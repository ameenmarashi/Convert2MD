/**
 * OpenDocument (.odt / .ods / .odp / .fodt) → Markdown.
 *
 * One reader covers text documents, spreadsheets and presentations: they share
 * `content.xml`, the automatic-style table used for inline formatting, and the
 * same list/table markup.
 */

import { ZipArchive } from '../core/zip.js';
import { attr, child, children, descendants, firstDescendant, parseXml, textOf, XElement, XNode } from '../core/xml.js';
import {
  collapseWhitespace,
  dataUri,
  escapeInline,
  imageMimeFor,
  image as mdImage,
  link as mdLink,
  MarkdownWriter,
  renderTable,
} from '../core/md.js';
import { ConversionError, ConvertOptions, SourceFile } from '../core/types.js';
import { basename, formatBytes } from './docx.js';

export interface OdfOutput {
  markdown: string;
  meta: Record<string, string>;
  warnings: string[];
  imageCount: number;
  kind: 'text' | 'spreadsheet' | 'presentation';
}

interface TextStyle {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  mono: boolean;
}

interface ListStyle {
  ordered: Map<number, boolean>;
}

export function convertOdf(file: SourceFile, options: ConvertOptions): OdfOutput {
  const zip = ZipArchive.open(file.bytes);
  const contentXml = zip.readText('content.xml');
  if (!contentXml) throw new ConversionError('Not an OpenDocument file: content.xml is missing.');

  const reader = new OdfReader(zip, options);
  const content = parseXml(contentXml);
  reader.loadStyles(content);
  const stylesXml = zip.readText('styles.xml');
  if (stylesXml) reader.loadStyles(parseXml(stylesXml));

  const body = firstDescendant(content, 'office:body');
  if (!body) throw new ConversionError('OpenDocument file has no body.');

  const writer = new MarkdownWriter();
  let kind: OdfOutput['kind'] = 'text';

  const text = child(body, 'office:text');
  const spreadsheet = child(body, 'office:spreadsheet');
  const presentation = child(body, 'office:presentation');

  if (spreadsheet) {
    kind = 'spreadsheet';
    reader.renderSpreadsheet(spreadsheet, writer);
  } else if (presentation) {
    kind = 'presentation';
    reader.renderPresentation(presentation, writer);
  } else if (text) {
    reader.renderTextBody(text, writer);
  } else {
    reader.renderTextBody(body, writer);
  }

  return {
    markdown: writer.toString(),
    meta: readMeta(zip),
    warnings: reader.warnings,
    imageCount: reader.imageCount,
    kind,
  };
}

function readMeta(zip: ZipArchive): Record<string, string> {
  const meta: Record<string, string> = {};
  const xml = zip.readText('meta.xml');
  if (!xml) return meta;
  const root = parseXml(xml);
  const pick = (tag: string): string => {
    const el = firstDescendant(root, tag);
    return el ? collapseWhitespace(textOf(el)).trim() : '';
  };
  const title = pick('dc:title');
  const author = pick('dc:creator') || pick('meta:initial-creator');
  const created = pick('meta:creation-date');
  const modified = pick('dc:date');
  if (title) meta.title = title;
  if (author) meta.author = author;
  if (created) meta.created = created;
  if (modified) meta.modified = modified;
  return meta;
}

class OdfReader {
  readonly warnings: string[] = [];
  imageCount = 0;

  private readonly textStyles = new Map<string, TextStyle>();
  private readonly listStyles = new Map<string, ListStyle>();
  private readonly styleParents = new Map<string, string>();

  constructor(private readonly zip: ZipArchive, private readonly options: ConvertOptions) {}

