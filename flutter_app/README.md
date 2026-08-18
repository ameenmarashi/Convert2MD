# MD Converter — Flutter app

The same converter engine as the PWA, ported to Dart for iOS, iPadOS, macOS and
Android. Everything runs on the device; the app makes no network calls.

## First run

The repository holds the Dart source only. Generate the platform runners once,
on a machine with Flutter installed:

```bash
cd flutter_app
flutter create --platforms=ios,android,macos --org com.marashi --project-name md_converter .
flutter pub get
flutter test          # also generates lib/l10n/app_localizations.dart
```

`flutter create` on an existing directory adds `ios/`, `android/` and `macos/`
without touching `lib/`, `test/` or `pubspec.yaml`.

Then register the app as a document handler, so a `.md` (or any supported
document) can be opened straight into it from Files, Finder or a file manager:

```bash
tool/configure_platforms.sh
```

It installs the native halves from `platform/` and merges the document-type
declarations into the generated `AndroidManifest.xml` and `Info.plist` files.
Re-run it after any `flutter create` that regenerates those folders; it is
idempotent, and it also grants the macOS entitlement described below, so the
manual step in the next section is only needed if you skip the script.

Then:

```bash
flutter run -d macos      # or: -d iPhone, -d android
flutter build ipa         # App Store / TestFlight
flutter build appbundle   # Google Play
flutter build macos
```

### macOS entitlements

`flutter create` ships a sandboxed macOS target. To let the app open documents
the user picks, add to both `macos/Runner/DebugProfile.entitlements` and
`macos/Runner/Release.entitlements`:

```xml
<key>com.apple.security.files.user-selected.read-write</key>
<true/>
```

No network entitlement is needed — the app never opens a socket.

## Layout

```
lib/
├── main.dart                      app shell, theme, localisation wiring
├── l10n/                          app_en.arb, app_ar.arb (generated class ignored)
└── src/
    ├── core/
    │   ├── conversion.dart        ConvertOptions, ConversionResult, exceptions
    │   ├── converter_registry.dart format detection + dispatch
    │   ├── markdown.dart          Markdown emission helpers
    │   ├── package_archive.dart   ZIP access for OOXML/ODF/EPUB
    │   ├── text_decode.dart       BOM sniffing, cp1252 fallback
    │   └── xml_query.dart         namespace-tolerant XML queries
    ├── converters/                one file per format, plus pdf/ (8 modules)
    │   ├── document_library.dart  the app's own .md files on disk
    │   ├── markdown_editing.dart  editor rules as pure functions
    ├── platform/
    │   └── opened_files.dart      documents the OS hands over ("Open with")
    ├── state/                     Riverpod providers (settings, conversions)
    └── ui/                        home, reader/editor, toolbar, result card, settings
platform/                          native halves, installed by tool/
├── android/  MainActivity.kt, intent-filters.xml
├── ios/      AppDelegate.swift
└── macos/    AppDelegate.swift, MainFlutterWindow.swift
tool/
└── configure_platforms.sh         registers the document types after create
```

## Your documents

`lib/src/core/document_library.dart` keeps the app's documents as real `.md`
files in the app's own Documents directory — not in a database, on purpose.
With `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` set by
`tool/configure_platforms.sh`, iOS and iPadOS list that folder in the **Files**
app under *On My iPhone/iPad → MD Converter*, so anything started here can be
opened, copied or moved to iCloud Drive from outside the app.

**Start a new document** creates one and opens the editor on it. A document
opened from elsewhere can be added with **Keep in app**. Renaming happens by
typing over the title, since on iOS there is no folder to go and rename it in.

## Reading and editing Markdown

A `.md` file is already the finished document, so `ReaderPage` shows it rather
than converting it: one measure, a contents sheet built from the headings and
adjustable text size. Markdown reaches it three ways — the **Open a .md file**
button, a `.md` among the files picked for conversion, and a document handed
over by the operating system.

Switching to **Edit** puts the text and a live preview side by side, with a
toolbar whose buttons say what they make. The rules — what Bold does to a
selection, what Enter does inside a list — are pure functions in
`lib/src/core/markdown_editing.dart`, mirroring `web/src/ui/editor.ts`, and are
covered by `test/markdown_editing_test.dart` against the same cases the PWA's
editor was checked against in a browser.

## Open with

`platform/` holds the native halves and `tool/configure_platforms.sh` installs
them. All three platforms speak one method channel, `md_converter/opened_files`,
so the Dart side has a single code path:

| Platform | Native entry point | Declared by |
| --- | --- | --- |
| Android | `MainActivity` — `ACTION_VIEW`, `ACTION_SEND`, `ACTION_SEND_MULTIPLE` | intent filters in `AndroidManifest.xml` |
| iOS, iPadOS | `AppDelegate.application(_:open:options:)` and the launch options | `CFBundleDocumentTypes` in `Info.plist` |
| macOS | `AppDelegate.application(_:open:)` | `CFBundleDocumentTypes` in `Info.plist` |

Apple assigns no type identifier to Markdown, so the app declares
`net.daringfireball.markdown` as an imported type and claims `.md`, `.markdown`,
`.mdown`, `.mkd` and `.mdx`. Android reports a `.md` inconsistently — sometimes
`text/markdown`, often `text/plain`, sometimes `application/octet-stream` — so
the filters cover all three, with a path-pattern filter as the backstop.

When the native half is missing (a platform that was never configured, or the
widget tests) every call degrades to "nothing was opened" rather than throwing.

Conversion runs on a background isolate (`compute`), so a large PDF never blocks
the UI thread — the same reason the web app uses a Web Worker.

## Tests

```bash
flutter test
```

28 tests cover every converter against fixtures built in memory, including
Google Docs/Sheets/Slides exports. `test/fixtures.dart` mirrors
`web/test/fixtures.mjs`, and the assertions mirror the web suite, so a change
that shifts output in one engine and not the other shows up as a failure.

## Parity with the PWA

Each Dart converter names the TypeScript file it mirrors in its header comment.
The two engines share format detection order, option names and Markdown output.
The known differences:

| Area | PWA | Flutter app |
| --- | --- | --- |
| ZIP + inflate | written in-tree | `package:archive` |
| XML / HTML parsing | written in-tree | `package:xml`, `package:html` |
| Threading | Web Worker | isolate via `compute` |
| Encrypted PDFs | RC4, AES-128, AES-256 rev 5 | same, via `package:crypto` for MD5/SHA-256 |
