// background/auto-verify.js —— 全自动反向搜图执行器
//
// 【它做什么】
//   对每个引擎：后台开一个不可见标签页 → 自动把图片塞进上传框 → 自动提交
//   → 轮询等结果页就绪 → 自动抓取结构化结果 → 立即关闭标签页。
//   全程零人工：不写剪贴板、不需要 Ctrl+V、不需要人眼读结果。
//
// 【为什么后台标签页而不是纯 fetch】
//   1. 引擎上传要经过它自己的 JS 处理（签名、分片、进度），纯 fetch 绕不过；
//   2. 页面上下文请求自带 Cookie 与 Referer，不会被当爬虫；
//   3. Cloudflare 的 JS challenge 需要真实渲染，只有标签页环境能过。
//
// 【为什么解析函数写成一个具名函数而不是字符串】
//   chrome.scripting.executeScript 的 func 靠 toString() 序列化后注入。
//   new Function(...) 生成的函数 toString() 只有 "function anonymous(...)"，
//   注入后会立刻抛错。所以解析逻辑必须是源码里真实存在、内部自包含的函数。

import { AUTO_ENGINES } from '../lib/engine-adapters.js';
import { loadOptions } from './store.js';

const POLL_INTERVAL_MS = 1200;
const TAB_OPEN_TIMEOUT_MS = 25000;
/** 引擎之间错开，避免瞬间多连接触发风控 */
const ENGINE_STAGGER_MS = 900;

/**
 * 全自动跑一遍所有启用的引擎
 * @param {object} image inv.image
 * @param {string} bytesBase64 图片字节（base64，已按长边压缩）
 * @param {string} mime
 * @param {(partial: object[]) => void} onProgress 每完成一个引擎回调，侧栏实时刷新
 */
export async function runAutoVerify(image, bytesBase64, mime, onProgress) {
  const options = await loadOptions();
  const enabledIds = resolveEnabled(options);
  const engines = AUTO_ENGINES.filter((e) => enabledIds.includes(e.id));

  if (!engines.length) return [];
  if (!bytesBase64) {
    return engines.map((e) => ({
      id: e.id,
      name: e.name,
      autoStatus: 'skipped',
      autoNote: '没有可用的图片字节，无法自动上传',
      matchCount: 0,
    }));
  }

  const results = [];

  // 串行执行：并行会同时开多个标签页并触发同源风控
  for (const engine of engines) {
    let r;
    try {
      r = await runOneEngine(engine, bytesBase64, mime);
    } catch (e) {
      r = {
        id: engine.id,
        name: engine.name,
        autoStatus: 'failed',
        autoNote: `执行异常：${e?.message || e}`,
        matchCount: 0,
      };
    }
    results.push(r);
    if (onProgress) {
      try {
        onProgress(results.slice());
      } catch {
        /* 回调异常不影响主流程 */
      }
    }
    await sleep(ENGINE_STAGGER_MS);
  }

  return results;
}

/** 兼容老配置（enabledEngines 里可能是旧引擎 id） */
function resolveEnabled(options) {
  const list = options.autoEngines || options.enabledEngines;
  if (Array.isArray(list) && list.length) return list;
  return AUTO_ENGINES.map((e) => e.id);
}

