/**
 * tools/verify-icons.js —— 自检：解码生成的 PNG，打印像素统计与 ASCII 预览
 * 用法： node tools/verify-icons.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function decode(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  const idat = [];
  let w = 0, h = 0, depth = 0, color = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9];
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4 + 1;
  const px = (x, y) => {
    const i = y * stride + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
  return { w, h, depth, color, px };
}

const dir = path.resolve(__dirname, '..', 'icons');
let failed = 0;
[16, 32, 48, 128].forEach((size) => {
  const file = path.join(dir, `icon${size}.png`);
  if (!fs.existsSync(file)) {
    console.log(`✗ icon${size}.png 不存在`);
    failed++;
    return;
  }
  const img = decode(file);
  let opaque = 0, semi = 0, transparent = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const a = img.px(x, y)[3];
      if (a === 0) transparent++;
      else if (a < 250) semi++;
      else opaque++;
    }
  }
  const center = img.px(Math.floor(img.w / 2), Math.floor(img.h / 2));
  const corner = img.px(0, 0);
  const ok = img.w === size && img.h === size && img.depth === 8 && img.color === 6 &&
             opaque + semi > size * size * 0.5 && corner[3] === 0;
  if (!ok) failed++;
  console.log(
    `${ok ? '✓' : '✗'} icon${size}.png  ${img.w}x${img.h} depth=${img.depth} color=${img.color}  ` +
    `不透明=${opaque} 半透明=${semi} 透明=${transparent}  中心=rgba(${center.join(',')})  左上角alpha=${corner[3]}`
  );

  // 小尺寸打印 ASCII 预览，便于肉眼确认图形
  if (size <= 32) {
    const rows = [];
    for (let y = 0; y < img.h; y++) {
      let line = '';
      for (let x = 0; x < img.w; x++) {
        const [r, g, b, a] = img.px(x, y);
        if (a === 0) line += '.';
        else if (a < 120) line += '-';
        else if (r > 200 && g > 200 && b > 200) line += '#';
        else line += 'o';
      }
      rows.push('   ' + line);
    }
    console.log(rows.join('\n'));
  }
});

console.log(failed ? `\n${failed} 个图标不合格` : '\n全部图标校验通过');
process.exit(failed ? 1 : 0);
