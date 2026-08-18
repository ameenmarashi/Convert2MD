/// The editing rules behind the Markdown editor, as pure functions.
///
/// Mirrors `web/src/ui/editor.ts`. Keeping the logic out of the widget means
/// the two apps can be compared line by line, and that every rule — what Bold
/// does to a selection, what Enter does inside a list — is testable without a
/// screen.
library;

/// Everything the toolbar and the keyboard shortcuts can do.
enum EditorAction {
  bold,
  italic,
  strike,
  code,
  h1,
  h2,
  h3,
  bullet,
  number,
  task,
  quote,
  link,
  table,
  rule,
}

/// The document after an edit, and where the selection should land.
class EditResult {
  const EditResult({required this.text, required this.start, required this.end});

  final String text;
  final int start;
  final int end;
}

const Map<EditorAction, ({String before, String after, String placeholder})> _wraps = {
  EditorAction.bold: (before: '**', after: '**', placeholder: 'bold text'),
  EditorAction.italic: (before: '*', after: '*', placeholder: 'italic text'),
  EditorAction.strike: (before: '~~', after: '~~', placeholder: 'crossed out'),
  EditorAction.code: (before: '`', after: '`', placeholder: 'code'),
};

/// A line mark, and what counts as "this line already has it" for the toggle.
///
/// The matcher is written out per action rather than derived from the prefix,
/// because deriving gets the overlaps wrong: `- ` is a prefix of `- [ ] `, so a
/// checklist item read as an ordinary bullet, and turning it into one left the
/// orphan `[ ]` behind.
typedef LineMark = ({String prefix, RegExp matcher});

final Map<EditorAction, LineMark> _lineMarks = {
  // `#\s+` cannot match `## `, so a heading button converts a heading of
  // another level instead of toggling it off.
  EditorAction.h1: (prefix: '# ', matcher: RegExp(r'^(\s*)#\s+')),
  EditorAction.h2: (prefix: '## ', matcher: RegExp(r'^(\s*)##\s+')),
  EditorAction.h3: (prefix: '### ', matcher: RegExp(r'^(\s*)###\s+')),
  EditorAction.bullet: (prefix: '- ', matcher: RegExp(r'^(\s*)[-*+]\s+(?!\[[ xX]\]\s)')),
  EditorAction.number: (prefix: '1. ', matcher: RegExp(r'^(\s*)\d+[.)]\s+')),
  EditorAction.task: (prefix: '- [ ] ', matcher: RegExp(r'^(\s*)[-*+]\s+\[[ xX]\]\s+')),
  EditorAction.quote: (prefix: '> ', matcher: RegExp(r'^(\s*)>\s?')),
};

/// Any mark that already owns the start of a line, so applying a new one
/// replaces it rather than stacking — a line cannot be a heading and a bullet.
final RegExp _anyLineMark = RegExp(r'^(\s*)(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+|>\s?)');

final RegExp _listItem = RegExp(r'^(\s*)([-*+]|\d+[.)])(\s+\[[ xX]\])?\s+(.*)$');
final RegExp _quoteLine = RegExp(r'^(\s*)>\s?(.*)$');

EditResult applyAction(EditorAction action, String text, int start, int end) {
  final wrap = _wraps[action];
  if (wrap != null) return _applyWrap(wrap, text, start, end);

  final mark = _lineMarks[action];
  if (mark != null) return _applyLineMark(mark, text, start, end);

  return switch (action) {
    EditorAction.link => _applyLink(text, start, end),
    EditorAction.table => _insertBlock('| Column | Column |\n| --- | --- |\n| Cell | Cell |', text, start, end),
    EditorAction.rule => _insertBlock('---', text, start, end),
    _ => EditResult(text: text, start: start, end: end),
  };
}

/// Wrapping is a toggle: pressing Bold on bold text takes the marks off.
EditResult _applyWrap(
  ({String before, String after, String placeholder}) wrap,
  String text,
  int start,
  int end,
) {
  final selected = text.substring(start, end);
  final outerStart = start - wrap.before.length;

  final alreadyWrapped = outerStart >= 0 &&
      text.substring(outerStart, start) == wrap.before &&
      end + wrap.after.length <= text.length &&
      text.substring(end, end + wrap.after.length) == wrap.after;

  if (alreadyWrapped) {
    final updated = text.substring(0, outerStart) + selected + text.substring(end + wrap.after.length);
    return EditResult(text: updated, start: outerStart, end: outerStart + selected.length);
  }

  if (selected.startsWith(wrap.before) &&
      selected.endsWith(wrap.after) &&
      selected.length > wrap.before.length + wrap.after.length) {
    final inner = selected.substring(wrap.before.length, selected.length - wrap.after.length);
    return EditResult(
      text: text.substring(0, start) + inner + text.substring(end),
      start: start,
      end: start + inner.length,
    );
  }

  final body = selected.isEmpty ? wrap.placeholder : selected;
  final inserted = wrap.before + body + wrap.after;
  return EditResult(
    text: text.substring(0, start) + inserted + text.substring(end),
    start: start + wrap.before.length,
    end: start + wrap.before.length + body.length,
  );
}