/** 单引擎完整流程 */
async function runOneEngine(engine, bytesBase64, mime) {
  const started = Date.now();
  let tabId = null;

  try {
    // 1) 后台创建标签页（用户不可见）
    const tab = await chrome.tabs.create({ url: engine.homeUrl, active: false });
    tabId = tab.id;

    // 2) 等页面加载完成
    await waitForTabLoad(tabId, TAB_OPEN_TIMEOUT_MS);

    // 3) 注入：把图片塞进文件输入框
    const seeded = await injectUpload(tabId, engine, bytesBase64, mime);
    if (!seeded?.ok) {
      return fail(engine, seeded?.error || '未能找到上传入口', started);
    }

    // 4) 等「可以提交」再提交
    //
    // 【为什么不能塞完就提交】
    //   引擎的上传框普遍挂着异步校验（SauceNAO: checkImageFile 读文件头），
    //   校验通过前表单守卫（isSearchReady）返回 false，提交会被静默拦下，
    //   页面停在首页 —— 表现就是「上传了但永远没有结果」。
    //   而且实测：塞入瞬间 isSearchReady 仍为 true（校验尚未开始），
    //   所以必须等「连续多次稳定为 true」，不能取瞬时值。
    const readyToSubmit = await waitForSubmitReady(tabId, engine.submitReadyTimeoutMs || 15000);

    if (readyToSubmit.rejected) {
      // 引擎自己判定这个文件不合格 —— 这是明确结论，不该报成"超时"
      return {
        id: engine.id,
        name: engine.name,
        autoStatus: 'rejected',
        autoNote: readyToSubmit.note || '引擎拒绝了这个文件',
        matchCount: 0,
        durationMs: Date.now() - started,
      };
    }

    await injectSubmit(tabId, engine);

    // 5) 确认真的离开了首页（提交被守卫拦下时 URL 不会变）
    await sleep(1500);
    let leftHome = await confirmLeftHome(tabId, engine, 8000);
    if (!leftHome.ok) {
      // 再试一次：有些引擎的就绪标志是延时置位的，第二次能过
      await injectSubmit(tabId, engine);
      leftHome = await confirmLeftHome(tabId, engine, 6000);
    }
    if (!leftHome.ok) {
      return {
        id: engine.id,
        name: engine.name,
        autoStatus: 'failed',
        autoNote: `提交未生效（${leftHome.note}）。该引擎可能对图片有最低尺寸或格式要求。`,
        matchCount: 0,
        durationMs: Date.now() - started,
      };
    }

    // 6) 轮询等结果就绪
    const ready = await waitForResult(tabId, engine);
    if (!ready.ok) {
      return {
        id: engine.id,
        name: engine.name,
        autoStatus: ready.blocked ? 'blocked' : 'timeout',
        autoNote: ready.note || '等待结果超时',
        matchCount: 0,
        durationMs: Date.now() - started,
      };
    }

    // 6) 抓取结构化结果
    const parsed = await injectParse(tabId, engine);

    return {
      id: engine.id,
      name: engine.name,
      autoStatus: parsed.status === 'ok' ? 'ok' : parsed.status || 'failed',
      autoNote: parsed.note || '',
      matchCount: parsed.matchCount || 0,
      items: (parsed.items || []).slice(0, 10),
      distinctHosts: parsed.distinctHosts || [],
      dateHints: parsed.dateHints || [],
      earliestSeenDate: pickEarliest(parsed.dateHints || []),
      earliestSeenUrl: pickEarliestLink(parsed.items || [], parsed.dateHints || []),
      earliestSeenContext: parsed.matchCount
        ? `自动检索命中 ${parsed.matchCount} 条${
            parsed.distinctHosts?.length ? `，涉及 ${parsed.distinctHosts.length} 个站点` : ''
          }`
        : '',
      autoVerified: true,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return fail(engine, String(e?.message || e), started);
  } finally {
    // 7) 无论成功失败，一律关闭标签页
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 标签页可能已被引擎自己关闭，忽略 */
      }
    }
  }
}

function fail(engine, note, started) {
  return {
    id: engine.id,
    name: engine.name,
    autoStatus: 'failed',
    autoNote: note,
    matchCount: 0,
    durationMs: Date.now() - started,
  };
}

// ---------- 注入脚本 ----------

/**
 * 把图片字节塞进页面的文件输入框（核心：绕开防盗链）
 * 这是一个会被序列化注入页面的函数，必须完全自包含。
 */
