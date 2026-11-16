// @ts-check
/**
 * Block model shared by the server and the browser UI.
 *
 * A page body is an ordered array of blocks. Agents read and write pages as
 * Markdown; the UI edits blocks. This module converts between the two and
 * renders a safe HTML subset for display. It has no Node or DOM imports so the
 * server can serve it to the browser unchanged at `/shared/markdown.js`.
 *
 * @typedef {'paragraph'|'h1'|'h2'|'h3'|'bullet'|'numbered'|'todo'|'quote'|'callout'|'code'|'divider'} BlockType
 * @typedef {{ id: string, type: BlockType, text: string, checked?: boolean, lang?: string }} Block
 */

/** Every block type the editor and renderer understand. */
export const BLOCK_TYPES = /** @type {const} */ ([
  'paragraph', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'quote', 'callout', 'code', 'divider',
]);

const BLOCK_TYPE_SET = new Set(BLOCK_TYPES);

/**
 * Returns a random id with a type prefix. Uses `crypto.getRandomValues`, which
 * browsers expose on insecure (plain-HTTP LAN) origins where `randomUUID` is absent.
 * @param {string} prefix
 * @returns {string}
 */
export function newId(prefix) {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(36).padStart(2, '0').slice(-2);
  return `${prefix}_${out}`;
}

/**
 * Validates and normalizes untrusted block JSON (from HTTP bodies or disk).
 * @param {unknown} input
 * @returns {Block[]}
 * @throws {Error} when the input is not an array of well-formed blocks
 */
export function normalizeBlocks(input) {
  if (!Array.isArray(input)) throw new Error('blocks must be an array');
  if (input.length > 5000) throw new Error('a page holds at most 5000 blocks');
  return input.map((raw, i) => {
    if (raw === null || typeof raw !== 'object') throw new Error(`block ${i} must be an object`);
    const b = /** @type {Record<string, unknown>} */ (raw);
    const type = b.type ?? 'paragraph';
    if (typeof type !== 'string' || !BLOCK_TYPE_SET.has(/** @type {BlockType} */ (type))) {
      throw new Error(`block ${i} has unknown type ${JSON.stringify(type)}`);
    }
    const text = b.text ?? '';
    if (typeof text !== 'string') throw new Error(`block ${i} text must be a string`);
    if (text.length > 100_000) throw new Error(`block ${i} text exceeds 100000 characters`);
    /** @type {Block} */
    const block = {
      id: typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : newId('blk'),
      type: /** @type {BlockType} */ (type),
      text: type === 'divider' ? '' : text,
    };
    if (type === 'todo') block.checked = b.checked === true;
    if (type === 'code' && typeof b.lang === 'string') block.lang = b.lang.slice(0, 32);
    return block;
  });
}

/**
 * Parses a Markdown subset into blocks: ATX headings (#–###), bullet, numbered and
 * task-list items, block quotes (`> [!NOTE]` becomes a callout), fenced code,
 * thematic breaks, and paragraphs. Inline markup stays in `text`.
 * @param {string} markdown
 * @returns {Block[]}
 */
export function markdownToBlocks(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[]} */
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ id: newId('blk'), type: 'paragraph', text: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      /** @type {Block} */
      const code = { id: newId('blk'), type: 'code', text: body.join('\n') };
      if (fence[1]) code.lang = fence[1];
      blocks.push(code);
      continue;
    }
    if (line.trim() === '') { flush(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ id: newId('blk'), type: /** @type {BlockType} */ (`h${m[1].length}`), text: m[2].trim() });
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ id: newId('blk'), type: 'divider', text: '' });
    } else if ((m = /^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/.exec(line))) {
      flush();
      blocks.push({ id: newId('blk'), type: 'todo', text: m[2], checked: m[1] !== ' ' });
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ id: newId('blk'), type: 'bullet', text: m[1] });
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ id: newId('blk'), type: 'numbered', text: m[1] });
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flush();
      const quoted = [m[1]];
      while (i + 1 < lines.length && /^>/.test(lines[i + 1])) quoted.push(lines[++i].replace(/^>\s?/, ''));
      const callout = /^\[!(\w+)\]\s*$/.exec(quoted[0]);
      if (callout) blocks.push({ id: newId('blk'), type: 'callout', text: quoted.slice(1).join('\n') });
      else blocks.push({ id: newId('blk'), type: 'quote', text: quoted.join('\n') });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * Serializes blocks to Markdown. `markdownToBlocks(blocksToMarkdown(b))` preserves
 * block types and text for every block whose text does not itself start with
 * Markdown block syntax.
 * @param {readonly Block[]} blocks
 * @returns {string}
 */
