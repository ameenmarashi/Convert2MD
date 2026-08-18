import 'package:xml/xml.dart';

import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/package_archive.dart';
import '../core/xml_query.dart';

/// Excel (.xlsx / .xlsm) → Markdown. Mirrors `web/src/converters/xlsx.ts`.
const Set<int> _dateFormatIds = {14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47};

RawOutput convertXlsx(SourceFile file, ConvertOptions options) {
  final archive = DocumentArchive.open(file.bytes);
  final workbookXml = archive.readText('xl/workbook.xml');
  if (workbookXml == null) {
    throw const ConversionException('Not a workbook: xl/workbook.xml is missing.');
  }

  final warnings = <String>[];
  final sharedStrings = _readSharedStrings(archive);
  final dateStyles = _readDateStyles(archive);
  final rels = readRelationships(archive, 'xl/_rels/workbook.xml.rels');
  final workbook = parseRoot(workbookXml);
  if (workbook == null) throw const ConversionException('The workbook could not be parsed.');

  final sheets = <_SheetRef>[];
  for (final sheet in descendantsOf(workbook, 'sheet')) {
    final name = attrOf(sheet, 'name') ?? 'Sheet${sheets.length + 1}';
    final relId = attrOf(sheet, 'r:id');
    final rel = relId == null ? null : rels[relId];
    final path = rel == null
        ? 'xl/worksheets/sheet${sheets.length + 1}.xml'
        : normalizePart('xl', rel.target);
    sheets.add(_SheetRef(name, path, (attrOf(sheet, 'state') ?? '').isNotEmpty));
  }

  final writer = MarkdownWriter();
  final multiple = sheets.length > 1;

  for (final sheet in sheets) {
    final root = parseRoot(archive.readText(sheet.path));
    if (root == null) {
      warnings.add('Worksheet part missing: ${sheet.path}');
      continue;
    }
    final rows = _readSheet(root, sharedStrings, dateStyles, archive, sheet.path);
    if (multiple) writer.heading(2, sheet.name + (sheet.hidden ? ' (hidden)' : ''));
    if (rows.isEmpty) {
      writer.paragraph('_Empty sheet._');
      continue;
    }
    writer.push(renderTable(rows));
  }

  if (writer.isEmpty) writer.paragraph('_The workbook contains no cell data._');

  return RawOutput(markdown: writer.toString(), meta: _readMeta(archive), warnings: warnings);
}

class _SheetRef {
  const _SheetRef(this.name, this.path, this.hidden);

  final String name;
  final String path;
  final bool hidden;
}

Map<String, String> _readMeta(DocumentArchive archive) {
  final meta = <String, String>{};
  final root = parseRoot(archive.readText('docProps/core.xml'));
  if (root == null) return meta;
  for (final entry in const [
    ['title', 'dc:title'],
    ['author', 'dc:creator'],
    ['modified', 'dcterms:modified'],
  ]) {
    final element = firstDescendantOf(root, entry[1]);
    final value = element == null ? '' : collapseWhitespace(element.innerText).trim();
    if (value.isNotEmpty) meta[entry[0]] = value;
  }
  return meta;
}

List<String> _readSharedStrings(DocumentArchive archive) {
  final root = parseRoot(archive.readText('xl/sharedStrings.xml'));
  if (root == null) return const [];
  return descendantsOf(root, 'si').map(_siText).toList();
}

String _siText(XmlElement si) {
  final direct = childOf(si, 't');
  if (direct != null) return direct.innerText;
  return childrenOf(si, 'r').map((run) => childOf(run, 't')?.innerText ?? '').join();
}

Set<int> _readDateStyles(DocumentArchive archive) {
  final styles = <int>{};
  final root = parseRoot(archive.readText('xl/styles.xml'));
  if (root == null) return styles;

  final customDateFormats = <int>{};
  for (final numFmt in descendantsOf(root, 'numFmt')) {
    final id = int.tryParse(attrOf(numFmt, 'numFmtId') ?? '');
    final code = (attrOf(numFmt, 'formatCode') ?? '').toLowerCase();
    final stripped = code.replaceAll(RegExp(r'\[[^\]]*\]'), '').replaceAll(RegExp('"[^"]*"'), '');
    if (id != null && RegExp('[ymdhs]').hasMatch(stripped)) customDateFormats.add(id);
  }

  final cellXfs = firstDescendantOf(root, 'cellXfs');
  if (cellXfs == null) return styles;
  final xfs = childrenOf(cellXfs, 'xf');
  for (var index = 0; index < xfs.length; index++) {
    final id = int.tryParse(attrOf(xfs[index], 'numFmtId') ?? '0') ?? 0;
    if (_dateFormatIds.contains(id) || customDateFormats.contains(id)) styles.add(index);
  }
  return styles;
}

