// Builds build/icon.ico from assets/icon-source.png (the Turtle Talks artwork).
// Rounds off the white corners with an SVG mask and packs PNG entries into ICO.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', 'icon-source.png');
const OUT_DIR = path.join(__dirname, '..', 'build');

function roundedMask(size) {
  const r = Math.round(size * 0.23);
  return Buffer.from(
    `<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  );
}

async function render(size) {
  // crop ~2.5% off each edge first — the artwork has a thin white margin
  const meta = await sharp(SRC).metadata();
  const inset = Math.round(meta.width * 0.025);
  return sharp(SRC)
    .extract({ left: inset, top: inset, width: meta.width - 2 * inset, height: meta.height - 2 * inset })
    .resize(size, size, { fit: 'cover' })
    .composite([{ input: roundedMask(size), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function main() {
  const sizes = [16, 32, 48, 256];
  const pngs = [];
  for (const s of sizes) pngs.push(await render(s));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = [];
  for (let i = 0; i < sizes.length; i++) {
    const e = Buffer.alloc(16);
    e[0] = sizes[i] === 256 ? 0 : sizes[i];
    e[1] = sizes[i] === 256 ? 0 : sizes[i];
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    entries.push(e);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), pngs[sizes.length - 1]);
  // clean rounded version for use inside the app's own UI
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), pngs[sizes.length - 1]);
  console.log('wrote build/icon.ico');
}

main().catch((e) => { console.error(e); process.exit(1); });
