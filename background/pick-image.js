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
 * @param {object} ctx { tabId, frameId, srcUrl, pageUrl, pageTitle }
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

  // 从 content script 拿更精确的目标信息（可能含原图 URL 与像素尺寸）
  let probe = null;
  try {
    probe = await requestProbeTarget(ctx.tabId, ctx.frameId);
  } catch (e) {
    notes.push(`页面探测不可用：${e?.message || e}`);
  }

  if (probe?.originalUrl) {
    meta.originalUrl = probe.originalUrl;
    meta.normalizedUrl = probe.normalizedUrl || upgradeToOriginalUrl(probe.originalUrl);
    meta.cdnNote = describeCdnRule(meta.originalUrl) || meta.cdnNote;
    if (probe.width) meta.width = probe.width;
    if (probe.height) meta.height = probe.height;
    if (probe.sourceType === 'canvas') meta.acquiredVia = 'manual-drop';
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
  if (probe?.rect && ctx.tabId) {
    const shot = await captureRegion(ctx.tabId, probe.rect);
    if (shot?.bytesBase64) {
      meta.acquiredVia = 'screenshot';
      meta.mime = shot.mime || 'image/png';
      meta.width = shot.width || probe.rect.width;
      meta.height = shot.height || probe.rect.height;
      notes.push('前两级取图失败，已降级为视口区域截图（原始元数据不可用）');
      return finalize(meta, shot.bytesBase64, notes);
    }
    notes.push('截图兜底同样失败');
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

/** Level 3：视口截图 + 坐标裁剪 */
async function captureRegion(tabId, rect) {
  try {
    const dpr = rect.dpr || 1;
    const dataUrl = await chrome.tabs.captureVisibleTab(tabId, { format: 'png' });
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
