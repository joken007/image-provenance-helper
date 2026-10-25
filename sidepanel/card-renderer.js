// sidepanel/card-renderer.js —— 双遍测量自适应高度 Canvas 渲染与 PNG 导出
//
// 关键点：画布高度不是死锁的 1080×1440，而是先做「Dry-Run 测量」算出精确总高，
// 再按 1080 × totalHeight（× SCALE=2 得 2160px 宽高清图）正式绘制。
// 这样无论正文多长，都不会出现文字截断或重叠。

import { CARD } from '../lib/constants.js';

const W = CARD.W;
const SCALE = CARD.SCALE;
const PAD = CARD.PAD;
const CONTENT_W = W - PAD * 2;
const FONT = CARD.FONT;

const COLORS = {
  bg: '#F8FAFC',
  brand: '#1E293B',
  brandText: '#FFFFFF',
  title: '#0F172A',
  subtitle: '#475569',
  section: '#2563EB',
  body: '#1E293B',
  highlightBg: '#FEF2F2',
  highlightText: '#991B1B',
  highlightBar: '#DC2626',
  line: '#E2E8F0',
  muted: '#64748B',
  watermark: 'rgba(71, 85, 105, 0.55)',
  coverShade: 'rgba(15, 23, 42, 0.72)',
  coverBadge: '#F1F5F9',
};

/**
 * 渲染事实核查卡
 * @param {HTMLCanvasElement} canvasEl
 * @param {object} draft 文案结构
 * @param {Blob|null} coverBlob 封面图（原图）
 * @param {string} watermark 水印
 */
