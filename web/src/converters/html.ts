/**
 * HTML → Markdown.
 *
 * Also the backend for EPUB chapters, `.mht` bodies and the HTML part of
 * emails, so it takes a parsed tree rather than a string and lets the caller
 * rewrite image sources (e.g. to pull a picture out of an EPUB container).
 */

import { attr, child, descendants, parseHtml, textOf, XElement, XNode } from '../core/xml.js';
import {
  codeBlock,
  collapseWhitespace,
  escapeBlock,
  escapeInline,
  image as mdImage,
  link as mdLink,
  normalizeMarkdown,
  renderTable,
} from '../core/md.js';

export interface HtmlOptions {
  bullet: '-' | '*' | '+';
  /** Map an `src`/`href` to something usable offline; return null to drop it. */
  resolveUrl?: (url: string, kind: 'image' | 'link') => string | null;
  /** Shift all headings down by this many levels (used for EPUB chapters). */
  headingOffset?: number;
  /** Counts images actually emitted. */
  onImage?: () => void;
}

const SKIPPED = new Set([
  'script', 'style', 'noscript', 'head', 'meta', 'link', 'title', 'iframe', 'object', 'embed',
  'canvas', 'svg', 'template', 'button', 'input', 'select', 'textarea', 'form', 'nav',
]);

const BLOCK_CONTAINERS = new Set([
  'html', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'figure',
  'fieldset', 'details', 'summary', 'address', 'center', 'font', 'span',
]);

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

interface Context extends HtmlOptions {
  listStack: { ordered: boolean; index: number }[];
  classStyles: Map<string, InlineStyle>;
}

export function htmlStringToMarkdown(html: string, options: HtmlOptions): string {
  return htmlToMarkdown(parseHtml(html), options);
}

export function htmlToMarkdown(root: XElement, options: HtmlOptions): string {
  const ctx: Context = { ...options, listStack: [], classStyles: collectClassStyles(root) };
  const body = findBody(root) ?? root;
  const blocks = renderChildren(body, ctx);
  return normalizeMarkdown(blocks.join('\n\n'));
}

/**
 * Word and Google Docs export emphasis as CSS classes on bare `<span>`s rather
 * than `<b>`/`<i>`, so the stylesheet has to be read to keep it.
 */
function collectClassStyles(root: XElement): Map<string, InlineStyle> {
  const styles = new Map<string, InlineStyle>();

  for (const styleEl of descendants(root, 'style')) {
    const css = textOf(styleEl).replace(/\/\*[\s\S]*?\*\//g, '');

    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2].toLowerCase();
      const bold = /font-weight\s*:\s*(bold(er)?|[6-9]00)/.test(body);
      const italic = /font-style\s*:\s*(italic|oblique)/.test(body);
      const strike = /text-decoration[^;]*line-through/.test(body);
      if (!bold && !italic && !strike) continue;

      for (const selector of rule[1].split(',')) {
        const match = selector.trim().match(/^\.([\w-]+)$/);
        if (!match) continue;
        const existing = styles.get(match[1]) ?? { bold: false, italic: false, strike: false };
        styles.set(match[1], {
          bold: existing.bold || bold,
          italic: existing.italic || italic,
          strike: existing.strike || strike,
        });
      }
    }
  }
  return styles;
}

function styleForElement(el: XElement, ctx: Context): InlineStyle | null {
  const classes = (attr(el, 'class') ?? '').split(/\s+/).filter(Boolean);
  const inline = (attr(el, 'style') ?? '').toLowerCase();

  let bold = /font-weight\s*:\s*(bold(er)?|[6-9]00)/.test(inline);
  let italic = /font-style\s*:\s*(italic|oblique)/.test(inline);
  let strike = /text-decoration[^;]*line-through/.test(inline);

  for (const name of classes) {
    const style = ctx.classStyles.get(name);
    if (!style) continue;
    bold = bold || style.bold;
    italic = italic || style.italic;
    strike = strike || style.strike;
  }

  return bold || italic || strike ? { bold, italic, strike } : null;
}

function applyStyle(text: string, style: InlineStyle): string {
  let out = text;
  if (style.strike) out = wrap(out, '~~');
  if (style.bold) out = wrap(out, '**');
  if (style.italic) out = wrap(out, '*');
  return out;
}

