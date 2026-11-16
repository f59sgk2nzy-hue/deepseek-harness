// @ts-check
/**
 * HTTP surface: JSON REST API under `/api`, a Server-Sent Events stream at
 * `/api/events`, and the static browser UI. All API routes except `/api/health`
 * require a bearer token: the operator's admin token or an agent token.
 */

import { createServer as createHttpServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, sep, extname } from 'node:path';
import { Store, BoardError, OPERATOR } from './store.js';
import { blocksToMarkdown } from '../shared/markdown.js';

/** @typedef {import('./store.js').Actor} Actor */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STATIC_ROOTS = { '/shared/': join(ROOT, 'src', 'shared'), '/': join(ROOT, 'public') };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const MAX_BODY = 2 * 1024 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

/**
 * @typedef {{
 *   req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *   url: URL, params: string[], actor: Actor, body: Record<string, unknown>,
 * }} RouteContext
 * @typedef {(ctx: RouteContext) => unknown} Handler
 */

/**
 * @param {{ store: Store, adminToken: string }} opts
 * @returns {{ server: import('node:http').Server, store: Store, close: () => Promise<void> }}
 */
export function createApp({ store, adminToken }) {
  const adminDigest = createHash('sha256').update(adminToken).digest();

  /**
   * @param {string | null | undefined} token
   * @returns {Actor | null}
   */
  function authenticate(token) {
    if (!token) return null;
    const digest = createHash('sha256').update(token).digest();
    if (timingSafeEqual(digest, adminDigest)) return OPERATOR;
    return store.authenticateAgent(token);
  }

  /** @type {Array<[string, RegExp, Handler]>} */
  const routes = [];
  /**
   * @param {string} method
   * @param {string} pattern path with `:param` segments
   * @param {Handler} handler
   */
  const route = (method, pattern, handler) => {
    routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, '([\\w-]+)')}$`), handler]);
  };

  const q = (/** @type {URL} */ url, /** @type {string} */ k) => url.searchParams.get(k) ?? undefined;

  route('GET', '/api/me', ({ actor }) => actor.role === 'operator'
    ? { role: 'operator', id: actor.id }
    : { role: 'agent', id: actor.id, agent: store.publicAgent(actor.agent) });
  route('GET', '/api/state', () => {
    const snap = store.snapshot();
    return { ...snap, config: { ...snap.config, mcpServerPath: join(ROOT, 'src', 'mcp', 'server.js') } };
  });
  route('GET', '/api/activity', ({ url }) => store.listActivity(Number(q(url, 'limit') ?? 100) || 100));

  route('GET', '/api/pages', () => store.state.pages.map(({ blocks: _b, ...p }) => p));
  route('POST', '/api/pages', ({ actor, body }) => store.createPage(actor, body));
  route('GET', '/api/pages/:id', ({ params }) => {
    const page = store.getPage(params[0]);
    return { ...page, markdown: blocksToMarkdown(page.blocks) };
  });
  route('PATCH', '/api/pages/:id', ({ actor, params, body }) => store.updatePage(actor, params[0], body));
  route('POST', '/api/pages/:id/append', ({ actor, params, body }) => store.appendToPage(actor, params[0], body));
  route('DELETE', '/api/pages/:id', ({ actor, params }) => { store.deletePage(actor, params[0]); return { ok: true }; });

  route('GET', '/api/tasks', ({ url, actor }) => store.listTasks({
    boardId: q(url, 'boardId'),
    status: q(url, 'status'),
    assigneeId: q(url, 'assignee') === 'me' ? actor.id : q(url, 'assignee'),
  }));
  route('POST', '/api/tasks', ({ actor, body }) => store.createTask(actor, body));
  route('POST', '/api/tasks/claim', ({ actor, body }) => ({ task: store.claimTask(actor, body) }));
  route('GET', '/api/tasks/:id', ({ params }) => {
    const task = store.getTask(params[0]);
    return { ...task, comments: store.state.comments.filter(c => c.taskId === task.id) };
  });
  route('PATCH', '/api/tasks/:id', ({ actor, params, body }) => store.updateTask(actor, params[0], body));
  route('DELETE', '/api/tasks/:id', ({ actor, params }) => { store.deleteTask(actor, params[0]); return { ok: true }; });
  route('POST', '/api/tasks/:id/claim', ({ actor, params }) => ({ task: store.claimTask(actor, { taskId: params[0] }) }));
  route('POST', '/api/tasks/:id/release', ({ actor, params, body }) => store.releaseTask(actor, params[0], body));
  route('POST', '/api/tasks/:id/complete', ({ actor, params, body }) => store.completeTask(actor, params[0], body));
  route('POST', '/api/tasks/:id/approve', ({ actor, params, body }) => store.approveTask(actor, params[0], body));
  route('POST', '/api/tasks/:id/reject', ({ actor, params, body }) => store.rejectTask(actor, params[0], body));
  route('POST', '/api/tasks/:id/comments', ({ actor, params, body }) => store.addComment(actor, params[0], body));

  route('GET', '/api/agents', () => store.state.agents.map(a => store.publicAgent(a)));
  route('POST', '/api/agents', ({ actor, body }) => store.createAgent(actor, body));
  route('PATCH', '/api/agents/:id', ({ actor, params, body }) => store.updateAgent(actor, params[0], body));
  route('DELETE', '/api/agents/:id', ({ actor, params }) => { store.deleteAgent(actor, params[0]); return { ok: true }; });
  route('POST', '/api/agents/:id/token', ({ actor, params }) => store.rotateToken(actor, params[0]));
  route('POST', '/api/agents/:id/commands', ({ actor, params, body }) => store.createCommand(actor, params[0], body));
  route('POST', '/api/heartbeat', ({ actor, body }) => store.heartbeat(actor, body));

  route('GET', '/api/commands', ({ actor, url }) => store.listCommands(actor, { agentId: q(url, 'agentId'), pending: q(url, 'pending') === 'true' }));
  route('POST', '/api/commands/:id/ack', ({ actor, params, body }) => store.ackCommand(actor, params[0], body));

  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();
  const unsubscribe = store.subscribe(event => {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const res of streams) res.write(frame);
  });
  const keepAlive = setInterval(() => { for (const res of streams) res.write(': keep-alive\n\n'); }, 20_000);
  keepAlive.unref();

  const knownOnline = new Set();
  const sweeper = setInterval(() => {
    store.expireLeases();
    store.sweepPresence(knownOnline);
  }, 2000);
  sweeper.unref();

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} payload
   */
  function sendJson(res, status, payload) {
    const json = JSON.stringify(payload ?? null);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(json);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<Record<string, unknown>>}
   */
  async function readBody(req) {
    if (req.method === 'GET' || req.method === 'DELETE') return {};
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new BoardError(413, 'request body exceeds 2 MiB');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BoardError(400, 'request body is not valid JSON'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BoardError(400, 'request body must be a JSON object');
    return parsed;
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   */
  async function serveStatic(res, pathname) {
    const [prefix, dir] = /** @type {[string, string]} */ (Object.entries(STATIC_ROOTS).find(([p]) => pathname.startsWith(p)));
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(prefix.length));
    const file = normalize(join(dir, rel));
    const type = MIME[/** @type {keyof typeof MIME} */ (extname(file))];
    if (!file.startsWith(dir + sep) || !type) return sendJson(res, 404, { error: 'not found' });
    try {
      const body = await readFile(file);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      // A missing file is the only expected failure here; anything else surfaces as 404 too.
      sendJson(res, 404, { error: 'not found' });
    }
  }

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
        return await serveStatic(res, url.pathname);
      }
      if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
      // EventSource cannot set headers, so the stream alone also accepts ?token=.
      const actor = authenticate(bearer ?? (url.pathname === '/api/events' ? url.searchParams.get('token') : null));
      if (!actor) return sendJson(res, 401, { error: 'missing or invalid bearer token' });

      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`event: hello\ndata: ${JSON.stringify({ role: actor.role, id: actor.id })}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }

      for (const [method, re, handler] of routes) {
        if (method !== req.method) continue;
        const m = re.exec(url.pathname);
        if (!m) continue;
        const body = await readBody(req);
        const result = await handler({ req, res, url, params: m.slice(1), actor, body });
        return sendJson(res, method === 'POST' && /\/api\/(pages|tasks|agents)$/.test(url.pathname) ? 201 : 200, result);
      }
      return sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof BoardError) {
        return sendJson(res, err.status, { error: err.message, ...('current' in err ? { current: err.current } : {}) });
      }
      console.error('agentboard: unhandled error', err);
      return sendJson(res, 500, { error: 'internal error' });
    }
  });

  return {
    server,
    store,
    async close() {
      clearInterval(keepAlive);
      clearInterval(sweeper);
      unsubscribe();
      for (const res of streams) res.end();
      streams.clear();
      await new Promise(resolve => server.close(() => resolve(undefined)));
      await store.flush();
    },
  };
}
