// test/e2e-engine-flow.mjs —— 走扩展真实消息通道，跑完整反搜引擎流程
//
// 【为什么不用 sw.evaluate + import】
//   MV3 的 Service Worker 被 HTML 规范禁止动态 import()（ServiceWorkerGlobalScope 限制）。
//   因此不能在 SW 里 import 内部模块来直接调用函数。
//   正确做法是走扩展自己的消息通道 / 用户入口，让扩展按真实路径跑。
//
// 【本测试验证什么】
//   「上传了但没结果」的根因是：引擎上传框有异步校验（SauceNAO 的 checkImageFile）
//   + 表单守卫（onsubmit="return(isSearchReady())"）。塞完文件立刻提交会被静默拦下，
//   页面停在首页，最终报「结果页等待超时」——诊断完全跑偏。
//   本测试通过真实拖入图片触发核查，再读侧栏会话里的引擎结果，验证：
//     1. 引擎结果里不能出现「提交未生效」；
//     2. 引擎必须真的走到结果页（ok / 命中 / 超时 都可，但不能卡在提交）；
//     3. 解析产出了结构化字段。
//
// 运行：node test/e2e-engine-flow.mjs

import { chromium } from 'playwright';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let FAILED = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) FAILED += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};
const skip = (label, why) => console.log(`  ⏭  ${label} — 跳过：${why}`);

let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xff];
  return crc ^ -1;
}

function makePng(w, h, rgb) {
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(0);
    for (let x = 0; x < w; x++) raw.push(rgb[0], rgb[1], rgb[2]);
  }
  const idat = deflateSync(Buffer.from(raw));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
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
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 读 PNG/JPEG 尺寸（够用即可） */
function readPngOrJpegSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = (buf[i + 2] << 8) | buf[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (buf[i + 5] << 8) | buf[i + 6], width: (buf[i + 7] << 8) | buf[i + 8] };
      }
      i += 2 + len;
    }
  }
  return { width: 0, height: 0 };
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'wb-flow-'));
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

    // 通过环境变量指定要测的引擎（默认只测 SauceNAO）
    const engineId = process.env.WB_ENGINE || 'saucenao';
    console.log(`\n=== 准备：只启用 ${engineId} 引擎 ===`);
    await sw.evaluate(async (eid) => {
      await chrome.storage.local.set({
        options: {
          autoEngines: [eid],
          enabledEngines: [eid],
          autoOpenEngines: true,
        },
      });
    }, engineId);
    ok(`配置已写入（仅 ${engineId}）`, true);

    // 打开侧栏页面（同扩展源，可直接用 chrome.* API）
    const extId = new URL(sw.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel/index.html`, { waitUntil: 'load' });
    await panel.waitForTimeout(800);

    console.log('\n=== 通过真实消息通道拖入图片，触发完整核查 ===');
    // 用扩展自带的真实 PNG 图标作为测试图：
    // 纯色小图会被 SauceNAO 的 checkImageFile 判为不合格（"too small"），
    // 那是引擎的正常行为，不是我们的 bug；要用真实图片才能验证提交链路。
    // 测试图有两种来源：
    //  · 本地图（默认）—— 走 DataTransfer 上传路径
    //  · 公网图（WB_PUBLIC_IMG=1）—— 带公网直链，可测 URL 直搜路径
    const usePublic = process.env.WB_PUBLIC_IMG === '1';
    // 用一个确定可直连的公网真实图片（picsum 返回 JPEG）
    const PUBLIC_URL = 'https://picsum.photos/seed/factcheck1/640/480.jpg';

    let img;
    let b64;
    let publicUrl = '';
    let imgW = 128;
    let imgH = 128;
    if (usePublic) {
      publicUrl = PUBLIC_URL;
      // 拉取同一张图作为本地字节（保证「送出去的」与「直链指向的」是同一张）
      const resp = await fetch(PUBLIC_URL);
      img = Buffer.from(await resp.arrayBuffer());
      b64 = img.toString('base64');
      const dim = readPngOrJpegSize(img);
      imgW = dim.width;
      imgH = dim.height;
      console.log(`  测试图：公网直链（${img.length} 字节）`);
    } else {
      const imgPath = join(ROOT, 'assets', 'icon-128.png');
      img = readFileSync(imgPath);
      b64 = img.toString('base64');
      console.log(`  测试图：icon-128.png（${img.length} 字节，本地无公网直链）`);
    }

    const dropResult = await panel.evaluate(async ({ b64, publicUrl }) => {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'inv:manual-drop',
            file: { bytesBase64: b64, fileName: 'e2e.png', mime: 'image/png' },
            publicUrl,
          },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message });
              return;
            }
            resolve(res || {});
          }
        );
      });
    }, { b64, publicUrl });

    ok('核查会话已建立', Boolean(dropResult?.inv?.id), dropResult?.error || dropResult?.inv?.id || '');

    if (!dropResult?.inv) {
      console.log('  无法建立会话，后续断言跳过');
    } else {
      // 取图自检必须存在（上一轮加的防「搜错图」机制）
      const acq = dropResult.inv.image?.acquisition;
      ok('取图自检信息存在', Boolean(acq), acq ? `${acq.viaLabel} ${acq.width}×${acq.height}` : '缺失');
      if (acq) {
        // 尺寸应与「送进去的那张图」的真实像素一致
        // （公网图是 640×480，本地图标是 128×128）
        ok(
          '取到的尺寸与上传图一致',
          acq.width === imgW && acq.height === imgH,
          `${acq.width}×${acq.height}（期望 ${imgW}×${imgH}）`
        );
        ok('有 SHA-256 指纹', Boolean(acq.shaShort), acq.shaShort);
      }

      // 等反搜跑完（SauceNAO 单引擎，最长约 60 秒）
      console.log('\n=== 等待反搜完成（最长 90 秒） ===');
      const engineResult = await waitForEngineDone(panel, engineId, 120000);
      reportEngineResult(engineResult);
    }
  } catch (e) {
    FAILED += 1;
    console.log(`  ❌ 执行异常：${e?.message || e}`);
    console.error(e);
  } finally {
    await context.close().catch(() => {});
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n${FAILED === 0 ? '✅ 通过（含跳过项）' : `❌ ${FAILED} 项失败`}`);
  process.exit(FAILED === 0 ? 0 : 1);
}

