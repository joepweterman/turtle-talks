// Generates build/icon.ico for the installer: a red record disc with a white
// mic glyph, drawn with distance functions in 256-space and scaled per size.
// Pure Node (reuses no deps) — PNG entries inside an ICO container.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
// distance to a rounded rectangle centered (cx,cy), half-size (hw,hh), radius r
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

// Everything defined in 256-space
function pixel(x, y) {
  const cx = 128;
  const discR = 118;
  const d = Math.hypot(x - cx, y - 128);
  const discA = clamp01(discR + 0.75 - d);
  if (discA <= 0) return [0, 0, 0, 0];

  // white mic glyph coverage
  let mic = 0;
  // capsule body
  mic = Math.max(mic, clamp01(0.75 - sdRoundRect(x, y, 128, 104, 22, 40, 22)));
  // holder: lower-half ring around (128,144), r 40, thickness 9
  if (y >= 144) {
    const rd = Math.abs(Math.hypot(x - 128, y - 144) - 40);
    mic = Math.max(mic, clamp01(9.5 - rd) * clamp01(y - 143.5));
  }
  // stem
  mic = Math.max(mic, clamp01(0.75 - sdRoundRect(x, y, 128, 192, 5, 10, 4)));
  // base bar
  mic = Math.max(mic, clamp01(0.75 - sdRoundRect(x, y, 128, 206, 26, 5, 5)));

  // red disc with subtle darker rim, white mic on top
  const rim = clamp01((d - (discR - 10)) / 10);
  const base = [Math.round(239 - 30 * rim), Math.round(68 - 14 * rim), Math.round(68 - 14 * rim)];
  const r = Math.round(base[0] + (255 - base[0]) * mic);
  const g = Math.round(base[1] + (255 - base[1]) * mic);
  const b = Math.round(base[2] + (255 - base[2]) * mic);
  return [r, g, b, discA];
}

function render(size) {
  const s = 256 / size;
  const rgba = Buffer.alloc(size * size * 4);
  const AA = 2; // 2x2 supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < AA; sy++) {
        for (let sx = 0; sx < AA; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / AA) * s, (y + (sy + 0.5) / AA) * s);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const n = AA * AA;
      const i = (y * size + x) * 4;
      rgba[i] = a ? Math.round(r / a) : 0;
      rgba[i + 1] = a ? Math.round(g / a) : 0;
      rgba[i + 2] = a ? Math.round(b / a) : 0;
      rgba[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, rgba);
}

const sizes = [16, 32, 48, 256];
const pngs = sizes.map((s) => render(s));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = [];
for (let i = 0; i < sizes.length; i++) {
  const e = Buffer.alloc(16);
  e[0] = sizes[i] === 256 ? 0 : sizes[i];
  e[1] = sizes[i] === 256 ? 0 : sizes[i];
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4);  // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
}
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const ico = Buffer.concat([header, ...entries, ...pngs]);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
// also drop a 256px png for reference/use elsewhere
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[sizes.length - 1]);
console.log('wrote', path.join(outDir, 'icon.ico'), `(${ico.length} bytes)`);
