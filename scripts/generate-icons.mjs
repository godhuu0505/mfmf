// ブランドアイコン（肉球モチーフ）を純 Node で生成するスクリプト。
// 外部の画像ライブラリに依存せず、zlib で PNG を直接エンコードする。
//
//   node scripts/generate-icons.mjs
//
// 出力:
//   public/icon-192.png            … manifest 用 (any)
//   public/icon-512.png            … manifest 用 (any)
//   public/icon-maskable-512.png   … manifest 用 (maskable, 全面塗り)
//   public/apple-touch-icon.png    … iOS ホーム画面 (180px, 全面塗り)
//   src/app/icon.png               … favicon (Next.js metadata)

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- カラーパレット（Tailwind slate / amber） ---
const BG = [15, 23, 42, 255]; // slate-900
const PAW = [251, 191, 36, 255]; // amber-400

// --- PNG エンコード（RGBA, 8bit） ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10..12 = 0 (compression / filter / interlace)

  // 各スキャンラインの先頭にフィルタバイト(0)を付与
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- 描画ヘルパー ---
function blend(dst, i, color) {
  const a = color[3] / 255;
  dst[i] = Math.round(color[0] * a + dst[i] * (1 - a));
  dst[i + 1] = Math.round(color[1] * a + dst[i + 1] * (1 - a));
  dst[i + 2] = Math.round(color[2] * a + dst[i + 2] * (1 - a));
  dst[i + 3] = Math.max(dst[i + 3], color[3]);
}

// 中心 (cx,cy) 半径 r の塗り円。アンチエイリアス付き。
function fillCircle(buf, w, h, cx, cy, r, color) {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.max(0, Math.min(1, r + 0.5 - d));
      if (cov <= 0) continue;
      blend(buf, (y * w + x) * 4, [color[0], color[1], color[2], Math.round(color[3] * cov)]);
    }
  }
}

// 縦長楕円（肉球の手のひら部分）
function fillEllipse(buf, w, h, cx, cy, rx, ry, color) {
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const d = Math.hypot(nx, ny);
      const cov = Math.max(0, Math.min(1, (1 - d) * Math.min(rx, ry)));
      if (cov <= 0) continue;
      blend(buf, (y * w + x) * 4, [color[0], color[1], color[2], Math.round(color[3] * cov)]);
    }
  }
}

// 角丸の有無を選んで背景を塗る
function fillBackground(buf, w, h, color, radius) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let cov = 1;
      if (radius > 0) {
        // 角丸: 各コーナーからの距離で覆い率を算出
        const dx = Math.min(x, w - 1 - x);
        const dy = Math.min(y, h - 1 - y);
        if (dx < radius && dy < radius) {
          const d = Math.hypot(radius - dx, radius - dy);
          cov = Math.max(0, Math.min(1, radius - d + 0.5));
        }
      }
      if (cov <= 0) continue;
      const i = (y * w + x) * 4;
      buf[i] = color[0];
      buf[i + 1] = color[1];
      buf[i + 2] = color[2];
      buf[i + 3] = Math.round(color[3] * cov);
    }
  }
}

// 肉球を描画する。size に対して中央配置。
function drawPaw(buf, size) {
  const s = size;
  // 手のひら（メインパッド）
  fillEllipse(buf, s, s, s * 0.5, s * 0.62, s * 0.2, s * 0.17, PAW);
  // 指の肉球 4 つ
  const toes = [
    [0.3, 0.4, 0.085],
    [0.43, 0.3, 0.092],
    [0.57, 0.3, 0.092],
    [0.7, 0.4, 0.085],
  ];
  for (const [fx, fy, fr] of toes) {
    fillCircle(buf, s, s, s * fx, s * fy, s * fr, PAW);
  }
}

function makeIcon(size, { maskable }) {
  const buf = Buffer.alloc(size * size * 4); // 透明で初期化
  const radius = maskable ? 0 : Math.round(size * 0.22);
  fillBackground(buf, size, size, BG, radius);
  drawPaw(buf, size);
  return encodePng(size, size, buf);
}

const outputs = [
  { path: "public/icon-192.png", size: 192, maskable: false },
  { path: "public/icon-512.png", size: 512, maskable: false },
  { path: "public/icon-maskable-512.png", size: 512, maskable: true },
  { path: "public/apple-touch-icon.png", size: 180, maskable: true },
  { path: "src/app/icon.png", size: 64, maskable: false },
];

for (const o of outputs) {
  const png = makeIcon(o.size, { maskable: o.maskable });
  const full = resolve(root, o.path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, png);
  console.log(`generated ${o.path} (${o.size}x${o.size}, ${png.length} bytes)`);
}