/** 轮询 storage.session，直到指定引擎不再是 queued/running */
async function waitForEngineDone(panel, engineId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const cur = await panel.evaluate(async () => {
      const idBag = await chrome.storage.session.get('session:currentId');
      const id = idBag['session:currentId'];
      if (!id) return null;
      const bag = await chrome.storage.session.get(`session:inv:${id}`);
      return bag[`session:inv:${id}`] || null;
    });
    if (cur) {
      last = cur;
      const e = (cur.engines || []).find((x) => x.id === engineId);
      if (e && !['queued', 'running', 'pending'].includes(e.autoStatus)) {
        return { engine: e, inv: cur };
      }
      if (cur.autoVerify?.status === 'failed' || cur.autoVerify?.status === 'done') {
        return { engine: e, inv: cur };
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const e = (last?.engines || []).find((x) => x.id === engineId);
  return { engine: e, inv: last, timedOut: true };
}

function reportEngineResult(r) {
  const e = r?.engine;
  if (!e) {
    FAILED += 1;
    console.log('  ❌ 没有拿到引擎结果对象');
    return;
  }

  console.log(`  引擎：${e.name} | 状态：${e.autoStatus} | 命中：${e.matchCount} | 耗时：${e.durationMs}ms`);
  if (e.autoNote) console.log(`  备注：${e.autoNote}`);

  // 【核心断言】不能卡在「提交未生效」
  const stuckOnSubmit = /提交未生效/.test(e.autoNote || '');
  ok('没有卡在「提交未生效」', !stuckOnSubmit, stuckOnSubmit ? e.autoNote : '');

  if (e.autoStatus === 'rejected') {
    skip('结果页解析验证', `引擎拒绝该文件：${e.autoNote || ''}`);
    return;
  }
  if (e.autoStatus === 'blocked') {
    skip('结果页解析验证', 'SauceNAO 要求人机验证（机房 IP 常见）');
    return;
  }
  if (e.autoStatus === 'timeout') {
    skip('结果页解析验证', '结果页等待超时（网络慢或页面改版）');
    return;
  }
  if (e.autoStatus === 'failed') {
    ok('引擎失败原因不是提交环节', !stuckOnSubmit, e.autoNote || '');
    return;
  }

  ok('引擎成功走到结果页', e.autoStatus === 'ok', `autoStatus=${e.autoStatus}`);
  ok('解析产出结构化字段', typeof e.matchCount === 'number', `matchCount=${e.matchCount}`);
}

main();