  loadStyles(root: XElement): void {
    for (const style of descendants(root, 'style:style')) {
      const name = attr(style, 'style:name');
      if (!name) continue;
      const parent = attr(style, 'style:parent-style-name');
      if (parent) this.styleParents.set(name, parent);

      const props = child(style, 'style:text-properties');
      if (!props) continue;
      const fontName = (attr(props, 'style:font-name') ?? '').toLowerCase();
      this.textStyles.set(name, {
        bold: (attr(props, 'fo:font-weight') ?? '') === 'bold',
        italic: (attr(props, 'fo:font-style') ?? '') === 'italic',
        strike: (attr(props, 'style:text-line-through-style') ?? 'none') !== 'none',
        mono: fontName.includes('mono') || fontName.includes('courier'),
      });
    }

    for (const listStyle of descendants(root, 'text:list-style')) {
      const name = attr(listStyle, 'style:name');
      if (!name) continue;
      const ordered = new Map<number, boolean>();
      for (const level of listStyle.children) {
        if (level.type !== 'element') continue;
        const lvl = Number(attr(level, 'text:level') ?? '1') || 1;
        if (level.local === 'list-level-style-number') ordered.set(lvl - 1, true);
        else if (level.local === 'list-level-style-bullet' || level.local === 'list-level-style-image') {
          ordered.set(lvl - 1, false);
        }
      }
      this.listStyles.set(name, { ordered });
    }
  }

  private styleFor(name: string | null): TextStyle {
    const empty: TextStyle = { bold: false, italic: false, strike: false, mono: false };
    if (!name) return empty;
    const own = this.textStyles.get(name);
    const parentName = this.styleParents.get(name);
    const parent = parentName ? this.styleFor(parentName) : empty;
    if (!own) return parent;
    return {
      bold: own.bold || parent.bold,
      italic: own.italic || parent.italic,
      strike: own.strike || parent.strike,
      mono: own.mono || parent.mono,
    };
  }

  /* --------------------------------------------------------------- text */

  renderTextBody(container: XElement, writer: MarkdownWriter): void {
    for (const node of container.children) {
      if (node.type !== 'element') continue;
      this.renderBlock(node, writer, 0);
    }
  }

  private renderBlock(el: XElement, writer: MarkdownWriter, depth: number): void {
    switch (el.local) {
      case 'h': {
        const level = Number(attr(el, 'text:outline-level') ?? '1') || 1;
        writer.heading(Math.min(6, level), this.renderInline(el));
        break;
      }
      case 'p': {
        const text = this.renderInline(el).trim();
        if (text) writer.push(text);
        break;
      }
      case 'list':
        writer.push(this.renderList(el, depth));
        break;
      case 'table':
        writer.push(this.renderTableElement(el));
        break;
      case 'section':
      case 'text-box':
      case 'frame':
      case 'forms':
        for (const kid of el.children) {
          if (kid.type === 'element') this.renderBlock(kid, writer, depth);
        }
        break;
      case 'soft-page-break':
        if (this.options.pageSeparators) writer.rule();
        break;
      default:
        for (const kid of el.children) {
          if (kid.type === 'element') this.renderBlock(kid, writer, depth);
        }
        break;
    }
  }

  private renderList(list: XElement, depth: number): string {
    const styleName = attr(list, 'text:style-name');
    const listStyle = styleName ? this.listStyles.get(styleName) : undefined;
    const ordered = listStyle?.ordered.get(depth) ?? false;
    const marker = ordered ? null : this.options.bullet;
    const indent = '  '.repeat(depth);

    const lines: string[] = [];
    let counter = 0;

    for (const item of children(list, 'text:list-item')) {
      counter++;
      const bullet = marker ?? `${counter}.`;
      const pad = ' '.repeat(bullet.length + 1);
      const parts: string[] = [];

      for (const node of item.children) {
        if (node.type !== 'element') continue;
        if (node.local === 'list') {
          parts.push(this.renderList(node, depth + 1));
        } else if (node.local === 'p' || node.local === 'h') {
          const text = this.renderInline(node).trim();
          if (text) parts.push(text);
        }
      }

      if (parts.length === 0) continue;
      const [first, ...rest] = parts;
      lines.push(`${indent}${bullet} ${first}`);
      for (const part of rest) {
        lines.push(part.startsWith(' ') ? part : part.split('\n').map((l) => `${indent}${pad}${l}`).join('\n'));
      }
    }
    return lines.join('\n');
  }

