'use strict';
// 从双色双引号 logo.png 生成 macOS 菜单栏模板图标（trayTemplate.png / @2x）。
// 模板图要求：纯黑 + alpha，系统据此在深浅色菜单栏自动反色。
// 提取白色与橙色引号、去掉黑色底板，导出同一字形的纯黑 + alpha 单色版。
// 纯 Node 无第三方依赖：自带 PNG 解码/编码、面积平均降采样。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 解码（8bit、非隔行、RGB/RGBA/灰度） ----------
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported png: depth=${bitDepth} interlace=${interlace}`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const img = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const prev = y ? img.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const out = img.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (colorType === 6) { rgba[o] = img[i * 4]; rgba[o + 1] = img[i * 4 + 1]; rgba[o + 2] = img[i * 4 + 2]; rgba[o + 3] = img[i * 4 + 3]; }
    else if (colorType === 2) { rgba[o] = img[i * 3]; rgba[o + 1] = img[i * 3 + 1]; rgba[o + 2] = img[i * 3 + 2]; rgba[o + 3] = 255; }
    else if (colorType === 0) { rgba[o] = rgba[o + 1] = rgba[o + 2] = img[i]; rgba[o + 3] = 255; }
    else { rgba[o] = rgba[o + 1] = rgba[o + 2] = img[i * 2]; rgba[o + 3] = img[i * 2 + 1]; }
  }
  return { w, h, rgba };
}

// ---------- PNG 编码（RGBA） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 面积平均降采样（预乘 alpha） ----------
function downscale(srcW, srcH, src, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  const sx = srcW / dstW, sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * sx), x1 = Math.ceil((x + 1) * sx);
      const y0 = Math.floor(y * sy), y1 = Math.ceil((y + 1) * sy);
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          if (xx >= srcW || yy >= srcH) continue;
          const i = (yy * srcW + xx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al;
          a += al; n++;
        }
      }
      const o = (y * dstW + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

// 源图 → 模板图：沿用原字形，恢复抗锯齿覆盖率并去掉底板。
function toTemplate(srcW, srcH, src) {
  const out = Buffer.alloc(srcW * srcH * 4);
  let left = srcW, top = srcH, right = -1, bottom = -1;
  for (let i = 0; i < srcW * srcH; i++) {
    const o = i * 4;
    const r = src[o], g = src[o + 1], b = src[o + 2], a = src[o + 3];
    const foreground = r > g * 1.3 ? 237 : 255;
    const alpha = Math.round(a * Math.max(0, Math.min(1, (r - 23) / (foreground - 23))));
    out[o + 3] = alpha;
    if (alpha) { const x = i % srcW, y = Math.floor(i / srcW); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (right < left) throw Error('Logo contains no visible quotation mark');
  const w = right - left + 1, h = bottom - top + 1, cropped = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) out.copy(cropped, y * w * 4, ((top + y) * srcW + left) * 4, ((top + y) * srcW + left + w) * 4);
  return { w, h, rgba: cropped };
}

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'logo.png');
const { w, h, rgba } = decodePNG(fs.readFileSync(SRC_PATH));
const tpl = toTemplate(w, h, rgba);
const outDir = path.join(ROOT, 'assets');
for (const size of [16, 32]) {
  const fit = (size - 2) / Math.max(tpl.w, tpl.h), dw = Math.max(1, Math.round(tpl.w * fit)), dh = Math.max(1, Math.round(tpl.h * fit));
  const small = downscale(tpl.w, tpl.h, tpl.rgba, dw, dh), canvas = Buffer.alloc(size * size * 4);
  const x = Math.floor((size - dw) / 2), y = Math.floor((size - dh) / 2);
  for (let row = 0; row < dh; row++) small.copy(canvas, ((y + row) * size + x) * 4, row * dw * 4, (row + 1) * dw * 4);
  fs.writeFileSync(path.join(outDir, size === 16 ? 'trayTemplate.png' : 'trayTemplate@2x.png'), encodePNG(size, size, canvas));
}
console.log('generated monochrome quotation marks: trayTemplate.png (16x16) + trayTemplate@2x.png (32x32)');
