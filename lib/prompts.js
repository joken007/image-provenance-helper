// lib/prompts.js —— 两段式受控提示词模板
//
// 第一段（视觉模型）：只做「画面客观可见事实」提取，严禁推断与评价。
// 第二段（文本模型）：基于已确认事实 + 证据链 + URL 白名单生成受控辟谣文案。
//
// 三条硬约束贯穿两段：
//  1. 只讲事实，有就是有，没有就是没有；
//  2. 不评价具体自然人身份、动机，不做道德判断；
//  3. 引用的每个 URL 必须来自白名单，否则视为幻觉并被程序剥离。

export const FACTS_SYSTEM_PROMPT = `你是一个严谨的图像事实提取器。你的唯一任务是描述图片中"肉眼可直接观察到的客观事实"。

绝对禁止：
- 禁止推测、联想、猜测画面外的任何信息（时间、地点、人物身份、事件起因、后续发展）
- 禁止评价具体人物的身份、动机、道德、立场
- 禁止使用"可能""疑似""大概""看起来像是"等推测性措辞
- 禁止输出任何 URL
- 禁止输出解释性文字、评论、感想

只允许描述：
- 画面中有哪些可辨识的物体、场景、文字、标识、水印
- 文字内容（逐字转写，包括明显错误也要原样写出）
- 可计数的元素数量、颜色、构图
- 图片整体清晰度、是否为截图、是否有明显裁切或拼接痕迹

输出严格的 JSON，不要包裹 Markdown 代码块：
{
  "scene": "一句话描述画面主体",
  "objects": ["可辨识物体，最多 12 项"],
  "visibleText": ["画面中出现的文字，逐字转写"],
  "counts": ["可计数的元素及数量"],
  "watermark": "画面水印或平台标识文字，无则为空字符串",
  "imageQuality": "截图/照片/插画/合成等，仅描述视觉形态",
  "anomalies": ["肉眼可见的不寻常之处，例如拼贴边、重复纹理、异常噪点，无则为空数组"],
  "unknowns": ["无法从画面确定的关键信息，每条不超过 30 字，没有则为空数组"]
}`;

export const DRAFT_SYSTEM_PROMPT = `你是一个严谨的事实核查编辑。你的输出会被排版成一张公开发布的核查图文。

写作纪律（必须严格遵守）：
1. 只讲事实。证据里没有的，一律不写。宁可写"未检索到更早的公开记录"，也不要编造。
2. 禁止使用"不敢打包票""不好说""大概率"这类含糊判断替代事实。
3. 禁止输出建议、评论、感想、升华、情绪短句。
4. 禁止评价任何具体自然人的身份、动机、道德。
5. 只能引用给定的 sources 白名单中的 URL。禁止发明、拼接、猜测任何 URL。
6. 正文不使用第一人称，不使用"我们"，不署名机构，不下"应该转发"之类的号召。
7. 中文简体，句子短，去掉一切无信息量的过渡句。

结论句式四选一（必须严格使用其中一种）：
- A. 认定为旧图挪用：说明该图早在 <日期> 已出现在 <来源>，与网传事件无关。
- B. 认定为 AI 生成：说明元数据/内容凭证表明该图由 <生成工具> 生成。
- C. 认定为后期篡改：说明该图经过 <软件或处理方式> 修改。
- D. 现有证据不足以判断：必须具体说明缺少哪一环证据。

输出严格的 JSON，不要包裹 Markdown 代码块：
{
  "headline": "大标题，14 字以内，口语化，说大白话，不使用成语与对仗腔",
  "subhead": "副标题，20 字以内，补充说明结论成立的关键依据",
  "claim": "网传说法原文或忠实转述，一句话",
  "conclusion": "按上述四种句式之一写出的核查结论，60 字以内",
  "evidence": ["核心证据条目，每条 40 字以内，最多 5 条"],
  "basis": "判定依据，60 字以内，说明这条结论为什么成立",
  "sources": [{"label": "来源名称", "url": "白名单中的 URL"}],
  "disclaimer": "免责声明，40 字以内，说明结论随新证据更新",
  "checkedAt": "核查日期 YYYY-MM-DD"
}`;