  private renderTableElement(table: XElement): string {
    const rows: string[][] = [];
    let headerRows = 0;

    const pushRow = (row: XElement, header: boolean): void => {
      const cells: string[] = [];
      for (const cell of children(row, 'table:table-cell')) {
        const repeat = Math.min(Number(attr(cell, 'table:number-columns-repeated') ?? '1') || 1, 64);
        const text = this.cellText(cell);
        for (let i = 0; i < repeat; i++) cells.push(text);
      }
      if (cells.length === 0) return;
      if (header && rows.length === headerRows) headerRows++;
      rows.push(cells);
    };

    for (const node of table.children) {
      if (node.type !== 'element') continue;
      if (node.local === 'table-header-rows') {
        for (const row of children(node, 'table:table-row')) pushRow(row, true);
      } else if (node.local === 'table-row') {
        const repeat = Math.min(Number(attr(node, 'table:number-rows-repeated') ?? '1') || 1, 64);
        for (let i = 0; i < repeat; i++) pushRow(node, false);
      } else if (node.local === 'table-row-group' || node.local === 'table-rows') {
        for (const row of children(node, 'table:table-row')) pushRow(row, false);
      }
    }

    while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
    if (rows.length === 0) return '';

    let width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    while (width > 0 && rows.every((row) => (row[width - 1] ?? '').trim() === '')) width--;
    const trimmed = rows.map((row) => {
      const copy = row.slice(0, width);
      while (copy.length < width) copy.push('');
      return copy;
    });

    if (headerRows === 0) trimmed.unshift(new Array(width).fill(''));
    return renderTable(trimmed);
  }

  private cellText(cell: XElement): string {
    const parts: string[] = [];
    for (const node of cell.children) {
      if (node.type !== 'element') continue;
      if (node.local === 'p' || node.local === 'h') {
        const text = this.renderInline(node).trim();
        if (text) parts.push(text);
      } else if (node.local === 'list') {
        parts.push(this.renderList(node, 0).replace(/\n/g, '<br>'));
      }
    }
    if (parts.length === 0) {
      const value = attr(cell, 'office:value') ?? attr(cell, 'office:date-value') ?? '';
      return value;
    }
    return parts.join('<br>');
  }

  /* ------------------------------------------------------- spreadsheets */

  renderSpreadsheet(body: XElement, writer: MarkdownWriter): void {
    const tables = children(body, 'table:table');
    for (const table of tables) {
      if (tables.length > 1) writer.heading(2, attr(table, 'table:name') ?? 'Sheet');
      const rendered = this.renderTableElement(table);
      if (rendered) writer.push(rendered);
      else writer.paragraph('_Empty sheet._');
    }
  }

  /* ------------------------------------------------------ presentations */

  renderPresentation(body: XElement, writer: MarkdownWriter): void {
    const pages = children(body, 'draw:page');
    pages.forEach((page, index) => {
      if (index > 0 && this.options.pageSeparators) writer.rule();
      writer.heading(2, attr(page, 'draw:name') ?? `Slide ${index + 1}`);
      for (const frame of descendants(page, 'draw:frame')) {
        const image = child(frame, 'draw:image');
        if (image) {
          const md = this.renderImageElement(image, attr(frame, 'draw:name') ?? '');
          if (md) writer.push(md);
          continue;
        }
        const lines: string[] = [];
        for (const para of descendants(frame, 'text:p')) {
          const text = this.renderInline(para).trim();
          if (text) lines.push(`${this.options.bullet} ${text}`);
        }
        if (lines.length > 0) writer.push(lines.join('\n'));
      }
      const notes = child(page, 'presentation:notes');
      if (notes && this.options.includeNotes) {
        const text = descendants(notes, 'text:p').map((p) => this.renderInline(p).trim()).filter(Boolean).join(' ');
        if (text) writer.quote(`**Speaker notes:** ${text}`);
      }
    });
  }

