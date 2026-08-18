import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, deflateRawSync } from 'node:zlib';

import { inflate, inflateRaw, crc32 } from '../public/js/core/inflate.js';
import { ZipArchive, writeZip } from '../public/js/core/zip.js';
import { renderTable, normalizeMarkdown, toBase64 } from '../public/js/core/md.js';
import { parseHtml, parseXml, descendants, attr, textOf } from '../public/js/core/xml.js';
import { convertFile, detectFormat } from '../public/js/core/convert.js';
import { DEFAULT_OPTIONS } from '../public/js/core/types.js';
import { sniffDelimiter, parseDelimited } from '../public/js/converters/csv.js';
import {
  makeCsv, makeDocx, makeEml, makeEpub, makeHtml, makeOdt, makePdf, makePptx, makeRtf, makeXlsx,
  sourceFile,
} from './fixtures.mjs';

const options = { ...DEFAULT_OPTIONS };

function convert(name, data, overrides = {}) {
  return convertFile(sourceFile(name, data), { ...options, ...overrides });
}

/* ------------------------------------------------------------------ inflate */

test('inflate matches zlib for text and binary payloads', () => {
  const samples = [
    Buffer.from('the quick brown fox '.repeat(500)),
    Buffer.from(Array.from({ length: 40000 }, (_, i) => (i * 2654435761) % 251)),
    Buffer.alloc(0),
    Buffer.from('a'),
  ];

  for (const sample of samples) {
    const zlibbed = new Uint8Array(deflateSync(sample));
    assert.deepEqual(Buffer.from(inflate(zlibbed)), sample, 'zlib-wrapped stream');

    const raw = new Uint8Array(deflateRawSync(sample));
    assert.deepEqual(Buffer.from(inflateRaw(raw, 0)), sample, 'raw deflate stream');
  }
});

test('inflate handles stored (uncompressed) blocks', () => {
  const sample = Buffer.from('stored blocks stay verbatim');
  const raw = new Uint8Array(deflateRawSync(sample, { level: 0 }));
  assert.equal(Buffer.from(inflateRaw(raw, 0)).toString(), sample.toString());
});

