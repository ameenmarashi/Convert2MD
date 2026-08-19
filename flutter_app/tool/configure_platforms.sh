#!/usr/bin/env bash
#
# Registers MD Converter as a document handler on Android, iOS/iPadOS and macOS,
# so a .md (or any supported document) can be opened straight into the app from
# Files, Finder, Drive, Mail or a file manager.
#
# `flutter create` generates the platform runners but not this wiring, and the
# repository does not track the generated folders — so run this once after
# `flutter create`, and again after any `flutter create` that regenerates them.
#
#   cd flutter_app
#   flutter create --platforms=ios,android,macos --org com.marashi --project-name md_converter .
#   tool/configure_platforms.sh
#
# It is idempotent: re-running replaces what it wrote before rather than
# stacking duplicates. Everything it copies lives in platform/, and the Dart
# half is lib/src/platform/opened_files.dart.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

bundle_id="com.marashi.mdConverter"
package_path="com/marashi/md_converter"
changed=0

say() { printf '  %s\n' "$1"; }
skip() { printf '  – %s\n' "$1"; }

# --------------------------------------------------------------------- Android

configure_android() {
  local manifest="android/app/src/main/AndroidManifest.xml"
  if [ ! -f "$manifest" ]; then
    skip "android/ not generated — skipping"
    return
  fi
  echo "Android"

  local kotlin_dir="android/app/src/main/kotlin/$package_path"
  mkdir -p "$kotlin_dir"
  cp platform/android/MainActivity.kt "$kotlin_dir/MainActivity.kt"
  say "MainActivity.kt installed"

  # Drop any block a previous run wrote, then insert the current one before the
  # activity closes. python3 ships with macOS and every Linux CI image.
  python3 - "$manifest" platform/android/intent-filters.xml <<'PY'
import re, sys

manifest_path, filters_path = sys.argv[1], sys.argv[2]
manifest = open(manifest_path, encoding='utf-8').read()

START = '<!-- md-converter:document-handlers:start -->'
END = '<!-- md-converter:document-handlers:end -->'

manifest = re.sub(re.escape(START) + r'.*?' + re.escape(END), '', manifest, flags=re.S)

filters = open(filters_path, encoding='utf-8').read()
# The file leads with an explanatory comment for readers of the repo; the
# manifest only needs the elements.
filters = filters.split('-->', 1)[1].strip()
block = '\n'.join('            ' + line if line.strip() else line
                  for line in (START + '\n' + filters + '\n' + END).split('\n'))

close = manifest.rfind('</activity>')
if close == -1:
    sys.exit('configure_platforms: no <activity> found in AndroidManifest.xml')

# The slice ends with the indentation that belonged to </activity>; the block
# brings its own, so drop it rather than doubling it up.
manifest = manifest[:close].rstrip(' ') + block + '\n        ' + manifest[close:]
open(manifest_path, 'w', encoding='utf-8').write(manifest)
PY
  say "intent filters merged into AndroidManifest.xml"

  pin_android_compile_sdk
  changed=1
}

# Every plugin module compiles against whatever compileSdk it was written for,
# and several of them are now older than what their own dependencies demand —
# flutter_native_splash against android-31 while androidx.window wants 33,
# file_picker against 34 while flutter_plugin_android_lifecycle wants 36. The
# build fails on twenty of these at once, and none of it is under this app's
# control, so the root project pins them all to one modern level.
#
# Reflection rather than typed access: the Android extension's classes are on
# the plugin modules' classpath, not the root project's.
#
# It goes in settings.gradle.kts rather than the root build file because the
# root build script is not early enough: Flutter's plugin loader has already
# finished evaluating some modules by the time it runs, and the Android plugin
# stops listening to compileSdk once a module is evaluated. Settings is read
# before any project at all, so `beforeProject` reaches every one of them.
pin_android_compile_sdk() {
  local gradle="android/settings.gradle.kts"
  [ -f "$gradle" ] || return 0

  local marker="// md-converter:compile-sdk"
  if grep -q "$marker" "$gradle"; then
    say "compileSdk pin already present"
    return 0
  fi

  cat >> "$gradle" <<'GRADLE'

// md-converter:compile-sdk — see tool/configure_platforms.sh
//
// Several plugin modules compile against an SDK older than their own
// dependencies now demand — flutter_native_splash against android-31 while
// androidx.window wants 33, and so on — and the build fails on all of them at
// once. None of it is under this app's control, so they are pinned here.
gradle.beforeProject {
    listOf("com.android.application", "com.android.library").forEach { pluginId ->
        plugins.withId(pluginId) {
            // withId fires as the plugin is applied, which is before the
            // module's own `android { compileSdk … }` block is read — setting it
            // there would just be overwritten. afterEvaluate is registered here
            // so it lands ahead of the Android plugin's own finalisation.
            afterEvaluate pin@{
                val android = extensions.findByName("android") ?: return@pin
                // AGP 8 exposes a `compileSdk` property; the older
                // `compileSdkVersion(int)` is what modules written against AGP 7
                // answer to. A module that takes neither is left alone.
                val applied = sequenceOf<() -> Unit>(
                    {
                        val setter = android.javaClass.methods.first {
                            it.name == "setCompileSdk" && it.parameterCount == 1
                        }
                        setter.invoke(android, 36)
                    },
                    {
                        val setter = android.javaClass.methods.first {
                            it.name == "compileSdkVersion" &&
                                it.parameterCount == 1 &&
                                it.parameterTypes[0] == Int::class.javaPrimitiveType
                        }
                        setter.invoke(android, 36)
                    },
                ).any { attempt -> attempt.runCatching { invoke() }.isSuccess }

                if (!applied) {
                    logger.lifecycle("md-converter: could not pin compileSdk for ${'$'}{project.name}")
                }
            }
        }
    }
}
GRADLE
  say "plugin modules pinned to compileSdk 36 in android/settings.gradle.kts"
}

