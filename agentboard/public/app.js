// @ts-check
/**
 * Agentboard browser UI: sidebar page tree, Home inbox, Control Room, activity
 * feed, page editor, and kanban/table boards with a task drawer. State comes from
 * `GET /api/state` and stays live through the `/api/events` SSE stream.
 */

import { h, ago, until, avatar, toast, modal, promptText, confirmAction, copy } from './ui.js';
import { PageEditor } from './editor.js';
import { markdownToHtml } from '/shared/markdown.js';
import { TASK_STATUSES, STATUS_LABELS, PRIORITIES, OPERATOR_ID, SYSTEM_ID } from '/shared/model.js';

/**
 * @typedef {import('/shared/model.js').Page} Page
 * @typedef {import('/shared/model.js').Task} Task
 * @typedef {import('/shared/model.js').Comment} Comment
 * @typedef {import('/shared/model.js').Command} Command
 * @typedef {import('/shared/model.js').Activity} Activity
 * @typedef {import('/shared/model.js').Agent & { online: boolean }} Agent
 */

const TOKEN_KEY = 'agentboard.token';
const ICONS = ['📄', '📋', '📝', '📚', '🧠', '🤖', '🛠️', '🚀', '🎯', '📊', '🔬', '🧪', '💡', '🗂️', '📦', '🔒', '🌐', '⚙️', '🧭', '✅', '🐛', '📣', '🗓️', '💬'];

/** Local mirror of server state. */
const S = {
  token: /** @type {string | null} */ (null),
  workspace: { name: '' },
  /** @type {Map<string, Page>} */ pages: new Map(),
  /** @type {Map<string, Task>} */ tasks: new Map(),
  /** @type {Comment[]} */ comments: [],
  /** @type {Map<string, Agent>} */ agents: new Map(),
  /** @type {Command[]} */ commands: [],
  /** @type {Activity[]} */ activity: [],
  config: { leaseMs: 300000, presenceMs: 45000, mcpServerPath: '' },
  connected: false,
  dragging: false,
};

/** Per-view caches that survive re-renders. */
const view = {
  /** @type {{ pageId: string, editor: PageEditor, root: HTMLElement, title: HTMLInputElement, boardHost: HTMLElement | null } | null} */
  page: null,
  mainStale: false,
  drawerStale: false,
  /** @type {Set<string>} */
  expanded: new Set(load('agentboard.expanded', [])),
};

/**
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } // storage blocked or corrupt: use the default
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked (private mode): preferences are per-session only */ }
}

// ---- API -------------------------------------------------------------------

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${S.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) { signOut('Your session token was rejected. Paste the admin token again.'); throw new Error('unauthorized'); }
  if (!res.ok) throw Object.assign(new Error(data?.error ?? res.statusText), { status: res.status, current: data?.current });
  return data;
}

/**
 * Runs an API call and shows failures as a toast.
 * @param {Promise<unknown>} p
 * @returns {Promise<any>}
 */
async function attempt(p) {
  try { return await p; } catch (err) {
    if (/** @type {Error} */ (err).message !== 'unauthorized') toast(/** @type {Error} */ (err).message, 'error');
    return undefined;
  }
}

// ---- live state ------------------------------------------------------------

/** @param {any} snap */
function adopt(snap) {
  S.workspace = snap.workspace;
  S.pages = new Map(snap.pages.map((/** @type {Page} */ p) => [p.id, p]));
  S.tasks = new Map(snap.tasks.map((/** @type {Task} */ t) => [t.id, t]));
  S.comments = snap.comments;
  S.agents = new Map(snap.agents.map((/** @type {Agent} */ a) => [a.id, a]));
  S.commands = snap.commands;
  S.activity = snap.activity;
  S.config = snap.config;
}

/** @type {EventSource | null} */
let events = null;

function connect() {
  events?.close();
  events = new EventSource(`/api/events?token=${encodeURIComponent(S.token ?? '')}`);
  let first = true;
  events.addEventListener('hello', async () => {
    S.connected = true;
    if (!first) adopt(await api('GET', '/api/state'));
    first = false;
    schedule();
  });
  events.onerror = () => { S.connected = false; schedule(); };
  /** @type {Record<string, (d: any) => void>} */
  const handlers = {
    'page.created': p => S.pages.set(p.id, p),
    'page.updated': p => S.pages.set(p.id, p),
    'page.deleted': ({ id }) => S.pages.delete(id),
    'task.created': t => S.tasks.set(t.id, t),
    'task.updated': t => S.tasks.set(t.id, t),
    'task.deleted': ({ id }) => S.tasks.delete(id),
    'comment.created': c => { if (!S.comments.some(x => x.id === c.id)) S.comments.push(c); },
    'agent.created': a => S.agents.set(a.id, a),
    'agent.updated': a => S.agents.set(a.id, a),
    'agent.deleted': ({ id }) => S.agents.delete(id),
    'command.created': c => S.commands.push(c),
    'command.updated': c => { const i = S.commands.findIndex(x => x.id === c.id); if (i >= 0) S.commands[i] = c; else S.commands.push(c); },
    'activity.created': a => { S.activity.push(a); if (S.activity.length > 500) S.activity.shift(); },
  };
  for (const [type, fn] of Object.entries(handlers)) {
    events.addEventListener(type, e => { fn(JSON.parse(/** @type {MessageEvent} */ (e).data)); schedule(type); });
  }
}

let frame = 0;
/** @type {Set<string>} */
const pendingTypes = new Set();
/** @param {string} [type] the event that triggered the render */
function schedule(type = 'local') {
  pendingTypes.add(type);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const types = new Set(pendingTypes);
    pendingTypes.clear();
    render(types);
  });
}

// ---- routing ---------------------------------------------------------------

/** @returns {{ name: string, id?: string, task?: string }} */
function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name = 'home', id] = path.split('/');
  const task = new URLSearchParams(query).get('task') ?? undefined;
  return { name: name || 'home', id, task };
}

/**
 * @param {string} hash
 */
function go(hash) {
  location.hash = hash;
}

/**
 * @param {string | null} taskId
 */