export function blocksToMarkdown(blocks) {
  /** @type {string[]} */
  const out = [];
  let n = 0;
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    const listy = (/** @type {Block | undefined} */ x) => x && (x.type === 'bullet' || x.type === 'numbered' || x.type === 'todo');
    if (i > 0 && !(listy(b) && listy(prev) && prev?.type === b.type)) out.push('');
    n = b.type === 'numbered' && prev?.type === 'numbered' ? n + 1 : 1;
    switch (b.type) {
      case 'h1': out.push(`# ${b.text}`); break;
      case 'h2': out.push(`## ${b.text}`); break;
      case 'h3': out.push(`### ${b.text}`); break;
      case 'bullet': out.push(`- ${b.text}`); break;
      case 'numbered': out.push(`${n}. ${b.text}`); break;
      case 'todo': out.push(`- [${b.checked ? 'x' : ' '}] ${b.text}`); break;
      case 'quote': out.push(b.text.split('\n').map(l => `> ${l}`).join('\n')); break;
      case 'callout': out.push(['> [!NOTE]', ...b.text.split('\n').map(l => `> ${l}`)].join('\n')); break;
      case 'code': out.push(`\`\`\`${b.lang ?? ''}\n${b.text}\n\`\`\``); break;
      case 'divider': out.push('---'); break;
      default: out.push(b.text);
    }
  });
  return out.join('\n') + (out.length ? '\n' : '');
}

/**
 * Escapes text for inclusion in HTML element content or a quoted attribute.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * Renders inline Markdown (code spans, bold, italic, strikethrough, links) as HTML.
 * Input is escaped first; links are emitted only for http(s) and mailto URLs.
 * @param {string} text
 * @returns {string}
 */
export function inlineToHtml(text) {
  /** @type {string[]} */
  const codes = [];
  let s = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/**
 * Renders blocks as read-only HTML (task results, page previews).
 * @param {readonly Block[]} blocks
 * @returns {string}
 */
export function blocksToHtml(blocks) {
  /** @type {string[]} */
  const out = [];
  /** @type {string | null} */
  let list = null;
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const b of blocks) {
    const tag = b.type === 'bullet' || b.type === 'todo' ? 'ul' : b.type === 'numbered' ? 'ol' : null;
    if (tag !== list) { closeList(); if (tag) { out.push(`<${tag}>`); list = tag; } }
    const t = inlineToHtml(b.text);
    switch (b.type) {
      case 'h1': case 'h2': case 'h3': out.push(`<${b.type}>${t}</${b.type}>`); break;
      case 'bullet': case 'numbered': out.push(`<li>${t}</li>`); break;
      case 'todo': out.push(`<li class="todo${b.checked ? ' done' : ''}"><span class="box">${b.checked ? '✓' : ''}</span>${t}</li>`); break;
      case 'quote': out.push(`<blockquote>${t}</blockquote>`); break;
      case 'callout': out.push(`<div class="callout">${t}</div>`); break;
      case 'code': out.push(`<pre><code>${escapeHtml(b.text)}</code></pre>`); break;
      case 'divider': out.push('<hr>'); break;
      default: out.push(`<p>${t}</p>`);
    }
  }
  closeList();
  return out.join('');
}

/**
 * Renders a Markdown string as safe HTML.
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToHtml(markdown) {
  return blocksToHtml(markdownToBlocks(markdown));
}