# ------------------------------------------------------------------ iOS, macOS

# Declares the document types both Apple platforms open. `LSItemContentTypes`
# lists UTIs the app accepts; the imported type declaration teaches the system
# what a .md file is, since Apple has no built-in UTI for Markdown.
write_apple_document_types() {
  local plist="$1"

  # PlistBuddy exits non-zero on a key that is not there, so a first run and a
  # re-run both have to tolerate the delete failing. Clearing first is what
  # keeps this idempotent instead of appending a second copy of everything.
  /usr/libexec/PlistBuddy -c "Delete :CFBundleDocumentTypes" "$plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Delete :UTImportedTypeDeclarations" "$plist" >/dev/null 2>&1 || true

  /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes array" "$plist" >/dev/null

  # Markdown stands alone, as Editor/Owner: that pair is what decides whether
  # Files and Finder put this app at the top of "Open with" for a .md file
  # rather than at the bottom of a list nobody scrolls. It is honest, too — the
  # app edits Markdown and writes it out, which is more than the formats below,
  # where it is one converter among the system's own viewers and must not push
  # Preview or Pages aside. The extensions are listed as well as the UTI so a
  # .md file that arrived from a source Launch Services cannot type still
  # matches.
  _add_document_type "$plist" 0 "Markdown" Editor Owner "net.daringfireball.markdown"
  _add_type_extensions "$plist" 0 md markdown mdown mkd mdx

  _add_document_type "$plist" 1 "Plain text" Viewer Alternate "public.plain-text" "public.text"
  _add_document_type "$plist" 2 "PDF" Viewer Alternate "com.adobe.pdf"
  _add_document_type "$plist" 3 "Word document" Viewer Alternate "org.openxmlformats.wordprocessingml.document"
  _add_document_type "$plist" 4 "Spreadsheet" Viewer Alternate "org.openxmlformats.spreadsheetml.sheet"
  _add_document_type "$plist" 5 "Presentation" Viewer Alternate "org.openxmlformats.presentationml.presentation"
  _add_document_type "$plist" 6 "OpenDocument" Viewer Alternate "org.oasis-open.opendocument.text" \
      "org.oasis-open.opendocument.spreadsheet" "org.oasis-open.opendocument.presentation"
  _add_document_type "$plist" 7 "EPUB" Viewer Alternate "org.idpf.epub-container"
  _add_document_type "$plist" 8 "Rich text" Viewer Alternate "public.rtf"
  _add_document_type "$plist" 9 "Web page" Viewer Alternate "public.html"
  _add_document_type "$plist" 10 "Comma-separated values" Viewer Alternate "public.comma-separated-values-text"
  _add_document_type "$plist" 11 "Email" Viewer Alternate "com.apple.mail.email"
  _add_document_type "$plist" 12 "Image" Viewer Alternate "public.image"

  # Markdown has no system UTI, so the app declares one and claims the
  # extensions — this is what puts it in Finder's and Files' "Open with".
  /usr/libexec/PlistBuddy "$plist" <<'PLIST' >/dev/null
Add :UTImportedTypeDeclarations array
Add :UTImportedTypeDeclarations:0 dict
Add :UTImportedTypeDeclarations:0:UTTypeIdentifier string net.daringfireball.markdown
Add :UTImportedTypeDeclarations:0:UTTypeDescription string Markdown
Add :UTImportedTypeDeclarations:0:UTTypeConformsTo array
Add :UTImportedTypeDeclarations:0:UTTypeConformsTo:0 string public.plain-text
Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification dict
Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension array
Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:0 string md
Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:1 string markdown
Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:2 string mdown
Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:3 string mkd
Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:4 string mdx
Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.mime-type array
Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.mime-type:0 string text/markdown
PLIST
}

