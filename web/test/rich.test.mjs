/**
 * The round trip behind the formatted editing view.
 *
 * What the user edits is a rendered document; what gets saved is Markdown. This
 * covers the way back, against the HTML that browsers actually leave behind
 * when someone types into a `contenteditable` — Chrome's `<div>` per line,
 * Safari's `<b>`/`<i>`, the non-breaking spaces all of them insert.
 *
 * There is no DOM here, which is the point: the string half is kept separate
 * from the clone-and-tidy half so it can be checked without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { editableHtmlToMarkdown as toMarkdown } from '../public/js/ui/rich.js';
import { splitFrontMatter } from '../public/js/ui/editor.js';

test('typed text keeps its emphasis', () => {
  assert.equal(toMarkdown('<p>Hello <b>world</b> and <i>more</i></p>'), 'Hello **world** and *more*\n');
  assert.equal(toMarkdown('<p><strong>bold</strong> <em>italic</em> <del>gone</del></p>'), '**bold** *italic* ~~gone~~\n');
});

// Chrome and Safari wrap each new line in a <div> rather than a <p>.
test('a div per line becomes a paragraph per line', () => {
  assert.equal(toMarkdown('<div>one</div><div>two</div>'), 'one\n\ntwo\n');
});

test('headings, lists and nesting survive', () => {
  assert.equal(
    toMarkdown('<h2>Title</h2><p>text</p><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>'),
    '## Title\n\ntext\n\n- a\n- b\n  - c\n'
  );
  assert.equal(toMarkdown('<ol><li>first</li><li>second</li></ol>'), '1. first\n2. second\n');
});

// The tick is a property in the browser and an attribute in the markup, so the
// editor copies it across before serialising. This is the half that reads it.
test('a ticked task comes back ticked', () => {
  assert.equal(
    toMarkdown('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>'),
    '- [x] done\n- [ ] todo\n'
  );
});

test('quotes, dividers and tables survive', () => {
  assert.equal(toMarkdown('<blockquote><div>quoted</div></blockquote><hr><p>after</p>'), '> quoted\n\n---\n\nafter\n');
  assert.equal(
    toMarkdown('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'),
    '| A   | B   |\n| --- | --- |\n| 1   | 2   |\n'
  );
});

test('a photo stays inside the document', () => {
  assert.equal(
    toMarkdown('<p><img src="data:image/png;base64,AAA" alt="a photo"></p>'),
    '![a photo](data:image/png;base64,AAA)\n'
  );
});

// Every browser pads with U+00A0 to keep runs of spaces alive on screen. In a
// text file they are invisible trouble, so they come out as ordinary spaces.
test('non-breaking spaces become ordinary ones', () => {
  const markdown = toMarkdown('<p>two  spaces</p>');
  assert.equal(markdown.includes(' '), false);
  assert.match(markdown, /two\s+spaces/);
});

test('an empty document is empty, not a stray paragraph', () => {
  assert.equal(toMarkdown('<p><br></p>').trim(), '');
});

test('front matter is separated so editing cannot rewrite it', () => {
  const source = '---\ntitle: Notes\n---\n\n# Heading\n\nbody\n';
  const { front, body } = splitFrontMatter(source);
  assert.equal(front, '---\ntitle: Notes\n---\n');
  assert.equal(body, '# Heading\n\nbody\n');

  // A document that merely starts with a divider is not front matter.
  assert.equal(splitFrontMatter('---\n\ntext').front, '');
  assert.equal(splitFrontMatter('# Heading').front, '');
});
