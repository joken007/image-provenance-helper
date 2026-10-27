// scripts/make-release.mjs —— 打包「可直接加载」的完整扩展
//
// 【为什么需要这个】
//   仓库里的 vendor/ 是 npm install 生成的，不入库（8MB WASM）。
//   所以从 GitHub 克隆的人必须先跑 npm install —— 在受限网络下会失败。
//   打包一份【已含 vendor 的完整扩展】放到 Release 附件里，
//   用户就能：下载 → 解压 → chrome://extensions 加载已解压的扩展程序。
//   这才是「零构建、加载解压即用」这句话真正兑现的方式。
//
// 用法：
//   node scripts/make-release.mjs            # 生成到 dist/
//   node scripts/make-release.mjs --check    # 只校验不打包
//
// 打包前会跑一次 vendor 完整性校验 —— 防止把残缺/被篡改的产物发出去。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const ONLY_CHECK = process.argv.includes('--check');

/** 要打包进扩展的文件（与 manifest 实际加载的保持一致） */
const INCLUDE_DIRS = ['background', 'content', 'sidepanel', 'options', 'lib', 'assets', 'vendor'];
const INCLUDE_FILES = ['manifest.json'];
/** 排除的文件与目录 */
const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'scripts', 'test', 'docs', '.github']);

function log(msg) {
  console.log(`  ${msg}`);
}

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') && name !== '.gitattributes') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE.has(name)) continue;
      walk(full, base, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function main() {
  console.log('\n=== 打包前检查 ===');

  // 1) manifest 必须存在且合法
  const manifestPath = join(ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('  ❌ 缺少 manifest.json');
    process.exit(1);
  }
  try {
    JSON.parse(readFileSync(manifestPath, 'utf8'));
    log('✅ manifest.json 合法');
  } catch (e) {
    console.error(`  ❌ manifest.json 解析失败：${e.message}`);
    process.exit(1);
  }

  // 2) vendor 完整性（跑项目自带的校验脚本）
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'verify-vendor.mjs')], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    log('✅ vendor 产物完整（SHA-512 三方比对通过）');
  } catch (e) {
    console.error('  ❌ vendor 校验失败：');
    console.error((e.stdout || '') + (e.stderr || ''));
    console.error('     请先跑 npm install（postinstall 会生成 vendor）');
    process.exit(1);
  }

  // 3) 收集文件
  const files = [];
  for (const d of INCLUDE_DIRS) {
    files.push(...walk(join(ROOT, d)));
  }
  for (const f of INCLUDE_FILES) {
    const p = join(ROOT, f);
    if (existsSync(p)) files.push(p);
  }
  log(`✅ 收集到 ${files.length} 个文件`);

  if (ONLY_CHECK) {
    console.log('\n✅ 检查通过（--check 模式未打包）\n');
    return;
  }

  // 4) 生成 zip
  // Node 没有内置 zip，这里用系统 zip（Windows 10+ 自带 tar 也可，但 zip 更通用）
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version || '0.0.0';
  const zipName = `image-provenance-helper-v${version}.zip`;
  const zipPath = join(DIST, zipName);

  // 先把文件拷到一个干净的暂存目录，保证 zip 内路径是相对根的
  const stage = join(DIST, '.stage');
  mkdirSync(stage, { recursive: true });
  for (const f of files) {
    const rel = relative(ROOT, f);
    const dest = join(stage, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(f));
  }
  log('✅ 暂存目录就绪');

  let zipped = false;
  // 优先用系统 zip
  try {
    execFileSync('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: stage, stdio: 'pipe' });
    zipped = true;
  } catch {
    // Windows 没有 zip 命令时，用 PowerShell 的 Compress-Archive
    try {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path '${join(stage, '*')}' -DestinationPath '${zipPath}' -Force`,
        ],
        { stdio: 'pipe' }
      );
      zipped = true;
    } catch (e) {
      console.error(`  ❌ 打包失败：${e.message}`);
      console.error('     请安装 zip，或手动用系统压缩工具打包 dist/.stage 目录');
      process.exit(1);
    }
  }
  rmSync(stage, { recursive: true, force: true });

  if (!zipped || !existsSync(zipPath)) {
    console.error('  ❌ 未生成 zip');
    process.exit(1);
  }

  const buf = readFileSync(zipPath);
  const sha = createHash('sha256').update(buf).digest('hex');
  writeFileSync(`${zipPath}.sha256`, `${sha}  ${zipName}\n`);

  log(`✅ 已生成 ${zipName}（${(buf.length / 1024 / 1024).toFixed(2)} MB）`);
  log(`   SHA-256: ${sha}`);
  console.log('\n发布到 GitHub Release：');
  console.log(`  gh release create v${version} ${zipPath} --title "v${version}" --notes "见 CHANGELOG"\n`);
}

main();