function openTask(taskId) {
  const r = route();
  const base = location.hash.replace(/^#/, '').split('?')[0] || '/home';
  if (taskId) go(`${base}?task=${taskId}`);
  else if (r.task) go(base);
}

// ---- helpers ---------------------------------------------------------------

/**
 * @param {string | null | undefined} id
 * @returns {string}
 */
function actorName(id) {
  if (!id || id === OPERATOR_ID) return 'You';
  if (id === SYSTEM_ID) return 'System';
  return S.agents.get(id)?.name ?? 'Removed agent';
}

/**
 * @param {string | null | undefined} id
 * @returns {HTMLElement}
 */
function actorAvatar(id) {
  if (!id || id === OPERATOR_ID) return h('span', { class: 'avatar you', title: 'You' }, '★');
  if (id === SYSTEM_ID) return h('span', { class: 'avatar system', title: 'System' }, '⚙');
  return avatar(actorName(id));
}

/** @param {Agent} a */
function presence(a) {
  const state = !a.online ? 'offline' : a.paused ? 'paused' : a.status;
  return h('span', { class: `presence ${state}`, title: state }, h('i'), state);
}

/** @returns {Page[]} */
function boards() {
  return [...S.pages.values()].filter(p => p.kind === 'board');
}

/**
 * @param {string} id
 * @returns {Page[]} the page's ancestors from the root down, excluding itself
 */
function ancestors(id) {
  const out = [];
  let p = S.pages.get(id);
  while (p?.parentId) { p = S.pages.get(p.parentId); if (p) out.unshift(p); }
  return out;
}

/** @param {Task} t */
function lastQuestion(t) {
  return S.comments.filter(c => c.taskId === t.id && c.kind === 'question').at(-1);
}

/**
 * @param {Task} t
 * @param {{ compact?: boolean }} [opts]
 * @returns {HTMLElement}
 */
function taskCard(t, { compact = false } = {}) {
  const assignee = t.assigneeId ? S.agents.get(t.assigneeId) : null;
  const q = t.status === 'blocked' ? lastQuestion(t) : null;
  const card = h('div', {
    class: `card prio-${t.priority}`, draggable: compact ? null : 'true', tabIndex: 0, dataset: { id: t.id },
    onClick: () => openTask(t.id),
    onKeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') openTask(t.id); },
  },
    h('div', { class: 'card-title' }, t.title),
    q ? h('div', { class: 'card-question' }, '❓ ', q.text.slice(0, 120)) : null,
    t.status === 'in_progress' && t.progress > 0 ? h('div', { class: 'progress' }, h('i', { style: { width: `${t.progress}%` } })) : null,
    h('div', { class: 'card-meta' },
      t.priority !== 'normal' ? h('span', { class: `chip prio ${t.priority}` }, t.priority) : null,
      t.needsApproval ? h('span', { class: `chip approval ${t.approval?.state ?? ''}`, title: 'Requires approval' }, t.approval?.state === 'pending' ? '⏳ awaiting approval' : t.approval?.state === 'approved' ? '✓ approved' : '🔒 approval') : null,
      t.labels.map(l => h('span', { class: 'chip' }, l)),
      t.lease ? h('span', { class: 'chip lease', title: `Lease expires ${until(t.lease.expiresAt)}` }, '⚡ live') : null,
      h('span', { class: 'spacer' }),
      assignee ? avatar(assignee.name, assignee.online ? 'online' : '') : t.assigneeId ? avatar('?') : null,
    ),
  );
  if (!compact) {
    card.addEventListener('dragstart', e => {
      S.dragging = true;
      e.dataTransfer?.setData('text/x-task', t.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    card.addEventListener('dragend', () => { S.dragging = false; card.classList.remove('dragging'); schedule(); });
  }
  return card;
}

// ---- sidebar ---------------------------------------------------------------

function renderSidebar() {
  const r = route();
  const nav = (/** @type {string} */ hash, /** @type {string} */ icon, /** @type {string} */ label, /** @type {number} */ badge = 0) =>
    h('a', { class: `nav${location.hash.startsWith(`#${hash}`) || (hash === '/home' && r.name === 'home') ? ' active' : ''}`, href: `#${hash}` },
      h('span', { class: 'nav-icon' }, icon), h('span', null, label), badge ? h('span', { class: 'badge' }, String(badge)) : null);
  const inbox = [...S.tasks.values()].filter(t => (t.status === 'review' && t.approval?.state === 'pending') || t.status === 'blocked').length;
  const online = [...S.agents.values()].filter(a => a.online).length;

  /**
   * @param {string | null} parentId
   * @param {number} depth
   * @returns {HTMLElement[]}
   */
  const tree = (parentId, depth) => [...S.pages.values()]
    .filter(p => p.parentId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap(p => {
      const kids = [...S.pages.values()].some(c => c.parentId === p.id);
      const open = view.expanded.has(p.id);
      const row = h('div', { class: `tree-row${r.name === 'p' && r.id === p.id ? ' active' : ''}`, style: { paddingLeft: `${8 + depth * 14}px` } },
        h('button', {
          class: `twisty${kids ? '' : ' empty'}`, 'aria-label': open ? 'Collapse' : 'Expand', 'aria-expanded': String(open),
          onClick: () => { open ? view.expanded.delete(p.id) : view.expanded.add(p.id); save('agentboard.expanded', [...view.expanded]); schedule(); },
        }, kids ? (open ? '▾' : '▸') : '•'),
        h('a', { class: 'tree-link', href: `#/p/${p.id}` }, h('span', { class: 'tree-icon' }, p.icon), h('span', { class: 'tree-title' }, p.title || 'Untitled')),
        h('button', { class: 'tree-add', title: 'Add a page inside', 'aria-label': 'Add a page inside', onClick: () => newPage('doc', p.id) }, '+'));
      return [row, ...(open ? tree(p.id, depth + 1) : [])];
    });

  const side = h('nav', { class: 'sidebar-inner', 'aria-label': 'Workspace' },
    h('div', { class: 'workspace' }, h('span', { class: 'ws-logo' }, '◆'), h('span', { class: 'ws-name' }, S.workspace.name || 'Agentboard')),
    nav('/home', '🏠', 'Home', inbox),
    nav('/agents', '🛰️', 'Control Room', 0),
    nav('/activity', '📜', 'Activity'),
    h('div', { class: 'side-section' }, h('span', null, 'Pages'),
      h('span', { class: 'side-actions' },
        h('button', { class: 'icon-btn', title: 'New page', 'aria-label': 'New page', onClick: () => newPage('doc', null) }, '+'),
        h('button', { class: 'icon-btn', title: 'New board', 'aria-label': 'New board', onClick: () => newPage('board', null) }, '▦'))),
    h('div', { class: 'tree' }, tree(null, 0)),
    h('div', { class: 'side-foot' },
      h('span', { class: `conn ${S.connected ? 'on' : 'off'}` }, h('i'), S.connected ? `Live · ${online} agent${online === 1 ? '' : 's'} online` : 'Reconnecting…'),
      h('span', { class: 'side-actions' },
        h('button', { class: 'icon-btn', title: 'Toggle theme', 'aria-label': 'Toggle theme', onClick: toggleTheme }, '🌓'),
        h('button', { class: 'icon-btn', title: 'Sign out', 'aria-label': 'Sign out', onClick: () => signOut() }, '🚪'))),
  );
  /** @type {HTMLElement} */ (document.getElementById('sidebar')).replaceChildren(side);
}

/**
 * @param {'doc' | 'board'} kind
 * @param {string | null} parentId
 */
async function newPage(kind, parentId) {
  const page = await attempt(api('POST', '/api/pages', { kind, parentId, title: kind === 'board' ? 'Untitled board' : 'Untitled' }));
  if (!page) return;
  S.pages.set(page.id, page);
  if (parentId) { view.expanded.add(parentId); save('agentboard.expanded', [...view.expanded]); }
  go(`/p/${page.id}`);
  setTimeout(() => { view.page?.title.focus(); view.page?.title.select(); }, 50);
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  save('agentboard.theme', root.dataset.theme);
}

// ---- main views ------------------------------------------------------------

/**
 * @param {Set<string>} types
 */
function render(types) {
  if (!S.token) return;
  renderSidebar();
  const main = /** @type {HTMLElement} */ (document.getElementById('main'));
  const r = route();
  const active = document.activeElement;
  const typing = active instanceof HTMLElement && main.contains(active) && (active.matches('input, textarea, select') || active.isContentEditable);

  if (r.name === 'p' && r.id && S.pages.has(r.id)) {
    renderPage(main, S.pages.get(r.id), types);
  } else {
    if (view.page) { view.page.editor.destroy(); view.page = null; main.replaceChildren(); }
    if (typing && !types.has('local') && !types.has('route')) view.mainStale = true;
    else {
      view.mainStale = false;
      const content = r.name === 'agents' && r.id ? viewAgent(r.id)
        : r.name === 'agents' ? viewAgents()
        : r.name === 'activity' ? viewActivity()
        : r.name === 'p' ? h('div', { class: 'empty-state' }, h('h2', null, 'Page not found'), h('p', null, 'It may have been deleted.'), h('a', { class: 'btn', href: '#/home' }, 'Go home'))
        : viewHome();
      const scroll = main.scrollTop;
      main.replaceChildren(content);
      main.scrollTop = scroll;
    }
  }
  renderDrawer(r.task, types);
}

function viewHome() {
  const tasks = [...S.tasks.values()];
  const agents = [...S.agents.values()];
  const approvals = tasks.filter(t => t.status === 'review' && t.approval?.state === 'pending');
  const blocked = tasks.filter(t => t.status === 'blocked');
  const erroring = agents.filter(a => a.online && a.status === 'error');
  const doneToday = tasks.filter(t => t.status === 'done' && Date.now() - Date.parse(t.updatedAt) < 86400000).length;
  const hour = new Date().getHours();
  const tile = (/** @type {string} */ label, /** @type {string | number} */ value, /** @type {string} */ hint = '') =>
    h('div', { class: 'tile' }, h('div', { class: 'tile-value' }, String(value)), h('div', { class: 'tile-label' }, label), hint ? h('div', { class: 'tile-hint' }, hint) : null);

  const attention = [
    ...approvals.map(t => h('div', { class: 'inbox-item' },
      h('div', { class: 'inbox-kind approve' }, 'Approval'),
      h('div', { class: 'inbox-body' },
        h('a', { href: '#', onClick: (/** @type {Event} */ e) => { e.preventDefault(); openTask(t.id); } }, h('strong', null, t.title)),
        h('div', { class: 'muted' }, `${actorName(t.assigneeId)} submitted ${ago(t.updatedAt)}`),
        t.result ? h('div', { class: 'result-preview prose', html: markdownToHtml(t.result.slice(0, 600)) }) : null),
      h('div', { class: 'inbox-actions' },
        h('button', { class: 'btn primary', onClick: () => review(t, 'approve') }, 'Approve'),
        h('button', { class: 'btn ghost', onClick: () => review(t, 'reject') }, 'Request changes')))),
    ...blocked.map(t => {
      const q = lastQuestion(t);
      return h('div', { class: 'inbox-item' },
        h('div', { class: 'inbox-kind blocked' }, 'Question'),
        h('div', { class: 'inbox-body' },
          h('a', { href: '#', onClick: (/** @type {Event} */ e) => { e.preventDefault(); openTask(t.id); } }, h('strong', null, t.title)),
          h('div', { class: 'muted' }, q ? `${actorName(q.authorId)} asked ${ago(q.at)}` : `Blocked ${ago(t.updatedAt)}`),
          q ? h('blockquote', { class: 'question' }, q.text) : null),
        h('div', { class: 'inbox-actions' }, h('button', { class: 'btn primary', onClick: () => openTask(t.id) }, 'Answer')));
    }),
    ...erroring.map(a => h('div', { class: 'inbox-item' },
      h('div', { class: 'inbox-kind error' }, 'Agent error'),
      h('div', { class: 'inbox-body' }, h('a', { href: `#/agents/${a.id}` }, h('strong', null, a.name)), h('div', { class: 'muted' }, a.statusNote || 'Reported an error')),
      h('div', { class: 'inbox-actions' }, h('a', { class: 'btn ghost', href: `#/agents/${a.id}` }, 'Inspect')))),
  ];

  return h('div', { class: 'page-wrap wide' },
    h('header', { class: 'view-head' },
      h('h1', null, `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}`),
      h('p', { class: 'muted' }, 'Here is what your agents are up to.')),
    h('div', { class: 'tiles' },
      tile('Agents online', `${agents.filter(a => a.online).length}/${agents.length}`),
      tile('Working now', tasks.filter(t => t.status === 'in_progress').length),
      tile('Needs you', approvals.length + blocked.length, approvals.length ? `${approvals.length} approval${approvals.length === 1 ? '' : 's'}` : ''),
      tile('Done today', doneToday)),
    h('section', null,
      h('h2', { class: 'section-title' }, 'Inbox'),
      attention.length ? h('div', { class: 'inbox' }, attention) : h('div', { class: 'empty-inline' }, '✨ Nothing needs your attention. Agents will ask here when they are blocked or need approval.')),
    h('div', { class: 'two-col' },
      h('section', null,
        h('h2', { class: 'section-title' }, 'Boards'),
        h('div', { class: 'board-links' }, boards().map(b => {
          const bt = tasks.filter(t => t.boardId === b.id);
          return h('a', { class: 'board-link', href: `#/p/${b.id}` },
            h('span', { class: 'board-link-title' }, b.icon, ' ', b.title),
            h('span', { class: 'board-link-stats' }, TASK_STATUSES.filter(s => s !== 'backlog').map(s => {
              const n = bt.filter(t => t.status === s).length;
              return n ? h('span', { class: `stat s-${s}`, title: STATUS_LABELS[s] }, `${n} ${STATUS_LABELS[s].toLowerCase()}`) : null;
            })));
        }), h('button', { class: 'btn ghost', onClick: () => newPage('board', null) }, '+ New board'))),
      h('section', null,
        h('h2', { class: 'section-title' }, 'Recent activity'),
        activityList(S.activity.slice(-12).reverse()),
        h('a', { class: 'more', href: '#/activity' }, 'View all activity →'))),
  );
}

/**
 * @param {Task} t
 * @param {'approve' | 'reject'} action
 */
async function review(t, action) {
  let note = '';
  if (action === 'reject') {
    const text = await promptText({ title: 'Request changes', label: `What should ${actorName(t.assigneeId)} change?`, multiline: true, confirm: 'Send back' });
    if (text === null) return;
    note = text;
  }
  const res = await attempt(api('POST', `/api/tasks/${t.id}/${action}`, { note }));
  if (res) toast(action === 'approve' ? 'Approved' : 'Sent back for changes');
}

/**
 * @param {Activity[]} items newest first
 * @returns {HTMLElement}
 */
function activityList(items) {
  if (!items.length) return h('div', { class: 'empty-inline' }, 'No activity yet.');
  return h('ul', { class: 'activity' }, items.map(a => h('li', null,
    actorAvatar(a.actorId),
    h('div', null,
      h('span', null, h('strong', null, actorName(a.actorId)), ' ', a.summary, ' '),
      a.taskId && S.tasks.has(a.taskId) ? h('a', { href: '#', class: 'muted', onClick: (/** @type {Event} */ e) => { e.preventDefault(); openTask(/** @type {string} */ (a.taskId)); } }, 'open') : null,
      h('div', { class: 'muted small', title: new Date(a.at).toLocaleString() }, ago(a.at))))));
}

function viewActivity() {
  return h('div', { class: 'page-wrap' },
    h('header', { class: 'view-head' }, h('h1', null, '📜 Activity'), h('p', { class: 'muted' }, 'Every change by you, your agents, and the system, newest first.')),
    activityList(S.activity.slice().reverse()));
}

// ---- Control Room ----------------------------------------------------------

function viewAgents() {
  const agents = [...S.agents.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return h('div', { class: 'page-wrap wide' },
    h('header', { class: 'view-head row' },
      h('div', null, h('h1', null, '🛰️ Control Room'), h('p', { class: 'muted' }, 'Register agents and bots, watch them work, and steer them with commands.')),
      h('button', { class: 'btn primary', onClick: registerAgent }, '+ Register agent')),
    agents.length
      ? h('div', { class: 'agent-grid' }, agents.map(agentCard))
      : h('div', { class: 'empty-state' },
        h('div', { class: 'empty-icon' }, '🤖'),
        h('h2', null, 'No agents yet'),
        h('p', null, 'Register an agent to get a token. Any program that can make HTTP requests — or any MCP client — can then join the board.'),
        h('button', { class: 'btn primary', onClick: registerAgent }, 'Register your first agent')));
}

/** @param {Agent} a */
function agentCard(a) {
  const task = a.currentTaskId ? S.tasks.get(a.currentTaskId) : null;
  return h('div', { class: `agent-card${a.online ? '' : ' is-offline'}` },
    h('div', { class: 'agent-head' },
      avatar(a.name, `lg${a.online ? ' online' : ''}`),
      h('div', { class: 'agent-id' },
        h('a', { href: `#/agents/${a.id}`, class: 'agent-name' }, a.name),
        h('div', { class: 'agent-sub' }, h('span', { class: 'chip kind' }, a.kind), presence(a))),
    ),
    a.statusNote ? h('div', { class: 'agent-note' }, a.statusNote) : null,
    h('div', { class: 'agent-task' },
      h('span', { class: 'muted small' }, 'Current task'),
      task ? h('a', { href: '#', onClick: (/** @type {Event} */ e) => { e.preventDefault(); openTask(task.id); } }, task.title) : h('span', { class: 'muted' }, '—'),
      task && task.progress ? h('div', { class: 'progress' }, h('i', { style: { width: `${task.progress}%` } })) : null),
    a.capabilities.length ? h('div', { class: 'chips' }, a.capabilities.map(c => h('span', { class: 'chip' }, c))) : null,
    h('div', { class: 'agent-foot' },
      h('span', { class: 'muted small' }, `Seen ${ago(a.lastSeenAt)}`),
      h('span', { class: 'spacer' }),
      commandButtons(a)));
}

/** @param {Agent} a */
function commandButtons(a) {
  return h('span', { class: 'cmd-buttons' },
    a.paused
      ? h('button', { class: 'btn small', onClick: () => sendCommand(a, 'resume') }, '▶ Resume')
      : h('button', { class: 'btn small', onClick: () => sendCommand(a, 'pause') }, '⏸ Pause'),
    h('button', { class: 'btn small', onClick: () => sendCommand(a, 'message') }, '✉ Message'),
    h('button', { class: 'btn small danger-text', onClick: () => sendCommand(a, 'stop') }, '■ Stop'));
}

/**
 * @param {Agent} a
 * @param {'pause' | 'resume' | 'stop' | 'message' | 'custom'} type
 */
async function sendCommand(a, type) {
  let payload = '';
  if (type === 'message' || type === 'custom') {
    const text = await promptText({ title: `Message ${a.name}`, label: 'The agent receives this with its next heartbeat.', multiline: true, placeholder: 'e.g. Focus on the release notes first.' });
    if (!text) return;
    payload = text;
  }
  if (type === 'stop' && !(await confirmAction(`Stop ${a.name}?`, 'The agent is paused and its leased tasks return to To do.', 'Stop agent'))) return;
  const res = await attempt(api('POST', `/api/agents/${a.id}/commands`, { type, payload }));
  if (res) toast(`${type[0].toUpperCase()}${type.slice(1)} sent to ${a.name}`);
}

function registerAgent() {
  const name = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: 'e.g. research-bot', maxLength: 80 }));
  const kind = /** @type {HTMLSelectElement} */ (h('select', null, h('option', { value: 'agent' }, 'Agent — reasons with a model'), h('option', { value: 'bot' }, 'Bot — fixed automation')));
  const description = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: 'What does it do?' }));
  const caps = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: 'research, writing, reviewer' }));
  modal({
    title: 'Register an agent',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Name'), name),
      h('label', { class: 'field' }, h('span', null, 'Kind'), kind),
      h('label', { class: 'field' }, h('span', null, 'Description'), description),
      h('label', { class: 'field' }, h('span', null, 'Capabilities'), caps,
        h('small', { class: 'muted' }, 'Comma-separated. Tasks can require capabilities; "reviewer" lets an agent approve other agents’ work.'))),
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => {} },
      {
        label: 'Register', kind: 'primary',
        onClick: async () => {
          const res = await attempt(api('POST', '/api/agents', {
            name: name.value.trim(), kind: kind.value, description: description.value.trim(),
            capabilities: caps.value.split(',').map(s => s.trim()).filter(Boolean),
          }));
          if (!res) return false;
          showToken(res.agent, res.token);
          return true;
        },
      },
    ],
  });
}

