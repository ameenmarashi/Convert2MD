/**
 * The documents this app holds on the device.
 *
 * iOS and iPadOS give a web app no way to browse a folder — there is no
 * directory picker, and the File System Access API is not implemented — so a
 * document written here would otherwise have nowhere to live between visits.
 * The library is that place: documents you start from scratch, or open and
 * decide to keep, stay listed until you delete them.
 *
 * Storage is `localStorage`, one key per document so a single oversized file
 * cannot make the rest unreadable, and the listing is derived by scanning those
 * keys rather than kept in a separate index that could drift out of step.
 */

const PREFIX = 'md-converter.doc.';

export interface DocumentMeta {
  id: string;
  name: string;
  updated: number;
  words: number;
}

export interface LibraryDocument extends DocumentMeta {
  markdown: string;
}

interface StoredDocument {
  name: string;
  markdown: string;
  updated: number;
}

/** Newest first — the one you were last working on is the one you want. */
export function listDocuments(): DocumentMeta[] {
  const documents: DocumentMeta[] = [];

  for (const key of storageKeys()) {
    const stored = read(key);
    if (!stored) continue;
    documents.push({
      id: key.slice(PREFIX.length),
      name: stored.name,
      updated: stored.updated,
      words: countWords(stored.markdown),
    });
  }
  return documents.sort((a, b) => b.updated - a.updated);
}

export function readDocument(id: string): LibraryDocument | null {
  const stored = read(PREFIX + id);
  if (!stored) return null;
  return {
    id,
    name: stored.name,
    markdown: stored.markdown,
    updated: stored.updated,
    words: countWords(stored.markdown),
  };
}

/**
 * A new document opens with its own title already written, so the first thing
 * a beginner sees in the preview is a heading appearing from `# `.
 */
export function createDocument(name?: string): LibraryDocument {
  const finalName = ensureUniqueName(name ?? 'Untitled');
  const title = finalName.replace(/\.md$/i, '');
  const document: LibraryDocument = {
    id: newId(),
    name: finalName,
    markdown: `# ${title}\n\n`,
    updated: Date.now(),
    words: 0,
  };
  write(document.id, { name: document.name, markdown: document.markdown, updated: document.updated });
  return document;
}

/** Adds an opened file to the library, keeping its name. */
export function importDocument(name: string, markdown: string): LibraryDocument {
  const finalName = ensureUniqueName(name);
  const id = newId();
  const updated = Date.now();
  write(id, { name: finalName, markdown, updated });
  return { id, name: finalName, markdown, updated, words: countWords(markdown) };
}

export function saveDocument(id: string, name: string, markdown: string): void {
  write(id, { name, markdown, updated: Date.now() });
}

export function renameDocument(id: string, name: string): string | null {
  const stored = read(PREFIX + id);
  if (!stored) return null;
  const finalName = ensureUniqueName(name, id);
  write(id, { ...stored, name: finalName, updated: Date.now() });
  return finalName;
}

export function deleteDocument(id: string): void {
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    // Nothing to remove, or storage is unavailable.
  }
}

/* ------------------------------------------------------------------ names */

/** `.md` on the end, and never two documents wearing the same name. */
export function normaliseName(name: string): string {
  // Only the characters a file system would refuse — spaces and hyphens are
  // most of what people actually name things with.
  const trimmed =
    name.trim().replace(/[/\\<>:"|?*\u0000-\u001f]/g, '').trim().slice(0, 120) || 'Untitled';
  return /\.(md|markdown|mdown|mkd|mdx)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

function ensureUniqueName(name: string, exceptId?: string): string {
  const wanted = normaliseName(name);
  const taken = new Set(
    listDocuments()
      .filter((document) => document.id !== exceptId)
      .map((document) => document.name.toLowerCase())
  );
  if (!taken.has(wanted.toLowerCase())) return wanted;

  const stem = wanted.replace(/\.md$/i, '');
  for (let counter = 2; counter < 1000; counter++) {
    const candidate = `${stem} ${counter}.md`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} ${Date.now()}.md`;
}

/* ---------------------------------------------------------------- storage */

function storageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
  } catch {
    // Private browsing can refuse storage entirely.
  }
  return keys;
}

function read(key: string): StoredDocument | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDocument>;
    if (typeof parsed.markdown !== 'string') return null;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : 'Untitled.md',
      markdown: parsed.markdown,
      updated: typeof parsed.updated === 'number' ? parsed.updated : 0,
    };
  } catch {
    return null;
  }
}

function write(id: string, document: StoredDocument): void {
  try {
    localStorage.setItem(PREFIX + id, JSON.stringify(document));
  } catch (error) {
    // Out of room, or storage refused. The caller reports it; the document is
    // still on screen, so nothing is lost until the tab closes.
    throw new Error(
      error instanceof Error && /quota/i.test(error.message)
        ? 'There is no room left on this device for this document. Pictures take up most of the space — ' +
          'download this one to keep it, or delete a document you no longer need.'
        : 'This browser would not let the app store the document.'
    );
  }
}

function newId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function countWords(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`|-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}
