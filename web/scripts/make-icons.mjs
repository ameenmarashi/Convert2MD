/**
 * Generates every branded image from ../../brand.json:
 *
 *   web/public/icons/          PWA icons, favicon, Apple touch icon, iOS launch images
 *   flutter_app/assets/branding/  1024px icon source + splash logo for the native apps
 *
 * The monogram is drawn as geometry rather than set in a typeface, so the same
 * letterforms come out identically on every machine with no font dependency and
 * no rasteriser. Shapes are evaluated per sub-pixel sample (4×4 supersampling),
 * and the PNG encoder is a thin wrapper over node:zlib.
 *
 * Run with `npm run icons` after editing brand.json.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const iconsDir = join(here, '..', 'public', 'icons');
const flutterAssets = join(repoRoot, 'flutter_app', 'assets', 'branding');

const brand = JSON.parse(readFileSync(join(repoRoot, 'brand.json'), 'utf8'));
const SAMPLES = 4;
const DESIGN = 512;

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const GRADIENT_START = hexToRgb(brand.gradientStart);
const GRADIENT_END = hexToRgb(brand.gradientEnd);
const ON_GRADIENT = hexToRgb(brand.onGradient);
const ACCENT = hexToRgb(brand.accent);

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

/**
 * The `MD` monogram, drawn in a 512×512 design space.
 *
 * `M` is four capsule strokes (two stems, two diagonals meeting at the vee);
 * `D` is a stem plus the ring left between an outer and an inner rounded rect,
 * which is what gives the bowl an even weight all the way round.
 */
function insideMonogram(x, y) {
  const stroke = DESIGN * brand.strokeRatio;
  const half = stroke / 2;
  const capHeight = DESIGN * brand.capHeightRatio;

  const top = (DESIGN - capHeight) / 2;
  const bottom = top + capHeight;

  const mWidth = capHeight * 0.92;
  const dWidth = capHeight * 0.78;
  const gap = stroke * 0.72;
  const totalWidth = mWidth + gap + dWidth;
  const left = (DESIGN - totalWidth) / 2;

  // M
  const mLeft = left + half;
  const mRight = left + mWidth - half;
  const mMiddle = (mLeft + mRight) / 2;
  const vee = top + capHeight * 0.62;

  if (insideCapsule(x, y, mLeft, bottom - half, mLeft, top + half, half)) return true;
  if (insideCapsule(x, y, mRight, bottom - half, mRight, top + half, half)) return true;
  if (insideCapsule(x, y, mLeft, top + half, mMiddle, vee, half)) return true;
  if (insideCapsule(x, y, mRight, top + half, mMiddle, vee, half)) return true;

  // D
  const dLeft = left + mWidth + gap;
  const dRight = dLeft + dWidth;
  const outerRadius = capHeight * 0.46;
  const innerRadius = Math.max(4, outerRadius - stroke);

  if (insideCapsule(x, y, dLeft + half, top + half, dLeft + half, bottom - half, half)) return true;

  const inOuter = insideRoundRect(x, y, dLeft, top, dRight, bottom, outerRadius);
  const inInner = insideRoundRect(
    x,
    y,
    dLeft + stroke,
    top + stroke,
    dRight - stroke,
    bottom - stroke,
    innerRadius
  );
  return inOuter && !inInner;
}

function gradientAt(x, y) {
  const mix = Math.min(1, Math.max(0, (x + y) / (DESIGN * 2)));
  return [
    Math.round(GRADIENT_START[0] + (GRADIENT_END[0] - GRADIENT_START[0]) * mix),
    Math.round(GRADIENT_START[1] + (GRADIENT_END[1] - GRADIENT_START[1]) * mix),
    Math.round(GRADIENT_START[2] + (GRADIENT_END[2] - GRADIENT_START[2]) * mix),
  ];
}

/** Colour at a design-space point, or null for transparent. */
function sampleIcon(x, y, { fullBleed, rounded = true }) {
  const inBackground =
    fullBleed || !rounded || insideRoundRect(x, y, 0, 0, DESIGN, DESIGN, DESIGN * brand.cornerRadiusRatio);
  if (!inBackground) return null;
  return insideMonogram(x, y) ? ON_GRADIENT : gradientAt(x, y);
}

/** The monogram in the on-gradient colour, for Android's adaptive foreground. */
function sampleForeground(x, y) {
  return insideMonogram(x, y) ? ON_GRADIENT : null;
}

/** The gradient alone, for Android's adaptive background layer. */
function sampleBackground(x, y) {
  return gradientAt(x, y);
}

/** The monogram alone, in the accent colour, for splash screens. */
function sampleLogo(x, y) {
  return insideMonogram(x, y) ? ACCENT : null;
}

/* ------------------------------------------------------------- rasterising */