/**
 * @param {Agent} agent
 * @param {string} token
 */
function showToken(agent, token) {
  const url = location.origin;
  const env = `export AGENTBOARD_URL=${url}\nexport AGENTBOARD_TOKEN=${token}`;
  const mcp = JSON.stringify({ mcpServers: { agentboard: { command: 'node', args: [S.config.mcpServerPath], env: { AGENTBOARD_URL: url, AGENTBOARD_TOKEN: token } } } }, null, 2);
  const claude = `claude mcp add agentboard -e AGENTBOARD_URL=${url} -e AGENTBOARD_TOKEN=${token} -- node ${S.config.mcpServerPath}`;
  const curl = `curl -s -X POST ${url}/api/heartbeat \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" -d '{"status":"idle"}'`;
  const snippet = (/** @type {string} */ label, /** @type {string} */ text) => h('div', { class: 'snippet' },
    h('div', { class: 'snippet-head' }, h('span', null, label), h('button', { class: 'btn small', onClick: () => copy(text) }, 'Copy')),
    h('pre', null, text));
  modal({
    title: `${agent.name} is registered`,
    wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'callout warn' }, 'Copy the token now. It is shown only once; rotate it from the agent page if it is lost.'),
      snippet('Environment', env),
      snippet('Claude Code (MCP)', claude),
      snippet('Any MCP client (JSON config)', mcp),
      snippet('Raw HTTP', curl),
      h('p', { class: 'muted small' }, 'Then try the sample bot: ', h('code', null, 'node examples/echo-bot.js'))),
    actions: [{ label: 'Done', kind: 'primary', onClick: () => {} }],
  });
}

