/** Images → Markdown. The picture is embedded so the note stays self-contained. */

import { dataUri, imageMimeFor, image as mdImage, MarkdownWriter } from '../core/md.js';
import { formatBytes } from './docx.js';
import { ConvertOptions, SourceFile } from '../core/types.js';
import { decodeText } from '../core/decode.js';

export interface ImageOutput {
  markdown: string;
  meta: Record<string, string>;
  warnings: string[];
  imageCount: number;
}

export function convertImage(file: SourceFile, options: ConvertOptions): ImageOutput {
  const writer = new MarkdownWriter();
  const warnings: string[] = [];
  const meta: Record<string, string> = { size: formatBytes(file.bytes.length) };
  const alt = file.name.replace(/\.[^.]+$/, '');
  const dimensions = readDimensions(file);
  if (dimensions) meta.dimensions = `${dimensions.width}×${dimensions.height}`;

  let imageCount = 0;

  if (options.imageMode === 'skip') {
    writer.paragraph(`_Image omitted: ${alt}_`);
  } else if (options.imageMode === 'reference' || file.bytes.length > options.maxEmbeddedImageBytes) {
    if (file.bytes.length > options.maxEmbeddedImageBytes && options.imageMode === 'embed') {
      warnings.push(
        `The image is ${formatBytes(file.bytes.length)}, above the inline limit, so it is linked by file name instead.`
      );
    }
    writer.push(mdImage(alt, file.name));
    imageCount++;
  } else {
    writer.push(mdImage(alt, dataUri(file.bytes, imageMimeFor(file.name))));
    imageCount++;
  }

  return { markdown: writer.toString(), meta, warnings, imageCount };
}

interface Dimensions {
  width: number;
  height: number;
}

/** Read intrinsic size from the container header — no decoding required. */
export function readDimensions(file: SourceFile): Dimensions | null {
  const bytes = file.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }

  if (bytes.length > 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = view.getUint16(offset + 2, false);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5, false), width: view.getUint16(offset + 7, false) };
      }
      offset += 2 + length;
    }
    return null;
  }

  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  }

  if (file.name.toLowerCase().endsWith('.svg')) {
    const head = decodeText(bytes.subarray(0, 2048)).text;
    const width = head.match(/\bwidth\s*=\s*"(\d+(?:\.\d+)?)/);
    const height = head.match(/\bheight\s*=\s*"(\d+(?:\.\d+)?)/);
    if (width && height) return { width: Math.round(Number(width[1])), height: Math.round(Number(height[1])) };
  }

  return null;
}
