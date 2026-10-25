// test/unit.test.mjs —— 纯函数单元测试（node --test）
// 覆盖：URL 归一化、CDN 原图还原、PNG tEXt 扫描、信号评分、JSON 容错解析、URL 白名单

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  upgradeToOriginalUrl,
  normalizeForArchive,
  isHotlinkProtected,
  isNonDirectUrl,
  base64ToUint8,
  uint8ToBase64,
  sha256Hex,
  safeHost,
  shortenUrl,
  wrapChineseText,
  filenameFromUrl,
} from '../lib/utils.js';

import { scanPngTextChunks } from '../background/metadata.js';
import { evaluateSignals } from '../background/score.js';
import { parseLooseJson, normalizeEndpoint, verifyDraftUrls, collectWhitelist } from '../background/llm.js';
import { findAscii } from '../background/c2pa-quick-scan.js';

// ---------------- URL 处理 ----------------

test('微博缩略图路径升级为原图', () => {
  const out = upgradeToOriginalUrl('https://wx1.sinaimg.cn/large/orj360/q70abc123.jpg');
  assert.match(out, /\/mw2000\//);
  assert.match(out, /q70abc123\.jpg$/);
});

test('X 图床 name 参数升级为 orig', () => {
  const out = upgradeToOriginalUrl('https://pbs.twimg.com/media/AbC123?format=jpg&name=small');
  assert.match(out, /name=orig/);
});

test('小红书 imageView2 参数被剥离', () => {
  const out = upgradeToOriginalUrl('https://sns-img-qc.xhscdn.com/abc.jpg?imageView2/2/w/1080/format/webp');
  assert.ok(!out.includes('imageView2'));
  assert.match(out, /abc\.jpg$/);
});

test('微信图床保持原样（签名参数不可改写）', () => {
  const url = 'https://mmbiz.qpic.cn/mmbiz_jpg/x/abc?wx_fmt=jpeg&from=appmsg';
  assert.equal(upgradeToOriginalUrl(url), url);
});

test('追踪参数在归档归一化时被剥离', () => {
  const out = normalizeForArchive('https://example.com/a/b?utm_source=wechat&spm=x&id=42#frag');
  assert.ok(!out.includes('utm_source'));
  assert.ok(!out.includes('spm'));
  assert.ok(!out.includes('#frag'));
  assert.match(out, /id=42/);
});

test('防盗链域名识别', () => {
  assert.equal(isHotlinkProtected('https://mmbiz.qpic.cn/x/1.jpg'), true);
  assert.equal(isHotlinkProtected('https://wx2.sinaimg.cn/x.jpg'), true);
  assert.equal(isHotlinkProtected('https://example.com/x.jpg'), false);
});

test('blob / data URL 判定为不可直链', () => {
  assert.equal(isNonDirectUrl('blob:https://example.com/abc'), true);
  assert.equal(isNonDirectUrl('data:image/png;base64,AAAA'), true);
  assert.equal(isNonDirectUrl('https://example.com/a.png'), false);
});

// ---------------- 字节工具 ----------------

test('base64 与 Uint8Array 互转可逆', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128]);
  const b64 = uint8ToBase64(bytes);
  assert.deepEqual([...base64ToUint8(b64)], [...bytes]);
});

