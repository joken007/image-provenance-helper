// background/text-factcheck.js —— 文本事实核查四段式编排
//
// 【四段管线】
//   ① 断言拆解（LLM）     帖文正文 → 2~6 条可独立核查的断言 + 检索关键词
//   ② 联网取证（真检索）  每个关键词 → 真实搜索 → 来源标题/摘要/URL
//      ＋ 专业核查库补充   Google Fact Check API → 已被专业机构核查过的记录
//   ③ 逐条判定（LLM+规则）模型基于证据写理由；【判定与置信度由程序规则裁定】
//   ④ 汇总成报告（LLM+规则） 生成核查过程与总体结论；【引用 URL 白名单硬校验】
//
// 【本项目与通用工具的关键区别，全部落在"程序规则"上】
//   1. 判定不能由模型自己说了算：
//      - 零来源 → 强制「未检索到相关来源」，绝不允许写成「不实」
//        （把「不知道」写成「否定」是辟谣工具最恶劣的幻觉）
//      - 判了真/假却给不出引用 → 降级为「证据不足以判定」
//   2. 置信度按【独立来源组】的一致率计算，不采信模型自报：
//      - 10 家网站转同一篇通稿 = 1 个独立佐证，不是 10 个
//   3. 引用 URL 必须在本次真实检索结果里，否则按幻觉剥离
//   4. 社媒正文与网页摘要一律围栏包裹，防 prompt injection
//
// 【可复核性】
//   返回的每条结论都带：用了哪些检索词、命中哪些来源、来源分几组、
//   哪几组被判定为转载、依据的原文片段是什么。读者可以逐条点开核对。

import { decomposeClaims, verifyClaim, summarizeTextCheck } from './llm.js';
import { gatherEvidence } from './web-search.js';
import { queryFactCheckApiWithOptions, factCheckHitsToSources } from './fact-check-api.js';
import { loadOptions } from './store.js';
import {
  TEXT_VERDICTS,
  groupByOrigin,
  finalizeVerdict,
  summarizeIndependence,
} from '../lib/source-trust.js';

/** 单次核查最多发出的检索词数（防止跑飞） */
const MAX_TOTAL_QUERIES = 10;
/** 专业核查库最多为每条断言补充多少条命中 */
const MAX_FACTCHECK_HITS = 3;

// ---------- 主入口 ----------

/**
 * 跑一次完整的文本事实核查
 *
 * @param {object} postContext 来自 content/text-probe.js 的帖文上下文
 * @param {(patch:object) => void} onProgress 阶段性进度回调（用于实时刷新侧栏）
 * @returns {Promise<object>} textCheck 结果对象
 */
