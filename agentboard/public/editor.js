// @ts-check
/**
 * Block editor for Agentboard pages: one contenteditable element per block,
 * Markdown shortcuts (`# `, `- `, `[] `, `> `, ```` ``` ````, `---`), a `/` menu,
 * drag-to-reorder, and Markdown paste. Saves are debounced and versioned; when an
 * agent edits the same page concurrently, the editor merges remote-only blocks
 * into the local list and retries.
 */

import { h } from './ui.js';
import { newId, inlineToHtml, markdownToBlocks } from '/shared/markdown.js';

/** @typedef {import('/shared/markdown.js').Block} Block */

const MENU = /** @type {const} */ ([
  ['paragraph', 'Text', 'Plain paragraph', '¶'],
  ['h1', 'Heading 1', 'Large section heading', 'H1'],
  ['h2', 'Heading 2', 'Medium section heading', 'H2'],
  ['h3', 'Heading 3', 'Small section heading', 'H3'],
  ['todo', 'To-do', 'Checkbox item', '☑'],
  ['bullet', 'Bulleted list', 'Simple list item', '•'],
  ['numbered', 'Numbered list', 'Ordered list item', '1.'],
  ['quote', 'Quote', 'Quoted text', '❝'],
  ['callout', 'Callout', 'Highlighted note', '💡'],
  ['code', 'Code', 'Monospace code block', '</>'],
  ['divider', 'Divider', 'Horizontal rule', '—'],
]);

const PLACEHOLDER = /** @type {Record<string, string>} */ ({
  paragraph: "Type '/' for commands", h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3',
  todo: 'To-do', bullet: 'List', numbered: 'List', quote: 'Quote', callout: 'Callout', code: 'Code',
});

