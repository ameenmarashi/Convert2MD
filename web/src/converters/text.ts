/**
 * Plain text, Markdown, source code, JSON/YAML and subtitle files → Markdown.
 *
 * Plain text gets a light structural pass (setext headings, bullet and numbered
 * lists, indented code) rather than being dumped into a code fence, which is
 * what makes a pasted note or a README-style .txt read well afterwards.
 */

import { decodeText } from '../core/decode.js';
import { codeBlock, escapeBlock, fenceLanguage, MarkdownWriter, normalizeMarkdown, renderTable } from '../core/md.js';
import { ConvertOptions, SourceFile } from '../core/types.js';

export interface TextOutput {
  markdown: string;
  meta: Record<string, string>;
  warnings: string[];
}

const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'cc', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'r', 'scala', 'dart', 'lua',
  'pl', 'vim', 'toml', 'ini', 'cfg', 'conf', 'gradle', 'tf', 'dockerfile', 'makefile', 'm', 'mm',
]);

export function convertText(file: SourceFile, options: ConvertOptions): TextOutput {
  const { text, encoding } = decodeText(file.bytes);
  const extension = (file.name.split('.').pop() ?? '').toLowerCase();
  const meta: Record<string, string> = { encoding };
  const warnings: string[] = [];

  if (extension === 'md' || extension === 'markdown' || extension === 'mdown' || extension === 'mkd') {
    return { markdown: normalizeMarkdown(text), meta, warnings };
  }

  if (extension === 'json' || extension === 'jsonl' || extension === 'ndjson') {
    return { markdown: jsonToMarkdown(text, extension, warnings), meta, warnings };
  }

  if (extension === 'srt' || extension === 'vtt') {
    return { markdown: subtitlesToMarkdown(text), meta, warnings };
  }

  if (extension === 'yaml' || extension === 'yml' || extension === 'xml' || extension === 'svg') {
    return { markdown: codeBlock(text.trim(), fenceLanguage(extension)), meta, warnings };
  }

  if (CODE_EXTENSIONS.has(extension)) {
    return { markdown: codeBlock(text.replace(/\s+$/, ''), fenceLanguage(extension)), meta, warnings };
  }

  return { markdown: plainTextToMarkdown(text, options), meta, warnings };
}

const BULLET_LINE = /^(\s*)([-*+•·▪◦‣o])\s+(.+)$/;
const ORDERED_LINE = /^(\s*)(\d{1,3})[.)]\s+(.+)$/;
const SETEXT_UNDERLINE = /^\s*(={3,}|-{3,}|~{3,}|\*{3,}|_{3,})\s*$/;

export function plainTextToMarkdown(text: string, options: ConvertOptions): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const writer = new MarkdownWriter();

  let paragraph: string[] = [];
  let listBuffer: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const joined = options.preserveLineBreaks
      ? paragraph.map((l) => escapeBlock(l.trim())).join('  \n')
      : escapeBlock(paragraph.join(' ').replace(/\s+/g, ' ').trim());
    writer.push(joined);
    paragraph = [];
  };

  const flushList = (): void => {
    if (listBuffer.length === 0) return;
    writer.push(listBuffer.join('\n'));
    listBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const next = lines[i + 1] ?? '';
    if (SETEXT_UNDERLINE.test(next) && trimmed.length <= 120) {
      flushParagraph();
      flushList();
      const level = next.trim().startsWith('=') ? 1 : 2;
      writer.heading(level, trimmed);
      i++;
      continue;
    }

    if (SETEXT_UNDERLINE.test(line)) {
      flushParagraph();
      flushList();
      writer.rule();
      continue;
    }

    const bullet = line.match(BULLET_LINE);
    if (bullet) {
      flushParagraph();
      const depth = Math.floor(bullet[1].length / 2);
      listBuffer.push(`${'  '.repeat(Math.min(depth, 4))}${options.bullet} ${escapeBlock(bullet[3].trim())}`);
      continue;
    }

    const ordered = line.match(ORDERED_LINE);
    if (ordered) {
      flushParagraph();
      const depth = Math.floor(ordered[1].length / 2);
      listBuffer.push(`${'  '.repeat(Math.min(depth, 4))}${ordered[2]}. ${escapeBlock(ordered[3].trim())}`);
      continue;
    }

    flushList();

    // An ALL-CAPS or numbered short line on its own reads as a heading.
    if (isHeadingLike(trimmed, lines[i + 1] ?? '')) {
      flushParagraph();
      writer.heading(trimmed.length < 40 ? 2 : 3, trimmed);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  if (writer.isEmpty) return '';
  return writer.toString();
}

function isHeadingLike(line: string, next: string): boolean {
  if (line.length > 80 || line.length < 3) return false;
  if (/[.,;]$/.test(line)) return false;
  if (!next.trim()) {
    const letters = line.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 3 && letters === letters.toUpperCase()) return true;
  }
  return /^(chapter|section|part|appendix)\s+[\dIVXivx]+/i.test(line);
}

function jsonToMarkdown(text: string, extension: string, warnings: string[]): string {
  if (extension === 'jsonl' || extension === 'ndjson') {
    const rows = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((value): value is Record<string, unknown> => isFlatRecord(value));
    const table = recordsToTable(rows);
    if (table) return table;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warnings.push(`The JSON could not be parsed (${(err as Error).message}); kept as a code block.`);
    return codeBlock(text.trim(), 'json');
  }

  if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isFlatRecord)) {
    const table = recordsToTable(parsed as Record<string, unknown>[]);
    if (table) return table;
  }
  return codeBlock(JSON.stringify(parsed, null, 2), 'json');
}

function isFlatRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
}

function recordsToTable(records: Record<string, unknown>[]): string | null {
  if (records.length === 0) return null;
  const columns: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) if (!columns.includes(key)) columns.push(key);
  }
  if (columns.length === 0 || columns.length > 24) return null;

  const rows = [columns, ...records.map((record) => columns.map((key) => stringifyCell(record[key])))];
  return renderTable(rows);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function subtitlesToMarkdown(text: string): string {
  const writer = new MarkdownWriter();
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^WEBVTT.*\n/, '').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length === 0) continue;

    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) {
      writer.paragraph(escapeBlock(lines.join(' ')));
      continue;
    }
    const timing = lines[timingIndex].replace(/\s*-->\s*/, ' → ').replace(/,/g, '.').split(' ').slice(0, 3).join(' ');
    const body = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (body) writer.push(`**${timing}**  \n${escapeBlock(body)}`);
  }
  return writer.toString();
}
