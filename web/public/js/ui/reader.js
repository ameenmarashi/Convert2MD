/**
 * Reading view for Markdown files.
 *
 * A `.md` file is already the finished document, so there is nothing to
 * convert — it just needs to be readable. This renders one into a paged,
 * comfortable-measure document view with a contents list, adjustable text size
 * and a print stylesheet, which is what makes "save as PDF" produce something
 * worth handing to somebody else.
 *
 * The renderer is the same DOM-building one the conversion previews use, so a
 * file that arrives from an AI tool — fenced code, tables, task lists — can
 * never inject markup.
 */
import { renderMarkdown } from './markdown-preview.js';
import { editorIsDirty, editorMarkdown, focusEditor, initEditor, loadIntoEditor, markEditorSaved, } from './editor.js';
const SIZE_KEY = 'md-converter.reader-size';
const SIZES = [0.9, 1, 1.15, 1.3, 1.5];
const DEFAULT_SIZE = 1;
let dom = null;
let current = null;
let sizeIndex = SIZES.indexOf(DEFAULT_SIZE);
let onCopy = null;
let onDownload = null;
let onToast = null;
let onSave = null;
let onKeep = null;
let onRename = null;
let mode = 'read';
/** Wires the reader chrome once, at startup. */
export function initReader(handlers) {
    onCopy = handlers.copy;
    onDownload = handlers.download;
    onToast = handlers.toast;
    onSave = handlers.save;
    onKeep = handlers.keep;
    onRename = handlers.rename;
    dom = {
        root: required('reader'),
        name: required('reader-name'),
        meta: required('reader-meta'),
        doc: required('reader-doc'),
        toc: required('reader-toc'),
        editor: required('editor'),
        toolbar: required('editor-toolbar'),
        rename: required('reader-rename'),
        saveButton: required('reader-save'),
        keepButton: required('reader-keep'),
        contentsButton: required('reader-contents'),
        readButton: required('mode-read'),
        editButton: required('mode-edit'),
    };
    initEditor({ changed: () => updateMeta(), notice: (message) => onToast?.(message) });
    sizeIndex = loadSize();
    applySize();
    required('reader-close').addEventListener('click', () => closeReader());
    required('reader-larger').addEventListener('click', () => stepSize(1));
    required('reader-smaller').addEventListener('click', () => stepSize(-1));
    required('reader-print').addEventListener('click', () => window.print());
    required('reader-copy').addEventListener('click', () => onCopy?.(markdownNow()));
    required('reader-download').addEventListener('click', () => {
        if (!current)
            return;
        onDownload?.({ name: current.name, markdown: markdownNow() });
        // Downloading is how a document leaves this app, so it is what "saved"
        // means here — the draft it was keeping is no longer needed.
        if (mode === 'edit')
            markEditorSaved();
    });
    dom.readButton.addEventListener('click', () => setMode('read'));
    dom.editButton.addEventListener('click', () => setMode('edit'));
    dom.saveButton.addEventListener('click', () => saveToLibrary());
    dom.keepButton.addEventListener('click', () => keepInLibrary());
    // The title is the document's name: type over it and that is the rename.
    dom.rename.addEventListener('change', () => applyRename());
    dom.rename.addEventListener('blur', () => applyRename());
    dom.rename.addEventListener('keydown', (event) => {
        if (event.key === 'Enter')
            dom.rename.blur();
        if (event.key === 'Escape') {
            dom.rename.value = current?.name ?? '';
            dom.rename.blur();
        }
    });
    dom.contentsButton.addEventListener('click', () => {
        const showing = !dom.toc.hidden;
        dom.toc.hidden = showing;
        dom.contentsButton.setAttribute('aria-expanded', String(!showing));
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen())
            closeReader();
    });
    // Android's back gesture should leave the document, not the app.
    window.addEventListener('popstate', () => {
        if (isOpen())
            closeReader({ fromHistory: true });
    });
}
export function isOpen() {
    return Boolean(dom && !dom.root.hidden);
}
export function openReader(document_, options = {}) {
    if (!dom)
        return;
    current = document_;
    showName();
    dom.doc.replaceChildren(renderMarkdown(document_.markdown));
    // The library id is stable and never reused; the name is, once a document
    // with that name is deleted — so the id is what keeps drafts from bleeding
    // between documents that happen to share a default name like "Untitled.md".
    const { restoredDraft } = loadIntoEditor(document_.id ?? document_.name, document_.markdown);
    // A document started from scratch has nothing to read yet, so it opens in
    // the editor with its placeholder title selected, ready to be typed over.
    setMode(options.edit ? 'edit' : 'read', { fresh: Boolean(options.edit) });
    updateMeta();
    if (restoredDraft) {
        onToast?.('Unsaved edits from last time were restored — switch to Edit to see them.');
    }
    dom.root.hidden = false;
    document.body.classList.add('is-reading');
    dom.root.scrollTop = 0;
    // Focus has to wait for the reader to be on screen: a hidden element cannot
    // take it, and a selection made before then is collapsed by whatever gets it
    // instead — which is how the first few letters of a new document ended up
    // beside the placeholder title rather than replacing it.
    if (options.edit)
        focusEditor({ selectTitle: true });
    else
        dom.doc.focus({ preventScroll: true });
    if (window.history.state?.reader !== true) {
        window.history.pushState({ reader: true }, '');
    }
}
export function closeReader(options = {}) {
    if (!dom || dom.root.hidden)
        return;
    // Edits are kept as a draft on this device, but a beginner will not know
    // that — so say it, rather than letting the document vanish silently.
    if (editorIsDirty() && !options.force) {
        const leave = window.confirm('You have edits you have not saved.\n\n' +
            'They are kept on this device and will still be here next time you open this file. ' +
            'Close anyway?');
        if (!leave)
            return;
    }
    dom.root.hidden = true;
    dom.doc.replaceChildren();
    current = null;
    document.body.classList.remove('is-reading');
    if (!options.fromHistory && window.history.state?.reader === true) {
        window.history.back();
    }
}
/* ---------------------------------------------------------------- library */
/**
 * A document in the library shows its name as an editable field, because the
 * title is the only place to rename it — on iOS there is no folder to go and
 * rename it in. One that came from a file keeps a plain, unchangeable title.
 */