function seedFileInput(b64, mimeType, selector) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const ext = (mimeType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const file = new File([bytes], `query.${ext}`, { type: mimeType });

    let input = selector ? document.querySelector(selector) : null;
    if (!input) input = document.querySelector('input[type=file]');
    if (!input) return { ok: false, error: '页面没有 input[type=file] 上传入口' };

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));

    return { ok: true, size: file.size, usedSelector: selector || 'input[type=file]' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 触发提交：requestSubmit → 点可见按钮 → form.submit 三级兜底
 * 同样必须完全自包含。
 *
 * 【绝对不要在提交前调用 isSearchReady()】
 *   它是 SauceNAO 的一次性消费开关（读一次就置 false）。
 *   提交动作本身会触发 onsubmit="return(isSearchReady())"，
 *   那一次调用才是「正当消费」。若我们提前再调一次，
 *   开关就被我们用掉了，真正提交时守卫只会拿到 false → 提交被取消。
 *
 *   所以这里只做「提交」，不做「就绪判断」——就绪判断交给 probeSubmitReady，
 *   而后者只看文件与错误提示，不碰 isSearchReady。
 */
function submitSearchForm(strategy) {
  const input = document.querySelector('input[type=file]');
  const form = input ? input.closest('form') : document.querySelector('form');

  if (strategy === 'requestSubmit' && form && form.requestSubmit) {
    form.requestSubmit();
    return 'requestSubmit';
  }

  const btns = [...document.querySelectorAll('button, input[type=submit], [role=button]')];
  const btn = btns.find((b) => {
    const t = (b.textContent || b.value || '').trim().toLowerCase();
    return /search|upload|submit|搜|查询|上传|识图|开始/.test(t) && b.offsetParent !== null;
  });
  if (btn) {
    btn.click();
    return 'click';
  }

  if (form) {
    if (form.requestSubmit) {
      form.requestSubmit();
      return 'requestSubmit-fallback';
    }
    form.submit();
    return 'submit';
  }
  return 'none';
}

/**
 * 探测页面是否「可以提交了」
 * 必须完全自包含。
 *
 * 【绝对禁止调用页面的 isSearchReady() 来探测】
 *   SauceNAO 的实现是：
 *     function isSearchReady() {
 *       if (searchReady) { searchReady = false; return true; }   // ← 读一次就置 false
 *       ...return false;
 *     }
 *   它是个【一次性消费开关】，不是纯查询函数。
 *   如果轮询里反复调用它来「探测是否就绪」，第一次调用就把开关消耗掉了，
 *   等到真正提交时 onsubmit 再调用它只会拿到 false —— 提交被静默取消。
 *   这就是「注入成功但永远停在首页」的根因，而且是探测动作自己造成的。
 *
 * 【正确做法：只看不会改变状态的外部信号】
 *   1. 文件框里有文件、且体积正常
 *   2. 预览区没有错误提示（Image Too Large / Image Type Not Supported）
 *   3. 搜索按钮被加上激活类名（这是 checkImageFile 成功后的副作用，纯读取）
 */
function probeSubmitReady() {
  const input = document.querySelector('input[type=file]');
  const hasFile = Boolean(input && input.files && input.files.length > 0);
  const fileSize = hasFile ? input.files[0].size : 0;

  // 预览区的错误提示（checkImageFile 失败时会写入这里）
  let rejectHint = '';
  try {
    const preview = document.getElementById('imagePreview') || document.querySelector('.preview, #preview');
    const t = (preview?.innerText || '').trim();
    if (/too large|not supported|too small|invalid/i.test(t)) rejectHint = t.slice(0, 80);
  } catch {
    /* ignore */
  }

  // 搜索按钮是否被激活（纯读取，不改变状态）
  let buttonActive = null;
  try {
    const btn = document.getElementById('searchButton') || document.querySelector('input[type=submit]');
    if (btn) {
      const cls = btn.className || '';
      // SauceNAO 成功后会 remove("searchButtonActive") 的反面：先加后减？
      // 实测成功路径是 showImageFile() 激活按钮，这里用「是否 disabled」更通用
      buttonActive = !btn.disabled;
    }
  } catch {
    /* ignore */
  }

  return {
    hasFile,
    fileSize,
    rejectHint,
    buttonActive,
    // 只依据「有文件 + 无错误提示」判定，绝不碰 isSearchReady
    readyNow: hasFile && fileSize > 0 && !rejectHint,
    url: location.href,
  };
}

/**
 * 探测结果页状态（是否就绪 / 是否被验证码拦）
 * 必须完全自包含。
 */
function probePage(urlNeedle, sel) {
  const bodyHead = (document.body?.innerText || '').slice(0, 600);
  const blocked =
    /showcaptcha|not a robot|SmartCaptcha|sorry\/index|unusual traffic|异常流量|人机验证|安全验证|just a moment|Checking your browser/i.test(
      location.href + ' ' + bodyHead
    );
  // 统计「出站链接数」：指向其它站点的链接数量。
  // 【为什么需要】
  //   有些引擎的结果页布局不稳定、class 名会变，但只要真出了结果，
  //   就一定会给出通往原始站点的链接 —— 这比硬编码选择器稳健得多，
  //   新增引擎时也不必先逆向一遍 DOM 结构。
  let outLinks = 0;
  try {
    const here = location.hostname.replace(/^www\./, '');
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      try {
        const host = new URL(a.href).hostname.replace(/^www\./, '');
        if (host && host !== here) outLinks += 1;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  return {
    url: location.href,
    blocked,
    hasSelector: sel ? !!document.querySelector(sel) : true,
    textLen: (document.body?.innerText || '').length,
    outLinks,
    hasQuery: location.search.length > 1,
  };
}

/**
 * 通用结果解析器 —— 所有引擎共用，行为由 cfg 驱动
 * 必须完全自包含（不能引用模块作用域的任何变量）。
 */
function parsePage(cfg) {
  // ---- 内联工具（不能依赖外部） ----
  function hostOf(u) {
    try {
      return new URL(u, location.href).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function extractDates(text) {
    const out = [];
    const t = String(text || '');
    let m;

    const re1 = /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g;
    while ((m = re1.exec(t))) {
      const y = +m[1];
      const mo = +m[2];
      const d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        out.push(y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
      }
    }

    const re2 = /(20\d{2})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/g;
    while ((m = re2.exec(t))) {
      const y = +m[1];
      const mo = +m[2];
      const d = m[3] ? +m[3] : 1;
      if (mo >= 1 && mo <= 12) {
        out.push(y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
      }
    }

    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const re3 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(20\d{2})\b/gi;
    while ((m = re3.exec(t))) {
      const mo = months[m[1].toLowerCase().slice(0, 3)];
      if (mo) out.push(m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0'));
    }

    if (!out.length) {
      const re4 = /(20[0-2]\d)\s*年/g;
      while ((m = re4.exec(t))) {
        const y = +m[1];
        if (y >= 2000 && y <= 2026) out.push(String(y));
      }
    }
    return [...new Set(out)];
  }

  const excludeRe = cfg.excludeHosts ? new RegExp('(^|\\.)(' + cfg.excludeHosts + ')\\.', 'i') : null;

  function usableLink(href) {
    if (!href || href.startsWith('javascript') || href.startsWith('data:')) return null;
    const h = hostOf(href);
    if (!h) return null;
    if (excludeRe && excludeRe.test(h)) return null;
    return { url: href, host: h };
  }

  function linksIn(root) {
    const out = [];
    const seen = new Set();
    for (const a of root.querySelectorAll('a[href]')) {
      const l = usableLink(a.href);
      if (!l || seen.has(l.url)) continue;
      seen.add(l.url);
      out.push({ url: l.url, host: l.host, text: (a.textContent || '').trim().slice(0, 120) });
      if (out.length >= 6) break;
    }
    return out;
  }

  // ---- 主体 ----
  const items = [];
  const nodes = cfg.itemSelector ? [...document.querySelectorAll(cfg.itemSelector)] : [];

  for (const n of nodes.slice(0, 20)) {
    const links = linksIn(n);
    let similarity = null;
    if (cfg.similaritySelector) {
      const s = n.querySelector(cfg.similaritySelector);
      if (s) {
        const v = parseFloat((s.textContent || '').replace(/[^0-9.]/g, ''));
        if (Number.isFinite(v)) similarity = v;
      }
    }
    let title = null;
    if (cfg.titleSelector) {
      const t = n.querySelector(cfg.titleSelector);
      if (t) title = (t.textContent || '').trim().slice(0, 150);
    }
    if (!title) {
      const a = n.querySelector('a');
      if (a) title = (a.textContent || '').trim().slice(0, 150);
    }
    items.push({
      similarity,
      title: title || null,
      links: links.slice(0, 3),
      text: (n.innerText || '').replace(/\s+/g, ' ').slice(0, 260),
    });
  }

  // 容器没抓到链接时，退化为全页按域名去重扫
  const hasAnyLink = items.some((i) => i.links.length > 0);
  if (!hasAnyLink) {
    const byHost = new Map();
    for (const a of document.querySelectorAll('a[href^="http"], a[href^="/"]')) {
      const l = usableLink(a.href);
      if (!l || byHost.has(l.host)) continue;
      byHost.set(l.host, { url: l.url, host: l.host, text: (a.textContent || '').trim().slice(0, 120) });
      if (byHost.size >= 20) break;
    }
    for (const l of byHost.values()) {
      items.push({ similarity: null, title: l.text || null, links: [l], text: '' });
    }
  }

  const allText = (document.body.innerText || '') + ' ' + items.map((i) => i.text).join(' ');
  const distinctHosts = [...new Set(items.flatMap((i) => i.links.map((l) => l.host)))];

  // 引擎自报的总数（部分引擎有 "N matches" 文案）
  let matchCount = items.length;
  if (cfg.totalSelector) {
    const el = document.querySelector(cfg.totalSelector);
    const n = parseInt((el?.textContent || '').replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(n) && n > 0) matchCount = n;
  }

  return {
    status: 'ok',
    matchCount,
    items: items.slice(0, 12),
    distinctHosts,
    dateHints: extractDates(allText),
    note: matchCount
      ? `命中 ${matchCount} 条${distinctHosts.length ? `，涉及 ${distinctHosts.length} 个站点` : ''}`
      : '未找到相似结果',
  };
}

async function injectUpload(tabId, engine, bytesBase64, mime) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: seedFileInput,
      args: [bytesBase64, mime || 'image/jpeg', engine.fileSelector || ''],
    });
    return res?.[0]?.result;
  } catch (e) {
    return { ok: false, error: `注入上传失败：${e?.message || e}` };
  }
}

async function injectSubmit(tabId, engine) {
  if (engine.submitStrategy === 'none') return;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: submitSearchForm,
      args: [engine.submitStrategy || 'auto'],
    });
    return res?.[0]?.result;
  } catch {
    return null;
  }
}

