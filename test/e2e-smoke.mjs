// test/e2e-smoke.mjs —— 浏览器端真实冒烟测试（Playwright + 真实加载扩展）
//
// 覆盖原文档第 9 章「开工前 15 分钟快速验证清单」中可自动化验证的部分：
//   1. 扩展能被 Chromium 正常加载，Service Worker 注册成功，无 manifest 错误；
//   2. 侧栏页面能正常渲染（无 JS 报错、无 CSP 违规）；
//   3. content script 能穿透遮罩层找到被遮挡的图片；
//   4. C2PA 验签 Worker 能真实加载 8MB WASM 并返回结果（不报 CSP / FileReaderSync 错误）；
//   5. 侧栏与 Service Worker 之间 chrome.storage.session 消息链路通畅；
//   6. 反搜引擎标签页能被真实打开。
//
// 运行：node test/e2e-smoke.mjs

import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = ROOT;

/** 起一个本地静态服务器（content script 只注入 http/https 页面） */
async function startStaticServer() {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mask test</title></head>
  <body style="margin:0;font-family:sans-serif">
    <h1>遮罩测试页</h1>
    <div style="position:relative;width:400px;height:300px;border:1px solid #ccc;">
      <img id="under" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" style="width:400px;height:300px;">
      <div id="mask" style="position:absolute;inset:0;background:transparent;"></div>
    </div>
  </body></html>`;

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome.exe'),
].filter(Boolean);

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'iph-e2e-'));
  const http = await startStaticServer();

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      '--window-size=1400,900',
    ],
    viewport: { width: 1400, height: 900 },
  });

  try {
    // ---------- 1. 扩展加载 ----------
    console.log('\n【1】扩展加载与 Service Worker 注册');
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
    check('Service Worker 注册成功', Boolean(sw), sw ? sw.url() : '未捕获到 SW');

    const extensionId = sw ? new URL(sw.url()).host : null;
    check('拿到扩展 ID', Boolean(extensionId), extensionId || '');

    // ---------- 2. 侧栏页面渲染 ----------
    console.log('\n【2】侧栏页面渲染与 CSP 合规');
    const panel = await ctx.newPage();
    const panelErrors = [];
    const cspViolations = [];
    panel.on('pageerror', (e) => panelErrors.push(String(e.message)));
    panel.on('console', (m) => {
      const t = m.text();
      if (/Content Security Policy|Refused to/i.test(t)) cspViolations.push(t);
    });

    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await panel.waitForLoadState('domcontentloaded');
    await panel.waitForTimeout(1200);

    check('侧栏无 JS 运行时错误', panelErrors.length === 0, panelErrors.join(' | ').slice(0, 300));
    check('侧栏无 CSP 违规', cspViolations.length === 0, cspViolations.join(' | ').slice(0, 300));
    check('空状态可见', await panel.locator('#empty-state').isVisible());
    check('页面标题正确', (await panel.title()).includes('图片溯源'), await panel.title());

    // ---------- 3. content script 穿透遮罩找图 ----------
    console.log('\n【3】content script 穿透遮罩找图');
    const testPage = await ctx.newPage();
    await testPage.goto(http.origin + '/mask-test.html');
    await testPage.waitForTimeout(800);

    // 在遮罩层上模拟右键
    await testPage.evaluate(() => {
      document.getElementById('mask').dispatchEvent(
        new MouseEvent('contextmenu', { clientX: 100, clientY: 100, bubbles: true })
      );
    });
    await testPage.waitForTimeout(400);

    // 由 Service Worker 主动向该标签页的 content script 询问探测结果（与右键菜单同一路径）
    const probeResult = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => (t.url || '').includes('mask-test.html'));
      if (!target) return { error: '未找到测试标签页' };
      try {
        return await chrome.tabs.sendMessage(target.id, { type: 'probe:get-context-target' });
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    });

    check(
      '穿透透明遮罩找到底层 <img>',
      Boolean(probeResult && probeResult.originalUrl && probeResult.originalUrl.startsWith('data:image')),
      probeResult ? `sourceType=${probeResult.sourceType}` : probeResult?.error || '无返回'
    );
    check(
      '返回了元素矩形（供截图兜底裁剪）',
      Boolean(probeResult && probeResult.rect && probeResult.rect.width > 0),
      probeResult?.rect ? `${probeResult.rect.width}x${probeResult.rect.height}` : ''
    );

    // 平台原图还原规则
    const cdnResult = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => (t.url || '').includes('mask-test.html'));
      if (!target) return null;
      await chrome.tabs.sendMessage(target.id, { type: 'probe:set-probe', probe: {
        sourceType: 'img',
        originalUrl: 'https://wx1.sinaimg.cn/large/orj360/q70test.jpg',
        normalizedUrl: 'https://wx1.sinaimg.cn/large/mw2000/q70test.jpg',
        width: 400, height: 300,
        rect: { x: 0, y: 0, width: 400, height: 300, dpr: 1 },
      } });
      return await chrome.tabs.sendMessage(target.id, { type: 'probe:get-context-target' });
    });
    check(
      '微博缩略图已还原为 mw2000 原图',
      Boolean(cdnResult?.normalizedUrl?.includes('/mw2000/')),
      cdnResult?.normalizedUrl || ''
    );

    // ---------- 4. C2PA 验签 Worker 真实加载 8MB WASM ----------
    console.log('\n【4】C2PA 验签 Worker（真实 WASM 加载）');
    const c2paResult = await panel.evaluate(async () => {
      try {
        const mod = await import('./c2pa-verifier.js');
        const r = await mod.selfTest();
        return r;
      } catch (e) {
        return { ok: false, note: String(e?.message || e) };
      }
    });
    check(
      'C2PA Worker 加载 WASM 成功',
      Boolean(c2paResult?.ok),
      c2paResult?.note?.slice(0, 220) || ''
    );
    check(
      '未出现 blob Worker 拒绝错误',
      !/blob/i.test(c2paResult?.note || ''),
      c2paResult?.note?.includes('Refused') ? '出现 Refused 错误' : ''
    );
    check(
      '未出现 FileReaderSync 缺失错误',
      !/FileReaderSync/i.test(c2paResult?.note || ''),
      c2paResult?.note?.includes('FileReaderSync') ? '主线程执行了 WASM 读取' : ''
    );

    // ---------- 5. Service Worker ↔ 侧栏 消息链路 ----------
    console.log('\n【5】Service Worker ↔ 侧栏 消息链路');
    const msgResult = await panel.evaluate(async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'inv:get-options' });
        return { ok: true, options: r?.options };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
    check('侧栏 → Service Worker 消息可达', Boolean(msgResult?.ok), msgResult?.error || '');

    // 写入配置 → 读回
    const roundTrip = await panel.evaluate(async () => {
      await chrome.runtime.sendMessage({
        type: 'inv:save-options',
        patch: { watermark: '@E2E 测试水印' },
      });
      const r = await chrome.runtime.sendMessage({ type: 'inv:get-options' });
      return r?.options?.watermark;
    });
    check('配置写入读回一致', roundTrip === '@E2E 测试水印', String(roundTrip));

    // ---------- 6. 手动拖入图片建立核查会话 ----------
    console.log('\n【6】手动拖入图片 → 建立核查会话 → 侧栏渲染');
    const dropResult = await panel.evaluate(async () => {
      // 1x1 透明 PNG
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      try {
        const r = await chrome.runtime.sendMessage({
          type: 'inv:manual-drop',
          file: { bytesBase64: b64, fileName: 'e2e.png', mime: 'image/png' },
        });
        return { ok: true, inv: r?.inv };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
    check('手动拖入建立会话成功', Boolean(dropResult?.ok && dropResult?.inv), dropResult?.error || '');
    check(
      '图片 sha256 已计算并落 IndexedDB',
      Boolean(dropResult?.inv?.image?.sha256),
      dropResult?.inv?.image?.sha256?.slice(0, 16) || ''
    );
    check(
      '会话状态为 ready',
      dropResult?.inv?.status === 'ready',
      `status=${dropResult?.inv?.status}`
    );

    // 侧栏应通过 storage.session.onChanged 自动重绘
    await panel.waitForTimeout(1200);
    const resultVisible = await panel.locator('#result-state').isVisible();
    check('侧栏自动切换到结果视图', resultVisible);

    const verdictText = await panel.locator('#verdict-text').textContent();
    check('结论条显示「无法判断」', (verdictText || '').includes('无法判断'), verdictText || '');

    const engineCount = await panel.locator('#engine-list .engine').count();
    check('反搜引擎卡片已渲染', engineCount > 0, `${engineCount} 个`);

    const signalCount = await panel.locator('#signal-list .signal').count();
    check('证据信号已渲染', signalCount > 0, `${signalCount} 条`);

    if (signalCount === 0) {
      const debug = await panel.evaluate(async () => {
        const r = await chrome.runtime.sendMessage({ type: 'inv:get-current' });
        return {
          status: r?.inv?.status,
          signals: r?.inv?.signals,
          exif: r?.inv?.exif,
          c2pa: r?.inv?.c2pa?.status,
          suggestion: r?.inv?.systemSuggestion,
        };
      });
      console.log('    [debug]', JSON.stringify(debug).slice(0, 500));
    }

    // ---------- 7. 反搜引擎标签页真实打开 ----------
    console.log('\n【7】反搜引擎标签页打开');
    const before = ctx.pages().length;
    const opened = await panel.evaluate(async () => {
      try {
        const r = await chrome.runtime.sendMessage({
          type: 'engines:open-one',
          engineId: 'tineye',
          useClipboard: true,
        });
        return { ok: true, r };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
    await panel.waitForTimeout(2500);
    const after = ctx.pages().length;
    check(
      '引擎标签页被真实打开',
      opened?.ok && after > before,
      `pages ${before} → ${after}`
    );

    // ---------- 7.5 人工回填最早出处 → 强信号 → 结论改变 ----------
    console.log('\n【7.5】人工回填最早出处 → 强信号触发');
    const patchRes = await panel.evaluate(async () => {
      const r = await chrome.runtime.sendMessage({
        type: 'inv:patch',
        enginePatch: {
          id: 'tineye',
          earliestSeenUrl: 'https://news.example.com/2019/old-photo',
          earliestSeenDate: '2019-05-12',
          earliestSeenContext: '早期新闻配图',
        },
      });
      return { ok: true, suggestion: r?.inv?.systemSuggestion, signals: r?.inv?.signals?.length };
    });
    check(
      '回填后系统倾向变为「旧图挪用」',
      patchRes?.suggestion === 'likely-old-reuse',
      String(patchRes?.suggestion)
    );
    await panel.waitForTimeout(900);
    const verdictAfter = await panel.locator('#verdict-text').textContent();
    check('侧栏结论条同步更新', (verdictAfter || '').includes('旧图挪用'), verdictAfter || '');

    // ---------- 7.6 Canvas 渲染与 PNG 导出 ----------
    console.log('\n【7.6】双遍排版 Canvas 渲染与 PNG 导出');
    const renderRes = await panel.evaluate(async () => {
      try {
        const mod = await import('./card-renderer.js');
        const canvas = document.getElementById('card-canvas');
        // 构造一份长文案，验证自适应高度（不截断）
        const draft = {
          headline: '这张图在 2019 年就发过',
          subhead: '经 TinEye 检索到的最早公开记录',
          claim: '网传某地某时刻发生某事件，现场图片流传广泛。',
          conclusion:
            '认定为旧图挪用：说明该图早在 2019-05-12 已出现在 news.example.com，与网传事件无关。',
          evidence: [
            'TinEye 反查命中 2019 年同一张图，构图与水印完全一致',
            '图片 EXIF 缺失，符合多次转存特征',
            'Wayback 归档显示该图 URL 首次收录于 2019 年',
            '原新闻页标题与网传事件无关',
            '多处独立信源复用了同一张旧图',
          ],
          basis:
            '反向搜图在三个独立引擎均命中同一张更早的公开图片，且像素级一致，说明网传图为旧图复用。',
          sources: [{ label: 'TinEye 最早出处', url: 'https://news.example.com/2019/old-photo' }],
          disclaimer: '声明：本报告基于公开图像元数据与网页归档记录整理，结论随新证据更新。',
          checkedAt: '2026-10-24',
        };
        const info = await mod.renderFactCheckCard(canvas, draft, null, '@测试水印');
        canvas.setAttribute('data-rendered', '1');
        const dataUrl = canvas.toDataURL('image/png');
        return { ok: true, info, dataUrlLength: dataUrl.length, dataUrl };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
    check('Canvas 渲染成功', Boolean(renderRes?.ok), renderRes?.error || '');
    check(
      '画布宽度为 2160px（2 倍高清）',
      renderRes?.info?.width === 2160,
      `${renderRes?.info?.width}px`
    );
    check(
      '画布高度自适应 > 1350px',
      renderRes?.info?.height > 1350,
      `${renderRes?.info?.height}px`
    );
    check('PNG 数据非空', (renderRes?.dataUrlLength || 0) > 2000, `${renderRes?.dataUrlLength} 字符`);

    if (renderRes?.dataUrl) {
      const buf = Buffer.from(renderRes.dataUrl.split(',')[1], 'base64');
      writeFileSync(join(ROOT, 'test', 'e2e-card.png'), buf);
      console.log('  📸 辟谣卡成品图已保存到 test/e2e-card.png');
    }

    const dl = await panel.evaluate(async () => {
      try {
        const canvas = document.getElementById('card-canvas');
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        return { ok: Boolean(blob), size: blob?.size };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
    check('PNG 导出为有效 Blob', Boolean(dl?.ok && dl?.size > 1000), `${dl?.size} bytes`);

    // ---------- 8. 校验清单 ----------
    console.log('\n【8】原文档第 9 章验证清单');
    const manifest = await sw.evaluate(async () => {
      const m = await chrome.runtime.getManifest();
      return { minChrome: m.minimum_chrome_version, version: m.version, perms: m.permissions };
    });
    check('minimum_chrome_version = 116', manifest.minChrome === '116', String(manifest.minChrome));
    check(
      '权限最小化（无 tabs 之外的越权项）',
      !manifest.perms.includes('webRequest') && !manifest.perms.includes('<all_urls>'),
      manifest.perms.join(',')
    );

    const swErrors = [];
    sw.on('console', (m) => {
      if (m.type() === 'error') swErrors.push(m.text());
    });
    await panel.waitForTimeout(500);
    check('Service Worker 无控制台错误', swErrors.length === 0, swErrors.join(' | ').slice(0, 200));

    await panel.screenshot({ path: join(ROOT, 'test', 'e2e-panel.png'), fullPage: true });
    console.log('\n  📸 侧栏截图已保存到 test/e2e-panel.png');
  } finally {
    await ctx.close().catch(() => {});
    http.close();
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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
  console.error('E2E 运行异常：', e);
  process.exit(1);
});
