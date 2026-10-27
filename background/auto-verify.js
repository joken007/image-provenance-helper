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
import { isHotlinkProtected } from '../lib/utils.js';

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
      r = await runOneEngine(engine, bytesBase64, mime, image);
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
async function runOneEngine(engine, bytesBase64, mime, image) {
  const started = Date.now();
  let tabId = null;

  try {
    // 1) 后台创建标签页（用户不可见）
    const tab = await chrome.tabs.create({ url: engine.homeUrl, active: false });
    tabId = tab.id;

    // 2) 等页面加载完成
    await waitForTabLoad(tabId, TAB_OPEN_TIMEOUT_MS);

    /**
     * 【模式选择：先上传，直搜兜底】
     *
     * 为什么要有 url-direct：
     *   DataTransfer 注入只改了 input.files，**并没有真的把文件上传到服务器**。
     *   引擎若是 multipart 表单自己提交（像 SauceNAO），这样没问题；
     *   但若引擎是「把文件名/URL 传给服务端，服务端自己去取」，
     *   那它拿到的就是个假文件名，检索必然落空。
     *   百度识图实测就是后者：走上传路径会变成
     *   graph.baidu.com/pcpage/index?file=query.png —— 服务端根本不认识这个文件名，
     *   于是回到首页；而正确协议是 graph.baidu.com/s?image_url=<真实URL>。
     *
     * 【为什么不是直搜优先】
     *   实测 SauceNAO 走 URL 直搜会触发 Cloudflare 挑战（blocked），
     *   而走上传模式是通的（命中 9 条）。所以顺序必须是：
     *   **先用已被验证可用的上传模式，直搜只作为上传彻底失败后的兜底**。
     *   否则一次「优化」就会把能用的引擎弄坏 —— 这正是本项目反复踩过的坑。
     */
    const directUrl = engine.buildDirectUrl ? engine.buildDirectUrl(pickDirectUrl(image)) : '';
    let directTried = false;

    /** 走直搜（兜底路径） */
    const tryDirect = async () => {
      if (!directUrl || directTried) return null;
      directTried = true;
      return await runDirectSearch(tabId, engine, directUrl, started);
    };

    /**
     * preferDirect：显式声明「这个引擎首选 URL 直搜」
     *
     * 【为什么需要显式声明，而不是一律靠失败兜底】
     *   百度识图实测：走上传路径时，页面会变成
     *   graph.baidu.com/pcpage/index?file=query.png ——
     *   标题已经是「百度识图搜索结果」，URL 也变了，
     *   看起来「提交成功了」，于是不会触发失败兜底，
     *   但实际服务端拿到的是假文件名 query.png，根本没检索。
     *   这种「假成功」靠兜底永远抓不住，必须由引擎显式声明首选模式。
     *
     *   对比 SauceNAO：它走 multipart 表单自己提交文件，上传模式才是对的，
     *   直搜反而会触发 Cloudflare 挑战 —— 所以它不声明 preferDirect。
     */
    if (engine.preferDirect && directUrl) {
      const r = await runDirectSearch(tabId, engine, directUrl, started);
      if (r) return r;
      // 直搜失败则继续走上传模式
    }

    // 2.5) 等待上传入口出现
    //
    // 【为什么需要】
    //   有些引擎（TinEye）首页有 Cloudflare JS 挑战，页面先显示「请稍候…」，
    //   挑战通过后才渲染出真正的上传框。此时立刻注入必然失败，
    //   报出来的是「页面没有 input[type=file] 上传入口」——但真实原因是「还没加载完」。
    if (engine.waitForSelector) {
      const appeared = await waitForSelectorAppear(
        tabId,
        engine.waitForSelector,
        engine.waitForSelectorTimeoutMs || 20000
      );
      if (!appeared.ok) {
        return {
          id: engine.id,
          name: engine.name,
          autoStatus: appeared.blocked ? 'blocked' : 'failed',
          autoNote: appeared.blocked
            ? '该引擎要求人机验证，已跳过（自动模式下无法绕过）'
            : `等待上传入口超时（${appeared.note}）`,
          matchCount: 0,
          durationMs: Date.now() - started,
        };
      }
    }

    // 3) 注入：把图片塞进文件输入框
    const seeded = await injectUpload(tabId, engine, bytesBase64, mime);
    if (!seeded?.ok) {
      // 上传路径走不通 → 试 URL 直搜兜底（百度这类引擎只认直链）
      const direct = await tryDirect();
      if (direct) return direct;
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
      // 引擎自己判定这个文件不合格 —— 可能是它不认 DataTransfer 注入的文件，
      // 此时 URL 直搜仍可能成功（服务端自己去取图，不需要客户端上传）
      const direct = await tryDirect();
      if (direct) return direct;
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
      // 情况 A：引擎是「塞文件即自动提交」（submitAfterSeed='none'），
      //         那没跳转说明它没自动提交 → 补一次显式提交
      // 情况 B：引擎需要显式提交但被守卫拦了 → 已经是明确失败
      if (engine.submitAfterSeed === 'none') {
        await injectSubmit(tabId, engine);
        leftHome = await confirmLeftHome(tabId, engine, 8000);
      }
      if (!leftHome.ok) {
        // 提交没生效 → 试 URL 直搜兜底
        const direct = await tryDirect();
        if (direct) return direct;
        return {
          id: engine.id,
          name: engine.name,
          autoStatus: 'failed',
          autoNote: `提交未生效（${leftHome.note}）。该引擎可能对图片有最低尺寸或格式要求。`,
          matchCount: 0,
          durationMs: Date.now() - started,
        };
      }
    }

    // 6) 轮询等结果就绪
    const ready = await waitForResult(tabId, engine);
    if (!ready.ok) {
      // 诊断：把当前页面的实际状态带回去，否则用户只看到「等待结果超时」，
      // 根本不知道是「没跳页」「页面没内容」还是「被判成首页」。
      const diag = await diagnoseResultPage(tabId, engine);
      return {
        id: engine.id,
        name: engine.name,
        autoStatus: ready.blocked ? 'blocked' : 'timeout',
        autoNote: `等待结果超时（${diag}）`,
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

/** 挑选可用于 url-direct 的公网直链（防盗链域名不可用） */
function pickDirectUrl(image) {
  const candidates = [image?.normalizedUrl, image?.originalUrl];
  for (const u of candidates) {
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    // blob:/data: 不可直连
    if (/^(blob:|data:)/i.test(u)) continue;
    // 防盗链图床直连会 403，跳过
    if (isHotlinkProtected(u)) continue;
    return u;
  }
  return '';
}

/**
 * url-direct 模式：直接跳到「用图片 URL 检索」的地址
 *
 * @returns {object|null} 成功返回引擎结果；不可用返回 null（交回落上传模式）
 */
async function runDirectSearch(tabId, engine, url, started) {
  try {
    await chrome.tabs.update(tabId, { url });
    await waitForTabLoad(tabId, engine.timeoutMs || 30000);

    const ready = await waitForResult(tabId, engine);
    if (!ready.ok) {
      if (ready.blocked) {
        return {
          id: engine.id,
          name: engine.name,
          autoStatus: 'blocked',
          autoNote: '该引擎要求人机验证，已跳过（自动模式下无法绕过）',
          matchCount: 0,
          durationMs: Date.now() - started,
        };
      }
      return null; // 直搜没成功，回落到上传模式
    }

    const parsed = await injectParse(tabId, engine);
    if (!parsed || parsed.status !== 'ok') return null;

    return {
      id: engine.id,
      name: engine.name,
      autoStatus: 'ok',
      autoNote: parsed.note || '',
      matchCount: parsed.matchCount || 0,
      items: (parsed.items || []).slice(0, 10),
      distinctHosts: parsed.distinctHosts || [],
      dateHints: parsed.dateHints || [],
      earliestSeenDate: pickEarliest(parsed.dateHints || []),
      earliestSeenUrl: pickEarliestLink(parsed.items || [], parsed.dateHints || []),
      earliestSeenContext: parsed.matchCount
        ? `URL 直搜命中 ${parsed.matchCount} 条${
            parsed.distinctHosts?.length ? `，涉及 ${parsed.distinctHosts.length} 个站点` : ''
          }`
        : '',
      autoVerified: true,
      viaDirect: true,
      durationMs: Date.now() - started,
    };
  } catch {
    return null;
  }
}

/**
 * 把图片字节塞进页面的文件输入框（核心：绕开防盗链）
 * 这是一个会被序列化注入页面的函数，必须完全自包含。
 *
 * 【为什么不能只找 input[type=file]】
 *   实测各引擎的差异很大：
 *     - SauceNAO：有明确 #fileInput，在 form 内，可见
 *     - Bing：id=sb_fileinput，在 form 内，但 display:none（隐藏）
 *     - Yandex：无 id、accept=image/*、**不在任何 form 内**
 *     - Google Lens：input[name=encoded_image]、不在 form 内
 *   因此：不能因为「隐藏」就跳过，也不能假设它一定在 form 里。
 *   按优先级挑一个最像「用于上传图片」的文件框即可。
 */
function seedFileInput(b64, mimeType, selector) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const ext = (mimeType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const file = new File([bytes], `query.${ext}`, { type: mimeType });

    /**
     * 选文件框：显式选择器优先，否则按「accept 含 image」打分挑最合适的。
     * 注意：不能排除隐藏元素 —— 多数站点会把真正的上传框 display:none，
     * 用样式化的 <label> 触发它。
     */
    function pickInput() {
      if (selector) {
        const el = document.querySelector(selector);
        if (el) return { input: el, why: 'selector' };
      }
      const all = [...document.querySelectorAll('input[type=file]')];
      if (!all.length) return { input: null, why: 'none' };

      let best = null;
      let bestScore = -1;
      for (const el of all) {
        let score = 0;
        const accept = (el.getAttribute('accept') || '').toLowerCase();
        if (accept.includes('image')) score += 100;
        else if (accept && !accept.includes('*')) score -= 50; // 明确非图片
        if (el.closest('form')) score += 20;
        if (el.id && /image|img|photo|file|upload|pic/i.test(el.id)) score += 15;
        if (el.name && /image|img|photo|file|upload|pic|encoded/i.test(el.name)) score += 15;
        // 多个候选时，优先第一个（通常是主入口）
        score -= all.indexOf(el) * 0.1;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return { input: best, why: 'scored' };
    }

    const picked = pickInput();
    if (!picked.input) return { ok: false, error: '页面没有 input[type=file] 上传入口' };
    const input = picked.input;

    // 部分站点用 <label for> 关联隐藏 input，先确保 input 未被禁用
    if (input.disabled) input.disabled = false;

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;

    // change 是绝大多数站点真正触发处理的时机；input 事件部分框架也要
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));

    return {
      ok: true,
      size: file.size,
      usedSelector: picked.why,
      inputId: input.id || null,
      inputName: input.name || null,
      inForm: Boolean(input.closest('form')),
      hidden: input.offsetParent === null,
    };
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
 *
 * 【顺序：先 requestSubmit，再点按钮】
 *   实测百度：走表单 requestSubmit 会到 /s?file=（结果页结构已知）；
 *   而点页面上的按钮会到 /pcpage/index?file=query.png（另一套 DOM）。
 *   两者结果等价但结构不同，优先用能到标准结果页的那条。
 */
function submitSearchForm(strategy, exactSelector) {
  const input = document.querySelector('input[type=file]');
  const form = input ? input.closest('form') : document.querySelector('form');

  /**
   * 【最高优先级：引擎指定的精确选择器】
   *   实测 Bing：真正的上传入口是 <span id="sb_brtext">上传图像</span>（不可见），
   *   而 form 里的按钮文案是「搜索」——按文案匹配会点中它，
   *   结果变成普通网页搜索（bing.com/?scope=web）而不是以图搜图。
   *   所以只要引擎给了精确选择器，就必须优先用它，绝不靠文案猜。
   */
  if (exactSelector) {
    const el = document.querySelector(exactSelector);
    if (el) {
      el.click();
      return 'click-exact';
    }
  }

  // 表单提交优先（语义最标准，结果页结构最可预期）
  if (strategy !== 'click' && form && form.requestSubmit) {
    try {
      form.requestSubmit();
      return 'requestSubmit';
    } catch {
      /* 某些站点在 submit 事件里抛错，继续走点按钮 */
    }
  }

  /**
   * 找提交按钮
   *
   * 【为什么不要求可见】
   *   原实现要求 b.offsetParent !== null（可见），但实测不少站点
   *   把真正的 submit 按钮做成隐藏的、由样式化 label 代理点击。
   *   要求可见会直接漏掉这些站点的提交入口。
   *   改为：优先可见按钮，找不到就退而用隐藏的 submit 按钮。
   */
  const all = [...document.querySelectorAll('button, input[type=submit], [role=button]')];
  const matchText = (b) => {
    const t = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
    return /search by image|upload image|以图搜图|上传图像|识图|search|upload|submit|搜|查询|上传|开始/.test(t);
  };
  const visible = all.find((b) => matchText(b) && b.offsetParent !== null);
  const hiddenSubmit = all.find((b) => matchText(b));

  const btn = visible || hiddenSubmit;
  if (btn) {
    btn.click();
    return visible ? 'click-visible' : 'click-hidden';
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

  /**
   * 【识别「已核查但无匹配」】
   *   实测百度识图：搜完但没有匹配时，页面会明确写「未找到相关结果」，
   *   正文只有 51 字。这不是失败，而是【一个有效的否定结论】——
   *   「查过了，公开来源里没有这张图的记录」。
   *   如果不识别它，就会被判成「等待结果超时」，把明确的否定报成技术故障。
   */
  const noMatchPatterns =
    /未找到相关结果|没有找到相关结果|无匹配|no results?|not found|no matches|no similar images/i;
  const explicitlyNoMatch = noMatchPatterns.test(allText) && items.length === 0;

  let note;
  if (explicitlyNoMatch) {
    note = '已核查，未找到匹配来源';
  } else if (matchCount) {
    note = `命中 ${matchCount} 条${distinctHosts.length ? `，涉及 ${distinctHosts.length} 个站点` : ''}`;
  } else {
    note = '未找到相似结果';
  }

  return {
    status: 'ok',
    matchCount,
    explicitlyNoMatch,
    items: items.slice(0, 12),
    distinctHosts,
    dateHints: extractDates(allText),
    note,
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
  // submitAfterSeed='none' 表示「塞完文件引擎会自己提交」，
  // 此时不应主动点提交按钮 —— 有些引擎的提交按钮点了反而会重复提交或清空表单。
  if (engine.submitAfterSeed === 'none') return null;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: submitSearchForm,
      args: [engine.submitStrategy || 'auto', engine.submitSelector || ''],
    });
    return res?.[0]?.result;
  } catch {
    return null;
  }
}

/**
 * 结果页诊断：把「到底卡在哪」变成一句人话
 * 必须完全自包含。
 */
function diagnoseResultPageState(cfg) {
  const bodyHead = (document.body?.innerText || '').slice(0, 300).replace(/\s+/g, ' ');
  const here = location.hostname.replace(/^www\./, '');
  let outLinks = 0;
  try {
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      try {
        const h = new URL(a.href).hostname.replace(/^www\./, '');
        if (h && h !== here) outLinks += 1;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return {
    url: location.href.slice(0, 120),
    title: document.title.slice(0, 60),
    hasSelector: cfg.selector ? !!document.querySelector(cfg.selector) : true,
    textLen: (document.body?.innerText || '').length,
    outLinks,
    urlHas: cfg.urlIncludes ? location.href.includes(cfg.urlIncludes) : true,
    head: bodyHead,
  };
}

/** 拿诊断信息（失败时给出具体原因，而不是笼统的「超时」） */
async function diagnoseResultPage(tabId, engine) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: diagnoseResultPageState,
      args: [engine.readyCheck || {}],
    });
    const d = res?.[0]?.result;
    if (!d) return '无法读取页面状态';
    const flags = [];
    if (engine.readyCheck?.urlIncludes && !d.urlHas) flags.push(`URL 未包含「${engine.readyCheck.urlIncludes}」`);
    if (engine.readyCheck?.selector && !d.hasSelector) flags.push('结果容器未出现');
    if (d.textLen < 30) flags.push(`页面内容过少(${d.textLen}字)`);
    if (d.outLinks === 0) flags.push('没有出站链接');
    return `${flags.join('；') || '判据未同时满足'}｜URL=${d.url}｜标题=${d.title}｜正文${d.textLen}字｜出站链接${d.outLinks}`;
  } catch (e) {
    return `诊断失败：${String((e && e.message) || e)}`;
  }
}

/**
 * 等待某个选择器出现
 *
 * 【用途】有些引擎首页有 Cloudflare 挑战或懒加载，
 * 上传框要等一会儿才渲染出来。此时立刻注入必然失败，
 * 报出来会是「没有上传入口」——但真实原因是「还没加载完」。
 */
async function waitForSelectorAppear(tabId, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let state;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: probeSelectorState,
        args: [selector],
      });
      state = res?.[0]?.result;
    } catch {
      state = null;
    }
    if (state) {
      if (state.found) return { ok: true };
      if (state.blocked) return { ok: false, blocked: true };
    }
    await sleep(800);
  }
  return { ok: false, blocked: false, note: '页面未在预期时间内渲染出上传入口' };
}