function showName() {
    if (!dom || !current)
        return;
    const inLibrary = Boolean(current.id);
    dom.name.hidden = inLibrary;
    dom.name.textContent = current.name;
    dom.rename.hidden = !inLibrary;
    dom.rename.value = current.name;
    dom.saveButton.hidden = !inLibrary;
    dom.keepButton.hidden = inLibrary;
}
function saveToLibrary() {
    if (!current?.id)
        return;
    const markdown = markdownNow();
    // Keeps the app's own copy in step with the edits, so reopening this
    // document from the library later shows what was just written rather than
    // whatever was here before. That storage has no visible home outside the
    // app, so it is never what "Save" should mean on its own — the button
    // below is what actually puts a file somewhere the user chose.
    onSave?.({ id: current.id, name: current.name, markdown });
    current.markdown = markdown;
    markEditorSaved();
    updateMeta();
    onDownload?.({ name: current.name, markdown });
}
function keepInLibrary() {
    if (!current || current.id)
        return;
    const added = onKeep?.({ name: current.name, markdown: markdownNow() });
    if (!added)
        return;
    current = { id: added.id, name: added.name, markdown: markdownNow() };
    showName();
    markEditorSaved();
    updateMeta();
    onToast?.(`Kept as ${added.name} in your documents.`);
}
function applyRename() {
    if (!dom || !current?.id)
        return;
    const wanted = dom.rename.value.trim();
    if (!wanted || wanted === current.name) {
        dom.rename.value = current.name;
        return;
    }
    const finalName = onRename?.(current.id, wanted);
    if (!finalName) {
        dom.rename.value = current.name;
        return;
    }
    current.name = finalName;
    dom.rename.value = finalName;
    if (finalName !== wanted)
        onToast?.(`A document was already called that, so this one is ${finalName}.`);
}
/* ------------------------------------------------------------------- mode */
/** The text as it stands: what is being edited if editing, else the original. */
function markdownNow() {
    return mode === 'edit' ? editorMarkdown() : current?.markdown ?? '';
}
function setMode(next, options = {}) {
    if (!dom)
        return;
    mode = next;
    const editing = next === 'edit';
    dom.editor.hidden = !editing;
    dom.toolbar.hidden = !editing;
    dom.doc.hidden = editing;
    // Editing owns the height: the panes scroll inside themselves so the toolbar
    // and the save line stay put. Reading lets the whole document scroll.
    dom.root.classList.toggle('reader--editing', editing);
    // The contents list navigates the rendered document, which is not on screen
    // while editing.
    dom.contentsButton.hidden = editing || dom.toc.childElementCount === 0;
    if (editing)
        dom.toc.hidden = true;
    dom.readButton.setAttribute('aria-pressed', String(!editing));
    dom.editButton.setAttribute('aria-pressed', String(editing));
    if (editing) {
        focusEditor({ selectTitle: options.fresh });
    }
    else if (current) {
        // Coming back from editing shows what was just written, not what was
        // opened — otherwise Read would look like the edits had been lost.
        const markdown = editorMarkdown();
        dom.doc.replaceChildren(renderMarkdown(markdown));
        buildContents();
    }
    updateMeta();
}
function updateMeta() {
    if (!dom)
        return;
    const suffix = editorIsDirty() ? ' · unsaved' : '';
    dom.meta.textContent = describe(markdownNow()) + suffix;
}
/* ---------------------------------------------------------------- contents */
function buildContents() {
    if (!dom)
        return;
    const headings = [...dom.doc.querySelectorAll('h1, h2, h3')];
    dom.toc.replaceChildren();
    // One heading is a title, not a structure worth navigating.
    if (headings.length < 2) {
        dom.toc.hidden = true;
        dom.contentsButton.hidden = true;
        dom.contentsButton.setAttribute('aria-expanded', 'false');
        return;
    }
    dom.contentsButton.hidden = false;
    const list = document.createElement('ol');
    for (const [index, heading] of headings.entries()) {
        heading.id = heading.id || `section-${index + 1}`;
        const item = document.createElement('li');
        item.dataset.level = heading.tagName.toLowerCase();
        const link = document.createElement('a');
        link.href = `#${heading.id}`;
        link.textContent = heading.textContent ?? '';
        link.addEventListener('click', (event) => {
            event.preventDefault();
            heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // On a phone the contents list covers the page it is navigating to.
            if (window.matchMedia('(max-width: 720px)').matches) {
                dom.toc.hidden = true;
                dom.contentsButton.setAttribute('aria-expanded', 'false');
            }
        });
        item.append(link);
        list.append(item);
    }
    dom.toc.append(list);
    // Wide screens have room for the contents beside the text; phones do not.
    dom.toc.hidden = !window.matchMedia('(min-width: 1000px)').matches;
    dom.contentsButton.setAttribute('aria-expanded', String(!dom.toc.hidden));
}
/* -------------------------------------------------------------- text size */
function stepSize(direction) {
    sizeIndex = Math.min(SIZES.length - 1, Math.max(0, sizeIndex + direction));
    applySize();
    try {
        localStorage.setItem(SIZE_KEY, String(sizeIndex));
    }
    catch {
        // Private browsing refuses storage; the size stays for this session only.
    }
}
function applySize() {
    dom?.root.style.setProperty('--reader-scale', String(SIZES[sizeIndex]));
}
function loadSize() {
    const fallback = SIZES.indexOf(DEFAULT_SIZE);
    // `Number(null)` is 0, which is a valid index — so an unset key has to be
    // ruled out before the range check, or the reader opens a step too small.
    const raw = localStorage.getItem(SIZE_KEY);
    if (raw === null)
        return fallback;
    const stored = Number(raw);
    return Number.isInteger(stored) && stored >= 0 && stored < SIZES.length ? stored : fallback;
}
/* ------------------------------------------------------------------ misc */
function describe(markdown) {
    const words = markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[#*_>`|-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean).length;
    // 200 wpm is the usual figure for reading prose on a screen.
    const minutes = Math.max(1, Math.round(words / 200));
    return `${words.toLocaleString()} words · about ${minutes} min`;
}
function required(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing element #${id}`);
    return element;
}
//# sourceMappingURL=reader.js.map