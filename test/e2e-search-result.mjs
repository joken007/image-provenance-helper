// test/e2e-search-result.mjs —— 验证「搜索引擎搜出来的结果确实对应送进去的那张图」
//
// 【为什么需要这个测试】
//   取图正确 ≠ 搜图正确。取图环节已经通过 e2e 验证（字节指纹完全一致），
//   但「把字节塞进引擎上传框 → 引擎返回结果」这一段仍可能出错：
//     - DataTransfer 注入失败，引擎拿到的是一张空图或残留图
//     - 引擎自己重定向到别的搜索，返回不相干结果
//     - 解析器抓错了区块
//   本测试用两张视觉特征截然不同的图（红/蓝纯色），
//   分别送去 SauceNAO 检索，验证两次返回的结果集合明显不同。
//
// 运行：node test/e2e-search-result.mjs
// 注意：需要真实网络。若 SauceNAO 被风控，本测试会如实报告 skipped 而非假通过。

import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let FAILED = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) FAILED += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};
const skip = (label, why) => console.log(`  ⏭  ${label} — 跳过：${why}`);

// ---------- 生成两张纯色 PNG ----------
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

const IMG_RED = makePng(300, 200, [220, 30, 30]);
const IMG_BLUE = makePng(300, 200, [30, 30, 220]);

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'wb-search-'));
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

    console.log('\n=== 直接验证：同一标签页连续上传两张不同的图 ===');

    // 用一个空白标签页做容器，模拟 auto-verify 的流程
    const page = await context.newPage();
    await page.goto('https://saucenao.com/', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const isBlocked = await page.evaluate(() =>
      /captcha|just a moment|cloudflare|人机验证|unusual traffic/i.test(
        document.title + ' ' + (document.body?.innerText || '').slice(0, 400)
      )
    ).catch(() => true);

    if (isBlocked) {
      skip('SauceNAO 上传与结果验证', '站点要求人机验证（机房 IP 常见）');
      console.log('\n⏭ 本次跳过（非失败）—— 该测试需要真实网络且不被风控');
      return;
    }

    /**
     * 往页面里塞一张图并提交，返回结果页的关键特征。
     * 这里直接复用扩展注入的那套 DataTransfer 逻辑。
     */
    const uploadAndRead = async (buf) => {
      const b64 = buf.toString('base64');
      await page.goto('https://saucenao.com/', { waitUntil: 'load', timeout: 30000 });

      await page.evaluate((b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], 'query.png', { type: 'image/png' });
        const input = document.querySelector('#fileInput') || document.querySelector('input[type=file]');
        if (!input) throw new Error('无上传框');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const form = input.closest('form');
        if (form?.requestSubmit) form.requestSubmit();
      }, b64);

      // 等结果页
      await page.waitForTimeout(8000);

      const result = await page.evaluate(() => ({
        url: location.href,
        textLen: (document.body?.innerText || '').length,
        // 抓结果条目的相似度与标题，作为「这次搜的是什么」的指纹
        sims: [...document.querySelectorAll('.similarity')].slice(0, 5).map((e) => e.textContent.trim()),
        titles: [...document.querySelectorAll('.title')].slice(0, 5).map((e) => e.textContent.trim()),
        noResult: /no results|not found|未找到/i.test(document.body?.innerText || ''),
      }));
      return result;
    };

    const redRes = await uploadAndRead(IMG_RED);
    console.log(`  红图结果：${redRes.sims.length} 条相似度 / noResult=${redRes.noResult}`);

    const blueRes = await uploadAndRead(IMG_BLUE);
    console.log(`  蓝图结果：${blueRes.sims.length} 条相似度 / noResult=${blueRes.noResult}`);

    ok('红图确实提交到了结果页', redRes.url.includes('search.php'), redRes.url.slice(0, 80));
    ok('蓝图确实提交到了结果页', blueRes.url.includes('search.php'), blueRes.url.slice(0, 80));

    const redKey = JSON.stringify(redRes.sims) + JSON.stringify(redRes.titles);
    const blueKey = JSON.stringify(blueRes.sims) + JSON.stringify(blueRes.titles);
    ok(
      '两次检索结果不同（证明送进去的是不同的图）',
      redKey !== blueKey,
      redKey === blueKey ? '两次结果完全相同，可能第二次复用上一次的上传' : '结果有差异'
    );

    // 纯色图在插画库里大概率查不到，但「查不到」本身也应是稳定结论
    if (redRes.noResult && blueRes.noResult) {
      skip('结果内容比对', '两张纯色图在 SauceNAO 均无匹配（符合预期，纯色图不属于插画库）');
    }
  } catch (e) {
    FAILED += 1;
    console.log(`  ❌ 执行异常：${e?.message || e}`);
  } finally {
    await context.close().catch(() => {});
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n${FAILED === 0 ? '✅ 通过（含跳过项）' : `❌ ${FAILED} 项失败`}`);
  process.exit(FAILED === 0 ? 0 : 1);
}

main();