List<List<String>> _readSheet(
  XmlElement sheetRoot,
  List<String> sharedStrings,
  Set<int> dateStyles,
  DocumentArchive archive,
  String sheetPath,
) {
  final hyperlinks = _readSheetHyperlinks(sheetRoot, archive, sheetPath);
  final grid = <List<String>>[];
  var maxColumn = 0;

  for (final row in descendantsOf(sheetRoot, 'row')) {
    final rowNumber = int.tryParse(attrOf(row, 'r') ?? '');
    final rowIndex = rowNumber != null && rowNumber > 0 ? rowNumber - 1 : grid.length;
    final cells = <String>[];

    var cursor = 0;
    for (final cell in childrenOf(row, 'c')) {
      final ref = attrOf(cell, 'r') ?? '';
      final column = ref.isEmpty ? cursor : columnIndex(ref);
      while (cells.length < column) {
        cells.add('');
      }
      cursor = column + 1;

      final value = _cellValue(cell, sharedStrings, dateStyles);
      final href = hyperlinks[ref.toUpperCase()];
      cells.add(href != null && value.isNotEmpty ? mdLink(value, href) : value);
    }

    while (grid.length < rowIndex) {
      grid.add(<String>[]);
    }
    if (grid.length == rowIndex) {
      grid.add(cells);
    } else {
      grid[rowIndex] = cells;
    }
    if (cells.length > maxColumn) maxColumn = cells.length;
  }

  final trimmed = grid.map((row) {
    final copy = List<String>.from(row);
    while (copy.length < maxColumn) {
      copy.add('');
    }
    return copy;
  }).toList();

  while (trimmed.isNotEmpty && trimmed.last.every((c) => c.trim().isEmpty)) {
    trimmed.removeLast();
  }
  while (trimmed.isNotEmpty && trimmed.first.every((c) => c.trim().isEmpty)) {
    trimmed.removeAt(0);
  }

  var width = maxColumn;
  while (width > 0 && trimmed.every((row) => row[width - 1].trim().isEmpty)) {
    width--;
  }
  return trimmed.map((row) => row.sublist(0, width)).toList();
}

Map<String, String> _readSheetHyperlinks(
  XmlElement sheetRoot,
  DocumentArchive archive,
  String sheetPath,
) {
  final map = <String, String>{};
  final links = descendantsOf(sheetRoot, 'hyperlink');
  if (links.isEmpty) return map;

  final rels = readRelationships(archive, relsPathFor(sheetPath));
  for (final link in links) {
    final ref = (attrOf(link, 'ref') ?? '').split(':').first.toUpperCase();
    final relId = attrOf(link, 'r:id');
    final location = attrOf(link, 'location');
    if (relId != null) {
      final rel = rels[relId];
      if (rel != null) map[ref] = rel.target;
    } else if (location != null) {
      map[ref] = '#$location';
    }
  }
  return map;
}

String _cellValue(XmlElement cell, List<String> sharedStrings, Set<int> dateStyles) {
  final type = attrOf(cell, 't') ?? 'n';

  if (type == 'inlineStr') {
    final is_ = childOf(cell, 'is');
    return is_ == null ? '' : collapseWhitespace(_siText(is_)).trim();
  }

  final v = childOf(cell, 'v');
  final raw = v == null ? '' : v.innerText.trim();
  if (raw.isEmpty) {
    final t = childOf(cell, 't');
    return t == null ? '' : collapseWhitespace(t.innerText).trim();
  }

  switch (type) {
    case 's':
      final index = int.tryParse(raw);
      if (index == null || index < 0 || index >= sharedStrings.length) return '';
      return collapseWhitespace(sharedStrings[index]).trim();
    case 'b':
      return raw == '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return raw;
    case 'str':
      return collapseWhitespace(raw).trim();
    default:
      final styleIndex = int.tryParse(attrOf(cell, 's') ?? '');
      final number = double.tryParse(raw);
      if (number != null && styleIndex != null && dateStyles.contains(styleIndex)) {
        return excelSerialToIso(number);
      }
      return raw;
  }
}

/// Excel day 0 is 1899-12-30 (the 1900 leap-year bug is baked into the epoch).
String excelSerialToIso(double serial) {
  final epoch = DateTime.utc(1899, 12, 30);
  final date = epoch.add(Duration(milliseconds: (serial * 86400000).round()));
  final iso = date.toIso8601String();
  final hasTime = (serial - serial.floorToDouble()).abs() > 1e-9;
  return hasTime ? iso.substring(0, 19).replaceFirst('T', ' ') : iso.substring(0, 10);
}

int columnIndex(String ref) {
  var index = 0;
  for (final rune in ref.toUpperCase().runes) {
    if (rune < 65 || rune > 90) break;
    index = index * 26 + (rune - 64);
  }
  return index - 1 < 0 ? 0 : index - 1;
}