function render(size, sampler, { maskable = false, scale = 1, background = null } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = DESIGN / size;
  const contentScale = maskable ? 0.68 : scale;
  const offset = (DESIGN * (1 - contentScale)) / 2;
  const bg = background ? hexToRgb(background) : null;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = (px + (sx + 0.5) / SAMPLES) * step;
          const dy = (py + (sy + 0.5) / SAMPLES) * step;
          const x = contentScale === 1 ? dx : (dx - offset) / contentScale;
          const y = contentScale === 1 ? dy : (dy - offset) / contentScale;
          const colour = sampler(x, y);
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            hits++;
          }
        }
      }

      const total = SAMPLES * SAMPLES;
      const index = (py * size + px) * 4;
      const alpha = Math.round((hits / total) * 255);

      if (bg) {
        // Composite over an opaque background instead of leaving it transparent.
        const cover = hits === 0 ? 0 : hits / total;
        const fr = hits === 0 ? 0 : r / hits;
        const fg = hits === 0 ? 0 : g / hits;
        const fb = hits === 0 ? 0 : b / hits;
        pixels[index] = Math.round(bg[0] * (1 - cover) + fr * cover);
        pixels[index + 1] = Math.round(bg[1] * (1 - cover) + fg * cover);
        pixels[index + 2] = Math.round(bg[2] * (1 - cover) + fb * cover);
        pixels[index + 3] = 255;
      } else {
        pixels[index] = hits ? Math.round(r / hits) : 0;
        pixels[index + 1] = hits ? Math.round(g / hits) : 0;
        pixels[index + 2] = hits ? Math.round(b / hits) : 0;
        pixels[index + 3] = alpha;
      }
    }
  }
  return { pixels, width: size, height: size };
}

/** A launch image: flat background with the monogram centred. */
function renderLaunch(width, height, background) {
  const pixels = Buffer.alloc(width * height * 4);
  const bg = hexToRgb(background);
  const logoSize = Math.round(Math.min(width, height) * 0.28);
  const originX = Math.round((width - logoSize) / 2);
  const originY = Math.round((height - logoSize) / 2);
  const logo = render(logoSize, sampleLogo, { scale: 0.92 });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      pixels[index] = bg[0];
      pixels[index + 1] = bg[1];
      pixels[index + 2] = bg[2];
      pixels[index + 3] = 255;
    }
  }

  for (let y = 0; y < logoSize; y++) {
    for (let x = 0; x < logoSize; x++) {
      const src = (y * logoSize + x) * 4;
      const alpha = logo.pixels[src + 3] / 255;
      if (alpha === 0) continue;
      const dst = ((originY + y) * width + (originX + x)) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[dst + c] = Math.round(bg[c] * (1 - alpha) + logo.pixels[src + c] * alpha);
      }
    }
  }
  return { pixels, width, height };
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

function encodePng({ pixels, width, height }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- main */

mkdirSync(iconsDir, { recursive: true });
mkdirSync(flutterAssets, { recursive: true });

let bytesWritten = 0;
function emit(path, image) {
  const png = encodePng(image);
  writeFileSync(path, png);
  bytesWritten += png.length;
  return png.length;
}

// PWA and Flutter icons.
const icons = [
  [join(iconsDir, 'icon-192.png'), 192, {}],
  [join(iconsDir, 'icon-512.png'), 512, {}],
  [join(iconsDir, 'maskable-512.png'), 512, { maskable: true }],
  [join(iconsDir, 'apple-touch-icon.png'), 180, { fullBleed: true }],
  [join(iconsDir, 'favicon-32.png'), 32, {}],
  [join(flutterAssets, 'icon-1024.png'), 1024, { fullBleed: true }],
];

for (const [path, size, options] of icons) {
  const image = render(size, (x, y) => sampleIcon(x, y, { fullBleed: options.fullBleed ?? false }), options);
  const written = emit(path, image);
  console.log(`icon    ${path.split('/').slice(-2).join('/')} — ${size}×${size}, ${(written / 1024).toFixed(1)} KB`);
}

// Android draws its adaptive icon as two layers and crops them to whatever mask
// the launcher uses, so the mark has to sit inside the 66% safe zone with the
// gradient supplied separately — that is what keeps it identical to iOS.
const adaptive = [
  ['icon-foreground-1024.png', sampleForeground, { scale: 0.62 }],
  ['icon-background-1024.png', sampleBackground, {}],
];
for (const [name, sampler, options] of adaptive) {
  const written = emit(join(flutterAssets, name), render(1024, sampler, options));
  console.log(`icon    branding/${name} — 1024×1024, ${(written / 1024).toFixed(1)} KB`);
}

// Splash logo for flutter_native_splash: monogram only, transparent behind.
const splashLogo = render(1024, sampleLogo, { scale: 0.9 });
console.log(
  `splash  flutter_app/assets/branding/splash-logo.png — ${(emit(join(flutterAssets, 'splash-logo.png'), splashLogo) / 1024).toFixed(1)} KB`
);

// iOS launch images for the installed PWA. Android generates its own splash
// from the manifest, so both platforms land on the same mark and background.
const LAUNCH_SIZES = [
  [1290, 2796], [1179, 2556], [1170, 2532], [1125, 2436],
  [828, 1792], [750, 1334], [1536, 2048], [2048, 2732],
];

const launchManifest = [];
for (const [width, height] of LAUNCH_SIZES) {
  for (const scheme of ['light', 'dark']) {
    const background = scheme === 'dark' ? brand.splashBackgroundDark : brand.splashBackground;
    const name = `launch-${width}x${height}-${scheme}.png`;
    emit(join(iconsDir, name), renderLaunch(width, height, background));
    launchManifest.push({ name, width, height, scheme });
  }
}
console.log(`launch  ${launchManifest.length} iOS launch images`);

writeFileSync(
  join(iconsDir, 'launch-images.json'),
  `${JSON.stringify(launchManifest, null, 2)}\n`
);

console.log(`total   ${(bytesWritten / 1024).toFixed(0)} KB of generated imagery`);
