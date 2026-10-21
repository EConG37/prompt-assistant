'use strict';
// 从项目根目录 logo.png 生成应用图标：assets/icon.png(1024)、assets/tray.png(32)、cache/icon.ico(多尺寸)。
// 纯 Node 无第三方依赖：自带 PNG 解码/编码、白底洪水填充转透明、面积平均降采样（预乘 alpha 防边缘溢色）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'logo.png');

// ---------- PNG 解码（8bit，非隔行，灰度/RGB/灰度+alpha/RGBA） ----------
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

// ---------- PNG 编码（RGBA8，与 tools/gen-icon.js 相同实现） ----------
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
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 白底（四角连通区域）转透明 ----------
function whiteBackgroundToTransparent(w, h, rgba) {
  const isBG = (i) => {
    const o = i * 4;
    return rgba[o + 3] === 0 || (rgba[o] > 200 && rgba[o + 1] > 200 && rgba[o + 2] > 200);
  };
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qh = 0, qt = 0;
  const seed = (x, y) => {
    const i = y * w + x;
    if (!visited[i] && isBG(i)) { visited[i] = 1; queue[qt++] = i; }
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  let cleared = 0;
  while (qh < qt) {
    const i = queue[qh++];
    rgba[i * 4 + 3] = 0;
    cleared++;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) { const n = i - 1; if (!visited[n] && isBG(n)) { visited[n] = 1; queue[qt++] = n; } }
    if (x < w - 1) { const n = i + 1; if (!visited[n] && isBG(n)) { visited[n] = 1; queue[qt++] = n; } }
    if (y > 0) { const n = i - w; if (!visited[n] && isBG(n)) { visited[n] = 1; queue[qt++] = n; } }
    if (y < h - 1) { const n = i + w; if (!visited[n] && isBG(n)) { visited[n] = 1; queue[qt++] = n; } }
  }
  return cleared;
}

// ---------- 面积平均降采样（预乘 alpha） ----------
function downscale(srcW, srcH, src, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const fx = srcW / dstW, fy = srcH / dstH, area = fx * fy;
  for (let y = 0; y < dstH; y++) {
    const sy0 = y * fy, sy1 = sy0 + fy;
    for (let x = 0; x < dstW; x++) {
      const sx0 = x * fx, sx1 = sx0 + fx;
      let r = 0, g = 0, b = 0, a = 0;
      for (let iy = Math.floor(sy0); iy < Math.ceil(sy1); iy++) {
        const wy = Math.min(sy1, iy + 1) - Math.max(sy0, iy);
        if (wy <= 0) continue;
        for (let ix = Math.floor(sx0); ix < Math.ceil(sx1); ix++) {
          const wx = Math.min(sx1, ix + 1) - Math.max(sx0, ix);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const o = (iy * srcW + ix) * 4;
          const pa = src[o + 3] / 255;
          r += src[o] * pa * wgt; g += src[o + 1] * pa * wgt; b += src[o + 2] * pa * wgt;
          a += src[o + 3] * wgt;
        }
      }
      const A = a / area;
      const o = (y * dstW + x) * 4;
      if (A > 0.5) {
        const s = 255 / (A * area);
        dst[o] = Math.round(Math.min(255, r * s));
        dst[o + 1] = Math.round(Math.min(255, g * s));
        dst[o + 2] = Math.round(Math.min(255, b * s));
      }
      dst[o + 3] = Math.round(Math.min(255, A));
    }
  }
  return dst;
}

// ---------- ICO（PNG 载荷，Vista+） ----------
function buildICO(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let off = 6 + 16 * entries.length;
  const dir = [];
  for (const { size, buf } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(off, 12);
    off += buf.length;
    dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.buf)]);
}

// ---------- 主流程 ----------
const { w, h, rgba } = decodePNG(fs.readFileSync(SRC));
console.log(`decoded logo.png ${w}x${h}`);
const cleared = whiteBackgroundToTransparent(w, h, rgba);
console.log(`background cleared: ${cleared} px (${((cleared / (w * h)) * 100).toFixed(1)}%)`);

// icon.png 用 1024：macOS 打包要求 ≥512 才能自动转 icns（Windows 的多尺寸 ico 另行生成）
const sizes = [1024, 32];
for (const size of sizes) {
  const out = downscale(w, h, rgba, size, size);
  const file = path.join(ROOT, 'assets', size === 32 ? 'tray.png' : 'icon.png');
  fs.writeFileSync(file, encodePNG(size, size, out));
  console.log('wrote', path.relative(ROOT, file), size + 'x' + size);
}

const icoEntries = [16, 32, 48, 64, 128, 256].map((size) => ({
  size,
  buf: encodePNG(size, size, downscale(w, h, rgba, size, size)),
}));
const icoPath = path.join(ROOT, 'cache', 'icon.ico');
fs.mkdirSync(path.dirname(icoPath), { recursive: true });
fs.writeFileSync(icoPath, buildICO(icoEntries));
console.log('wrote', path.relative(ROOT, icoPath), `(${icoEntries.length} sizes)`);
