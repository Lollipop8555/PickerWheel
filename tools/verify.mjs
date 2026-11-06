#!/usr/bin/env node
/**
 * 静态自检：CI 与本地共用。
 *
 * 只做「能在无浏览器环境下确定性验证」的检查，不追求覆盖运行时行为：
 *   1. JS 语法（node --check）
 *   2. manifest 结构合法
 *   3. 所有本地资源引用真实存在
 *   4. Service Worker 外壳清单完整且覆盖 index.html 的引用
 *   5. 图标文件是合法 PNG，且声明的尺寸与实际一致
 *
 * 用法：node tools/verify.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
const notes = [];

const fail = (message) => problems.push(message);
const ok = (message) => notes.push(message);

const read = (file) => readFileSync(resolve(ROOT, file), 'utf8');

/** 把 './a/b.css' 归一化为仓库内的相对路径。 */
function normalizeAsset(url) {
  const clean = url.split('?')[0].split('#')[0];
  if (clean === './' || clean === '.') return 'index.html';
  return clean.replace(/^\.\//, '');
}

/* ---------- 1. JS 语法 ---------- */

const SCRIPTS = [
  'app.js',
  'sw.js',
  'tools/generate-icons.mjs',
  'tools/verify.mjs',
  'tools/test-core.mjs',
];

for (const file of SCRIPTS) {
  if (!existsSync(resolve(ROOT, file))) {
    fail(`脚本缺失：${file}`);
    continue;
  }
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0) ok(`语法通过：${file}`);
  else fail(`语法错误：${file}\n${result.stderr.trim()}`);
}

/* ---------- 2. manifest ---------- */

let manifest = null;
try {
  manifest = JSON.parse(read('manifest.webmanifest'));
  ok('manifest JSON 合法');
} catch (error) {
  fail(`manifest 解析失败：${error.message}`);
}

if (manifest) {
  for (const key of ['name', 'short_name', 'start_url', 'display', 'icons']) {
    if (!(key in manifest)) fail(`manifest 缺少字段：${key}`);
  }

  const sizes = (manifest.icons || []).map((icon) => icon.sizes);
  if (!sizes.includes('192x192') || !sizes.includes('512x512')) {
    fail(`manifest 至少需要 192x192 与 512x512 图标，当前：${sizes.join(', ')}`);
  }
  if (!(manifest.icons || []).some((icon) => icon.purpose === 'maskable')) {
    fail('manifest 缺少 purpose: maskable 的图标');
  }
  if (!manifest.icons || manifest.icons.length < 2) {
    fail('manifest 图标数量不足');
  } else {
    ok(`manifest 图标 ${manifest.icons.length} 项，含 maskable`);
  }

  if (manifest.start_url && !manifest.start_url.startsWith('./')) {
    fail(`start_url 建议用相对路径以便部署到子目录：${manifest.start_url}`);
  }
}

/* ---------- 3. HTML 引用 ---------- */

const html = read('index.html');
const htmlRefs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);

if (htmlRefs.length === 0) fail('index.html 中未找到任何相对资源引用');

for (const ref of htmlRefs) {
  if (!existsSync(resolve(ROOT, normalizeAsset(ref)))) {
    fail(`index.html 引用了不存在的资源：${ref}`);
  }
}
ok(`index.html 引用 ${htmlRefs.length} 个本地资源，全部存在`);

if (!html.includes('rel="manifest"')) fail('index.html 缺少 manifest 声明');

/* ---------- 4. Service Worker 外壳 ---------- */

let shellAssets = [];
if (existsSync(resolve(ROOT, 'sw.js'))) {
  const sw = read('sw.js');
  const match = sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);

  if (!match) {
    fail('sw.js 中未找到 SHELL_ASSETS');
  } else {
    shellAssets = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    ok(`SW 外壳清单 ${shellAssets.length} 项`);

    for (const asset of shellAssets) {
      if (!existsSync(resolve(ROOT, normalizeAsset(asset)))) {
        fail(`SW 预缓存了不存在的资源：${asset}`);
      }
    }

    // 页面引用的资源必须全部在预缓存清单里，否则首次离线会缺件
    const cached = new Set(shellAssets.map(normalizeAsset));
    for (const ref of htmlRefs) {
      const path = normalizeAsset(ref);
      if (!cached.has(path)) fail(`index.html 引用的 ${ref} 未加入 SW 预缓存`);
    }
    ok('index.html 的所有引用均在 SW 预缓存清单内');
  }
}

/* ---------- 5. 图标 ---------- */

const PNG_SIGNATURE = '89504e470d0a1a0a';

function inspectPNG(file) {
  const buffer = readFileSync(resolve(ROOT, file));
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== PNG_SIGNATURE) return { valid: false, reason: 'PNG 签名错误' };
  return {
    valid: true,
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

const iconChecks = [];

if (manifest) {
  for (const icon of manifest.icons || []) {
    iconChecks.push({ file: normalizeAsset(icon.src), expect: icon.sizes });
  }
}
const EXTRA_ICONS = [
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'icons/apple-touch-icon.png',
];

for (const file of EXTRA_ICONS) {
  if (existsSync(resolve(ROOT, file))) iconChecks.push({ file, expect: null });
  else fail(`图标缺失：${file}`);
}

for (const { file, expect } of iconChecks) {
  if (!existsSync(resolve(ROOT, file))) {
    fail(`图标缺失：${file}`);
    continue;
  }

  const info = inspectPNG(file);
  if (!info.valid) {
    fail(`图标无效：${file}（${info.reason}）`);
    continue;
  }

  if (expect) {
    const [w, h] = expect.split('x').map(Number);
    if (info.width !== w || info.height !== h) {
      fail(`图标尺寸与声明不符：${file} 实际 ${info.width}x${info.height}，声明 ${expect}`);
      continue;
    }
  }
  ok(`图标有效：${file}（${info.width}x${info.height}）`);
}

/* ---------- 6. 协议与杂项 ---------- */

if (!existsSync(resolve(ROOT, 'LICENSE'))) {
  fail('缺少 LICENSE');
} else if (!read('LICENSE').includes('MIT License')) {
  fail('LICENSE 不是 MIT 协议');
} else {
  ok('LICENSE 为 MIT');
}

/* ---------- 输出 ---------- */

console.log('\n=== 检查项 ===');
for (const note of notes) console.log(`  ✔ ${note}`);

if (problems.length) {
  console.log('\n=== 问题 ===');
  for (const problem of problems) console.log(`  ✘ ${problem}`);
  console.log(`\n共 ${problems.length} 个问题 ❌\n`);
  process.exit(1);
}

console.log(`\n全部 ${notes.length} 项通过 ✅\n`);
