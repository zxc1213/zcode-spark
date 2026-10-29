/*
图标生成：纯 Node 画一张星芒图（RGBA），编码 PNG，再打包成多尺寸 ICO。
避免依赖 sharp/canvas，也让仓库里不用放二进制资源。
*/
import fs from "node:fs";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function roundedRectCoverage(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.max(Math.abs(x - half) - (half - radius), 0);
  const dy = Math.max(Math.abs(y - half) - (half - radius), 0);
  return Math.hypot(dx, dy) <= radius ? 1 : 0;
}

// 四角星：|u|^p + |v|^p <= r^p，p < 1 时星角内凹
function starCoverage(x, y, cx, cy, radius, p) {
  const u = Math.abs(x - cx) / radius;
  const v = Math.abs(y - cy) / radius;
  return Math.pow(u, p) + Math.pow(v, p) <= 1 ? 1 : 0;
}

function renderIcon(size) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 3; // 3x3 超采样
  const radius = size * 0.23;
  const p = 0.62;
  const main = { cx: size * 0.44, cy: size * 0.5, r: size * 0.31 };
  const small = { cx: size * 0.745, cy: size * 0.285, r: size * 0.135 };
  const dot = { cx: size * 0.72, cy: size * 0.735, r: size * 0.065 };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0, glyphHits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (roundedRectCoverage(px, py, size, radius)) bgHits++;
          if (starCoverage(px, py, main.cx, main.cy, main.r, p)
            || starCoverage(px, py, small.cx, small.cy, small.r, p)
            || Math.hypot(px - dot.cx, py - dot.cy) <= dot.r) glyphHits++;
        }
      }
      const total = ss * ss;
      const bg = bgHits / total;
      const glyph = Math.min(glyphHits / total, bg);
      const t = clamp01((x / size) * 0.55 + (y / size) * 0.45);
      let r = Math.round(lerp(0x4f, 0x8b, t));   // #4F46E5 → #8B5CF6
      let g = Math.round(lerp(0x46, 0x5c, t));
      let b = Math.round(lerp(0xe5, 0xf6, t));
      r = Math.round(lerp(r, 255, glyph));
      g = Math.round(lerp(g, 255, glyph));
      b = Math.round(lerp(b, 255, glyph));
      const i = (y * size + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b;
      out[i + 3] = Math.round(bg * 255);
    }
  }
  return out;
}

function packIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, png } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

export function writeIcon(filePath, sizes = [256, 64, 48, 32, 16]) {
  const pngs = sizes.map((size) => ({ size, png: encodePng(size, size, renderIcon(size)) }));
  fs.writeFileSync(filePath, packIco(pngs));
  return filePath;
}

export function writePng(filePath, size = 256) {
  fs.writeFileSync(filePath, encodePng(size, size, renderIcon(size)));
  return filePath;
}
