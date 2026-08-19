/**
 * Editing in the preview — the word-processor half of the editor.
 *
 * The user types into the rendered document, not into Markdown source, and the
 * marks are only shown when they ask for them. That needs a round trip:
 * Markdown is rendered to DOM by `markdown-preview`, the browser edits the DOM,
 * and this module turns it back into Markdown.
 *
 * The way back is the app's own HTML → Markdown converter — the same code that
 * reads a saved web page or a Word export. Reusing it is the whole reason this
 * is a small file rather than a second Markdown writer that would drift from
 * the first one.
 *
 * `execCommand` is formally deprecated and has no replacement that any shipping
 * browser implements. Every one of them still supports it, and the alternative
 * is hand-rolling selection surgery for lists and headings, so it is what the
 * toolbar uses — with each command's result normalised on the way out.
 */

import { htmlStringToMarkdown } from '../converters/html.js';

/** Blocks the caret can sit in, for the toolbar's "is it already?" checks. */
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'DIV',
]);

/**
 * The editable DOM as Markdown.
 *
 * Works on a clone so the live document — and the user's caret in it — is never
 * touched by the tidying.
 */
export function serializeEditable(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;

  // A checkbox's tick is a property, and `innerHTML` writes attributes, so the
  // state has to be copied across by hand or every task comes back unticked.
  const live = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const copies = clone.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  copies.forEach((copy, index) => {
    if (live[index]?.checked) copy.setAttribute('checked', 'checked');
    else copy.removeAttribute('checked');
  });

  for (const element of clone.querySelectorAll('[contenteditable]')) {
    element.removeAttribute('contenteditable');
  }

  return editableHtmlToMarkdown(clone.innerHTML);
}

/**
 * The string half of the round trip, kept separate so it can be tested without
 * a browser.
 */
export function editableHtmlToMarkdown(html: string): string {
  const markdown = htmlStringToMarkdown(html, { bullet: '-' });
  // contenteditable pads with non-breaking spaces to keep runs of spaces alive.
  // They are invisible in the editor and confusing in a text file.
  return markdown.replace(/\u00a0/g, ' ');
}

/* ---------------------------------------------------------------- commands */

export type RichCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'number'
  | 'task'
  | 'quote'
  | 'link'
  | 'table'
  | 'rule';

/**
 * Runs a toolbar action against the editable document.
 *
 * Returns false when the caret is not inside the editor, which is the case
 * right after the pane is shown and before anything has been clicked.
 */
export function applyRichCommand(root: HTMLElement, command: RichCommand): boolean {
  if (!focusInside(root)) return false;

  switch (command) {
    case 'bold':
      return exec('bold');
    case 'italic':
      return exec('italic');
    case 'strike':
      return exec('strikeThrough');
    case 'code':
      return wrapInCode(root);
    case 'h1':
    case 'h2':
    case 'h3':
      return applyBlock(root, command.toUpperCase());
    case 'bullet':
      return exec('insertUnorderedList');
    case 'number':
      return exec('insertOrderedList');
    case 'task':
      return toggleTask(root);
    case 'quote':
      return applyBlock(root, 'BLOCKQUOTE');
    case 'link':
      return insertLink();
    case 'table':
      return insertHtml(TABLE_HTML);
    case 'rule':
      return insertHtml('<hr><p><br></p>');
    default:
      return false;
  }
}

const TABLE_HTML =
  '<table><thead><tr><th>Column</th><th>Column</th></tr></thead>' +
  '<tbody><tr><td>Cell</td><td>Cell</td></tr>' +
  '<tr><td>Cell</td><td>Cell</td></tr></tbody></table><p><br></p>';

/** Puts an image where the caret is. */
export function insertRichImage(root: HTMLElement, src: string, alt: string): boolean {
  if (!focusInside(root)) return false;
  const image = document.createElement('img');
  image.src = src;
  image.alt = alt;
  return insertNode(root, image);
}

