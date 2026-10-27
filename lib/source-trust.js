// lib/source-trust.js —— 来源独立性判定与置信度计算（纯函数，浏览器与 Node 双端可用）
//
// 【为什么需要它】
//   社媒核查最容易翻车的地方不是「查不到」，而是「查到了很多，但其实是同一个来源」。
//   典型场景：10 家网站转发了同一篇通稿 —— 看着是 10 个来源，实际只有 1 个独立佐证。
//   如果按 URL 条数算佐证强度，就会把 1 条证据误当成 10 条，得出「证据充分」的错误结论。
//
//   本模块解决三件事：
//     1. publisherKey    —— 把 URL 归到「主办方」（注册域）粒度
//     2. detectSyndication —— 跨域识别同一篇原文的转载，形成「来源组」
//     3. computeConfidence —— 置信度按【独立来源组】的一致率算，而不是让模型自报
//
// 【设计原则】
//   * 判定规则用代码写死，不依赖模型自觉（模型自报置信度被实测证明不可靠）。
//   * 宁可低估置信度，不可高估：阈值偏严，宁可标「无法证实」也不标「属实」。
//   * 全部为纯函数，便于 node --test 单测，也便于日后抽到服务端复用。

// ---------- 域名归组 ----------

/**
 * 两级公共后缀（简化的公共后缀表，覆盖常见中文与国际域名）
 * 目的：把 news.example.com.cn 归到 example.com.cn，而不是 com.cn。
 */
const MULTI_PART_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 're.kr', 'go.kr',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'com.sg', 'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.sa',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'com.br', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.tr', 'com.ua',
  'co.za', 'co.kr', 'co.il', 'co.id', 'co.th', 'com.ec', 'com.uy',
]);

/**
 * 取「注册域」：example.com.cn、example.co.uk、example.com
 * 输入可以是完整 URL 或裸域名。失败返回空串。
 */
