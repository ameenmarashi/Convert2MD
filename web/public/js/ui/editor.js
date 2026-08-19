/**
 * Markdown editor, written for someone who has never used Markdown.
 *
 * There are two ways to work in it, and the everyday one is the document
 * itself: you type into the formatted page, the way you would in a word
 * processor, and the Markdown marks are only shown if you ask to see them. The
 * marks are still what gets saved — the file on disk is plain Markdown either
 * way — but nobody has to look at them to write.
 *
 *   Formatted (default)  the rendered document is the editing surface; the
 *                        toolbar acts on it and `rich.ts` turns it back into
 *                        Markdown after every change.
 *   Markdown             the source in a textarea with the rendered document
 *                        beside it, redrawing as you type. This is the teaching
 *                        view: the connection between `## ` and a heading is
 *                        learned by watching it happen.
 *
 * Whichever is showing, the textarea holds the document. That keeps one source
 * of truth: saving, word counts and the unsaved-changes flag all read it, and
 * the formatted surface writes into it rather than owning a second copy.
 *
 * In the Markdown view every programmatic edit goes through `insertText`, which
 * keeps the textarea's native undo stack intact. Setting `.value` directly would
 * throw it away, and an editor where Ctrl+Z does nothing is not one a beginner
 * can explore in.
 */
import { renderMarkdown } from './markdown-preview.js';
import { applyRichCommand, insertRichImage, serializeEditable } from './rich.js';
import { embedPhoto } from './photos.js';
const DRAFT_PREFIX = 'md-converter.draft.';
const VIEW_KEY = 'md-converter.editor-view';
const PREVIEW_DELAY = 120;
/**
 * Longer than the preview's: turning a whole document back into Markdown is
 * more work than rendering one, and it only has to be current by the time
 * something asks for the text.
 */
const SYNC_DELAY = 250;
let dom = null;
let documentName = '';
let baseline = '';
let previewTimer = 0;
let syncTimer = 0;
let view = 'rich';
/**
 * A `---` block at the top of the file. It is metadata rather than prose, so it
 * is held aside while the formatted surface is being edited and put back when
 * the Markdown is read — otherwise editing a document would quietly rewrite it.
 */