test('sha256 计算结果与已知向量一致', async () => {
  const hash = await sha256Hex(new TextEncoder().encode('abc'));
  assert.equal(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('ASCII 查找定位正确', () => {
  const bytes = new TextEncoder().encode('hello jumb world');
  assert.equal(findAscii(bytes, [0x6a, 0x75, 0x6d, 0x62]), 6);
  assert.equal(findAscii(bytes, [0x78, 0x78]), -1);
});

// ---------------- PNG tEXt 扫描 ----------------

/** 构造一个带 tEXt 块的最小 PNG */
function makePngWithText(keyword, value) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdrData = new Uint8Array(13);
  const view = new DataView(ihdrData.buffer);
  view.setUint32(0, 100);
  view.setUint32(4, 100);
  ihdrData[8] = 8;
  ihdrData[9] = 6;

  const textBytes = new TextEncoder().encode(keyword + '\0' + value);
  const chunks = [];
  const mk = (type, data) => {
    const typeBytes = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(typeBytes, 4);
    out.set(data, 8);
    // CRC 填 0，扫描器不校验
    return out;
  };
  chunks.push(mk('IHDR', ihdrData));
  chunks.push(mk('tEXt', textBytes));
  chunks.push(mk('IEND', new Uint8Array(0)));

  const total = sig.length + chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let off = sig.length;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

test('PNG tEXt 命中 Stable Diffusion parameters 判为 AI 生成', () => {
  const png = makePngWithText(
    'parameters',
    'positive_prompt: a cat\nNegative prompt: bad\nSteps: 20, Sampler: DPM++ 2M, CFG scale: 7'
  );
  const r = scanPngTextChunks(png);
  assert.equal(r.detected, true);
  assert.equal(r.generator, 'stable-diffusion');
  assert.equal(r.rawKey, 'parameters');
});

test('PNG tEXt 命中 ComfyUI workflow 判为 AI 生成', () => {
  const png = makePngWithText('workflow', '{"nodes":[{"class_type":"KSampler"}]}');
  const r = scanPngTextChunks(png);
  assert.equal(r.detected, true);
  assert.equal(r.generator, 'comfyui');
});

test('普通 PNG 不误报', () => {
  const png = makePngWithText('Software', 'Adobe Photoshop 25.0');
  const r = scanPngTextChunks(png);
  assert.equal(r.detected, false);
});

test('非 PNG 数据直接返回未检出', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.equal(scanPngTextChunks(jpeg).detected, false);
});

// ---------------- 信号评分 ----------------

test('无强信号时结论强制为 undetermined', () => {
  const inv = {
    exif: { present: false, rawTagCount: 0 },
    c2pa: { status: 'absent', method: 'jumbf-scan', note: '' },
    engines: [],
    timeline: {},
    detection: [],
  };
  const r = evaluateSignals(inv);
  assert.equal(r.suggestion, 'undetermined');
  assert.equal(r.signals.filter((s) => s.strength === 'strong').length, 0);
});

test('PNG AIGC 参数触发 likely-ai 强信号', () => {
  const inv = {
    exif: { present: true, aigcChunk: { detected: true, generator: 'stable-diffusion', rawKey: 'parameters' } },
    c2pa: { status: 'absent' },
    engines: [],
    timeline: {},
    detection: [],
  };
  const r = evaluateSignals(inv);
  assert.equal(r.suggestion, 'likely-ai');
  assert.ok(r.signals.some((s) => s.id === 'sig_png_aigc' && s.strength === 'strong'));
});

test('人工补录最早出处触发 likely-old-reuse 强信号', () => {
  const inv = {
    exif: { present: false },
    c2pa: { status: 'absent' },
    engines: [
      {
        id: 'tineye',
        name: 'TinEye',
        earliestSeenUrl: 'https://old.example.com/post',
        earliestSeenDate: '2019-05-12',
        earliestSeenContext: '早期新闻配图',
      },
    ],
    timeline: {},
    detection: [],
  };
  const r = evaluateSignals(inv);
  assert.equal(r.suggestion, 'likely-old-reuse');
});

test('C2PA 相机签名有效触发 no-anomaly', () => {
  const inv = {
    exif: { present: true, make: 'Canon', model: 'EOS R5' },
    c2pa: { status: 'verified-valid', signer: 'Canon', isAiGenerated: false },
    engines: [],
    timeline: {},
    detection: [],
  };
  const r = evaluateSignals(inv);
  assert.equal(r.suggestion, 'no-anomaly');
});

test('缺失 EXIF 只产生 unknown 信号，不指为造假', () => {
  const inv = { exif: { present: false }, c2pa: { status: 'absent' }, engines: [], timeline: {}, detection: [] };
  const r = evaluateSignals(inv);
  const absent = r.signals.find((s) => s.id === 'sig_exif_absent');
  assert.equal(absent.strength, 'unknown');
  assert.equal(absent.direction, 'neutral');
});

test('像素级 AI 概率仅产生弱信号', () => {
  const inv = {
    exif: { present: true, make: 'X', model: 'Y' },
    c2pa: { status: 'absent' },
    engines: [],
    timeline: {},
    detection: [{ provider: 'sightengine', aiScore: 0.92 }],
  };
  const r = evaluateSignals(inv);
  const det = r.signals.find((s) => s.id === 'sig_det_sightengine');
  assert.equal(det.strength, 'weak');
  assert.equal(r.suggestion, 'undetermined');
});

// ---------------- LLM 容错解析 ----------------

test('解析带 think 标签与代码块围栏的 JSON', () => {
  const raw = '<think>让我想想</think>\n```json\n{"scene":"一间办公室","objects":["桌子"]}\n```';
  const r = parseLooseJson(raw);
  assert.equal(r.scene, '一间办公室');
  assert.deepEqual(r.objects, ['桌子']);
});

test('解析前后夹带文字的 JSON', () => {
  const r = parseLooseJson('好的，结果如下：{"scene":"街道"} 请查收');
  assert.equal(r.scene, '街道');
});

test('无 JSON 时抛出错误', () => {
  assert.throws(() => parseLooseJson('完全没有 JSON'), /未找到可解析的 JSON/);
});

test('接口地址自动补全 chat/completions', () => {
  assert.equal(normalizeEndpoint('https://api.x.com'), 'https://api.x.com/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://api.x.com/v1'), 'https://api.x.com/v1/chat/completions');
  assert.equal(
    normalizeEndpoint('https://api.x.com/v1/chat/completions'),
    'https://api.x.com/v1/chat/completions'
  );
  assert.equal(normalizeEndpoint('api.x.com'), 'https://api.x.com/v1/chat/completions');
});

// ---------------- URL 白名单 ----------------

test('白名单外的链接被剥离并记录', () => {
  const inv = {
    engines: [{ id: 'tineye', name: 'TinEye', earliestSeenUrl: 'https://real.example.com/a' }],
    timeline: {},
    signals: [],
  };
  const { draft, blockedSources } = verifyDraftUrls(inv, {
    headline: '测试',
    sources: [
      { label: '真实来源', url: 'https://real.example.com/a' },
      { label: '幻觉来源', url: 'https://fake.example.com/b' },
    ],
    conclusion: '见 https://fake.example.com/c 了解更多',
  });
  assert.equal(draft.sources.length, 1);
  assert.equal(draft.sources[0].url, 'https://real.example.com/a');
  assert.ok(blockedSources.includes('https://fake.example.com/b'));
  assert.ok(blockedSources.includes('https://fake.example.com/c'));
  assert.ok(!draft.conclusion.includes('fake.example.com'));
});

test('白名单汇总包含反搜出处与快照链接', () => {
  const inv = {
    engines: [{ id: 'tineye', name: 'TinEye', earliestSeenUrl: 'https://real.example.com/a' }],
    timeline: { image: { snapshotUrl: 'https://web.archive.org/web/20200101/x' } },
    signals: [],
  };
  const wl = collectWhitelist(inv);
  const urls = wl.map((w) => w.url);
  assert.ok(urls.includes('https://real.example.com/a'));
  assert.ok(urls.includes('https://web.archive.org/web/20200101/x'));
});

// ---------------- 文本与格式化 ----------------

test('中文折行不把标点放在行首', () => {
  const measure = (t) => t.length * 10;
  const lines = wrapChineseText(measure, '这是一句话。需要换行吗？好的', 60);
  assert.ok(lines.length > 1);
  for (const l of lines) {
    assert.ok(!'，。、；：？！'.includes(l[0]), `行首出现标点：${l}`);
  }
});

test('短 URL 展示保留主机名', () => {
  assert.ok(shortenUrl('https://example.com/some/path').startsWith('example.com'));
});

test('从 URL 提取文件名', () => {
  assert.equal(filenameFromUrl('https://example.com/a/b/photo.jpg'), 'photo');
});

test('主机名解析失败返回 unknown', () => {
  assert.equal(safeHost('not a url'), 'unknown');
});
