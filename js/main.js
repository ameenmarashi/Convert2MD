/** App shell: file intake, conversion queue, results UI, install and offline. */
import { DEFAULT_OPTIONS } from './core/types.js';
import { SUPPORTED_EXTENSIONS } from './core/convert.js';
import { writeZip } from './core/zip.js';
import { renderMarkdown } from './ui/markdown-preview.js';
const APP_VERSION = '1.0.0';
const SETTINGS_KEY = 'md-converter.settings';
const THEME_KEY = 'md-converter.theme';
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const entries = new Map();
let options = loadOptions();
let worker = null;
let inlineConvert = null;
let installPrompt = null;
let sequence = 0;
const dom = {
    dropzone: byId('dropzone'),
    fileInput: byId('file-input'),
    chooseButton: byId('choose-button'),
    pasteButton: byId('paste-button'),
    resultsSection: byId('results-section'),
    resultsList: byId('results-list'),
    resultsTitle: byId('results-title'),
    downloadAll: byId('download-all'),
    clearAll: byId('clear-all'),
    template: byId('result-template'),
    toast: byId('toast'),
    themeButton: byId('theme-button'),
    themeIcon: byId('theme-icon'),
    installButton: byId('install-button'),
    offlineBadge: byId('offline-badge'),
    versionLabel: byId('version-label'),
};
function byId(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing element #${id}`);
    return element;
}
/* ------------------------------------------------------------------ startup */
function init() {
    dom.fileInput.accept = SUPPORTED_EXTENSIONS.join(',');
    dom.versionLabel.textContent = `v${APP_VERSION}`;
    applyTheme(localStorage.getItem(THEME_KEY) ?? 'system');
    bindSettings();
    bindIntake();
    bindGlobalActions();
    registerServiceWorker();
    watchConnectivity();
    handleLaunchFiles();
    void collectSharedFiles();
}
function bindIntake() {
    dom.chooseButton.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', () => {
        if (dom.fileInput.files)
            void addFiles([...dom.fileInput.files]);
        dom.fileInput.value = '';
    });
    for (const type of ['dragenter', 'dragover']) {
        document.addEventListener(type, (event) => {
            event.preventDefault();
            dom.dropzone.classList.add('is-dragover');
        });
    }
    for (const type of ['dragleave', 'drop']) {
        document.addEventListener(type, (event) => {
            if (type === 'dragleave' && event.relatedTarget)
                return;
            dom.dropzone.classList.remove('is-dragover');
        });
    }
    document.addEventListener('drop', (event) => {
        event.preventDefault();
        const files = event.dataTransfer?.files;
        if (files && files.length > 0)
            void addFiles([...files]);
    });
    dom.pasteButton.addEventListener('click', () => void pasteFromClipboard());
    document.addEventListener('paste', (event) => {
        const files = event.clipboardData?.files;
        if (files && files.length > 0) {
            event.preventDefault();
            void addFiles([...files]);
            return;
        }
        const text = event.clipboardData?.getData('text/plain');
        if (text && text.trim().length > 40 && document.activeElement === document.body) {
            event.preventDefault();
            void addFiles([textAsFile(text)]);
        }
    });
}
function bindGlobalActions() {
    dom.downloadAll.addEventListener('click', downloadAllAsZip);
    dom.clearAll.addEventListener('click', () => {
        entries.clear();
        dom.resultsList.replaceChildren();
        updateResultsVisibility();
    });
    dom.themeButton.addEventListener('click', () => {
        const current = localStorage.getItem(THEME_KEY) ?? 'system';
        const next = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
        localStorage.setItem(THEME_KEY, next);
        applyTheme(next);
    });
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        installPrompt = event;
        dom.installButton.hidden = false;
    });
    dom.installButton.addEventListener('click', async () => {
        if (!installPrompt)
            return;
        await installPrompt.prompt();
        installPrompt = null;
        dom.installButton.hidden = true;
    });
    window.addEventListener('appinstalled', () => {
        dom.installButton.hidden = true;
        toast('Installed. It now works offline.');
    });
}
function bindSettings() {
    const bindSwitch = (id, key) => {
        const input = byId(id);
        input.checked = Boolean(options[key]);
        input.addEventListener('change', () => {
            options[key] = input.checked;
            saveOptions();
        });
    };
    bindSwitch('opt-frontmatter', 'frontMatter');
    bindSwitch('opt-separators', 'pageSeparators');
    bindSwitch('opt-notes', 'includeNotes');
    bindSwitch('opt-headings', 'detectPdfHeadings');
    bindSwitch('opt-linebreaks', 'preserveLineBreaks');
    const images = byId('opt-images');
    images.value = options.imageMode;
    images.addEventListener('change', () => {
        options.imageMode = images.value;
        saveOptions();
    });
    const bullet = byId('opt-bullet');
    bullet.value = options.bullet;
    bullet.addEventListener('change', () => {
        options.bullet = bullet.value;
        saveOptions();
    });
    const limit = byId('opt-imagelimit');
    limit.value = String(options.maxEmbeddedImageBytes);
    limit.addEventListener('change', () => {
        options.maxEmbeddedImageBytes = Number(limit.value);
        saveOptions();
    });
}
function loadOptions() {
    try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        if (!stored)
            return { ...DEFAULT_OPTIONS };
        return { ...DEFAULT_OPTIONS, ...JSON.parse(stored) };
    }
    catch {
        return { ...DEFAULT_OPTIONS };
    }
}
function saveOptions() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(options));
    }
    catch {
        // Private browsing can refuse storage; settings simply stay session-only.
    }
}
function applyTheme(theme) {
    if (theme === 'system')
        document.documentElement.removeAttribute('data-theme');
    else
        document.documentElement.setAttribute('data-theme', theme);
    dom.themeIcon.textContent = theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐';
    dom.themeButton.title = `Colour theme: ${theme}`;
}
/* ------------------------------------------------------------- conversion */
async function addFiles(files) {
    const accepted = files.filter((file) => {
        if (file.size > MAX_FILE_BYTES) {
            addEntry(file.name, `The file is ${formatBytes(file.size)}, larger than this app will load in one go.`);
            return false;
        }
        return true;
    });
    if (accepted.length === 0)
        return;
    dom.dropzone.classList.add('is-busy');
    for (const file of accepted) {
        await convertOne(file);
    }
    dom.dropzone.classList.remove('is-busy');
}
async function convertOne(file) {
    const id = `f${++sequence}`;
    const entry = { id, name: file.name, status: 'pending' };
    entries.set(id, entry);
    renderEntry(entry);
    updateResultsVisibility();
    try {
        const buffer = await file.arrayBuffer();
        const result = await runConversion({
            id,
            name: file.name || 'document',
            mime: file.type,
            lastModified: file.lastModified,
            buffer,
            options,
        });
        entry.status = 'done';
        entry.result = result;
    }
    catch (err) {
        entry.status = 'error';
        entry.error = err instanceof Error ? err.message : String(err);
    }
    renderEntry(entry);
    updateResultsVisibility();
}
function runConversion(request) {
    const activeWorker = ensureWorker();
    if (!activeWorker)
        return runInline(request);
    return new Promise((resolve, reject) => {
        const onMessage = (event) => {
            const data = event.data;
            if (data.id !== request.id)
                return;
            activeWorker.removeEventListener('message', onMessage);
            if (data.type === 'result')
                resolve(data.result);
            else
                reject(new Error(data.message));
        };
        activeWorker.addEventListener('message', onMessage);
        activeWorker.postMessage(request, [request.buffer]);
    });
}
function ensureWorker() {
    if (worker)
        return worker;
    try {
        worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        worker.addEventListener('error', () => {
            worker?.terminate();
            worker = null;
        });
        return worker;
    }
    catch {
        return null;
    }
}
/** Fallback for browsers without module workers: convert on the main thread. */
async function runInline(request) {
    if (!inlineConvert) {
        const module = await import('./core/convert.js');
        inlineConvert = module.convertFile;
    }
    return inlineConvert({
        name: request.name,
        bytes: new Uint8Array(request.buffer),
        mime: request.mime,
        lastModified: request.lastModified,
    }, request.options);
}
function addEntry(name, error) {
    const id = `f${++sequence}`;
    const entry = { id, name, status: 'error', error };
    entries.set(id, entry);
    renderEntry(entry);
    updateResultsVisibility();
}
/* ----------------------------------------------------------------- results */
function renderEntry(entry) {
    const fragment = dom.template.content.cloneNode(true);
    const card = fragment.querySelector('.card');
    const name = card.querySelector('.card__name');
    const meta = card.querySelector('.card__meta');
    const warnings = card.querySelector('.card__warnings');
    const preview = card.querySelector('.card__panel--preview');
    const source = card.querySelector('.card__panel--source code');
    const tabs = [...card.querySelectorAll('.tab')];
    name.textContent = entry.result?.outputName ?? entry.name;
    if (entry.status === 'pending') {
        meta.textContent = 'Converting…';
        card.querySelector('.card__actions')?.setAttribute('hidden', '');
        card.querySelector('.card__tabs')?.setAttribute('hidden', '');
        preview.hidden = true;
    }
    else if (entry.status === 'error') {
        card.classList.add('card--error');
        meta.textContent = entry.name;
        card.querySelector('.card__actions')?.setAttribute('hidden', '');
        card.querySelector('.card__tabs')?.setAttribute('hidden', '');
        preview.hidden = true;
        const error = document.createElement('p');
        error.className = 'card__error';
        error.textContent = entry.error ?? 'Conversion failed.';
        card.querySelector('.card__head')?.after(error);
    }
    else if (entry.result) {
        const result = entry.result;
        meta.textContent = [
            result.format,
            `${result.wordCount.toLocaleString()} words`,
            result.imageCount > 0 ? `${result.imageCount} image${result.imageCount === 1 ? '' : 's'}` : '',
            `${(result.markdown.length / 1024).toFixed(1)} KB`,
            `${result.durationMs} ms`,
        ]
            .filter(Boolean)
            .join(' · ');
        if (result.warnings.length > 0) {
            warnings.hidden = false;
            const list = document.createElement('ul');
            for (const warning of result.warnings.slice(0, 6)) {
                const item = document.createElement('li');
                item.textContent = warning;
                list.append(item);
            }
            warnings.append(list);
        }
        preview.append(renderMarkdown(result.markdown));
        source.textContent = result.markdown;
        card.querySelector('[data-action="copy"]')?.addEventListener('click', () => void copyMarkdown(result));
        card.querySelector('[data-action="download"]')?.addEventListener('click', () => downloadMarkdown(result));
    }
    card.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
        entries.delete(entry.id);
        entry.element?.remove();
        updateResultsVisibility();
    });
    for (const tab of tabs) {
        tab.addEventListener('click', () => {
            for (const other of tabs)
                other.setAttribute('aria-selected', String(other === tab));
            const showSource = tab.dataset.tab === 'source';
            card.querySelector('.card__panel--preview').hidden = showSource;
            card.querySelector('.card__panel--source').hidden = !showSource;
        });
    }
    if (entry.element) {
        entry.element.replaceWith(card);
    }
    else {
        dom.resultsList.append(card);
    }
    entry.element = card;
}
function updateResultsVisibility() {
    const count = entries.size;
    dom.resultsSection.hidden = count === 0;
    const done = [...entries.values()].filter((e) => e.status === 'done').length;
    dom.resultsTitle.textContent = count === 1 ? 'Converted file' : `Converted files (${done}/${count})`;
    dom.downloadAll.disabled = done === 0;
}
async function copyMarkdown(result) {
    try {
        await navigator.clipboard.writeText(result.markdown);
        toast('Markdown copied');
    }
    catch {
        const area = document.createElement('textarea');
        area.value = result.markdown;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        toast(ok ? 'Markdown copied' : 'Copying was blocked — use Download instead');
    }
}
function downloadMarkdown(result) {
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
    saveBlob(blob, result.outputName);
}
function downloadAllAsZip() {
    const done = [...entries.values()].filter((entry) => entry.result);
    if (done.length === 0)
        return;
    if (done.length === 1 && done[0].result) {
        downloadMarkdown(done[0].result);
        return;
    }
    const encoder = new TextEncoder();
    const used = new Set();
    const files = done.map((entry) => {
        const result = entry.result;
        let name = result.outputName;
        let counter = 2;
        while (used.has(name)) {
            name = result.outputName.replace(/\.md$/, `-${counter++}.md`);
        }
        used.add(name);
        return { name, data: encoder.encode(result.markdown) };
    });
    const archive = writeZip(files);
    saveBlob(new Blob([archive.buffer], { type: 'application/zip' }), 'markdown-export.zip');
}
function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
let toastTimer = 0;
function toast(message) {
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    requestAnimationFrame(() => dom.toast.classList.add('is-visible'));
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        dom.toast.classList.remove('is-visible');
        window.setTimeout(() => {
            dom.toast.hidden = true;
        }, 220);
    }, 2600);
}
/* ---------------------------------------------------------------- intake+ */
async function pasteFromClipboard() {
    try {
        if (navigator.clipboard && 'read' in navigator.clipboard) {
            const items = await navigator.clipboard.read();
            const files = [];
            for (const item of items) {
                for (const type of item.types) {
                    if (type === 'text/plain' || type.startsWith('image/') || type === 'text/html') {
                        const blob = await item.getType(type);
                        files.push(new File([blob], fileNameForType(type), { type }));
                    }
                }
            }
            if (files.length > 0) {
                await addFiles(files);
                return;
            }
        }
        const text = await navigator.clipboard.readText();
        if (text.trim())
            await addFiles([textAsFile(text)]);
        else
            toast('The clipboard is empty');
    }
    catch {
        toast('Clipboard access was refused — paste with ⌘V / Ctrl+V instead');
    }
}
function fileNameForType(type) {
    if (type === 'text/html')
        return 'clipboard.html';
    if (type.startsWith('image/'))
        return `clipboard.${type.split('/')[1].split('+')[0]}`;
    return 'clipboard.txt';
}
function textAsFile(text) {
    return new File([text], 'clipboard.txt', { type: 'text/plain' });
}
function handleLaunchFiles() {
    const queue = window.launchQueue;
    if (!queue)
        return;
    queue.setConsumer((params) => {
        void (async () => {
            const files = [];
            for (const handle of params.files ?? [])
                files.push(await handle.getFile());
            if (files.length > 0)
                await addFiles(files);
        })();
    });
}
/** Files sent through the Web Share Target are parked in a cache by the SW. */
async function collectSharedFiles() {
    const url = new URL(window.location.href);
    if (url.searchParams.get('share-target') !== '1')
        return;
    url.searchParams.delete('share-target');
    window.history.replaceState(null, '', url.toString());
    if (!('caches' in window))
        return;
    try {
        const cache = await caches.open('md-converter-share');
        const requests = await cache.keys();
        const files = [];
        for (const request of requests) {
            const response = await cache.match(request);
            if (!response)
                continue;
            const blob = await response.blob();
            const name = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? 'shared');
            files.push(new File([blob], name, { type: blob.type }));
            await cache.delete(request);
        }
        if (files.length > 0)
            await addFiles(files);
    }
    catch {
        // Nothing shared, or the cache was cleared between the share and the load.
    }
}
/* ------------------------------------------------------- offline plumbing */
function registerServiceWorker() {
    if (!('serviceWorker' in navigator))
        return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {
            // Registration fails on file:// and in some private modes; the app still runs.
        });
    });
}
function watchConnectivity() {
    const update = () => {
        const offline = !navigator.onLine;
        dom.offlineBadge.textContent = offline ? 'Offline — still working' : 'Offline ready';
        dom.offlineBadge.classList.toggle('badge--offline', offline);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
init();
//# sourceMappingURL=main.js.map