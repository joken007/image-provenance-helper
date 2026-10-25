// lib/utils.js —— 纯函数工具集（浏览器与 Node 双端可用，便于单测）

import { NOISE_QUERY_KEYS, CDN_UPGRADE_RULES, HOTLINK_PROTECTED_HOSTS } from './constants.js';

/** base64 -> Uint8Array（浏览器 / Node 通用） */
export function base64ToUint8(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array -> base64（分块，避免 apply 参数溢出） */
export function uint8ToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
}

/** 字节数组 -> hex */
export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** 计算 SHA-256（返回 hex）。优先用 WebCrypto，Node 环境下回退 crypto.subtle 亦可用。 */
export async function sha256Hex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(new Uint8Array(digest));
}

/** 取主机名，失败返回 unknown */
export function safeHost(url) {
  try {
    return new URL(url).hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 判断是否为受强防盗链保护的图床 */
export function isHotlinkProtected(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOTLINK_PROTECTED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

/** 判断是否为 blob: / data: 这类不可直链的 URL */
export function isNonDirectUrl(url) {
  if (!url) return true;
  return /^(blob:|data:|filesystem:)/i.test(url.trim());
}

/**
 * 平台原图 URL 还原：把缩略图地址升级为原图地址。
 * 失败或无匹配规则时原样返回。
 */
export function upgradeToOriginalUrl(urlStr) {
  if (!urlStr) return '';
  try {
    const u = new URL(urlStr);
    for (const rule of CDN_UPGRADE_RULES) {
      if (rule.match(u)) return rule.apply(new URL(urlStr)).href;
    }
    return u.href;
  } catch {
    return urlStr;
  }
}

/** 取命中的 CDN 规则说明（用于侧栏展示还原依据） */
export function describeCdnRule(urlStr) {
  try {
    const u = new URL(urlStr);
    for (const rule of CDN_UPGRADE_RULES) {
      if (rule.match(u)) return rule.note;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/** URL 去噪归一化：剥离追踪/营销参数与末尾斜杠，供 Wayback 精确匹配 */
export function normalizeForArchive(urlStr) {
  if (!urlStr) return '';
  try {
    const u = new URL(urlStr);
    for (const key of [...u.searchParams.keys()]) {
      if (NOISE_QUERY_KEYS.includes(key.toLowerCase())) u.searchParams.delete(key);
    }
    // 常见 CDN 尺寸参数
    for (const key of ['imageView2', 'w', 'h', 'width', 'height', 'quality', 'format']) {
      if (u.searchParams.has(key) && NOISE_QUERY_KEYS.includes(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    let href = u.href;
    if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
    return href;
  } catch {
    return urlStr;
  }
}

/** 判断 URL 是否指向图片资源（按扩展名粗判） */
export function looksLikeImageUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** 短 URL 显示（用于证据卡来源列表） */
export function shortenUrl(u) {
  try {
    const parsed = new URL(u);
    const tail = parsed.pathname.length > 24 ? parsed.pathname.slice(0, 24) + '...' : parsed.pathname;
    return parsed.hostname + tail;
  } catch {
    return u;
  }
}

/**
 * 中文优先的折行算法（纯字符级，符合 canvas measureText 的使用场景）
 * 避免行首出现标点符号。
 */
export function wrapChineseText(measure, text, maxWidth) {
  const out = [];
  let line = '';
  const noLineStart = '，。、；：？！）》”’%·';
  for (const ch of String(text || '')) {
    if (ch === '\n') {
      out.push(line);
      line = '';
      continue;
    }
    if (measure(line + ch) > maxWidth && line.length > 0) {
      if (noLineStart.includes(ch)) {
        out.push(line + ch);
        line = '';
      } else {
        out.push(line);
        line = ch;
      }
    } else {
      line += ch;
    }
  }
  if (line) out.push(line);
  return out;
}

/** 生成核查会话 ID */
export function newInvestigationId(ts = Date.now()) {
  return `inv_${ts}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 从 URL 中提取有意义的文件名（作为默认标题） */
export function filenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return name.replace(/\.[a-z0-9]{2,5}$/i, '') || u.hostname;
  } catch {
    return '';
  }
}
