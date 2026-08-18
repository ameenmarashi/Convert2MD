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
    ├── state/                     Riverpod providers (settings, conversions)
    └── ui/                        home page, result card, settings sheet
```

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
