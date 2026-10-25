// test/c2pa-wasm.test.mjs —— 验证 C2PA WASM 二进制可编译、可实例化
//
// 背景（对原文档 v1.0 的关键修正）：
//   C2PA 的 WASM 绑定在读取 Blob 时依赖 FileReaderSync，该 API 只存在于
//   WorkerGlobalScope，主线程不可用。因此验签必须跑在扩展内的真实 Worker 里
//   （见 sidepanel/c2pa-worker.js），不能用 c2pa-web 的 blob: Worker
//   （MV3 CSP worker-src 'self' 不允许 blob:）。
//
//   Node 环境没有 FileReaderSync，无法复现完整验签链路，
//   因此本测试聚焦「供应链完整性 + WASM 可编译 + 胶水自洽」这三项，
//   浏览器端的完整验签由 sidepanel/c2pa-verifier.js 的 selfTest() 覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WASM_PATH = join(ROOT, 'vendor', 'c2pa_bg.wasm');
const GLUE_PATH = join(ROOT, 'vendor', 'c2pa.wasm.js');

test('C2PA WASM 二进制可被 WebAssembly 编译', async () => {
  const bytes = readFileSync(WASM_PATH);
  assert.ok(bytes.length > 1_000_000, 'WASM 体积异常，可能未正确 vendor');

  const module = await WebAssembly.compile(bytes);
  assert.ok(module instanceof WebAssembly.Module);

  // 校验导出数量合理（wasm-bindgen 胶水需要一批导出）
  const exports = WebAssembly.Module.exports(module);
  assert.ok(exports.length > 10, `导出数量异常：${exports.length}`);
});

test('C2PA WASM 胶水的 SRI 与实际二进制一致（供应链完整性）', async () => {
  const glue = readFileSync(GLUE_PATH, 'utf8');
  const m = glue.match(/WASM_SRI\s*=\s*"sha512-([A-Za-z0-9+/=]+)"/);
  assert.ok(m, '胶水中未找到 WASM_SRI');

  const bytes = readFileSync(WASM_PATH);
  const digest = await crypto.subtle.digest('SHA-512', bytes);
  const b64 = Buffer.from(digest).toString('base64');
  assert.equal(b64, m[1], 'WASM 二进制与官方 SRI 不匹配，vendor 过程中可能损坏');
});

test('C2PA 胶水可作为 ESM 导入并暴露所需 API', async () => {
  const mod = await import(pathToFileURL(GLUE_PATH).href);
  assert.equal(typeof mod.default, 'function', '应导出默认初始化函数');
  assert.equal(typeof mod.WasmReader, 'function', '应导出 WasmReader 类');
  assert.equal(typeof mod.WasmBuilder, 'function', '应导出 WasmBuilder 类');
  assert.ok(mod.WASM_SRI, '应导出 WASM_SRI 常量');
});

test('C2PA 胶水可在主线程完成 WASM 实例化（编译期可行）', async () => {
  const mod = await import(pathToFileURL(GLUE_PATH).href);
  const bytes = readFileSync(WASM_PATH);
  // 传字节而非路径，避免依赖 fetch
  await mod.default({ module_or_path: new Uint8Array(bytes) });
  // 初始化后再次调用应直接返回，不抛错
  await mod.default({ module_or_path: new Uint8Array(bytes) });
});
