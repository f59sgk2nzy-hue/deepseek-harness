// @ts-check
/**
 * Authoritative board state: pages, task boards, agents, commands, and the
 * activity log. Every mutation goes through a `Store` method, which validates
 * input, checks the acting principal's permissions, appends an activity entry,
 * emits a change event for live subscribers, and schedules a durable save.
 *
 * Persistence is a single JSON document written atomically (temp file + rename).
 * The document carries `schemaVersion`; a file with any other version is
 * refused at load instead of being migrated or silently reset.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { newId, normalizeBlocks, markdownToBlocks } from '../shared/markdown.js';
import {
  TASK_STATUSES, PRIORITIES, AGENT_KINDS, REPORTABLE_AGENT_STATUSES, COMMAND_TYPES,
  COMMENT_KINDS, OPERATOR_ID, SYSTEM_ID,
} from '../shared/model.js';
import { seedState } from './seed.js';

/**
 * @typedef {import('../shared/model.js').Page} Page
 * @typedef {import('../shared/model.js').Task} Task
 * @typedef {import('../shared/model.js').Agent} Agent
 * @typedef {import('../shared/model.js').Comment} Comment
 * @typedef {import('../shared/model.js').Command} Command
 * @typedef {import('../shared/model.js').Activity} Activity
 * @typedef {Agent & { tokenHash: string }} StoredAgent
 * @typedef {{ role: 'operator', id: string } | { role: 'agent', id: string, agent: StoredAgent }} Actor
 * @typedef {{
 *   schemaVersion: number, workspace: { name: string },
 *   pages: Page[], tasks: Task[], comments: Comment[], agents: StoredAgent[],
 *   commands: Command[], activity: Activity[],
 * }} PersistedState
 * @typedef {{ type: string, data: unknown }} BoardEvent
 */

/** On-disk format version. Increment on any incompatible change; older files are refused. */
export const SCHEMA_VERSION = 1;

const MAX_ACTIVITY = 2000;
const MAX_ACKED_COMMANDS = 2000;

/** An error that carries the HTTP status the API should answer with. */
export class BoardError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message client-facing explanation
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The operator principal: whoever holds the admin token. */
export const OPERATOR = /** @type {Actor} */ ({ role: 'operator', id: OPERATOR_ID });

/**
 * @param {string} token
 * @returns {string} hex SHA-256 digest; tokens are stored only as digests
 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** @returns {string} a new agent bearer token */
function mintToken() {
  return `ab_${randomBytes(24).toString('base64url')}`;
}

// ---- input validation (HTTP/MCP JSON is untrusted) -------------------------

/**
 * @param {unknown} v
 * @param {string} field
 * @param {{ max?: number, required?: boolean, fallback?: string }} [opts]
 * @returns {string}
 */
function str(v, field, { max = 500, required = false, fallback = '' } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new BoardError(400, `${field} is required`);
    return fallback;
  }
  if (typeof v !== 'string') throw new BoardError(400, `${field} must be a string`);
  if (required && v.trim() === '') throw new BoardError(400, `${field} must not be empty`);
  if (v.length > max) throw new BoardError(400, `${field} exceeds ${max} characters`);
  return v;
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {string[]}
 */
function strList(v, field) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || x.length > 64)) {
    throw new BoardError(400, `${field} must be an array of strings (max 64 chars each)`);
  }
  if (v.length > 50) throw new BoardError(400, `${field} holds at most 50 entries`);
  return [...new Set(v.map(x => x.trim()).filter(Boolean))];
}

/**
 * @template {string} T
 * @param {unknown} v
 * @param {readonly T[]} allowed
 * @param {string} field
 * @returns {T}
 */
