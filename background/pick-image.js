// background/pick-image.js —— 取图与原图还原（三级降级 + 防盗链判定）
//
// 三级降级：
//  L1 页面上下文带凭证抓取（主力）—— executeScript 到当前标签页 fetch，自动带 Referer + Cookie
//  L2 Service Worker 跨域直取 —— 绕过页面 CSP 与 CORS，同时用于判定「是否公网可直链」
//  L3 视口截图裁剪兜底 —— 加密 Canvas / DRM 保护时使用，标记 acquiredVia: 'screenshot'
//
// 防盗链判定：L2 的无 Referer 请求能拿到 200 image/* 即视为 canDirectLink = true。

import { base64ToUint8, uint8ToBase64, sha256Hex, upgradeToOriginalUrl, describeCdnRule, isHotlinkProtected, isNonDirectUrl } from '../lib/utils.js';
import { putImageBlob } from '../lib/idb-blob-cache.js';

/**
 * @param {object} ctx { tabId, windowId, frameId, srcUrl, pageUrl, pageTitle, pickLargest }
 */
export async function acquireImage(ctx) {
  const notes = [];
  const meta = {
    originalUrl: ctx.srcUrl || '',
    normalizedUrl: ctx.srcUrl ? upgradeToOriginalUrl(ctx.srcUrl) : '',
    canDirectLink: false,
    pageUrl: ctx.pageUrl || '',
    pageTitle: ctx.pageTitle || '',
    pageSite: '',
    width: 0,
    height: 0,
    mime: 'image/jpeg',
    sha256: '',
    acquiredVia: 'page-context',
    cdnNote: ctx.srcUrl ? describeCdnRule(ctx.srcUrl) : '',
  };

  // ---------- 目标图 URL 的确定：右键菜单优先，页面探测兜底 ----------
  //
  // 【为什么不能无条件采用页面探测结果】
  //   content script 里记录的是「最后一次右键命中的图片」，是个长期存在的全局变量。
  //   如果用户先右键了 A 图，之后又用快捷键/工具栏触发（此时没有右键动作），
  //   探测返回的仍是 A 图 —— 结果就是「搜的不是用户以为的那张」。
  //   所以：右键菜单已经明确给了 srcUrl 时，以它为准；只有它为空（快捷键/工具栏触发）才用探测结果。
  //
  // 【探测为何固定查主框架】
  //   page-probe.js 在主框架注册了 contextmenu 监听（all_frames: true 只是让它能在子框架里也跑，
  //   但每个框架各有一份自己的 lastRightClickTarget）。右键 iframe 里的图时，
  //   命中记录在子框架；而这里统一从主框架问，拿不到就用 ctx.srcUrl —— 右键菜单给的 srcUrl
  //   本来就是权威值，因此这个组合不会取错图，也不会因为框架 ID 对不上而报错。
  let probe = null;
  try {
    probe = await requestProbeTarget(ctx.tabId, 0);
  } catch (e) {
    notes.push(`页面探测不可用：${e?.message || e}`);
  }

  const ctxSrc = String(ctx.srcUrl || '').trim();
  const probeUrl = String(probe?.originalUrl || '').trim();

  if (ctxSrc) {
    // 右键菜单来源：以 ctx.srcUrl 为准。若探测结果与它不同，记录下来供排查。
    notes.push('取图目标来自右键菜单命中项');
    if (probeUrl && !sameImage(ctxSrc, probeUrl)) {
      notes.push('（页面探测结果与右键项不一致，已按右键项为准）');
    }
  } else if (probeUrl) {
    meta.originalUrl = probeUrl;
    meta.normalizedUrl = probe.normalizedUrl || upgradeToOriginalUrl(probeUrl);
    meta.cdnNote = describeCdnRule(probeUrl) || meta.cdnNote;
    notes.push('取图目标来自页面探测（无右键上下文）');
  }

  // 尺寸/画布信息：无论 URL 从哪来，探测到的尺寸都可参考
  if (probe) {
    if (probe.width) meta.width = probe.width;
    if (probe.height) meta.height = probe.height;
    if (probe.sourceType === 'canvas') meta.acquiredVia = 'manual-drop';
  }

  // 快捷键/工具栏触发（srcUrl 为空）且要求「取页面最大图」时，
  // 若探测没给结果，就退回按页面内容挑主图
  if (!ctxSrc && !probeUrl && ctx.pickLargest) {
    const largest = await pickLargestInPage(ctx.tabId, ctx.frameId);
    if (largest?.url) {
      meta.originalUrl = largest.url;
      meta.normalizedUrl = upgradeToOriginalUrl(largest.url);
      meta.width = largest.width || meta.width;
      meta.height = largest.height || meta.height;
      notes.push('已按页面可见面积挑选主图');
    } else {
      notes.push('页面内未找到可用图片');
    }
  }

  const targetUrl = meta.normalizedUrl || meta.originalUrl;

  // ---------- Level 1：页面上下文带凭证抓取 ----------
  if (targetUrl && !isNonDirectUrl(targetUrl)) {
    const r = await fetchInPageContext(ctx.tabId, ctx.frameId, targetUrl);
    if (r?.bytesBase64) {
      meta.mime = r.mime || meta.mime;
      meta.width = r.width || meta.width;
      meta.height = r.height || meta.height;
      meta.acquiredVia = 'page-context';
      notes.push('已通过页面上下文（携带 Referer 与 Cookie）成功抓取原图');
      return finalize(meta, r.bytesBase64, notes);
    }
    notes.push(`页面上下文抓取失败：${r?.error || '未知原因'}`);
  } else if (isNonDirectUrl(targetUrl)) {
    notes.push('目标为 blob:/data: 资源，无法直连抓取');
  }

  // ---------- Level 2：Service Worker 跨域直取（同时判定防盗链） ----------
  if (targetUrl && /^https?:/i.test(targetUrl)) {
    const r = await fetchDirect(targetUrl);
    if (r?.ok) {
      meta.mime = r.mime || meta.mime;
      meta.width = r.width || meta.width;
      meta.height = r.height || meta.height;
      meta.acquiredVia = 'direct';
      meta.canDirectLink = true;
      notes.push('已通过扩展直连抓取原图（该图片支持公网无 Referer 直链）');
      return finalize(meta, r.bytesBase64, notes);
    }
    // 403 / 401 => 典型防盗链
    meta.canDirectLink = false;
    notes.push(
      r?.status === 403 || r?.status === 401
        ? '直连返回 403：该图片受防盗链保护，反搜将走剪贴板粘贴模式'
        : `直连失败：${r?.error || `HTTP ${r?.status}`}`
    );
  }

  // ---------- Level 3：视口截图裁剪兜底 ----------
  //
  // 【为什么必须传 windowId 而不是 tabId】
  //   chrome.tabs.captureVisibleTab(windowId?, options?) 的第一个参数是 **窗口 ID**，不是标签页 ID。
  //   传 tabId 进去时，Chrome 会拿这个数字当窗口 ID 去找窗口 —— 多窗口场景下会截到
  //   另一个窗口的可见区域，再按坐标裁剪，就得到一张完全不相干的图，
  //   而整个流程看起来「正常成功」。这是最隐蔽的一类「搜错图」。
  if (probe?.rect && ctx.tabId) {
    const shot = await captureRegion(ctx.tabId, ctx.windowId, probe.rect);
    if (shot?.bytesBase64) {
      meta.acquiredVia = 'screenshot';
      meta.mime = shot.mime || 'image/png';
      meta.width = shot.width || probe.rect.width;
      meta.height = shot.height || probe.rect.height;
      notes.push('前两级取图失败，已降级为视口区域截图（原始元数据不可用）');
      return finalize(meta, shot.bytesBase64, notes);
    }
    notes.push(`截图兜底同样失败：${shot?.error || '未知原因'}`);
  }

  // 全部失败：仍返回一个壳，交由侧栏提示用户手动上传
  meta.acquiredVia = 'manual-drop';
  meta.error = notes.join('；');
  return { meta, bytesBase64: null, notes };
}

