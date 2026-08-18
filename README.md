# MD Converter

Convert documents to Markdown — and read the Markdown you already have —
entirely on your own device, with no server, no uploads and no account. Two apps
from one design:

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

## Privacy

Nothing you open is uploaded, stored, logged or shared — not with a server, not
with an AI company, not with the developer. These are properties of the build,
not promises:

- **No upload.** Files are read and converted by code running on your device.
  There is no server to send them to.
- **No AI.** Nothing is sent to any model, for training, context or anything
  else. The conversion is ordinary parsing code — every format has a parser
  written in-tree.
- **Nothing to look at.** No account, no database, no log. The developer cannot
  see what you convert even in principle.
- **No analytics, cookies or third-party scripts.** The app opens no network
  connection of its own; the typeface is bundled rather than fetched.
- **Only settings persist.** Preferences, theme and reading size are kept
  locally. Document content never is.

The one exception, stated in the app as well: if a document links to an image
hosted on the web, the preview loads that image from wherever it lives, as any
viewer would. Setting *Images* to "Leave out entirely" prevents it.

You can verify the whole claim: install the app, turn off the network, and
convert a file.

## Reading and editing Markdown

A `.md` file is already the finished document, so there is nothing to convert.
**Open a .md file** puts it in a reading view instead: one comfortable measure,
a contents list built from the headings, adjustable text size, and a print
stylesheet so "Save as PDF" produces something worth sending on. It is the
answer to the pile of `.md` files that AI tools hand back.

Switch to **Edit** and the same document becomes editable, built for someone who
has never used Markdown:

- **A toolbar that says what it makes**, not what it inserts — *Big heading*,
  *Bulleted list*, *Checklist*, *Link*. Nothing has to be memorised to start.
- **The preview beside the text, redrawing as you type**, so the connection
  between `## ` and a heading is learned by watching rather than by reading.
- **Typing help that does what the marks imply.** Enter continues a list and
  counts numbers on; Enter on an empty item ends it; Tab nests an item under the
  one above; Shift+Tab lifts it back out. Ctrl/⌘ + B, I and K are wired up.
- **Buttons that toggle.** Bold on bold text takes the marks off; a heading
  button on a heading of another level converts it rather than stacking.
- **Undo that works.** Every toolbar press goes onto the browser's own undo
  stack, so Ctrl+Z steps back through them exactly as it does through typing.
- **A cheat sheet in nine lines**, collapsed until asked for.
- **Nothing is lost.** Typing is kept as a draft on the device as it happens and
  offered back next time the file is opened; closing with unsaved edits says so.

The editing rules live in one place per app — `web/src/ui/editor.ts` and
`flutter_app/lib/src/core/markdown_editing.dart` — and are asserted against the
same cases in both suites.

Markdown that arrives any other way — dropped on the window, picked from the
file dialog, or handed over by the operating system — goes to the reader too;
everything else goes to the converter.

## Keeping the UI clean

All the explanatory material — the privacy notice, why Markdown and AI go
together, what the app does — is collapsed behind a summary, so the app opens on
the work and nothing else. Links to a panel expand it rather than scrolling to a
closed row. Both apps do this the same way: `<details class="panel">` in the PWA,
`ExpansionTile` in the Flutter app.

## Open with

Both apps register as document handlers, so a file can go straight into the app
from wherever it lives:

| Platform | Route |
| --- | --- |
| iOS, iPadOS | Files, Mail, Drive → Share → **MD Converter**, or tap a `.md` and pick it under "Open in" |
| macOS | Finder → right-click → **Open With**, or drop the file on the Dock icon |
| Android | Files or any file manager → **Open with**, plus the system share sheet |
| Chrome, Edge, Chrome OS | Registered through the manifest's `file_handlers` once the PWA is installed |

Markdown has no system-assigned type identifier on Apple platforms, so the app
declares one (`net.daringfireball.markdown`) and claims the extensions — that
declaration is what puts it in Finder's and Files' "Open with" list.

For the native apps this wiring lives in `flutter_app/platform/` and is
installed by `flutter_app/tool/configure_platforms.sh` after `flutter create`.

## Updates

The app bar carries a circular arrow. Pressing it looks for a newer version,
downloads it, and — pressed again once a green dot appears — installs it and
reloads onto it. The dot is the only signal the app ever raises on its own.

**It only ever looks while the app is open.** There are three checks and no
others: one when the app starts, one when it comes back to the foreground (at
most every 15 minutes), and one whenever the button is pressed. No Periodic
Background Sync and no push subscription are registered, which is what would
otherwise let a service worker reach the network with the app closed — verified
by counting requests for `sw.js` with every page shut: zero.

The service worker downloads a new version and then *waits*, rather than
activating on its own. That is deliberate: an update that swaps the app out
mid-edit is worse than one that waits to be asked. Unsaved editor work is kept
as a draft either way, and applying an update while editing asks first.

`v1.0.0 · build a1b2c3d` in the footer names the build actually running — the
hash comes from the worker serving the page, so it cannot drift from what is on
screen.

## Live site

**https://ameenmarashi.github.io/Convert2MD/**

Served from the `gh-pages` branch, which holds only the built site. Pushing
that branch is also what enabled Pages in the first place — the Actions token is
refused on the "create Pages site" API, so the usual `deploy-pages` route would
have needed a repository setting changed by hand.

`.github/workflows/deploy-pages.yml` rebuilds `web/public` from source on every
push that touches `web/`, runs the test suite, and syncs the result onto
`gh-pages`; a failing test blocks the release. Do not edit `gh-pages` directly —
it is regenerated.

GitHub Pages serves this at a sub-path, which the app is built for: every URL is
relative, the service worker scopes itself to `/Convert2MD/`, and the manifest
uses `./` for `start_url` and `scope`.

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
clipboard, the Web Share Target and OS file handlers all feed the same pipeline —
which routes Markdown to the reading view and everything else to the converter.

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

## Branding

`brand.json` at the repository root is the single source of the visual identity —
the monogram, the gradient, the accent and the launch-screen backgrounds.

```bash
npm --prefix web run icons     # regenerates every icon, splash and launch image
```

That one command writes the PWA icons, favicon, Apple touch icon and 76 iOS
launch images into `web/public/icons/`, rewrites the `apple-touch-startup-image`
block in `index.html` to match, and writes the 1024px icon, Android adaptive
layers and splash logo into `flutter_app/assets/branding/`. The monogram is drawn
as geometry rather than set in a typeface, so it renders identically everywhere
with no font dependency.

iOS picks a launch image by an exact media query on the device's CSS size,
pixel ratio and orientation, and shows a blank white screen when nothing
matches — so the generator covers 19 device sizes in both orientations and both
colour schemes, driven from one table in `web/scripts/make-icons.mjs`. Each
image is a flat field with the monogram on it, encoded as an indexed PNG, which
keeps all 76 to about 400 KB and out of the offline precache.

For the native apps, after `flutter create` has generated the platform folders:

```bash
cd flutter_app
dart run flutter_launcher_icons        # app icon: iOS, Android (adaptive), macOS
dart run flutter_native_splash:create  # launch screen: iOS, Android, Android 12+
```

Both read the same generated images and the same background colours, so the icon
and the launch screen are identical on iOS and Android by construction. The PWA
matches them through `manifest.webmanifest` (`background_color`) and the
`apple-touch-startup-image` links in `index.html`, in light and dark.

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
