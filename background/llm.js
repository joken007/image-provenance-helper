// background/llm.js —— 两段式 LLM 调用 + 容错 JSON 解析 + URL 白名单硬校验
//
// 为什么需要容错解析：
//   许多免费中转路由与开源视觉模型不支持 response_format=json_object（返回 400），
//   或者会在 JSON 前后输出 <think>...</think> 与 Markdown 代码块。
//   因此：① 带 response_format 返回 400 时自动去掉该参数重试一次；
//        ② 解析时先剥离 <think> 块，再用正则定位首个 { 到最后一个 } 之间的子串解析。

import { loadOptions } from './store.js';
import {
  FACTS_SYSTEM_PROMPT,
  DRAFT_SYSTEM_PROMPT,
  CLAIMS_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  TEXT_SUMMARY_SYSTEM_PROMPT,
  buildFactsUserPrompt,
  buildDraftUserPrompt,
  buildClaimsUserPrompt,
  buildVerifyUserPrompt,
  buildTextSummaryUserPrompt,
  emptyFacts,
  emptyDraft,
  emptyClaims,
  emptyTextReport,
} from '../lib/prompts.js';
import { VERDICTS } from '../lib/constants.js';

// ---------- 阶段一：视觉事实提取 ----------

export async function generateVisionFacts(inv, imageBase64, mime = 'image/jpeg') {
  const options = await loadOptions();
  if (!options.llmBaseUrl) throw new Error('未配置 LLM 接口地址（请到扩展选项页填写）');
  if (!options.llmVisionModel) throw new Error('未配置视觉模型名称');

  const dataUrl = `data:${mime};base64,${imageBase64}`;
  const body = {
    model: options.llmVisionModel,
    messages: [
      { role: 'system', content: FACTS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildFactsUserPrompt(inv) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };

  const raw = await callChatJson(options, body);
  return normalizeFacts(raw);
}

// ---------- 阶段二：辟谣文案生成 ----------

export async function generateFactCheckDraft(inv) {
  const options = await loadOptions();
  if (!options.llmBaseUrl) throw new Error('未配置 LLM 接口地址（请到扩展选项页填写）');
  if (!options.llmTextModel) throw new Error('未配置文本模型名称');

  const facts = inv.article?.facts || emptyFacts();
  const manualVerdict = inv.manual?.verdict || null;
  const verdict = manualVerdict || inv.systemSuggestion || VERDICTS.UNDETERMINED;

  const whitelist = collectWhitelist(inv);
  const unknowns = collectUnknowns(inv, facts);

  const body = {
    model: options.llmTextModel,
    messages: [
      { role: 'system', content: DRAFT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildDraftUserPrompt({
          facts,
          verdict,
          verdictNote: inv.manual?.notes || '',
          manualVerdict,
          signals: inv.signals || [],
          whitelist,
          unknowns,
          checkedAt: new Date().toISOString().slice(0, 10),
        }),
      },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  };

  const raw = await callChatJson(options, body);
  const draft = normalizeDraft(raw);

  // URL 白名单硬校验：剥离一切不在白名单里的链接
  const { draft: cleaned, blockedSources } = verifyDraftUrls(inv, draft);
  return { draft: cleaned, blockedSources };
}

// ---------- URL 白名单 ----------

/** 汇总本次核查中所有「被允许引用」的来源链接 */
export function collectWhitelist(inv) {
  const list = [];
  const seen = new Set();
  const push = (label, url) => {
    if (!url) return;
    const u = String(url).trim();
    if (!/^https?:\/\//i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    list.push({ label, url: u });
  };

  for (const eng of inv.engines || []) {
    if (eng.earliestSeenUrl) push(`${eng.name} 检索到的最早出处`, eng.earliestSeenUrl);
  }
  if (inv.timeline?.image?.snapshotUrl) push('Wayback 图片快照', inv.timeline.image.snapshotUrl);
  if (inv.timeline?.page?.snapshotUrl) push('Wayback 来源页快照', inv.timeline.page.snapshotUrl);
  for (const s of inv.signals || []) {
    if (s.sourceUrl) push(s.text.slice(0, 30), s.sourceUrl);
  }
  return list;
}

/** 汇总缺失的证据说明 */
export function collectUnknowns(inv, facts) {
  const list = [];
  const hasReverse = (inv.engines || []).some((e) => e.earliestSeenUrl);
  if (!hasReverse) list.push('未在任何反搜引擎中检索到更早的公开出处');
  if (!inv.exif?.present) list.push('图片不含 EXIF 元数据，无法确认原始拍摄设备与时间');
  if (!inv.c2pa || inv.c2pa.status === 'absent') list.push('图片无 C2PA 内容凭证，无法确认是否经 AI 工具生成');
  if (inv.systemSuggestion === VERDICTS.UNDETERMINED && !inv.manual?.verdict) {
    list.push('缺少可独立验证的确定性证据，暂无法给出定性结论');
  }
  for (const u of facts?.unknowns || []) list.push(u);
  return [...new Set(list)];
}

/**
 * 校验并剥离白名单外的 URL
 * @returns {{draft: object, blockedSources: string[]}}
 */
export function verifyDraftUrls(inv, draft) {
  const blocked = [];
  const cleaned = { ...(draft || emptyDraft()) };

  if (Array.isArray(cleaned.sources)) {
    const allowed = new Map(collectWhitelist(inv).map((s) => [s.url, s]));
    const kept = [];
    for (const s of cleaned.sources) {
      const url = String(s?.url || '').trim();
      if (!url) continue;
      if (allowed.has(url)) {
        kept.push({ label: s.label || allowed.get(url).label, url });
      } else {
        blocked.push(url);
      }
    }
    cleaned.sources = kept;
  }

  // 证据条目与正文里若混入了白名单外的裸链接，一并剥离
  const allowedUrls = new Set(collectWhitelist(inv).map((s) => s.url));
  const stripUrls = (text) =>
    String(text || '').replace(/https?:\/\/[^\s，。；、）)】\]"'<>]+/g, (m) => {
      const raw = m.replace(/[.,;:]$/, '');
      const tail = m.slice(raw.length);
      if (allowedUrls.has(raw)) return m;
      blocked.push(raw);
      return tail;
    });

  for (const key of ['headline', 'subhead', 'claim', 'conclusion', 'basis', 'disclaimer']) {
    if (typeof cleaned[key] === 'string') cleaned[key] = stripUrls(cleaned[key]);
  }
  if (Array.isArray(cleaned.evidence)) {
    cleaned.evidence = cleaned.evidence.map((e) => stripUrls(e));
  }

  return { draft: cleaned, blockedSources: [...new Set(blocked)] };
}

// ---------- 文本链路：断言拆解 / 逐条核查 / 汇总 ----------

/**
 * 第一段：把帖文正文拆成可独立核查的断言
 * @param {object} postContext {text, platform, title, author, publishedAt, url}
 */
export async function decomposeClaims(postContext) {
  const options = await loadOptions();
  if (!options.llmBaseUrl) throw new Error('未配置 LLM 接口地址（请到扩展选项页填写）');
  if (!options.llmTextModel) throw new Error('未配置文本模型名称');

  const body = {
    model: options.llmTextModel,
    messages: [
      { role: 'system', content: CLAIMS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildClaimsUserPrompt({
          text: postContext?.text || '',
          platform: postContext?.platform?.name || postContext?.platform || '',
          title: postContext?.pageTitle || postContext?.title || '',
          author: postContext?.author || '',
          publishedAt: postContext?.publishedAt || '',
          pageUrl: postContext?.url || '',
        }),
      },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };

  const raw = await callChatJson(options, body);
  return normalizeClaims(raw);
}

/**
 * 第二段：基于本次真实检索到的来源，逐条判定断言
 * @param {object} claim {text, keywords, type}
 * @param {Array}  sources [{title, url, snippet}]
 */
export async function verifyClaim(claim, sources) {
  const options = await loadOptions();
  if (!options.llmBaseUrl) throw new Error('未配置 LLM 接口地址（请到扩展选项页填写）');
  if (!options.llmTextModel) throw new Error('未配置文本模型名称');

  const body = {
    model: options.llmTextModel,
    messages: [
      { role: 'system', content: VERIFY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildVerifyUserPrompt({
          claim: claim?.text || '',
          keywords: claim?.keywords || [],
          sources: sources || [],
        }),
      },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };

  const raw = await callChatJson(options, body);
  return normalizeVerdict(raw);
}

/**
 * 第三段：汇总成核查报告
 * @param {Array}  results 逐条核查结果
 * @param {Array}  sources 本次检索到的全部来源
 * @param {object} meta    {platform, pageUrl, queries, checkedAt}
 */
export async function summarizeTextCheck(results, sources, meta = {}) {
  const options = await loadOptions();
  if (!options.llmBaseUrl) throw new Error('未配置 LLM 接口地址（请到扩展选项页填写）');
  if (!options.llmTextModel) throw new Error('未配置文本模型名称');

  const body = {
    model: options.llmTextModel,
    messages: [
      { role: 'system', content: TEXT_SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildTextSummaryUserPrompt({
          results: results || [],
          sources: sources || [],
          queries: meta.queries || [],
          platform: meta.platform || '',
          pageUrl: meta.pageUrl || '',
          checkedAt: meta.checkedAt || new Date().toISOString().slice(0, 10),
        }),
      },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  };

  const raw = await callChatJson(options, body);
  return normalizeTextReport(raw);
}

// ---------- 结构归一化 ----------

function normalizeClaims(raw) {
  const base = emptyClaims();
  const r = raw || {};
  const claims = Array.isArray(r.claims)
    ? r.claims
        .filter((c) => c && typeof c.text === 'string' && c.text.trim())
        .slice(0, 6)
        .map((c, i) => ({
          id: `c${i + 1}`,
          text: str(c.text),
          keywords: arr(c.keywords).slice(0, 3),
          type: str(c.type) || '其他',
        }))
    : [];
  return { claims, unverifiable: arr(r.unverifiable) };
}

function normalizeVerdict(raw) {
  const r = raw || {};
  const valid = ['true', 'false', 'partial', 'misleading', 'unverifiable', 'no-evidence'];
  const verdict = valid.includes(str(r.verdict)) ? str(r.verdict) : 'unverifiable';
  const evidence = Array.isArray(r.evidence)
    ? r.evidence
        .filter((e) => e && (e.quote || e.url))
        .map((e) => ({
          quote: str(e.quote),
          url: str(e.url),
          stance: ['supports', 'refutes', 'neutral'].includes(str(e.stance)) ? str(e.stance) : 'neutral',
        }))
    : [];
  return {
    verdict,
    // 【重要】confidence 不再由模型自报——实测模型自评置信度并不可靠，
    // 改由 lib/source-trust.js 按「独立来源组的一致率」计算。
    reasoning: str(r.reasoning),
    evidence,
    missing: arr(r.missing),
  };
}

function normalizeTextReport(raw) {
  const base = emptyTextReport();
  const r = raw || {};
  const valid = ['true', 'false', 'partial', 'misleading', 'unverifiable', 'no-evidence'];
  const sources = Array.isArray(r.sources)
    ? r.sources
        .filter((s) => s && (s.url || s.label))
        .map((s) => ({ label: str(s.label) || '来源', url: str(s.url) }))
    : [];
  const claimResults = Array.isArray(r.claimResults)
    ? r.claimResults
        .filter((c) => c && c.claim)
        .map((c) => ({
          claim: str(c.claim),
          verdict: valid.includes(str(c.verdict)) ? str(c.verdict) : 'unverifiable',
          reasoning: str(c.reasoning),
        }))
    : [];
  return {
    verdict: valid.includes(str(r.verdict)) ? str(r.verdict) : base.verdict,
    headline: str(r.headline),
    summary: str(r.summary),
    process: arr(r.process),
    claimResults,
    sources,
    checkedAt: str(r.checkedAt),
  };
}

// ---------- HTTP 调用与容错解析 ----------

/**
 * 调用 chat completions 并解析出 JSON
 * 自动处理：400 时去掉 response_format 重试；<think> 剥离；Markdown 代码块剥离
 */
export async function callChatJson(options, body) {
  const url = normalizeEndpoint(options.llmBaseUrl);
  const headers = {
    'Content-Type': 'application/json',
  };
  if (options.llmApiKey) headers.Authorization = `Bearer ${options.llmApiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 400 && body.response_format) {
    // 免费路由不支持 json_object，去掉后重试一次
    const retryBody = { ...body };
    delete retryBody.response_format;
    return callChatJson(options, retryBody);
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`LLM 接口返回 HTTP ${resp.status}：${text.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`LLM 返回内容无法解析为 JSON：${text.slice(0, 200)}`);
  }

  const content = extractContent(payload);
  return parseLooseJson(content);
}

/** 兼容多种返回结构，取出模型输出的文本 */
function extractContent(payload) {
  const choices = payload?.choices || payload?.data?.choices;
  if (Array.isArray(choices) && choices.length) {
    const c = choices[0];
    if (typeof c?.message?.content === 'string') return c.message.content;
    if (typeof c?.text === 'string') return c.text;
    // 部分中转路由把内容放在数组里
    if (Array.isArray(c?.message?.content)) {
      return c.message.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
  }
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (typeof payload?.content === 'string') return payload.content;
  throw new Error('LLM 返回结构无法识别');
}

/**
 * 容错 JSON 解析：
 *  1) 剥离 <think>...</think>
 *  2) 剥离 ```json ``` 代码块围栏
 *  3) 正则定位第一个 { 到最后一个 } 之间的子串
 *  4) 失败则逐个尝试从每个 { 起头的片段解析
 */
export function parseLooseJson(content) {
  let text = String(content || '');

  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      /* 继续尝试 */
    }
  }

  // 逐段尝试
  const parts = text.split(/\n(?=\s*\{)/);
  for (const part of parts) {
    const f = part.indexOf('{');
    const l = part.lastIndexOf('}');
    if (f >= 0 && l > f) {
      try {
        return JSON.parse(part.slice(f, l + 1));
      } catch {
        /* next */
      }
    }
  }

  throw new Error('模型输出中未找到可解析的 JSON');
}

/** 补齐缺失字段，保证下游拿到结构完整的数据 */
function normalizeFacts(raw) {
  const base = emptyFacts();
  const r = raw || {};
  return {
    scene: str(r.scene),
    objects: arr(r.objects),
    visibleText: arr(r.visibleText),
    counts: arr(r.counts),
    watermark: str(r.watermark),
    imageQuality: str(r.imageQuality),
    anomalies: arr(r.anomalies),
    unknowns: arr(r.unknowns),
    ...(Object.keys(base).length ? {} : {}),
  };
}

function normalizeDraft(raw) {
  const base = emptyDraft();
  const r = raw || {};
  const sources = Array.isArray(r.sources)
    ? r.sources
        .filter((s) => s && (s.url || s.label))
        .map((s) => ({ label: str(s.label) || '来源', url: str(s.url) }))
    : [];
  return {
    headline: str(r.headline),
    subhead: str(r.subhead),
    claim: str(r.claim),
    conclusion: str(r.conclusion),
    evidence: arr(r.evidence),
    basis: str(r.basis),
    sources,
    disclaimer: str(r.disclaimer) || base.disclaimer,
    checkedAt: str(r.checkedAt),
  };
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function arr(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x.trim() : String(x))).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

/** 把用户填的 base url 归一化成 chat completions 端点 */
export function normalizeEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim();
  if (!u) throw new Error('LLM 接口地址为空');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v\d+$/.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}
