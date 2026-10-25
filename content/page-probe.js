// content/page-probe.js —— 页面穿透找图 + 社交平台原图 URL 还原
//
// 解决两个核心痛点：
//  1. 遮罩层拦截右键：小红书、Instagram、微博灯箱常在 <img> 上方覆盖透明 <div>，
//     导致仅注册 contexts:['image'] 时右键菜单不出，或拿不到底层图片。
//     => 监听 contextmenu，用 elementsFromPoint 遍历鼠标下方所有元素。
//  2. 缩略图误搜：页面展示多为裁剪后的 WebP/AVIF 缩略图，且缩略图必定被剥离 EXIF/C2PA。
//     => 解析 srcset 取最大宽度候选，再按 CDN 规则还原原图 URL。

let lastRightClickTarget = null;

// 记录右键点击瞬间的真实图片信息（穿透顶层透明遮罩 div）
document.addEventListener(
  'contextmenu',
  (e) => {
    try {
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      lastRightClickTarget = findBestImageFromElements(elements, e.clientX, e.clientY);
    } catch {
      lastRightClickTarget = { fallbackX: e.clientX, fallbackY: e.clientY };
    }
  },
  true
);

function findBestImageFromElements(elements, clientX, clientY) {
  for (const el of elements) {
    if (!el || !el.tagName) continue;

    // 1. 标准 <img> 或 <picture> 内部的 <img>
    if (el.tagName === 'IMG') {
      const rawUrl =
        pickLargestSrcset(el) ||
        el.currentSrc ||
        el.src ||
        el.dataset?.src ||
        el.dataset?.original ||
        el.getAttribute('data-origin') ||
        el.getAttribute('data-original');
      if (rawUrl) {
        return buildTargetInfo(el, rawUrl, 'img');
      }
    }

    // 2. <canvas> 元素
    if (el.tagName === 'CANVAS') {
      try {
        const dataUrl = el.toDataURL('image/png');
        return buildTargetInfo(el, dataUrl, 'canvas');
      } catch {
        // 画布被跨域污染，无法读取像素
        return buildTargetInfo(el, '', 'canvas-tainted');
      }
    }

    // 3. CSS background-image
    const bg = window.getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none' && bg.includes('url(')) {
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m && m[1] && !m[1].startsWith('data:image/svg')) {
        return buildTargetInfo(el, m[1], 'css-bg');
      }
    }
  }
  return { fallbackX: clientX, fallbackY: clientY };
}

/** 从 srcset 里挑宽度最大的候选 */
function pickLargestSrcset(imgEl) {
  const srcset =
    imgEl.getAttribute('srcset') ||
    imgEl.parentElement?.querySelector('source[srcset]')?.getAttribute('srcset');
  if (!srcset) return null;

  let bestUrl = null;
  let maxScore = -1;

  for (const part of srcset.split(',')) {
    const tokens = part.trim().split(/\s+/);
    if (!tokens[0]) continue;
    const desc = tokens[1] || '1x';
    // 640w 形式按宽度计分；2x 形式按宽度*1000 粗略折算
    const score = desc.endsWith('w') ? parseFloat(desc) : parseFloat(desc) * 1000;
    if (!Number.isNaN(score) && score > maxScore) {
      maxScore = score;
      try {
        bestUrl = new URL(tokens[0], location.href).href;
      } catch {
        bestUrl = tokens[0];
      }
    }
  }
  return bestUrl;
}

/** 社交平台原图 URL 还原规则 */
function upgradeToOriginalUrl(urlStr) {
  try {
    const u = new URL(urlStr, location.href);

    // 微博图床：缩略图升大图
    if (/\.sinaimg\.cn$/i.test(u.hostname)) {
      u.pathname = u.pathname.replace(
        /\/(orj360|mw690|thumb150|bmiddle|small|square|mw200)\//i,
        '/mw2000/'
      );
    }

    // Twitter / X 图床：name=small -> name=orig
    if (/pbs\.twimg\.com$/i.test(u.hostname) && u.searchParams.has('name')) {
      u.searchParams.set('name', 'orig');
    }

    // 小红书图床：剥离末尾 ?imageView2 缩放参数
    if (/\.xhscdn\.com$/i.test(u.hostname) && u.search.includes('imageView2')) {
      u.search = '';
    }

    return u.href;
  } catch {
    return urlStr;
  }
}

function buildTargetInfo(el, rawUrl, sourceType) {
  const rect = el.getBoundingClientRect();
  let absUrl = '';
  try {
    absUrl = rawUrl ? new URL(rawUrl, location.href).href : '';
  } catch {
    absUrl = rawUrl || '';
  }
  return {
    sourceType,
    originalUrl: absUrl,
    normalizedUrl: absUrl ? upgradeToOriginalUrl(absUrl) : '',
    width: el.naturalWidth || Math.round(rect.width),
    height: el.naturalHeight || Math.round(rect.height),
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      dpr: window.devicePixelRatio || 1,
    },
  };
}

// 响应 Service Worker 的取图请求
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'probe:get-context-target') {
    sendResponse(lastRightClickTarget);
    return false;
  }
  if (msg.type === 'probe:fetch-in-page') {
    fetchImageInPageContext(msg.url).then(sendResponse);
    return true; // 异步响应
  }
  if (msg.type === 'probe:set-probe') {
    // 供自动化测试注入探测结果（不影响正常流程）
    lastRightClickTarget = msg.probe || null;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function fetchImageInPageContext(targetUrl) {
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
}