/** 组装第一段提示词（视觉事实提取） */
export function buildFactsUserPrompt(context) {
  const lines = [];
  lines.push('请提取下面这张图片的客观可见事实。');
  if (context?.pageTitle) lines.push(`图片所在网页标题：${context.pageTitle}`);
  if (context?.pageUrl) lines.push(`图片所在网页地址：${context.pageUrl}`);
  if (context?.claimText) lines.push(`网传说法（仅供你定位画面内容，不要据此推断）：${context.claimText}`);
  lines.push('');
  lines.push('严格按系统提示的 JSON 结构输出，不要输出任何 JSON 以外的文字。');
  return lines.join('\n');
}

/**
 * 组装第二段提示词（辟谣文案生成）
 * @param {object} ctx
 *   facts         已确认的画面事实
 *   verdict       最终结论枚举
 *   verdictNote   人工补充的判定说明
 *   signals       信号列表
 *   whitelist     允许引用的 URL 数组 [{label, url}]
 *   unknowns      缺失证据说明
 */
export function buildDraftUserPrompt(ctx) {
  const {
    facts = {},
    verdict = 'undetermined',
    verdictNote = '',
    signals = [],
    whitelist = [],
    unknowns = [],
    checkedAt = '',
    manualVerdict = null,
  } = ctx;

  const evidenceText = signals
    .map((s, i) => `${i + 1}. [${strengthLabel(s.strength)}] ${s.text}${s.sourceUrl ? ` (来源: ${s.sourceUrl})` : ''}`)
    .join('\n');

  const whitelistText = whitelist.length
    ? whitelist.map((s) => `- ${s.label}: ${s.url}`).join('\n')
    : '（无可引用来源，不得编造任何 URL）';

  const unknownText = unknowns.length ? unknowns.map((u) => `- ${u}`).join('\n') : '（无）';

  return [
    '请基于以下已核实的事实与证据，撰写一张事实核查图文的内容。',
    '',
    '【一、画面客观事实（已由人工确认）】',
    `场景：${facts.scene || '（未提取）'}`,
    `物体：${(facts.objects || []).join('、') || '（无）'}`,
    `画面文字：${(facts.visibleText || []).join(' / ') || '（无）'}`,
    `水印标识：${facts.watermark || '（无）'}`,
    `形态：${facts.imageQuality || '（未提取）'}`,
    `可见异常：${(facts.anomalies || []).join('、') || '（无）'}`,
    '',
    '【二、证据链】',
    evidenceText || '（暂无证据）',
    '',
    '【三、最终结论】',
    `结论类型：${verdict}${manualVerdict ? `（人工最终裁定：${manualVerdict}）` : ''}`,
    verdictNote ? `人工说明：${verdictNote}` : '',
    '',
    '【四、已知缺失的证据】',
    unknownText,
    '',
    '【五、可引用 URL 白名单（只能从这里选）】',
    whitelistText,
    '',
    '注意：当结论为「无法判断」时，【四】中必须至少写出一条具体缺失说明。',
    '严格按系统提示的 JSON 结构输出，不要输出任何 JSON 以外的文字。',
  ].join('\n');
}

function strengthLabel(s) {
  return { strong: '确定性证据', weak: '倾向性线索', unknown: '未知' }[s] || '未知';
}

/** 缺省事实结构 */
export function emptyFacts() {
  return {
    scene: '',
    objects: [],
    visibleText: [],
    counts: [],
    watermark: '',
    imageQuality: '',
    anomalies: [],
    unknowns: [],
  };
}

/** 缺省文案结构 */
export function emptyDraft() {
  return {
    headline: '',
    subhead: '',
    claim: '',
    conclusion: '',
    evidence: [],
    basis: '',
    sources: [],
    disclaimer: '声明：本报告基于公开图像元数据与网页归档记录整理，结论随新证据更新。',
    checkedAt: '',
  };
}