/** @param {string} id */
function viewAgent(id) {
  const a = S.agents.get(id);
  if (!a) return h('div', { class: 'empty-state' }, h('h2', null, 'Agent not found'), h('a', { class: 'btn', href: '#/agents' }, 'Back to Control Room'));
  const tasks = [...S.tasks.values()].filter(t => t.assigneeId === id).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  const cmds = S.commands.filter(c => c.agentId === id).slice().reverse().slice(0, 30);
  const acts = S.activity.filter(x => x.actorId === id || x.agentId === id).slice().reverse().slice(0, 30);
  return h('div', { class: 'page-wrap wide' },
    h('div', { class: 'crumbs' }, h('a', { href: '#/agents' }, 'Control Room'), ' / ', a.name),
    h('header', { class: 'agent-hero' },
      avatar(a.name, `xl${a.online ? ' online' : ''}`),
      h('div', { class: 'agent-hero-main' },
        h('h1', null, a.name),
        h('div', { class: 'agent-sub' }, h('span', { class: 'chip kind' }, a.kind), presence(a), h('span', { class: 'muted small' }, `Seen ${ago(a.lastSeenAt)}`)),
        a.description ? h('p', null, a.description) : null,
        a.statusNote ? h('p', { class: 'agent-note' }, a.statusNote) : null),
      h('div', { class: 'agent-hero-actions' }, commandButtons(a),
        h('div', { class: 'cmd-buttons' },
          h('button', { class: 'btn small ghost', onClick: () => editCapabilities(a) }, 'Edit capabilities'),
          h('button', { class: 'btn small ghost', onClick: () => rotate(a) }, 'Rotate token'),
          h('button', { class: 'btn small ghost danger-text', onClick: () => removeAgent(a) }, 'Remove')))),
    h('div', { class: 'chips' }, a.capabilities.length ? a.capabilities.map(c => h('span', { class: 'chip' }, c)) : h('span', { class: 'muted small' }, 'No capabilities — can claim only tasks that require none.')),
    Object.keys(a.meta).length ? h('dl', { class: 'meta' }, Object.entries(a.meta).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, String(v))])) : null,
    h('div', { class: 'two-col' },
      h('section', null,
        h('h2', { class: 'section-title' }, `Tasks (${tasks.length})`),
        tasks.length ? h('div', { class: 'card-list' }, tasks.slice(0, 20).map(t => h('div', { class: 'card-row' }, h('span', { class: `status-pill s-${t.status}` }, STATUS_LABELS[t.status]), taskCard(t, { compact: true })))) : h('div', { class: 'empty-inline' }, 'No tasks yet.'),
        h('h2', { class: 'section-title' }, 'Commands'),
        cmds.length ? h('ul', { class: 'commands' }, cmds.map(c => h('li', null,
          h('span', { class: `chip cmd ${c.type}` }, c.type),
          c.payload ? h('span', null, c.payload) : null,
          h('span', { class: 'muted small' }, c.ackedAt ? `✓ ${c.response || 'acknowledged'} · ${ago(c.ackedAt)}` : `pending · sent ${ago(c.createdAt)}`)))) : h('div', { class: 'empty-inline' }, 'No commands sent.')),
      h('section', null, h('h2', { class: 'section-title' }, 'Activity'), activityList(acts))));
}

