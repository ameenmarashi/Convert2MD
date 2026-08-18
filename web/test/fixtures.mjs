/** Builds in-memory sample documents for the converter tests. */

import { deflateSync } from 'node:zlib';
import { writeZip } from '../public/js/core/zip.js';

const encoder = new TextEncoder();

export function bytes(text) {
  return encoder.encode(text);
}

export function sourceFile(name, data, mime = '') {
  return {
    name,
    bytes: data instanceof Uint8Array ? data : bytes(data),
    mime,
    lastModified: Date.UTC(2024, 0, 15),
  };
}

function zip(entries) {
  return writeZip(entries.map(([name, data]) => ({ name, data: data instanceof Uint8Array ? data : bytes(data) })));
}

/* ------------------------------------------------------------------- docx */

const PNG_PIXEL = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

export function makeDocx() {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Annual Review</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Summary</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Revenue grew by </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>18%</w:t></w:r>
      <w:r><w:t xml:space="preserve"> across </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>all regions</w:t></w:r>
      <w:r><w:t>.</w:t></w:r>
    </w:p>
    <w:p>
      <w:hyperlink r:id="rId5"><w:r><w:t>Read the full report</w:t></w:r></w:hyperlink>
    </w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second item</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Step one</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Step two</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:trPr><w:tblHeader/></w:trPr>
        <w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Growth</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>EMEA</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>12%</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Chart" descr="Growth chart"/>
      <a:graphic><a:graphicData><a:blip r:embed="rId6"/></a:graphicData></a:graphic>
    </wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:t>Footnote follows.</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>
  </w:body>
</w:document>`;

  const styles = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;

  const numbering = `<?xml version="1.0"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:start w:val="1"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

  const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report" TargetMode="External"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/>
</Relationships>`;

  const footnotes = `<?xml version="1.0"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="2"><w:p><w:r><w:t>Figures are unaudited.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

  const core = `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Annual Review 2024</dc:title>
  <dc:creator>Ameen Marashi</dc:creator>
</cp:coreProperties>`;

  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['docProps/core.xml', core],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/numbering.xml', numbering],
    ['word/footnotes.xml', footnotes],
    ['word/_rels/document.xml.rels', rels],
    ['word/media/chart.png', PNG_PIXEL],
  ]);
}

/* ------------------------------------------------------------------- xlsx */

export function makeXlsx() {
  const workbook = `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sales" sheetId="1" r:id="rId1"/>
    <sheet name="Notes" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

  const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`;

  const shared = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5">
  <si><t>Product</t></si>
  <si><t>Units</t></si>
  <si><t>Shipped</t></si>
  <si><t>Widget</t></si>
  <si><t>Gadget</t></si>
</sst>`;

  const styles = `<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>
</styleSheet>`;

  const sheet1 = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1200</v></c><c r="C2" s="1"><v>45306</v></c></row>
    <row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>860</v></c><c r="C3" s="1"><v>45307</v></c></row>
  </sheetData>
</worksheet>`;

  const sheet2 = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Prices exclude VAT</t></is></c></row>
  </sheetData>
</worksheet>`;

  return zip([
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', rels],
    ['xl/sharedStrings.xml', shared],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', sheet1],
    ['xl/worksheets/sheet2.xml', sheet2],
  ]);
}

/* ------------------------------------------------------------------- pptx */

export function makePptx() {
  const presentation = `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>
</p:presentation>`;

  const presentationRels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`;

  const slide = (title, bullets) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody>${bullets
        .map((b, i) => `<a:p><a:pPr lvl="${i > 1 ? 1 : 0}"/><a:r><a:t>${b}</a:t></a:r></a:p>`)
        .join('')}</p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

  const slide1Rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`;

  const notes = `<?xml version="1.0"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
    <p:txBody><a:p><a:r><a:t>Remember to mention the pilot.</a:t></a:r></a:p></p:txBody>
  </p:sp></p:spTree></p:cSld>
</p:notes>`;

  return zip([
    ['ppt/presentation.xml', presentation],
    ['ppt/_rels/presentation.xml.rels', presentationRels],
    ['ppt/slides/slide1.xml', slide('Roadmap', ['Ship the beta', 'Collect feedback', 'Nested detail'])],
    ['ppt/slides/slide2.xml', slide('Timeline', ['Q1 kickoff', 'Q3 launch'])],
    ['ppt/slides/_rels/slide1.xml.rels', slide1Rels],
    ['ppt/notesSlides/notesSlide1.xml', notes],
  ]);
}

/* -------------------------------------------------------------------- odt */

export function makeOdt() {
  const content = `<?xml version="1.0"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink">
  <office:automatic-styles>
    <style:style style:name="T1"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="T2"><style:text-properties fo:font-style="italic"/></style:style>
    <text:list-style style:name="L1"><text:list-level-style-bullet text:level="1"/></text:list-style>
  </office:automatic-styles>
  <office:body><office:text>
    <text:h text:outline-level="1">Field Notes</text:h>
    <text:p>Recorded on <text:span text:style-name="T1">Tuesday</text:span> in <text:span text:style-name="T2">Erbil</text:span>.</text:p>
    <text:list text:style-name="L1">
      <text:list-item><text:p>Wind from the north</text:p></text:list-item>
      <text:list-item><text:p>Clear skies</text:p></text:list-item>
    </text:list>
    <text:p><text:a xlink:href="https://example.org">Source data</text:a></text:p>
    <table:table table:name="Readings">
      <table:table-header-rows>
        <table:table-row>
          <table:table-cell><text:p>Hour</text:p></table:table-cell>
          <table:table-cell><text:p>Temp</text:p></table:table-cell>
        </table:table-row>
      </table:table-header-rows>
      <table:table-row>
        <table:table-cell><text:p>09:00</text:p></table:table-cell>
        <table:table-cell><text:p>21</text:p></table:table-cell>
      </table:table-row>
    </table:table>
  </office:text></office:body>
</office:document-content>`;

  const meta = `<?xml version="1.0"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <office:meta><dc:title>Field Notes</dc:title><dc:creator>Observer</dc:creator></office:meta>
</office:document-meta>`;

  return zip([
    ['mimetype', 'application/vnd.oasis.opendocument.text'],
    ['content.xml', content],
    ['meta.xml', meta],
  ]);
}

/* ------------------------------------------------------------------- epub */

export function makeEpub() {
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Small Book</dc:title>
    <dc:creator>A. Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;

  const chapter = (title, body) => `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;

  return zip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', container],
    ['OEBPS/content.opf', opf],
    ['OEBPS/chapter1.xhtml', chapter('Beginnings', 'It started with a <em>question</em>.')],
    ['OEBPS/chapter2.xhtml', chapter('Endings', 'And finished with an answer.')],
  ]);
}

