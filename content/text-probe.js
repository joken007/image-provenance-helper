// content/text-probe.js —— 社交平台帖文正文抽取
//
// 为什么需要它：
//   现有的 page-probe.js 只处理「图片」——右键某张图，拿到图的 URL 与像素。
//   但网传谣言大量是「文字」形态：一段话、一个数字、一句结论。
//   本模块负责把「当前页面上那条内容」的正文抓出来，交给后台做断言拆解与联网核查。
//
// 三级抽取策略（按优先级）：
//   1. 选中文字：用户框选了某段话 —— 最精准，直接就是「某一条社群内容」
//   2. 平台选择器：按站点命中已知正文容器（小红书/微博/X/抖音/B站/知乎/公众号…）
//   3. 通用兜底：按「文字密度 - 链接密度」给候选容器打分，选最像正文的那块
//
// 严格禁止：
//   * 不读输入框内容、不读 cookie、不碰 localStorage / sessionStorage
//   * 只取可见文本（innerText 自动排除 display:none 的元素）
//   * 不修改页面 DOM

// ---------- 平台适配表 ----------

/**
 * 每个平台给出：域名匹配、正文选择器（按优先级）、作者选择器、标题选择器。
 * 选择器只取「可见正文容器」，避开导航栏、评论区、推荐流。
 */
const PLATFORMS = [
  {
    id: 'xiaohongshu',
    name: '小红书',
    host: /(^|\.)xiaohongshu\.com$/i,
    body: ['#detail-desc .note-text', '#detail-desc', '.note-content .desc', '.note-detail-mask .desc'],
    author: ['.author-wrapper .username', '.author-container .name', '.user-name'],
    title: ['#detail-title', '.note-content .title'],
  },
  {
    id: 'weibo',
    name: '微博',
    host: /(^|\.)(weibo\.com|m\.weibo\.cn|weibo\.cn)$/i,
    body: ['.card-wrap .wb_body', '.status-content', '#js_content', '.text-content'],
    author: ['.card-wrap .nickname', '.user-info .name', '.name'],
    title: [],
  },
  {
    id: 'x',
    name: 'X（推特）',
    host: /(^|\.)(x\.com|twitter\.com)$/i,
    body: ['[data-testid="tweetText"]', 'article [lang]'],
    author: ['[data-testid="User-Name"]', 'article a[href*="/"] span'],
    title: [],
  },
  {
    id: 'douyin',
    name: '抖音',
    host: /(^|\.)douyin\.com$/i,
    body: ['[data-e2e="video-desc"]', '.video-info-detail .desc', '.desc'],
    author: ['.user-info .name', '[data-e2e="video-author"]'],
    title: [],
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    host: /(^|\.)bilibili\.com$/i,
    body: ['.bpx-player-video-desc-info', '.video-desc-info-text', '.video-desc'],
    author: ['.up-name', '.username'],
    title: ['.video-title', 'h1[title]'],
  },
  {
    id: 'zhihu',
    name: '知乎',
    host: /(^|\.)zhihu\.com$/i,
    body: ['.RichText', '.Post-RichText', '.Answer-RichText'],
    author: ['.AuthorInfo-name', '.author-name'],
    title: ['h1.Question-title', '.Question-title'],
  },
  {
    id: 'wechat',
    name: '微信公众号',
    host: /(^|\.)mp\.weixin\.qq\.com$/i,
    body: ['#js_content', '.rich_media_content'],
    author: ['#js_name', '.rich_media_meta_nickname'],
    title: ['#activity-name', '.rich_media_title'],
  },
  {
    id: 'toutiao',
    name: '今日头条',
    host: /(^|\.)toutiao\.com$/i,
    body: ['.article-content', '.article-info', 'article'],
    author: ['.article-info .name', '.author-name'],
    title: ['h1', '.title'],
  },
  {
    id: 'douban',
    name: '豆瓣',
    host: /(^|\.)douban\.com$/i,
    body: ['.topic-content', '.note-content', '.review-content'],
    author: ['.topic-author .name', '.author'],
    title: ['h1', '.note-title'],
  },
  {
    id: 'tieba',
    name: '百度贴吧',
    host: /(^|\.)tieba\.baidu\.com$/i,
    body: ['.d_post_content', '.p_tail', '.post-content'],
    author: ['.p_author_name', '.d_user_name'],
    title: ['.core_title_txt', 'h1'],
  },
  {
    id: 'reddit',
    name: 'Reddit',
    host: /(^|\.)reddit\.com$/i,
    body: ['[data-testid="post-rtjson-content"]', '.md', '[data-testid="post-body"]'],
    author: [],
    title: [],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    host: /(^|\.)youtube\.com$/i,
    body: ['#description-inline-expander', 'ytd-text-inline-expander', '#description'],
    author: ['#owner-name', 'ytd-channel-name'],
    title: ['h1.title', 'h1'],
  },
];

