#!/usr/bin/env node
/**
 * 生成 PWA 图标。纯 Node 实现（手写 PNG 编码 + 超采样抗锯齿），无第三方依赖。
 *
 * 用法：node tools/generate-icons.mjs
 * 产物：icons/*.png
 *
 * 这是一个构建期工具，不参与运行时；改配色后重新执行即可。
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'icons');

/* ---------- 配色（与 app.js 的莫奈色板保持一致） ---------- */

const BG = [251, 250, 247, 255];
const RIM = [255, 255, 255, 255];
const HUB = [255, 252, 248, 255];

/**
 * 图标专用色板。
 *
 * 界面用的是莫奈浅色（明度约 90%），实测相对浅色背景对比度仅
 * 1.1:1 ~ 1.4:1，在 16px/32px 的 favicon 上会整片糊掉。
 *
 * 这里保留同一套色相顺序（珊瑚 → 杏 → 麦黄 → 青柠 → 薄荷 → 湖青），
 * 把明度压到 55%~64%，使每个扇区相对白色背景的对比度 ≥ 3:1，
 * 达到 WCAG 对小图形的可辨识下限；饱和度保持在 45%~60%，
 * 整体仍是柔和的马卡龙调性，而不是刺眼的纯色。
 */
const WEDGES = [
  [196, 96, 80],   // 珊瑚  4.09:1
  [198, 126, 56],  // 杏橙  3.10:1
  [158, 149, 46],  // 麦黄  3.12:1
  [110, 158, 74],  // 青柠  3.16:1
  [72, 152, 112],  // 薄荷  3.50:1
  [64, 146, 148],  // 湖青  3.65:1
];

const WEDGE_COUNT = WEDGES.length;

/* ---------- PNG 编码 ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);

  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 无隔行

  // 每行前置一个 filter 字节（0 = None）
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new Uint8Array(4);

/**
 * 计算归一化坐标 (px, py) ∈ [0,1] 处的颜色。
 * radius 为转盘半径（相对边长），opaque 表示圆圈外是否填充底色，
 * size 用于按图标实际像素调整线条粗细。
 *
 * 注意：图标只画「转盘本体」，不放指针——16px 下指针会被压成
 * 一个看不出形状的小三角，反而让图标显得脏。
 */
function sample(px, py, radius, opaque, size) {
  const dx = px - 0.5;
  const dy = py - 0.5;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > radius) {
    if (!opaque) {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
      return out;
    }
    out.set(BG);
    return out;
  }

  // 角度：12 点方向为 0°，顺时针递增
  let angle = Math.atan2(dy, dx) + Math.PI / 2;
  if (angle < 0) angle += Math.PI * 2;
  const deg = (angle * 180) / Math.PI;

  const slice = 360 / WEDGE_COUNT;
  const index = Math.floor(deg / slice) % WEDGE_COUNT;
  const local = deg % slice;

  let color = WEDGES[index];

  // 扇区分隔线：16px 图标上 0.9° 的白线会被抗锯齿吃掉，需按尺寸加粗
  const lineWidth = size > 96 ? 0.9 : 2.6;
  if (local < lineWidth || local > slice - lineWidth) color = RIM;

  // 外缘白圈
  if (dist > radius - radius * 0.022) color = RIM;

  out[0] = color[0]; out[1] = color[1]; out[2] = color[2]; out[3] = 255;

  // 中心圆盘
  if (dist <= 0.34 * radius) {
    out.set(HUB);
  }

  return out;
}

/** 渲染一张图标：radius 为转盘半径（相对边长），opaque 决定圆圈外是否透明。 */
function render(size, radius, opaque) {
  // 小尺寸需要更多采样次数，否则边缘锯齿明显
  const SUPERSAMPLE = size < 64 ? 8 : 4;
  const buffer = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 颜色按 alpha 加权累加（预乘方式）。
      // 直接把透明样本的 rgb(0,0,0) 一起平均，会把边缘像素拉暗，
      // 在浅色背景上呈现出一圈发灰的脏边。
      let r = 0;
      let g = 0;
      let b = 0;
      let alphaSum = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = (x + (sx + 0.5) / SUPERSAMPLE) / size;
          const py = (y + (sy + 0.5) / SUPERSAMPLE) / size;
          const c = sample(px, py, radius, opaque, size);
          const w = c[3] / 255;
          r += c[0] * w;
          g += c[1] * w;
          b += c[2] * w;
          alphaSum += w;
        }
      }

      const offset = (y * size + x) * 4;
      if (alphaSum > 0) {
        buffer[offset] = Math.round(r / alphaSum);
        buffer[offset + 1] = Math.round(g / alphaSum);
        buffer[offset + 2] = Math.round(b / alphaSum);
      }
      buffer[offset + 3] = Math.round((alphaSum / samples) * 255);
    }
  }

  return buffer;
}