function oneOf(v, allowed, field) {
  if (typeof v !== 'string' || !allowed.includes(/** @type {T} */ (v))) {
    throw new BoardError(400, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return /** @type {T} */ (v);
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {boolean}
 */
function bool(v, field) {
  if (typeof v !== 'boolean') throw new BoardError(400, `${field} must be a boolean`);
  return v;
}

/**
 * @param {unknown} v
 * @returns {Record<string, string | number | boolean>}
 */
function meta(v) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new BoardError(400, 'meta must be an object');
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  const entries = Object.entries(v);
  if (entries.length > 32) throw new BoardError(400, 'meta holds at most 32 keys');
  for (const [k, val] of entries) {
    if (k.length > 64) throw new BoardError(400, 'meta keys are at most 64 characters');
    if (typeof val === 'string') out[k] = val.slice(0, 500);
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val;
    else throw new BoardError(400, `meta.${k} must be a string, number, or boolean`);
  }
  return out;
}

/**
 * Accepts either `blocks` (block JSON) or `markdown` from a request body.
 * @param {Record<string, unknown>} body
 * @returns {import('../shared/markdown.js').Block[] | undefined}
 */
function blocksFrom(body) {
  if (body.blocks !== undefined) {
    try { return normalizeBlocks(body.blocks); } catch (err) { throw new BoardError(400, /** @type {Error} */ (err).message); }
  }
  if (body.markdown !== undefined) return markdownToBlocks(str(body.markdown, 'markdown', { max: 500_000 }));
  return undefined;
}

// ---- the store --------------------------------------------------------------

export class Store {
  /**
   * @param {{ file: string | null, leaseMs: number, presenceMs: number, now?: () => number }} opts
   *   `file: null` keeps state in memory only (tests, demos).
   */
  constructor({ file, leaseMs, presenceMs, now = Date.now }) {
    this.file = file;
    this.leaseMs = leaseMs;
    this.presenceMs = presenceMs;
    this.now = now;
    /** @type {Set<(event: BoardEvent) => void>} */
    this.listeners = new Set();
    /** @type {PersistedState} */
    this.state = this.#load();
    /** @type {Map<string, string>} token digest → agent id */
    this.tokenIndex = new Map(this.state.agents.map(a => [a.tokenHash, a.id]));
    /** @type {NodeJS.Timeout | null} */
    this.saveTimer = null;
    /** @type {Promise<void>} */
    this.saving = Promise.resolve();
  }

  /** @returns {PersistedState} */
  #load() {
    if (this.file && existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed?.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(
          `${this.file} has schemaVersion ${JSON.stringify(parsed?.schemaVersion)}; this build reads only version ${SCHEMA_VERSION}. ` +
          'Move the file aside to start a fresh board.',
        );
      }
      return parsed;
    }
    const state = seedState(this.#iso());
    if (this.file) this.#writeSync(state);
    return state;
  }

  /** @returns {string} the current time as ISO-8601 */
  #iso() {
    return new Date(this.now()).toISOString();
  }

  // ---- persistence & events -------------------------------------------------

  /**
   * Subscribes to change events.
   * @param {(event: BoardEvent) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * @param {string} type
   * @param {unknown} data
   */
  #emit(type, data) {
    for (const fn of this.listeners) fn({ type, data });
  }

  /**
   * Records an activity entry, emits it with the change event, and schedules a save.
   * @param {Actor} actor
   * @param {string} type event type, e.g. `task.updated`
   * @param {unknown} data the changed record (public view)
   * @param {string | null} summary activity text; `null` changes state without an activity entry
   * @param {Partial<Pick<Activity, 'pageId' | 'taskId' | 'agentId'>>} [refs]
   */
  #commit(actor, type, data, summary, refs = {}) {
    this.#emit(type, data);
    if (summary !== null) {
      /** @type {Activity} */
      const entry = { id: newId('act'), at: this.#iso(), actorId: actor.id, type, summary, ...refs };
      this.state.activity.push(entry);
      if (this.state.activity.length > MAX_ACTIVITY) this.state.activity.splice(0, this.state.activity.length - MAX_ACTIVITY);
      this.#emit('activity.created', entry);
    }
    this.#scheduleSave();
  }

  #scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const json = JSON.stringify(this.state);
      const file = /** @type {string} */ (this.file);
      this.saving = this.saving.then(async () => {
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, json, { mode: 0o600 });
        await rename(tmp, file);
      }).catch(err => { console.error('agentboard: failed to save state:', err); });
    }, 100);
    this.saveTimer.unref?.();
  }

  /** @param {PersistedState} state */
  #writeSync(state) {
    const file = /** @type {string} */ (this.file);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
  }

  /**
   * Writes pending changes synchronously. Call before process exit.
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    await this.saving;
    if (this.file) this.#writeSync(this.state);
  }

  // ---- views ---------------------------------------------------------------

  /**
   * @param {StoredAgent} a
   * @returns {Agent & { online: boolean }}
   */
  publicAgent(a) {
    const { tokenHash: _digest, ...rest } = a;
    const online = a.lastSeenAt !== null && this.now() - Date.parse(a.lastSeenAt) < this.presenceMs;
    return { ...rest, online, status: online ? a.status : 'offline' };
  }

  /** @returns {object} everything the UI needs to render, without secrets */
  snapshot() {
    const s = this.state;
    return {
      workspace: s.workspace,
      pages: s.pages,
      tasks: s.tasks,
      comments: s.comments,
      agents: s.agents.map(a => this.publicAgent(a)),
      commands: s.commands,
      activity: s.activity.slice(-300),
      config: { leaseMs: this.leaseMs, presenceMs: this.presenceMs },
    };
  }

  // ---- auth ----------------------------------------------------------------

  /**
   * @param {string} token
   * @returns {Actor | null} the agent principal holding `token`
   */
  authenticateAgent(token) {
    const id = this.tokenIndex.get(hashToken(token));
    const agent = id ? this.state.agents.find(a => a.id === id) : undefined;
    return agent ? { role: 'agent', id: agent.id, agent } : null;
  }

  /** @param {Actor} actor */
  #requireOperator(actor) {
    if (actor.role !== 'operator') throw new BoardError(403, 'only the operator can do this');
  }

  // ---- pages ---------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {Page}
   */
  getPage(id) {
    const page = this.state.pages.find(p => p.id === id);
    if (!page) throw new BoardError(404, `page ${id} not found`);
    return page;
  }

  /**
   * @param {Actor} actor
   * @param {Record<string, unknown>} body `{ title, icon?, kind?, parentId?, blocks? | markdown? }`
   * @returns {Page}
   */
  createPage(actor, body) {
    const parentId = body.parentId == null ? null : str(body.parentId, 'parentId', { max: 64 });
    if (parentId) this.getPage(parentId);
    const at = this.#iso();
    /** @type {Page} */
    const page = {
      id: newId('pg'),
      parentId,
      title: str(body.title, 'title', { max: 200, fallback: 'Untitled' }) || 'Untitled',
      icon: str(body.icon, 'icon', { max: 8, fallback: body.kind === 'board' ? '📋' : '📄' }),
      kind: body.kind === undefined ? 'doc' : oneOf(body.kind, /** @type {const} */ (['doc', 'board']), 'kind'),
      blocks: blocksFrom(body) ?? [],
      version: 1,
      createdBy: actor.id,
      createdAt: at,
      updatedAt: at,
    };
    this.state.pages.push(page);
    this.#commit(actor, 'page.created', page, `created ${page.kind === 'board' ? 'board' : 'page'} “${page.title}”`, { pageId: page.id });
    return page;
  }

  /**
   * Updates page fields. When `blocks` is given with `baseVersion` and the page has
   * moved on, the update is refused with 409 so the caller can merge and retry.
   * @param {Actor} actor
   * @param {string} id
   * @param {Record<string, unknown>} body `{ title?, icon?, parentId?, blocks? | markdown?, baseVersion? }`
   * @returns {Page}
   */
  updatePage(actor, id, body) {
    const page = this.getPage(id);
    const blocks = blocksFrom(body);
    if (blocks && body.baseVersion !== undefined && body.baseVersion !== page.version) {
      throw Object.assign(new BoardError(409, 'page changed since baseVersion'), { current: page });
    }
    if (body.parentId !== undefined) {
      const parentId = body.parentId === null ? null : str(body.parentId, 'parentId', { max: 64 });
      for (let p = parentId; p; p = this.getPage(p).parentId) {
        if (p === id) throw new BoardError(400, 'a page cannot be nested inside itself');
      }
      page.parentId = parentId;
    }
    if (body.title !== undefined) page.title = str(body.title, 'title', { max: 200 }) || 'Untitled';
    if (body.icon !== undefined) page.icon = str(body.icon, 'icon', { max: 8 });
    if (blocks) page.blocks = blocks;
    page.version++;
    page.updatedAt = this.#iso();
    // Keystroke-level edits would flood the feed; only structural edits are logged.
    const summary = blocks && body.title === undefined && body.parentId === undefined ? null : `updated “${page.title}”`;
    this.#commit(actor, 'page.updated', page, actor.role === 'agent' && blocks ? `edited “${page.title}”` : summary, { pageId: id });
    return page;
  }

  /**
   * Appends blocks to the end of a page; never conflicts. The agent-friendly write.
   * @param {Actor} actor
   * @param {string} id
   * @param {Record<string, unknown>} body `{ blocks } | { markdown }`
   * @returns {Page}
   */
  appendToPage(actor, id, body) {
    const page = this.getPage(id);
    const blocks = blocksFrom(body);
    if (!blocks) throw new BoardError(400, 'blocks or markdown is required');
    page.blocks.push(...blocks);
    page.version++;
    page.updatedAt = this.#iso();
    this.#commit(actor, 'page.updated', page, `added ${blocks.length} block${blocks.length === 1 ? '' : 's'} to “${page.title}”`, { pageId: id });
    return page;
  }

  /**
   * Deletes a page, its descendants, and tasks on any deleted board. Agents may
   * delete only pages they created.
   * @param {Actor} actor
   * @param {string} id
   */
  deletePage(actor, id) {
    const page = this.getPage(id);
    if (actor.role === 'agent' && page.createdBy !== actor.id) throw new BoardError(403, 'agents can delete only pages they created');
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of this.state.pages) if (p.parentId && doomed.has(p.parentId) && !doomed.has(p.id)) { doomed.add(p.id); grew = true; }
    }
    const doomedTasks = new Set(this.state.tasks.filter(t => doomed.has(t.boardId)).map(t => t.id));
    this.state.pages = this.state.pages.filter(p => !doomed.has(p.id));
    this.state.tasks = this.state.tasks.filter(t => !doomedTasks.has(t.id));
    this.state.comments = this.state.comments.filter(c => !doomedTasks.has(c.taskId));
    for (const a of this.state.agents) if (a.currentTaskId && doomedTasks.has(a.currentTaskId)) a.currentTaskId = null;
    for (const taskId of doomedTasks) this.#emit('task.deleted', { id: taskId });
    for (const pageId of doomed) if (pageId !== id) this.#emit('page.deleted', { id: pageId });
    this.#commit(actor, 'page.deleted', { id }, `deleted “${page.title}”`);
  }

  // ---- tasks ---------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {Task}
   */
  getTask(id) {
    const task = this.state.tasks.find(t => t.id === id);
    if (!task) throw new BoardError(404, `task ${id} not found`);
    return task;
  }

  /**
   * @param {{ boardId?: string, status?: string, assigneeId?: string }} filter
   * @returns {Task[]}
   */
  listTasks(filter) {
    return this.state.tasks.filter(t =>
      (!filter.boardId || t.boardId === filter.boardId) &&
      (!filter.status || t.status === filter.status) &&
      (!filter.assigneeId || t.assigneeId === filter.assigneeId));
  }

  /**
   * @param {string} boardId
   * @param {string} status
   * @returns {number} an order value that sorts after every task in the column
   */
  #nextOrder(boardId, status) {
    let max = 0;
    for (const t of this.state.tasks) if (t.boardId === boardId && t.status === status) max = Math.max(max, t.order);
    return max + 1;
  }

  /**
   * @param {string} id
   * @returns {StoredAgent}
   */
  #agent(id) {
    const agent = this.state.agents.find(a => a.id === id);
    if (!agent) throw new BoardError(404, `agent ${id} not found`);
    return agent;
  }

  /**
   * @param {Actor} actor
   * @param {Record<string, unknown>} body
   * @returns {Task}
   */
  createTask(actor, body) {
    const boardId = str(body.boardId, 'boardId', { required: true, max: 64 });
    const board = this.getPage(boardId);
    if (board.kind !== 'board') throw new BoardError(400, `page ${boardId} is not a board`);
    const status = body.status === undefined ? 'todo' : oneOf(body.status, TASK_STATUSES, 'status');
    const assigneeId = body.assigneeId == null ? null : this.#agent(str(body.assigneeId, 'assigneeId', { max: 64 })).id;
    const at = this.#iso();
    /** @type {Task} */
    const task = {
      id: newId('tsk'),
      boardId,
      title: str(body.title, 'title', { required: true, max: 300 }),
      description: str(body.description, 'description', { max: 50_000 }),
      status,
      priority: body.priority === undefined ? 'normal' : oneOf(body.priority, PRIORITIES, 'priority'),
      labels: strList(body.labels, 'labels'),
      requiredCapabilities: strList(body.requiredCapabilities, 'requiredCapabilities'),
      assigneeId,
      lease: null,
      needsApproval: body.needsApproval === undefined ? false : bool(body.needsApproval, 'needsApproval'),
      approval: null,
      progress: 0,
      result: '',
      order: this.#nextOrder(boardId, status),
      createdBy: actor.id,
      createdAt: at,
      updatedAt: at,
    };
    this.state.tasks.push(task);
    this.#commit(actor, 'task.created', task, `created task “${task.title}” on ${board.title}`, { taskId: task.id, pageId: boardId });
    return task;
  }

  /**
   * @param {Actor} actor
   * @param {Task} task
   */
  #requireTaskWrite(actor, task) {
    if (actor.role === 'operator') return;
    if (task.assigneeId === actor.id || (task.assigneeId === null && task.createdBy === actor.id)) return;
    throw new BoardError(403, 'agents can change only tasks assigned to them or unassigned tasks they created');
  }

  /**
   * @param {Task} task
   */
  #refreshLease(task) {
    if (task.lease) task.lease.expiresAt = new Date(this.now() + this.leaseMs).toISOString();
  }

  /**
   * Updates task fields. Agents may change status (except to `done` on approval-gated
   * tasks), progress, and descriptive fields of tasks they own; only the operator
   * reassigns tasks or toggles approval gating.
   * @param {Actor} actor
   * @param {string} id
   * @param {Record<string, unknown>} body
   * @returns {Task}
   */
  updateTask(actor, id, body) {
    const task = this.getTask(id);
    this.#requireTaskWrite(actor, task);
    /** @type {string[]} */
    const changes = [];
    if (body.title !== undefined) { task.title = str(body.title, 'title', { required: true, max: 300 }); changes.push('title'); }
    if (body.description !== undefined) { task.description = str(body.description, 'description', { max: 50_000 }); changes.push('description'); }
    if (body.priority !== undefined) { task.priority = oneOf(body.priority, PRIORITIES, 'priority'); changes.push(`priority → ${task.priority}`); }
    if (body.labels !== undefined) { task.labels = strList(body.labels, 'labels'); changes.push('labels'); }
    if (body.requiredCapabilities !== undefined) { task.requiredCapabilities = strList(body.requiredCapabilities, 'requiredCapabilities'); changes.push('capabilities'); }
    if (body.result !== undefined) { task.result = str(body.result, 'result', { max: 200_000 }); changes.push('result'); }
    if (body.progress !== undefined) {
      if (typeof body.progress !== 'number' || !(body.progress >= 0 && body.progress <= 100)) throw new BoardError(400, 'progress must be a number from 0 to 100');
      task.progress = Math.round(body.progress);
    }
    if (body.needsApproval !== undefined) {
      this.#requireOperator(actor);
      task.needsApproval = bool(body.needsApproval, 'needsApproval');
      changes.push(task.needsApproval ? 'requires approval' : 'no approval needed');
    }
    if (body.assigneeId !== undefined) {
      this.#requireOperator(actor);
      const next = body.assigneeId === null ? null : this.#agent(str(body.assigneeId, 'assigneeId', { max: 64 })).id;
      if (next !== task.assigneeId) {
        if (task.lease && task.lease.agentId !== next) this.#dropLease(task);
        task.assigneeId = next;
        changes.push(next ? `assigned to ${this.#agent(next).name}` : 'unassigned');
      }
    }
    if (body.status !== undefined) {
      const status = oneOf(body.status, TASK_STATUSES, 'status');
      if (status === 'done' && task.needsApproval && task.approval?.state !== 'approved' && actor.role === 'agent') {
        throw new BoardError(409, 'this task requires approval; call complete to submit it for review');
      }
      if (status !== task.status) {
        task.status = status;
        if (status !== 'in_progress' && task.lease) this.#dropLease(task);
        changes.push(`moved to ${status.replace('_', ' ')}`);
      }
    }
    if (body.order !== undefined) {
      if (typeof body.order !== 'number' || !Number.isFinite(body.order)) throw new BoardError(400, 'order must be a finite number');
      task.order = body.order;
    } else if (body.status !== undefined && changes.some(c => c.startsWith('moved'))) {
      task.order = this.#nextOrder(task.boardId, task.status);
    }
    if (actor.role === 'agent') this.#refreshLease(task);
    task.updatedAt = this.#iso();
    this.#commit(actor, 'task.updated', task, changes.length ? `${changes.join(', ')} — “${task.title}”` : null, { taskId: id, pageId: task.boardId });
    return task;
  }

  /** @param {Task} task */
  #dropLease(task) {
    const holder = task.lease && this.state.agents.find(a => a.id === task.lease?.agentId);
    if (holder && holder.currentTaskId === task.id) {
      holder.currentTaskId = null;
      this.#emit('agent.updated', this.publicAgent(holder));
    }
    task.lease = null;
  }

  /**
   * @param {Actor} actor
   * @param {string} id
   */
  deleteTask(actor, id) {
    const task = this.getTask(id);
    if (actor.role === 'agent' && task.createdBy !== actor.id) throw new BoardError(403, 'agents can delete only tasks they created');
    this.#dropLease(task);
    this.state.tasks = this.state.tasks.filter(t => t.id !== id);
    this.state.comments = this.state.comments.filter(c => c.taskId !== id);
    this.#commit(actor, 'task.deleted', { id }, `deleted task “${task.title}”`, { pageId: task.boardId });
  }

  /**
   * @param {StoredAgent} agent
   * @param {Task} task
   * @returns {string | null} why `agent` cannot claim `task`, or null when it can
   */
  #claimBlocker(agent, task) {
    if (task.status !== 'todo' && task.status !== 'backlog') return `task is ${task.status}`;
    if (task.lease) return 'task is leased by another agent';
    if (task.assigneeId && task.assigneeId !== agent.id) return 'task is assigned to another agent';
    const missing = task.requiredCapabilities.filter(c => !agent.capabilities.includes(c));
    if (missing.length) return `agent lacks capabilities: ${missing.join(', ')}`;
    return null;
  }

  /**
   * Leases a task to an agent. With `taskId`, claims that task; otherwise claims the
   * best eligible `todo` task (assigned-to-me first, then priority, then column order).
   * @param {Actor} actor must be an agent
   * @param {Record<string, unknown>} body `{ taskId?, boardId? }`
   * @returns {Task | null} the claimed task, or null when nothing is eligible
   */
  claimTask(actor, body) {
    if (actor.role !== 'agent') throw new BoardError(403, 'only agents claim tasks');
    const agent = actor.agent;
    if (agent.paused) throw new BoardError(409, 'agent is paused by the operator');
    /** @type {Task | undefined} */
    let task;
    if (body.taskId !== undefined) {
      task = this.getTask(str(body.taskId, 'taskId', { max: 64 }));
      const blocker = this.#claimBlocker(agent, task);
      if (blocker) throw new BoardError(409, `cannot claim: ${blocker}`);
    } else {
      const boardId = body.boardId === undefined ? undefined : str(body.boardId, 'boardId', { max: 64 });
      const rank = (/** @type {Task} */ t) => [t.assigneeId === agent.id ? 0 : 1, -PRIORITIES.indexOf(t.priority), t.order, Date.parse(t.createdAt)];
      task = this.state.tasks
        .filter(t => t.status === 'todo' && (!boardId || t.boardId === boardId) && this.#claimBlocker(agent, t) === null)
        .sort((a, b) => {
          const ra = rank(a), rb = rank(b);
          for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
          return 0;
        })[0];
      if (!task) return null;
    }
    task.lease = { agentId: agent.id, expiresAt: new Date(this.now() + this.leaseMs).toISOString() };
    task.assigneeId = agent.id;
    task.status = 'in_progress';
    task.order = this.#nextOrder(task.boardId, 'in_progress');
    task.updatedAt = this.#iso();
    agent.currentTaskId = task.id;
    agent.status = 'working';
    agent.lastSeenAt = this.#iso();
    this.#emit('agent.updated', this.publicAgent(agent));
    this.#commit(actor, 'task.updated', task, `claimed “${task.title}”`, { taskId: task.id, pageId: task.boardId, agentId: agent.id });
    return task;
  }

  /**
   * Returns a leased task to `todo` and unassigns it.
   * @param {Actor} actor the lease holder or the operator
   * @param {string} id
   * @param {Record<string, unknown>} body `{ note? }`
   * @returns {Task}
   */
  releaseTask(actor, id, body) {
    const task = this.getTask(id);
    if (actor.role === 'agent' && task.assigneeId !== actor.id) throw new BoardError(403, 'only the assignee can release this task');
    const note = str(body.note, 'note', { max: 5000 });
    this.#dropLease(task);
    task.status = 'todo';
    task.assigneeId = null;
    task.order = this.#nextOrder(task.boardId, 'todo');
    task.updatedAt = this.#iso();
    if (note) this.#pushComment(actor.id, task.id, 'system', `Released: ${note}`);
    this.#commit(actor, 'task.updated', task, `released “${task.title}”${note ? `: ${note}` : ''}`, { taskId: id, pageId: task.boardId });
    return task;
  }

  /**
   * Finishes a task. Approval-gated tasks move to `review` with a pending approval;
   * others move to `done`.
   * @param {Actor} actor the assignee or the operator
   * @param {string} id
   * @param {Record<string, unknown>} body `{ result? }` Markdown
   * @returns {Task}
   */
  completeTask(actor, id, body) {
    const task = this.getTask(id);
    if (actor.role === 'agent' && task.assigneeId !== actor.id) throw new BoardError(403, 'only the assignee can complete this task');
    if (body.result !== undefined) task.result = str(body.result, 'result', { max: 200_000 });
    this.#dropLease(task);
    task.progress = 100;
    if (task.needsApproval && actor.role === 'agent') {
      task.status = 'review';
      task.approval = { state: 'pending', by: null, note: '', at: null };
    } else {
      task.status = 'done';
    }
    task.order = this.#nextOrder(task.boardId, task.status);
    task.updatedAt = this.#iso();
    if (actor.role === 'agent') {
      actor.agent.status = 'idle';
      this.#emit('agent.updated', this.publicAgent(actor.agent));
    }
    this.#commit(actor, 'task.updated', task,
      task.status === 'review' ? `submitted “${task.title}” for approval` : `completed “${task.title}”`,
      { taskId: id, pageId: task.boardId });
    return task;
  }

  /**
   * @param {Actor} actor
   * @param {Task} task
   */
  #requireReviewer(actor, task) {
    if (actor.role === 'operator') return;
    if (!actor.agent.capabilities.includes('reviewer')) throw new BoardError(403, 'only the operator or an agent with the "reviewer" capability can review');
    if (task.assigneeId === actor.id) throw new BoardError(403, 'agents cannot review their own work');
  }

  /**
   * Approves a task awaiting review and moves it to `done`.
   * @param {Actor} actor operator, or a `reviewer` agent other than the assignee
   * @param {string} id
   * @param {Record<string, unknown>} body `{ note? }`
   * @returns {Task}
   */
  approveTask(actor, id, body) {
    return this.#review(actor, id, body, 'approved');
  }

  /**
   * Rejects a task awaiting review and returns it to `todo`, still assigned, with the note
   * recorded on its timeline so the assignee can retry.
   * @param {Actor} actor operator, or a `reviewer` agent other than the assignee
   * @param {string} id
   * @param {Record<string, unknown>} body `{ note? }`
   * @returns {Task}
   */
  rejectTask(actor, id, body) {
    return this.#review(actor, id, body, 'rejected');
  }

  /**
   * @param {Actor} actor
   * @param {string} id
   * @param {Record<string, unknown>} body
   * @param {'approved' | 'rejected'} state
   * @returns {Task}
   */
  #review(actor, id, body, state) {
    const task = this.getTask(id);
    this.#requireReviewer(actor, task);
    if (task.status !== 'review') throw new BoardError(409, `task is ${task.status}, not awaiting review`);
    const note = str(body.note, 'note', { max: 5000 });
    task.approval = { state, by: actor.id, note, at: this.#iso() };
    task.status = state === 'approved' ? 'done' : 'todo';
    if (state === 'rejected') task.progress = 0;
    task.order = this.#nextOrder(task.boardId, task.status);
    task.updatedAt = this.#iso();
    this.#pushComment(actor.id, task.id, 'system', `${state === 'approved' ? 'Approved' : 'Changes requested'}${note ? `: ${note}` : ''}`);
    this.#commit(actor, 'task.updated', task, `${state === 'approved' ? 'approved' : 'requested changes on'} “${task.title}”`, { taskId: id, pageId: task.boardId });
    return task;
  }

  /**
   * @param {string} authorId
   * @param {string} taskId
   * @param {Comment['kind']} kind
   * @param {string} text
   * @returns {Comment}
   */
  #pushComment(authorId, taskId, kind, text) {
    /** @type {Comment} */
    const comment = { id: newId('cmt'), taskId, authorId, kind, text, at: this.#iso() };
    this.state.comments.push(comment);
    this.#emit('comment.created', comment);
    return comment;
  }

  /**
   * Adds a timeline entry to a task. A `question` from the assignee also moves the task
   * to `blocked` so it surfaces in the operator's inbox.
   * @param {Actor} actor
   * @param {string} taskId
   * @param {Record<string, unknown>} body `{ text, kind?, progress? }`
   * @returns {Comment}
   */
  addComment(actor, taskId, body) {
    const task = this.getTask(taskId);
    const kind = body.kind === undefined ? 'comment' : oneOf(body.kind, COMMENT_KINDS.filter(k => k !== 'system'), 'kind');
    const text = str(body.text, 'text', { required: true, max: 20_000 });
    const comment = this.#pushComment(actor.id, taskId, kind, text);
    let summary = kind === 'log' ? null : `${kind === 'question' ? 'asked' : 'commented'} on “${task.title}”: ${text.slice(0, 140)}`;
    if (typeof body.progress === 'number' && body.progress >= 0 && body.progress <= 100) task.progress = Math.round(body.progress);
    if (kind === 'question' && task.assigneeId === actor.id && task.status === 'in_progress') {
      task.status = 'blocked';
      this.#dropLease(task);
      task.order = this.#nextOrder(task.boardId, 'blocked');
    }
    if (actor.role === 'agent' && task.lease?.agentId === actor.id) this.#refreshLease(task);
    task.updatedAt = this.#iso();
    this.#emit('task.updated', task);
    this.#commit(actor, 'comment.created', comment, summary, { taskId, pageId: task.boardId });
    return comment;
  }

  /**
   * Returns tasks whose lease has expired to `todo`, unassigned.
   * @returns {number} how many leases expired
   */
  expireLeases() {
    const now = this.now();
    let n = 0;
    for (const task of this.state.tasks) {
      if (!task.lease || Date.parse(task.lease.expiresAt) > now) continue;
      const holder = this.state.agents.find(a => a.id === task.lease?.agentId);
      this.#dropLease(task);
      task.status = 'todo';
      task.assigneeId = null;
      task.order = this.#nextOrder(task.boardId, 'todo');
      task.updatedAt = this.#iso();
      this.#pushComment(SYSTEM_ID, task.id, 'system', `Lease expired${holder ? ` (${holder.name} stopped sending heartbeats)` : ''}; returned to To do.`);
      this.#commit({ role: 'operator', id: SYSTEM_ID }, 'task.updated', task, `lease expired on “${task.title}”`, { taskId: task.id, pageId: task.boardId });
      n++;
    }
    return n;
  }

  // ---- agents --------------------------------------------------------------

  /**
   * Registers an agent and mints its bearer token. The token is returned once and
   * stored only as a digest.
   * @param {Actor} actor must be the operator
   * @param {Record<string, unknown>} body `{ name, kind?, description?, capabilities? }`
   * @returns {{ agent: Agent & { online: boolean }, token: string }}
   */
  createAgent(actor, body) {
    this.#requireOperator(actor);
    const name = str(body.name, 'name', { required: true, max: 80 });
    if (this.state.agents.some(a => a.name.toLowerCase() === name.toLowerCase())) throw new BoardError(409, `an agent named ${name} already exists`);
    const token = mintToken();
    /** @type {StoredAgent} */
    const agent = {
      id: newId('agt'),
      name,
      kind: body.kind === undefined ? 'agent' : oneOf(body.kind, AGENT_KINDS, 'kind'),
      description: str(body.description, 'description', { max: 2000 }),
      capabilities: strList(body.capabilities, 'capabilities'),
      status: 'idle',
      statusNote: '',
      paused: false,
      currentTaskId: null,
      meta: {},
      lastSeenAt: null,
      createdAt: this.#iso(),
      tokenHash: hashToken(token),
    };
    this.state.agents.push(agent);
    this.tokenIndex.set(agent.tokenHash, agent.id);
    const view = this.publicAgent(agent);
    this.#commit(actor, 'agent.created', view, `registered ${agent.kind} ${agent.name}`, { agentId: agent.id });
    return { agent: view, token };
  }

  /**
   * @param {Actor} actor operator, or the agent itself for its description
   * @param {string} id
   * @param {Record<string, unknown>} body `{ name?, description?, capabilities?, kind? }`
   * @returns {Agent & { online: boolean }}
   */
  updateAgent(actor, id, body) {
    const agent = this.#agent(id);
    if (actor.role === 'agent' && actor.id !== id) throw new BoardError(403, 'agents can update only themselves');
    if (body.name !== undefined) {
      this.#requireOperator(actor);
      const name = str(body.name, 'name', { required: true, max: 80 });
      if (this.state.agents.some(a => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) throw new BoardError(409, `an agent named ${name} already exists`);
      agent.name = name;
    }
    if (body.kind !== undefined) { this.#requireOperator(actor); agent.kind = oneOf(body.kind, AGENT_KINDS, 'kind'); }
    if (body.description !== undefined) agent.description = str(body.description, 'description', { max: 2000 });
    // Capabilities gate claims and reviews, so an agent changing its own would be privilege escalation.
    if (body.capabilities !== undefined) { this.#requireOperator(actor); agent.capabilities = strList(body.capabilities, 'capabilities'); }
    const view = this.publicAgent(agent);
    this.#commit(actor, 'agent.updated', view, `updated ${agent.name}`, { agentId: id });
    return view;
  }

  /**
   * Removes an agent, revokes its token, and returns its leased tasks to `todo`.
   * @param {Actor} actor must be the operator
   * @param {string} id
   */
  deleteAgent(actor, id) {
    this.#requireOperator(actor);
    const agent = this.#agent(id);
    for (const task of this.state.tasks) {
      if (task.assigneeId !== id) continue;
      task.lease = null;
      task.assigneeId = null;
      if (task.status === 'in_progress') task.status = 'todo';
      this.#emit('task.updated', task);
    }
    this.tokenIndex.delete(agent.tokenHash);
    this.state.agents = this.state.agents.filter(a => a.id !== id);
    this.state.commands = this.state.commands.filter(c => c.agentId !== id);
    this.#commit(actor, 'agent.deleted', { id }, `removed ${agent.name}`);
  }

  /**
   * Replaces an agent's token; the old token stops working immediately.
   * @param {Actor} actor must be the operator
   * @param {string} id
   * @returns {{ token: string }}
   */
  rotateToken(actor, id) {
    this.#requireOperator(actor);
    const agent = this.#agent(id);
    this.tokenIndex.delete(agent.tokenHash);
    const token = mintToken();
    agent.tokenHash = hashToken(token);
    this.tokenIndex.set(agent.tokenHash, id);
    this.#commit(actor, 'agent.updated', this.publicAgent(agent), `rotated the token for ${agent.name}`, { agentId: id });
    return { token };
  }

  /**
   * Records liveness and status, extends the agent's task leases, and returns the
   * operator's pending commands. Agents should call this every few seconds.
   * @param {Actor} actor must be an agent
   * @param {Record<string, unknown>} body `{ status?, note?, meta? }`
   * @returns {{ paused: boolean, commands: Command[], leaseMs: number }}
   */
  heartbeat(actor, body) {
    if (actor.role !== 'agent') throw new BoardError(403, 'only agents send heartbeats');
    const agent = actor.agent;
    const wasOnline = this.publicAgent(agent).online;
    const prevStatus = agent.status;
    if (body.status !== undefined) agent.status = oneOf(body.status, REPORTABLE_AGENT_STATUSES, 'status');
    if (body.note !== undefined) agent.statusNote = str(body.note, 'note', { max: 500 });
    if (body.meta !== undefined) agent.meta = meta(body.meta);
    agent.lastSeenAt = this.#iso();
    for (const task of this.state.tasks) if (task.lease?.agentId === agent.id) this.#refreshLease(task);
    const summary = !wasOnline ? `${agent.name} came online` : prevStatus !== agent.status ? `${agent.name} is ${agent.status}` : null;
    this.#commit(actor, 'agent.updated', this.publicAgent(agent), summary, { agentId: agent.id });
    return { paused: agent.paused, commands: this.state.commands.filter(c => c.agentId === agent.id && !c.ackedAt), leaseMs: this.leaseMs };
  }

  /**
   * Emits `agent.updated` for agents whose presence lapsed since the last sweep so
   * live views flip them to offline without polling.
   * @param {Set<string>} knownOnline ids considered online at the previous sweep; updated in place
   */
  sweepPresence(knownOnline) {
    for (const agent of this.state.agents) {
      const online = this.publicAgent(agent).online;
      if (online) knownOnline.add(agent.id);
      else if (knownOnline.delete(agent.id)) {
        this.#commit({ role: 'operator', id: SYSTEM_ID }, 'agent.updated', this.publicAgent(agent), `${agent.name} went offline`, { agentId: agent.id });
      }
    }
  }

  // ---- commands --------------------------------------------------------------

  /**
   * Queues a command for an agent. `pause` and `resume` also take effect server-side:
   * a paused agent cannot claim tasks. `stop` pauses the agent and returns its leased
   * tasks to `todo`.
   * @param {Actor} actor must be the operator
   * @param {string} agentId
   * @param {Record<string, unknown>} body `{ type, payload? }`
   * @returns {Command}
   */
  createCommand(actor, agentId, body) {
    this.#requireOperator(actor);
    const agent = this.#agent(agentId);
    const type = oneOf(body.type, COMMAND_TYPES, 'type');
    const payload = str(body.payload, 'payload', { max: 20_000, required: type === 'message' || type === 'custom' });
    if (type === 'pause' || type === 'stop') agent.paused = true;
    if (type === 'resume') agent.paused = false;
    if (type === 'stop') {
      for (const task of this.state.tasks) {
        if (task.lease?.agentId !== agentId) continue;
        this.#dropLease(task);
        task.status = 'todo';
        task.assigneeId = null;
        task.order = this.#nextOrder(task.boardId, 'todo');
        this.#pushComment(SYSTEM_ID, task.id, 'system', `Returned to To do: the operator stopped ${agent.name}.`);
        this.#emit('task.updated', task);
      }
    }
    /** @type {Command} */
    const command = { id: newId('cmd'), agentId, type, payload, createdBy: actor.id, createdAt: this.#iso(), ackedAt: null, response: '' };
    this.state.commands.push(command);
    this.#emit('agent.updated', this.publicAgent(agent));
    this.#commit(actor, 'command.created', command, `sent ${type} to ${agent.name}${payload ? `: ${payload.slice(0, 140)}` : ''}`, { agentId });
    return command;
  }

  /**
   * @param {Actor} actor
   * @param {{ agentId?: string, pending?: boolean }} filter agents always see only their own commands
   * @returns {Command[]}
   */
  listCommands(actor, filter) {
    const agentId = actor.role === 'agent' ? actor.id : filter.agentId;
    return this.state.commands.filter(c => (!agentId || c.agentId === agentId) && (!filter.pending || !c.ackedAt));
  }

  /**
   * Marks a command handled by its target agent.
   * @param {Actor} actor must be the command's agent
   * @param {string} id
   * @param {Record<string, unknown>} body `{ response? }`
   * @returns {Command}
   */
  ackCommand(actor, id, body) {
    const command = this.state.commands.find(c => c.id === id);
    if (!command) throw new BoardError(404, `command ${id} not found`);
    if (actor.role !== 'agent' || command.agentId !== actor.id) throw new BoardError(403, 'only the target agent can acknowledge a command');
    if (command.ackedAt) return command;
    command.ackedAt = this.#iso();
    command.response = str(body.response, 'response', { max: 20_000 });
    const acked = this.state.commands.filter(c => c.ackedAt);
    if (acked.length > MAX_ACKED_COMMANDS) {
      const drop = new Set(acked.slice(0, acked.length - MAX_ACKED_COMMANDS).map(c => c.id));
      this.state.commands = this.state.commands.filter(c => !drop.has(c.id));
    }
    this.#commit(actor, 'command.updated', command,
      `${actor.agent.name} acknowledged ${command.type}${command.response ? `: ${command.response.slice(0, 140)}` : ''}`, { agentId: actor.id });
    return command;
  }

  /**
   * @param {number} limit
   * @returns {Activity[]} the most recent entries, oldest first
   */
  listActivity(limit) {
    return this.state.activity.slice(-Math.max(1, Math.min(limit, MAX_ACTIVITY)));
  }
}

export { OPERATOR_ID, SYSTEM_ID };