/** 通用兜底时优先考虑的正文容器 */
const GENERIC_BODY_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '.article-content',
  '.post-content',
  '.entry-content',
  '.content',
  '#content',
  '.note-content',
  '.topic-content',
];

/** 明显属于导航/页脚/工具条/评论区的类名与标签，兜底抽取时降权 */
const CHROME_PATTERN = /nav|menu|sidebar|footer|header|banner|toolbar|comment|related|recommend|hot-list|popular/i;

/** 整行属于界面噪声时直接丢弃 */
const BOILERPLATE_LINE = new RegExp(
  [
    '^(关注|取关|收藏|点赞|赞|踩|评论|回复|分享|转发|举报|编辑|删除|更多|展开|收起|登录|注册|首页|发现|消息|通知|我|搜索|投稿|订阅|广告|客服|帮助|隐私|协议|意见反馈|返回|复制链接|网页|APP|下载|打开APP|点击查看|查看更多|全部|相关推荐|猜你喜欢|评论区|热门评论|全部评论)',
    '(赞|评论|收藏|转发|分享|阅读|浏览)[0-9.万亿kK＋+]*$',
    '^(第\\d+页|共\\d+条|\\d+条评论|\\d+人喜欢|\\d+条转发)$',
  ].join('|')
);

/** 时间戳样式 */
const TIME_PATTERNS = [
  /\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}/,
  /\d{4}年\d{1,2}月\d{1,2}日/,
  /\d{1,2}月\d{1,2}日/,
  /(\d+\s*(秒|分钟|小时|天|周|个月|年)前)/,
  /(昨天|前天|今天|刚刚|刚刚发布)/,
];

// ---------- 对外接口 ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'probe:get-post-context') {
    try {
      sendResponse(extractPostContext());
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return false;
  }
  return false;
});

/**
 * 抽取当前页面的帖文上下文
 * @returns {object} {ok, text, platform, author, title, publishedAt, url, images, selection, strategy, note}
 */
function extractPostContext() {
  const url = location.href;
  const host = location.hostname;
  const platform = detectPlatform(host);

  // ---- 策略 1：用户框选的文字（最精准）----
  const selection = readSelection();
  if (selection && selection.length >= 8) {
    return {
      ok: true,
      strategy: 'selection',
      text: selection,
      selection,
      postCount: 1,
      platform,
      author: pickBy(platform?.author) || '',
      title: pickBy(platform?.title) || document.title || '',
      publishedAt: findPublishedAt(),
      url,
      images: collectImages(null),
      note: '使用你框选的文字作为核查对象',
    };
  }

  // ---- 策略 2：平台选择器 ----
  if (platform) {
    const el = pickBy(platform.body);
    if (el) {
      const text = cleanText(el.innerText || el.textContent || '');
      if (text.length >= 8) {
        return {
          ok: true,
          strategy: 'platform-selector',
          text,
          selection: '',
          postCount: countBy(platform.body),
          platform,
          author: pickBy(platform.author) || '',
          title: pickBy(platform.title) || document.title || '',
          publishedAt: findPublishedAt(),
          url,
          images: collectImages(el),
          note: `按${platform.name}正文容器抽取`,
        };
      }
    }
  }

  // ---- 策略 3：通用兜底（文字密度打分）----
  const fallback = findBodyByDensity();
  if (fallback && fallback.text.length >= 8) {
    return {
      ok: true,
      strategy: 'generic-density',
      text: fallback.text,
      selection: '',
      postCount: 1,
      platform,
      author: pickBy(platform?.author) || '',
      title: pickBy(platform?.title) || document.title || '',
      publishedAt: findPublishedAt(),
      url,
      images: collectImages(fallback.el),
      note: '未命中平台规则，按文字密度推定正文区域',
    };
  }

  return {
    ok: false,
    error: '未能从当前页面提取到可核查的文本内容。可尝试框选要核查的那段文字后重试。',
    strategy: 'none',
    url,
    platform,
  };
}

// ---------- 平台识别 ----------

function detectPlatform(host) {
  for (const p of PLATFORMS) {
    if (p.host.test(host)) return { id: p.id, name: p.name };
  }
  return { id: 'generic', name: host.replace(/^www\./, '') };
}

/** 按选择器列表取第一个非空元素的文本 */
function pickBy(selectors) {
  if (!selectors) return '';
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const t = (el.innerText || el.textContent || '').trim();
        if (t) return t.slice(0, 200);
      }
    } catch {
      /* 选择器非法则跳过 */
    }
  }
  return '';
}

/**
 * 统计页面上命中正文容器的元素数量。
 *
 * 【为什么需要】
 *   信息流页面（X 首页、微博推荐流、小红书发现页）里有几十条同构的内容，
 *   抽取器只能取到第一条。用户想核查的很可能是另一条 —— 这种情况必须告诉他，
 *   而不是默默核查了一条不相干的内容还给出结论。
 */
function countBy(selectors) {
  if (!selectors) return 0;
  for (const sel of selectors) {
    try {
      const n = document.querySelectorAll(sel).length;
      if (n > 0) return n;
    } catch {
      /* 选择器非法则跳过 */
    }
  }
  return 0;
}