/** @param {Agent} a */
async function editCapabilities(a) {
  const text = await promptText({ title: `Capabilities of ${a.name}`, label: 'Comma-separated', value: a.capabilities.join(', '), confirm: 'Save' });
  if (text === null) return;
  await attempt(api('PATCH', `/api/agents/${a.id}`, { capabilities: text.split(',').map(s => s.trim()).filter(Boolean) }));
}

/** @param {Agent} a */
async function rotate(a) {
  if (!(await confirmAction(`Rotate ${a.name}'s token?`, 'The current token stops working immediately.', 'Rotate'))) return;
  const res = await attempt(api('POST', `/api/agents/${a.id}/token`));
  if (res) showToken(a, res.token);
}

/** @param {Agent} a */
async function removeAgent(a) {
  if (!(await confirmAction(`Remove ${a.name}?`, 'Its token is revoked and its tasks are unassigned.', 'Remove'))) return;
  if (await attempt(api('DELETE', `/api/agents/${a.id}`))) go('/agents');
}

// ---- pages & boards --------------------------------------------------------

/**
 * @param {HTMLElement} main
 * @param {Page} page
 * @param {Set<string>} types
 */
function renderPage(main, page, types) {
  if (!view.page || view.page.pageId !== page.id) {
    view.page?.editor.destroy();
    const editor = new PageEditor({
      blocks: page.blocks,
      version: page.version,
      save: async (blocks, baseVersion) => {
        const saved = await api('PATCH', `/api/pages/${page.id}`, { blocks, baseVersion });
        S.pages.set(saved.id, saved);
        return saved;
      },
    });
    const title = /** @type {HTMLInputElement} */ (h('input', { class: 'page-title', value: page.title, placeholder: 'Untitled', 'aria-label': 'Page title' }));
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let titleTimer;
    title.addEventListener('input', () => {
      clearTimeout(titleTimer);
      titleTimer = setTimeout(() => attempt(api('PATCH', `/api/pages/${page.id}`, { title: title.value })), 500);
    });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); editor.focusEnd(); } });
    const boardHost = page.kind === 'board' ? h('div', { class: 'board-host' }) : null;
    const root = h('div', { class: `page-wrap${page.kind === 'board' ? ' wide' : ''}` },
      h('div', { class: 'page-bar' }),
      h('div', { class: 'page-head' }, h('button', { class: 'page-icon', title: 'Change icon', onClick: (/** @type {MouseEvent} */ e) => pickIcon(page.id, /** @type {HTMLElement} */ (e.currentTarget)) }, page.icon), title),
      h('div', { class: page.kind === 'board' ? 'board-desc' : 'doc-body' }, editor.el),
      page.kind === 'doc' ? h('div', { class: 'doc-tail', onClick: () => editor.focusEnd() }) : null,
      boardHost);
    main.replaceChildren(root);
    main.scrollTop = 0;
    view.page = { pageId: page.id, editor, root, title, boardHost };
  }
  const v = view.page;
  if (document.activeElement !== v.title && v.title.value !== page.title) v.title.value = page.title;
  const icon = v.root.querySelector('.page-icon');
  if (icon && icon.textContent !== page.icon) icon.textContent = page.icon;
  v.editor.applyRemote(page);
  /** @type {HTMLElement} */ (v.root.querySelector('.page-bar')).replaceChildren(pageBar(page));
  if (v.boardHost && !S.dragging) {
    const active = document.activeElement;
    const typingInBoard = active instanceof HTMLElement && v.boardHost.contains(active) && active.matches('input, textarea, select');
    if (!typingInBoard || types.has('route')) v.boardHost.replaceChildren(boardView(page));
  }
}

