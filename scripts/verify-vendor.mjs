#!/usr/bin/env node
// scripts/verify-vendor.mjs —— 校验 vendor/ 产物的完整性与一致性
//
// 【为什么需要它】
//   vendor/ 里的 exifr 与 C2PA WASM 是由 scripts/vendor.mjs 从 npm 复制进来的，
//   属于「构建产物入库」。一旦有人手动改动、或 npm 包被替换，
//   插件会在用户端静默出错（WASM 加载失败、EXIF 解析异常），排查成本很高。
//
//   这个脚本把校验固化成一条命令，CI 与本地都能跑：
//     node scripts/verify-vendor.mjs
//
// 【校验三件事】
//   1. 四个 vendor 文件是否齐全，且非空
//   2. c2pa_bg.wasm 的 SHA-512 是否与 vendor/c2pa.sri.txt 记录一致
//   3. vendor/c2pa.wasm.js 里内嵌的 WASM_SRI 常量是否与上面两者一致
//
// 退出码：0 全部通过；1 有任一失败（CI 会据此判定失败）

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const REQUIRED = [
  'vendor/exifr.full.esm.mjs',
  'vendor/c2pa.wasm.js',
  'vendor/c2pa_bg.wasm',
  'vendor/c2pa.sri.txt',
];

let failed = 0;

function ok(msg) {
  console.log(`  ✅ ${msg}`);
}
function bad(msg) {
  console.log(`  ❌ ${msg}`);
  failed++;
}
function info(msg) {
  console.log(`     ${msg}`);
}

console.log('vendor 产物完整性校验\n');

// ---------- 1. 文件存在性 ----------
console.log('[1/3] 文件齐全性');
for (const rel of REQUIRED) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    bad(`${rel} 缺失`);
    continue;
  }
  const size = statSync(abs).size;
  if (size === 0) {
    bad(`${rel} 是空文件`);
    continue;
  }
  ok(`${rel}  ${(size / 1024).toFixed(1)} KB`);
}

if (failed) {
  console.log('\n文件不全，后续校验跳过。请先运行：npm install');
  process.exit(1);
}

// ---------- 2. WASM 与 SRI 记录比对 ----------
console.log('\n[2/3] WASM SHA-512 与 c2pa.sri.txt 比对');

const wasmPath = join(ROOT, 'vendor/c2pa_bg.wasm');
// SRI 基线优先读仓库内的 scripts/c2pa.sri.txt（入库，作为可信基准），
// 回落到 vendor/c2pa.sri.txt（npm install 生成的副本）。
// 这样即便 vendor 未生成，也能用仓库里的基准校验。
const sriCandidates = [join(ROOT, 'scripts/c2pa.sri.txt'), join(ROOT, 'vendor/c2pa.sri.txt')];
const sriPath = sriCandidates.find((p) => existsSync(p));

// actual / sriExpected 提到外层：第 3 步（比对 c2pa.wasm.js 内嵌常量）也要用
let actual = '';
let sriExpected = '';

if (!sriPath) {
  bad('找不到 SRI 基线（scripts/c2pa.sri.txt 或 vendor/c2pa.sri.txt）');
} else {
  const wasmBytes = readFileSync(wasmPath);
  actual = createHash('sha512').update(wasmBytes).digest('base64');

  // c2pa.sri.txt 形如：sha512-<base64>
  const sriRaw = readFileSync(sriPath, 'utf8').trim();
  sriExpected = sriRaw.replace(/^sha512-/, '');

  if (!sriExpected) {
    bad('c2pa.sri.txt 内容为空');
  } else if (actual !== sriExpected) {
    bad('WASM 实际哈希与 SRI 基线不一致，文件可能被替换或损坏');
    info(`记录值：${sriExpected.slice(0, 32)}…`);
    info(`实际值：${actual.slice(0, 32)}…`);
  } else {
    ok('WASM 哈希与 SRI 基线一致');
    info(`sha512-${actual.slice(0, 32)}…`);
  }
}

// ---------- 3. c2pa.wasm.js 内嵌常量比对 ----------
console.log('\n[3/3] c2pa.wasm.js 内嵌 WASM_SRI 常量比对');

const glue = readFileSync(join(ROOT, 'vendor/c2pa.wasm.js'), 'utf8');
const m = glue.match(/WASM_SRI\s*=\s*"sha512-([A-Za-z0-9+/=]+)"/);

if (!m) {
  bad('未能在 c2pa.wasm.js 中找到 WASM_SRI 常量');
} else if (m[1] !== actual) {
  bad('c2pa.wasm.js 内嵌的 WASM_SRI 与真实 WASM 不一致（绑定层与二进制不匹配）');
  info(`内嵌值：${m[1].slice(0, 32)}…`);
  info(`实际值：${actual.slice(0, 32)}…`);
} else if (sriExpected && m[1] !== sriExpected) {
  bad('c2pa.wasm.js 内嵌的 WASM_SRI 与 c2pa.sri.txt 不一致');
} else {
  ok('绑定层内嵌常量与二进制、SRI 记录三方一致');
}

// ---------- 汇总 ----------
console.log('\n' + '─'.repeat(52));
if (failed) {
  console.log(`  ❌ 校验失败：${failed} 项`);
  console.log('     修复方式：npm run vendor（或 npm install）重新生成 vendor/');
  process.exit(1);
}
console.log('  ✅ 全部通过：vendor 产物完整且未被篡改');
console.log('─'.repeat(52));