export async function runTextFactCheck(postContext, onProgress = () => {}) {
  const options = await loadOptions();
  const startedAt = new Date().toISOString();

  const state = {
    status: 'running',
    stage: 'claims',
    startedAt,
    source: {
      platform: postContext?.platform?.name || postContext?.platform || '',
      platformId: postContext?.platform?.id || '',
      url: postContext?.url || '',
      title: postContext?.pageTitle || postContext?.title || '',
      author: postContext?.author || '',
      publishedAt: postContext?.publishedAt || '',
      text: postContext?.text || '',
      strategy: postContext?.strategy || '',
      note: postContext?.note || '',
      images: postContext?.images || [],
    },
    claims: [],
    unverifiableParts: [],
    queries: [],
    sources: [],
    groups: [],
    results: [],
    report: null,
    blockedSources: [],
    factCheck: { available: false, note: '', hits: [] },
    failures: [],
    updatedAt: startedAt,
  };

  const emit = async (patch) => {
    Object.assign(state, patch);
    state.updatedAt = new Date().toISOString();
    try {
      // 必须 await：不 await 的话，回写 storage 会变成竞态，
      // 进度可能乱序，甚至丢掉最后一次状态（侧栏就会停在某个中间步骤）。
      await onProgress({ ...state });
    } catch {
      /* 回调异常不影响核查 */
    }
  };

  try {
    // ---- ① 断言拆解 ----
    await emit({ stage: 'claims', note: '正在拆解可核查断言…' });

    // 正文太短就别去烧 LLM 了，直接给出明确原因
    const text = String(postContext?.text || '').trim();
    if (text.length < 10) {
      await emit({
        status: 'failed',
        stage: 'failed',
        note:
          '没能从页面提取到足够的文字（不足 10 字）。请在页面上框选要核查的那段话后重试，或换一个内容更多的页面。',
        finishedAt: new Date().toISOString(),
      });
      return state;
    }

    const decomposed = await decomposeClaims(postContext);
    const maxClaims = Math.max(1, Math.min(6, options.maxClaims || 6));
    const claims = (decomposed.claims || []).slice(0, maxClaims);
    state.claims = claims;
    state.unverifiableParts = decomposed.unverifiable || [];

    if (!claims.length) {
      await emit({
        status: 'done',
        stage: 'claims',
        note: '正文里没有可独立核查的断言，无需联网取证',
        finishedAt: new Date().toISOString(),
      });
      return state;
    }

    // ---- ② 组装检索计划 ----
    const plan = buildQueryPlan(claims, options);
    state.queries = plan.queries;
    await emit({ stage: 'search', note: `准备发起 ${plan.queries.length} 组检索…` });

    // ---- ② 联网取证 ----
    const maxPerQuery = Math.max(1, Math.min(20, options.maxSourcesPerQuery || 8));
    const gathered = await gatherEvidence(plan.queries, {
      engineIds: options.searchEngines,
      maxResults: maxPerQuery,
      onProgress: async (done, total, query) => {
        await emit({
          stage: 'search',
          note: `正在检索（${done}/${total}）：${query}`,
          searchProgress: { done, total, query },
        });
      },
    });

    const searchSources = (gathered.results || []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.snippet || '',
      engine: r.engine || '',
      engineName: r.engineName || '',
      query: r.query || '',
      trustTier: 'search',
    }));

    state.failures = gathered.failures || [];

    // ---- ② 补充：Google 专业核查库 ----
    const fcHits = [];
    if (options.factCheckApiKey) {
      for (const claim of claims) {
        try {
          const r = await queryFactCheckApiWithOptions(claim.text, { apiKey: options.factCheckApiKey });
          if (r.available && r.hits.length) {
            fcHits.push(...r.hits.map((h) => ({ ...h, claimId: claim.id })));
          }
        } catch {
          /* 单条失败不阻塞 */
        }
      }
    }
    const fcSources = factCheckHitsToSources(fcHits).map((s) => ({ ...s, claimId: fcHits[0]?.claimId || '' }));
    state.factCheck = {
      available: Boolean(options.factCheckApiKey),
      note: fcHits.length
        ? `专业核查库命中 ${fcHits.length} 条既有核查记录`
        : options.factCheckApiKey
          ? '专业核查库无既有核查记录（不代表断言为真）'
          : '未配置 Google Fact Check API Key，已跳过专业核查库',
      hits: fcHits.slice(0, 10),
    };

    const allSources = [...fcSources, ...searchSources];

    // ---- 来源分组：区分「独立佐证」与「同源转载」----
    const groups = groupByOrigin(allSources);
    state.sources = allSources;
    state.groups = summarizeIndependence(groups).groupList;

    // ---- ③ 逐条判定 ----
    const results = [];
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      await emit({
        stage: 'verify',
        note: `正在核查第 ${i + 1}/${claims.length} 条断言：${claim.text.slice(0, 24)}…`,
      });

      // 该断言自己的来源：本条检索词命中的 + 专业核查库针对它的命中
      const own = allSources.filter(
        (s) =>
          (s.query && plan.claimOfQuery[s.query] === claim.id) ||
          (s.engine === 'google-factcheck' && fcHits.some((h) => h.claimId === claim.id && h.reviewUrl === s.url))
      );

      const ownGroups = groupByOrigin(own);

      let raw;
      try {
        raw = await verifyClaim(claim, own.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet })));
      } catch (e) {
        raw = {
          verdict: TEXT_VERDICTS.NO_EVIDENCE,
          reasoning: `核查调用失败：${String((e && e.message) || e)}`,
          evidence: [],
          missing: ['核查过程未能完成'],
        };
      }

      // 被实际引用的证据（模型可能引用了不在本次检索结果里的链接，后面还要过白名单）
      const citedEvidence = (raw.evidence || []).filter((e) => e && e.url);

      /**
       * 把被引用的来源映射回「来源组」。
       *
       * 【为什么不能直接对引用重新分组】
       *   转载判定依赖摘要的文本比对（靠摘要才能识别通稿），而模型给的引用里没有摘要。
       *   如果拿引用重新分组，就退化成了「按域名分组」，会把同源转载误算成多个独立来源。
       *   所以正确做法是：用 ownGroups（含摘要比对的结果）反查引用属于哪个组。
       */
      const citedGroups = [];
      for (const e of citedEvidence) {
        const g = ownGroups.find((grp) => (grp.memberUrls || []).includes(e.url));
        if (g && !citedGroups.some((x) => x.id === g.id)) citedGroups.push(g);
      }

      // 程序规则裁定判定与置信度（模型只提供理由与引用）
      const finalized = finalizeVerdict({
        verdict: raw.verdict,
        evidence: citedEvidence,
        sourceCount: own.length,
        groups: citedGroups,
      });

      const result = {
        claimId: claim.id,
        claimText: claim.text,
        claimType: claim.type,
        keywords: claim.keywords || [],
        queries: plan.queriesOfClaim[claim.id] || [],
        verdict: finalized.verdict,
        confidence: finalized.confidence,
        forced: finalized.forced || '',
        reasoning: raw.reasoning || '',
        evidence: citedEvidence,
        missing: raw.missing || [],
        sourceCount: own.length,
        independentCount: citedGroups.length,
        independenceNote: buildIndependenceNote(own, citedGroups, ownGroups),
        citedUrls: citedEvidence.map((e) => e.url),
      };

      results.push(result);
    }

    state.results = results;
    await emit({ stage: 'summary', note: '正在汇总核查报告…' });

    // ---- ④ 汇总 ----
    const computedVerdict = aggregateVerdict(results);
    let report = null;
    try {
      report = await summarizeTextCheck(
        results.map((r) => ({
          claimText: r.claimText,
          verdict: r.verdict,
          reasoning: r.reasoning,
          evidence: r.evidence,
          missing: r.missing,
          independenceNote: r.independenceNote,
        })),
        allSources.map((s) => ({ title: s.title, url: s.url })),
        {
          platform: state.source.platform,
          pageUrl: state.source.url,
          queries: plan.queries,
          checkedAt: new Date().toISOString().slice(0, 10),
        }
      );
    } catch (e) {
      report = null;
      state.failures.push({ engine: 'llm-summary', query: '-', error: `汇总失败：${String((e && e.message) || e)}` });
    }

    // ---- URL 白名单硬校验 ----
    const { cleaned, blocked } = verifyTextUrls(allSources, results, report);
    state.results = cleaned.results;
    state.report = cleaned.report;
    state.blockedSources = blocked;

    await emit({
      status: 'done',
      stage: 'done',
      note: '核查完成',
      overallVerdict: computedVerdict,
      finishedAt: new Date().toISOString(),
    });

    return state;
  } catch (e) {
    await emit({
      status: 'failed',
      stage: 'failed',
      note: `核查失败：${String((e && e.message) || e)}`,
      finishedAt: new Date().toISOString(),
    });
    return state;
  }
}