/** @param {Page} page */
function pageBar(page) {
  return h('div', { class: 'page-bar-inner' },
    h('div', { class: 'crumbs' }, ancestors(page.id).map(p => [h('a', { href: `#/p/${p.id}` }, p.icon, ' ', p.title), ' / ']), h('span', null, page.title || 'Untitled')),
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted small' }, `Edited ${ago(page.updatedAt)}`),
    h('button', { class: 'icon-btn', title: 'Copy page id (for agents)', onClick: () => copy(page.id) }, '#'),
    h('button', { class: 'icon-btn', title: 'Copy as Markdown', onClick: async () => { const p = await attempt(api('GET', `/api/pages/${page.id}`)); if (p) copy(p.markdown); } }, '⧉'),
    h('button', { class: 'icon-btn', title: 'Delete page', onClick: () => deletePage(page) }, '🗑'));
}

/** @param {Page} page */
async function deletePage(page) {
  const kids = [...S.pages.values()].filter(p => p.parentId === page.id).length;
  const tasks = [...S.tasks.values()].filter(t => t.boardId === page.id).length;
  const extra = [kids ? `${kids} subpage${kids === 1 ? '' : 's'}` : '', tasks ? `${tasks} task${tasks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  if (!(await confirmAction(`Delete “${page.title}”?`, `This cannot be undone${extra ? ` and also deletes ${extra}` : ''}.`))) return;
  if (await attempt(api('DELETE', `/api/pages/${page.id}`))) go(page.parentId ? `/p/${page.parentId}` : '/home');
}

/**
 * @param {string} pageId
 * @param {HTMLElement} anchor
 */
function pickIcon(pageId, anchor) {
  document.querySelector('.icon-picker')?.remove();
  const rect = anchor.getBoundingClientRect();
  const picker = h('div', { class: 'icon-picker', style: { top: `${rect.bottom + 6}px`, left: `${rect.left}px` } },
    ICONS.map(i => h('button', { onClick: () => { picker.remove(); attempt(api('PATCH', `/api/pages/${pageId}`, { icon: i })); } }, i)));
  document.body.append(picker);
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!picker.contains(/** @type {Node} */ (e.target))) { picker.remove(); document.removeEventListener('mousedown', off); }
  }), 0);
}

/** @param {Page} board */
function boardView(board) {
  const mode = load(`agentboard.view.${board.id}`, 'kanban');
  const filter = load(`agentboard.filter.${board.id}`, '');
  const all = [...S.tasks.values()].filter(t => t.boardId === board.id);
  const tasks = all.filter(t => !filter || t.title.toLowerCase().includes(filter.toLowerCase()) || t.labels.some(l => l.toLowerCase().includes(filter.toLowerCase())) || actorName(t.assigneeId).toLowerCase().includes(filter.toLowerCase()));
  const search = /** @type {HTMLInputElement} */ (h('input', { type: 'search', class: 'board-search', placeholder: 'Filter by title, label, or agent', value: filter }));
  search.addEventListener('input', () => { save(`agentboard.filter.${board.id}`, search.value); });
  search.addEventListener('change', () => schedule('route'));
  search.addEventListener('keydown', e => { if (e.key === 'Enter') schedule('route'); });
  const toolbar = h('div', { class: 'board-toolbar' },
    h('div', { class: 'seg' },
      h('button', { class: mode === 'kanban' ? 'on' : '', onClick: () => { save(`agentboard.view.${board.id}`, 'kanban'); schedule('route'); } }, '▦ Board'),
      h('button', { class: mode === 'table' ? 'on' : '', onClick: () => { save(`agentboard.view.${board.id}`, 'table'); schedule('route'); } }, '☰ Table')),
    search,
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted small' }, `${all.length} task${all.length === 1 ? '' : 's'}`),
    h('button', { class: 'btn primary', onClick: () => quickCreate(board.id, 'todo') }, '+ New task'));
  return h('div', null, toolbar, mode === 'table' ? tableView(tasks) : kanban(board, tasks));
}

/**
 * @param {Page} board
 * @param {Task[]} tasks
 */
function kanban(board, tasks) {
  return h('div', { class: 'kanban' }, TASK_STATUSES.map(status => {
    const col = tasks.filter(t => t.status === status).sort((a, b) => a.order - b.order);
    const list = h('div', { class: 'col-cards', dataset: { status } }, col.map(t => taskCard(t)));
    const column = h('div', { class: `col s-${status}` },
      h('div', { class: 'col-head' }, h('span', { class: `status-pill s-${status}` }, STATUS_LABELS[status]), h('span', { class: 'muted small' }, String(col.length)),
        h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', title: `Add to ${STATUS_LABELS[status]}`, onClick: () => quickCreate(board.id, status) }, '+')),
      list);
    list.addEventListener('dragover', e => {
      if (!e.dataTransfer?.types.includes('text/x-task')) return;
      e.preventDefault();
      column.classList.add('drop');
      const after = [...list.querySelectorAll('.card:not(.dragging)')].find(c => e.clientY < c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2);
      let marker = list.querySelector('.drop-marker');
      if (!marker) marker = h('div', { class: 'drop-marker' });
      list.insertBefore(marker, after ?? null);
    });
    list.addEventListener('dragleave', e => {
      if (list.contains(/** @type {Node} */ (e.relatedTarget))) return;
      column.classList.remove('drop');
      list.querySelector('.drop-marker')?.remove();
    });
    list.addEventListener('drop', e => {
      e.preventDefault();
      column.classList.remove('drop');
      const id = e.dataTransfer?.getData('text/x-task');
      const marker = list.querySelector('.drop-marker');
      const next = /** @type {HTMLElement | null} */ (marker?.nextElementSibling ?? null);
      const prev = /** @type {HTMLElement | null} */ (marker?.previousElementSibling ?? null);
      marker?.remove();
      if (!id) return;
      const task = S.tasks.get(id);
      if (!task) return;
      const o = (/** @type {HTMLElement | null} */ el) => (el?.dataset.id ? S.tasks.get(el.dataset.id)?.order : undefined);
      const before = o(prev), after = o(next);
      const order = before !== undefined && after !== undefined ? (before + after) / 2 : before !== undefined ? before + 1 : after !== undefined ? after - 1 : 1;
      if (task.status === status && task.order === order) return;
      S.tasks.set(id, { ...task, status, order });
      S.dragging = false;
      schedule('local');
      attempt(api('PATCH', `/api/tasks/${id}`, { status, order })).then(t => { if (!t) attempt(api('GET', '/api/state')).then(s => { if (s) { adopt(s); schedule(); } }); });
    });
    return column;
  }));
}

/** @param {Task[]} tasks */
function tableView(tasks) {
  const rows = tasks.slice().sort((a, b) => TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status) || PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
    h('thead', null, h('tr', null, ['Task', 'Status', 'Priority', 'Assignee', 'Labels', 'Updated'].map(c => h('th', null, c)))),
    h('tbody', null, rows.map(t => h('tr', { tabIndex: 0, onClick: () => openTask(t.id), onKeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') openTask(t.id); } },
      h('td', { class: 'title-cell' }, t.title, t.needsApproval ? h('span', { class: 'chip approval' }, '🔒') : null),
      h('td', null, h('span', { class: `status-pill s-${t.status}` }, STATUS_LABELS[t.status])),
      h('td', null, h('span', { class: `chip prio ${t.priority}` }, t.priority)),
      h('td', null, t.assigneeId ? [avatar(actorName(t.assigneeId)), ' ', actorName(t.assigneeId)] : h('span', { class: 'muted' }, '—')),
      h('td', null, t.labels.map(l => h('span', { class: 'chip' }, l))),
      h('td', { class: 'muted small' }, ago(t.updatedAt))))),
    rows.length ? null : h('caption', null, 'No tasks match.')));
}

/**
 * @param {string} boardId
 * @param {string} status
 */
async function quickCreate(boardId, status) {
  const title = await promptText({ title: `New task in ${STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (status)]}`, label: 'Title', placeholder: 'What needs doing?', confirm: 'Create' });
  if (!title) return;
  const task = await attempt(api('POST', '/api/tasks', { boardId, title, status }));
  if (task) { S.tasks.set(task.id, task); openTask(task.id); }
}

// ---- task drawer -----------------------------------------------------------

/**
 * @param {string | undefined} taskId
 * @param {Set<string>} types
 */
function renderDrawer(taskId, types) {
  const host = /** @type {HTMLElement} */ (document.getElementById('drawer'));
  const task = taskId ? S.tasks.get(taskId) : undefined;
  if (!task) { host.replaceChildren(); host.classList.remove('open'); return; }
  const active = document.activeElement;
  const typing = active instanceof HTMLElement && host.contains(active) && active.matches('input, textarea, select');
  if (typing && host.dataset.task === task.id && !types.has('route')) { view.drawerStale = true; return; }
  view.drawerStale = false;
  const scroll = host.querySelector('.drawer-body')?.scrollTop ?? 0;
  host.dataset.task = task.id;
  host.classList.add('open');
  host.replaceChildren(drawer(task));
  const body = host.querySelector('.drawer-body');
  if (body) body.scrollTop = scroll;
}

/**
 * @param {Task} t
 * @param {Record<string, unknown>} patch
 */
function patchTask(t, patch) {
  return attempt(api('PATCH', `/api/tasks/${t.id}`, patch).then(saved => { S.tasks.set(saved.id, saved); return saved; }));
}

/** @param {Task} t */
function drawer(t) {
  const board = S.pages.get(t.boardId);
  const comments = S.comments.filter(c => c.taskId === t.id);
  const agents = [...S.agents.values()];
  const select = (/** @type {string} */ value, /** @type {Array<[string, string]>} */ opts, /** @type {(v: string) => void} */ onChange) => {
    const el = /** @type {HTMLSelectElement} */ (h('select', null, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };
  const title = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'drawer-title', rows: 1, value: t.title, 'aria-label': 'Task title' }));
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { if (title.value.trim() && title.value !== t.title) patchTask(t, { title: title.value.trim() }); else flushStale(); });
  const desc = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'desc', rows: 5, value: t.description, placeholder: 'Describe the task. Agents read this as Markdown.' }));
  desc.addEventListener('blur', () => { if (desc.value !== t.description) patchTask(t, { description: desc.value }); else flushStale(); });
  const listInput = (/** @type {string[]} */ values, /** @type {string} */ field, /** @type {string} */ ph) => {
    const el = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: values.join(', '), placeholder: ph }));
    el.addEventListener('blur', () => {
      const next = el.value.split(',').map(s => s.trim()).filter(Boolean);
      if (next.join(',') !== values.join(',')) patchTask(t, { [field]: next }); else flushStale();
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
    return el;
  };
  const approval = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: t.needsApproval }));
  approval.addEventListener('change', () => patchTask(t, { needsApproval: approval.checked }));

  const composer = /** @type {HTMLTextAreaElement} */ (h('textarea', { rows: 2, placeholder: t.status === 'blocked' ? 'Answer the question…' : 'Leave a comment for the agent…' }));
  const postComment = async (/** @type {boolean} */ unblock) => {
    const text = composer.value.trim();
    if (!text) return;
    composer.value = '';
    await attempt(api('POST', `/api/tasks/${t.id}/comments`, { text }));
    if (unblock) await patchTask(t, { status: 'todo' });
    flushStale();
  };
  composer.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) postComment(t.status === 'blocked'); });

  const kindIcon = /** @type {Record<string, string>} */ ({ comment: '💬', progress: '📈', question: '❓', log: '🧾', system: '⚙' });
  return h('aside', { class: 'drawer-panel', 'aria-label': 'Task details' },
    h('div', { class: 'drawer-head' },
      h('span', { class: 'muted small' }, board ? h('a', { href: `#/p/${board.id}` }, board.icon, ' ', board.title) : null),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Copy task id', onClick: () => copy(t.id) }, '#'),
      h('button', { class: 'icon-btn', title: 'Delete task', onClick: async () => { if (await confirmAction('Delete this task?', t.title)) { if (await attempt(api('DELETE', `/api/tasks/${t.id}`))) openTask(null); } } }, '🗑'),
      h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onClick: () => openTask(null) }, '✕')),
    h('div', { class: 'drawer-body' },
      title,
      t.status === 'review' && t.approval?.state === 'pending' ? h('div', { class: 'approval-box' },
        h('div', null, h('strong', null, 'Awaiting your approval'), h('div', { class: 'muted small' }, `${actorName(t.assigneeId)} submitted this for review.`)),
        h('div', { class: 'cmd-buttons' },
          h('button', { class: 'btn primary', onClick: () => review(t, 'approve') }, 'Approve'),
          h('button', { class: 'btn ghost', onClick: () => review(t, 'reject') }, 'Request changes'))) : null,
      t.lease ? h('div', { class: 'lease-box' }, '⚡ ', h('strong', null, actorName(t.lease.agentId)), ` is working on this · lease renews with heartbeats, expires ${until(t.lease.expiresAt)}`,
        h('button', { class: 'btn small ghost', onClick: () => attempt(api('POST', `/api/tasks/${t.id}/release`, { note: 'Released by the operator' })) }, 'Release')) : null,
      h('div', { class: 'props' },
        h('label', null, 'Status'), select(t.status, TASK_STATUSES.map(s => [s, STATUS_LABELS[s]]), v => patchTask(t, { status: v })),
        h('label', null, 'Priority'), select(t.priority, PRIORITIES.map(p => [p, p[0].toUpperCase() + p.slice(1)]), v => patchTask(t, { priority: v })),
        h('label', null, 'Assignee'), select(t.assigneeId ?? '', [['', 'Unassigned — any agent can claim'], ...agents.map(a => /** @type {[string, string]} */ ([a.id, `${a.name}${a.online ? ' ●' : ''}`]))], v => patchTask(t, { assigneeId: v || null })),
        h('label', null, 'Labels'), listInput(t.labels, 'labels', 'bug, docs'),
        h('label', { title: 'Only agents with all of these capabilities can claim the task' }, 'Requires'), listInput(t.requiredCapabilities, 'requiredCapabilities', 'capabilities an agent must have'),
        h('label', null, 'Approval'), h('label', { class: 'toggle' }, approval, h('span', null, 'Hold in Review until approved')),
        t.progress ? [h('label', null, 'Progress'), h('div', { class: 'progress big' }, h('i', { style: { width: `${t.progress}%` } }), h('span', null, `${t.progress}%`))] : null,
        h('label', null, 'Created'), h('span', { class: 'muted small' }, `${actorName(t.createdBy)} · ${ago(t.createdAt)}`)),
      h('h3', { class: 'drawer-section' }, 'Description'), desc,
      t.result ? [h('h3', { class: 'drawer-section' }, 'Result'), h('div', { class: 'result prose', html: markdownToHtml(t.result) })] : null,
      h('h3', { class: 'drawer-section' }, `Timeline (${comments.length})`),
      h('ul', { class: 'timeline' }, comments.map(c => h('li', { class: `tl-${c.kind}` },
        actorAvatar(c.authorId),
        h('div', { class: 'tl-body' },
          h('div', { class: 'tl-head' }, h('strong', null, actorName(c.authorId)), h('span', { class: 'tl-kind' }, kindIcon[c.kind], ' ', c.kind), h('span', { class: 'muted small' }, ago(c.at))),
          h('div', { class: 'prose', html: markdownToHtml(c.text) }))))),
      h('div', { class: 'composer' }, composer,
        h('div', { class: 'cmd-buttons' },
          t.status === 'blocked' ? h('button', { class: 'btn primary', onClick: () => postComment(true) }, 'Reply & unblock') : null,
          h('button', { class: `btn ${t.status === 'blocked' ? 'ghost' : 'primary'}`, onClick: () => postComment(false) }, 'Comment'),
          h('span', { class: 'muted small' }, '⌘/Ctrl + Enter')))));
}