export async function renderFactCheckCard(canvasEl, draft, coverBlob, watermark = '@图片溯源核查笔记') {
  const coverImg = coverBlob ? await blobToImage(coverBlob).catch(() => null) : null;

  const sections = [
    { title: '网传说法', items: [draft.claim || '（未填写）'], highlight: false },
    { title: '核查结论', items: [draft.conclusion || '（未生成）'], highlight: true },
    {
      title: '核心证据链',
      items: draft.evidence?.length ? draft.evidence : ['暂无足够公开证据'],
      bullet: true,
    },
    { title: '判定依据', items: [draft.basis || '（未填写）'], highlight: false },
    {
      title: '可核验来源',
      items: draft.sources?.length
        ? draft.sources.map((s) => `${s.label}（${shortenUrl(s.url)}）`)
        : ['本次核查未检索到更早的公开网页链接'],
      bullet: true,
    },
  ];

  // ---------- 第一遍：Dry-Run 测量 ----------
  const measureCtx = createMeasureContext();
  const layout = computeCardLayout(measureCtx, draft, sections, Boolean(coverImg));

  // ---------- 第二遍：正式绘制 ----------
  const H = layout.totalHeight;
  canvasEl.width = W * SCALE;
  canvasEl.height = H * SCALE;
  const ctx = canvasEl.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'alphabetic';

  // 1) 背景与顶部品牌识别条
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = COLORS.brand;
  ctx.fillRect(0, 0, W, 76);
  ctx.fillStyle = COLORS.brandText;
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText('图片溯源与事实核查报告', PAD, 48);

  // 2) 封面图区域（等比居中裁切 + 底部来源角标）
  const coverTop = 76;
  const coverH = 580;
  if (coverImg) {
    drawCoverImage(ctx, coverImg, 0, coverTop, W, coverH);
    ctx.fillStyle = COLORS.coverShade;
    ctx.fillRect(W - 330, coverTop + coverH - 52, 310, 38);
    ctx.fillStyle = COLORS.coverBadge;
    ctx.font = `400 18px ${FONT}`;
    ctx.fillText('待核查原图画面截取', W - 314, coverTop + coverH - 26);
  } else {
    ctx.fillStyle = '#E2E8F0';
    ctx.fillRect(0, coverTop, W, coverH);
    ctx.fillStyle = '#94A3B8';
    ctx.font = `400 24px ${FONT}`;
    ctx.fillText('（原图不可用）', PAD, coverTop + coverH / 2);
  }

  // 3) 大标题与副标题
  let y = layout.bodyStartY;
  ctx.fillStyle = COLORS.title;
  ctx.font = `700 46px ${FONT}`;
  for (const line of layout.headlineLines) {
    ctx.fillText(line, PAD, y);
    y += 60;
  }
  y += 8;
  ctx.fillStyle = COLORS.subtitle;
  ctx.font = `400 28px ${FONT}`;
  for (const line of layout.subheadLines) {
    ctx.fillText(line, PAD, y);
    y += 40;
  }
  y += 28;

  // 4) 逐个绘制结构化内容块
  for (const block of layout.blocks) {
    if (block.highlight) {
      ctx.fillStyle = COLORS.highlightBg;
      ctx.fillRect(PAD - 16, y - 34, CONTENT_W + 32, block.boxHeight);
      ctx.fillStyle = COLORS.highlightBar;
      ctx.fillRect(PAD - 16, y - 34, 6, block.boxHeight);
    } else {
      ctx.fillStyle = COLORS.section;
    }
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(block.title, PAD, y);
    y += 42;

    ctx.fillStyle = block.highlight ? COLORS.highlightText : COLORS.body;
    ctx.font = `${block.highlight ? 700 : 400} 24px ${FONT}`;
    for (const line of block.lines) {
      ctx.fillText(line, PAD, y);
      y += 38;
    }
    y += 28;
  }

  // 5) 底部核查时间、免责声明与右对齐水印
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, H - 130);
  ctx.lineTo(W - PAD, H - 130);
  ctx.stroke();

  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 18px ${FONT}`;
  ctx.fillText(`核查时间：${draft.checkedAt || new Date().toISOString().slice(0, 10)}`, PAD, H - 90);
  ctx.fillText(
    draft.disclaimer || '声明：本报告基于公开图像元数据与网页归档记录整理，结论随新证据更新。',
    PAD,
    H - 56
  );

  ctx.save();
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.watermark;
  ctx.font = `600 20px ${FONT}`;
  ctx.fillText(watermark, W - PAD, H - 90);
  ctx.restore();

  return { width: canvasEl.width, height: canvasEl.height, cssWidth: W, cssHeight: H };
}

/** 计算布局（含精确折行行数与总高度） */
function computeCardLayout(ctx, draft, sections, hasCover) {
  const measure = (text) => ctx.measureText(text).width;

  ctx.font = `700 46px ${FONT}`;
  const headlineLines = wrapText(measure, draft.headline || '图片事实核查', CONTENT_W).slice(0, 2);
  ctx.font = `400 28px ${FONT}`;
  const subheadLines = wrapText(measure, draft.subhead || '', CONTENT_W).slice(0, 2);

  const coverH = hasCover ? 580 : 580;
  let y = 76 + coverH + 56;
  const bodyStartY = y;
  y += headlineLines.length * 60 + 8 + subheadLines.length * 40 + 28;

  const blocks = [];
  for (const sec of sections) {
    ctx.font = `${sec.highlight ? 700 : 400} 24px ${FONT}`;
    const allLines = [];
    for (const item of sec.items) {
      const prefix = sec.bullet ? '• ' : '';
      allLines.push(...wrapText(measure, prefix + (item || ''), CONTENT_W));
    }
    const boxHeight = 42 + allLines.length * 38 + 16;
    blocks.push({ title: sec.title, lines: allLines, highlight: Boolean(sec.highlight), boxHeight });
    y += 42 + allLines.length * 38 + 28;
  }

  const totalHeight = Math.max(1350, Math.ceil(y + 150));
  return { bodyStartY, headlineLines, subheadLines, blocks, totalHeight };
}

/** 创建离屏测量上下文 */
function createMeasureContext() {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  return ctx;
}

/** 中文优先折行（与 lib/utils.js 同算法，此处接受 measure 函数） */
export function wrapText(measure, text, maxWidth) {
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

/** 等比居中裁切绘制封面图 */
function drawCoverImage(ctx, img, x, y, w, h) {
  const imgRatio = img.width / img.height;
  const boxRatio = w / h;
  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;
  if (imgRatio > boxRatio) {
    sw = img.height * boxRatio;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / boxRatio;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

export function shortenUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.hostname + (parsed.pathname.length > 24 ? parsed.pathname.slice(0, 24) + '...' : parsed.pathname);
  } catch {
    return u;
  }
}

/** 触发 PNG 下载 */
export function downloadCanvas(canvasEl, filename) {
  return new Promise((resolve) => {
    canvasEl.toBlob((blob) => {
      if (!blob) {
        resolve({ ok: false, error: '画布导出失败' });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `factcheck-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      resolve({ ok: true, bytes: blob.size });
    }, 'image/png');
  });
}
