import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToBlocks, blocksToMarkdown, inlineToHtml, normalizeBlocks, markdownToHtml } from '../src/shared/markdown.js';

const strip = blocks => blocks.map(({ id: _id, ...b }) => b);

test('markdown round-trips through blocks', () => {
  const md = [
    '# Title', '', 'Intro paragraph', 'second line', '', '## Section', '', '- one', '- two', '',
    '1. first', '2. second', '', '- [ ] open', '- [x] done', '', '> quoted', '', '> [!NOTE]', '> heads up', '',
    '```js', 'const x = 1;', '```', '', '---', '', '### Small',
  ].join('\n') + '\n';
  const blocks = markdownToBlocks(md);
  assert.deepEqual(strip(blocks).map(b => b.type), ['h1', 'paragraph', 'h2', 'bullet', 'bullet', 'numbered', 'numbered', 'todo', 'todo', 'quote', 'callout', 'code', 'divider', 'h3']);
  assert.equal(blocks[1].text, 'Intro paragraph\nsecond line');
  assert.equal(blocks[8].checked, true);
  assert.equal(blocks[11].lang, 'js');
  assert.deepEqual(strip(markdownToBlocks(blocksToMarkdown(blocks))), strip(blocks));
});

test('inline rendering escapes HTML and only links safe URLs', () => {
  assert.equal(inlineToHtml('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(inlineToHtml('**bold** and `a<b`'), '<strong>bold</strong> and <code>a&lt;b</code>');
  assert.match(inlineToHtml('[ok](https://example.com)'), /<a href="https:\/\/example.com"/);
  assert.doesNotMatch(inlineToHtml('[bad](javascript:alert(1))'), /<a /);
  assert.doesNotMatch(markdownToHtml('"><img src=x onerror=alert(1)>'), /<img/);
});

test('normalizeBlocks rejects malformed input and assigns ids', () => {
  assert.throws(() => normalizeBlocks('nope'), /array/);
  assert.throws(() => normalizeBlocks([{ type: 'script' }]), /unknown type/);
  assert.throws(() => normalizeBlocks([{ type: 'paragraph', text: 5 }]), /text must be a string/);
  const [b] = normalizeBlocks([{ type: 'todo', text: 'x', id: '<bad id>' }]);
  assert.match(b.id, /^blk_/);
  assert.equal(b.checked, false);
});