const SHORTCUTS = /** @type {Array<[RegExp, Block['type']]>} */ ([
  [/^#\s/, 'h1'], [/^##\s/, 'h2'], [/^###\s/, 'h3'], [/^[-*+]\s/, 'bullet'], [/^1[.)]\s/, 'numbered'],
  [/^\[\s?\]\s/, 'todo'], [/^>\s/, 'quote'], [/^```$/, 'code'], [/^---$/, 'divider'],
]);

const supportsPlaintextOnly = (() => {
  const probe = document.createElement('div');
  probe.contentEditable = 'plaintext-only';
  return probe.contentEditable === 'plaintext-only';
})();

/**
 * @param {HTMLElement} el
 * @returns {number} caret offset in `el`'s text, or -1 when the selection is elsewhere
 */
function caretOffset(el) {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return -1;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return range.toString().length;
}

/**
 * @param {HTMLElement} el
 * @returns {boolean} whether the selection is collapsed
 */
function collapsed(el) {
  const sel = getSelection();
  return !!sel && sel.isCollapsed && el.contains(sel.anchorNode);
}

/**
 * Focuses `el` and places the caret at `offset` (clamped; `Infinity` means end).
 * @param {HTMLElement} el
 * @param {number} offset
 */
function setCaret(el, offset) {
  el.focus();
  const sel = getSelection();
  if (!sel) return;
  const range = document.createRange();
  let remaining = offset;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const len = /** @type {Text} */ (node).length;
    if (remaining <= len) { range.setStart(node, remaining); break; }
    remaining -= len;
    const next = walker.nextNode();
    if (!next) { range.setStart(node, len); break; }
    node = next;
  }
  if (!node) range.selectNodeContents(el), range.collapse(false);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * @param {HTMLElement} el
 * @returns {string} the element's text with a browser-added trailing newline removed
 */
function readText(el) {
  return el.innerText.replace(/\n$/, '');
}

export class PageEditor {
  /**
   * @param {{
   *   blocks: Block[], version: number, readOnly?: boolean,
   *   save: (blocks: Block[], baseVersion: number) => Promise<{ version: number }>,
   * }} opts `save` rejects with `{ status: 409, current }` on a version conflict
   */
  constructor({ blocks, version, save, readOnly = false }) {
    /** @type {Block[]} */
    this.blocks = structuredClone(blocks);
    this.version = version;
    this.saveFn = save;
    this.readOnly = readOnly;
    this.dirty = false;
    this.saving = false;
    /** @type {Set<string>} ids deleted locally since the last successful save */
    this.deleted = new Set();
    /** @type {Map<string, { row: HTMLElement, content: HTMLElement, type: string }>} */
    this.rows = new Map();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.timer = undefined;
    /** @type {{ el: HTMLElement, blockId: string, index: number, items: typeof MENU[number][] } | null} */
    this.menu = null;
    /** @type {string | null} */
    this.dragId = null;
    this.el = h('div', { class: 'editor' });
    if (!this.blocks.length && !readOnly) this.blocks.push({ id: newId('blk'), type: 'paragraph', text: '' });
    this.render();
  }

  // ---- rendering -------------------------------------------------------------

  render() {
    const focusedId = /** @type {HTMLElement | null} */ (document.activeElement?.closest?.('.block'))?.dataset.id;
    const keep = new Set(this.blocks.map(b => b.id));
    for (const [id, r] of this.rows) if (!keep.has(id)) { r.row.remove(); this.rows.delete(id); }
    this.blocks.forEach((block, i) => {
      let entry = this.rows.get(block.id);
      if (entry && entry.type !== block.type) { entry.row.remove(); this.rows.delete(block.id); entry = undefined; }
      if (!entry) { entry = this.#createRow(block); this.rows.set(block.id, entry); }
      else if (block.id !== focusedId) this.#paint(entry.content, block);
      entry.row.classList.toggle('checked', block.type === 'todo' && !!block.checked);
      const at = this.el.children[i];
      if (at !== entry.row) this.el.insertBefore(entry.row, at ?? null);
    });
  }

  /**
   * Shows formatted inline Markdown when the block is not being edited.
   * @param {HTMLElement} content
   * @param {Block} block
   */
  #paint(content, block) {
    if (block.type === 'divider') return;
    const rich = block.type !== 'code' && /[*_`~[]/.test(block.text);
    if (rich) { content.innerHTML = inlineToHtml(block.text); content.dataset.rich = '1'; }
    else { if (content.textContent !== block.text) content.textContent = block.text; delete content.dataset.rich; }
  }

  /**
   * @param {Block} block
   * @returns {{ row: HTMLElement, content: HTMLElement, type: string }}
   */
  #createRow(block) {
    const id = block.id;
    const content = h('div', {
      class: 'block-content',
      'data-placeholder': PLACEHOLDER[block.type] ?? '',
      spellcheck: block.type === 'code' ? 'false' : 'true',
    });
    if (block.type === 'divider') {
      content.tabIndex = this.readOnly ? -1 : 0;
      content.append(h('hr'));
    } else if (!this.readOnly) {
      content.contentEditable = supportsPlaintextOnly ? 'plaintext-only' : 'true';
    }
    this.#paint(content, block);

    const row = h('div', { class: 'block', dataset: { id, type: block.type } });
    if (!this.readOnly) {
      const handle = h('div', { class: 'block-handle', draggable: 'true', title: 'Drag to move' },
        h('button', { class: 'block-add', title: 'Add block below', tabIndex: -1, onClick: () => this.#insertAfter(id, { type: 'paragraph', text: '/' }, true) }, '+'),
        h('span', { class: 'grip' }, '⋮⋮'));
      handle.addEventListener('dragstart', e => {
        this.dragId = id;
        row.classList.add('dragging');
        e.dataTransfer?.setData('text/plain', id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      handle.addEventListener('dragend', () => { row.classList.remove('dragging'); this.dragId = null; this.#clearDropMarks(); });
      row.append(handle);
      row.addEventListener('dragover', e => {
        if (!this.dragId || this.dragId === id) return;
        e.preventDefault();
        const below = e.offsetY > row.offsetHeight / 2;
        this.#clearDropMarks();
        row.classList.add(below ? 'drop-below' : 'drop-above');
      });
      row.addEventListener('drop', e => {
        if (!this.dragId) return;
        e.preventDefault();
        this.#move(this.dragId, id, row.classList.contains('drop-below'));
        this.#clearDropMarks();
      });
    }
    if (block.type === 'todo') {
      row.append(h('button', {
        class: 'todo-box', role: 'checkbox', 'aria-checked': String(!!block.checked), disabled: this.readOnly,
        onClick: (/** @type {MouseEvent} */ e) => {
          const b = this.#block(id);
          if (!b) return;
          b.checked = !b.checked;
          /** @type {HTMLElement} */ (e.currentTarget).setAttribute('aria-checked', String(b.checked));
          row.classList.toggle('checked', b.checked);
          this.#changed();
        },
      }));
    }
    if (block.type === 'bullet') row.append(h('span', { class: 'bullet-dot' }, '•'));
    row.append(content);
    if (!this.readOnly) this.#bind(id, content);
    return { row, content, type: block.type };
  }

  #clearDropMarks() {
    for (const el of this.el.querySelectorAll('.drop-above, .drop-below')) el.classList.remove('drop-above', 'drop-below');
  }

  // ---- editing -------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {Block | undefined}
   */
  #block(id) {
    return this.blocks.find(b => b.id === id);
  }

  /**
   * @param {string} id
   * @param {number} [offset]
   */
  focus(id, offset = Infinity) {
    const entry = this.rows.get(id);
    if (!entry) return;
    if (entry.type === 'divider') { entry.content.focus(); return; }
    this.#unpaint(entry.content, id);
    setCaret(entry.content, offset);
  }

  /** Focuses the end of the last block (used when clicking below the content). */
  focusEnd() {
    const last = this.blocks.at(-1);
    if (!last || last.type !== 'paragraph' || last.text) this.#insertAfter(last?.id ?? null, { type: 'paragraph', text: '' }, true);
    else this.focus(last.id);
  }

  /**
   * Swaps formatted HTML back to raw Markdown text for editing.
   * @param {HTMLElement} content
   * @param {string} id
   */
  #unpaint(content, id) {
    if (content.dataset.rich) {
      content.textContent = this.#block(id)?.text ?? '';
      delete content.dataset.rich;
    }
  }

  /**
   * @param {string} id
   * @param {HTMLElement} content
   */
  #bind(id, content) {
    content.addEventListener('focus', () => {
      if (content.dataset.rich) { this.#unpaint(content, id); setCaret(content, Infinity); }
    });
    content.addEventListener('blur', () => {
      const b = this.#block(id);
      if (b && !this.menu) this.#paint(content, b);
      setTimeout(() => { if (this.menu && !this.el.contains(document.activeElement)) this.#closeMenu(); }, 150);
    });
    content.addEventListener('input', () => {
      const b = this.#block(id);
      if (!b) return;
      b.text = readText(content);
      if (b.type === 'paragraph' || b.type === 'bullet') {
        for (const [re, type] of SHORTCUTS) {
          if (b.type === 'bullet' && type !== 'todo') continue;
          if (!re.test(b.text)) continue;
          b.text = b.text.replace(re, '');
          this.#setType(id, type);
          return;
        }
      }
      if (b.text.startsWith('/') && !b.text.includes(' ') && b.type !== 'code') this.#openMenu(id, b.text.slice(1));
      else this.#closeMenu();
      this.#changed();
    });
    content.addEventListener('paste', e => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const b = this.#block(id);
      if (!b) return;
      if (text.includes('\n') && b.type !== 'code') {
        e.preventDefault();
        const parsed = markdownToBlocks(text);
        if (!parsed.length) return;
        const i = this.blocks.indexOf(b);
        if (b.text === '') this.blocks.splice(i, 1, ...parsed), this.deleted.add(b.id);
        else this.blocks.splice(i + 1, 0, ...parsed);
        this.render();
        this.focus(/** @type {Block} */ (parsed.at(-1)).id);
        this.#changed();
      } else if (!supportsPlaintextOnly) {
        e.preventDefault();
        document.execCommand('insertText', false, text);
      }
    });
    content.addEventListener('keydown', e => this.#onKey(e, id, content));
  }

  /**
   * @param {KeyboardEvent} e
   * @param {string} id
   * @param {HTMLElement} content
   */
  #onKey(e, id, content) {
    const b = this.#block(id);
    if (!b || e.isComposing) return;
    if (this.menu && this.menu.blockId === id) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.menu.items.length;
        this.menu.index = (this.menu.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.#drawMenu();
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); const item = this.menu.items[this.menu.index]; if (item) this.#pick(item[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.#closeMenu(); return; }
    }
    const i = this.blocks.indexOf(b);
    if (b.type === 'divider') {
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); this.#remove(id, i > 0 ? this.blocks[i - 1].id : this.blocks[i + 1]?.id); }
      else if (e.key === 'Enter') { e.preventDefault(); this.#insertAfter(id, { type: 'paragraph', text: '' }, true); }
      else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); this.focus(this.blocks[i - 1].id); }
      else if (e.key === 'ArrowDown' && i < this.blocks.length - 1) { e.preventDefault(); this.focus(this.blocks[i + 1].id, 0); }
      return;
    }
    const offset = caretOffset(content);
    if (e.key === 'Tab' && b.type === 'code') { e.preventDefault(); document.execCommand('insertText', false, '  '); return; }
    if (e.key === 'Enter' && !e.shiftKey && b.type !== 'code') {
      e.preventDefault();
      const listy = b.type === 'bullet' || b.type === 'numbered' || b.type === 'todo';
      if (listy && b.text === '') { this.#setType(id, 'paragraph'); return; }
      const before = b.text.slice(0, offset < 0 ? b.text.length : offset);
      const after = b.text.slice(offset < 0 ? b.text.length : offset);
      b.text = before;
      content.textContent = before;
      this.#insertAfter(id, { type: listy || b.type === 'quote' ? b.type : 'paragraph', text: after }, true, 0);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && b.type === 'code') {
      e.preventDefault();
      this.#insertAfter(id, { type: 'paragraph', text: '' }, true);
      return;
    }
    if (e.key === 'Backspace' && offset === 0 && collapsed(content)) {
      e.preventDefault();
      if (b.type !== 'paragraph') { this.#setType(id, 'paragraph'); return; }
      const prev = this.blocks[i - 1];
      if (!prev) return;
      if (prev.type === 'divider') { this.#remove(prev.id, id); return; }
      const joinAt = prev.text.length;
      prev.text += b.text;
      this.#remove(id, null);
      const prevEntry = this.rows.get(prev.id);
      if (prevEntry) { prevEntry.content.textContent = prev.text; delete prevEntry.content.dataset.rich; }
      this.focus(prev.id, joinAt);
      return;
    }
    if (e.key === 'ArrowUp' && offset === 0 && i > 0) { e.preventDefault(); this.focus(this.blocks[i - 1].id); return; }
    if (e.key === 'ArrowDown' && offset === b.text.length && i < this.blocks.length - 1) { e.preventDefault(); this.focus(this.blocks[i + 1].id, 0); }
  }

  /**
   * @param {string | null} afterId null inserts at the top
   * @param {Pick<Block, 'type' | 'text'>} init
   * @param {boolean} focus
   * @param {number} [caret]
   */
  #insertAfter(afterId, init, focus, caret = Infinity) {
    /** @type {Block} */
    const block = { id: newId('blk'), type: init.type, text: init.text };
    if (block.type === 'todo') block.checked = false;
    const i = afterId ? this.blocks.findIndex(b => b.id === afterId) : -1;
    this.blocks.splice(i + 1, 0, block);
    this.render();
    if (focus) this.focus(block.id, caret);
    if (block.text === '/') this.#openMenu(block.id, '');
    this.#changed();
  }

  /**
   * @param {string} id
   * @param {string | null | undefined} focusId block to focus afterwards
   */
  #remove(id, focusId) {
    if (this.blocks.length === 1) {
      Object.assign(this.blocks[0], { type: 'paragraph', text: '' });
      this.render();
      this.focus(this.blocks[0].id);
      this.#changed();
      return;
    }
    this.blocks = this.blocks.filter(b => b.id !== id);
    this.deleted.add(id);
    this.render();
    if (focusId) this.focus(focusId);
    this.#changed();
  }

  /**
   * @param {string} id
   * @param {Block['type']} type
   */
  #setType(id, type) {
    const b = this.#block(id);
    if (!b) return;
    b.type = type;
    if (type === 'divider') b.text = '';
    if (type === 'todo') b.checked = false; else delete b.checked;
    if (type !== 'code') delete b.lang;
    this.#closeMenu();
    this.render();
    if (type === 'divider') {
      const i = this.blocks.indexOf(b);
      if (i === this.blocks.length - 1 || this.blocks[i + 1].type !== 'paragraph') this.#insertAfter(id, { type: 'paragraph', text: '' }, true);
      else this.focus(this.blocks[i + 1].id, 0);
    } else {
      this.focus(id, 0);
    }
    this.#changed();
  }

  /**
   * @param {string} dragId
   * @param {string} targetId
   * @param {boolean} below
   */
  #move(dragId, targetId, below) {
    const from = this.blocks.findIndex(b => b.id === dragId);
    if (from < 0 || dragId === targetId) return;
    const [block] = this.blocks.splice(from, 1);
    const to = this.blocks.findIndex(b => b.id === targetId);
    this.blocks.splice(below ? to + 1 : to, 0, block);
    this.render();
    this.#changed();
  }

  // ---- slash menu ------------------------------------------------------------

  /**
   * @param {string} blockId
   * @param {string} query
   */
  #openMenu(blockId, query) {
    const q = query.toLowerCase();
    const items = MENU.filter(([type, label]) => !q || label.toLowerCase().includes(q) || type.startsWith(q));
    if (!items.length) { this.#closeMenu(); return; }
    if (!this.menu || this.menu.blockId !== blockId) {
      this.#closeMenu();
      this.menu = { el: h('div', { class: 'slash-menu', role: 'listbox' }), blockId, index: 0, items };
      document.body.append(this.menu.el);
    }
    this.menu.items = items;
    this.menu.index = Math.min(this.menu.index, items.length - 1);
    this.#drawMenu();
  }

  #drawMenu() {
    const menu = this.menu;
    if (!menu) return;
    const row = this.rows.get(menu.blockId)?.row;
    if (!row) { this.#closeMenu(); return; }
    const rect = row.getBoundingClientRect();
    const flip = rect.bottom + 4 + 320 > innerHeight && rect.top > innerHeight - rect.bottom;
    Object.assign(menu.el.style, flip
      ? { top: '', bottom: `${innerHeight - rect.top + 4}px`, left: `${Math.max(8, rect.left + 24)}px` }
      : { bottom: '', top: `${rect.bottom + 4}px`, left: `${Math.max(8, rect.left + 24)}px` });
    menu.el.replaceChildren(h('div', { class: 'slash-title' }, 'Basic blocks'), ...menu.items.map(([type, label, hint, icon], i) =>
      h('div', {
        class: `slash-item${i === menu.index ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === menu.index),
        onMousedown: (/** @type {MouseEvent} */ e) => { e.preventDefault(); this.#pick(type); },
      }, h('span', { class: 'slash-icon' }, icon), h('span', null, h('strong', null, label), h('small', null, hint)))));
    menu.el.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  /** @param {Block['type']} type */
  #pick(type) {
    const menu = this.menu;
    if (!menu) return;
    const b = this.#block(menu.blockId);
    this.#closeMenu();
    if (!b) return;
    b.text = '';
    const entry = this.rows.get(b.id);
    if (entry) entry.content.textContent = '';
    if (b.type === type) { this.focus(b.id, 0); this.#changed(); return; }
    this.#setType(b.id, type);
  }

  #closeMenu() {
    this.menu?.el.remove();
    this.menu = null;
  }

  // ---- persistence ---------------------------------------------------------

  #changed() {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }

  /** Saves now if there are unsaved edits. */
  async flush() {
    clearTimeout(this.timer);
    if (!this.dirty || this.saving) return;
    this.saving = true;
    this.dirty = false;
    const deleted = new Set(this.deleted);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const saved = await this.saveFn(structuredClone(this.blocks), this.version);
          this.version = saved.version;
          for (const id of deleted) this.deleted.delete(id);
          break;
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (e?.status !== 409 || !e.current) throw err;
          this.#merge(e.current.blocks);
          this.version = e.current.version;
        }
      }
    } catch (err) {
      this.dirty = true;
      throw err;
    } finally {
      this.saving = false;
      if (this.dirty) this.timer = setTimeout(() => this.flush(), 1000);
    }
  }

  /**
   * Inserts blocks that exist remotely but not locally (and were not deleted
   * locally) after their nearest remote predecessor that exists locally.
   * @param {Block[]} remote
   */
  #merge(remote) {
    const local = new Set(this.blocks.map(b => b.id));
    // Blocks after the last shared block were appended remotely; keep them at the end.
    const lastShared = remote.findLastIndex(rb => local.has(rb.id));
    let anchor = null;
    for (const [i, rb] of remote.entries()) {
      if (local.has(rb.id)) { anchor = rb.id; continue; }
      if (this.deleted.has(rb.id)) continue;
      const at = i > lastShared ? this.blocks.length : anchor ? this.blocks.findIndex(b => b.id === anchor) + 1 : 0;
      this.blocks.splice(at, 0, structuredClone(rb));
      local.add(rb.id);
      anchor = rb.id;
    }
    this.render();
  }

  /**
   * Adopts a newer server version when there are no local edits in flight.
   * @param {{ blocks: Block[], version: number }} page
   */
  applyRemote(page) {
    if (page.version <= this.version || this.dirty || this.saving) return;
    this.blocks = structuredClone(page.blocks);
    if (!this.blocks.length && !this.readOnly) this.blocks.push({ id: newId('blk'), type: 'paragraph', text: '' });
    this.version = page.version;
    this.render();
  }

  destroy() {
    this.#closeMenu();
    if (this.dirty) this.flush().catch(() => {
      // The view is gone; a failed final save has nowhere to surface except the console.
      console.warn('agentboard: final save failed');
    });
  }
}
