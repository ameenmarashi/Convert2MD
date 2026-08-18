/**
 * Generates the PNG app icons from the same shapes as icons/icon.svg.
 *
 * Written by hand (scanline coverage + a minimal PNG encoder over node:zlib)
 * so the build has no image dependencies and produces byte-identical output on
 * every machine. Run with `npm run icons` after changing the artwork.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SAMPLES = 4;

const COLORS = {
  gradientStart: [99, 102, 241],
  gradientEnd: [6, 182, 212],
  sheet: [255, 255, 255],
  fold: [199, 210, 254],
  accent: [79, 70, 229],
};

/* --------------------------------------------------------------- geometry */

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insideCapsule(x, y, ax, ay, bx, by, halfWidth) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return (x - px) ** 2 + (y - py) ** 2 <= halfWidth * halfWidth;
}

/** Colour of the artwork at a point in the 512×512 design space. */
function sample(x, y, { fullBleed }) {
  const background = fullBleed || insideRoundRect(x, y, 0, 0, 512, 512, 114);
  if (!background) return null;

  const mix = Math.min(1, Math.max(0, (x + y) / 1024));
  let color = [
    Math.round(COLORS.gradientStart[0] + (COLORS.gradientEnd[0] - COLORS.gradientStart[0]) * mix),
    Math.round(COLORS.gradientStart[1] + (COLORS.gradientEnd[1] - COLORS.gradientStart[1]) * mix),
    Math.round(COLORS.gradientStart[2] + (COLORS.gradientEnd[2] - COLORS.gradientStart[2]) * mix),
  ];

  const inSheet = insideRoundRect(x, y, 128, 96, 386, 440, 26);
  const inCorner = x >= 282 && y <= 200;
  const aboveFold = x - 282 > y - 96;

  if (inSheet && !(inCorner && aboveFold)) {
    color = inCorner ? COLORS.fold : COLORS.sheet;

    const onStem = insideCapsule(x, y, 256, 236, 256, 324, 13);
    const onLeft = insideCapsule(x, y, 214, 284, 256, 326, 13);
    const onRight = insideCapsule(x, y, 298, 284, 256, 326, 13);
    const onBar = insideRoundRect(x, y, 196, 356, 316, 378, 11);
    if (onStem || onLeft || onRight || onBar) color = COLORS.accent;
  }

  return color;
}

function render(size, { maskable = false, fullBleed = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  const contentScale = maskable ? 0.68 : 1;
  const offset = (512 * (1 - contentScale)) / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = (px + (sx + 0.5) / SAMPLES) * scale;
          const dy = (py + (sy + 0.5) / SAMPLES) * scale;
          const x = maskable ? (dx - offset) / contentScale : dx;
          const y = maskable ? (dy - offset) / contentScale : dy;

          const color = maskable
            ? sample(Math.min(Math.max(x, 0), 512), Math.min(Math.max(y, 0), 512), { fullBleed: true })
            : sample(x, y, { fullBleed });

          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }

      const total = SAMPLES * SAMPLES;
      const index = (py * size + px) * 4;
      const alpha = a / total;
      const opaqueSamples = a / 255 || 1;
      pixels[index] = Math.round(r / opaqueSamples);
      pixels[index + 1] = Math.round(g / opaqueSamples);
      pixels[index + 2] = Math.round(b / opaqueSamples);
      pixels[index + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

/* -------------------------------------------------------------------- PNG */

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
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- main */

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, options: {} },
  { file: 'icon-512.png', size: 512, options: {} },
  { file: 'maskable-512.png', size: 512, options: { maskable: true } },
  { file: 'apple-touch-icon.png', size: 180, options: { fullBleed: true } },
  { file: 'favicon-32.png', size: 32, options: {} },
];

for (const target of targets) {
  const png = encodePng(render(target.size, target.options), target.size);
  writeFileSync(join(OUT_DIR, target.file), png);
  console.log(`icons: ${target.file} (${target.size}×${target.size}, ${(png.length / 1024).toFixed(1)} KB)`);
}