// ---------- 检索计划 ----------

/**
 * 把断言与检索词关联起来，并给每个检索词标记归属的断言。
 * 同一个检索词被多条断言共用时只检索一次。
 */
function buildQueryPlan(claims, options) {
  const maxPerClaim = Math.max(1, Math.min(3, options.maxQueriesPerClaim || 2));
  const queryOf = new Map();   // query → [claimId]
  const claimOfQuery = {};     // query → claimId（代表断言）
  const queriesOfClaim = {};   // claimId → [query]

  for (const claim of claims) {
    const list = [];
    const kws = (claim.keywords || []).filter(Boolean).slice(0, maxPerClaim);
    // 没有关键词时，用断言原文兜底（截断以免查询过长）
    if (!kws.length) kws.push(String(claim.text || '').slice(0, 30));
    for (const kw of kws) {
      const q = String(kw).trim();
      if (!q) continue;
      list.push(q);
      if (!queryOf.has(q)) {
        queryOf.set(q, []);
        claimOfQuery[q] = claim.id;
      }
      queryOf.get(q).push(claim.id);
      (queriesOfClaim[claim.id] = queriesOfClaim[claim.id] || []).push(q);
    }
    if (list.length) queriesOfClaim[claim.id] = list;
  }

  const queries = [...queryOf.keys()].slice(0, MAX_TOTAL_QUERIES);
  return { queries, claimOfQuery, queriesOfClaim };
}