  /* ------------------------------------------------------------- inline */

  private renderInline(el: XElement, style: TextStyle = this.styleFor(attr(el, 'text:style-name'))): string {
    let out = '';
    for (const node of el.children) {
      out += this.renderInlineNode(node, style);
    }
    return out;
  }

  private renderInlineNode(node: XNode, style: TextStyle): string {
    if (node.type === 'text') return applyStyle(escapeInline(node.value), style);

    switch (node.local) {
      case 's': {
        const count = Number(attr(node, 'text:c') ?? '1') || 1;
        return ' '.repeat(Math.min(count, 8));
      }
      case 'tab':
        return '    ';
      case 'line-break':
        return '  \n';
      case 'a': {
        const href = attr(node, 'xlink:href') ?? '';
        const inner = this.renderInline(node, style).trim();
        return href ? mdLink(inner || href, href) : inner;
      }
      case 'span': {
        const spanStyle = mergeStyles(style, this.styleFor(attr(node, 'text:style-name')));
        return this.renderInline(node, spanStyle);
      }
      case 'image':
        return this.renderImageElement(node, '');
      case 'frame': {
        const image = child(node, 'draw:image');
        if (image) return this.renderImageElement(image, attr(node, 'draw:name') ?? '');
        return this.renderInline(node, style);
      }
      case 'note': {
        if (!this.options.includeNotes) return '';
        const body = firstDescendant(node, 'text:note-body');
        const text = body ? collapseWhitespace(textOf(body)).trim() : '';
        return text ? ` ^[${text}]` : '';
      }
      case 'bookmark':
      case 'bookmark-start':
      case 'bookmark-end':
      case 'sequence-decls':
      case 'annotation':
        return '';
      default:
        return this.renderInline(node, style);
    }
  }

  private renderImageElement(image: XElement, alt: string): string {
    if (this.options.imageMode === 'skip') return '';
    const href = attr(image, 'xlink:href');
    if (!href) return '';
    if (/^https?:/i.test(href)) {
      this.imageCount++;
      return mdImage(alt || 'image', href);
    }

    const path = href.replace(/^\.\//, '');
    if (this.options.imageMode === 'reference') {
      this.imageCount++;
      return mdImage(alt || basename(path), basename(path));
    }

    const bytes = this.zip.read(path);
    if (!bytes) {
      this.warnings.push(`Image part not found: ${path}`);
      return '';
    }
    if (bytes.length > this.options.maxEmbeddedImageBytes) {
      this.warnings.push(`Skipped embedding ${basename(path)} (${formatBytes(bytes.length)}).`);
      return mdImage(alt || basename(path), basename(path));
    }
    this.imageCount++;
    return mdImage(alt || basename(path), dataUri(bytes, imageMimeFor(path)));
  }
}

function mergeStyles(a: TextStyle, b: TextStyle): TextStyle {
  return {
    bold: a.bold || b.bold,
    italic: a.italic || b.italic,
    strike: a.strike || b.strike,
    mono: a.mono || b.mono,
  };
}

function applyStyle(text: string, style: TextStyle): string {
  if (!text.trim()) return text;
  const leading = text.match(/^\s*/)?.[0] ?? '';
  const trailing = text.match(/\s*$/)?.[0] ?? '';
  let core = text.slice(leading.length, text.length - trailing.length);
  if (style.mono) core = `\`${core.replace(/`/g, '')}\``;
  if (style.strike) core = `~~${core}~~`;
  if (style.bold) core = `**${core}**`;
  if (style.italic) core = `*${core}*`;
  return `${leading}${core}${trailing}`;
}