export function registrableDomain(input) {
  if (!input) return '';
  let host = String(input).trim().toLowerCase();
  try {
    if (/^https?:\/\//i.test(host)) host = new URL(host).hostname;
  } catch {
    /* 当作裸域名继续处理 */
  }
  host = host.replace(/^\*\./, '').replace(/^www\./, '');
  // 去掉端口与路径残留
  host = host.split('/')[0].split(':')[0];
  if (!host || !host.includes('.')) return host;

  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/** 主办方键：判定「是否同一来源」的第一层依据 */
export function publisherKey(url) {
  return registrableDomain(url);
}

// ---------- 转载 / 通稿识别 ----------

/** 摘要归一化：去标点、去空白、统一小写 */
export function normalizeSnippet(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[，。！？、；：""''「」『』（）()《》〈〉【】\[\]…—\-·.,!?:;"'`~@#$%^&*+=|]/g, '');
}

/** 字符 k-shingle 集合（中文按字、英文按字符都能用） */
export function shingles(text, k = 8) {
  const t = normalizeSnippet(text);
  const out = new Set();
  if (t.length < k) {
    if (t) out.add(t);
    return out;
  }
  for (let i = 0; i + k <= t.length; i++) out.add(t.slice(i, i + k));
  return out;
}

/** Jaccard 相似度 */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** 判定为「同一篇原文」的阈值 */
const SYNDICATION_JACCARD = 0.55;
/**
 * 同时要求共享片段的绝对数量，避免「所有摘要都含检索词」造成的误判。
 * 8 字 shingle 共享 16 个 ≈ 至少有 20 个连续相同的字，足够把同源转载与巧合区分开。
 */
const SYNDICATION_MIN_SHARED = 16;
/**
 * 参与转载判定的摘要最小长度。
 * 注意：必须按【归一化后】的长度判断——归一化会去掉标点与空格，
 * 若用原文长度判断，标点密集的中文摘要会被误判为「太短」而漏掉转载。
 */
const SYNDICATION_MIN_NORM_LEN = 36;

/**
 * 把来源聚成「来源组」：同组 = 同一主办方或同一篇原文的转载。
 *
 * @param {Array<{url,title,snippet}>} sources
 * @returns {Array<{id,origin,members:Array,independent:boolean,reason:string}>}
 */
export function groupByOrigin(sources) {
  const list = (sources || []).filter((s) => s && s.url);
  if (!list.length) return [];

  // 先按主办方建初始组
  const parent = list.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const keys = list.map((s) => publisherKey(s.url));

  // 同主办方直接合并
  const byKey = new Map();
  list.forEach((s, i) => {
    const k = keys[i];
    if (!k) return;
    if (byKey.has(k)) union(byKey.get(k), i);
    else byKey.set(k, i);
  });

  // 跨主办方：文本高度重合 → 判为同一篇原文的转载
  const shingleCache = list.map((s) => {
    const norm = normalizeSnippet(s.snippet);
    if (norm.length < SYNDICATION_MIN_NORM_LEN) return null;
    return shingles(s.snippet, 8);
  });

  for (let i = 0; i < list.length; i++) {
    if (!shingleCache[i]) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (!shingleCache[j]) continue;
      if (keys[i] && keys[j] && keys[i] === keys[j]) continue; // 同主办方已合并
      const shared = countShared(shingleCache[i], shingleCache[j]);
      if (shared < SYNDICATION_MIN_SHARED) continue;
      if (jaccard(shingleCache[i], shingleCache[j]) >= SYNDICATION_JACCARD) {
        union(i, j);
      }
    }
  }

  // 汇总成组
  const buckets = new Map();
  list.forEach((s, i) => {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push({ source: s, publisher: keys[i] });
  });

  const groups = [];
  let idx = 0;
  for (const [, members] of buckets) {
    const urls = members.map((m) => m.source.url);
    const hosts = [...new Set(members.map((m) => m.publisher).filter(Boolean))];
    // 同组内跨了多个主办方 → 说明是转载/通稿
    const syndicated = hosts.length > 1;
    groups.push({
      id: `g${idx++}`,
      origin: hosts[0] || 'unknown',
      hosts,
      members: members.map((m) => m.source),
      memberUrls: urls,
      independent: !syndicated,
      reason: syndicated
        ? `疑似同一篇原文的转载（涉及 ${hosts.length} 个站点：${hosts.slice(0, 3).join('、')}）`
        : '同一主办方',
    });
  }
  return groups;
}

function countShared(a, b) {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) n += 1;
  return n;
}

// ---------- 判定与置信度 ----------

/** 文本核查的判定枚举（比图像链路多一档：no-evidence） */
export const TEXT_VERDICTS = {
  TRUE: 'true',
  FALSE: 'false',
  PARTIAL: 'partial',
  MISLEADING: 'misleading',
  NO_EVIDENCE: 'no-evidence',
  UNVERIFIABLE: 'unverifiable',
};

export const TEXT_VERDICT_LABEL = {
  true: '属实',
  false: '不实',
  partial: '部分属实',
  misleading: '误导',
  'no-evidence': '未检索到相关来源',
  unverifiable: '证据不足以判定',
};

const VALID_TEXT_VERDICTS = new Set(Object.values(TEXT_VERDICTS));

/**
 * 最终判定校正：把模型输出约束到「证据允许的范围内」。
 *
 * 两条硬规则（防止最常见的两种幻觉）：
 *   规则一：一个来源都没检索到 → 强制 no-evidence。
 *            不允许出现「未检索到任何东西，所以判定为不实」——那是把「不知道」写成「否定」。
 *   规则二：模型判了真/假，却没给出任何可核验的引用 → 降级为 unverifiable。
 *            一个没有出处的判定不成立，无论模型写得多自信。
 *
 * @param {object} p
 *   verdict     模型给出的判定
 *   evidence    模型给出的证据数组 [{url, quote, stance}]
 *   sourceCount 本次检索到的来源总数
 *   groups      来源组（groupByOrigin 的结果）
 */
export function finalizeVerdict({ verdict, evidence, sourceCount, groups }) {
  const ev = (evidence || []).filter((e) => e && e.url);
  const total = Number(sourceCount) || 0;

  // 规则一：零来源
  if (!total) {
    return {
      verdict: TEXT_VERDICTS.NO_EVIDENCE,
      confidence: 'none',
      forced: 'no-sources',
    };
  }

  let v = VALID_TEXT_VERDICTS.has(verdict) ? verdict : TEXT_VERDICTS.UNVERIFIABLE;

  // 规则二：有来源但没引用
  if (v !== TEXT_VERDICTS.UNVERIFIABLE && v !== TEXT_VERDICTS.NO_EVIDENCE && ev.length === 0) {
    v = TEXT_VERDICTS.UNVERIFIABLE;
    return {
      verdict: v,
      confidence: 'low',
      forced: 'no-cited-evidence',
    };
  }

  // 模型说「无法证实」，但实际零来源 —— 统一收敛到 no-evidence（更准确的描述）
  if (v === TEXT_VERDICTS.UNVERIFIABLE && total === 0) {
    v = TEXT_VERDICTS.NO_EVIDENCE;
  }

  return { verdict: v, confidence: computeConfidence({ verdict: v, evidence: ev, groups }), forced: '' };
}

/**
 * 置信度 = 独立来源组的一致率，而不是模型自报。
 *
 *   独立佐证组：按来源组去重后，stance=supports 的组数
 *   独立反证组：按来源组去重后，stance=refutes 的组数
 *
 * 判定规则：
 *   0 支持 0 反证            → low
 *   仅 1 组佐证               → medium
 *   ≥2 组佐证且无反证         → high
 *   ≥2 组反证且无佐证         → high
 *   同时存在佐证与反证        → medium（存在争议，不给 high）
 *   全程只有 1 个来源组       → 封顶 medium（单一来源不足以给高置信）
 */
export function computeConfidence({ verdict, evidence, groups }) {
  if (verdict === TEXT_VERDICTS.NO_EVIDENCE) return 'none';
  if (verdict === TEXT_VERDICTS.UNVERIFIABLE) return 'low';

  const ev = (evidence || []).filter((e) => e && e.url);
  if (!ev.length) return 'low';

  const groupList = Array.isArray(groups) ? groups : [];

  // 建立 url → groupId 映射
  const urlToGroup = new Map();
  for (const g of groupList) {
    for (const u of g.memberUrls || []) urlToGroup.set(u, g.id);
  }

  const supportGroups = new Set();
  const refuteGroups = new Set();
  const allGroups = new Set();

  for (const e of ev) {
    const gid = urlToGroup.get(e.url);
    if (gid) {
      allGroups.add(gid);
      const stance = String(e.stance || 'neutral').toLowerCase();
      if (stance === 'supports') supportGroups.add(gid);
      else if (stance === 'refutes') refuteGroups.add(gid);
    }
  }

  // 找不到归属的引用也要计入「见过这个来源」
  for (const e of ev) {
    if (!urlToGroup.has(e.url)) allGroups.add(`url:${e.url}`);
  }

  const s = supportGroups.size;
  const r = refuteGroups.size;

  let level;
  if (s === 0 && r === 0) {
    level = 'low';
  } else if (s > 0 && r > 0) {
    // 有独立反证：存在争议，最高只给 medium
    level = 'medium';
  } else {
    const supporting = Math.max(s, r);
    if (supporting >= 2) level = 'high';
    else if (supporting === 1) level = 'medium';
    else level = 'low';
  }

  // 单一来源组封顶：只有一个来源组时不给 high
  if (level === 'high' && allGroups.size < 2) return 'medium';

  return level;
}

/**
 * 汇总所有断言的独立佐证情况，用于在核查过程里如实说明「几个独立来源」。
 * @returns {{groupCount:number, groupList:Array, syndicated:Array}}
 */
export function summarizeIndependence(groups) {
  const list = Array.isArray(groups) ? groups : [];
  const syndicated = list.filter((g) => !g.independent);
  return {
    groupCount: list.length,
    groupList: list.map((g) => ({
      id: g.id,
      origin: g.origin,
      hosts: g.hosts,
      count: (g.memberUrls || []).length,
      independent: g.independent,
      reason: g.reason,
    })),
    syndicated,
  };
}