# _add_document_type <plist> <index> <name> <role> <rank> <uti>...
#
# Role is Editor only where the app really edits the file in place; everywhere
# else it is Viewer, which is what the converter does. Rank decides the order
# of the "Open with" list, so it is Owner for Markdown and Alternate for the
# formats the system already has better apps for.
_add_document_type() {
  local plist="$1" index="$2" name="$3" role="$4" rank="$5"
  shift 5

  /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:$index dict" "$plist" >/dev/null
  /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:$index:CFBundleTypeName string $name" "$plist" >/dev/null
  /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:$index:CFBundleTypeRole string $role" "$plist" >/dev/null
  /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:$index:LSHandlerRank string $rank" "$plist" >/dev/null
  /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:$index:LSItemContentTypes array" "$plist" >/dev/null

  local slot=0
  for uti in "$@"; do
    /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:$index:LSItemContentTypes:$slot string $uti" "$plist" >/dev/null
    slot=$((slot + 1))
  done
}

# The pre-UTI way of claiming a file, still consulted when a document arrives
# with no type Launch Services recognises — a .md downloaded by a browser, most
# often.
_add_type_extensions() {
  local plist="$1" index="$2"
  shift 2

  /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:$index:CFBundleTypeExtensions array" "$plist" >/dev/null
  local slot=0
  for extension in "$@"; do
    /usr/libexec/PlistBuddy -c \
      "Add :CFBundleDocumentTypes:$index:CFBundleTypeExtensions:$slot string $extension" "$plist" >/dev/null
    slot=$((slot + 1))
  done
}

_set_bool() {
  /usr/libexec/PlistBuddy -c "Delete :$2" "$1" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :$2 bool $3" "$1" >/dev/null
}

configure_ios() {
  local plist="ios/Runner/Info.plist"
  if [ ! -f "$plist" ]; then
    skip "ios/ not generated — skipping"
    return
  fi
  if [ ! -x /usr/libexec/PlistBuddy ]; then
    skip "ios/ needs PlistBuddy — run this on macOS"
    return
  fi
  echo "iOS / iPadOS"

  cp platform/ios/AppDelegate.swift ios/Runner/AppDelegate.swift
  say "AppDelegate.swift installed"

  write_apple_document_types "$plist"
  # Open the user's file where it sits instead of on a copy, and show the app's
  # own documents in the Files app.
  _set_bool "$plist" LSSupportsOpeningDocumentsInPlace true
  _set_bool "$plist" UIFileSharingEnabled true
  _set_bool "$plist" UISupportsDocumentBrowser false
  say "document types written to Info.plist"
  changed=1
}

configure_macos() {
  local plist="macos/Runner/Info.plist"
  if [ ! -f "$plist" ]; then
    skip "macos/ not generated — skipping"
    return
  fi
  if [ ! -x /usr/libexec/PlistBuddy ]; then
    skip "macos/ needs PlistBuddy — run this on macOS"
    return
  fi
  echo "macOS"

  cp platform/macos/AppDelegate.swift macos/Runner/AppDelegate.swift
  cp platform/macos/MainFlutterWindow.swift macos/Runner/MainFlutterWindow.swift
  say "AppDelegate.swift and MainFlutterWindow.swift installed"

  write_apple_document_types "$plist"
  say "document types written to Info.plist"

  # The sandboxed template cannot read a file the user picked or dropped
  # without this. No network entitlement is added — the app never opens a
  # socket, and that is the point of it.
  for entitlements in macos/Runner/DebugProfile.entitlements macos/Runner/Release.entitlements; do
    [ -f "$entitlements" ] || continue
    _set_bool "$entitlements" com.apple.security.files.user-selected.read-write true
    say "$(basename "$entitlements"): user-selected file access granted"
  done
  changed=1
}

# ------------------------------------------------------------------------ main

echo "Configuring document handlers for $bundle_id"
echo

configure_android
configure_ios
configure_macos

echo
if [ "$changed" -eq 0 ]; then
  echo "Nothing to configure — run flutter create first."
  exit 1
fi

cat <<'DONE'
Done. Rebuild for the system to pick up the new registrations:

  flutter run -d android    # then long-press a .md in Files → Open with
  flutter run -d ios        # then share a .md → MD Converter
  flutter run -d macos      # then right-click a .md in Finder → Open With

macOS caches Launch Services aggressively. If Finder does not offer the app:

  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -kill -r -domain local -domain system -domain user
DONE