let frontMatter = '';
let onChanged = null;
let onNotice = null;
/* -------------------------------------------------------------- lifecycle */
export function initEditor(handlers) {
    onChanged = handlers.changed;
    onNotice = handlers.notice ?? null;
    dom = {
        input: required('editor-input'),
        preview: required('editor-preview'),
        previewLabel: required('editor-preview-label'),
        toolbar: required('editor-toolbar'),
        pane: required('editor'),
        status: required('editor-status'),
        sourceToggle: required('editor-source'),
        photoInput: required('editor-photo'),
    };
    dom.toolbar.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-action]');
        if (!(button instanceof HTMLElement))
            return;
        apply(button.dataset.action);
    });
    dom.sourceToggle.addEventListener('click', () => setView(view === 'rich' ? 'source' : 'rich'));
    dom.input.addEventListener('input', () => {
        schedulePreview();
        updateStatus();
        saveDraft();
    });
    dom.input.addEventListener('keydown', onKeyDown);
    // The formatted surface: the browser does the editing, and every change is
    // turned back into Markdown a moment later.
    dom.preview.addEventListener('input', () => scheduleSync());
    // Ticking a task box is a change too, and it does not raise `input`.
    dom.preview.addEventListener('change', () => scheduleSync());
    dom.preview.addEventListener('paste', (event) => onPaste(event));
    dom.preview.addEventListener('drop', (event) => onDrop(event));
    dom.preview.addEventListener('keydown', onRichKeyDown);
    dom.photoInput.addEventListener('change', () => {
        const files = [...(dom.photoInput.files ?? [])];
        // Cleared straight away so choosing the same picture twice still fires.
        dom.photoInput.value = '';
        void addPhotos(files);
    });
    view = loadView();
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
    applyView();
    reportDirty();
    return { restoredDraft };
}
export function editorMarkdown() {
    // The formatted surface writes into the textarea on a timer, so anything
    // asking for the text has to settle that first or it reads a stale copy.
    flushSync();
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
/**
 * `selectTitle` is for a document that has just been created: its heading is a
 * placeholder, so it is selected rather than merely focused and the first thing
 * typed replaces it — the way a new file behaves in a word processor.
 */
export function focusEditor(options = {}) {
    if (!dom)
        return;
    if (view === 'source') {
        dom.input.focus();
        if (options.selectTitle) {
            const heading = dom.input.value.match(/^#{1,6}\s+(.*)$/m);
            if (heading?.[1]) {
                const start = dom.input.value.indexOf(heading[1]);
                dom.input.setSelectionRange(start, start + heading[1].length);
            }
        }
        return;
    }
    dom.preview.focus({ preventScroll: true });
    if (!options.selectTitle)
        return;
    const heading = dom.preview.querySelector('h1, h2, h3');
    const selection = window.getSelection();
    if (!heading || !heading.textContent?.trim() || !selection)
        return;
    const range = document.createRange();
    range.selectNodeContents(heading);
    selection.removeAllRanges();
    selection.addRange(range);
}
/* ------------------------------------------------------------------- views */
export function editorView() {
    return view;
}
/**
 * Switches between typing in the document and typing in the Markdown.
 *
 * The switch is remembered, because it is a preference about how someone wants
 * to write rather than a property of a particular file.
 */
export function setView(next) {
    if (!dom)
        return;
    // Leaving the formatted surface means the Markdown has to be current first,
    // or the source view opens showing the document as it was before the last
    // few keystrokes.
    flushSync();
    view = next;
    try {
        localStorage.setItem(VIEW_KEY, next);
    }
    catch {
        // Private browsing; the choice lasts for this session.
    }
    applyView();
    focusEditor();
}
function loadView() {
    try {
        return localStorage.getItem(VIEW_KEY) === 'source' ? 'source' : 'rich';
    }
    catch {
        return 'rich';
    }
}
/** Puts the panes, the labels and the editable surface into the current view. */
function applyView() {
    if (!dom)
        return;
    const rich = view === 'rich';
    dom.pane.classList.toggle('editor--rich', rich);
    dom.sourceToggle.setAttribute('aria-pressed', String(!rich));
    dom.sourceToggle.title = rich
        ? 'Show the Markdown marks behind this document'
        : 'Hide the marks and edit the document itself';
    dom.previewLabel.textContent = rich ? 'Your document' : 'How it will look';
    renderPane();
    // `contenteditable` is set after the render so the browser sets up its
    // editing state on the finished document rather than an empty one.
    if (rich) {
        dom.preview.setAttribute('contenteditable', 'true');
        dom.preview.setAttribute('role', 'textbox');
        dom.preview.setAttribute('aria-multiline', 'true');
        dom.preview.setAttribute('aria-label', 'Your document');
        dom.preview.spellcheck = true;
    }
    else {
        dom.preview.removeAttribute('contenteditable');
        dom.preview.removeAttribute('role');
        dom.preview.removeAttribute('aria-multiline');
        dom.preview.removeAttribute('aria-label');
    }
}
/**
 * Draws the document into the preview pane.
 *
 * In the formatted view the front matter is held back: it is machine-readable
 * metadata, and a `<details>` block in the middle of an editable page is
 * something a beginner can only break.
 */
function renderPane() {
    if (!dom)
        return;
    const markdown = dom.input.value;
    if (view === 'rich') {
        const split = splitFrontMatter(markdown);
        frontMatter = split.front;
        dom.preview.replaceChildren(renderMarkdown(split.body));
        prepareEditable();
    }
    else {
        frontMatter = '';
        dom.preview.replaceChildren(renderMarkdown(markdown));
    }
    onChanged?.();
}
/** Makes a rendered document usable as an editing surface. */
function prepareEditable() {
    if (!dom)
        return;
    // The reading view shows task boxes as a fixed picture of the file; here they
    // are the way to tick something off.
    for (const box of dom.preview.querySelectorAll('input[type="checkbox"]')) {
        box.disabled = false;
    }
    // An empty document has nothing to put a caret in, and a document that ends
    // in a heading has nowhere to carry on writing — clicking under the title
    // would land back inside it. An empty paragraph is the answer to both, and it
    // serialises to nothing, so it never reaches the file.
    const last = dom.preview.lastElementChild;
    if (!last || /^H[1-6]$/.test(last.tagName)) {
        const paragraph = document.createElement('p');
        paragraph.append(document.createElement('br'));
        dom.preview.append(paragraph);
    }
}
/** Splits a leading `---` block off, keeping `front + body` equal to the input. */
export function splitFrontMatter(markdown) {
    if (!markdown.startsWith('---'))
        return { front: '', body: markdown };
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    if (lines[0].trim() !== '---')
        return { front: '', body: markdown };
    const end = lines.indexOf('---', 1);
    if (end < 1)
        return { front: '', body: markdown };
    const front = lines.slice(0, end + 1).join('\n') + '\n';
    return { front, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}
/* ------------------------------------------------- the formatted surface */
function scheduleSync() {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(syncFromRich, SYNC_DELAY);
}
/** Brings the Markdown up to date now, if the formatted view has run ahead. */
function flushSync() {
    if (view !== 'rich' || !syncTimer)
        return;
    window.clearTimeout(syncTimer);
    syncTimer = 0;
    syncFromRich();
}
/**
 * Turns the edited document back into Markdown.
 *
 * The rendered document is deliberately *not* redrawn from the result: the
 * caret lives in those nodes, and replacing them under someone's hands loses
 * their place mid-sentence.
 */
function syncFromRich() {
    if (!dom || view !== 'rich')
        return;
    syncTimer = 0;
    const body = serializeEditable(dom.preview);
    dom.input.value = frontMatter ? `${frontMatter}\n${body}` : body;
    updateStatus();
    saveDraft();
    onChanged?.();
}
/**
 * Enter inside a quote or a list is the browser's job here — it already
 * continues them. What it does not do is leave a quote, so Ctrl/⌘ + Enter drops
 * out into a fresh paragraph.
 */
function onRichKeyDown(event) {
    const meta = event.metaKey || event.ctrlKey;
    if (!meta)
        return;
    const shortcut = { b: 'bold', i: 'italic', k: 'link' };
    const action = shortcut[event.key.toLowerCase()];
    if (action) {
        event.preventDefault();
        apply(action);
        return;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        document.execCommand('formatBlock', false, '<p>');
        scheduleSync();
    }
}
/* ------------------------------------------------------------------ photos */
/** Opens the picture chooser. On a phone that offers the camera as well. */
export function choosePhotos() {
    dom?.photoInput.click();
}
async function addPhotos(files) {
    if (!dom || files.length === 0)
        return;
    let added = 0;
    for (const file of files) {
        const photo = await embedPhoto(file);
        if (!photo) {
            onNotice?.(`${file.name} could not be read as a picture.`);
            continue;
        }
        if (view === 'rich')
            insertRichImage(dom.preview, photo.src, photo.alt);
        else
            insertBlock(`![${photo.alt}](${photo.src})`);
        added++;
    }
    if (added === 0)
        return;
    if (view === 'rich')
        syncFromRich();
    else {
        schedulePreview();
        reportDirty();
        saveDraft();
    }
    onNotice?.(added === 1
        ? 'Picture added. It is stored inside the document itself, on this device.'
        : `${added} pictures added. They are stored inside the document itself, on this device.`);
}
/** Pasting or dropping a picture puts it in the document, not its file name. */
function onPaste(event) {
    const files = imageFiles(event.clipboardData);
    if (files.length === 0)
        return;
    event.preventDefault();
    void addPhotos(files);
}
function onDrop(event) {
    const files = imageFiles(event.dataTransfer);
    if (files.length === 0)
        return;
    event.preventDefault();
    void addPhotos(files);
}
function imageFiles(data) {
    return [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'));
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
/**
 * Only the Markdown view redraws from the text: in the formatted view the
 * document *is* the text, and redrawing it would take the caret with it.
 *
 * Counting words means scanning the whole document, so it rides along with the
 * debounced redraw rather than running on every keystroke.
 */
function renderPreview() {
    if (view === 'rich')
        return;
    renderPane();
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
    if (action === 'photo') {
        choosePhotos();
        return;
    }
    // In the formatted view the browser does the editing and the Markdown is
    // derived afterwards; in the Markdown view the marks are written directly.
    if (view === 'rich') {
        applyRichCommand(dom.preview, action);
        scheduleSync();
        return;
    }
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
    const content = lines.filter((line) => line.trim());
    // A selection with nothing in it is someone starting a list on an empty
    // line, so the mark goes on rather than coming off. Blank lines are only
    // left alone when there is other content around them to separate.
    const allMarked = content.length > 0 && content.every((line) => matcher.test(line));
    const keepBlanks = content.length > 0;
    let counter = 1;
    const updated = lines.map((line) => {
        if (!line.trim() && keepBlanks)
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