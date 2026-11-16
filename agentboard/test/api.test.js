import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { AgentboardClient } from '../src/client/index.js';

const ADMIN = 'admin_test_token';
let app, base;

before(async () => {
  app = createApp({ store: new Store({ file: null, leaseMs: 60_000, presenceMs: 30_000 }), adminToken: ADMIN });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const call = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('auth: health is public, everything else needs a token, agents cannot use operator routes', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200);
  assert.equal((await call('GET', '/api/state')).status, 401);
  assert.equal((await call('GET', '/api/state', 'nope')).status, 401);
  const reg = await call('POST', '/api/agents', ADMIN, { name: 'auth-bot' });
  assert.equal(reg.status, 201);
  assert.match(reg.body.token, /^ab_/);
  assert.equal((await call('POST', '/api/agents', reg.body.token, { name: 'x' })).status, 403);
  assert.equal((await call('GET', '/api/state', ADMIN)).body.agents.some(a => 'tokenHash' in a), false);
});

test('static UI is served and path traversal is refused', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${base}/shared/markdown.js`)).status, 200);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/shared/..%2f..%2fpackage.json`)).status, 404);
});

test('a bot works a task end to end through the client SDK while the operator watches the SSE stream', async () => {
  const { body: reg } = await call('POST', '/api/agents', ADMIN, { name: 'sdk-bot', capabilities: ['writing'] });
  const board = new AgentboardClient({ url: base, token: reg.token });
  const state = (await call('GET', '/api/state', ADMIN)).body;
  const boardId = state.pages.find(p => p.kind === 'board').id;
  const { body: task } = await call('POST', '/api/tasks', ADMIN, { boardId, title: 'write haiku', priority: 'urgent', needsApproval: true });

  const seen = [];
  const ac = new AbortController();
  const stream = await fetch(`${base}/api/events?token=${ADMIN}`, { signal: ac.signal });
  const reader = stream.body.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; seen.push(dec.decode(value)); } } catch { /* aborted at test end */ }
  })();

  const hb = await board.heartbeat({ status: 'idle' });
  assert.deepEqual(hb.commands, []);
  const claimed = await board.claim({ taskId: task.id });
  assert.equal(claimed.status, 'in_progress');
  await board.comment(task.id, 'halfway', { kind: 'progress', progress: 50 });
  const done = await board.complete(task.id, 'old pond / frog jumps in');
  assert.equal(done.status, 'review');
  assert.equal((await call('POST', `/api/tasks/${task.id}/approve`, ADMIN, { note: 'nice' })).body.status, 'done');

  const page = await board.createPage({ title: 'Report', markdown: '# Report\n\n- item' });
  await board.appendToPage(page.id, '## More');
  assert.match((await board.getPage(page.id)).markdown, /## More/);

  await new Promise(r => setTimeout(r, 100));
  ac.abort();
  await pump;
  const text = seen.join('');
  for (const ev of ['hello', 'task.updated', 'comment.created', 'page.created', 'activity.created']) assert.match(text, new RegExp(`event: ${ev.replace('.', '\\.')}`));
});

test('the MCP server lists tools and calls them against the board', async () => {
  const { body: reg } = await call('POST', '/api/agents', ADMIN, { name: 'mcp-agent' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/server.js', import.meta.url))], {
    env: { ...process.env, AGENTBOARD_URL: base, AGENTBOARD_TOKEN: reg.token }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  let n = 0;
  const rpc = (method, params) => new Promise(resolve => { const id = ++n; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'agentboard');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const { result: { tools } } = await rpc('tools/list', {});
    assert.ok(tools.some(t => t.name === 'board_claim_task'));
    const who = await rpc('tools/call', { name: 'board_whoami', arguments: {} });
    assert.equal(JSON.parse(who.result.content[0].text).agent.name, 'mcp-agent');
    const created = await rpc('tools/call', { name: 'board_create_page', arguments: { title: 'From MCP', markdown: '- [ ] check' } });
    const pageId = JSON.parse(created.result.content[0].text).id;
    const read = await rpc('tools/call', { name: 'board_read_page', arguments: { pageId } });
    assert.match(read.result.content[0].text, /# From MCP\n\n- \[ \] check/);
    const bad = await rpc('tools/call', { name: 'board_get_task', arguments: { taskId: 'tsk_missing' } });
    assert.equal(bad.result.isError, true);
    assert.equal((await rpc('nope/method', {})).error.code, -32601);
  } finally {
    child.kill();
  }
});
