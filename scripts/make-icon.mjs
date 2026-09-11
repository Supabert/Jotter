// Draws Jotter's source icon with no image libraries: a raw RGBA buffer
// deflated into a PNG by hand. `npx tauri icon` takes it from here.
//
// The mark is the product in one glyph — a panel with a thumb-tab down its
// left edge and two rules where the writing goes. It has to survive 16px in a
// system tray, so it is three shapes and nothing else.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 1024;
const px = (n) => Math.round((n / 100) * S);

const PANEL = [0x22, 0x26, 0x28, 255];
const BEZEL = [0x3a, 0x40, 0x42, 255];
const AMBER = [0xd6, 0x9a, 0x2e, 255];
const RULE = [0xcf, 0xd6, 0xd8, 255];
const CLEAR = [0, 0, 0, 0];

const buf = new Uint8Array(S * S * 4);

const put = (x, y, c, a = 1) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const sa = (c[3] / 255) * a;
  if (sa <= 0) return;
  const da = buf[i + 3] / 255;
  const out = sa + da * (1 - sa);
  for (let k = 0; k < 3; k++) {
    buf[i + k] = Math.round((c[k] * sa + buf[i + k] * da * (1 - sa)) / (out || 1));
  }
  buf[i + 3] = Math.round(out * 255);
};

// Signed distance to a rounded rectangle, so every edge in the mark gets the
// same antialiasing treatment rather than one shape looking crisper.
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
};

const fillRoundRect = (x0, y0, x1, y1, r, color) => {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2;
  const hh = (y1 - y0) / 2;
  const pad = 2;
  for (let y = Math.floor(y0 - pad); y <= Math.ceil(y1 + pad); y++) {
    for (let x = Math.floor(x0 - pad); x <= Math.ceil(x1 + pad); x++) {
      const d = sdRoundRect(x + 0.5, y + 0.5, cx, cy, hw, hh, r);
      const a = Math.min(1, Math.max(0, 0.5 - d));
      if (a > 0) put(x, y, color, a);
    }
  }
};

buf.fill(0);
void CLEAR;

// Bezel, then the panel inset inside it: one hairline of lighter metal is the
// only depth cue the whole design system allows.
fillRoundRect(px(4), px(4), px(96), px(96), px(9), BEZEL);
fillRoundRect(px(5.6), px(5.6), px(94.4), px(94.4), px(7.6), PANEL);

// The thumb tab.
fillRoundRect(px(16), px(24), px(28), px(76), px(2.5), AMBER);

// Two rules where the writing goes.
fillRoundRect(px(38), px(35), px(82), px(43), px(2.5), RULE);
fillRoundRect(px(38), px(53), px(70), px(61), px(2.5), RULE);

// --- PNG encoding ---------------------------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  Buffer.from(buf.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon-source.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${S}x${S}, ${png.length} bytes)`);