test('crc32 matches the known check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

/* ---------------------------------------------------------------------- zip */

test('zip writer and reader round-trip', () => {
  const encoder = new TextEncoder();
  const archive = writeZip([
    { name: 'a.md', data: encoder.encode('# Alpha') },
    { name: 'nested/b.txt', data: encoder.encode('beta ✓') },
  ]);

  const zip = ZipArchive.open(archive);
  assert.deepEqual(zip.names.sort(), ['a.md', 'nested/b.txt']);
  assert.equal(zip.readText('a.md'), '# Alpha');
  assert.equal(zip.readText('nested/b.txt'), 'beta ✓');
  assert.equal(zip.read('missing.txt'), null);
});

test('zip reader inflates deflated entries', () => {
  // Hand-built archive with a single DEFLATE entry, mirroring real producers.
  const encoder = new TextEncoder();
  const payload = encoder.encode('compressed content '.repeat(50));
  const compressed = new Uint8Array(deflateRawSync(Buffer.from(payload)));
  const name = encoder.encode('big.txt');

  const local = new Uint8Array(30 + name.length + compressed.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(14, crc32(payload), true);
  lv.setUint32(18, compressed.length, true);
  lv.setUint32(22, payload.length, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(compressed, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc32(payload), true);
  cv.setUint32(20, compressed.length, true);
  cv.setUint32(24, payload.length, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, 0, true);
  central.set(name, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);

  const bytes = new Uint8Array(local.length + central.length + eocd.length);
  bytes.set(local, 0);
  bytes.set(central, local.length);
  bytes.set(eocd, local.length + central.length);

  assert.equal(ZipArchive.open(bytes).readText('big.txt'), 'compressed content '.repeat(50));
});

/* ---------------------------------------------------------------- markdown */

test('table renderer pads columns and escapes pipes', () => {
  const table = renderTable([
    ['Name', 'Value'],
    ['a|b', '2'],
  ]);
  assert.match(table, /\| Name \| Value \|/);
  assert.match(table, /a\\\|b/);
});

test('normalizeMarkdown collapses blank runs and keeps hard breaks', () => {
  assert.equal(normalizeMarkdown('a\n\n\n\nb  \nc   '), 'a\n\nb  \nc\n');
});

test('base64 encoder matches Buffer', () => {
  const data = Uint8Array.from([0, 1, 2, 250, 251, 252, 253]);
  assert.equal(toBase64(data), Buffer.from(data).toString('base64'));
});

/* --------------------------------------------------------------------- xml */

test('html parser recovers from unclosed tags', () => {
  const root = parseHtml('<ul><li>one<li>two</ul><p>tail');
  const items = descendants(root, 'li');
  assert.equal(items.length, 2);
  assert.equal(textOf(items[0]).trim(), 'one');
  assert.equal(descendants(root, 'p').length, 1);
});

test('xml parser keeps namespace prefixes and decodes entities', () => {
  const root = parseXml('<w:p xmlns:w="x"><w:t xml:space="preserve">a &amp; b</w:t></w:p>');
  const t = descendants(root, 'w:t')[0];
  assert.equal(textOf(t), 'a & b');
  assert.equal(attr(t, 'space'), 'preserve');
});

/* -------------------------------------------------------------------- docx */

test('docx converts headings, emphasis, lists, tables, links and footnotes', () => {
  const result = convert('review.docx', makeDocx());

  assert.equal(result.format, 'Word (.docx)');
  assert.match(result.markdown, /^---\ntitle: Annual Review 2024/m);
  assert.match(result.markdown, /^# Annual Review$/m);
  assert.match(result.markdown, /^## Summary$/m);
  assert.match(result.markdown, /Revenue grew by \*\*18%\*\* across \*all regions\*\./);
  assert.match(result.markdown, /\[Read the full report]\(https:\/\/example\.com\/report\)/);
  assert.match(result.markdown, /^- First item$/m);
  assert.match(result.markdown, /^1\. Step one$/m);
  assert.match(result.markdown, /^2\. Step two$/m);
  assert.match(result.markdown, /\| Region \| Growth \|/);
  assert.match(result.markdown, /!\[Growth chart]\(data:image\/png;base64,/);
  assert.match(result.markdown, /\[\^fn1]: Figures are unaudited\./);
  assert.equal(result.imageCount, 1);
});

test('docx image mode "skip" leaves pictures out', () => {
  const result = convert('review.docx', makeDocx(), { imageMode: 'skip' });
  assert.equal(result.imageCount, 0);
  assert.ok(!result.markdown.includes('data:image/png'));
});

/* -------------------------------------------------------------------- xlsx */

test('xlsx converts every sheet, resolving shared strings and dates', () => {
  const result = convert('sales.xlsx', makeXlsx());
  assert.match(result.markdown, /^## Sales$/m);
  assert.match(result.markdown, /\| Product \| Units \| Shipped +\|/);
  assert.match(result.markdown, /\| Widget +\| 1200 +\| 2024-01-15 \|/);
  assert.match(result.markdown, /^## Notes$/m);
  assert.match(result.markdown, /Prices exclude VAT/);
});

/* -------------------------------------------------------------------- pptx */

test('pptx converts slides in order with bullets and speaker notes', () => {
  const result = convert('deck.pptx', makePptx());
  assert.match(result.markdown, /^## Roadmap$/m);
  assert.match(result.markdown, /^- Ship the beta$/m);
  assert.match(result.markdown, /^ {2}- Nested detail$/m);
  assert.match(result.markdown, /Speaker notes:\*\* Remember to mention the pilot\./);
  assert.ok(result.markdown.indexOf('## Roadmap') < result.markdown.indexOf('## Timeline'));
});

test('pptx omits notes when the option is off', () => {
  const result = convert('deck.pptx', makePptx(), { includeNotes: false });
  assert.ok(!result.markdown.includes('Speaker notes'));
});

/* --------------------------------------------------------------------- odf */

test('odt converts headings, styled spans, lists, links and tables', () => {
  const result = convert('notes.odt', makeOdt());
  assert.match(result.markdown, /^# Field Notes$/m);
  assert.match(result.markdown, /Recorded on \*\*Tuesday\*\* in \*Erbil\*\./);
  assert.match(result.markdown, /^- Wind from the north$/m);
  assert.match(result.markdown, /\[Source data]\(https:\/\/example\.org\)/);
  assert.match(result.markdown, /\| Hour +\| Temp \|/);
});

/* -------------------------------------------------------------------- epub */

test('epub converts chapters in spine order', () => {
  const result = convert('book.epub', makeEpub());
  assert.match(result.markdown, /^# Beginnings$/m);
  assert.match(result.markdown, /It started with a \*question\*\./);
  assert.match(result.markdown, /^# Endings$/m);
  assert.ok(result.markdown.indexOf('Beginnings') < result.markdown.indexOf('Endings'));
  assert.match(result.markdown, /^author: A\. Author$/m);
});

/* --------------------------------------------------------------------- pdf */

for (const compress of [false, true]) {
  test(`pdf extracts structured text (${compress ? 'compressed' : 'uncompressed'} streams)`, () => {
    const result = convert('report.pdf', makePdf({ compress }));

    assert.equal(result.format, 'PDF');
    assert.match(result.markdown, /^# Quarterly Report$/m);
    assert.match(result.markdown, /This is the first paragraph of the report, wrapped across two lines\./);
    assert.match(result.markdown, /^- First bullet point$/m);
    assert.match(result.markdown, /^- Second bullet point$/m);
    assert.match(result.markdown, /^## Method$/m);
    assert.match(result.markdown, /Kerned words stay separate\./);
    assert.match(result.markdown, /^pages: "1"$/m);
    assert.match(result.markdown, /^author: Finance$/m);
  });
}

test('pdf heading detection can be turned off', () => {
  const result = convert('report.pdf', makePdf(), { detectPdfHeadings: false });
  assert.ok(!result.markdown.includes('# Quarterly Report'));
  assert.match(result.markdown, /Quarterly Report/);
});

/* --------------------------------------------------------------------- rtf */

test('rtf converts formatting, lists and escapes', () => {
  const result = convert('notes.rtf', makeRtf());
  assert.match(result.markdown, /^# Meeting notes$/m);
  assert.match(result.markdown, /\*\*budget\*\*/);
  assert.match(result.markdown, /\*timeline\*/);
  assert.match(result.markdown, /^- Review vendor quotes$/m);
  assert.match(result.markdown, /Café costs were €120\./);
});

/* -------------------------------------------------------------------- html */

test('html converts structure, nested lists, code and tables', () => {
  const result = convert('notes.html', makeHtml());
  assert.match(result.markdown, /^# Release notes$/m);
  assert.match(result.markdown, /Version \*\*2\.1\*\* is out/);
  assert.match(result.markdown, /\[changelog]\(https:\/\/example\.com\/changelog\)/);
  assert.match(result.markdown, /^- Faster startup$/m);
  assert.match(result.markdown, /^ {2}- on Windows$/m);
  assert.match(result.markdown, /^> Upgrading is recommended\.$/m);
  assert.match(result.markdown, /\| Platform \| Status +\|/);
  assert.match(result.markdown, /```bash\nnpm install app@2\.1\n```/);
  assert.match(result.markdown, /^title: Release notes$/m);
});

/* --------------------------------------------------------------------- eml */

test('eml decodes encoded headers and prefers the html body', () => {
  const result = convert('message.eml', makeEml());
  assert.match(result.markdown, /^# Quarterly update$/m);
  assert.match(result.markdown, /\| From +\| "Ameen Marashi" \\<ameen@example\.com\\> \|/);
  assert.match(result.markdown, /Numbers are \*\*up\*\* — details inside\./);
});

/* --------------------------------------------------------------------- csv */

test('csv sniffs the delimiter and handles quoted fields', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.deepEqual(parseDelimited('a,"b,c",d', ','), [['a', 'b,c', 'd']]);

  const result = convert('sales.csv', makeCsv());
  assert.match(result.markdown, /\| Region +\| Units \| Revenue \|/);
  assert.match(result.markdown, /North, America/);
  assert.equal(result.meta.delimiter, ';');
});

/* -------------------------------------------------------------------- text */

test('plain text gains structure without a code fence', () => {
  const source = ['PROJECT PLAN', '', 'Overview', '========', '', 'First line', 'second line.', '', '- alpha', '- beta'].join('\n');
  const result = convert('plan.txt', source);
  assert.match(result.markdown, /^## PROJECT PLAN$/m);
  assert.match(result.markdown, /^# Overview$/m);
  assert.match(result.markdown, /First line second line\./);
  assert.match(result.markdown, /^- alpha$/m);
});

test('markdown input passes through unchanged apart from front matter', () => {
  const result = convert('readme.md', '# Title\n\nBody **text**.\n', { frontMatter: false });
  assert.equal(result.markdown, '# Title\n\nBody **text**.\n');
});

test('json arrays of flat objects become tables', () => {
  const result = convert('rows.json', JSON.stringify([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]));
  assert.match(result.markdown, /\| id  \| name \|/);
  assert.match(result.markdown, /\| 2 +\| b +\|/);
});

/* ---------------------------------------------------------------- dispatch */

test('format detection is content-first', () => {
  assert.equal(detectFormat(sourceFile('mislabelled.doc', makeDocx())).id, 'docx');
  assert.equal(detectFormat(sourceFile('report.bin', makePdf())).id, 'pdf');
  assert.equal(detectFormat(sourceFile('page.htm', '<html><body>hi</body></html>')).id, 'html');
  assert.equal(detectFormat(sourceFile('data.csv', 'a,b\n1,2')).id, 'csv');
});

test('legacy binary Office files get an actionable message', () => {
  const ole = new Uint8Array(600);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  assert.throws(() => convert('old.doc', ole), /save as \.docx/i);
});

test('unsupported binaries are rejected clearly', () => {
  const noise = new Uint8Array(2048).fill(0);
  noise[0] = 0x7f;
  assert.throws(() => convert('mystery.bin', noise), /does not look like a document/i);
});

test('front matter can be switched off', () => {
  const result = convert('review.docx', makeDocx(), { frontMatter: false });
  assert.ok(!result.markdown.startsWith('---'));
  assert.equal(result.outputName, 'review.md');
});
