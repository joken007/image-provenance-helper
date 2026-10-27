// background/web-search.js —— 联网检索取证层
//
// 【它为什么必须存在】
//   核查「一句话是真是假」，光靠模型自己的记忆是不可靠的——那等于让模型编造事实。
//   正确做法是：扩展自己去搜索引擎把证据搜回来，再把「标题 + 摘要 + 链接」喂给模型判定。
//   这样做的直接好处是：
//     1. 模型能引用的 URL，全部来自本文件真实检索到的结果，程序层面可做白名单硬校验；
//     2. 侧栏能展示「用了什么检索词、搜到了什么」，核查过程可复核，不是黑箱。
//
// 【实现方式：沿用 auto-verify.js 的后台标签页套路】
//   搜索引擎结果页大量依赖 JS 渲染且有反爬，纯 fetch 解析不稳；
//   因此开一个不可见标签页（active:false）→ 跳转检索 → 注入解析函数 → 取结果 → 关闭。
//   用户全程看不到任何窗口，页面也不会被打扰。
//
// 【与 auto-verify.js 的差异】
//   搜索不需要上传文件，因此不需要 DataTransfer 那套注入；
//   但需要「同一个标签页复用来跑多个检索词」，以减少标签页开关开销。

/** 搜索适配器：每家一份「怎么拼 URL + 怎么读结果」的配方 */
export const SEARCH_ENGINES = [
  {
    id: 'bing-cn',
    name: '必应',
    buildUrl: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`,
    excludeHosts: 'bing\\.com|microsoft|msn|live\\.com',
    parse: {
      itemSelector: 'li.b_algo',
      titleSelector: 'h2',
      snippetSelector: '.b_caption p, .b_lineclamp2, .b_algoSlug, p',
    },
    readySelector: 'li.b_algo, #b_results',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    buildUrl: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    excludeHosts: 'duckduckgo\\.com|duckduckgo\\.com\\.cn',
    parse: {
      itemSelector: '.result',
      titleSelector: '.result__a',
      snippetSelector: '.result__snippet',
    },
    readySelector: '.result, #links',
  },
  {
    id: 'baidu',
    name: '百度',
    buildUrl: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
    excludeHosts: 'baidu\\.com|bdstatic|bdimg|bdurl|qq\\.com',
    parse: {
      itemSelector: 'div.result, div.c-container',
      titleSelector: 'h3',
      snippetSelector: '.c-abstract, [class*=content-right], .c-span-last',
    },
    readySelector: '#content_left div.result, #content_left div.c-container',
  },
];

/** 默认启用顺序：先稳后快 */
export const DEFAULT_SEARCH_ENGINES = ['bing-cn', 'duckduckgo'];

export const SEARCH_ENGINE_BY_ID = Object.fromEntries(SEARCH_ENGINES.map((e) => [e.id, e]));

/** 单次检索超时 */
const DEFAULT_TIMEOUT_MS = 20000;
/** 检索间隔，避免连续请求触发风控 */
const QUERY_STAGGER_MS = 700;

// ---------- 对外接口 ----------

/**
 * 对一组检索词逐个联网取证。
 *
 * @param {string[]} queries 检索词列表
 * @param {object}   opts
 *   engineIds    使用的搜索引擎 id 列表（默认第一个即可）
 *   maxResults   每个检索词最多保留多少条结果
 *   onProgress   (done, total, query, engine) => void
 * @returns {Promise<{results: Array, byQuery: Object, enginesUsed: string[], failures: Array}>}
 */
export async function gatherEvidence(queries, opts = {}) {
  const engineIds = resolveEngineIds(opts.engineIds);
  const maxResults = Math.max(1, Math.min(20, opts.maxResults || 8));
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const list = (queries || []).map((q) => String(q || '').trim()).filter(Boolean);
  const results = [];
  const byQuery = {};
  const failures = [];
  const enginesUsed = [];

  if (!list.length) {
    return { results, byQuery, enginesUsed, failures };
  }

  // 单个标签页复用于全部检索词，跑完统一关闭
  let tabId = null;
  try {
    tabId = await openBackgroundTab();

    let done = 0;
    for (const query of list) {
      const perEngine = [];

      for (const engineId of engineIds) {
        const engine = SEARCH_ENGINE_BY_ID[engineId];
        if (!engine) continue;

        let r;
        try {
          r = await searchOne(tabId, engine, query, maxResults, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
        } catch (e) {
          r = { ok: false, error: String((e && e.message) || e), items: [] };
        }

        if (r.ok) {
          enginesUsed.push(engine.id);
          perEngine.push(...r.items);
        } else {
          failures.push({ engine: engine.id, query, error: r.error || '检索失败' });
        }
      }

      // 跨引擎去重（同一 URL 只留一条，优先保留有摘要的）
      const merged = dedupeByUrl(perEngine).slice(0, maxResults);
      byQuery[query] = merged;
      results.push(...merged.map((m) => ({ ...m, query })));

      done += 1;
      if (onProgress) {
        try {
          // 必须 await：进度回写要按顺序落盘，否则侧栏可能停在过期的步骤上
          await onProgress(done, list.length, query);
        } catch {
          /* 回调异常不影响检索 */
        }
      }

      if (done < list.length) await sleep(QUERY_STAGGER_MS);
    }
  } catch (e) {
    failures.push({ engine: '-', query: '-', error: `检索流程异常：${String((e && e.message) || e)}` });
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 标签页可能已被关闭 */
      }
    }
  }

  return { results: dedupeByUrl(results), byQuery, enginesUsed: [...new Set(enginesUsed)], failures };
}

/** 单条检索词（供调试与单点复查使用） */
export async function searchWeb(query, opts = {}) {
  const engineIds = resolveEngineIds(opts.engineIds);
  const engine = SEARCH_ENGINE_BY_ID[engineIds[0]] || SEARCH_ENGINES[0];
  const maxResults = Math.max(1, Math.min(20, opts.maxResults || 8));

  let tabId = null;
  try {
    tabId = await openBackgroundTab();
    const r = await searchOne(tabId, engine, query, maxResults, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    return { ok: r.ok, error: r.error, items: r.items || [], engine: engine.id, query };
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------- 单次检索 ----------

async function searchOne(tabId, engine, query, maxResults, timeoutMs) {
  const url = engine.buildUrl(query);
  await chrome.tabs.update(tabId, { url });
  await waitForTabLoad(tabId, timeoutMs);

  // 结果页就绪判定：等容器出现
  const ready = await waitForSearchReady(tabId, engine, timeoutMs);
  if (!ready.ready) {
    if (ready.blocked) {
      return { ok: false, error: `${engine.name} 要求人机验证，已跳过`, items: [] };
    }
    return { ok: false, error: `${engine.name} 结果页等待超时`, items: [] };
  }

  const parsed = await injectParse(tabId, engine);
  if (!parsed || parsed.status !== 'ok') {
    return { ok: false, error: (parsed && parsed.note) || `${engine.name} 结果解析失败`, items: [] };
  }

  return {
    ok: true,
    items: (parsed.items || []).slice(0, maxResults).map((it) => ({
      title: it.title || '',
      url: it.url || '',
      snippet: it.snippet || '',
      engine: engine.id,
      engineName: engine.name,
    })),
  };
}

// ---------- 注入解析函数 ----------
//
// 【硬性约束】
//   chrome.scripting.executeScript 的 func 靠 toString() 序列化后注入页面。
//   new Function(...) 生成的函数 toString() 不含实现，注入后必定抛错。
//   因此下面这个函数必须是源码里真实存在的具名函数，且完全自包含（不引用模块作用域变量）。

function parseSearchResults(cfg) {
  function cleanText(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function absolute(href) {
    if (!href) return '';
    try {
      return new URL(href, location.href).href;
    } catch {
      return '';
    }
  }

  function hostOf(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  }

  const excludeRe = cfg.excludeHosts ? new RegExp('(^|\\.)(' + cfg.excludeHosts + ')\\.', 'i') : null;

  function isExcluded(u) {
    if (!u) return true;
    if (/^javascript:/i.test(u) || /^data:/i.test(u)) return true;
    const h = hostOf(u);
    if (!h) return true;
    if (excludeRe && excludeRe.test(h)) return true;
    return false;
  }

  /**
   * 搜索结果的真实落地 URL：
   *   百度等会把链接包成 /link?url=... 跳转，这里优先取 data-mu / data-url / cite 上的真实地址。
   */
  function realUrl(el, anchor) {
    const candidates = [
      el.getAttribute && el.getAttribute('data-mu'),
      el.getAttribute && el.getAttribute('data-url'),
      el.getAttribute && el.getAttribute('data-landurl'),
      anchor && anchor.getAttribute && anchor.getAttribute('data-url'),
    ];
    for (const c of candidates) {
      const v = cleanText(c || '');
      if (v && /^https?:\/\//i.test(v) && !isExcluded(v)) return absolute(v);
    }

    const href = absolute(anchor && anchor.getAttribute ? anchor.getAttribute('href') : '');
    if (!href) return '';

    // 百度跳转链接：从 cite 展示文本里还原
    if (/baidu\.com\/link\?/i.test(href)) {
      const cite = cleanText((el.querySelector && el.querySelector('cite, .c-showurl'))?.textContent || '');
      const m = cite.match(/https?:\/\/[^\s]+/i);
      if (m && !isExcluded(m[0])) return m[0];
      return ''; // 还原不出来就丢弃，不给模型一条不可核验的链接
    }

    return isExcluded(href) ? '' : href;
  }

  const items = [];
  const seen = new Set();

  const nodes = cfg.itemSelector ? Array.from(document.querySelectorAll(cfg.itemSelector)) : [];

  for (const n of nodes.slice(0, 30)) {
    const titleEl = cfg.titleSelector ? n.querySelector(cfg.titleSelector) : n.querySelector('a');
    const anchor =
      titleEl && titleEl.tagName === 'A' ? titleEl : titleEl ? titleEl.querySelector('a') : n.querySelector('a');
    if (!anchor) continue;

    const url = realUrl(n, anchor);
    if (!url || seen.has(url)) continue;

    const title = cleanText(titleEl ? titleEl.innerText || titleEl.textContent : anchor.textContent);
    if (!title) continue;

    let snippet = '';
    if (cfg.snippetSelector) {
      const sEl = n.querySelector(cfg.snippetSelector);
      if (sEl) snippet = cleanText(sEl.innerText || sEl.textContent);
    }
    if (!snippet) {
      // 退而求其次：取整块文本去掉标题
      const whole = cleanText(n.innerText || n.textContent);
      snippet = whole.startsWith(title) ? whole.slice(title.length).trim() : whole;
    }

    seen.add(url);
    items.push({ title: title.slice(0, 200), url, snippet: snippet.slice(0, 600) });
    if (items.length >= 20) break;
  }

  // 一个容器都没命中时，全页扫标题链接兜底
  if (!items.length) {
    for (const a of Array.from(document.querySelectorAll('a[href^="http"]'))) {
      const url = absolute(a.getAttribute('href'));
      if (!url || isExcluded(url) || seen.has(url)) continue;
      const title = cleanText(a.innerText || a.textContent);
      if (title.length < 6) continue;
      seen.add(url);
      items.push({ title: title.slice(0, 200), url, snippet: '' });
      if (items.length >= 20) break;
    }
  }

  return {
    status: 'ok',
    items,
    note: items.length ? `解析到 ${items.length} 条结果` : '未解析到结果',
  };
}

/**
 * 探测检索结果页是否就绪 / 是否被验证码拦截
 * 同样必须完全自包含。
 */
function probeSearchPage(readySelector) {
  const bodyHead = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 600);
  const blocked =
    /captcha|人机验证|安全验证|异常流量|unusual traffic|just a moment|verify you are human|are you a robot|访问受限/i.test(
      location.href + ' ' + bodyHead
    );
  return {
    url: location.href,
    blocked,
    hasResults: readySelector ? !!document.querySelector(readySelector) : true,
    textLen: (document.body && document.body.innerText ? document.body.innerText : '').length,
  };
}

async function injectParse(tabId, engine) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: parseSearchResults,
      args: [engine.parse || {}],
    });
    return res && res[0] ? res[0].result : { status: 'failed', note: '解析无返回', items: [] };
  } catch (e) {
    return { status: 'failed', note: `解析失败：${String((e && e.message) || e)}`, items: [] };
  }
}

// ---------- 工具 ----------

function resolveEngineIds(engineIds) {
  if (Array.isArray(engineIds) && engineIds.length) {
    const valid = engineIds.filter((id) => SEARCH_ENGINE_BY_ID[id]);
    if (valid.length) return valid;
  }
  return [DEFAULT_SEARCH_ENGINES[0]];
}

async function openBackgroundTab() {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  return tab.id;
}

async function waitForTabLoad(tabId, timeoutMs) {
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
        if (t && t.status === 'complete') finish();
      })
      .catch(finish);
  });
}

/** 轮询等结果容器出现 */
async function waitForSearchReady(tabId, engine, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let probe;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: probeSearchPage,
        args: [engine.readySelector || ''],
      });
      probe = res && res[0] ? res[0].result : null;
    } catch {
      continue; // 页面还在跳转，下一轮再试
    }
    if (!probe) continue;
    if (probe.blocked) return { ready: false, blocked: true };
    if (probe.hasResults && probe.textLen > 150) return { ready: true, blocked: false };
    await sleep(600);
  }
  return { ready: false, blocked: false };
}

/** 同一 URL 只保留一条，优先保留摘要更完整的那条 */
export function dedupeByUrl(items) {
  const map = new Map();
  for (const it of items || []) {
    if (!it || !it.url) continue;
    const key = it.url.split('#')[0];
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...it });
      continue;
    }
    const score = (x) => (x.snippet ? x.snippet.length : 0) + (x.title ? 40 : 0);
    if (score(it) > score(prev)) map.set(key, { ...it });
  }
  return [...map.values()];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
