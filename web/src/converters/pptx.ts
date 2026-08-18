/**
 * PowerPoint (.pptx) → Markdown.
 *
 * Slides are emitted in presentation order (from the slide id list, not the
 * file names), each as a `##` section: title placeholder as the heading, body
 * placeholders as bullets that keep their outline level, plus tables, pictures
 * and — optionally — speaker notes.
 */

import { ZipArchive, naturalCompare } from '../core/zip.js';
import { attr, child, children, descendants, firstDescendant, parseXml, textOf, XElement } from '../core/xml.js';
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
import { basename, formatBytes, normalizePart, readRelationships } from './docx.js';

export interface PptxOutput {
  markdown: string;
  meta: Record<string, string>;
  warnings: string[];
  imageCount: number;
}

export function convertPptx(file: SourceFile, options: ConvertOptions): PptxOutput {
  const zip = ZipArchive.open(file.bytes);
  if (!zip.has('ppt/presentation.xml') && zip.namesUnder('ppt/slides/', '.xml').length === 0) {
    throw new ConversionError('Not a PowerPoint presentation: ppt/presentation.xml is missing.');
  }

  const warnings: string[] = [];
  let imageCount = 0;
  const slidePaths = slideOrder(zip);
  const writer = new MarkdownWriter();

  slidePaths.forEach((slidePath, index) => {
    const xml = zip.readText(slidePath);
    if (!xml) {
      warnings.push(`Slide part missing: ${slidePath}`);
      return;
    }
    if (index > 0 && options.pageSeparators) writer.rule();

    const slideRels = readRelationships(zip, relsPathFor(slidePath));
    const root = parseXml(xml);
    const shapes = collectShapes(root);

    const title = shapes.find((s) => s.placeholder === 'title' || s.placeholder === 'ctrTitle');
    writer.heading(2, title?.text.trim() || `Slide ${index + 1}`);

    for (const shape of shapes) {
      if (shape === title) continue;
      if (shape.kind === 'table') {
        writer.push(shape.text);
      } else if (shape.text.trim()) {
        writer.push(shape.text);
      }
    }

    for (const pic of descendants(root, 'p:pic')) {
      const md = renderPicture(pic, zip, slideRels, options, warnings);
      if (md) {
        imageCount++;
        writer.push(md);
      }
    }

    if (options.includeNotes) {
      const notes = readNotes(zip, slideRels);
      if (notes) writer.quote(`**Speaker notes:** ${notes}`);
    }
  });

  if (writer.isEmpty) writer.paragraph('_The presentation contains no text._');

  return { markdown: writer.toString(), meta: readMeta(zip), warnings, imageCount };
}

function readMeta(zip: ZipArchive): Record<string, string> {
  const meta: Record<string, string> = {};
  const core = zip.readText('docProps/core.xml');
  if (!core) return meta;
  const root = parseXml(core);
  for (const [key, tag] of [
    ['title', 'dc:title'],
    ['author', 'dc:creator'],
    ['modified', 'dcterms:modified'],
  ] as const) {
    const el = descendants(root, tag)[0];
    const value = el ? collapseWhitespace(textOf(el)).trim() : '';
    if (value) meta[key] = value;
  }
  return meta;
}

function slideOrder(zip: ZipArchive): string[] {
  const presentation = zip.readText('ppt/presentation.xml');
  if (presentation) {
    const rels = readRelationships(zip, 'ppt/_rels/presentation.xml.rels');
    const ids = descendants(parseXml(presentation), 'p:sldId');
    const ordered = ids
      .map((el) => attr(el, 'r:id'))
      .filter((id): id is string => Boolean(id))
      .map((id) => rels.get(id))
      .filter((rel): rel is NonNullable<typeof rel> => Boolean(rel))
      .map((rel) => normalizePart('ppt', rel.target))
      .filter((path) => zip.has(path));
    if (ordered.length > 0) return ordered;
  }
  return zip.namesUnder('ppt/slides/', '.xml').filter((n) => /slide\d+\.xml$/.test(n)).sort(naturalCompare);
}

function relsPathFor(partPath: string): string {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const name = partPath.split('/').pop() ?? '';
  return `${dir}/_rels/${name}.rels`;
}

interface Shape {
  kind: 'text' | 'table';
  placeholder: string | null;
  order: number;
  text: string;
}

function collectShapes(root: XElement): Shape[] {
  const shapes: Shape[] = [];
  let order = 0;

  const walk = (el: XElement): void => {
    for (const node of el.children) {
      if (node.type !== 'element') continue;
      if (node.name === 'p:sp') {
        const placeholder = placeholderType(node);
        const isHeading = placeholder === 'title' || placeholder === 'ctrTitle' || placeholder === 'subTitle';
        shapes.push({
          kind: 'text',
          placeholder,
          order: order++,
          text: renderTextBody(node, !isHeading),
        });
        continue;
      }
      if (node.name === 'a:tbl' || node.local === 'tbl') {
        shapes.push({ kind: 'table', placeholder: null, order: order++, text: renderPptxTable(node) });
        continue;
      }
      walk(node);
    }
  };

  walk(root);
  return shapes;
}

function placeholderType(shape: XElement): string | null {
  const ph = firstDescendant(shape, 'p:ph');
  if (!ph) return null;
  return attr(ph, 'type') ?? 'body';
}