/** 落库 + 计算 sha256 */
async function finalize(meta, bytesBase64, notes) {
  try {
    const bytes = base64ToUint8(bytesBase64);
    meta.sha256 = await sha256Hex(bytes);
    const blob = new Blob([bytes], { type: meta.mime });
    await putImageBlob(meta.sha256, blob);
    notes.push('图片字节已存入 IndexedDB 临时缓存（按 SHA-256 索引）');
  } catch (e) {
    notes.push(`写入图片缓存失败：${e?.message || e}`);
  }
  meta.notes = notes.join('；');
  return { meta, bytesBase64, notes };
}

/**
 * 取图自检：记录「实际拿去搜索的图」的关键指纹。
 *
 * 【为什么要做这一步】
 *   「搜错图」是这类插件最致命也最难发现的问题 —— 全流程看起来都成功，
 *   只是搜的不是用户点的那张。除了从取图逻辑上逐条堵漏，还必须让用户**看得见**：
 *   侧栏会展示实际取到的缩略图、来源 URL、尺寸、字节数、SHA-256 前 12 位。
 *   一旦不对，用户一眼就能发现，而不是等搜出一堆不相干结果才察觉。
 */
export function describeAcquisition(meta, bytesBase64) {
  const bytes = bytesBase64 ? Math.floor((bytesBase64.length * 3) / 4) : 0;
  return {
    url: meta.normalizedUrl || meta.originalUrl || '',
    originalUrl: meta.originalUrl || '',
    via: meta.acquiredVia || '',
    viaLabel: {
      'page-context': '页面上下文抓取（带 Referer/Cookie）',
      direct: '扩展直连抓取',
      screenshot: '视口截图裁剪',
      'manual-drop': '手动上传',
    }[meta.acquiredVia] || meta.acquiredVia || '',
    width: meta.width || 0,
    height: meta.height || 0,
    mime: meta.mime || '',
    bytes,
    sha256: meta.sha256 || '',
    shaShort: (meta.sha256 || '').slice(0, 12),
  };
}

