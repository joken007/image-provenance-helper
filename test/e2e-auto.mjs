// test/e2e-auto.mjs —— 全自动反搜专项端到端验证
//
// 只验证用户最在意的三件事：
//   1. 全程零人工：不写剪贴板、不需要 Ctrl+V、不需要人读结果；
//   2. 反搜在后台真实跑通，结果自动写入（有 matchCount / 站点 / 日期）；
//   3. 所有临时标签页跑完自动关闭，浏览器里不残留任何窗口。
//
// 运行：node test/e2e-auto.mjs

import { chromium } from 'playwright';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = ROOT;

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 生成一张真实的渐变 PNG（避免依赖外网图片） */
function makeTestPng(w = 640, h = 480) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      raw[p++] = (x * 255) / w;
      raw[p++] = (y * 255) / h;
      raw[p++] = 128;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'iph-auto-'));
  const png = makeTestPng();
  const b64 = png.toString('base64');
  console.log(`测试图片：${(png.length / 1024).toFixed(0)} KB PNG\n`);

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1400,900',
    ],
    viewport: { width: 1400, height: 900 },
  });

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
    check('扩展加载成功', Boolean(sw));
    const extId = new URL(sw.url()).host;

    // 只启用 SauceNAO，缩短测试时长（其余引擎逻辑同构）
    await sw.evaluate(async () => {
      await chrome.storage.local.set({
        options: { autoEngines: ['saucenao'], enabledEngines: ['saucenao'], autoOpenEngines: false },
      });
    });
    check('配置为仅 SauceNAO（缩短测试时长）', true);

    const panel = await ctx.newPage();
    const panelErrors = [];
    panel.on('pageerror', (e) => panelErrors.push(String(e.message)));
    await panel.goto(`chrome-extension://${extId}/sidepanel/index.html`);
    await panel.waitForLoadState('domcontentloaded');
    await panel.waitForTimeout(800);

    // 记录基线标签页数（侧栏自身算 1）
    const baselinePages = ctx.pages().length;

    console.log('\n【核心】触发核查 → 观察是否全自动');
    const t0 = Date.now();

    // 触发核查（模拟用户拖入图片，之后全程不再有任何人工动作）
    const dropRes = await panel.evaluate(async (b64) => {
      const r = await chrome.runtime.sendMessage({
        type: 'inv:manual-drop',
        file: { bytesBase64: b64, fileName: 'auto-test.png', mime: 'image/png' },
      });
      return { ok: r?.ok, id: r?.inv?.id, engineCount: r?.inv?.engines?.length };
    }, b64);
    check('核查已启动', Boolean(dropRes?.ok), `会话 ${dropRes?.id || '?'}`);
    check('引擎占位卡片已建立', (dropRes?.engineCount || 0) >= 1, `${dropRes?.engineCount} 个`);

    // 轮询等待自动反搜完成
    let finalInv = null;
    let sawRunning = false;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await panel.waitForTimeout(2000);
      const cur = await panel.evaluate(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'inv:get-current' });
        return r?.inv || null;
      });
      if (!cur) continue;
      if (cur.autoVerify?.status === 'running') sawRunning = true;
      if (cur.autoVerify?.status === 'done' || cur.autoVerify?.status === 'failed') {
        finalInv = cur;
        break;
      }
    }

    check('反搜确实在后台自动运行过', sawRunning);
    check('自动反搜已结束', Boolean(finalInv), finalInv?.autoVerify?.status || '超时未结束');
    console.log(`    耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (finalInv) {
      const engines = finalInv.engines || [];
      const okEngines = engines.filter((e) => e.autoStatus === 'ok');
      const withResult = engines.filter((e) => (e.matchCount || 0) > 0);

      check('至少一个引擎自动返回结果', okEngines.length > 0,
        engines.map((e) => `${e.name}:${e.autoStatus}(${e.matchCount || 0})`).join(' '));

      if (withResult.length) {
        const e0 = withResult[0];
        check('结果被自动写入（无需人工回填）', (e0.matchCount || 0) > 0, `${e0.name} 命中 ${e0.matchCount} 条`);
        check('自动提取了站点列表', (e0.distinctHosts || []).length > 0,
          (e0.distinctHosts || []).slice(0, 4).join(', '));
        console.log(`    自动提取线索：日期=${e0.earliestSeenDate || '(未提取到)'} 链接=${(e0.earliestSeenUrl || '').slice(0, 60) || '(无)'}`);
      } else {
        const notes = engines.map((e) => `${e.name}=${e.autoStatus}:${(e.autoNote || '').slice(0, 40)}`).join(' | ');
        console.log(`    ⚠ 本次无引擎返回结果（环境原因）：${notes}`);
        check('无结果时状态被如实标记（未编造数据）',
          engines.every((e) => ['blocked', 'timeout', 'failed', 'skipped'].includes(e.autoStatus)),
          notes.slice(0, 160));
      }

      check('自动信号已参与评分', Array.isArray(finalInv.signals) && finalInv.signals.length > 0,
        `${finalInv.signals?.length || 0} 条信号`);
    }

    // 最关键：临时标签页是否全部关闭
    console.log('\n【关键】临时页面是否自动关闭');
    await panel.waitForTimeout(1500);
    const finalPages = ctx.pages().length;
    check('所有临时标签页已自动关闭', finalPages <= baselinePages,
      `基线 ${baselinePages} → 结束 ${finalPages}`);

    const leftover = ctx.pages()
      .map((p) => p.url())
      .filter((u) => u && u !== 'about:blank' && !u.startsWith('chrome-extension://'));
    check('浏览器里没有残留引擎页面', leftover.length === 0, leftover.slice(0, 3).join(' | ') || '无残留');

    // 零人工验证：剪贴板横幅必须隐藏
    console.log('\n【关键】是否仍需人工操作');
    const clipVisible = await panel.locator('#clipboard-banner').isVisible().catch(() => false);
    check('不再提示「复制到剪贴板 + Ctrl+V」', !clipVisible);
    const pasteHints = await panel.evaluate(() => /Ctrl\+V|粘贴图片到|复制到剪贴板/.test(document.body.innerText));
    check('页面无任何要求用户粘贴的提示', !pasteHints);

    check('侧栏无 JS 运行时错误', panelErrors.length === 0, panelErrors.join(' | ').slice(0, 200));

    await panel.screenshot({ path: join(ROOT, 'test', 'e2e-auto.png'), fullPage: true });
    console.log('\n  📸 截图已保存到 test/e2e-auto.png');
  } finally {
    await ctx.close().catch(() => {});
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`  通过 ${results.length - failed} / ${results.length}`);
  if (failed) {
    console.log('  失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`    · ${r.name} — ${r.detail}`));
  }
  console.log('─'.repeat(56));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 异常：', e);
  process.exit(1);
});
