import 'package:flutter_test/flutter_test.dart';
import 'package:md_converter/src/core/markdown_editing.dart';

/// The editor's rules, asserted against the same cases the PWA's editor was
/// checked against in a browser — so a change that shifts behaviour in one
/// engine and not the other shows up as a failure here.
void main() {
  /// Applies an action to `text`, with the selection written as `|` for a caret
  /// or `[...]` around a range, and returns the result in the same notation.
  String run(EditorAction action, String marked) {
    final (text, start, end) = _parse(marked);
    final result = applyAction(action, text, start, end);
    return _mark(result.text, result.start, result.end);
  }

  group('wrapping', () {
    test('bold wraps a selection', () {
      expect(run(EditorAction.bold, '[hello] world'), '**[hello]** world');
    });

    test('bold on already-bold text takes the marks off', () {
      expect(run(EditorAction.bold, '**[hello]** world'), '[hello] world');
    });

    test('bold with nothing selected leaves a placeholder selected', () {
      expect(run(EditorAction.bold, '|'), '**[bold text]**');
    });
  });

  group('line marks', () {
    test('a heading applies to the caret line', () {
      expect(run(EditorAction.h2, 'hello| world'), '[## hello world]');
    });

    test('the same heading again removes it', () {
      expect(run(EditorAction.h2, '## hello| world'), '[hello world]');
    });

    test('a heading replaces a bullet rather than stacking on it', () {
      expect(run(EditorAction.h1, '- an| item'), '[# an item]');
    });

    test('a numbered list renumbers every selected line', () {
      expect(run(EditorAction.number, '[one\ntwo\nthree]'), '[1. one\n2. two\n3. three]');
    });

    test('blank lines inside a selection are left alone', () {
      expect(run(EditorAction.bullet, '[one\n\ntwo]'), '[- one\n\n- two]');
    });

    // `- ` is a prefix of `- [ ] `, so a matcher derived from the prefix read a
    // checklist item as an ordinary bullet and left the orphan `[ ]` behind.
    test('a bullet over a checklist item drops the box, not just the dash', () {
      expect(run(EditorAction.bullet, '- [ ] a|'), '[- a]');
      expect(run(EditorAction.bullet, '- [x] a|'), '[- a]');
    });

    test('a checklist over a plain bullet adds the box', () {
      expect(run(EditorAction.task, '- a|'), '[- [ ] a]');
    });

    test('a heading button converts another level rather than toggling', () {
      expect(run(EditorAction.h1, '## Title|'), '[# Title]');
      expect(run(EditorAction.h3, '## Title|'), '[### Title]');
    });

    test('an indented paragraph keeps its indentation', () {
      expect(run(EditorAction.bullet, '  some text|'), '[  - some text]');
    });
  });

  group('links', () {
    test('a selected URL becomes the target, with the label selected', () {
      expect(run(EditorAction.link, '[https://example.org]'), '[[link text]](https://example.org)');
    });

    test('selected words become the label, with the address selected', () {
      expect(run(EditorAction.link, '[the protocol]'), '[the protocol]([https://])');
    });
  });

  group('blocks', () {
    test('a divider lands on its own line', () {
      expect(run(EditorAction.rule, 'text|'), 'text\n\n[---]\n');
    });
  });

  group('Enter inside a list', () {
    EditResult? enter(String marked) {
      final (text, start, _) = _parse(marked);
      return continueList(text, start);
    }

    test('continues a bulleted list', () {
      final result = enter('- milk|')!;
      expect(result.text, '- milk\n- ');
      expect(result.start, result.text.length);
    });

    test('counts a numbered list on', () {
      expect(enter('1. first\n2. second|')!.text, '1. first\n2. second\n3. ');
    });

    test('keeps the box on a checklist', () {
      expect(enter('- [ ] buy stamps|')!.text, '- [ ] buy stamps\n- [ ] ');
    });

    test('an empty item ends the list', () {
      expect(enter('- milk\n- |')!.text, '- milk\n');
    });

    test('continues a quote', () {
      expect(enter('> to be|')!.text, '> to be\n> ');
    });

    test('an ordinary paragraph is left to the platform', () {
      expect(enter('just words|'), isNull);
    });
  });

  group('Tab inside a list', () {
    test('nests an item, and lifts it back out', () {
      final (text, start, end) = _parse('- one\n- two|');
      final nested = indentListItems(text, start, end, outdent: false)!;
      expect(nested.text, '- one\n  - two');

      final lifted = indentListItems(nested.text, nested.start, nested.end, outdent: true)!;
      expect(lifted.text, '- one\n- two');
    });

    test('does nothing outside a list, so Tab still moves focus', () {
      final (text, start, end) = _parse('a paragraph|');
      expect(indentListItems(text, start, end, outdent: false), isNull);
    });
  });
}

/// `|` marks a caret, `[...]` marks a selection.
(String, int, int) _parse(String marked) {
  final caret = marked.indexOf('|');
  if (caret != -1) {
    final text = marked.replaceFirst('|', '');
    return (text, caret, caret);
  }
  final open = marked.indexOf('[');
  final close = marked.indexOf(']', open + 1);
  final text = marked.substring(0, open) + marked.substring(open + 1, close) + marked.substring(close + 1);
  return (text, open, close - 1);
}

String _mark(String text, int start, int end) {
  if (start == end) return '${text.substring(0, start)}|${text.substring(start)}';
  return '${text.substring(0, start)}[${text.substring(start, end)}]${text.substring(end)}';
}