export function htmlTitle(root: XElement): string {
  const title = descendants(root, 'title')[0];
  if (title) {
    const text = collapseWhitespace(textOf(title)).trim();
    if (text) return text;
  }
  for (const meta of descendants(root, 'meta')) {
    const name = (attr(meta, 'name') ?? attr(meta, 'property') ?? '').toLowerCase();
    if (name === 'og:title' || name === 'title') {
      const content = attr(meta, 'content')?.trim();
      if (content) return content;
    }
  }
  const h1 = descendants(root, 'h1')[0];
  return h1 ? collapseWhitespace(textOf(h1)).trim() : '';
}

export function htmlMeta(root: XElement): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const el of descendants(root, 'meta')) {
    const key = (attr(el, 'name') ?? attr(el, 'property') ?? '').toLowerCase();
    const content = attr(el, 'content')?.trim();
    if (!key || !content) continue;
    if (key === 'author' || key === 'article:author') meta.author = content;
    if (key === 'description' || key === 'og:description') meta.description = content;
    if (key === 'keywords') meta.keywords = content;
    if (key === 'article:published_time' || key === 'date') meta.date = content;
  }
  return meta;
}

function findBody(root: XElement): XElement | null {
  return descendants(root, 'body')[0] ?? null;
}

function renderChildren(el: XElement, ctx: Context): string[] {
  const blocks: string[] = [];
  let inlineRun: XNode[] = [];

  const flush = (): void => {
    if (inlineRun.length === 0) return;
    const text = inlineRun.map((n) => renderInline(n, ctx)).join('');
    const trimmed = trimInline(text);
    if (trimmed) blocks.push(trimmed);
    inlineRun = [];
  };

  for (const node of el.children) {
    if (node.type === 'text') {
      inlineRun.push(node);
      continue;
    }
    if (SKIPPED.has(node.local)) continue;

    if (isBlock(node)) {
      flush();
      blocks.push(...renderBlock(node, ctx));
    } else {
      inlineRun.push(node);
    }
  }
  flush();
  return blocks.filter((b) => b.trim().length > 0);
}

