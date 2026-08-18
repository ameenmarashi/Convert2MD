import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/text_decode.dart';

/// Rich Text Format (.rtf) → Markdown. Mirrors `web/src/converters/rtf.ts`.
const Set<String> _skipDestinations = {
  'fonttbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable', 'info', 'pict', 'object',
  'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'generator', 'xmlnstbl',
  'mmathPr', 'wgrffmtfilter', 'nonesttables', 'shppict', 'header', 'headerl', 'headerr', 'headerf',
  'footer', 'footerl', 'footerr', 'footerf', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc', 'panose',
  'falt', 'listtext', 'pntext', 'pntxta', 'pntxtb', 'atrfstart', 'atrfend', 'annotation',
};

const Map<String, String> _controlSymbols = {
  'par': '\n',
  'line': '\n',
  'tab': '\t',
  'emdash': '—',
  'endash': '–',
  'emspace': ' ',
  'enspace': ' ',
  'qmspace': ' ',
  'bullet': '•',
  'lquote': '‘',
  'rquote': '’',
  'ldblquote': '“',
  'rdblquote': '”',
  '~': ' ',
  '_': '-',
  '-': '',
};

const Map<int, String> _cp1252High = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

RawOutput convertRtf(SourceFile file, ConvertOptions options) {
  return _RtfParser(latin1String(file.bytes), options).parse();
}

class _Run {
  _Run({
    required this.text,
    required this.bold,
    required this.italic,
    required this.strike,
    required this.href,
  });

  String text;
  final bool bold;
  final bool italic;
  final bool strike;
  final String? href;
}

class _Paragraph {
  final List<_Run> runs = <_Run>[];
  int outlineLevel = 0;
  int listLevel = 0;
  bool isListItem = false;
  bool inTable = false;
  double maxFontSize = 0;
}

class _State {
  _State({
    this.bold = false,
    this.italic = false,
    this.strike = false,
    this.hidden = false,
    this.fontSize = 0,
    this.destination = '',
    this.unicodeSkip = 1,
  });

  bool bold;
  bool italic;
  bool strike;
  bool hidden;
  double fontSize;
  String destination;
  int unicodeSkip;

  _State copy() => _State(
        bold: bold,
        italic: italic,
        strike: strike,
        hidden: hidden,
        fontSize: fontSize,
        destination: destination,
        unicodeSkip: unicodeSkip,
      );
}

class _RtfParser {
  _RtfParser(this.src, this.options);

  final String src;
  final ConvertOptions options;

  int _pos = 0;
  final List<_State> _stack = <_State>[];
  _State _state = _State();

  final List<_Paragraph> _paragraphs = <_Paragraph>[];
  _Paragraph _current = _Paragraph();
  List<String> _pendingCells = <String>[];
  final List<List<String>> _tableRows = <List<String>>[];
  final Map<String, String> _meta = <String, String>{};
  final List<String> _warnings = <String>[];
  String? _linkTarget;
  String? _fieldInstruction;
  int _skipCharacters = 0;

  RawOutput parse() {
    if (!src.startsWith(r'{\rtf')) {
      _warnings.add('File does not start with an RTF header; parsed anyway.');
    }

    while (_pos < src.length) {
      final ch = src[_pos];

      if (ch == '{') {
        _pos++;
        _stack.add(_state.copy());
        continue;
      }
      if (ch == '}') {
        _pos++;
        if (_stack.isNotEmpty) {
          final restored = _stack.removeLast();
          if (_state.destination == 'fldrslt' && restored.destination != 'fldrslt') {
            _linkTarget = null;
          }
          _state = restored;
        }
        continue;
      }
      if (ch == r'\') {
        _readControl();
        continue;
      }
      if (ch == '\r' || ch == '\n') {
        _pos++;
        continue;
      }

      _pos++;
      _pushText(ch);
    }

    _endParagraph();
    return _render();
  }

  void _readControl() {
    _pos++;
    if (_pos >= src.length) return;
    final ch = src[_pos];

    if (ch == "'") {
      final hex = _pos + 3 <= src.length ? src.substring(_pos + 1, _pos + 3) : '';
      _pos += 3;
      final code = int.tryParse(hex, radix: 16);
      if (code != null) {
        if (_skipCharacters > 0) {
          _skipCharacters--;
        } else {
          _pushText(_cp1252High[code] ?? String.fromCharCode(code));
        }
      }
      return;
    }

    if (!RegExp('[a-zA-Z]').hasMatch(ch)) {
      _pos++;
      if (ch == r'\' || ch == '{' || ch == '}') {
        _pushText(ch);
      } else if (ch == '*') {
        _markIgnorableDestination();
      } else if (ch == '\n' || ch == '\r') {
        _endParagraphBreak();
      } else {
        final mapped = _controlSymbols[ch];
        if (mapped != null) _pushText(mapped);
      }
      return;
    }

    final start = _pos;
    while (_pos < src.length && RegExp('[a-zA-Z]').hasMatch(src[_pos])) {
      _pos++;
    }
    final word = src.substring(start, _pos);

    int? parameter;
    if (_pos < src.length && (src[_pos] == '-' || RegExp(r'\d').hasMatch(src[_pos]))) {
      final numStart = _pos;
      if (src[_pos] == '-') _pos++;
      while (_pos < src.length && RegExp(r'\d').hasMatch(src[_pos])) {
        _pos++;
      }
      parameter = int.tryParse(src.substring(numStart, _pos));
    }
    if (_pos < src.length && src[_pos] == ' ') _pos++;

    _applyControlWord(word, parameter);
  }