/** 向 content script 询问右键命中的图片目标 */
function requestProbeTarget(tabId, frameId) {
  return new Promise((resolve, reject) => {
    chrome.tabs
      .sendMessage(tabId, { type: 'probe:get-context-target' }, { frameId })
      .then((res) => {
        if (!res) reject(new Error('页面未返回探测结果'));
        else resolve(res);
      })
      .catch((e) => reject(e));
  });
}

/**
 * 判断两个 URL 是否指向同一张图（宽松比较）。
 * 用于发现「右键项」与「页面探测项」不一致的情况，只作提示、不改变取值。
 */
function sameImage(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.href === ub.href) return true;
    // 同一路径不同尺寸参数（CDN 缩略图 vs 原图）视为同一张
    if (ua.origin === ub.origin && ua.pathname === ub.pathname) return true;
    return false;
  } catch {
    return String(a || '') === String(b || '');
  }
}

/**
 * 按「页面可见面积」挑主图（快捷键/工具栏触发、且页面探测无结果时使用）
 *
 * 【为什么按可见面积而不是原始像素】
 *   用户看到的「主图」是屏幕上最大的那张。有些站点会把巨大的隐藏图塞在页面里
 *   （预加载、SEO 图），按原始像素挑会挑到用户根本没看到的那张。
 *   因此优先按 getBoundingClientRect 的可见面积排序。
 */
