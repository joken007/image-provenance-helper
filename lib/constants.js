// lib/constants.js —— 全局常量：引擎配置、CDN 原图还原规则、反爬关键词、URL 归一化规则

/**
 * 反向搜图引擎配置
 * mode: 'url-direct'  = 可用公网直链 URL 直接 GET 反搜
 *       'clipboard'   = 防盗链 / blob: / 截图场景，走「写剪贴板 + 打开首页 Ctrl+V」回退
 */
export const ENGINES = [
  {
    id: 'google-lens',
    name: 'Google Lens',
    mode: 'url-direct',
    buildUrl: (u) => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(u)}&hl=zh-CN`,
    openUrl: 'https://lens.google.com/',
    focus: '全球索引量最大，擅长找境外新闻源、裁剪图与图中地标建筑；点「查找图片来源」看早期网页',
  },
  {
    id: 'tineye',
    name: 'TinEye',
    mode: 'url-direct',
    buildUrl: (u) => `https://tineye.com/search?url=${encodeURIComponent(u)}`,
    openUrl: 'https://tineye.com/',
    focus: '像素级与修改副本匹配最强；结果页切 Oldest 排序找首发源头',
  },
  {
    id: 'yandex',
    name: 'Yandex Images',
    mode: 'url-direct',
    buildUrl: (u) => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(u)}`,
    openUrl: 'https://yandex.com/images/',
    focus: '人脸识别、俄语/东欧圈与风景建筑检索强，适合查网图盗用与冒充身份',
  },
  {
    id: 'bing',
    name: 'Bing 视觉搜索',
    mode: 'url-direct',
    buildUrl: (u) =>
      `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIIDP&sbisrc=UrlPaste&q=imgurl:${encodeURIComponent(u)}`,
    openUrl: 'https://www.bing.com/images',
    focus: '补充检索中文与英文资讯站',
  },
  {
    id: 'baidu',
    name: '百度识图',
    mode: 'clipboard',
    buildUrl: null,
    openUrl: 'https://image.baidu.com/',
    focus: '国内自媒体、公众号、微博早期流传记录检索必查',
  },
  {
    id: 'saucenao',
    name: 'SauceNAO',
    mode: 'url-direct',
    buildUrl: (u) => `https://saucenao.com/search.php?url=${encodeURIComponent(u)}`,
    openUrl: 'https://saucenao.com/',
    focus: '针对插画、二次元作品盗图与社区老图溯源',
  },
];

export const ENGINE_BY_ID = Object.fromEntries(ENGINES.map((e) => [e.id, e]));

/** 强防盗链图床域名（子串匹配）——命中即默认走剪贴板回退模式 */
export const HOTLINK_PROTECTED_HOSTS = [
  'mmbiz.qpic.cn',      // 微信公众号
  'wx.qlogo.cn',
  'sinaimg.cn',         // 微博
  'xhscdn.com',         // 小红书
  'pic.rmb.bdstatic.com',
  'pstatp.com',         // 今日头条
  'sns-webpic-qc.xhscdn.com',
];

/** 常见图片 CDN 域名前缀（用于判断是否为图床而非普通网页资源） */
export const IMAGE_HOST_SUFFIXES = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic', '.heif', '.svg',
];

/**
 * 社交平台原图 URL 还原规则
 * 每条规则针对特定 CDN，把「缩略图路径/参数」改写为「原图路径/参数」。
 */
export const CDN_UPGRADE_RULES = [
  {
    id: 'sinaimg',
    match: (u) => /\.sinaimg\.cn$/i.test(u.hostname),
    apply: (u) => {
      u.pathname = u.pathname.replace(
        /\/(orj360|mw690|thumb150|bmiddle|small|square|mw200)\//i,
        '/mw2000/'
      );
      return u;
    },
    note: '微博图床：/orj360/ /mw690/ 等缩略图路径升级为 /mw2000/ 原图',
  },
  {
    id: 'twimg',
    match: (u) => /(^|\.)pbs\.twimg\.com$/i.test(u.hostname),
    apply: (u) => {
      if (u.searchParams.has('name')) u.searchParams.set('name', 'orig');
      return u;
    },
    note: 'X / Twitter：name=small|medium|900x900 改写为 name=orig',
  },
  {
    id: 'xhscdn',
    match: (u) => /\.xhscdn\.com$/i.test(u.hostname),
    apply: (u) => {
      if (u.search.includes('imageView2')) u.search = '';
      return u;
    },
    note: '小红书图床：剥离 ?imageView2 缩放裁切参数',
  },
  {
    id: 'wechat-qpic',
    match: (u) => /mmbiz\.qpic\.cn$/i.test(u.hostname),
    apply: (u) => u, // 保留完整签名参数，不可改写
    note: '微信公众号图床：强防盗链，保留完整签名参数',
  },
];

/** 反爬 / 验证码关键词（注入探测脚本后检查页面标题与可见文本） */
export const ANTI_BOT_KEYWORDS = [
  'captcha',
  '人机验证',
  '异常流量',
  'just a moment',
  'verify you are human',
  'are you a robot',
  'unusual traffic',
  'access denied',
  '安全验证',
  '滑动验证',
];

/** Wayback CDX 查询端点 */
export const WAYBACK_CDX = 'https://web.archive.org/cdx/search/cdx';

/** URL 去噪归一化：剥离营销与追踪参数 */
export const NOISE_QUERY_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'spm', 'from', 'isappinstalled', 'scene', 'srcid', 'sharer_shareid',
  'sharer_sharetime', 'weibo_id', 'wechat', 'timestamp', '_t', 'ref', 'referer',
];

/** 结论枚举 */
export const VERDICTS = {
  OLD_REUSE: 'likely-old-reuse',
  AI: 'likely-ai',
  MANIPULATED: 'manipulated',
  AUTHENTIC: 'no-anomaly',
  UNDETERMINED: 'undetermined',
};

export const VERDICT_LABEL = {
  'likely-old-reuse': '旧图挪用',
  'likely-ai': 'AI 生成',
  manipulated: '疑似后期篡改',
  'no-anomaly': '未见明显异常',
  undetermined: '无法判断',
};

/** 存储键名 */
export const STORAGE_KEYS = {
  SESSION_CURRENT: 'session:currentId',
  SESSION_INV: (id) => `session:inv:${id}`,
  LOCAL_INDEX: 'inv:index',
  LOCAL_INV: (id) => `inv:${id}`,
  OPTIONS: 'options',
};

/** LRU 上限 */
export const MAX_FULL_RECORDS = 200;
export const MAX_INDEX_RECORDS = 500;
export const MAX_BLOBS = 15;

/** C2PA 在线验证页 */
export const C2PA_VERIFY_PAGE = 'https://contentcredentials.org/verify';

/** 画布排版参数（与 sidepanel/card-renderer.js 保持一致） */
export const CARD = {
  W: 1080,
  SCALE: 2,
  PAD: 56,
  FONT: '"Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
};
