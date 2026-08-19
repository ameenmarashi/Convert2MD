import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:md_converter/l10n/app_localizations.dart';
import 'package:md_converter/main.dart';
import 'package:md_converter/src/core/markdown_editing.dart';
import 'package:md_converter/src/ui/reader_page.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The app actually building and running, rather than only compiling.
///
/// These are the checks that catch what static analysis cannot: a theme that no
/// longer type-checks against the framework, a toolbar action that throws on an
/// empty document, a screen that fails to lay out.
void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Widget reader({required String name, required String markdown}) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: ReaderPage(name: name, markdown: markdown),
    );
  }

  testWidgets('the app builds and shows the home screen', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: MdConverterApp()));
    await tester.pumpAndSettle();

    expect(find.text('MD Converter'), findsOneWidget);
    expect(find.text('Choose files'), findsOneWidget);
    expect(find.text('Start a new document'), findsOneWidget);
    expect(find.text('Open a .md file'), findsOneWidget);
  });

  testWidgets('the explainers are collapsed until asked for', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: MdConverterApp()));
    await tester.pumpAndSettle();

    final privacy = find.text('Privacy — your files are never collected');
    expect(privacy, findsOneWidget);
    // A collapsed ExpansionTile does not build its body at all.
    expect(find.textContaining('never used to train'), findsNothing);

    // It sits below the fold in the test viewport.
    await tester.scrollUntilVisible(privacy, 200, scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    await tester.tap(privacy);
    await tester.pumpAndSettle();
    expect(find.textContaining('never used to train or prompt any AI'), findsOneWidget);
  });

  testWidgets('the reader renders a document, and Edit opens the editor', (tester) async {
    await tester.pumpWidget(reader(name: 'notes.md', markdown: '# Title\n\nA paragraph.'));
    await tester.pumpAndSettle();

    expect(find.text('notes.md'), findsOneWidget);
    expect(find.text('Title'), findsOneWidget);
    expect(find.text('A paragraph.'), findsOneWidget);

    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    expect(find.byType(TextField), findsWidgets);
    expect(find.text('H1'), findsOneWidget);
    expect(find.text('• List'), findsOneWidget);
  });

  testWidgets('a toolbar action on an empty document does not throw', (tester) async {
    // The case that crashed before the bounds fix: a caret at position 0.
    await tester.pumpWidget(reader(name: 'blank.md', markdown: ''));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('• List'));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    final field = tester.widget<TextField>(find.byType(TextField).first);
    expect(field.controller?.text, '- ');
  });

  testWidgets('typing redraws the preview', (tester) async {
    await tester.pumpWidget(reader(name: 'notes.md', markdown: ''));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, '## A new heading');
    await tester.pumpAndSettle(const Duration(milliseconds: 400));

    // Once in the text field, once rendered in the preview beside it.
    expect(find.text('A new heading'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  test('the editing rules survive an empty document', () {
    // `lastIndexOf` clamps a negative start in JavaScript and throws in Dart,
    // so position 0 is the case worth pinning down.
    expect(applyAction(EditorAction.bullet, '', 0, 0).text, '- ');
    expect(applyAction(EditorAction.h1, '', 0, 0).text, '# ');
    expect(applyAction(EditorAction.bold, '', 0, 0).text, '**bold text**');
    expect(continueList('', 0), isNull);
    expect(indentListItems('', 0, 0, outdent: false), isNull);
  });
}
