// @ts-check
/** DOM helpers shared by the Agentboard UI modules. */

/**
 * Creates an element. `attrs` keys starting with `on` attach listeners; `class`,
 * `style`, `dataset`, and boolean/string attributes are applied directly.
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...(Node | string | number | false | null | undefined | Array<Node | string | false | null | undefined>)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') /** @type {HTMLInputElement} */ (el).value = String(v);
    else if (k in el && typeof v !== 'string') /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'object' ? c : String(c));
  }
  return el;
}

/**
 * @param {string | null | undefined} iso
 * @returns {string} "just now", "5m ago", "3h ago", or a date
 */
export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * @param {string | null | undefined} iso
 * @returns {string} "in 4m", "in 30s", or "expired"
 */
export function until(iso) {
  if (!iso) return '';
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  return s < 60 ? `in ${s}s` : `in ${Math.ceil(s / 60)}m`;
}

/**
 * Deterministic avatar hue for a name.
 * @param {string} name
 * @returns {string} CSS color
 */
export function hue(name) {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${n % 360} 55% 52%)`;
}

/**
 * @param {string} name
 * @param {string} [extra] additional class
 * @returns {HTMLElement}
 */
export function avatar(name, extra = '') {
  return h('span', { class: `avatar ${extra}`, style: { background: hue(name) }, title: name }, name.slice(0, 1).toUpperCase());
}

/**
 * Shows a transient message.
 * @param {string} text
 * @param {'info' | 'error'} [kind]
 */
export function toast(text, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
  host.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'error' ? 6000 : 3000);
}

/**
 * Opens a modal dialog.
 * @param {{ title: string, body: Node, actions?: Array<{ label: string, kind?: 'primary' | 'danger' | 'ghost', onClick: () => unknown }>, wide?: boolean }} opts
 * @returns {() => void} closes the dialog
 */
export function modal({ title, body, actions = [], wide = false }) {
  const prev = /** @type {HTMLElement | null} */ (document.activeElement);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') close(); };
  const dialog = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, actions.map(a =>
      h('button', { class: `btn ${a.kind ?? ''}`, onClick: async () => { if ((await a.onClick()) !== false) close(); } }, a.label))) : null,
  );
  const overlay = h('div', { class: 'overlay', onMousedown: (/** @type {MouseEvent} */ e) => { if (e.target === overlay) close(); } }, dialog);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  /** @type {HTMLElement | null} */ (dialog.querySelector('input, textarea, select, button.primary'))?.focus();
  return close;
}

/**
 * Asks for one line or paragraph of text.
 * @param {{ title: string, label: string, placeholder?: string, multiline?: boolean, confirm?: string, value?: string }} opts
 * @returns {Promise<string | null>} the trimmed text, or null when cancelled
 */
export function promptText({ title, label, placeholder = '', multiline = false, confirm = 'Send', value = '' }) {
  return new Promise(resolve => {
    const input = multiline
      ? h('textarea', { rows: 4, placeholder, value })
      : h('input', { type: 'text', placeholder, value });
    let done = false;
    const close = modal({
      title,
      body: h('label', { class: 'field' }, h('span', null, label), input),
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => { done = true; resolve(null); } },
        { label: confirm, kind: 'primary', onClick: () => { done = true; resolve(/** @type {HTMLInputElement} */ (input).value.trim()); } },
      ],
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); done = true; resolve(/** @type {HTMLInputElement} */ (input).value.trim()); close(); }
    });
    const observer = new MutationObserver(() => { if (!input.isConnected) { observer.disconnect(); if (!done) resolve(null); } });
    observer.observe(document.body, { childList: true });
  });
}

/**
 * @param {string} title
 * @param {string} text
 * @param {string} [confirmLabel]
 * @returns {Promise<boolean>}
 */
export function confirmAction(title, text, confirmLabel = 'Delete') {
  return new Promise(resolve => {
    let done = false;
    const close = modal({
      title,
      body: h('p', null, text),
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => { done = true; resolve(false); } },
        { label: confirmLabel, kind: 'danger', onClick: () => { done = true; resolve(true); } },
      ],
    });
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.overlay')) { observer.disconnect(); if (!done) resolve(false); }
    });
    observer.observe(document.body, { childList: true });
    void close;
  });
}

/**
 * Copies text and confirms with a toast.
 * @param {string} text
 */
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    // Clipboard API is unavailable on insecure origins; the text stays selectable on screen.
    toast('Copy failed — select the text manually', 'error');
  }
}