function isBlock(el: XElement): boolean {
  const tag = el.local;
  if (tag === 'span' || tag === 'font') {
    // Treat as block only when it wraps block content (common in exported HTML).
    return el.children.some((n) => n.type === 'element' && isBlock(n) && n.local !== 'span');
  }
  return (
    BLOCK_CONTAINERS.has(tag) ||
    /^h[1-6]$/.test(tag) ||
    ['p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'table', 'dl', 'dt', 'dd', 'figcaption'].includes(tag)
  );
}

function renderBlock(el: XElement, ctx: Context): string[] {
  const tag = el.local;

  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(6, Number(tag[1]) + (ctx.headingOffset ?? 0));
    const text = trimInline(renderInlineChildren(el, ctx));
    return text ? [`${'#'.repeat(Math.max(1, level))} ${text.replace(/\n+/g, ' ')}`] : [];
  }

  switch (tag) {
    case 'p':
    case 'figcaption':
    case 'dt':
    case 'dd': {
      const text = trimInline(renderInlineChildren(el, ctx));
      if (!text) return [];
      if (tag === 'dt') return [`**${text}**`];
      if (tag === 'dd') return [`: ${text}`];
      return [escapeLeadingMarker(text)];
    }
    case 'hr':
      return ['---'];
    case 'pre':
      return [renderPre(el)];
    case 'blockquote': {
      const inner = renderChildren(el, ctx).join('\n\n');
      if (!inner.trim()) return [];
      return [inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')];
    }
    case 'ul':
    case 'ol':
      return [renderList(el, ctx)];
    case 'table':
      return renderHtmlTable(el, ctx);
    case 'dl':
      return renderChildren(el, ctx);
    default:
      return renderChildren(el, ctx);
  }
}

function renderPre(el: XElement): string {
  const codeEl = child(el, 'code');
  const target = codeEl ?? el;
  const classes = (attr(target, 'class') ?? '').split(/\s+/);
  const langClass = classes.find((c) => /^(language|lang|highlight)-/.test(c));
  const language = langClass ? langClass.replace(/^(language|lang|highlight)-/, '') : '';
  const text = rawText(target).replace(/^\n/, '').replace(/\s+$/, '');
  return codeBlock(text, language);
}

function rawText(node: XNode): string {
  if (node.type === 'text') return node.value;
  if (node.local === 'br') return '\n';
  let out = '';
  for (const kid of node.children) out += rawText(kid);
  return out;
}

function renderList(el: XElement, ctx: Context): string {
  const ordered = el.local === 'ol';
  const start = Number(attr(el, 'start') ?? '1');
  ctx.listStack.push({ ordered, index: Number.isFinite(start) ? start : 1 });

  const lines: string[] = [];
  const depth = ctx.listStack.length - 1;
  const indent = '  '.repeat(depth);

  for (const li of el.children) {
    if (li.type !== 'element') continue;
    if (li.local !== 'li') continue;

    const state = ctx.listStack[ctx.listStack.length - 1];
    const marker = ordered ? `${state.index++}.` : ctx.bullet;
    const checkbox = taskMarker(li);

    const { blocks, nested } = splitListItem(li, ctx);
    const body = blocks.join('\n\n').trim();
    if (!body && nested.length === 0 && !checkbox) continue;

    const pad = ' '.repeat(marker.length + 1);
    const rendered = body
      .split('\n')
      .map((line, i) => (i === 0 ? line : line ? `${indent}${pad}${line}` : ''))
      .join('\n');

    // Nested lists already carry their own indent, and must not be separated
    // by a blank line or the outer list breaks into two.
    const suffix = nested.length > 0 ? `\n${nested.join('\n')}` : '';
    lines.push(`${indent}${marker} ${checkbox}${rendered}${suffix}`.replace(/[ \t]+$/, ''));
  }

  ctx.listStack.pop();
  return lines.join('\n');
}

/** Separates an `<li>`'s own content from the lists nested inside it. */
function splitListItem(li: XElement, ctx: Context): { blocks: string[]; nested: string[] } {
  const blocks: string[] = [];
  const nested: string[] = [];
  let inlineRun: XNode[] = [];

  const flush = (): void => {
    if (inlineRun.length === 0) return;
    const text = trimInline(inlineRun.map((n) => renderInline(n, ctx)).join(''));
    if (text) blocks.push(text);
    inlineRun = [];
  };

  for (const node of li.children) {
    if (node.type === 'text') {
      inlineRun.push(node);
      continue;
    }
    if (SKIPPED.has(node.local)) continue;

    if (node.local === 'ul' || node.local === 'ol') {
      flush();
      const rendered = renderList(node, ctx);
      if (rendered.trim()) nested.push(rendered);
    } else if (isBlock(node)) {
      flush();
      blocks.push(...renderBlock(node, ctx));
    } else {
      inlineRun.push(node);
    }
  }
  flush();
  return { blocks, nested };
}

function taskMarker(li: XElement): string {
  const input = descendants(li, 'input')[0];
  if (!input) return '';
  if ((attr(input, 'type') ?? '').toLowerCase() !== 'checkbox') return '';
  return attr(input, 'checked') !== null ? '[x] ' : '[ ] ';
}

function renderHtmlTable(el: XElement, ctx: Context): string[] {
  const rows: string[][] = [];
  let headerRows = 0;
  const caption = child(el, 'caption');

  const rowElements = descendants(el, 'tr');
  for (const tr of rowElements) {
    const cells: string[] = [];
    let isHeaderRow = true;
    for (const cell of tr.children) {
      if (cell.type !== 'element') continue;
      if (cell.local !== 'td' && cell.local !== 'th') continue;
      if (cell.local !== 'th') isHeaderRow = false;
      const text = trimInline(renderCell(cell, ctx));
      const span = Math.max(1, Number(attr(cell, 'colspan') ?? '1') || 1);
      cells.push(text);
      for (let i = 1; i < span; i++) cells.push('');
    }
    if (cells.length === 0) continue;
    if (isHeaderRow && rows.length === headerRows) headerRows++;
    rows.push(cells);
  }

  if (rows.length === 0) return [];

  // Markdown tables need a header row; synthesise a blank one when absent.
  if (headerRows === 0) rows.unshift(new Array(rows[0].length).fill(''));

  const out = [renderTable(rows)];
  if (caption) {
    const text = trimInline(renderInlineChildren(caption, ctx));
    if (text) out.unshift(`**${text}**`);
  }
  return out;
}

function renderCell(cell: XElement, ctx: Context): string {
  const blocks = renderChildren(cell, ctx);
  return blocks.join('<br>');
}

function renderInlineChildren(el: XElement, ctx: Context): string {
  let out = '';
  for (const node of el.children) out += renderInline(node, ctx);
  return out;
}

function renderInline(node: XNode, ctx: Context): string {
  if (node.type === 'text') return escapeInline(collapseWhitespace(node.value.replace(/\n/g, ' ')));

  const tag = node.local;
  if (SKIPPED.has(tag)) return '';

  switch (tag) {
    case 'br':
      return '  \n';
    case 'img':
      return renderImage(node, ctx);
    case 'a':
      return renderAnchor(node, ctx);
    case 'strong':
    case 'b':
      return wrap(renderInlineChildren(node, ctx), '**');
    case 'em':
    case 'i':
    case 'cite':
    case 'var':
      return wrap(renderInlineChildren(node, ctx), '*');
    case 'del':
    case 's':
    case 'strike':
      return wrap(renderInlineChildren(node, ctx), '~~');
    case 'mark':
      return wrap(renderInlineChildren(node, ctx), '==');
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt':
      return inlineCode(rawText(node));
    case 'sup':
      return wrapTag(renderInlineChildren(node, ctx), 'sup');
    case 'sub':
      return wrapTag(renderInlineChildren(node, ctx), 'sub');
    case 'q':
      return `"${renderInlineChildren(node, ctx)}"`;
    case 'wbr':
      return '';
    default: {
      if (isBlock(node)) {
        return renderBlock(node, ctx).join('\n\n');
      }
      const inner = renderInlineChildren(node, ctx);
      const style = styleForElement(node, ctx);
      return style ? applyStyle(inner, style) : inner;
    }
  }
}

function renderAnchor(el: XElement, ctx: Context): string {
  const inner = renderInlineChildren(el, ctx);
  const raw = attr(el, 'href');
  if (!raw) return inner;
  const href = ctx.resolveUrl ? ctx.resolveUrl(raw, 'link') : raw;
  if (!href) return inner;
  if (!inner.trim()) return href.startsWith('#') ? '' : `<${href}>`;

  const leading = inner.match(/^\s*/)?.[0] ?? '';
  const trailing = inner.match(/\s*$/)?.[0] ?? '';
  const title = attr(el, 'title') ?? undefined;
  return `${leading}${mdLink(inner.trim(), href, title)}${trailing}`;
}

function renderImage(el: XElement, ctx: Context): string {
  const raw = attr(el, 'src') ?? attr(el, 'data-src') ?? '';
  if (!raw) return '';
  const src = ctx.resolveUrl ? ctx.resolveUrl(raw, 'image') : raw;
  if (!src) return '';
  ctx.onImage?.();
  const alt = (attr(el, 'alt') ?? '').trim();
  const title = attr(el, 'title') ?? undefined;
  return mdImage(alt, src, title);
}

function inlineCode(text: string): string {
  const clean = text.replace(/\r?\n/g, ' ');
  if (!clean.trim()) return '';
  const longest = [...clean.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/** Keep whitespace outside emphasis markers — `** bold **` does not render. */
function wrap(inner: string, marker: string): string {
  if (!inner.trim()) return inner;
  const leading = inner.match(/^\s*/)?.[0] ?? '';
  const trailing = inner.match(/\s*$/)?.[0] ?? '';
  const core = inner.slice(leading.length, inner.length - trailing.length);
  if (core.startsWith(marker) && core.endsWith(marker)) return inner;
  return `${leading}${marker}${core}${marker}${trailing}`;
}

function wrapTag(inner: string, tag: string): string {
  return inner.trim() ? `<${tag}>${inner.trim()}</${tag}>` : '';
}

function trimInline(text: string): string {
  return text.replace(/^[ \t]+/gm, (m, offset: number) => (offset === 0 ? '' : m)).replace(/^\s+|\s+$/g, '');
}

/**
 * The text is already Markdown, so only a marker at the very start of the
 * paragraph needs escaping — running a full escape here would neuter the
 * emphasis and links produced by the inline pass.
 */
function escapeLeadingMarker(text: string): string {
  return text.replace(/^(\s*)([-+>#]|\d+[.)])(\s)/, (_match, indent: string, marker: string, tail: string) => {
    return `${indent}\\${marker}${tail}`;
  });
}
