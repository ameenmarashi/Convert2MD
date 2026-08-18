/**
 * Markdown editor, written for someone who has never used Markdown.
 *
 * The teaching idea is Obsidian's: never make the beginner memorise syntax, and
 * always show what the marks do. So there are three things working together —
 *
 *   1. a toolbar whose buttons say what they make, not what they insert;
 *   2. a preview beside the text that redraws as you type, so the connection
 *      between `## ` and a heading is learned by watching rather than reading;
 *   3. typing help that does what the marks imply — Enter continues a list,
 *      Tab indents one, an empty item ends it.
 *
 * Every programmatic edit goes through `insertText`, which keeps the textarea's
 * native undo stack intact. Setting `.value` directly would throw it away, and
 * an editor where Ctrl+Z does nothing is not one a beginner can explore in.
 */
import { renderMarkdown } from './markdown-preview.js';
const DRAFT_PREFIX = 'md-converter.draft.';
const PREVIEW_DELAY = 120;
let dom = null;
let documentName = '';
let baseline = '';
let previewTimer = 0;
let onChanged = null;
/* -------------------------------------------------------------- lifecycle */
export function initEditor(handlers) {
    onChanged = handlers.changed;
    dom = {
        input: required('editor-input'),
        preview: required('editor-preview'),
        toolbar: required('editor-toolbar'),
        pane: required('editor'),
        status: required('editor-status'),
    };
    dom.toolbar.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-action]');
        if (!(button instanceof HTMLElement))
            return;
        apply(button.dataset.action);
    });
    dom.input.addEventListener('input', () => {
        schedulePreview();
        updateStatus();
        saveDraft();
    });
    dom.input.addEventListener('keydown', onKeyDown);
}
/** Loads a document, restoring an unsaved draft of it if one is waiting. */
export function loadIntoEditor(name, markdown) {
    if (!dom)
        return { restoredDraft: false };
    documentName = name;
    baseline = markdown;
    const draft = readDraft(name);
    const restoredDraft = draft !== null && draft !== markdown;
    dom.input.value = restoredDraft ? draft : markdown;
    renderPreview();
    reportDirty();
    return { restoredDraft };
}
export function editorMarkdown() {
    return dom?.input.value ?? '';
}
export function editorIsDirty() {
    return editorMarkdown() !== baseline;
}
/** Called after a save, so the document is no longer "unsaved". */
export function markEditorSaved() {
    baseline = editorMarkdown();
    clearDraft(documentName);
    reportDirty();
}
export function focusEditor() {
    dom?.input.focus();
}
/* ------------------------------------------------------------ dirty state */
function updateStatus() {
    if (!dom)
        return;
    const dirty = editorIsDirty();
    dom.status.textContent = dirty ? 'Unsaved changes' : 'All changes saved on this device';
    dom.status.classList.toggle('editor__status--dirty', dirty);
}
function reportDirty() {
    updateStatus();
    onChanged?.();
}
/* ---------------------------------------------------------------- preview */
function schedulePreview() {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(renderPreview, PREVIEW_DELAY);
}
function renderPreview() {
    if (!dom)
        return;
    dom.preview.replaceChildren(renderMarkdown(dom.input.value));
    // Counting words means scanning the whole document, so it rides along with
    // the debounced redraw rather than running on every keystroke.
    onChanged?.();
}
/* ------------------------------------------------------------ the drafts */
/**
 * Typing is kept on the device as it happens, so closing the tab by accident
 * does not lose an hour of work. It never leaves this browser, and it is
 * dropped the moment the file is saved.
 */
