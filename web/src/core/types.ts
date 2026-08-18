/** Shared conversion contract. The Dart port mirrors these names exactly. */

export type ImageMode = 'embed' | 'reference' | 'skip';

export interface ConvertOptions {
  /** Emit a YAML front-matter block with title/author/source metadata. */
  frontMatter: boolean;
  /** How embedded pictures are handled. `embed` inlines them as data URIs. */
  imageMode: ImageMode;
  /** Largest single image, in bytes, that will be inlined as a data URI. */
  maxEmbeddedImageBytes: number;
  /** Insert `---` separators between PDF pages / slides / EPUB chapters. */
  pageSeparators: boolean;
  /** Include PowerPoint speaker notes and Word comments. */
  includeNotes: boolean;
  /** Bullet marker for unordered lists. */
  bullet: '-' | '*' | '+';
  /** Promote large PDF text runs to headings using relative font size. */
  detectPdfHeadings: boolean;
  /** Keep hard line breaks inside paragraphs instead of reflowing them. */
  preserveLineBreaks: boolean;
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  frontMatter: true,
  imageMode: 'embed',
  maxEmbeddedImageBytes: 512 * 1024,
  pageSeparators: true,
  includeNotes: true,
  bullet: '-',
  detectPdfHeadings: true,
  preserveLineBreaks: false,
};

export interface SourceFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
  lastModified: number;
}

export interface ConversionResult {
  /** Source file name. */
  name: string;
  /** Suggested output file name, e.g. `report.md`. */
  outputName: string;
  /** Human label of the detected format, e.g. `Word (.docx)`. */
  format: string;
  markdown: string;
  warnings: string[];
  meta: Record<string, string>;
  /** Number of images written into the Markdown. */
  imageCount: number;
  wordCount: number;
  durationMs: number;
}

export interface ConversionFailure {
  name: string;
  error: string;
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

export interface Converter {
  /** Stable id, also used as the Markdown `source_format` front-matter value. */
  id: string;
  label: string;
  extensions: string[];
  /** Sniff the payload; extension matching is handled by the registry. */
  sniff?: (file: SourceFile) => boolean;
  convert: (file: SourceFile, options: ConvertOptions) => Promise<string> | string;
}
