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

const SQUARE_TERMINALS = brand.terminals === 'square';

/** Draws a stroke with the terminal style the brand calls for. */
function insideStroke(x, y, ax, ay, bx, by, halfWidth) {
  return SQUARE_TERMINALS
    ? insideBar(x, y, ax, ay, bx, by, halfWidth)
    : insideCapsule(x, y, ax, ay, bx, by, halfWidth);
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

/** A stroke with square ends, for the monospace-slab feel of the Rx Suite face. */
function insideBar(x, y, ax, ay, bx, by, halfWidth) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length === 0) return false;
  const ux = dx / length;
  const uy = dy / length;
  const along = (x - ax) * ux + (y - ay) * uy;
  const across = -(x - ax) * uy + (y - ay) * ux;
  return along >= -0.0001 && along <= length && Math.abs(across) <= halfWidth;
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

  const mWidth = capHeight * 0.86;
  const dWidth = capHeight * 0.72;
  const gap = stroke * 1.3;
  const totalWidth = mWidth + gap + dWidth;
  const left = (DESIGN - totalWidth) / 2;

  // M
  const mLeft = left + half;
  const mRight = left + mWidth - half;
  const mMiddle = (mLeft + mRight) / 2;
  const vee = top + capHeight * 0.62;

  if (insideStroke(x, y, mLeft, bottom, mLeft, top, half)) return true;
  if (insideStroke(x, y, mRight, bottom, mRight, top, half)) return true;

  // Square terminals would leave a notch where the two diagonals meet, so each
  // one runs past the vee and the pair is then clipped to the band the stems
  // occupy: flat across the top, mitred to a point at the bottom of the joint.
  // `veeFloor` is where the two outer edges cross — the true tip of the vee.
  const runX = mMiddle - mLeft;
  const runY = vee - top;
  const cos = runX / Math.hypot(runX, runY);
  const veeFloor = vee + half / cos;
  if (y >= top && y <= veeFloor) {
    const reach = half / cos + half;
    const extend = (ax, ay, bx, by) => {
      const length = Math.hypot(bx - ax, by - ay);
      return [bx + ((bx - ax) / length) * reach, by + ((by - ay) / length) * reach];
    };
    const [leftTipX, leftTipY] = extend(mLeft, top, mMiddle, vee);
    const [rightTipX, rightTipY] = extend(mRight, top, mMiddle, vee);
    if (insideStroke(x, y, mLeft, top, leftTipX, leftTipY, half)) return true;
    if (insideStroke(x, y, mRight, top, rightTipX, rightTipY, half)) return true;
  }

  // D
  const dLeft = left + mWidth + gap;
  const dRight = dLeft + dWidth;
  const outerRadius = capHeight * 0.46;
  const innerRadius = Math.max(4, outerRadius - stroke);

  if (insideStroke(x, y, dLeft + half, top, dLeft + half, bottom, half)) return true;

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

/**
 * A launch image: flat background with the monogram centred.
 *
 * Every pixel is the background mixed with the accent by one alpha value, so
 * the whole image fits a small palette. Emitting it as an indexed PNG rather
 * than RGBA cuts the raw bytes to a quarter before deflate even starts — which
 * is what keeps covering every iOS device size at both orientations from
 * costing megabytes.
 */
const LAUNCH_LEVELS = 64;

