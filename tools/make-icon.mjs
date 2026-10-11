/**
 * 生成应用图标 desktop/icon.ico
 *
 * 为什么手写 PNG + ICO 编码而不是装个图像库：这个项目「运行期零依赖」是条底线，
 * 构建期也不想为了一个图标拖进 pillow / sharp 这种重家伙。光栅化就几行数学，
 * PNG 无非 zlib + CRC，ICO 无非一个目录头 —— 各写一遍，比拉依赖省心。
 *
 * 图案：深色圆角底 + 金色的锅（碗身 + 口沿 + 两只耳朵把手），
 * 配色直接取页面的 --accent (#c99a5b)，跟界面是一套。
 *
 * 用法：node tools/make-icon.mjs
 * 产出：desktop/icon.ico（16 / 24 / 32 / 48 / 64 / 128 / 256 全套尺寸）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'desktop', 'icon.ico');

const SS = 4;            // 超采样倍数：先按 1024 画，再缩回各尺寸，边缘才不毛
const BASE = 256;
const N = BASE * SS;

/* ── 画 ── */

const BG = [15, 19, 25];        // #0f1319 深底
const GOLD = [201, 154, 91];    // #c99a5b 主金
const GOLD_HI = [230, 193, 134]; // 口沿提亮，小尺寸下才看得出「这是个容器」
const INNER = [26, 32, 40];     // 锅内暗部

/** 归一化坐标下的圆角矩形 */
function inRoundRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 归一化坐标下的椭圆 */
function inEllipse(u, v, cx, cy, rx, ry) {
  const dx = (u - cx) / rx;
  const dy = (v - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

/** 锅的几何：碗身是下半椭圆，口沿是一圈亮金，内里压暗 —— 三个形状叠出「一口锅」 */
const PAN = {
  cx: 0.5, top: 0.42, rx: 0.335, ry: 0.40,   // 碗身
  rimRy: 0.072, innerRx: 0.285, innerRy: 0.050, // 口沿 / 内里
};

function paint(u, v) {
  // 1) 锅口：最上面那圈亮金，压过碗身，形成清楚的「口」
  if (inEllipse(u, v, PAN.cx, PAN.top, PAN.rx + 0.028, PAN.rimRy + 0.014)) {
    // 2) 内里：口沿中间挖空，露出暗色 —— 这是锅不是实心饼
    if (inEllipse(u, v, PAN.cx, PAN.top, PAN.innerRx, PAN.innerRy)) return INNER;
    return GOLD_HI;
  }

  // 3) 碗身：上半截裁掉，只留下半椭圆
  if (v >= PAN.top && inEllipse(u, v, PAN.cx, PAN.top, PAN.rx, PAN.ry)) return GOLD;

  // 4) 两只耳朵把手：贴在口沿两侧，做成胶囊形（r = 半高）才像锅耳而不是方块
  if (inRoundRect(u, v, 0.035, PAN.top - 0.068, 0.190, PAN.top - 0.008, 0.030)) return GOLD;
  if (inRoundRect(u, v, 0.810, PAN.top - 0.068, 0.965, PAN.top - 0.008, 0.030)) return GOLD;

  return null;
}

function render() {
  const buf = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y += 1) {
    const v = (y + 0.5) / N;
    for (let x = 0; x < N; x += 1) {
      const u = (x + 0.5) / N;
      let rgb = null;
      if (inRoundRect(u, v, 0, 0, 1, 1, 0.225)) rgb = paint(u, v) || BG;
      const o = (y * N + x) * 4;
      if (rgb) {
        buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 255;
      }
    }
  }
  return buf;
}

/** 盒式降采样 —— 超采样的收益全在这一步 */
function downscale(src, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const step = N / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      const y0 = Math.floor(y * step); const y1 = Math.floor((y + 1) * step);
      const x0 = Math.floor(x * step); const x1 = Math.floor((x + 1) * step);
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const o = (sy * N + sx) * 4;
          // 按 alpha 加权，避免透明边缘把颜色拉黑
          const al = src[o + 3] / 255;
          r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += src[o + 3];
          n += 1;
        }
      }
      const o2 = (y * size + x) * 4;
      const aw = a / 255 || 1;
      out[o2] = r / aw; out[o2 + 1] = g / aw; out[o2 + 2] = b / aw; out[o2 + 3] = a / n;
    }
  }
  return out;
}

/* ── PNG 编码 ── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none —— 图标本来就小，压缩率够用
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── ICO 封装 ── */

function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);              // 1 = icon
  head.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);   // 256 用 0 表示
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.png)]);
}

/* ── main ── */

const canvas = render();
const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = sizes.map((size) => ({ size, png: encodePng(size, downscale(canvas, size)) }));
const ico = buildIco(entries);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico);
console.log(`  desktop/icon.ico  ${(ico.length / 1024).toFixed(1)} KB  ${sizes.join(' / ')}`);
