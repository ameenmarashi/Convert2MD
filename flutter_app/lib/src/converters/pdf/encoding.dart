/// Simple-font encodings and glyph-name → Unicode mapping.
/// Mirrors `web/src/converters/pdf/encoding.ts`.
library;

/// cp1252 additions in 0x80-0x9F; codes absent here are undefined in WinAnsi.
const Map<int, String> _winAnsiHigh = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

/// MacRomanEncoding 0x80-0xFF. 0xF0 is Apple's private-use logo glyph.
const String _macRomanHigh = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü'
    '†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø'
    '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ'
    '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uF8FFÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/// Adobe StandardEncoding, expressed as code → glyph name.
const Map<int, String> _standardNames = {
  39: 'quoteright', 96: 'quoteleft',
  161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen', 166: 'florin',
  167: 'section', 168: 'currency', 169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft',
  172: 'guilsinglleft', 173: 'guilsinglright', 174: 'fi', 175: 'fl', 177: 'endash', 178: 'dagger',
  179: 'daggerdbl', 180: 'periodcentered', 182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase',
  185: 'quotedblbase', 186: 'quotedblright', 187: 'guillemotright', 188: 'ellipsis',
  189: 'perthousand', 191: 'questiondown', 193: 'grave', 194: 'acute', 195: 'circumflex',
  196: 'tilde', 197: 'macron', 198: 'breve', 199: 'dotaccent', 200: 'dieresis', 202: 'ring',
  203: 'cedilla', 205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash', 225: 'AE',
  227: 'ordfeminine', 232: 'Lslash', 233: 'Oslash', 234: 'OE', 235: 'ordmasculine', 241: 'ae',
  245: 'dotlessi', 248: 'lslash', 249: 'oslash', 250: 'oe', 251: 'germandbls',
};

const Map<int, String> _asciiNames = {
  32: 'space', 33: 'exclam', 34: 'quotedbl', 35: 'numbersign', 36: 'dollar', 37: 'percent',
  38: 'ampersand', 39: 'quotesingle', 40: 'parenleft', 41: 'parenright', 42: 'asterisk', 43: 'plus',
  44: 'comma', 45: 'hyphen', 46: 'period', 47: 'slash', 48: 'zero', 49: 'one', 50: 'two',
  51: 'three', 52: 'four', 53: 'five', 54: 'six', 55: 'seven', 56: 'eight', 57: 'nine', 58: 'colon',
  59: 'semicolon', 60: 'less', 61: 'equal', 62: 'greater', 63: 'question', 64: 'at',
  91: 'bracketleft', 92: 'backslash', 93: 'bracketright', 94: 'asciicircum', 95: 'underscore',
  96: 'grave', 123: 'braceleft', 124: 'bar', 125: 'braceright', 126: 'asciitilde',
};

const Map<String, String> _extraGlyphs = {
  'space': ' ', 'nbspace': ' ', 'uni00A0': ' ', 'fi': 'ﬁ', 'fl': 'ﬂ', 'ffi': 'ﬃ', 'ffl': 'ﬄ',
  'ff': 'ﬀ', 'quoteright': '’', 'quoteleft': '‘', 'quotedblleft': '“', 'quotedblright': '”',
  'quotesinglbase': '‚', 'quotedblbase': '„', 'endash': '–', 'emdash': '—', 'bullet': '•',
  'ellipsis': '…', 'dagger': '†', 'daggerdbl': '‡', 'perthousand': '‰', 'guilsinglleft': '‹',
  'guilsinglright': '›', 'guillemotleft': '«', 'guillemotright': '»', 'fraction': '⁄',
  'florin': 'ƒ', 'trademark': '™', 'minus': '−', 'periodcentered': '·', 'Euro': '€', 'euro': '€',
  'copyright': '©', 'registered': '®', 'degree': '°', 'plusminus': '±', 'multiply': '×',
  'divide': '÷', 'onehalf': '½', 'onequarter': '¼', 'threequarters': '¾', 'section': '§',
  'paragraph': '¶', 'currency': '¤', 'yen': '¥', 'sterling': '£', 'cent': '¢',
  'exclamdown': '¡', 'questiondown': '¿', 'ordfeminine': 'ª', 'ordmasculine': 'º',
  'logicalnot': '¬', 'macron': '¯', 'brokenbar': '¦', 'dotlessi': 'ı', 'germandbls': 'ß',
  'AE': 'Æ', 'ae': 'æ', 'OE': 'Œ', 'oe': 'œ', 'Oslash': 'Ø', 'oslash': 'ø', 'Lslash': 'Ł',
  'lslash': 'ł', 'Scaron': 'Š', 'scaron': 'š', 'Zcaron': 'Ž', 'zcaron': 'ž', 'Ydieresis': 'Ÿ',
  'Thorn': 'Þ', 'thorn': 'þ', 'Eth': 'Ð', 'eth': 'ð', 'mu': 'µ', 'arrowright': '→',
  'arrowleft': '←', 'arrowup': '↑', 'arrowdown': '↓', 'lessequal': '≤', 'greaterequal': '≥',
  'notequal': '≠', 'approxequal': '≈', 'infinity': '∞', 'integral': '∫', 'radical': '√',
  'partialdiff': '∂', 'summation': '∑', 'product': '∏', 'pi': 'π', 'Delta': '∆', 'Omega': 'Ω',
  'lozenge': '◊', 'circumflex': 'ˆ', 'tilde': '˜', 'breve': '˘', 'dotaccent': '˙', 'ring': '˚',
  'ogonek': '˛', 'caron': 'ˇ', 'hungarumlaut': '˝', 'cedilla': '¸', 'dieresis': '¨',
  'acute': '´', 'grave': '`',
};