async function pickLargestInPage(tabId, frameId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId ?? 0] },
      func: () => {
        let best = null;
        let bestArea = 0;
        for (const img of document.querySelectorAll('img')) {
          const r = img.getBoundingClientRect();
          if (r.width < 120 || r.height < 120) continue; // 排除图标、头像
          // 只考虑当前视口内可见的图
          if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
          const area = r.width * r.height;
          if (area > bestArea) {
            bestArea = area;
            best = {
              url: img.currentSrc || img.src || '',
              width: img.naturalWidth || Math.round(r.width),
              height: img.naturalHeight || Math.round(r.height),
            };
          }
        }
        return best;
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

/** Level 1：在页面上下文里 fetch（自动带 Referer 与 Cookie） */
async function fetchInPageContext(tabId, frameId, url) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId ?? 0] },
      func: async (targetUrl) => {
        try {
          const r = await fetch(targetUrl, { credentials: 'include', referrer: location.href });
          if (!r.ok) return { error: `HTTP ${r.status}` };
          const blob = await r.blob();
          const bmp = await createImageBitmap(blob).catch(() => null);
          const buf = await blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          return {
            mime: blob.type || 'image/jpeg',
            bytesBase64: btoa(bin),
            width: bmp?.width ?? 0,
            height: bmp?.height ?? 0,
          };
        } catch (e) {
          return { error: String(e?.message || e) };
        }
      },
      args: [url],
    });
    return results?.[0]?.result;
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/** Level 2：Service Worker 跨域直取（无 Referer） */
async function fetchDirect(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);

    const mime = resp.headers.get('content-type') || '';
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    }
    if (mime && !mime.startsWith('image/')) {
      return { ok: false, status: resp.status, error: `返回内容不是图片（${mime}）` };
    }

    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const dims = await readDimensions(bytes, mime);
    return {
      ok: true,
      mime: mime.split(';')[0] || 'image/jpeg',
      bytesBase64: uint8ToBase64(bytes),
      width: dims.width,
      height: dims.height,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Level 3：视口截图 + 坐标裁剪
 *
 * 【务必注意参数语义】
 *   captureVisibleTab(windowId?, options?) 的第一个参数是【窗口 ID】。
 *   传错会静默截到别的窗口，产生一张看起来正常、实际完全不相干的图。
 *   因此这里显式要求 windowId，拿不到就宁可失败（上层会提示手动上传），
 *   也绝不用 tabId 去凑。
 */
async function captureRegion(tabId, windowId, rect) {
  try {
    if (!Number.isInteger(windowId) || windowId < 0) {
      return { error: '缺少 windowId，无法安全截图（避免截错窗口）' };
    }
    const dpr = rect.dpr || 1;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const blob = await (await fetch(dataUrl)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // 解析 PNG 尺寸以便裁剪
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let imgW = 0;
    let imgH = 0;
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      imgW = view.getUint32(16, false);
      imgH = view.getUint32(20, false);
    }

    const sx = Math.max(0, Math.round(rect.x * dpr));
    const sy = Math.max(0, Math.round(rect.y * dpr));
    const sw = Math.min(imgW - sx, Math.round(rect.width * dpr));
    const sh = Math.min(imgH - sy, Math.round(rect.height * dpr));
    if (sw <= 0 || sh <= 0) return { error: '裁剪区域无效' };

    const cropped = await cropPng(bytes, sx, sy, sw, sh);
    if (!cropped) return { error: '截图裁剪失败' };
    return { bytesBase64: uint8ToBase64(cropped), mime: 'image/png', width: sw, height: sh };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/** 用离屏 canvas 做像素裁剪（Service Worker 无 DOM，此处走 OffscreenCanvas） */
async function cropPng(bytes, sx, sy, sw, sh) {
  try {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const blob = new Blob([bytes], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const out = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await out.arrayBuffer());
  } catch {
    return null;
  }
}

/** 轻量图片尺寸读取（PNG / JPEG / GIF / WebP） */
export async function readDimensions(bytes, mime = '') {
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i < bytes.length - 9) {
        if (bytes[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = bytes[i + 1];
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          const height = (bytes[i + 5] << 8) | bytes[i + 6];
          const width = (bytes[i + 7] << 8) | bytes[i + 8];
          return { width, height };
        }
        i += 2 + len;
      }
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
    }
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
      // WebP (VP8X / VP8 / VP8L)
      if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
        const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width: w, height: h };
      }
    }
  } catch {
    /* ignore */
  }
  return { width: 0, height: 0 };
}

/** 判断当前图片是否属于强防盗链图床（供上层直接决定反搜模式） */
export function shouldUseClipboardMode(url, canDirectLink) {
  if (!canDirectLink) return true;
  if (isNonDirectUrl(url)) return true;
  if (isHotlinkProtected(url)) return true;
  return false;
}