function renderTextBody(shape: XElement, bulleted = true): string {
  const txBody = child(shape, 'p:txBody') ?? firstDescendant(shape, 'p:txBody');
  if (!txBody) return '';

  const lines: string[] = [];
  const counters = new Map<number, number>();

  for (const para of children(txBody, 'a:p')) {
    const text = renderParagraphRuns(para);
    if (!text.trim()) continue;

    if (!bulleted) {
      lines.push(text.trim());
      continue;
    }

    const pPr = child(para, 'a:pPr');
    const level = Number(pPr ? attr(pPr, 'lvl') ?? '0' : '0') || 0;
    const noBullet = pPr ? child(pPr, 'a:buNone') !== null : false;
    const autoNum = pPr ? child(pPr, 'a:buAutoNum') : null;

    if (noBullet && level === 0) {
      lines.push(text.trim());
      counters.clear();
      continue;
    }

    const indent = '  '.repeat(level);
    if (autoNum) {
      const next = (counters.get(level) ?? 0) + 1;
      counters.set(level, next);
      lines.push(`${indent}${next}. ${text.trim()}`);
    } else {
      lines.push(`${indent}- ${text.trim()}`);
    }
  }

  return lines.join('\n');
}

function renderParagraphRuns(para: XElement): string {
  let out = '';
  for (const node of para.children) {
    if (node.type !== 'element') continue;
    if (node.name === 'a:br') {
      out += '  \n';
      continue;
    }
    if (node.name === 'a:fld') {
      const t = child(node, 'a:t');
      if (t) out += escapeInline(textOf(t));
      continue;
    }
    if (node.name !== 'a:r') continue;

    const t = child(node, 'a:t');
    if (!t) continue;
    const rPr = child(node, 'a:rPr');
    const bold = rPr ? attr(rPr, 'b') === '1' : false;
    const italic = rPr ? attr(rPr, 'i') === '1' : false;
    const strike = rPr ? (attr(rPr, 'strike') ?? 'noStrike') !== 'noStrike' : false;
    const hlink = rPr ? child(rPr, 'a:hlinkClick') : null;

    const raw = textOf(t);
    if (!raw) continue;
    const leading = raw.match(/^\s*/)?.[0] ?? '';
    const trailing = raw.match(/\s*$/)?.[0] ?? '';
    let core = escapeInline(raw.trim());
    if (!core) {
      out += raw;
      continue;
    }
    if (strike) core = `~~${core}~~`;
    if (bold) core = `**${core}**`;
    if (italic) core = `*${core}*`;
    if (hlink) {
      const href = attr(hlink, 'r:id');
      if (href) core = mdLink(core, `#${href}`);
    }
    out += `${leading}${core}${trailing}`;
  }
  return out;
}

function renderPptxTable(tbl: XElement): string {
  const rows: string[][] = [];
  for (const tr of children(tbl, 'a:tr')) {
    const cells: string[] = [];
    for (const tc of children(tr, 'a:tc')) {
      const paragraphs = descendants(tc, 'a:p').map((p) => renderParagraphRuns(p).trim()).filter(Boolean);
      const span = Number(attr(tc, 'gridSpan') ?? '1') || 1;
      cells.push(paragraphs.join('<br>'));
      for (let i = 1; i < span; i++) cells.push('');
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';

  const firstRow = child(tbl, 'a:tblPr');
  const hasHeader = firstRow ? attr(firstRow, 'firstRow') === '1' : true;
  if (!hasHeader) rows.unshift(new Array(rows[0].length).fill(''));
  return renderTable(rows);
}

function renderPicture(
  pic: XElement,
  zip: ZipArchive,
  rels: Map<string, { target: string; external: boolean; type: string }>,
  options: ConvertOptions,
  warnings: string[]
): string {
  if (options.imageMode === 'skip') return '';

  const blip = firstDescendant(pic, 'a:blip');
  const id = blip ? attr(blip, 'r:embed') : null;
  if (!id) return '';
  const rel = rels.get(id);
  if (!rel) return '';

  const nv = firstDescendant(pic, 'p:cNvPr');
  const alt = nv ? (attr(nv, 'descr') || attr(nv, 'name') || '').trim() : '';

  if (rel.external) return mdImage(alt || 'image', rel.target);

  const path = normalizePart('ppt/slides', rel.target);
  if (options.imageMode === 'reference') return mdImage(alt || basename(path), basename(path));

  const bytes = zip.read(path);
  if (!bytes) {
    warnings.push(`Image part not found: ${path}`);
    return '';
  }
  if (bytes.length > options.maxEmbeddedImageBytes) {
    warnings.push(`Skipped embedding ${basename(path)} (${formatBytes(bytes.length)}).`);
    return mdImage(alt || basename(path), basename(path));
  }
  return mdImage(alt || basename(path), dataUri(bytes, imageMimeFor(path)));
}

function readNotes(
  zip: ZipArchive,
  rels: Map<string, { target: string; external: boolean; type: string }>
): string {
  for (const rel of rels.values()) {
    if (!rel.type.endsWith('/notesSlide')) continue;
    const path = normalizePart('ppt/slides', rel.target);
    const xml = zip.readText(path);
    if (!xml) continue;
    const root = parseXml(xml);
    const texts: string[] = [];
    for (const shape of descendants(root, 'p:sp')) {
      if (placeholderType(shape) === 'sldNum') continue;
      const text = descendants(shape, 'a:t').map((t) => textOf(t)).join('');
      if (text.trim()) texts.push(collapseWhitespace(text).trim());
    }
    return texts.join(' ');
  }
  return '';
}
