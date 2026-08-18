# MD Converter

Convert documents to Markdown entirely on your own device — no server, no
uploads, no account. Two apps from one design:

- **`web/`** — an installable PWA that works fully offline once added to the
  Home Screen or Dock.
- **`flutter_app/`** — the same converter engine in Dart, for iOS, iPadOS,
  macOS and Android.

## What it converts

| Input | Notes |
| --- | --- |
| **PDF** | Text, headings (by font size), paragraphs, bullet and numbered lists. Running headers/footers are detected across pages and dropped. Encrypted-but-openable files (RC4, AES-128, AES-256 rev 5) are decrypted. |
| **Word `.docx`** | Headings, bold/italic/strikethrough, sub/superscript, ordered and bulleted lists with nesting, tables, hyperlinks, images, footnotes, endnotes, comments. |
| **Excel `.xlsx` / `.xlsm`** | Every sheet as a Markdown table; shared strings, inline strings, cached formula results, date formats and cell hyperlinks resolved. |
| **PowerPoint `.pptx`** | Slides in presentation order, title as heading, bullets with outline levels, tables, pictures, speaker notes. |
| **Google Docs, Sheets, Slides** | Download as `.docx` / `.xlsx` / `.pptx` (or OpenDocument, or "Web page" HTML) and convert that — all four paths are covered by tests. `.gdoc`/`.gsheet`/`.gslides` shortcut files explain how to get the real document. |
| **OpenDocument `.odt` / `.ods` / `.odp`** | Text, spreadsheets and presentations, including automatic styles for emphasis. |
| **EPUB** | Chapters in spine order, images inlined. |
| **HTML** | Semantic structure, nested lists, tables, code blocks. Emphasis carried by CSS classes (how Word and Google Docs export) is restored. |
| **Email `.eml` / `.mht`** | Headers as a summary table, HTML body preferred over plain text, attachments listed. |
| **RTF** | Formatting, headings by outline level or font size, lists, tables, hyperlinks. |
| **CSV / TSV** | Delimiter sniffing, RFC 4180 quoting, numeric columns right-aligned. |
| **Text, Markdown, JSON, YAML, source code, subtitles** | Plain text gets a light structural pass; JSON arrays of flat objects become tables; code is fenced with the right language. |
| **Images** | Embedded as a data URI with dimensions in the front matter. |

Legacy binary `.doc`/`.xls`/`.ppt` are detected and answered with the one-line
fix (re-save as the modern format) rather than a generic failure.

## The PWA

```bash
cd web
npm install
npm run build     # compiles TypeScript and regenerates the service worker
npm test          # 36 tests
npm run serve     # http://localhost:8080
```

`web/public/` is the deployable directory — plain static files, no build step
needed at deploy time:

```bash
npx wrangler pages deploy web/public      # Cloudflare Pages
```

or point GitHub Pages / Netlify / any static host at it. Serve over HTTPS (or
localhost) so the service worker can register.

**Install:** iPhone/iPad — Share → Add to Home Screen. macOS Safari — File →
Add to Dock. Chrome/Edge — the install icon in the address bar. After that, the
whole app (including the PDF and Word engines) is on the device and no
connection is used again.

### How it is built

Everything is written in-tree — no runtime dependencies, nothing fetched from a
CDN, which is what makes true offline operation possible:

- **DEFLATE decoder and ZIP reader/writer** — so OOXML, ODF and EPUB parsing
  works on iOS Safari versions without `DecompressionStream`.
- **Tolerant XML/HTML parser** — `DOMParser` is not available in Web Workers,
  and all conversion runs off the main thread.
- **PDF reader** — brute-force object scanning (survives broken cross-reference
  tables), object streams, Flate/LZW/ASCII85/ASCIIHex/RunLength filters, PNG and
  TIFF predictors, RC4 and AES decryption, ToUnicode CMaps, simple and CID font
  encodings, glyph metrics, and layout inference for headings, paragraphs and
  lists.
- **Markdown preview** built from DOM nodes, never `innerHTML`, so converted
  document content cannot inject markup.

Conversion runs in a Web Worker; results can be copied, downloaded, or exported
together as a `.zip` built in the browser. Drag and drop, the file picker, the
clipboard, the Web Share Target and OS file handlers all feed the same pipeline.

## The Flutter app

See [`flutter_app/README.md`](flutter_app/README.md) for setup. In short:

```bash
cd flutter_app
flutter create --platforms=ios,android,macos --org com.marashi --project-name md_converter .
flutter pub get
flutter test      # 28 tests
flutter run -d macos
```

It uses Riverpod for state, `package:archive`/`xml`/`html` for parsing, and runs
each conversion on a background isolate. The UI is localised (English and
Arabic, RTL included) with no hardcoded display strings.

## Repository layout

```
web/
├── src/            TypeScript source (core/, converters/, converters/pdf/, ui/)
├── public/         the deployable PWA, including compiled js/
├── scripts/        build, icon generation, dev server
└── test/           node:test suite + in-memory fixtures
flutter_app/
├── lib/            main.dart, l10n/, src/{core,converters,state,ui}
└── test/           flutter_test suite mirroring the web assertions
```

The compiled JavaScript in `web/public/js/` is committed so the folder can be
served as-is; regenerate it with `npm run build` rather than editing it.

## Known limits

- **Scanned PDFs** have no text layer. The converter says so explicitly instead
  of producing an empty file; run OCR first.
- **AES-256 revision 6** PDF encryption (PDF 2.0) is reported as unsupported.
- **Charts, SmartArt and equations** are not rendered; their surrounding text is
  kept.
- Multi-column PDF layouts are read in reading order per line, which suits
  reports and articles better than newspaper-style columns.