function saveDraft() {
    if (!documentName)
        return;
    try {
        localStorage.setItem(DRAFT_PREFIX + documentName, editorMarkdown());
    }
    catch {
        // Private browsing, or the quota is full; editing still works.
    }
}
function readDraft(name) {
    try {
        return localStorage.getItem(DRAFT_PREFIX + name);
    }
    catch {
        return null;
    }
}
function clearDraft(name) {
    try {
        localStorage.removeItem(DRAFT_PREFIX + name);
    }
    catch {
        // Nothing to clean up.
    }
}
const WRAPS = {
    bold: { before: '**', after: '**', placeholder: 'bold text' },
    italic: { before: '*', after: '*', placeholder: 'italic text' },
    strike: { before: '~~', after: '~~', placeholder: 'crossed out' },
    code: { before: '`', after: '`', placeholder: 'code' },
};
const LINE_MARKS = {
    // `#\s+` cannot match `## `, so a heading button converts a heading of
    // another level instead of toggling it off.
    h1: { prefix: '# ', matcher: /^(\s*)#\s+/ },
    h2: { prefix: '## ', matcher: /^(\s*)##\s+/ },
    h3: { prefix: '### ', matcher: /^(\s*)###\s+/ },
    bullet: { prefix: '- ', matcher: /^(\s*)[-*+]\s+(?!\[[ xX]\]\s)/ },
    number: { prefix: '1. ', matcher: /^(\s*)\d+[.)]\s+/ },
    task: { prefix: '- [ ] ', matcher: /^(\s*)[-*+]\s+\[[ xX]\]\s+/ },
    quote: { prefix: '> ', matcher: /^(\s*)>\s?/ },
};
export function apply(action) {
    if (!dom)
        return;
    const wrap = WRAPS[action];
    if (wrap) {
        applyWrap(wrap);
    }
    else if (LINE_MARKS[action]) {
        applyLineMark(LINE_MARKS[action]);
    }
    else if (action === 'link') {
        applyLink();
    }
    else if (action === 'table') {
        insertBlock('| Column | Column |\n| --- | --- |\n| Cell | Cell |');
    }
    else if (action === 'rule') {
        insertBlock('---');
    }
    schedulePreview();
    reportDirty();
    saveDraft();
}
/** Wrapping is a toggle: pressing Bold on bold text takes the marks off. */
function applyWrap({ before, after, placeholder }) {
    const input = dom.input;
    const { selectionStart: start, selectionEnd: end, value } = input;
    const selected = value.slice(start, end);
    const outerStart = start - before.length;
    const alreadyWrapped = outerStart >= 0 &&
        value.slice(outerStart, start) === before &&
        value.slice(end, end + after.length) === after;
    if (alreadyWrapped) {
        replaceRange(outerStart, end + after.length, selected, outerStart, outerStart + selected.length);
        return;
    }
    if (selected.startsWith(before) && selected.endsWith(after) && selected.length > before.length + after.length) {
        const inner = selected.slice(before.length, selected.length - after.length);
        replaceRange(start, end, inner, start, start + inner.length);
        return;
    }
    const body = selected || placeholder;
    replaceRange(start, end, before + body + after, start + before.length, start + before.length + body.length);
}
/**
 * Headings, lists and quotes apply to whole lines, and toggle off when every
 * selected line already carries the mark — so the same button undoes itself.
 */
function applyLineMark({ prefix, matcher }) {
    const input = dom.input;
    const { value } = input;
    const start = lineStartAt(value, input.selectionStart);
    const end = lineEndAt(value, input.selectionEnd);
    const lines = value.slice(start, end).split('\n');
    const ordered = /^\d+\. $/.test(prefix);
    const allMarked = lines.every((line) => !line.trim() || matcher.test(line));
    let counter = 1;
    const updated = lines.map((line) => {
        if (!line.trim())
            return line;
        if (allMarked)
            return line.replace(matcher, '$1');
        // One mark at a time: a line cannot be a heading and a bullet at once.
        const bare = line.replace(/^(\s*)(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+|>\s?)/, '$1');
        const indent = bare.match(/^\s*/)?.[0] ?? '';
        const text = bare.slice(indent.length);
        return indent + (ordered ? `${counter++}. ` : prefix) + text;
    });
    const text = updated.join('\n');
    replaceRange(start, end, text, start, start + text.length);
}
function applyLink() {
    const input = dom.input;
    const { selectionStart: start, selectionEnd: end, value } = input;
    const selected = value.slice(start, end);
    // Selecting a URL means the user wants that as the target, not the label.
    const isUrl = /^(https?:\/\/|mailto:|\/|\.\/)\S*$/i.test(selected.trim());
    const label = isUrl ? 'link text' : selected || 'link text';
    const href = isUrl ? selected.trim() : 'https://';
    const text = `[${label}](${href})`;
    // Land the caret on the half the user still has to fill in.
    const selectFrom = isUrl ? start + 1 : start + text.length - href.length - 1;
    const selectTo = isUrl ? start + 1 + label.length : start + text.length - 1;
    replaceRange(start, end, text, selectFrom, selectTo);
}
function insertBlock(block) {
    const input = dom.input;
    const { selectionStart: start, selectionEnd: end, value } = input;
    const before = start > 0 && value[start - 1] !== '\n' ? '\n\n' : '';
    const after = end < value.length && value[end] !== '\n' ? '\n\n' : '\n';
    const text = before + block + after;
    replaceRange(start, end, text, start + before.length, start + before.length + block.length);
}
/* --------------------------------------------------------- typing helpers */
function onKeyDown(event) {
    const meta = event.metaKey || event.ctrlKey;
    if (meta) {
        const shortcut = { b: 'bold', i: 'italic', k: 'link' };
        const action = shortcut[event.key.toLowerCase()];
        if (action) {
            event.preventDefault();
            apply(action);
        }
        return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
        if (continueList())
            event.preventDefault();
        return;
    }
    if (event.key === 'Tab') {
        // Tab only indents inside a list; everywhere else it moves focus onward,
        // which is what a keyboard user needs to leave the editor at all.
        if (indentListItem(event.shiftKey))
            event.preventDefault();
    }
}
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+\[[ xX]\])?\s+(.*)$/;
const QUOTE_LINE = /^(\s*)>\s?(.*)$/;
/**
 * Enter on a list item starts the next one; Enter on an empty item ends the
 * list instead of leaving a stray marker behind. Numbers count on.
 */
function continueList() {
    const input = dom.input;
    const { value, selectionStart: caret } = input;
    if (caret !== input.selectionEnd)
        return false;
    const start = lineStartAt(value, caret);
    const line = value.slice(start, caret);
    const item = line.match(LIST_ITEM);
    if (item) {
        const [, indent, marker, checkbox, text] = item;
        if (!text.trim()) {
            // An empty item means "I am done with this list".
            replaceRange(start, caret, indent, start + indent.length);
            return true;
        }
        const next = /\d/.test(marker)
            ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}`
            : marker;
        const box = checkbox ? ' [ ]' : '';
        const insert = `\n${indent}${next}${box} `;
        replaceRange(caret, caret, insert, caret + insert.length);
        return true;
    }
    const quote = line.match(QUOTE_LINE);
    if (quote) {
        const [, indent, text] = quote;
        if (!text.trim()) {
            replaceRange(start, caret, indent, start + indent.length);
            return true;
        }
        const insert = `\n${indent}> `;
        replaceRange(caret, caret, insert, caret + insert.length);
        return true;
    }
    return false;
}
function indentListItem(outdent) {
    const input = dom.input;
    const { value } = input;
    const start = lineStartAt(value, input.selectionStart);
    const end = lineEndAt(value, input.selectionEnd);
    const lines = value.slice(start, end).split('\n');
    if (!lines.some((line) => LIST_ITEM.test(line)))
        return false;
    const updated = lines.map((line) => {
        if (!LIST_ITEM.test(line))
            return line;
        return outdent ? line.replace(/^ {1,2}/, '') : `  ${line}`;
    });
    const text = updated.join('\n');
    replaceRange(start, end, text, start, start + text.length);
    schedulePreview();
    reportDirty();
    saveDraft();
    return true;
}
/* -------------------------------------------------------------- utilities */
/**
 * Edits go through `insertText` so the browser records them on the textarea's
 * own undo stack — Ctrl+Z then steps back through toolbar presses just as it
 * does through typing. The direct-assignment path is only for browsers that
 * refuse the command.
 */
function replaceRange(start, end, text, selectStart, selectEnd) {
    const input = dom.input;
    input.focus();
    input.setSelectionRange(start, end);
    let inserted = false;
    try {
        inserted = document.execCommand('insertText', false, text);
    }
    catch {
        inserted = false;
    }
    if (!inserted) {
        input.setRangeText(text, start, end, 'end');
    }
    if (selectStart !== undefined)
        input.setSelectionRange(selectStart, selectEnd ?? selectStart);
}
function lineStartAt(value, index) {
    return value.lastIndexOf('\n', index - 1) + 1;
}
function lineEndAt(value, index) {
    const next = value.indexOf('\n', index);
    return next === -1 ? value.length : next;
}
function required(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing element #${id}`);
    return element;
}
//# sourceMappingURL=editor.js.map