/// Headings, lists and quotes apply to whole lines, and toggle off when every
/// selected line already carries the mark — so the same button undoes itself.
EditResult _applyLineMark(LineMark mark, String text, int start, int end) {
  final prefix = mark.prefix;
  final matcher = mark.matcher;
  final from = _lineStart(text, start);
  final to = _lineEnd(text, end);
  final lines = text.substring(from, to).split('\n');

  final ordered = RegExp(r'^\d+\. $').hasMatch(prefix);
  final allMarked = lines.every((line) => line.trim().isEmpty || matcher.hasMatch(line));

  var counter = 1;
  final updated = lines.map((line) {
    if (line.trim().isEmpty) return line;
    // Strip the mark, keep the indentation the line was sitting at.
    if (allMarked) return line.replaceFirst(matcher, _indentOf(line));

    final bare = line.replaceFirst(_anyLineMark, _indentOf(line));
    final indent = _indentOf(bare);
    final body = bare.substring(indent.length);
    return '$indent${ordered ? '${counter++}. ' : prefix}$body';
  }).toList();

  final replacement = updated.join('\n');
  return EditResult(
    text: text.substring(0, from) + replacement + text.substring(to),
    start: from,
    end: from + replacement.length,
  );
}

EditResult _applyLink(String text, int start, int end) {
  final selected = text.substring(start, end);
  // Selecting a URL means the user wants that as the target, not the label.
  final isUrl = RegExp(r'^(https?://|mailto:|/|\./)\S*$', caseSensitive: false).hasMatch(selected.trim());
  final label = isUrl || selected.isEmpty ? 'link text' : selected;
  final href = isUrl ? selected.trim() : 'https://';
  final inserted = '[$label]($href)';

  // Land the selection on the half the user still has to fill in.
  final selectFrom = isUrl ? start + 1 : start + inserted.length - href.length - 1;
  final selectTo = isUrl ? start + 1 + label.length : start + inserted.length - 1;
  return EditResult(
    text: text.substring(0, start) + inserted + text.substring(end),
    start: selectFrom,
    end: selectTo,
  );
}

EditResult _insertBlock(String block, String text, int start, int end) {
  final before = start > 0 && text[start - 1] != '\n' ? '\n\n' : '';
  final after = end < text.length && text[end] != '\n' ? '\n\n' : '\n';
  final inserted = before + block + after;
  return EditResult(
    text: text.substring(0, start) + inserted + text.substring(end),
    start: start + before.length,
    end: start + before.length + block.length,
  );
}

/// Enter on a list item starts the next one; Enter on an empty item ends the
/// list instead of leaving a stray marker behind. Numbers count on.
///
/// Returns null when the caret is not on a list or quote line, so the caller
/// lets the platform insert an ordinary newline.
EditResult? continueList(String text, int caret) {
  final from = _lineStart(text, caret);
  final line = text.substring(from, caret);

  final item = _listItem.firstMatch(line);
  if (item != null) {
    final indent = item.group(1)!;
    final marker = item.group(2)!;
    final checkbox = item.group(3);
    final body = item.group(4)!;

    if (body.trim().isEmpty) {
      // An empty item means "I am done with this list".
      return EditResult(
        text: text.substring(0, from) + indent + text.substring(caret),
        start: from + indent.length,
        end: from + indent.length,
      );
    }

    final digits = RegExp(r'^\d+').firstMatch(marker);
    final next = digits != null
        ? '${int.parse(digits.group(0)!) + 1}${marker.substring(marker.length - 1)}'
        : marker;
    final box = checkbox != null ? ' [ ]' : '';
    final inserted = '\n$indent$next$box ';
    return EditResult(
      text: text.substring(0, caret) + inserted + text.substring(caret),
      start: caret + inserted.length,
      end: caret + inserted.length,
    );
  }

  final quote = _quoteLine.firstMatch(line);
  if (quote != null) {
    final indent = quote.group(1)!;
    if (quote.group(2)!.trim().isEmpty) {
      return EditResult(
        text: text.substring(0, from) + indent + text.substring(caret),
        start: from + indent.length,
        end: from + indent.length,
      );
    }
    final inserted = '\n$indent> ';
    return EditResult(
      text: text.substring(0, caret) + inserted + text.substring(caret),
      start: caret + inserted.length,
      end: caret + inserted.length,
    );
  }

  return null;
}

/// Tab nests a list item under the one above; Shift+Tab lifts it back out.
/// Returns null when no selected line is a list item.
EditResult? indentListItems(String text, int start, int end, {required bool outdent}) {
  final from = _lineStart(text, start);
  final to = _lineEnd(text, end);
  final lines = text.substring(from, to).split('\n');
  if (!lines.any(_listItem.hasMatch)) return null;

  final updated = lines.map((line) {
    if (!_listItem.hasMatch(line)) return line;
    return outdent ? line.replaceFirst(RegExp(r'^ {1,2}'), '') : '  $line';
  }).toList();

  final replacement = updated.join('\n');
  return EditResult(
    text: text.substring(0, from) + replacement + text.substring(to),
    start: from,
    end: from + replacement.length,
  );
}

String _indentOf(String line) => RegExp(r'^\s*').firstMatch(line)!.group(0)!;

int _lineStart(String text, int index) => text.lastIndexOf('\n', index - 1) + 1;

int _lineEnd(String text, int index) {
  final next = text.indexOf('\n', index);
  return next == -1 ? text.length : next;
}