function flushStale() {
  setTimeout(() => {
    if (view.drawerStale || view.mainStale) schedule('local');
  }, 0);
}

// ---- auth & boot -------------------------------------------------------------

/** @param {string} [message] */
function signOut(message) {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: nothing persisted to remove */ }
  S.token = null;
  events?.close();
  showLogin(message);
}

/** @param {string} [message] */
function showLogin(message) {
  document.body.classList.add('logged-out');
  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'password', placeholder: 'admin_…', autocomplete: 'current-password', 'aria-label': 'Admin token' }));
  const error = h('div', { class: 'login-error', role: 'alert' }, message ?? '');
  const submit = async (/** @type {Event} */ e) => {
    e.preventDefault();
    const ok = await start(input.value.trim(), error);
    if (!ok) input.select();
  };
  /** @type {HTMLElement} */ (document.getElementById('login')).replaceChildren(h('form', { class: 'login-card', onSubmit: submit },
    h('div', { class: 'ws-logo big' }, '◆'),
    h('h1', null, 'Agentboard'),
    h('p', { class: 'muted' }, 'The open workspace where people and agents get work done together.'),
    h('label', { class: 'field' }, h('span', null, 'Admin token'), input),
    error,
    h('button', { class: 'btn primary wide', type: 'submit' }, 'Open the board'),
    h('p', { class: 'muted small' }, 'The server prints a sign-in link on startup. The token is also in ', h('code', null, '.agentboard/admin-token'), '.')));
  input.focus();
}

