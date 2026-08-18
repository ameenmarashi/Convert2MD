/**
 * Post-compile step: build the service worker's precache list.
 *
 * The cache name is a content hash of everything shipped, so a rebuild that
 * changes any byte gets a new cache and the old one is dropped on activate.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const templatePath = join(root, 'scripts', 'sw-template.js');

const EXCLUDED = new Set(['sw.js', 'icons/launch-images.json']);
const EXCLUDED_EXTENSIONS = ['.map', '.DS_Store'];
// iOS fetches a launch image once, while installing to the Home Screen, and
// keeps it itself. Precaching all 16 would double the offline bundle for
// something the app never requests at runtime.
const EXCLUDED_PREFIXES = ['icons/launch-'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

if (!existsSync(join(publicDir, 'js', 'main.js'))) {
  console.error('build: public/js/main.js is missing — run `tsc -p tsconfig.json` first.');
  process.exit(1);
}

const files = walk(publicDir)
  .map((file) => relative(publicDir, file).split(sep).join('/'))
  .filter((file) => !EXCLUDED.has(file))
  .filter((file) => !EXCLUDED_EXTENSIONS.some((ext) => file.endsWith(ext)))
  .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
  .sort();

const hash = createHash('sha256');
for (const file of files) {
  hash.update(file);
  hash.update(readFileSync(join(publicDir, file)));
}
const version = hash.digest('hex').slice(0, 12);

const precache = ['./', ...files.map((file) => `./${file}`)];
const template = readFileSync(templatePath, 'utf8');
const output = template
  .replace('__CACHE_NAME__', `md-converter-${version}`)
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2));

writeFileSync(join(publicDir, 'sw.js'), output);

const totalBytes = files.reduce((sum, file) => sum + statSync(join(publicDir, file)).size, 0);
console.log(`build: service worker ready — ${files.length} assets, ${(totalBytes / 1024).toFixed(0)} KB, cache md-converter-${version}`);