/**
 * 等「文件已就位且未被拒绝」
 *
 * 【为什么只需短暂等待，不再长时间轮询】
 *   探测本身虽不碰 isSearchReady，但长时间轮询没有意义：
 *   checkImageFile 是同步执行的（塞文件时 dispatch change 就立即跑完），
 *   它成功会立刻激活搜索按钮、失败会立刻写入错误提示。
 *   所以塞完文件后等 1~2 秒确认状态即可，不需要几十秒轮询。
 *
 *   若确认被拒绝（体积/类型不合格），立刻返回 rejected 并说明原因 ——
 *   让用户知道是「这张图引擎不收」，而不是笼统的「超时」。
 */
async function waitForSubmitReady(tabId, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 6000);
  let last = null;

  while (Date.now() < deadline) {
    let probe;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: probeSubmitReady,
        args: [],
      });
      probe = res?.[0]?.result;
    } catch {
      probe = null;
    }

    if (probe) {
      last = probe;

      // 页面明确拒绝了这个文件 —— 立即失败，别白等
      if (probe.rejectHint) {
        return {
          ok: false,
          probe,
          rejected: true,
          note: `引擎拒绝了这个文件：${probe.rejectHint}`,
        };
      }

      if (probe.readyNow) {
        return { ok: true, probe };
      }
    }

    await sleep(400);
  }

  return { ok: false, probe: last, note: '文件未被引擎接受' };
}

