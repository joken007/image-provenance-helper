// lib/engine-adapters.js —— 反搜引擎自动化适配器（配置驱动）
//
// 每个引擎一份「怎么自动搜 + 怎么自动读结果」的配方。执行器见 background/auto-verify.js。
//
// 【设计原则】
// 1. 全程后台无感：标签页 active:false 创建，跑完立即 tabs.remove()，用户看不到任何窗口。
// 2. 上传不依赖公网直链：用 DataTransfer 把图片字节塞进 input[type=file]，
//    彻底绕开微信/微博/小红书的防盗链（这是原方案必须人工 Ctrl+V 的根因）。
// 3. 解析用【统一的通用函数 + 每引擎配置】，而不是每引擎写一段代码字符串。
//    原因：chrome.scripting.executeScript 的 func 靠 toString() 序列化，
//    new Function 生成的函数 toString() 不含实现，注入后必失败。
// 4. 失败即降级：任何一步超时/被拦，标记该引擎 failed，绝不阻塞其它引擎。

/**
 * 引擎清单
 * upload: 'file-input' 用 DataTransfer 塞文件
 * parse:  通用解析器的行为配置（见 background/auto-verify.js 的 parsePage）
 */
export const AUTO_ENGINES = [
  {
    id: 'saucenao',
    name: 'SauceNAO',
    homeUrl: 'https://saucenao.com/',
    upload: 'file-input',
    fileSelector: '#fileInput',
    submitStrategy: 'requestSubmit',
    // SauceNAO 的上传框挂 onchange="checkImageFile(this)"，要异步读文件头校验；
    // 表单守卫 onsubmit="return(isSearchReady())" 在校验完成前返回 false。
    // 因此必须等就绪再提交，否则提交会被静默拦下（页面停在首页）。
    submitReadyTimeoutMs: 15000,
    readyCheck: { urlIncludes: 'search.php', selector: '.result' },
    timeoutMs: 35000,
    parse: {
      itemSelector: '.result',
      similaritySelector: '.similarity',
      titleSelector: '.title',
      excludeHosts: 'saucenao|tineye|google|yandex|bing|baidu|microsoft',
    },
  },

  {
    id: 'tineye',
    name: 'TinEye',
    homeUrl: 'https://tineye.com/',
    upload: 'file-input',
    fileSelector: 'input[type=file]',
    submitStrategy: 'auto',
    readyCheck: { urlIncludes: '/search/', selector: '.match, [class*=match]' },
    timeoutMs: 40000,
    parse: {
      itemSelector: '.match, [class*=match-item], [class*=result-row]',
      similaritySelector: '[class*=score]',
      titleSelector: null,
      excludeHosts: 'tineye|cloudflare',
      totalSelector: '[class*=total]',
    },
  },

  {
    id: 'bing',
    name: 'Bing 视觉搜索',
    homeUrl: 'https://www.bing.com/images',
    upload: 'file-input',
    fileSelector: 'input[type=file]',
    submitStrategy: 'auto',
    readyCheck: { urlIncludes: 'iss=sbi', selector: '.imgpt, .mimg, [class*=sbi]' },
    timeoutMs: 40000,
    parse: {
      itemSelector: '.imgpt, .mimg, .iusc',
      titleSelector: null,
      excludeHosts: 'bing|microsoft|msn|live|mm\\.bing\\.net',
    },
  },

  {
    id: 'baidu',
    name: '百度识图',
    homeUrl: 'https://image.baidu.com/',
    upload: 'file-input',
    fileSelector: 'input[type=file]',
    submitStrategy: 'auto',
    readyCheck: { urlIncludes: 'graph.baidu.com', selector: '.general, [class*=result], .card-area' },
    timeoutMs: 40000,
    parse: {
      itemSelector: '.general, .card-area, [class*=result-item]',
      titleSelector: null,
      excludeHosts: 'baidu|bdstatic|bdimg|bdurl',
    },
  },

  {
    id: 'yandex',
    name: 'Yandex',
    homeUrl: 'https://yandex.com/images/',
    upload: 'file-input',
    fileSelector: 'input[type=file]',
    submitStrategy: 'auto',
    readyCheck: { urlIncludes: 'rpt=imageview', selector: '.serp-item, [class*=CbirSites], [class*=similar]' },
    timeoutMs: 45000,
    parse: {
      itemSelector: '.serp-item, [class*=CbirSites-Item]',
      titleSelector: null,
      excludeHosts: 'yandex|yastatic|yimg',
    },
  },

  {
    id: 'google-lens',
    name: 'Google Lens',
    homeUrl: 'https://lens.google.com/',
    upload: 'file-input',
    fileSelector: 'input[type=file]',
    submitStrategy: 'auto',
    readyCheck: { urlIncludes: 'lens.google.com/search', selector: '[data-item-index], [role=list], a[href^="http"]' },
    timeoutMs: 45000,
    parse: {
      itemSelector: null, // 无固定容器时退化为全页扫链接
      titleSelector: null,
      excludeHosts: 'google|gstatic|googleusercontent|googleapis',
    },
  },
  {
    id: 'iqdb',
    name: 'IQDB 二次元图库',
    homeUrl: 'https://iqdb.org/',
    upload: 'file-input',
    // IQDB 首页有 file 输入框 + service[] 复选框（1=Danbooru 2=Konachan 3=yande.re
    // 4=Gelbooru 5=Sankaku 6=e-shuushuu 11=Zerochan 13=anime-pictures），默认全选
    fileSelector: 'input[name=file]',
    submitStrategy: 'requestSubmit',
    // 结果页与首页同域，路径不变只有查询串不同 —— 用 urlHasQuery 区分
    readyCheck: { urlIncludes: 'iqdb.org', urlHasQuery: true, minLinks: 2 },
    timeoutMs: 45000,
    parse: {
      // 结果布局会变，不硬编码容器；由通用解析器退化为「按域名去重扫全页链接」
      itemSelector: null,
      titleSelector: null,
      excludeHosts: 'iqdb\\.org',
    },
  },

  {
    id: 'ascii2d',
    name: 'ASCII2D 二次元',
    homeUrl: 'https://ascii2d.net/',
    upload: 'file-input',
    // ASCII2D 有 id=file_upload 的 multipart 文件上传表单（POST /search/file）
    fileSelector: '#file_upload input[type=file]',
    submitStrategy: 'requestSubmit',
    // 结果页路径含 /search/，首页不含
    readyCheck: { urlIncludes: 'ascii2d.net/search', minLinks: 2 },
    timeoutMs: 45000,
    parse: {
      itemSelector: null,
      titleSelector: null,
      excludeHosts: 'ascii2d\\.net',
    },
  },
];

export const AUTO_ENGINE_BY_ID = Object.fromEntries(AUTO_ENGINES.map((e) => [e.id, e]));

/**
 * 默认启用顺序：按实测可靠性排序（能跑通的在前）
 * 二次元引擎（iqdb / ascii2d）紧跟 sauceNAO，因为三者覆盖的是同一批图。
 */
export const DEFAULT_AUTO_ENGINES = [
  'saucenao',
  'iqdb',
  'ascii2d',
  'tineye',
  'bing',
  'baidu',
  'yandex',
  'google-lens',
];
