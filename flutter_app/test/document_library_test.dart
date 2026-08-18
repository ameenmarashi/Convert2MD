import 'package:flutter_test/flutter_test.dart';
import 'package:md_converter/src/core/document_library.dart';

/// Naming rules for documents on disk, mirroring `web/test/library.test.mjs`.
/// The file operations themselves need a real directory, so they are exercised
/// on device rather than here.
void main() {
  group('document names', () {
    test('keeps the words people actually write', () {
      expect(DocumentLibrary.normaliseName('My notes'), 'My notes.md');
      expect(DocumentLibrary.normaliseName('Q3 plan - draft'), 'Q3 plan - draft.md');
      expect(DocumentLibrary.normaliseName('  padded  '), 'padded.md');
    });

    test('loses only what a file system would refuse', () {
      expect(DocumentLibrary.normaliseName('a/b:c*d'), 'abcd.md');
      expect(DocumentLibrary.normaliseName('what?'), 'what.md');
      expect(DocumentLibrary.normaliseName(r'back\slash'), 'backslash.md');
    });

    test('leaves an existing extension alone, and gives an empty name one', () {
      expect(DocumentLibrary.normaliseName('notes.md'), 'notes.md');
      expect(DocumentLibrary.normaliseName('notes.markdown'), 'notes.markdown');
      expect(DocumentLibrary.normaliseName('   '), 'Untitled.md');
      expect(DocumentLibrary.normaliseName('///'), 'Untitled.md');
    });

    test('does not run away with a very long name', () {
      final long = DocumentLibrary.normaliseName('x' * 400);
      expect(long.length, 123);
      expect(long.endsWith('.md'), isTrue);
    });
  });
}
