"use strict";
/* make-icons.js — 零依赖生成 PWA 图标（暖色渐变底 + 白色爱心）
   用法: node tools/make-icons.js   （在项目根目录执行，输出到 icons/） */

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

/* ---------- PNG 编码（IHDR/IDAT/IEND） ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------- 图案：渐变底 + 白色爱心（经典隐式方程） ---------- */

function heartInside(nx, ny) {
  // (x^2 + y^2 - 1)^3 - x^2 * y^3 <= 0 ，y 向上
  const f = Math.pow(nx * nx + ny * ny - 1, 3) - nx * nx * ny * ny * ny;
  return f <= 0;
}

function makeIcon(size) {
  const top = [217, 129, 89];    // #d98159
  const bottom = [184, 94, 60];  // #b85e3c
  const cx = size / 2;
  const cy = size / 2 + size * 0.02;
  const scale = size * 0.27;     // 爱心占比约 54%，落在 maskable 安全区内
  const SS = 3;                  // 3x3 超采样抗锯齿

  return encodePng(size, (x, y) => {
    const t = y / size;
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t);

    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        const nx = (px - cx) / scale;
        const ny = (cy - py) / scale + 0.25; // 略上移做视觉居中
        if (heartInside(nx * 1.05, ny)) hits++;
      }
    }
    const cover = hits / (SS * SS);
    if (cover === 0) return [r, g, b, 255];
    return [
      Math.round(r + (255 - r) * cover),
      Math.round(g + (255 - g) * cover),
      Math.round(b + (255 - b) * cover),
      255
    ];
  });
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });

[
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180]
].forEach(([name, size]) => {
  const buf = makeIcon(size);
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log("wrote icons/" + name + " (" + buf.length + " bytes)");
});
