// background/fact-check-api.js —— Google Fact Check Tools API 接入
//
// 【它提供什么】
//   这个 API 返回的是「已经被第三方专业机构核查过的断言」，不是它自己去核查。
//   换句话说：它回答的是「这条消息，之前有没有人辟过谣」，而不是「这条消息是真是假」。
//
// 【为什么仍然值得接】
//   * 命中即等于拿到一个专业机构的现成结论 + 可引用的原始辟谣链接，质量远高于普通搜索结果；
//   * 免费、官方维护、覆盖 PolitiFact / AAP FactCheck / Full Fact 等大量核查机构；
//   * 与本插件已接入的 Wayback 属同类信号源：查「这件事在时间线上的位置」。
//
// 【为什么只能当辅助线索，不能当唯一依据】
//   * Google 已于 2025-06 逐步下线搜索结果里的 fact-check 富媒体摘要，官方口径是「不再重要」；
//     Explorer 工具与 API 目前仍可用，但这种收缩信号意味着不能把工作流绑定在它上面。
//   * 它的语料依赖第三方核查生态，生态在变薄；没被核查过的断言一律查不到。
//   * 所以：命中 → 作为高可信来源并入证据；未命中 → 绝不作为「查无此事」的证据。
//
// 【失败策略】
//   没配 key / 请求失败 / 返回异常 → 一律静默降级，绝不阻塞核查主流程。

import { loadOptions } from './store.js';

const API_BASE = 'https://toolbox.googleapis.com/v1/factchecktools/search';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 查询 Google Fact Check 数据库
 *
 * @param {string} query 检索文本（一般用断言原文）
 * @param {object} opts {apiKey, timeoutMs}
 * @returns {Promise<{available:boolean, hits:Array, note:string, error?:string}>}
 *   hits: [{claimText, verdict, verdictLabel, rating, reviewUrl, title, publisher, reviewDate}]
 */
export async function queryFactCheckApi(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return { available: false, hits: [], note: '检索词为空，已跳过专业核查库' };
  }

  const apiKey = opts.apiKey || '';
  if (!apiKey) {
    return { available: false, hits: [], note: '未配置 Google Fact Check API Key，已跳过专业核查库' };
  }

  const url = `${API_BASE}?query=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);

  let payload;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        available: false,
        hits: [],
        note: `专业核查库返回 HTTP ${resp.status}`,
        error: text.slice(0, 200),
      };
    }
    payload = await resp.json();
  } catch (e) {
    return {
      available: false,
      hits: [],
      note: `专业核查库请求失败：${String((e && e.message) || e)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const claims = Array.isArray(payload?.claims) ? payload.claims : [];
  const hits = [];

  for (const claim of claims) {
    const reviews = Array.isArray(claim?.claimReview) ? claim.claimReview : [];
    for (const rv of reviews) {
      const rating = rv?.reviewRating || {};
      const mapped = mapRating(rating);
      hits.push({
        claimText: String(claim.claimText || '').slice(0, 300),
        verdict: mapped.verdict,
        verdictLabel: mapped.label,
        rating: typeof rating.rating === 'number' ? rating.rating : null,
        ratingText: String(rating.textValue || ''),
        reviewUrl: String(rv.url || ''),
        title: String(rv.title || '').slice(0, 200),
        publisher: String(rv?.publisher?.name || '').slice(0, 80),
        reviewDate: String(rv.reviewDate || '').slice(0, 10),
      });
    }
  }

  return {
    available: true,
    hits,
    note: hits.length
      ? `专业核查库命中 ${hits.length} 条既有核查记录`
      : '专业核查库无既有核查记录（不代表该断言为真）',
  };
}

/**
 * 把 Google 的 reviewRating 映射到本项目的判定枚举。
 * rating 取值约定：1 = 真，-1 = 假，0 = 混合/部分；textValue 提供更细的措辞。
 */
function mapRating(rating) {
  const text = String(rating.textValue || '').toLowerCase();
  const v = typeof rating.rating === 'number' ? rating.rating : null;

  if (/misleading|误导/i.test(text)) return { verdict: 'misleading', label: '误导' };
  if (/mostly false|大部分不实|基本不实/i.test(text)) return { verdict: 'false', label: '基本不实' };
  if (/half false|部分不实|有争议|mixed/i.test(text)) return { verdict: 'partial', label: '部分不实' };
  if (/mostly true|大部分属实|基本属实/i.test(text)) return { verdict: 'true', label: '基本属实' };
  if (/false|不实|错误/i.test(text)) return { verdict: 'false', label: '不实' };
  if (/true|属实|正确/i.test(text)) return { verdict: 'true', label: '属实' };

  if (v === 1) return { verdict: 'true', label: '属实' };
  if (v === -1) return { verdict: 'false', label: '不实' };
  if (v === 0) return { verdict: 'partial', label: '部分属实' };

  return { verdict: 'unverifiable', label: '未标明评级' };
}

/**
 * 把命中记录转成「可引用来源」，并入本次证据池。
 * 这类来源的可信度高于普通搜索结果，因此单独标记 trustTier。
 */
export function factCheckHitsToSources(hits) {
  return (hits || [])
    .filter((h) => h && h.reviewUrl)
    .map((h) => ({
      title: h.title || `${h.publisher || '专业核查机构'}：${h.verdictLabel || '核查结论'}`,
      url: h.reviewUrl,
      snippet: `${h.publisher || '专业核查机构'} 于 ${h.reviewDate || '（日期不详）'} 给出评级「${
        h.verdictLabel || h.ratingText || '未标明'
      }」。核查对象：${h.claimText || ''}`,
      engine: 'google-factcheck',
      engineName: 'Google 专业核查库',
      trustTier: 'factcheck-org',
      presetVerdict: h.verdict,
      presetVerdictLabel: h.verdictLabel,
    }));
}

/**
 * 便捷入口：直接从扩展配置读取 key
 */
export async function queryFactCheckApiWithOptions(query, extraOpts = {}) {
  let apiKey = extraOpts.apiKey;
  if (!apiKey) {
    try {
      const options = await loadOptions();
      apiKey = options.factCheckApiKey || '';
    } catch {
      apiKey = '';
    }
  }
  return queryFactCheckApi(query, { ...extraOpts, apiKey });
}
