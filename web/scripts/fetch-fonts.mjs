/**
 * Re-downloads the self-hosted IBM Plex Mono subsets from Google Fonts.
 *
 * The app must run with no network, so the typeface is served from
 * public/fonts/ rather than linked from a CDN. Run this only when the weights
 * or subsets change; the result is committed.
 */

import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
const fontsDir = join(publicDir, 'fonts');
const WANTED_SUBSETS = new Set(['latin', 'latin-ext']);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

mkdirSync(fontsDir, { recursive: true });

const css = await (
  await fetch('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap', {
    headers: { 'User-Agent': UA },
  })
).text();

const faces = [];
for (const [, subset, body] of css.matchAll(/\/\* (\S+) \*\/\s*@font-face \{([\s\S]*?)\}/g)) {
  if (!WANTED_SUBSETS.has(subset)) continue;
  const weight = body.match(/font-weight: (\d+)/)[1];
  const url = body.match(/url\((\S+?)\)/)[1];
  const unicodeRange = body.match(/unicode-range: ([^;]+);/)[1].trim();
  const name = `ibm-plex-mono-${weight}-${subset}.woff2`;

  const data = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(join(fontsDir, name), data);
  faces.push({ weight, subset, name, unicodeRange });
  console.log(`${name} — ${(data.length / 1024).toFixed(1)} KB`);
}

faces.sort((a, b) => a.weight.localeCompare(b.weight) || a.subset.localeCompare(b.subset));

const stylesheet = [
  '/* IBM Plex Mono — self-hosted so the app keeps working with no network.',
  ' * Copyright 2017 IBM Corp. Licensed under the SIL Open Font License 1.1.',
  ' * See fonts/OFL.txt. Regenerate with scripts/fetch-fonts.mjs.',
  ' */',
  '',
  ...faces.flatMap((face) => [
    '@font-face {',
    "  font-family: 'IBM Plex Mono';",
    '  font-style: normal;',
    `  font-weight: ${face.weight};`,
    '  font-display: swap;',
    `  src: url('fonts/${face.name}') format('woff2');`,
    `  unicode-range: ${face.unicodeRange};`,
    '}',
    '',
  ]),
].join('\n');

writeFileSync(join(publicDir, 'fonts.css'), stylesheet);
console.log(`wrote public/fonts.css — ${faces.length} faces`);
