/**
 * DEFLATE decoder (RFC 1951) with a zlib wrapper helper (RFC 1950).
 *
 * Implemented in-tree so the app never needs a network fetch or a platform
 * feature that older iOS Safari lacks (`DecompressionStream` landed in 16.4).
 * Decoding follows the canonical-Huffman walk used by zlib's `puff` reference:
 * counts-per-length + sorted symbol table, which needs no lookup tables and is
 * fast enough for the document sizes this app handles.
 */

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  count: Int32Array;
  symbol: Int32Array;
}

function buildHuffman(lengths: Uint8Array, n: number): Huffman {
  const count = new Int32Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;

  const offsets = new Int32Array(16);
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1] + count[len - 1];

  const symbol = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (lengths[i] !== 0) symbol[offsets[lengths[i]]++] = i;
  }
  return { count, symbol };
}

class BitReader {
  private pos: number;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(private readonly src: Uint8Array, start: number) {
    this.pos = start;
  }

  get bytePos(): number {
    return this.pos;
  }

  bits(need: number): number {
    let val = this.bitBuf;
    while (this.bitCount < need) {
      if (this.pos >= this.src.length) throw new Error('inflate: out of input');
      val |= this.src[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
    this.bitBuf = val >>> need;
    this.bitCount -= need;
    return val & ((1 << need) - 1);
  }

  alignToByte(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  readStoredHeader(): { len: number; start: number } {
    this.alignToByte();
    if (this.pos + 4 > this.src.length) throw new Error('inflate: truncated stored block');
    const len = this.src[this.pos] | (this.src[this.pos + 1] << 8);
    this.pos += 4;
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.src.length) throw new Error('inflate: stored block overruns input');
    return { len, start };
  }

  decode(huff: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= this.bits(1);
      const count = huff.count[len];
      if (code - first < count) return huff.symbol[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: invalid Huffman code');
  }
}

class Output {
  buf: Uint8Array;
  len = 0;

  constructor(initial: number) {
    this.buf = new Uint8Array(Math.max(initial, 1024));
  }

  private grow(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  pushByte(b: number): void {
    this.grow(1);
    this.buf[this.len++] = b;
  }

  pushBytes(src: Uint8Array, start: number, count: number): void {
    this.grow(count);
    this.buf.set(src.subarray(start, start + count), this.len);
    this.len += count;
  }

  copyBack(distance: number, length: number): void {
    if (distance > this.len) throw new Error('inflate: distance beyond output');
    this.grow(length);
    let from = this.len - distance;
    for (let i = 0; i < length; i++) this.buf[this.len++] = this.buf[from++];
  }

  result(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (!fixedLit || !fixedDist) {
    const litLengths = new Uint8Array(288);
    litLengths.fill(8, 0, 144);
    litLengths.fill(9, 144, 256);
    litLengths.fill(7, 256, 280);
    litLengths.fill(8, 280, 288);
    fixedLit = buildHuffman(litLengths, 288);
    const distLengths = new Uint8Array(30).fill(5);
    fixedDist = buildHuffman(distLengths, 30);
  }
  return { lit: fixedLit, dist: fixedDist };
}

function readDynamicTables(reader: BitReader): { lit: Huffman; dist: Huffman } {
  const hlit = reader.bits(5) + 257;
  const hdist = reader.bits(5) + 1;
  const hclen = reader.bits(4) + 4;

  const clenLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clenLengths[CLEN_ORDER[i]] = reader.bits(3);
  const clenHuff = buildHuffman(clenLengths, 19);

  const lengths = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < hlit + hdist) {
    const sym = reader.decode(clenHuff);
    if (sym < 16) {
      lengths[i++] = sym;
    } else if (sym === 16) {
      if (i === 0) throw new Error('inflate: repeat with no previous length');
      const prev = lengths[i - 1];
      let repeat = 3 + reader.bits(2);
      while (repeat-- > 0 && i < lengths.length) lengths[i++] = prev;
    } else if (sym === 17) {
      let repeat = 3 + reader.bits(3);
      while (repeat-- > 0 && i < lengths.length) lengths[i++] = 0;
    } else {
      let repeat = 11 + reader.bits(7);
      while (repeat-- > 0 && i < lengths.length) lengths[i++] = 0;
    }
  }

  return {
    lit: buildHuffman(lengths.subarray(0, hlit), hlit),
    dist: buildHuffman(lengths.subarray(hlit), hdist),
  };
}

/** Inflate a raw DEFLATE stream (no zlib/gzip wrapper). */
export function inflateRaw(src: Uint8Array, start = 0, expectedSize = 0): Uint8Array {
  const reader = new BitReader(src, start);
  const out = new Output(expectedSize || src.length * 4);

  for (;;) {
    const last = reader.bits(1);
    const type = reader.bits(2);

    if (type === 0) {
      const { len, start: from } = reader.readStoredHeader();
      out.pushBytes(src, from, len);
    } else if (type === 1 || type === 2) {
      const { lit, dist } = type === 1 ? fixedTables() : readDynamicTables(reader);
      for (;;) {
        const sym = reader.decode(lit);
        if (sym < 256) {
          out.pushByte(sym);
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= LENGTH_BASE.length) throw new Error('inflate: invalid length symbol');
          const length = LENGTH_BASE[li] + reader.bits(LENGTH_EXTRA[li]);
          const di = reader.decode(dist);
          if (di >= DIST_BASE.length) throw new Error('inflate: invalid distance symbol');
          const distance = DIST_BASE[di] + reader.bits(DIST_EXTRA[di]);
          out.copyBack(distance, length);
        }
      }
    } else {
      throw new Error('inflate: invalid block type');
    }

    if (last) break;
  }

  return out.result();
}

/** Inflate a zlib-wrapped stream, transparently accepting raw DEFLATE too. */
export function inflate(src: Uint8Array, expectedSize = 0): Uint8Array {
  if (src.length === 0) return new Uint8Array(0);

  // A zlib header is CMF/FLG where CM == 8 and (CMF<<8 | FLG) % 31 == 0.
  const cmf = src[0];
  const flg = src[1];
  const looksZlib = (cmf & 0x0f) === 8 && src.length > 2 && ((cmf << 8) | flg) % 31 === 0;

  if (looksZlib) {
    try {
      return inflateRaw(src, 2, expectedSize);
    } catch (err) {
      // Some producers emit a bogus header; retry as raw before giving up.
      return inflateRaw(src, 0, expectedSize);
    }
  }
  return inflateRaw(src, 0, expectedSize);
}

/** CRC-32 (IEEE) — needed when writing ZIP archives for "download all". */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