/**
 * @param {string} token
 * @param {HTMLElement | null} errorEl
 * @returns {Promise<boolean>}
 */
async function start(token, errorEl) {
  if (!token) return false;
  S.token = token;
  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('That token was not accepted.');
    const me = await res.json();
    if (me.role !== 'operator') throw new Error(`That token belongs to agent ${me.agent?.name ?? me.id}. Use the admin token to open the board.`);
    adopt(await api('GET', '/api/state'));
  } catch (err) {
    S.token = null;
    if (errorEl) errorEl.textContent = /** @type {Error} */ (err).message;
    else showLogin(/** @type {Error} */ (err).message);
    return false;
  }
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage blocked: sign-in lasts for this tab only */ }
  document.body.classList.remove('logged-out');
  connect();
  schedule('route');
  return true;
}

const theme = load('agentboard.theme', null);
if (theme) document.documentElement.dataset.theme = theme;

addEventListener('hashchange', () => schedule('route'));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && route().task && !document.querySelector('.overlay, .slash-menu, .icon-picker')) openTask(null);
});
document.addEventListener('focusout', () => flushStale());
setInterval(() => { if (!document.hidden) schedule('tick'); }, 15000);
addEventListener('beforeunload', () => { view.page?.editor.flush(); });

const hashToken = /[#&]token=([^&]+)/.exec(location.hash)?.[1];
if (hashToken) history.replaceState(null, '', `${location.pathname}#/home`);
const stored = hashToken ? decodeURIComponent(hashToken) : (() => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } // storage blocked: no remembered token
})();
if (stored) start(stored, null); else showLogin();
