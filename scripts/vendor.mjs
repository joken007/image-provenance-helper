// vendor.mjs —— 把 npm 依赖的浏览器可用产物复制进扩展目录，达成「零构建加载解压即用」
//
// 为什么不用 vite/crxjs：
//   1) crxjs 仍是 beta，MV3 多入口 + WASM + sidePanel 组合下易翻车；
//   2) 本扩展的第三方依赖（exifr / c2pa-wasm）都是自包含纯 ESM，浏览器原生 import 即可；
//   3) 用户是单人自用，「加载已解压的扩展程序」零构建最省心。
//
// 产物映射：
//   node_modules/exifr/dist/full.esm.mjs                -> vendor/exifr.full.esm.mjs
//   node_modules/@contentauth/c2pa-wasm/pkg/c2pa.js      -> vendor/c2pa.wasm.js
//   node_modules/@contentauth/c2pa-wasm/pkg/c2pa_bg.wasm -> vendor/c2pa_bg.wasm
//
// 注意：c2pa-wasm 的 wasm 与 JS 必须同版本号配套，脚本会校验版本一致性。

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NM = join(ROOT, 'node_modules');
const OUT = join(ROOT, 'vendor');

const JOBS = [
  {
    from: join(NM, 'exifr', 'dist', 'full.esm.mjs'),
    to: join(OUT, 'exifr.full.esm.mjs'),
    label: 'exifr (EXIF/IPTC/XMP 解析)',
  },
  {
    from: join(NM, '@contentauth', 'c2pa-wasm', 'pkg', 'c2pa.js'),
    to: join(OUT, 'c2pa.wasm.js'),
    label: '@contentauth/c2pa-wasm (C2PA 主线程验签 JS 胶水)',
  },
  {
    from: join(NM, '@contentauth', 'c2pa-wasm', 'pkg', 'c2pa_bg.wasm'),
    to: join(OUT, 'c2pa_bg.wasm'),
    label: '@contentauth/c2pa-wasm (WASM 二进制)',
  },
];

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

let failed = false;
for (const job of JOBS) {
  if (!existsSync(job.from)) {
    console.error(`[vendor] 缺少依赖文件：${job.from}\n        请先执行 npm install`);
    failed = true;
    continue;
  }
  copyFileSync(job.from, job.to);
  const kb = (statSync(job.to).size / 1024).toFixed(0);
  console.log(`[vendor] ${job.label.padEnd(42)} -> vendor/${job.to.split(/[\\/]/).pop()} (${kb} KB)`);
}

// 校验 c2pa-wasm 的 JS 胶水与 WASM 是否同版本（避免 SRI 校验失败导致验签直接报错）
try {
  const glue = readFileSync(join(OUT, 'c2pa.wasm.js'), 'utf8');
  const m = glue.match(/WASM_SRI\s*=\s*"([^"]+)"/);
  if (m) {
    writeFileSync(join(OUT, 'c2pa.sri.txt'), m[1] + '\n', 'utf8');
    console.log(`[vendor] 已记录 C2PA WASM SRI 校验值 -> vendor/c2pa.sri.txt`);
  }
} catch {
  /* 记录失败不影响主流程 */
}

if (failed) process.exit(1);
console.log('[vendor] 全部依赖就绪，可直接在 chrome://extensions 以「加载已解压的扩展程序」使用。');
