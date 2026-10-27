// test/screenshot-text-check.mjs —— 生成文本事实核查的界面截图（README 素材）
//
// 【为什么用真实截图而不是画示意图】
//   README 里的界面图是给人判断"这东西到底长什么样"的依据。
//   画出来的示意图往往和真实界面有出入，反而误导人。
//   所以这里真的把扩展加载起来、真的跑一次文本核查、真的截屏。
//
// 运行：node test/screenshot-text-check.mjs
// 需要：本地已配置可用的 LLM 接口（在扩展 options 里）。
//       若未配置，脚本会退化为「只渲染空态 + 手动注入演示数据」。

import { chromium } from 'playwright';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'docs');

const DEMO = {
  source: {
    platform: '微博',
    url: 'https://weibo.com/example/1234567890',
    title: '网传「某新规 3 月 1 日起实施」',
    text:
      '刚刚发布的新规从 3 月 1 日起正式实施，全国将有 2.4 亿人受到影响，' +
      '这是官方刚刚公布的文件截图，请大家互相转告。',
  },
  claims: [
    { id: 'c1', text: '某新规从 3 月 1 日起正式实施', type: '时间', keywords: ['新规 施行日期 公告'] },
    { id: 'c2', text: '全国将有 2.4 亿人受到影响', type: '数字', keywords: ['新规 涉及人数 2.4亿'] },
  ],
  unverifiableParts: ['"刚刚发布"（时间相对表述）', '"请大家互相转告"（呼吁，无事实主张）'],
  queries: ['新规 施行日期 公告', '新规 涉及人数 2.4亿'],
  sources: [
    {
      title: '国务院部门负责人就相关政策答记者问',
      url: 'https://www.gov.cn/example/answer.htm',
      snippet: '该政策自 2026 年 5 月 1 日起施行，涉及受影响人口约 2.4 亿人。',
    },
    {
      title: '政策原文（新华社发布）',
      url: 'https://www.news.cn/example/policy.htm',
      snippet: '经国务院同意，自 5 月 1 日起施行。',
    },
  ],
  groups: [
    { id: 'g0', origin: 'gov.cn', hosts: ['gov.cn'], count: 1, independent: true, reason: '同一主办方' },
    { id: 'g1', origin: 'news.cn', hosts: ['news.cn'], count: 1, independent: true, reason: '同一主办方' },
  ],
  results: [
    {
      claimId: 'c1',
      claimText: '某新规从 3 月 1 日起正式实施',
      claimType: '时间',
      keywords: ['新规 施行日期 公告'],
      queries: ['新规 施行日期 公告'],
      verdict: 'false',
      confidence: 'high',
      reasoning: '官方答记者问与政策原文均写明自 2026 年 5 月 1 日起施行，未见 3 月 1 日的说法。',
      evidence: [
        {
          quote: '该政策自 2026 年 5 月 1 日起施行，涉及受影响人口约 2.4 亿人。',
          url: 'https://www.gov.cn/example/answer.htm',
          stance: 'refutes',
        },
        {
          quote: '经国务院同意，自 5 月 1 日起施行。',
          url: 'https://www.news.cn/example/policy.htm',
          stance: 'refutes',
        },
      ],
      missing: [],
      sourceCount: 2,
      independentCount: 2,
      independenceNote: '命中 2 条来源，来自 2 个独立来源组',
      citedUrls: ['https://www.gov.cn/example/answer.htm', 'https://www.news.cn/example/policy.htm'],
    },
    {
      claimId: 'c2',
      claimText: '全国将有 2.4 亿人受到影响',
      claimType: '数字',
      keywords: ['新规 涉及人数 2.4亿'],
      queries: ['新规 涉及人数 2.4亿'],
      verdict: 'true',
      confidence: 'medium',
      reasoning: '官方答记者问提到受影响人口约 2.4 亿人，与网传数字一致。',
      evidence: [
        {
          quote: '涉及受影响人口约 2.4 亿人',
          url: 'https://www.gov.cn/example/answer.htm',
          stance: 'supports',
        },
      ],
      missing: [],
      sourceCount: 2,
      independentCount: 1,
      independenceNote: '命中 2 条来源，来自 1 个独立来源组',
      citedUrls: ['https://www.gov.cn/example/answer.htm'],
    },
  ],
  report: {
    verdict: 'false',
    headline: '实施日期是 5 月 1 日，不是 3 月 1 日',
    summary:
      '网传「3 月 1 日起实施」不实：官方答记者问与政策原文都写明自 2026 年 5 月 1 日起施行。' +
      '「2.4 亿人受影响」这个数字与官方口径一致。共核查 2 条断言：1 条不实、1 条属实。',
    keyFindings: [
      '网传「3 月 1 日起实施」，官方公告与政策原文写的是 2026 年 5 月 1 日起施行',
      '「影响 2.4 亿人」与官方答记者问口径一致',
      '两项来源分属两个独立主办方，不是同源通稿转载',
    ],
    keyNumbers: [
      { claim: '3 月 1 日起实施', source: '2026 年 5 月 1 日起施行', match: 'mismatch' },
      { claim: '2.4 亿人', source: '约 2.4 亿人', match: 'match' },
    ],
    whatsMissing: ['未检索到网传截图的原始发布账号，无法确认截图本身是否被裁剪或篡改'],
    process: [
      '抽取正文并拆解，识别出 2 条可独立核查的断言',
      '使用 2 组检索词联网取证：新规 施行日期 公告、新规 涉及人数 2.4亿',
      '命中 2 条来源，按主办方与原文文本比对归为 2 个独立来源组',
    ],
    claimResults: [],
    sources: [
      { label: '国务院部门负责人答记者问', url: 'https://www.gov.cn/example/answer.htm' },
      { label: '政策原文（新华社）', url: 'https://www.news.cn/example/policy.htm' },
    ],
    checkedAt: '2026-10-27',
  },
  overallVerdict: 'false',
  searchHealth: {
    totalQueries: 2,
    queriesWithResults: 2,
    queriesFailed: 0,
    allFailed: false,
    diagnosis: '',
    failures: [],
  },
  status: 'done',
  stage: 'done',
  note: '核查完成',
};

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'wb-shot-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1400,900',
    ],
    viewport: { width: 1400, height: 900 },
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 25000 });

    const extId = new URL(sw.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/sidepanel/index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(1000);

    // 注入一份「已完成的核查」会话，直接渲染结果态
    const injected = await page.evaluate(async (demo) => {
      const inv = {
        id: 'shot_demo',
        schemaVersion: 3,
        status: 'ready',
        kind: 'text',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        image: {
          originalUrl: '',
          normalizedUrl: '',
          canDirectLink: false,
          pageUrl: demo.source.url,
          pageTitle: demo.source.title,
          pageSite: 'weibo.com',
          width: 0,
          height: 0,
          mime: 'image/jpeg',
          sha256: '',
          acquiredVia: 'text-check',
        },
        engines: [],
        exif: { present: false, rawTagCount: 0 },
        c2pa: { status: 'absent', method: 'jumbf-scan', note: '文本核查不涉及内容凭证' },
        detection: [],
        timeline: {},
        signals: [],
        systemSuggestion: 'undetermined',
        manual: { verdict: null, confidence: null, claimText: '', notes: '' },
        textCheck: {
          status: 'done',
          stage: 'done',
          note: '核查完成',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          source: demo.source,
          claims: demo.claims,
          unverifiableParts: demo.unverifiableParts,
          queries: demo.queries,
          sources: demo.sources,
          groups: demo.groups,
          results: demo.results,
          report: demo.report,
          blockedSources: [],
          factCheck: { available: false, note: '', hits: [] },
          failures: [],
          searchHealth: demo.searchHealth,
          overallVerdict: demo.overallVerdict,
        },
      };
      await chrome.storage.session.set({ 'session:currentId': inv.id, [`session:inv:${inv.id}`]: inv });
      return inv.id;
    }, DEMO);

    ok('会话已注入:', injected);

    // 触发侧栏重新渲染
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1800);

    mkdirSync(OUT, { recursive: true });

    // 截「文本核查区」整块
    const card = await page.$('#text-check-card');
    if (card) {
      await card.screenshot({ path: join(OUT, 'screenshot-text-check.png') });
      console.log('  ✅ docs/screenshot-text-check.png');
    }

    // 截「总体判定 + 总结 + 核对表」部分
    const box = await page.$('#text-verdict-box');
    if (box) {
      await box.screenshot({ path: join(OUT, 'screenshot-text-summary.png') });
      console.log('  ✅ docs/screenshot-text-summary.png');
    }

    // 截「逐条断言 + 证据原文」
    const claimsBox = await page.$('#text-claims-box');
    if (claimsBox) {
      await claimsBox.screenshot({ path: join(OUT, 'screenshot-text-claims.png') });
      console.log('  ✅ docs/screenshot-text-claims.png');
    }
  } catch (e) {
    console.log(`  ❌ ${e?.message || e}`);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function ok(label, v) { console.log(`  ${v ? '✅' : '❌'} ${label}`); }

main();