/**
 * 确认提交真的生效了（离开了首页）
 *
 * 【为什么必须单独确认】
 *   提交被表单守卫拦下时，页面不会报错，URL 也不会变 —— 只是「什么都没发生」。
 *   如果不确认就继续等结果，会一直等到超时，最后报「结果页等待超时」，
 *   而真实原因是「提交根本没发出去」，诊断完全跑偏。
 */
async function confirmLeftHome(tabId, engine, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await getTabUrl(tabId);
    if (url && !sameOrigin(url, engine.homeUrl)) {
      return { ok: true, url };
    }
    await sleep(500);
  }
  const finalUrl = await getTabUrl(tabId);
  return { ok: false, note: `仍停在 ${finalUrl || '首页'}` };
}

async function injectParse(tabId, engine) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: parsePage,
      args: [engine.parse || {}],
    });
    return res?.[0]?.result || { status: 'failed', note: '解析无返回', matchCount: 0, items: [] };
  } catch (e) {
    return {
      status: 'failed',
      note: `解析失败：${e?.message || e}`,
      matchCount: 0,
      items: [],
      dateHints: [],
    };
  }
}

/** 轮询等待结果页就绪 */
async function waitForResult(tabId, engine) {
  const deadline = Date.now() + (engine.timeoutMs || 35000);
  const check = engine.readyCheck || {};

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let probe;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: probePage,
        args: [check.urlIncludes || '', check.selector || ''],
      });
      probe = res?.[0]?.result;
    } catch {
      continue; // 页面正在跳转，下一轮再试
    }
    if (!probe) continue;

    if (probe.blocked) {
      return { ok: false, blocked: true, note: '该引擎要求人机验证，已跳过（自动模式下无法绕过）' };
    }

    const urlOk = !check.urlIncludes || probe.url.includes(check.urlIncludes);
    const selOk = !check.selector || probe.hasSelector;
    // 结果页必须带查询串（区分「搜索首页」与「搜索结果页」）
    const queryOk = !check.urlHasQuery || probe.hasQuery;
    // 结果页至少要有 N 个出站链接（出结果了必然会给出通往原始站点的链接）
    const linksOk = !check.minLinks || (probe.outLinks || 0) >= check.minLinks;

    if (urlOk && selOk && queryOk && linksOk && probe.textLen > 120) {
      return { ok: true, url: probe.url };
    }
  }
  return { ok: false, note: '等待结果超时' };
}

// ---------- 工具 ----------

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t?.status === 'complete') finish();
      })
      .catch(finish);
  });
}

async function getTabUrl(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return t?.url || '';
  } catch {
    return '';
  }
}

function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

/** 从日期候选里取最早（年份型补成 01-01 参与排序，但返回原始形态） */
function pickEarliest(dates) {
  if (!dates?.length) return null;
  const norm = dates
    .map((d) => ({ raw: d, key: d.length === 4 ? `${d}-01-01` : d }))
    .sort((x, y) => x.key.localeCompare(y.key));
  return norm[0]?.raw || null;
}

/** 挑一个最可能代表出处的链接 */
function pickEarliestLink(items, dateHints) {
  for (const it of items || []) {
    for (const l of it.links || []) {
      if (!l?.url) continue;
      if (dateHints?.length && /20\d{2}/.test(l.url)) return l.url;
    }
  }
  const first = (items || []).flatMap((i) => i.links || []).find((l) => l?.url);
  return first?.url || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
