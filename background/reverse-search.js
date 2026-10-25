// background/reverse-search.js —— 双模式多引擎反向搜图
//
// 模式 1（url-direct）：图片为公网可直链 URL 时，后台并发打开各引擎的 URL 直搜入口。
// 模式 2（clipboard）：blob:/data:/截图 或 微信·微博·小红书等防盗链图床时，
//   由侧栏把高清原图写入系统剪贴板，并打开各引擎首页，用户按 Ctrl+V 即可上传检索。
//
// 两种模式都会做「验证码自动感知」：标签页打开约 3.5 秒后注入轻量探测脚本，
// 命中验证码特征则把该引擎标记为 blocked，提醒人工过验证。

import { ENGINES, ANTI_BOT_KEYWORDS } from '../lib/constants.js';
import { loadOptions } from './store.js';

const TAB_INTERVAL_MS = 150;
const PROBE_DELAY_MS = 3500;

/**
 * 打开反搜引擎标签页
 * @param {object} image inv.image
 * @param {number|undefined} windowId 目标窗口；为 undefined 时只准备不打开（手动上传场景）
 * @param {boolean} autoOpen 是否自动打开标签页
 */
export async function openReverseSearches(image, windowId, autoOpen = true) {
  const options = await loadOptions();
  const enabled = new Set(options.enabledEngines || ENGINES.map((e) => e.id));
  const useClipboard = !image.canDirectLink || /^(blob:|data:)/i.test(image.normalizedUrl || '');

  const results = [];
  const targets = ENGINES.filter((e) => enabled.has(e.id));

  for (const engine of targets) {
    const mode = useClipboard ? 'clipboard-paste' : engine.mode === 'clipboard' ? 'clipboard-paste' : 'url-direct';
    // 百度识图本身无稳定 GET 直搜口，任何情况下都走剪贴板
    const finalMode = engine.id === 'baidu' ? 'clipboard-paste' : mode;

    const entry = {
      id: engine.id,
      name: engine.name,
      mode: finalMode,
      url: finalMode === 'url-direct' ? engine.buildUrl(image.normalizedUrl || image.originalUrl) : engine.openUrl,
      tabId: null,
      status: 'pending',
      openedAt: new Date().toISOString(),
      focus: engine.focus,
    };

    // 自动打开需要同时满足：配置允许 + 有目标窗口 + 有可直链 URL
    const shouldOpen = autoOpen && options.autoOpenEngines !== false && windowId !== undefined;
    if (!shouldOpen) {
      entry.status = 'pending';
      entry.note = options.autoOpenEngines === false
        ? '已在配置中关闭自动打开，可点下方按钮手动打开'
        : '本地图片没有公网地址，请复制图片后到引擎首页按 Ctrl+V 检索';
      results.push(entry);
      continue;
    }

    try {
      const tab = await chrome.tabs.create({ url: entry.url, active: false, windowId });
      entry.tabId = tab.id;
      entry.status = finalMode === 'clipboard-paste' ? 'pending-paste' : 'opened';
      entry.note =
        finalMode === 'clipboard-paste'
          ? '已打开引擎首页：切换到该标签页按 Ctrl+V 粘贴图片'
          : '已打开检索结果页';
    } catch (e) {
      entry.status = 'failed';
      entry.note = `打开失败：${e?.message || e}`;
    }

    results.push(entry);

    // 错开创建间隔，避免瞬间开 5 个标签页触发同源风控或卡顿
    await sleep(TAB_INTERVAL_MS);
  }

  // 异步探测验证码（不阻塞主流程）
  if (windowId !== undefined) scheduleCaptchaProbe(results, windowId);

  return results;
}

/** 延时注入验证码探测脚本 */
function scheduleCaptchaProbe(engines, windowId) {
  setTimeout(() => {
    for (const eng of engines) {
      if (eng.tabId && eng.status === 'opened') {
        probeCaptcha(eng.tabId).then((blocked) => {
          if (blocked) {
            eng.status = 'blocked';
            eng.note = '该引擎触发了验证码/人机验证，请手动点开通过验证';
            notifyPanel();
          }
        });
      }
    }
  }, PROBE_DELAY_MS);
}

/** 注入轻量探测脚本，检查页面标题与可见文本 */
async function probeCaptcha(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (keywords) => {
        const haystack = `${document.title || ''}\n${(document.body?.innerText || '').slice(0, 6000)}`.toLowerCase();
        return keywords.some((k) => haystack.includes(k.toLowerCase()));
      },
      args: [ANTI_BOT_KEYWORDS],
    });
    return Boolean(results?.[0]?.result);
  } catch {
    return false; // 探测失败不算命中
  }
}

/** 通知侧栏刷新（引擎状态变化） */
function notifyPanel() {
  chrome.runtime.sendMessage({ type: 'engines:updated' }).catch(() => {
    /* 侧栏未打开时忽略 */
  });
}

/**
 * 手动打开单个引擎（侧栏按钮触发）
 * @param {string} engineId
 * @param {object} image
 * @param {boolean} useClipboard
 */
export async function openSingleEngine(engineId, image, useClipboard) {
  const engine = ENGINES.find((e) => e.id === engineId);
  if (!engine) return { ok: false, error: '未知引擎' };

  const mode =
    engine.id === 'baidu' || useClipboard ? 'clipboard-paste' : engine.mode === 'clipboard' ? 'clipboard-paste' : 'url-direct';
  const url = mode === 'url-direct' ? engine.buildUrl(image.normalizedUrl || image.originalUrl) : engine.openUrl;

  try {
    const tab = await chrome.tabs.create({ url, active: true });
    return {
      ok: true,
      tabId: tab.id,
      mode,
      url,
      note:
        mode === 'clipboard-paste'
          ? '已打开引擎首页：切换到该标签页按 Ctrl+V 粘贴图片'
          : '已打开检索结果页',
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** 把图片以 PNG 形式写入系统剪贴板（防盗链回退路径） */
export async function copyImageToClipboard(base64, mime = 'image/png') {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
