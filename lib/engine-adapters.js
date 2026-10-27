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
    // SauceNAO 支持 URL 直搜（search.php?url=），比上传更稳更快
    buildDirectUrl: (u) => `https://saucenao.com/search.php?url=${encodeURIComponent(u)}`,
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
    // TinEye 首页有 Cloudflare JS 挑战（标题短暂显示「请稍候…」），
    // 真浏览器能过，但上传框要等挑战完成才出现 —— 先等框再注入。
    waitForSelector: 'input[type=file]',
    waitForSelectorTimeoutMs: 25000,
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
    // 实测：Bing 的上传框 id=sb_fileinput、display:none（隐藏），
    // 但确实在 form 内、accept 含 image —— DataTransfer 注入有效。
    fileSelector: '#sb_fileinput',
    submitStrategy: 'click',
    // 【实测】Bing 的真实上传入口是 <span id="sb_brtext">上传图像</span>，
    // 而它不可见；form 里的提交按钮文案是「搜索」，点了会变成普通网页搜索
    // （bing.com/?scope=web），不是以图搜图。
    // 因此必须用精确选择器点「上传图像」，不能靠文案模糊匹配。
    submitSelector: '#sb_brtext',
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
    // 【重要】image.baidu.com 已改版为 AI 生图站，不再提供识图上传入口
    // （实测页面上根本没有 input[type=file]）。真正的识图入口是 graph.baidu.com/pcpage。
    homeUrl: 'https://graph.baidu.com/pcpage/index?tpl_from=pc',
    upload: 'file-input',
    fileSelector: 'input[type=file]',
    submitStrategy: 'auto',
    // 【实测】百度识图的正确协议是 graph.baidu.com/s?image_url=<图片URL>。
    // 走上传路径会变成 /pcpage/index?file=query.png —— 服务端不认识这个假文件名，
    // 于是退回首页。必须用真实公网直链。
    buildDirectUrl: (u) => `https://graph.baidu.com/s?image_url=${encodeURIComponent(u)}`,
    // 百度识图首选 URL 直搜：走上传路径只会得到假文件名，服务端检索不到
    preferDirect: true,
    // 【实测】百度识图不跳页，而是在同一 URL 上加 ?file= 参数显示结果。
    // 因此 urlIncludes 用 'file=' 作为「已进入结果页」的标志。
    // 【实测】百度识图（URL 直搜）结果页：
    //   URL = graph.baidu.com/s?image_url=<编码后的图片URL>
    //   容器 = .graph-g-results（1 个）+ .graph-result-card（2 个）
    //   无匹配时正文只有 51 字并显示「未找到相关结果」——那是有效的否定结论，
    //   不是失败。因此正文门槛要放宽（见 waitForResult 的 textOk 逻辑）。
    readyCheck: { urlIncludes: 'image_url=', selector: '.graph-g-results, .graph-result-card' },
    timeoutMs: 40000,
    parse: {
      itemSelector: '.graph-result-card, .graph-g-results > *',
      titleSelector: null,
      excludeHosts: 'baidu|bdstatic|bdimg|bdurl',
    },
  },

  {
    id: 'yandex',
    name: 'Yandex',
    homeUrl: 'https://yandex.com/images/',
    upload: 'file-input',
    // 实测：Yandex 的上传框 accept=image/*、无 id、**不在任何 form 内**。
    // 塞文件后它会自己发起请求，无需点按钮。
    fileSelector: 'input[type=file][accept*="image"]',
    submitStrategy: 'auto',
    submitAfterSeed: 'none',
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
    // 实测：lens.google.com 会跳到 www.google.com/?olud=...，
    // 上传框是 input[name=encoded_image]（不在 form 内），
    // 因此不能用 input[type=file] 泛匹配 —— 会选中 accept=*/* 的那个。
    fileSelector: 'input[name=encoded_image]',
    submitStrategy: 'auto',
    submitAfterSeed: 'none',
    // 结果页可能落在 lens.google.com/search 或 www.google.com/search
    readyCheck: { urlIncludes: '/search', selector: '[data-item-index], [role=list], a[href^="http"]' },
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