/**
 * 探测选择器是否出现 / 页面是否被验证码拦截
 * 必须完全自包含。
 */
function probeSelectorState(selector) {
  const found = Boolean(selector && document.querySelector(selector));
  const head = (document.body?.innerText || '').slice(0, 500);
  const blocked =
    /captcha|just a moment|verify you are human|unusual traffic|人机验证|安全验证|请稍候/i.test(
      location.href + ' ' + document.title + ' ' + head
    );
  return { found, blocked, url: location.href, title: document.title };
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
 * 【为什么不能只比 origin】
 *   实测百度的识图：上传成功后**不跳页**，而是在同一个 URL 上加查询参数
 *   （graph.baidu.com/pcpage/index → graph.baidu.com/pcpage/index?file=...）。
 *   只比 origin 会认为「还在首页」，从而误判为提交失败。
 *   因此必须比较【路径 + 查询串】，只有完全一致才算还在首页。
 */
async function confirmLeftHome(tabId, engine, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await getTabUrl(tabId);
    if (url && !samePage(url, engine.homeUrl)) {
      return { ok: true, url };
    }
    await sleep(500);
  }
  const finalUrl = await getTabUrl(tabId);
  return { ok: false, note: `仍停在 ${finalUrl || '首页'}` };
}

/**
 * 是否还是同一个页面（路径与查询串都相同才算）
 * 只比 origin 不够 —— 很多引擎是同页改查询串。
 */
function samePage(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.origin !== ub.origin) return false;
    if (ua.pathname !== ub.pathname) return false;
    // 查询串有变化即视为离开了首页
    if (ua.search !== ub.search) return false;
    return true;
  } catch {
    return String(a || '') === String(b || '');
  }
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

    /**
     * 正文长度门槛
     *
     * 【为什么不能一刀切要 120 字】
     *   实测百度识图：搜到结果但页面明确显示「未找到相关结果」时，
     *   正文只有 51 字。这时候它其实已经**正常完成了**（给出了「无匹配」结论），
     *   但因为长度不足 120，会被判成「等待结果超时」——把正常结果报成失败。
     *   所以：有明确的就绪信号（URL 已带查询串 / 结果容器存在 / 有出站链接）时，
     *   放宽长度门槛；否则仍要求足够长的正文，避免把首页当成结果页。
     */
    const hasStrongSignal =
      (check.urlIncludes && probe.url.includes(check.urlIncludes)) ||
      (check.selector && probe.hasSelector) ||
      (check.minLinks && (probe.outLinks || 0) >= check.minLinks);
    const textOk = probe.textLen > 120 || (hasStrongSignal && probe.textLen > 20);

    if (urlOk && selOk && queryOk && linksOk && textOk) {
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