/**
 * Headings and quotes toggle: pressing Heading on a heading of that level puts
 * the paragraph back, which is how every word processor behaves.
 */
function applyBlock(root: HTMLElement, tag: string): boolean {
  const block = blockAt(root);
  const target = block?.tagName === tag ? 'P' : tag;
  return exec('formatBlock', `<${target.toLowerCase()}>`);
}

/**
 * A checklist is a bulleted list whose items open with a checkbox — there is no
 * browser command for it, so the list comes from `insertUnorderedList` and the
 * boxes are put in afterwards.
 */
function toggleTask(root: HTMLElement): boolean {
  let item = closestTag(root, 'LI');
  if (!item) {
    exec('insertUnorderedList');
    item = closestTag(root, 'LI');
  }
  if (!item) return false;

  const existing = item.querySelector<HTMLInputElement>(':scope > input[type="checkbox"]');
  if (existing) {
    existing.remove();
    return true;
  }

  const box = document.createElement('input');
  box.type = 'checkbox';
  item.prepend(box, document.createTextNode(' '));
  return true;
}

/** `<code>` has no command of its own, so the selection is wrapped by hand. */
function wrapInCode(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const inside = closestTag(root, 'CODE');
  if (inside) {
    // Pressing it again gives the plain text back.
    inside.replaceWith(...inside.childNodes);
    return true;
  }

  const range = selection.getRangeAt(0);
  const code = document.createElement('code');
  if (range.collapsed) {
    code.textContent = 'code';
    if (!insertNode(root, code)) return false;
    selectContents(code);
    return true;
  }
  code.append(range.extractContents());
  range.insertNode(code);
  selectContents(code);
  return true;
}

function insertLink(): boolean {
  const selection = window.getSelection();
  const selected = selection?.toString().trim() ?? '';
  const looksLikeUrl = /^(https?:\/\/|mailto:|www\.)\S+$/i.test(selected);

  const address = window.prompt('Where should this link go?', looksLikeUrl ? selected : 'https://');
  if (!address || address === 'https://') return false;

  const href = /^[a-z][\w+.-]*:/i.test(address) ? address : `https://${address}`;
  if (selection && !selection.isCollapsed && !looksLikeUrl) return exec('createLink', href);

  // Nothing useful selected, so the address doubles as the label.
  return insertHtml(`<a href="${escapeAttribute(href)}">${escapeText(selected || href)}</a>&nbsp;`);
}

function insertHtml(html: string): boolean {
  return exec('insertHTML', html);
}

function exec(command: string, value?: string): boolean {
  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- selection */

function insertNode(root: HTMLElement, node: Node): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    root.append(node);
    return true;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    root.append(node);
    return true;
  }

  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function selectContents(node: Node): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The element the caret is in, walking up to the nearest block. */
function blockAt(root: HTMLElement): HTMLElement | null {
  let node = caretElement(root);
  while (node && node !== root) {
    if (BLOCK_TAGS.has(node.tagName)) return node;
    node = node.parentElement;
  }
  return null;
}

function closestTag(root: HTMLElement, tag: string): HTMLElement | null {
  let node = caretElement(root);
  while (node && node !== root) {
    if (node.tagName === tag) return node;
    node = node.parentElement;
  }
  return null;
}

function caretElement(root: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode ?? null;
  if (!anchor || !root.contains(anchor)) return null;
  return anchor.nodeType === Node.ELEMENT_NODE ? (anchor as HTMLElement) : anchor.parentElement;
}

/**
 * The toolbar takes focus away from the document when a button is pressed, so
 * the caret has to be put back before a command can act on it.
 */
function focusInside(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && root.contains(selection.anchorNode)) {
    root.focus({ preventScroll: true });
    return true;
  }

  root.focus({ preventScroll: true });
  if (!selection) return false;

  // No caret yet: start at the end, which is where someone who just opened a
  // document expects to carry on typing.
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
