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
const SIZE_KEY = 'md-converter.reader-size';
const SIZES = [0.9, 1, 1.15, 1.3, 1.5];
const DEFAULT_SIZE = 1;
let dom = null;
let current = null;
let sizeIndex = SIZES.indexOf(DEFAULT_SIZE);
let onCopy = null;
let onDownload = null;
/** Wires the reader chrome once, at startup. */
export function initReader(handlers) {
    onCopy = handlers.copy;
    onDownload = handlers.download;
    dom = {
        root: required('reader'),
        name: required('reader-name'),
        meta: required('reader-meta'),
        doc: required('reader-doc'),
        toc: required('reader-toc'),
        source: required('reader-source-panel'),
        sourceCode: required('reader-source-code'),
        contentsButton: required('reader-contents'),
        sourceButton: required('reader-source'),
    };
    sizeIndex = loadSize();
    applySize();
    required('reader-close').addEventListener('click', () => closeReader());
    required('reader-larger').addEventListener('click', () => stepSize(1));
    required('reader-smaller').addEventListener('click', () => stepSize(-1));
    required('reader-print').addEventListener('click', () => window.print());
    required('reader-copy').addEventListener('click', () => {
        if (current)
            onCopy?.(current.markdown);
    });
    required('reader-download').addEventListener('click', () => {
        if (current)
            onDownload?.(current);
    });
    dom.contentsButton.addEventListener('click', () => {
        const showing = !dom.toc.hidden;
        dom.toc.hidden = showing;
        dom.contentsButton.setAttribute('aria-expanded', String(!showing));
    });
    dom.sourceButton.addEventListener('click', () => {
        const showingSource = dom.source.hidden;
        dom.source.hidden = !showingSource;
        dom.doc.hidden = showingSource;
        dom.sourceButton.setAttribute('aria-pressed', String(showingSource));
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
export function openReader(document_) {
    if (!dom)
        return;
    current = document_;
    dom.name.textContent = document_.name;
    dom.meta.textContent = describe(document_.markdown);
    dom.doc.replaceChildren(renderMarkdown(document_.markdown));
    dom.sourceCode.textContent = document_.markdown;
    dom.source.hidden = true;
    dom.doc.hidden = false;
    dom.sourceButton.setAttribute('aria-pressed', 'false');
    buildContents();
    dom.root.hidden = false;
    document.body.classList.add('is-reading');
    dom.root.scrollTop = 0;
    dom.doc.focus({ preventScroll: true });
    if (window.history.state?.reader !== true) {
        window.history.pushState({ reader: true }, '');
    }
}
export function closeReader(options = {}) {
    if (!dom || dom.root.hidden)
        return;
    dom.root.hidden = true;
    dom.doc.replaceChildren();
    dom.sourceCode.textContent = '';
    current = null;
    document.body.classList.remove('is-reading');
    if (!options.fromHistory && window.history.state?.reader === true) {
        window.history.back();
    }
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