const List<List<String>> _accented = [
  ['A', 'ÀÁÂÃÄÅ'], ['E', 'ÈÉÊË'], ['I', 'ÌÍÎÏ'], ['O', 'ÒÓÔÕÖ'], ['U', 'ÙÚÛÜ'],
  ['a', 'àáâãäå'], ['e', 'èéêë'], ['i', 'ìíîï'], ['o', 'òóôõö'], ['u', 'ùúûü'],
];

const List<String> _accentSuffixes = ['grave', 'acute', 'circumflex', 'tilde', 'dieresis', 'ring'];

final Map<String, String> _glyphToUnicode = () {
  final map = <String, String>{..._extraGlyphs};
  _asciiNames.forEach((code, name) => map[name] = String.fromCharCode(code));
  for (var c = 65; c <= 90; c++) {
    map[String.fromCharCode(c)] = String.fromCharCode(c);
  }
  for (var c = 97; c <= 122; c++) {
    map[String.fromCharCode(c)] = String.fromCharCode(c);
  }
  for (final entry in _accented) {
    final base = entry[0];
    final chars = entry[1].split('');
    for (var i = 0; i < chars.length && i < _accentSuffixes.length; i++) {
      map['$base${_accentSuffixes[i]}'] = chars[i];
    }
  }
  map['Ccedilla'] = 'Ç';
  map['ccedilla'] = 'ç';
  map['Ntilde'] = 'Ñ';
  map['ntilde'] = 'ñ';
  map['Yacute'] = 'Ý';
  map['yacute'] = 'ý';
  map['ydieresis'] = 'ÿ';
  return map;
}();

String? glyphNameToUnicode(String name) {
  final direct = _glyphToUnicode[name];
  if (direct != null) return direct;

  final uni = RegExp(r'^uni([0-9A-Fa-f]{4,6})$').firstMatch(name);
  if (uni != null) return _safeFromCode(int.parse(uni.group(1)!, radix: 16));

  final u = RegExp(r'^u([0-9A-Fa-f]{4,6})$').firstMatch(name);
  if (u != null) return _safeFromCode(int.parse(u.group(1)!, radix: 16));

  // Names like `g123`, `cid42`, `index7` carry no Unicode meaning.
  if (RegExp(r'^(g|cid|index|glyph)\d+$', caseSensitive: false).hasMatch(name)) return null;

  // `A.sc`, `one.oldstyle`: fall back to the part before the first dot.
  final dot = name.indexOf('.');
  if (dot > 0) return glyphNameToUnicode(name.substring(0, dot));

  if (name.length == 1) return name;
  return null;
}

String? _safeFromCode(int code) {
  if (code < 0 || code > 0x10ffff) return null;
  return String.fromCharCode(code);
}

List<String?> baseEncodingTable(String? name) {
  final table = List<String?>.filled(256, null);

  for (var code = 32; code <= 126; code++) {
    table[code] = String.fromCharCode(code);
  }

  switch (name) {
    case 'WinAnsiEncoding':
      for (var code = 128; code <= 159; code++) {
        table[code] = _winAnsiHigh[code];
      }
      for (var code = 160; code <= 255; code++) {
        table[code] = String.fromCharCode(code);
      }
    case 'MacRomanEncoding':
      for (var code = 128; code <= 255; code++) {
        final index = code - 128;
        table[code] = index < _macRomanHigh.length ? _macRomanHigh[index] : null;
      }
    default:
      _standardNames.forEach((code, glyph) => table[code] = glyphNameToUnicode(glyph));
  }
  return table;
}
