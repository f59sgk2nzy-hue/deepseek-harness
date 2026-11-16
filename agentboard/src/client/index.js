// @ts-check
/**
 * Minimal Agentboard client for bots and agents (Node ≥ 22 or any runtime with `fetch`).
 *
 * ```js
 * import { AgentboardClient } from 'agentboard/client';
 * const board = new AgentboardClient({ url: process.env.AGENTBOARD_URL, token: process.env.AGENTBOARD_TOKEN });
 * const { commands } = await board.heartbeat({ status: 'idle' });
 * const task = await board.claim();
 * ```
 *
 * @typedef {import('../shared/model.js').Task} Task
 * @typedef {import('../shared/model.js').Page} Page
 * @typedef {import('../shared/model.js').Agent} Agent
 * @typedef {import('../shared/model.js').Command} Command
 * @typedef {import('../shared/model.js').Comment} Comment
 */

/** A non-2xx API response. */
export class AgentboardError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(`${status}: ${message}`);
    this.status = status;
  }
}

/**
 * Throw from a `runAgentLoop` work function after asking the operator a question
 * (`comment(..., { kind: 'question' })`). The task stays blocked and assigned to
 * this agent instead of being released; the agent re-claims it once the operator
 * answers and moves it back to To do.
 */
export class TaskBlocked extends Error {}

export class AgentboardClient {
  /**
   * @param {{ url?: string, token?: string }} opts defaults to `AGENTBOARD_URL` / `AGENTBOARD_TOKEN`
   * @throws {Error} when no token is available
   */
  constructor({ url = process.env.AGENTBOARD_URL ?? 'http://127.0.0.1:4317', token = process.env.AGENTBOARD_TOKEN } = {}) {
    if (!token) throw new Error('AgentboardClient needs a token (set AGENTBOARD_TOKEN)');
    this.url = url.replace(/\/+$/, '');
    this.token = token;
  }

  /**
   * @template T
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<T>}
   * @throws {AgentboardError} on a non-2xx response
   */
  async request(method, path, body) {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new AgentboardError(res.status, data?.error ?? res.statusText);
    return data;
  }

  /** @returns {Promise<{ role: string, id: string, agent?: Agent }>} the authenticated principal */
  me() { return this.request('GET', '/api/me'); }

  /**
   * Reports liveness; call every few seconds while running.
   * @param {{ status?: 'idle'|'working'|'paused'|'error', note?: string, meta?: Record<string, string|number|boolean> }} [body]
   * @returns {Promise<{ paused: boolean, commands: Command[], leaseMs: number }>} pending operator commands
   */
  heartbeat(body = {}) { return this.request('POST', '/api/heartbeat', body); }

  /**
   * Leases the best eligible task, or a specific one.
   * @param {{ taskId?: string, boardId?: string }} [opts]
   * @returns {Promise<Task | null>}
   */
  async claim(opts = {}) {
    const { task } = await this.request('POST', '/api/tasks/claim', opts);
    return task;
  }

  /**
   * @param {{ boardId?: string, status?: string, assignee?: string }} [filter] `assignee: 'me'` lists your tasks
   * @returns {Promise<Task[]>}
   */
  listTasks(filter = {}) {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined));
    return this.request('GET', `/api/tasks${qs.size ? `?${qs}` : ''}`);
  }

  /**
   * @param {string} id
   * @returns {Promise<Task & { comments: Comment[] }>}
   */
  getTask(id) { return this.request('GET', `/api/tasks/${id}`); }

  /**
   * @param {{ boardId: string, title: string, description?: string, priority?: string, labels?: string[], requiredCapabilities?: string[], needsApproval?: boolean, status?: string }} body
   * @returns {Promise<Task>}
   */
  createTask(body) { return this.request('POST', '/api/tasks', body); }

  /**
   * @param {string} id
   * @param {Partial<Pick<Task, 'title'|'description'|'status'|'priority'|'labels'|'progress'|'result'>>} patch
   * @returns {Promise<Task>}
   */
  updateTask(id, patch) { return this.request('PATCH', `/api/tasks/${id}`, patch); }

  /**
   * Adds a timeline entry. `kind: 'question'` blocks the task and alerts the operator.
   * @param {string} id
   * @param {string} text
   * @param {{ kind?: 'comment'|'progress'|'question'|'log', progress?: number }} [opts]
   * @returns {Promise<Comment>}
   */
  comment(id, text, opts = {}) { return this.request('POST', `/api/tasks/${id}/comments`, { text, ...opts }); }

  /**
   * @param {string} id
   * @param {string} [result] Markdown
   * @returns {Promise<Task>}
   */
  complete(id, result) { return this.request('POST', `/api/tasks/${id}/complete`, { result }); }

  /**
   * @param {string} id
   * @param {string} [note]
   * @returns {Promise<Task>}
   */
  release(id, note) { return this.request('POST', `/api/tasks/${id}/release`, { note }); }

  /** @returns {Promise<Omit<Page, 'blocks'>[]>} */
  listPages() { return this.request('GET', '/api/pages'); }

  /**
   * @param {string} id
   * @returns {Promise<Page & { markdown: string }>}
   */
  getPage(id) { return this.request('GET', `/api/pages/${id}`); }

  /**
   * @param {{ title: string, markdown?: string, parentId?: string, icon?: string, kind?: 'doc'|'board' }} body
   * @returns {Promise<Page>}
   */
  createPage(body) { return this.request('POST', '/api/pages', body); }

  /**
   * @param {string} id
   * @param {string} markdown
   * @returns {Promise<Page>}
   */
  appendToPage(id, markdown) { return this.request('POST', `/api/pages/${id}/append`, { markdown }); }

  /**
   * @param {string} id
   * @param {string} [response]
   * @returns {Promise<Command>}
   */
  ack(id, response) { return this.request('POST', `/api/commands/${id}/ack`, { response }); }
}