  void _markIgnorableDestination() {
    final save = _pos;
    if (_pos >= src.length || src[_pos] != r'\') return;
    _pos++;
    final start = _pos;
    while (_pos < src.length && RegExp('[a-zA-Z]').hasMatch(src[_pos])) {
      _pos++;
    }
    final word = src.substring(start, _pos);
    if (_pos < src.length && src[_pos] == ' ') _pos++;

    if (word == 'fldinst') {
      _state.destination = 'fldinst';
      _fieldInstruction = '';
      return;
    }
    _pos = save;
    _skipGroup();
  }

  void _skipGroup() {
    var depth = 1;
    while (_pos < src.length && depth > 0) {
      final ch = src[_pos];
      if (ch == r'\') {
        _pos += 2;
        continue;
      }
      if (ch == '{') {
        depth++;
      } else if (ch == '}') {
        depth--;
      }
      _pos++;
    }
    if (_stack.isNotEmpty) _state = _stack.removeLast();
  }

  void _applyControlWord(String word, int? parameter) {
    if (_skipDestinations.contains(word)) {
      if (word == 'listtext' || word == 'pntext') _current.isListItem = true;
      _skipGroup();
      return;
    }

    switch (word) {
      case 'par':
        _endParagraphBreak();
      case 'line':
      case 'softline':
        _pushText('\n');
      case 'tab':
        _pushText('\t');
      case 'cell':
        _pendingCells.add(_currentText().trim());
        _current = _Paragraph();
      case 'row':
      case 'nestrow':
        if (_pendingCells.isNotEmpty) {
          _tableRows.add(_pendingCells);
          _pendingCells = <String>[];
        }
        _current = _Paragraph();
      case 'trowd':
      case 'intbl':
        _current.inTable = true;
      case 'pard':
        _current.outlineLevel = 0;
        _current.listLevel = 0;
        _current.isListItem = false;
        _state.bold = false;
        _state.italic = false;
        _state.strike = false;
      case 'plain':
        _state.bold = false;
        _state.italic = false;
        _state.strike = false;
        _state.hidden = false;
      case 'b':
        _state.bold = parameter != 0;
      case 'i':
        _state.italic = parameter != 0;
      case 'strike':
      case 'striked':
        _state.strike = parameter != 0;
      case 'v':
        _state.hidden = parameter != 0;
      case 'fs':
        _state.fontSize = (parameter ?? 24) / 2;
        if (_state.fontSize > _current.maxFontSize) _current.maxFontSize = _state.fontSize;
      case 'outlinelvl':
        _current.outlineLevel = (parameter ?? 0) + 1;
      case 'ilvl':
        _current.listLevel = parameter ?? 0;
      case 'li':
        final level = ((parameter ?? 0) / 360).floor();
        if (level > _current.listLevel) _current.listLevel = level;
      case 'ls':
        _current.isListItem = true;
      case 'uc':
        _state.unicodeSkip = parameter ?? 1;
      case 'u':
        final code = parameter ?? 0;
        _pushText(_safeChar(code < 0 ? code + 65536 : code));
        _skipCharacters = _state.unicodeSkip;
      case 'field':
        _linkTarget = null;
      case 'fldrslt':
        _state.destination = 'fldrslt';
      case 'title':
      case 'author':
      case 'subject':
      case 'company':
      case 'operator':
        _readMetaGroup(word);
      default:
        final mapped = _controlSymbols[word];
        if (mapped != null) _pushText(mapped);
    }
  }

  void _readMetaGroup(String key) {
    final start = _pos;
    var depth = 1;
    final buffer = StringBuffer();
    while (_pos < src.length && depth > 0) {
      final ch = src[_pos];
      if (ch == '{') {
        depth++;
      } else if (ch == '}') {
        depth--;
        if (depth == 0) break;
      } else if (ch == r'\') {
        _pos += 2;
        continue;
      } else {
        buffer.write(ch);
      }
      _pos++;
    }
    final value = buffer.toString().trim();
    if (value.isNotEmpty) _meta[key] = value;
    if (_pos <= start) _pos = start;
  }

  void _pushText(String text) {
    if (text.isEmpty || _state.hidden) return;

    if (_skipCharacters > 0 && text != '\n' && text != '\t') {
      _skipCharacters--;
      return;
    }

    if (_state.destination == 'fldinst') {
      _fieldInstruction = (_fieldInstruction ?? '') + text;
      final match =
          RegExp('HYPERLINK\\s+"([^"]+)"', caseSensitive: false).firstMatch(_fieldInstruction!);
      if (match != null) _linkTarget = match.group(1);
      return;
    }

    // Track the largest size actually used for text, not just where \fs appears,
    // so paragraphs that inherit a size still take part in heading detection.
    final size = _state.fontSize == 0 ? 12.0 : _state.fontSize;
    if (size > _current.maxFontSize) _current.maxFontSize = size;

    if (_current.runs.isNotEmpty) {
      final last = _current.runs.last;
      if (last.bold == _state.bold &&
          last.italic == _state.italic &&
          last.strike == _state.strike &&
          last.href == _linkTarget) {
        last.text += text;
        return;
      }
    }
    _current.runs.add(_Run(
      text: text,
      bold: _state.bold,
      italic: _state.italic,
      strike: _state.strike,
      href: _linkTarget,
    ));
  }

  String _currentText() => _current.runs.map((r) => r.text).join();

  void _endParagraphBreak() {
    _endParagraph();
    _current = _Paragraph();
  }

  void _endParagraph() {
    if (_current.runs.isEmpty) return;
    if (_current.inTable) {
      _current = _Paragraph();
      return;
    }
    _paragraphs.add(_current);
    _current = _Paragraph();
  }

  RawOutput _render() {
    final writer = MarkdownWriter();
    final bodySize = _medianFontSize();
    var listBuffer = <String>[];

    void flushList() {
      if (listBuffer.isEmpty) return;
      writer.push(listBuffer.join('\n'));
      listBuffer = <String>[];
    }

    for (final paragraph in _paragraphs) {
      final text = _renderRuns(paragraph.runs).replaceAll(RegExp(r'[ \t]+'), ' ').trim();
      if (text.isEmpty) continue;

      if (paragraph.isListItem && paragraph.outlineLevel == 0) {
        final indent = '  ' * (paragraph.listLevel > 4 ? 4 : paragraph.listLevel);
        listBuffer.add('$indent${options.bulletChar} $text');
        continue;
      }
      flushList();

      if (paragraph.outlineLevel > 0) {
        writer.heading(paragraph.outlineLevel.clamp(1, 6), _stripWrappingEmphasis(text));
        continue;
      }
      if (paragraph.maxFontSize > 0 &&
          bodySize > 0 &&
          paragraph.maxFontSize >= bodySize * 1.25 &&
          text.length < 120) {
        final ratio = paragraph.maxFontSize / bodySize;
        writer.heading(
          ratio >= 1.7 ? 1 : (ratio >= 1.45 ? 2 : 3),
          _stripWrappingEmphasis(text),
        );
        continue;
      }
      writer.push(text);
    }
    flushList();

    if (_tableRows.isNotEmpty) {
      final width = _tableRows.fold<int>(0, (max, row) => row.length > max ? row.length : max);
      final rows = _tableRows.map((row) {
        final copy = List<String>.from(row);
        while (copy.length < width) {
          copy.add('');
        }
        return copy;
      }).toList();
      writer.push(renderTable(rows));
    }

    if (writer.isEmpty) writer.paragraph('_The document contains no text._');

    return RawOutput(markdown: writer.toString(), meta: _meta, warnings: _warnings);
  }

  double _medianFontSize() {
    final sizes = _paragraphs
        .where((p) => p.maxFontSize > 0 && p.runs.any((r) => r.text.trim().isNotEmpty))
        .map((p) => p.maxFontSize)
        .toList()
      ..sort();
    if (sizes.isEmpty) return 0;
    return sizes[sizes.length ~/ 2];
  }
}

String _renderRuns(List<_Run> runs) {
  final buffer = StringBuffer();
  for (final run in runs) {
    final raw = run.text.replaceAll('\n', '  \n');
    if (raw.trim().isEmpty) {
      buffer.write(raw);
      continue;
    }
    final leading = RegExp(r'^\s*').firstMatch(raw)!.group(0)!;
    final trailing = RegExp(r'\s*$').firstMatch(raw)!.group(0)!;
    var core = escapeInline(raw.trim());
    if (run.strike) core = '~~$core~~';
    if (run.bold) core = '**$core**';
    if (run.italic) core = '*$core*';
    if (run.href != null) core = mdLink(core, run.href!);
    buffer..write(leading)..write(core)..write(trailing);
  }
  return buffer.toString();
}

/// Headings carry their weight in the `#` markers; `# **Title**` is noise.
String _stripWrappingEmphasis(String text) {
  final bold = RegExp(r'^\*\*(.+)\*\*$', dotAll: true).firstMatch(text);
  if (bold != null && !bold.group(1)!.contains('**')) return bold.group(1)!;
  final italic = RegExp(r'^\*(.+)\*$', dotAll: true).firstMatch(text);
  if (italic != null && !italic.group(1)!.contains('*')) return italic.group(1)!;
  return text;
}

String _safeChar(int code) {
  if (code < 0 || code > 0x10ffff) return '';
  return String.fromCharCode(code);
}