// ---------- 判定聚合 ----------

/**
 * 总体判定：按断言判定的严重程度聚合，不采信模型给的总体结论。
 * 严重程度：false > misleading > partial > （true 与 no-evidence/unverifiable 混合则 unverifiable）> true
 */
export function aggregateVerdict(results) {
  const list = results || [];
  if (!list.length) return TEXT_VERDICTS.UNVERIFIABLE;

  const count = (v) => list.filter((r) => r.verdict === v).length;

  if (count(TEXT_VERDICTS.FALSE) > 0) return TEXT_VERDICTS.FALSE;
  if (count(TEXT_VERDICTS.MISLEADING) > 0) return TEXT_VERDICTS.MISLEADING;
  if (count(TEXT_VERDICTS.PARTIAL) > 0) return TEXT_VERDICTS.PARTIAL;

  const unverifiableCount = count(TEXT_VERDICTS.NO_EVIDENCE) + count(TEXT_VERDICTS.UNVERIFIABLE);
  if (count(TEXT_VERDICTS.TRUE) === list.length) return TEXT_VERDICTS.TRUE;
  if (unverifiableCount > 0) return TEXT_VERDICTS.UNVERIFIABLE;
  return TEXT_VERDICTS.UNVERIFIABLE;
}

/** 生成「来源独立性」说明，供核查过程如实展示 */
function buildIndependenceNote(ownSources, citedGroups, allGroups) {
  if (!ownSources.length) return '本次检索未获得相关来源';
  const syndicated = (allGroups || []).filter((g) => !g.independent);
  const cited = (citedGroups || []).length;
  const parts = [`命中 ${ownSources.length} 条来源，来自 ${cited} 个独立来源组`];
  if (syndicated.length) {
    parts.push(
      `其中 ${syndicated.length} 组被判定为同一篇原文的转载（${syndicated
        .slice(0, 2)
        .map((g) => g.hosts.slice(0, 2).join('、'))
        .join('；')}）`
    );
  }
  return parts.join('，');
}

// ---------- URL 白名单硬校验 ----------

/**
 * 校验并剥离白名单外的 URL。
 * 白名单 = 本次真实检索得到的全部来源 URL。
 */
export function verifyTextUrls(allSources, results, report) {
  const allowed = new Set((allSources || []).map((s) => s.url).filter(Boolean));
  const blocked = [];

  const checkUrl = (u) => {
    const raw = String(u || '').trim();
    if (!raw) return '';
    if (allowed.has(raw)) return raw;
    // 去掉末尾标点再比对一次（模型常在 URL 后加句号）
    const trimmed = raw.replace(/[.,;:)\]}'"]+$/, '');
    if (allowed.has(trimmed)) return trimmed;
    blocked.push(raw);
    return '';
  };

  const cleanResults = (results || []).map((r) => {
    const evidence = (r.evidence || [])
      .map((e) => {
        const url = checkUrl(e.url);
        return url ? { ...e, url } : null;
      })
      .filter(Boolean);
    return {
      ...r,
      evidence,
      citedUrls: evidence.map((e) => e.url),
      // 引用的证据被剥离后，引用数可能归零 —— 判定需相应降级
      confidence: evidence.length === 0 ? 'low' : r.confidence,
    };
  });

  let cleanReport = report;
  if (report) {
    const sources = (report.sources || [])
      .map((s) => {
        const url = checkUrl(s.url);
        return url ? { ...s, url } : null;
      })
      .filter(Boolean);

    // 正文中混入的裸链接一律剥离
    const stripBare = (text) =>
      String(text || '').replace(/https?:\/\/[^\s，。；、）)】\]"'<>]+/g, (m) => {
        const raw = m.replace(/[.,;:]$/, '');
        return allowed.has(raw) ? m : '';
      });

    cleanReport = {
      ...report,
      headline: stripBare(report.headline),
      summary: stripBare(report.summary),
      process: (report.process || []).map(stripBare),
      claimResults: (report.claimResults || []).map((c) => ({
        ...c,
        reasoning: stripBare(c.reasoning),
      })),
      sources,
    };
  }

  return { results: cleanResults, report: cleanReport, blocked: [...new Set(blocked)] };
}