/* ---------- ICO 封装（内嵌 PNG，Vista 及以上支持） ---------- */

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留位
  header.writeUInt16LE(1, 2); // 类型：1 = 图标
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + directory.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    // 目录项里 0 表示 256
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0; // 调色板颜色数
    directory[at + 3] = 0; // 保留位
    directory.writeUInt16LE(1, at + 4); // 颜色平面数
    directory.writeUInt16LE(32, at + 6); // 位深
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

/* ---------- 矢量 favicon ---------- */

function buildSVG() {
  const cx = 32;
  const cy = 32;
  const r = 30;

  const point = (deg, distance) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [
      (cx + Math.cos(rad) * distance).toFixed(2),
      (cy + Math.sin(rad) * distance).toFixed(2),
    ];
  };

  const slice = 360 / WEDGE_COUNT;
  const wedges = WEDGES.map((color, i) => {
    const [x1, y1] = point(i * slice, r);
    const [x2, y2] = point((i + 1) * slice, r);
    const hex = `#${color.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    return `    <path d="M${cx} ${cy}L${x1} ${y1}A${r} ${r} 0 0 1 ${x2} ${y2}Z" fill="${hex}"/>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <title>Picker Wheel</title>
  <g>
${wedges}
  </g>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-width="1.6"/>
  <circle cx="${cx}" cy="${cy}" r="10.2" fill="#fffcf8"/>
</svg>
`;
}

/* ---------- 产出 ---------- */

const TARGETS = [
  // 普通图标：透明背景，圆形转盘几乎占满画布
  { file: 'icon-192.png', size: 192, radius: 0.46, opaque: false },
  { file: 'icon-512.png', size: 512, radius: 0.46, opaque: false },
  // maskable：满幅底色，内容缩进到 80% 安全区内
  { file: 'icon-maskable-512.png', size: 512, radius: 0.37, opaque: true },
  // iOS 主屏图标：iOS 会自己加圆角，因此保留不透明底色
  { file: 'apple-touch-icon.png', size: 180, radius: 0.42, opaque: true },
];

/** 站点根目录的 favicon，浏览器会主动请求这些路径。 */
const ROOT_TARGETS = [
  { file: 'favicon-16.png', size: 16, radius: 0.46 },
  { file: 'favicon-32.png', size: 32, radius: 0.46 },
  { file: 'favicon-48.png', size: 48, radius: 0.46 },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const target of TARGETS) {
  const png = encodePNG(target.size, render(target.size, target.radius, target.opaque));
  writeFileSync(resolve(OUT_DIR, target.file), png);
  console.log(`生成 icons/${target.file}（${target.size}×${target.size}，${(png.length / 1024).toFixed(1)} KB）`);
}

for (const target of ROOT_TARGETS) {
  const png = encodePNG(target.size, render(target.size, target.radius, false));
  writeFileSync(resolve(ROOT, target.file), png);
  console.log(`生成 ${target.file}（${target.size}×${target.size}，${(png.length / 1024).toFixed(1)} KB）`);
}

const ico = encodeICO(
  [16, 32, 48].map((size) => ({
    size,
    png: encodePNG(size, render(size, 0.46, false)),
  }))
);
writeFileSync(resolve(ROOT, 'favicon.ico'), ico);
console.log(`生成 favicon.ico（16/32/48，${(ico.length / 1024).toFixed(1)} KB）`);

const svg = buildSVG();
writeFileSync(resolve(ROOT, 'favicon.svg'), svg);
console.log(`生成 favicon.svg（${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB）`);

console.log('图标生成完成。');