/**
 * Runs a standard agent loop: heartbeat, obey commands, claim, work, complete.
 * Throwing from `work` releases the task with the error message.
 *
 * @param {AgentboardClient} board
 * @param {{
 *   work: (task: Task, ctx: { progress: (text: string, pct?: number) => Promise<unknown>, signal: AbortSignal }) => Promise<string | void>,
 *   onMessage?: (command: Command) => Promise<string | void> | string | void,
 *   pollMs?: number, heartbeatMs?: number, boardId?: string, log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<void>} resolves after a `stop` command
 */
export async function runAgentLoop(board, { work, onMessage, pollMs = 3000, heartbeatMs = 5000, boardId, log = console.log }) {
  let stopped = false;
  let paused = false;
  /** @type {AbortController | null} */
  let current = null;
  /** @type {'idle'|'working'|'paused'|'error'} */
  let status = 'idle';

  const beat = async () => {
    const hb = await board.heartbeat({ status: paused ? 'paused' : status });
    paused = hb.paused;
    for (const cmd of hb.commands) {
      let response = 'ok';
      if (cmd.type === 'stop') { stopped = true; current?.abort(); response = 'stopping'; }
      else if (cmd.type === 'pause') { paused = true; response = 'paused'; }
      else if (cmd.type === 'resume') { paused = false; response = 'resumed'; }
      else if (onMessage) response = (await onMessage(cmd)) || 'received';
      log(`command ${cmd.type}${cmd.payload ? `: ${cmd.payload}` : ''}`);
      await board.ack(cmd.id, response);
    }
  };

  const timer = setInterval(() => { beat().catch(err => log(`heartbeat failed: ${err.message}`)); }, heartbeatMs);
  try {
    await beat();
    while (!stopped) {
      if (paused) { await sleep(pollMs); await beat(); continue; }
      const task = await board.claim(boardId ? { boardId } : {});
      if (!task) { await sleep(pollMs); continue; }
      log(`claimed ${task.id}: ${task.title}`);
      status = 'working';
      current = new AbortController();
      try {
        const result = await work(task, {
          progress: (text, pct) => board.comment(task.id, text, { kind: 'progress', progress: pct }),
          signal: current.signal,
        });
        if (current.signal.aborted) log(`aborted ${task.id}`);
        else {
          await board.complete(task.id, result || '');
          log(`completed ${task.id}`);
        }
      } catch (err) {
        if (err instanceof TaskBlocked) {
          log(`blocked ${task.id}: waiting for the operator`);
        } else {
          status = 'error';
          log(`failed ${task.id}: ${/** @type {Error} */ (err).message}`);
          const fresh = await board.getTask(task.id).catch(() => null);
          // Release only while this agent still holds the task; the operator or lease expiry may have taken it back.
          if (fresh?.status === 'in_progress' && fresh.lease?.agentId === task.assigneeId) {
            await board.release(task.id, `Error: ${/** @type {Error} */ (err).message}`).catch(() => {
              // Lost a race with the operator or lease expiry; the task is no longer ours to release.
            });
          }
        }
      } finally {
        current = null;
        if (status !== 'error') status = 'idle';
      }
      await beat();
      status = 'idle';
    }
  } finally {
    clearInterval(timer);
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