function renderLaunch(width, height, background) {
  const bg = hexToRgb(background);
  const palette = [];
  for (let level = 0; level <= LAUNCH_LEVELS; level++) {
    const t = level / LAUNCH_LEVELS;
    palette.push([
      Math.round(bg[0] + (ACCENT[0] - bg[0]) * t),
      Math.round(bg[1] + (ACCENT[1] - bg[1]) * t),
      Math.round(bg[2] + (ACCENT[2] - bg[2]) * t),
    ]);
  }

  // Index 0 is the background, so the field needs no writing at all.
  const indices = Buffer.alloc(width * height);
  const logoSize = Math.round(Math.min(width, height) * 0.28);
  const originX = Math.round((width - logoSize) / 2);
  const originY = Math.round((height - logoSize) / 2);
  const logo = render(logoSize, sampleLogo, { scale: 0.92 });

  for (let y = 0; y < logoSize; y++) {
    for (let x = 0; x < logoSize; x++) {
      const alpha = logo.pixels[(y * logoSize + x) * 4 + 3];
      if (alpha === 0) continue;
      indices[(originY + y) * width + (originX + x)] = Math.round((alpha / 255) * LAUNCH_LEVELS);
    }
  }
  return { indices, palette, width, height };
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

/**
 * Picks a row filter per scanline by the usual minimum-sum-of-absolute-
 * differences heuristic. Launch images are a flat field with a small logo, and
 * a filtered flat row deflates to almost nothing — it takes them from ~25 KB
 * each to a couple, which is what makes covering every iOS device size viable.
 */
function filterRow(row, prior, bpp, out) {
  const length = row.length;
  const candidates = [];

  for (let type = 0; type < 5; type++) {
    const line = Buffer.alloc(length);
    let score = 0;
    for (let i = 0; i < length; i++) {
      const raw = row[i];
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prior[i];
      const upLeft = i >= bpp ? prior[i - bpp] : 0;
      let value;
      switch (type) {
        case 0: value = raw; break;
        case 1: value = raw - left; break;
        case 2: value = raw - up; break;
        case 3: value = raw - ((left + up) >> 1); break;
        default: value = raw - paeth(left, up, upLeft); break;
      }
      const byte = value & 0xff;
      line[i] = byte;
      // Signed magnitude: bytes near 0 or 255 are both cheap to deflate.
      score += byte < 128 ? byte : 256 - byte;
    }
    candidates.push({ type, line, score });
  }

  const best = candidates.reduce((a, b) => (b.score < a.score ? b : a));
  out[0] = best.type;
  best.line.copy(out, 1);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function encodePng({ pixels, width, height }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  let prior = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    filterRow(row, prior, 4, raw.subarray(y * (stride + 1), (y + 1) * (stride + 1)));
    prior = row;
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

/** Indexed PNG (colour type 3). The spec advises no filtering for these. */
function encodeIndexedPng({ indices, palette, width, height }) {
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    indices.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;

  const plte = Buffer.alloc(palette.length * 3);
  for (const [index, [r, g, b]] of palette.entries()) {
    plte[index * 3] = r;
    plte[index * 3 + 1] = g;
    plte[index * 3 + 2] = b;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- main */

mkdirSync(iconsDir, { recursive: true });
mkdirSync(flutterAssets, { recursive: true });

let bytesWritten = 0;
function emit(path, image) {
  const png = image.indices ? encodeIndexedPng(image) : encodePng(image);
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
//
// iOS matches one `apple-touch-startup-image` by an exact media query on the
// device's CSS size and pixel ratio, and shows a blank white screen when
// nothing matches. Both orientations need an entry — device-width and
// device-height swap when the device is held sideways, which is why an iPad in
// landscape used to get nothing — and every current device size needs a row,
// so a missing model does not fall back to white.
const DEVICES = [
  // iPhone                                    css w   css h  dpr
  { name: 'iPhone SE (1st gen)',               w: 320, h: 568, dpr: 2 },
  { name: 'iPhone SE, 6/7/8',                  w: 375, h: 667, dpr: 2 },
  { name: 'iPhone 6/7/8 Plus',                 w: 414, h: 736, dpr: 3 },
  { name: 'iPhone X, XS, 11 Pro, 12/13 mini',  w: 375, h: 812, dpr: 3 },
  { name: 'iPhone XR, 11',                     w: 414, h: 896, dpr: 2 },
  { name: 'iPhone XS Max, 11 Pro Max',         w: 414, h: 896, dpr: 3 },
  { name: 'iPhone 12/13/14',                   w: 390, h: 844, dpr: 3 },
  { name: 'iPhone 14 Pro, 15, 16',             w: 393, h: 852, dpr: 3 },
  { name: 'iPhone 16 Pro',                     w: 402, h: 874, dpr: 3 },
  { name: 'iPhone 12/13/14 Plus, 14 Pro Max',  w: 428, h: 926, dpr: 3 },
  { name: 'iPhone 15/16 Plus, 15 Pro Max',     w: 430, h: 932, dpr: 3 },
  { name: 'iPhone 16 Pro Max',                 w: 440, h: 956, dpr: 3 },
  // iPad
  { name: 'iPad mini 6',                       w: 744, h: 1133, dpr: 2 },
  { name: 'iPad 9.7", mini, Air',              w: 768, h: 1024, dpr: 2 },
  { name: 'iPad 10.2"',                        w: 810, h: 1080, dpr: 2 },
  { name: 'iPad Air, iPad 10th gen',           w: 820, h: 1180, dpr: 2 },
  { name: 'iPad Pro 10.5"',                    w: 834, h: 1112, dpr: 2 },
  { name: 'iPad Pro 11", Air 11"',             w: 834, h: 1194, dpr: 2 },
  { name: 'iPad Pro 12.9", 13"',               w: 1024, h: 1366, dpr: 2 },
];

const launchManifest = [];
for (const device of DEVICES) {
  for (const orientation of ['portrait', 'landscape']) {
    const portrait = orientation === 'portrait';
    const cssWidth = portrait ? device.w : device.h;
    const cssHeight = portrait ? device.h : device.w;
    const width = cssWidth * device.dpr;
    const height = cssHeight * device.dpr;

    for (const scheme of ['light', 'dark']) {
      const background = scheme === 'dark' ? brand.splashBackgroundDark : brand.splashBackground;
      const name = `launch-${width}x${height}-${scheme}.png`;
      emit(join(iconsDir, name), renderLaunch(width, height, background));
      launchManifest.push({
        name,
        width,
        height,
        cssWidth,
        cssHeight,
        dpr: device.dpr,
        orientation,
        scheme,
        device: device.name,
      });
    }
  }
}
console.log(`launch  ${launchManifest.length} iOS launch images for ${DEVICES.length} device sizes`);

// Rewrite the <link> block in index.html from the same table, so the markup and
// the images on disk can never drift apart. A light entry has no colour-scheme
// clause so it also serves as the fallback; the dark one follows it, and iOS
// takes the last matching link.
const launchLinks = launchManifest
  .map((image) => {
    const media = [
      `(device-width: ${image.cssWidth}px)`,
      `(device-height: ${image.cssHeight}px)`,
      `(-webkit-device-pixel-ratio: ${image.dpr})`,
      `(orientation: ${image.orientation})`,
      image.scheme === 'dark' ? '(prefers-color-scheme: dark)' : '',
    ]
      .filter(Boolean)
      .join(' and ');
    return `<link rel="apple-touch-startup-image" href="icons/${image.name}" media="${media}">`;
  })
  .join('\n');

const indexPath = join(here, '..', 'public', 'index.html');
const marker = /<!-- launch-images:start[^>]*-->[\s\S]*?<!-- launch-images:end -->/;
const html = readFileSync(indexPath, 'utf8');
if (!marker.test(html)) {
  console.error('icons: index.html has no <!-- launch-images:start --> block to fill.');
  process.exit(1);
}
writeFileSync(
  indexPath,
  html.replace(
    marker,
    `<!-- launch-images:start (generated by scripts/make-icons.mjs — do not edit by hand) -->\n${launchLinks}\n<!-- launch-images:end -->`
  )
);
console.log(`launch  index.html rewritten with ${launchManifest.length} startup-image links`);

writeFileSync(
  join(iconsDir, 'launch-images.json'),
  `${JSON.stringify(launchManifest, null, 2)}\n`
);

console.log(`total   ${(bytesWritten / 1024).toFixed(0)} KB of generated imagery`);
