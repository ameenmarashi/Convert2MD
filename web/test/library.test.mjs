/**
 * The document library: naming, uniqueness and the round trip through storage.
 *
 * `localStorage` is not a thing in Node, so the suite installs the smallest
 * stand-in that behaves like one — which is also a fair test of the module's
 * only assumption about it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  #map = new Map();
  get length() {
    return this.#map.size;
  }
  key(index) {
    return [...this.#map.keys()][index] ?? null;
  }
  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }
  setItem(key, value) {
    this.#map.set(key, String(value));
  }
  removeItem(key) {
    this.#map.delete(key);
  }
  clear() {
    this.#map.clear();
  }
}

globalThis.localStorage = new MemoryStorage();

const {
  createDocument,
  deleteDocument,
  importDocument,
  listDocuments,
  normaliseName,
  readDocument,
  renameDocument,
  saveDocument,
} = await import('../public/js/core/library.js');

test('a name keeps the words people actually write', () => {
  assert.equal(normaliseName('My notes'), 'My notes.md');
  assert.equal(normaliseName('Q3 plan - draft'), 'Q3 plan - draft.md');
  assert.equal(normaliseName('  padded  '), 'padded.md');
});

test('a name loses only what a file system would refuse', () => {
  assert.equal(normaliseName('a/b:c*d'), 'abcd.md');
  assert.equal(normaliseName('what?'), 'what.md');
});

test('an existing extension is left alone, and an empty name gets one', () => {
  assert.equal(normaliseName('notes.md'), 'notes.md');
  assert.equal(normaliseName('notes.markdown'), 'notes.markdown');
  assert.equal(normaliseName('   '), 'Untitled.md');
});

test('a new document opens with its own title already written', () => {
  localStorage.clear();
  const created = createDocument('Retina clinic');
  assert.equal(created.name, 'Retina clinic.md');
  assert.equal(created.markdown, '# Retina clinic\n\n');
  assert.equal(readDocument(created.id)?.markdown, '# Retina clinic\n\n');
});

test('two documents never wear the same name', () => {
  localStorage.clear();
  assert.equal(createDocument('Notes').name, 'Notes.md');
  assert.equal(createDocument('Notes').name, 'Notes 2.md');
  assert.equal(createDocument('Notes').name, 'Notes 3.md');
});

test('saving updates the text and the timestamp, and listing is newest first', async () => {
  localStorage.clear();
  const first = createDocument('First');
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = createDocument('Second');

  assert.deepEqual(listDocuments().map((d) => d.name), ['Second.md', 'First.md']);

  await new Promise((resolve) => setTimeout(resolve, 2));
  saveDocument(first.id, first.name, '# First\n\nsome words here');
  assert.deepEqual(listDocuments().map((d) => d.name), ['First.md', 'Second.md']);
  assert.equal(readDocument(first.id)?.words, 4);
  assert.equal(second.id in {}, false);
});

test('renaming keeps the text and still avoids a collision', () => {
  localStorage.clear();
  createDocument('Taken');
  const document = createDocument('Other');
  saveDocument(document.id, document.name, 'body');

  assert.equal(renameDocument(document.id, 'Taken'), 'Taken 2.md');
  assert.equal(readDocument(document.id)?.markdown, 'body');
  assert.equal(renameDocument('missing-id', 'x'), null);
});

test('an imported file keeps its own name', () => {
  localStorage.clear();
  const imported = importDocument('from-chatgpt.md', '# Answer\n\ntext');
  assert.equal(imported.name, 'from-chatgpt.md');
  assert.equal(listDocuments().length, 1);
});

test('deleting removes it from the listing', () => {
  localStorage.clear();
  const document = createDocument('Temporary');
  deleteDocument(document.id);
  assert.equal(listDocuments().length, 0);
  assert.equal(readDocument(document.id), null);
});

test('a corrupt entry is skipped rather than breaking the listing', () => {
  localStorage.clear();
  createDocument('Good');
  localStorage.setItem('md-converter.doc.broken', 'not json');
  localStorage.setItem('md-converter.doc.partial', JSON.stringify({ name: 'x' }));
  assert.deepEqual(listDocuments().map((d) => d.name), ['Good.md']);
});
