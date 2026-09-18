/**
 * tools/make-icons.js —— 生成扩展图标 PNG（纯 Node，无需浏览器或图像库）
 *
 * 用法：node tools/make-icons.js
 * 输出：icons/icon16.png  icon32.png  icon48.png  icon128.png
 *
 * 实现要点：
 *   - 图标图案是纯几何图形（圆角方块 + 两个面板 + 分隔缝 + 文字示意条），
 *     因此不做 SVG 解析，直接在 128 逻辑坐标系里用「有符号距离」逐点求值；
 *   - 每个输出像素做 3x3 超采样抗锯齿；
 *   - PNG 用 zlib.deflateSync + 手写 CRC32 编码（RGBA8）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ================================================================== */
/* 一、PNG 编码                                                        */
/* ================================================================== */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 0);
  crcBuf.copy(out, 8 + data.length);
  return out;
}

/**
 * @param {number} w
 * @param {number} h
 * @param {Buffer} rgba 长度 w*h*4
 */
function encodePng(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const dst = y * stride;
    raw[dst] = 0;                                   // filter type 0 (None)
    rgba.copy(raw, dst + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: truecolor + alpha
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* ================================================================== */
/* 二、图形求值（128 x 128 逻辑坐标系）                                */
/* ================================================================== */

/** 圆角矩形有符号距离：<0 在内部，>0 在外部，绝对值≈到边的距离 */
function roundRectDist(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const ax = qx > 0 ? qx : 0;
  const ay = qy > 0 ? qy : 0;
  const outer = Math.sqrt(ax * ax + ay * ay);
  const inner = qx > qy ? qx : qy;
  const clamped = inner < 0 ? inner : 0;
  return outer + clamped - r;
}

const COLOR_TOP = [59, 130, 246];    // #3b82f6
const COLOR_BOTTOM = [99, 102, 241]; // #6366f1
const COLOR_WHITE = [255, 255, 255];
const COLOR_ACCENT_L = [59, 130, 246];
const COLOR_ACCENT_R = [99, 102, 241];

/** 面板内的「文字示意条」： [x, y, width] */
const BARS_LEFT = [[25, 42, 29], [25, 54, 29], [25, 66, 20], [25, 78, 25]];
const BARS_RIGHT = [[74, 42, 29], [74, 54, 29], [74, 66, 22], [74, 78, 26]];

/**
 * 逐点着色（返回 [r,g,b,a]，a 为 0..1 的覆盖度）
 * @param {boolean} simple 小尺寸简化：省略内部细线，只保留大色块
 */
function shade(px, py, simple) {
  let r = 0, g = 0, b = 0, a = 0;

  /** 把 (cr,cg,cb) 以 alpha 覆盖到当前颜色上 */
  function paint(cr, cg, cb, alpha) {
    if (alpha <= 0) return;
    if (alpha > 1) alpha = 1;
    r = r * (1 - alpha) + cr * alpha;
    g = g * (1 - alpha) + cg * alpha;
    b = b * (1 - alpha) + cb * alpha;
    a = a * (1 - alpha) + alpha;
  }

  /** 有符号距离 → 覆盖度（1px 宽的软边） */
  function cover(d) {
    if (d <= -0.5) return 1;
    if (d >= 0.5) return 0;
    return 0.5 - d;
  }

  // ---- 底板：渐变圆角方块 ----
  const dBase = roundRectDist(px, py, 4, 4, 120, 120, 28);
  if (dBase >= 0.5) return [0, 0, 0, 0];
  let t = (px + py - 8) / 240;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  paint(
    COLOR_TOP[0] + (COLOR_BOTTOM[0] - COLOR_TOP[0]) * t,
    COLOR_TOP[1] + (COLOR_BOTTOM[1] - COLOR_TOP[1]) * t,
    COLOR_TOP[2] + (COLOR_BOTTOM[2] - COLOR_TOP[2]) * t,
    cover(dBase)
  );

  // ---- 左面板（原文，白色高不透明） ----
  paint(COLOR_WHITE[0], COLOR_WHITE[1], COLOR_WHITE[2],
    cover(roundRectDist(px, py, 18, 30, 43, 68, 6)) * 0.94);

  // ---- 右面板（译文，白色半透明，形成镜像感） ----
  paint(COLOR_WHITE[0], COLOR_WHITE[1], COLOR_WHITE[2],
    cover(roundRectDist(px, py, 67, 30, 43, 68, 6)) * 0.55);

  // ---- 中间分隔缝 ----
  paint(COLOR_WHITE[0], COLOR_WHITE[1], COLOR_WHITE[2],
    cover(roundRectDist(px, py, 62.5, 24, 3, 80, 1.5)));

  // ---- 面板内的文字示意条 ----
  if (!simple) {
    for (let i = 0; i < 4; i++) {
      const bl = BARS_LEFT[i];
      paint(COLOR_ACCENT_L[0], COLOR_ACCENT_L[1], COLOR_ACCENT_L[2],
        cover(roundRectDist(px, py, bl[0], bl[1], bl[2], 5, 2.5)));
      const br = BARS_RIGHT[i];
      paint(COLOR_ACCENT_R[0], COLOR_ACCENT_R[1], COLOR_ACCENT_R[2],
        cover(roundRectDist(px, py, br[0], br[1], br[2], 5, 2.5)));
    }
  }

  return [r, g, b, a];
}

/* ================================================================== */
/* 三、渲染（超采样抗锯齿）                                            */
/* ================================================================== */

function render(size) {
  const SS = 4;                       // 4x4 = 16 个子样本
  const scale = 128 / size;
  const simple = size <= 20;
  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const lx = (x + (sx + 0.5) / SS) * scale;
          const ly = (y + (sy + 0.5) / SS) * scale;
          const c = shade(lx, ly, simple);
          if (c[3] <= 0) continue;
          rSum += c[0] * c[3];
          gSum += c[1] * c[3];
          bSum += c[2] * c[3];
          aSum += c[3];
        }
      }
      const idx = (y * size + x) * 4;
      if (aSum <= 0) continue;                       // 保持 (0,0,0,0)
      const alpha = aSum / n;                        // 0..1
      out[idx] = Math.round(Math.min(255, rSum / aSum));
      out[idx + 1] = Math.round(Math.min(255, gSum / aSum));
      out[idx + 2] = Math.round(Math.min(255, bSum / aSum));
      out[idx + 3] = Math.round(Math.min(255, alpha * 255));
    }
  }
  return out;
}

/* ================================================================== */
/* 四、主流程                                                          */
/* ================================================================== */

if (require.main === module) {
  const outDir = path.resolve(__dirname, '..', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  let made = 0;
  [16, 32, 48, 128].forEach((size) => {
    try {
      const png = encodePng(size, size, render(size));
      fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
      console.log(`✓ icons/icon${size}.png  ${size}x${size}  ${png.length} bytes`);
      made++;
    } catch (err) {
      console.error(`✗ icon${size}.png 生成失败：${err.message}`);
    }
  });
  console.log(`完成：${made}/4`);
}

module.exports = { encodePng, render, shade, roundRectDist };