/* -------------------------------------------------------------------- pdf */

function pdfStream(content, compress) {
  if (!compress) return { data: bytes(content), extra: '' };
  return { data: new Uint8Array(deflateSync(Buffer.from(content, 'latin1'))), extra: ' /Filter /FlateDecode' };
}

/**
 * Assembles a small but structurally real PDF. `compress` exercises the inflate
 * path; the cross-reference table is deliberately omitted to prove the reader
 * does not depend on it.
 */
export function makePdf({ compress = false } = {}) {
  const content = `BT /F1 24 Tf 72 720 Td (Quarterly Report) Tj ET
BT /F2 12 Tf 72 690 Td (This is the first paragraph of the) Tj 0 -14 Td (report, wrapped across two lines.) Tj ET
BT /F2 12 Tf 72 640 Td (\\225 First bullet point) Tj 0 -16 Td (\\225 Second bullet point) Tj ET
BT /F1 16 Tf 72 590 Td (Method) Tj ET
BT /F2 12 Tf 72 566 Td [(Kerned) -400 (words) -400 (stay) -400 (separate.)] TJ ET`;

  const stream = pdfStream(content, compress);
  const parts = [];
  const chunks = [];

  const push = (text) => chunks.push(bytes(text));

  push('%PDF-1.5\n');
  push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >> endobj\n');
  push(
    '3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >> endobj\n'
  );
  push(`4 0 obj << /Length ${stream.data.length}${stream.extra} >> stream\n`);
  chunks.push(stream.data);
  push('\nendstream endobj\n');
  push('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> endobj\n');
  push('6 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj\n');
  push('7 0 obj << /Title (Quarterly Report) /Author (Finance) >> endobj\n');
  push('trailer << /Size 8 /Root 1 0 R /Info 7 0 R >>\n%%EOF\n');

  for (const chunk of chunks) parts.push(chunk);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/* -------------------------------------------------------------------- rtf */

export function makeRtf() {
  return [
    '{\\rtf1\\ansi\\deff0',
    '{\\fonttbl{\\f0 Calibri;}}',
    '{\\info{\\title Meeting notes}{\\author Ameen}}',
    '\\fs48\\b Meeting notes\\b0\\fs24\\par',
    'Attendees discussed the {\\b budget} and the {\\i timeline}.\\par',
    '{\\pntext\\f0 \\bullet\\tab}Review vendor quotes\\par',
    '{\\pntext\\f0 \\bullet\\tab}Confirm the launch date\\par',
    'Caf\\\'e9 costs were \\u8364?120.\\par',
    '}',
  ].join('\n');
}

/* ------------------------------------------------------------------- misc */

export function makeHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Release notes</title>
<meta name="author" content="Platform team"></head>
<body>
<h1>Release notes</h1>
<p>Version <strong>2.1</strong> is out. See the <a href="https://example.com/changelog">changelog</a>.</p>
<ul><li>Faster startup</li><li>Fixed <code>--verbose</code><ul><li>on Windows</li></ul></li></ul>
<blockquote><p>Upgrading is recommended.</p></blockquote>
<table><thead><tr><th>Platform</th><th>Status</th></tr></thead>
<tbody><tr><td>macOS</td><td>Shipped</td></tr><tr><td>Linux</td><td>Beta</td></tr></tbody></table>
<pre><code class="language-bash">npm install app@2.1</code></pre>
<p>Trailing paragraph with an image <img src="logo.png" alt="Logo"></p>
</body></html>`;
}

export function makeEml() {
  return [
    'From: "Ameen Marashi" <ameen@example.com>',
    'To: team@example.com',
    'Subject: =?utf-8?B?UXVhcnRlcmx5IHVwZGF0ZQ==?=',
    'Date: Tue, 16 Jan 2024 09:12:00 +0300',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Plain text fallback.',
    '',
    '--BOUND',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<h1>Quarterly update</h1><p>Numbers are <b>up</b> =E2=80=94 details inside.</p>',
    '',
    '--BOUND--',
    '',
  ].join('\r\n');
}

export function makeCsv() {
  return [
    'Region;Units;Revenue',
    'EMEA;1200;45,000',
    '"North, America";860;38,200',
    'APAC;540;19,900',
  ].join('\n');
}
