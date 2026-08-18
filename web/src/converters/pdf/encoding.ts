/** Simple-font encodings and glyph-name → Unicode mapping. */

/** cp1252 additions in 0x80-0x9F; codes absent here are undefined in WinAnsi. */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

/** MacRomanEncoding 0x80-0xFF. 0xF0 is Apple's private-use logo glyph. */
const MAC_ROMAN_HIGH = [
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü',
  '†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø',
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ',
  '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uF8FFÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ',
].join('');

/** Adobe StandardEncoding, expressed as code → glyph name. */
const STANDARD_NAMES: Record<number, string> = {
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

const ASCII_NAMES: Record<number, string> = {
  32: 'space', 33: 'exclam', 34: 'quotedbl', 35: 'numbersign', 36: 'dollar', 37: 'percent',
  38: 'ampersand', 39: 'quotesingle', 40: 'parenleft', 41: 'parenright', 42: 'asterisk', 43: 'plus',
  44: 'comma', 45: 'hyphen', 46: 'period', 47: 'slash', 48: 'zero', 49: 'one', 50: 'two',
  51: 'three', 52: 'four', 53: 'five', 54: 'six', 55: 'seven', 56: 'eight', 57: 'nine', 58: 'colon',
  59: 'semicolon', 60: 'less', 61: 'equal', 62: 'greater', 63: 'question', 64: 'at',
  91: 'bracketleft', 92: 'backslash', 93: 'bracketright', 94: 'asciicircum', 95: 'underscore',
  96: 'grave', 123: 'braceleft', 124: 'bar', 125: 'braceright', 126: 'asciitilde',
};

const EXTRA_GLYPHS: Record<string, string> = {
  space: ' ', nbspace: ' ', uni00A0: ' ', fi: 'ﬁ', fl: 'ﬂ', ffi: 'ﬃ', ffl: 'ﬄ', ff: 'ﬀ',
  quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚',
  quotedblbase: '„', endash: '–', emdash: '—', bullet: '•', ellipsis: '…', dagger: '†',
  daggerdbl: '‡', perthousand: '‰', guilsinglleft: '‹', guilsinglright: '›', guillemotleft: '«',
  guillemotright: '»', fraction: '⁄', florin: 'ƒ', trademark: '™', minus: '−', periodcentered: '·',
  Euro: '€', euro: '€', copyright: '©', registered: '®', degree: '°', plusminus: '±',
  multiply: '×', divide: '÷', onehalf: '½', onequarter: '¼', threequarters: '¾', section: '§',
  paragraph: '¶', currency: '¤', yen: '¥', sterling: '£', cent: '¢', exclamdown: '¡',
  questiondown: '¿', ordfeminine: 'ª', ordmasculine: 'º', logicalnot: '¬', macron: '¯',
  brokenbar: '¦', dotlessi: 'ı', germandbls: 'ß', AE: 'Æ', ae: 'æ', OE: 'Œ', oe: 'œ',
  Oslash: 'Ø', oslash: 'ø', Lslash: 'Ł', lslash: 'ł', Scaron: 'Š', scaron: 'š', Zcaron: 'Ž',
  zcaron: 'ž', Ydieresis: 'Ÿ', Thorn: 'Þ', thorn: 'þ', Eth: 'Ð', eth: 'ð', mu: 'µ',
  arrowright: '→', arrowleft: '←', arrowup: '↑', arrowdown: '↓', lessequal: '≤',
  greaterequal: '≥', notequal: '≠', approxequal: '≈', infinity: '∞', integral: '∫',
  radical: '√', partialdiff: '∂', summation: '∑', product: '∏', pi: 'π', Delta: '∆',
  Omega: 'Ω', lozenge: '◊', circumflex: 'ˆ', tilde: '˜', breve: '˘', dotaccent: '˙',
  ring: '˚', ogonek: '˛', caron: 'ˇ', hungarumlaut: '˝', cedilla: '¸', dieresis: '¨',
  acute: '´', grave: '`',
};

const ACCENTED: [string, string][] = [
  ['A', 'ÀÁÂÃÄÅ'], ['E', 'ÈÉÊË'], ['I', 'ÌÍÎÏ'], ['O', 'ÒÓÔÕÖ'], ['U', 'ÙÚÛÜ'],
  ['a', 'àáâãäå'], ['e', 'èéêë'], ['i', 'ìíîï'], ['o', 'òóôõö'], ['u', 'ùúûü'],
];
const ACCENT_SUFFIXES = ['grave', 'acute', 'circumflex', 'tilde', 'dieresis', 'ring'];

const GLYPH_TO_UNICODE: Record<string, string> = (() => {
  const map: Record<string, string> = { ...EXTRA_GLYPHS };
  for (const [code, name] of Object.entries(ASCII_NAMES)) map[name] = String.fromCharCode(Number(code));
  for (let c = 65; c <= 90; c++) map[String.fromCharCode(c)] = String.fromCharCode(c);
  for (let c = 97; c <= 122; c++) map[String.fromCharCode(c)] = String.fromCharCode(c);
  for (const [base, chars] of ACCENTED) {
    [...chars].forEach((ch, index) => {
      const suffix = ACCENT_SUFFIXES[index];
      if (suffix) map[`${base}${suffix}`] = ch;
    });
  }
  map.Ccedilla = 'Ç';
  map.ccedilla = 'ç';
  map.Ntilde = 'Ñ';
  map.ntilde = 'ñ';
  map.Yacute = 'Ý';
  map.yacute = 'ý';
  map.ydieresis = 'ÿ';
  return map;
})();

export function glyphNameToUnicode(name: string): string | null {
  const direct = GLYPH_TO_UNICODE[name];
  if (direct) return direct;

  const uni = name.match(/^uni([0-9A-Fa-f]{4,6})$/);
  if (uni) return safeFromCode(parseInt(uni[1], 16));

  const u = name.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (u) return safeFromCode(parseInt(u[1], 16));

  // Names like `g123`, `cid42`, `index7` carry no Unicode meaning.
  if (/^(g|cid|index|glyph)\d+$/i.test(name)) return null;

  // `A.sc`, `one.oldstyle`: fall back to the part before the first dot.
  const dot = name.indexOf('.');
  if (dot > 0) return glyphNameToUnicode(name.slice(0, dot));

  if (name.length === 1) return name;
  return null;
}

function safeFromCode(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

export type EncodingName = 'StandardEncoding' | 'WinAnsiEncoding' | 'MacRomanEncoding' | 'MacExpertEncoding';

export function baseEncodingTable(name: EncodingName | string | null): (string | null)[] {
  const table = new Array<string | null>(256).fill(null);

  for (let code = 32; code <= 126; code++) table[code] = String.fromCharCode(code);

  switch (name) {
    case 'WinAnsiEncoding':
      for (let code = 128; code <= 159; code++) table[code] = WIN_ANSI_HIGH[code] ?? null;
      for (let code = 160; code <= 255; code++) table[code] = String.fromCharCode(code);
      break;
    case 'MacRomanEncoding':
      for (let code = 128; code <= 255; code++) table[code] = MAC_ROMAN_HIGH[code - 128] ?? null;
      break;
    case 'StandardEncoding':
    default:
      for (const [code, glyph] of Object.entries(STANDARD_NAMES)) {
        table[Number(code)] = glyphNameToUnicode(glyph);
      }
      break;
  }

  return table;
}