// ---------- 通用兜底：文字密度打分 ----------

/**
 * 给候选容器打分并取最高分：
 *   分数 = 文本长度 - 链接文字长度×2 - 界面元素惩罚
 * 目的是避开导航栏与评论区这类「链接多、文字少」的区域。
 */
function findBodyByDensity() {
  const candidates = [];
  const seen = new Set();

  const push = (el) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    candidates.push(el);
  };

  for (const sel of GENERIC_BODY_SELECTORS) {
    try {
      document.querySelectorAll(sel).forEach(push);
    } catch {
      /* ignore */
    }
  }

  // 兜底：所有 div / section，取文本较长的那些
  try {
    const all = document.querySelectorAll('div, section, td');
    const arr = Array.from(all);
    // 先按长度粗排，避免遍历过多节点
    arr.sort((a, b) => textLen(b) - textLen(a));
    for (const el of arr.slice(0, 400)) {
      if (textLen(el) >= 40) push(el);
    }
  } catch {
    /* ignore */
  }

  let best = null;
  let bestScore = 0;

  for (const el of candidates) {
    const raw = el.innerText || el.textContent || '';
    const len = raw.length;
    if (len < 20) continue;
    if (len > 20000) continue;

    // 链接文字占比过高 → 多半是列表/推荐位而非正文
    const linkLen = sumLinkText(el);
    const linkRatio = linkLen / Math.max(1, len);

    // 界面元素惩罚
    const uiCount = el.querySelectorAll('button, input, select, nav, [role="button"]').length;

    // 类名/标签像导航、推荐、评论
    const chromePenalty = chromeScore(el);

    const score = len * (1 - Math.min(0.9, linkRatio * 1.5)) - uiCount * 120 - chromePenalty;

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (!best) return null;
  const text = cleanText(best.innerText || best.textContent || '');
  if (text.length < 8) return null;
  return { el: best, text, score: bestScore };
}

function textLen(el) {
  return ((el && (el.innerText || el.textContent)) || '').length;
}

function sumLinkText(el) {
  let n = 0;
  try {
    for (const a of el.querySelectorAll('a')) {
      n += ((a.innerText || a.textContent) || '').length;
    }
  } catch {
    /* ignore */
  }
  return n;
}

/** 命中「导航/推荐/评论」特征的容器给一个与文本量相关的惩罚 */
function chromeScore(el) {
  const tag = (el.tagName || '').toLowerCase();
  let penalty = 0;
  if (['nav', 'header', 'footer', 'aside'].includes(tag)) return 100000;

  const cls = `${el.className || ''} ${el.id || ''}`;
  if (CHROME_PATTERN.test(cls)) {
    penalty += Math.min(6000, textLen(el) * 0.5);
  }
  return penalty;
}

// ---------- 文本清洗 ----------

/**
 * 清洗抽出来的正文：
 *   逐行丢弃纯界面噪声行，去掉连续空行与首尾空白，限制最大长度。
 */
function cleanText(raw) {
  const lines = String(raw || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim());

  const kept = [];
  for (const line of lines) {
    if (!line) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (BOILERPLATE_LINE.test(line)) continue;
    // 纯数字/纯符号的行通常是计数器，直接丢
    if (/^[\d\s.·,，%]+$/.test(line)) continue;
    kept.push(line);
  }

  let text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // 过长时截断，但保留「前 6000 字 + 结尾提示」，避免把论点埋在截断之外
  const MAX = 6000;
  if (text.length > MAX) {
    text = text.slice(0, MAX) + '\n…（正文过长已截断）';
  }
  return text;
}

// ---------- 选中文字 ----------

function readSelection() {
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const t = String(sel.toString() || '').trim();
    if (!t) return '';
    return t.length > 6000 ? t.slice(0, 6000) + '…（已截断）' : t;
  } catch {
    return '';
  }
}

// ---------- 时间与配图 ----------

/** 在页面可见文本里找发布时间线索 */
function findPublishedAt() {
  const text = (document.body && document.body.innerText) || '';
  for (const re of TIME_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return '';
}

/**
 * 收集帖文配图（大图、排除头像与图标）
 * 文本核查与图像溯源可以共用同一批图，形成「文图双证据」。
 */
function collectImages(scopeEl) {
  const out = [];
  const seen = new Set();
  let nodes = [];
  try {
    nodes = Array.from((scopeEl || document).querySelectorAll('img'));
  } catch {
    nodes = [];
  }
  if (nodes.length > 400) nodes = nodes.slice(0, 400);

  for (const img of nodes) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w && w < 200) continue; // 头像、表情、图标
    const url =
      img.currentSrc ||
      img.getAttribute('data-origin') ||
      img.getAttribute('data-original') ||
      img.src ||
      '';
    if (!url || !/^https?:/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, width: w, height: h });
    if (out.length >= 10) break;
  }
  return out;
}
