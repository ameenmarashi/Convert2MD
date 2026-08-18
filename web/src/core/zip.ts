/**
 * Minimal ZIP reader/writer.
 *
 * The reader backs every OOXML (docx/xlsx/pptx), OpenDocument and EPUB
 * converter; the writer backs the "download all as .zip" action. Entries are
 * decompressed lazily and memoised, so opening a 40 MB deck to read one slide
 * does not inflate every media file in it.
 */

import { crc32, inflateRaw } from './inflate.js';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

const utf8 = new TextDecoder('utf-8');

export class ZipArchive {
  private readonly entries = new Map<string, CentralEntry>();
  private readonly cache = new Map<string, Uint8Array>();

  private constructor(private readonly bytes: Uint8Array, private readonly view: DataView) {}

  static isZip(bytes: Uint8Array): boolean {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  }

  static open(bytes: Uint8Array): ZipArchive {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const zip = new ZipArchive(bytes, view);
    zip.readCentralDirectory();
    return zip;
  }

  get names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Entry names under a folder prefix, natural-sorted (slide2 before slide10). */
  namesUnder(prefix: string, extension?: string): string[] {
    const matches = this.names.filter(
      (n) => n.startsWith(prefix) && (!extension || n.toLowerCase().endsWith(extension))
    );
    return matches.sort(naturalCompare);
  }

  read(name: string): Uint8Array | null {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const entry = this.entries.get(name);
    if (!entry) return null;

    const data = this.extract(entry);
    this.cache.set(name, data);
    return data;
  }

  readText(name: string): string | null {
    const data = this.read(name);
    return data ? utf8.decode(stripBom(data)) : null;
  }

  private extract(entry: CentralEntry): Uint8Array {
    const { localOffset } = entry;
    if (this.view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`zip: bad local header for ${entry.name}`);
    }
    const nameLen = this.view.getUint16(localOffset + 26, true);
    const extraLen = this.view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + nameLen + extraLen;

    if (entry.method === 0) {
      return this.bytes.subarray(dataStart, dataStart + entry.uncompressedSize);
    }
    if (entry.method === 8) {
      return inflateRaw(this.bytes, dataStart, entry.uncompressedSize);
    }
    throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
  }

  private findEocd(): number {
    const max = Math.min(this.bytes.length, 0xffff + 22);
    for (let i = 22; i <= max; i++) {
      const at = this.bytes.length - i;
      if (at < 0) break;
      if (this.view.getUint32(at, true) === EOCD_SIG) return at;
    }
    throw new Error('zip: end of central directory not found');
  }

  private readCentralDirectory(): void {
    const eocd = this.findEocd();
    let count = this.view.getUint16(eocd + 10, true);
    let offset = this.view.getUint32(eocd + 16, true);

    if (offset === 0xffffffff || count === 0xffff) {
      const locator = eocd - 20;
      if (locator >= 0 && this.view.getUint32(locator, true) === EOCD64_LOCATOR_SIG) {
        const eocd64 = Number(this.view.getBigUint64(locator + 8, true));
        if (this.view.getUint32(eocd64, true) === EOCD64_SIG) {
          count = Number(this.view.getBigUint64(eocd64 + 32, true));
          offset = Number(this.view.getBigUint64(eocd64 + 48, true));
        }
      }
    }

    let pos = offset;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > this.bytes.length) break;
      if (this.view.getUint32(pos, true) !== CENTRAL_SIG) break;

      const method = this.view.getUint16(pos + 10, true);
      let compressedSize = this.view.getUint32(pos + 20, true);
      let uncompressedSize = this.view.getUint32(pos + 24, true);
      const nameLen = this.view.getUint16(pos + 28, true);
      const extraLen = this.view.getUint16(pos + 30, true);
      const commentLen = this.view.getUint16(pos + 32, true);
      let localOffset = this.view.getUint32(pos + 42, true);

      const name = utf8.decode(this.bytes.subarray(pos + 46, pos + 46 + nameLen));

      if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        const extraStart = pos + 46 + nameLen;
        let ex = extraStart;
        const extraEnd = extraStart + extraLen;
        while (ex + 4 <= extraEnd) {
          const headerId = this.view.getUint16(ex, true);
          const size = this.view.getUint16(ex + 2, true);
          if (headerId === 0x0001) {
            let field = ex + 4;
            if (uncompressedSize === 0xffffffff) {
              uncompressedSize = Number(this.view.getBigUint64(field, true));
              field += 8;
            }
            if (compressedSize === 0xffffffff) {
              compressedSize = Number(this.view.getBigUint64(field, true));
              field += 8;
            }
            if (localOffset === 0xffffffff) localOffset = Number(this.view.getBigUint64(field, true));
            break;
          }
          ex += 4 + size;
        }
      }

      if (!name.endsWith('/')) {
        this.entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }

    if (this.entries.size === 0) throw new Error('zip: archive contains no readable entries');
  }
}

function stripBom(data: Uint8Array): Uint8Array {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return data.subarray(3);
  }
  return data;
}

export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const ax = a.match(re) ?? [];
  const bx = b.match(re) ?? [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = Number(ax[i]);
    const bn = Number(bx[i]);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

export interface ZipFileInput {
  name: string;
  data: Uint8Array;
}

/** Build a STORE-only ZIP. Markdown compresses well but bundle size here is tiny. */
export function writeZip(files: ZipFileInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const { dosTime, dosDate } = dosTimestamp(new Date());

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.data.length, true);
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, file.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.data.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + file.data.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function dosTimestamp(date: Date): { dosTime: number; dosDate: number } {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}
