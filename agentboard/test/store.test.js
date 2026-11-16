import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, OPERATOR, BoardError } from '../src/server/store.js';

function setup() {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const store = new Store({ file: null, leaseMs: 60_000, presenceMs: 30_000, now: () => clock });
  const board = store.state.pages.find(p => p.kind === 'board');
  const make = (name, capabilities = []) => {
    const { agent, token } = store.createAgent(OPERATOR, { name, capabilities });
    return { agent, token, actor: store.authenticateAgent(token) };
  };
  return { store, board, make, tick: ms => { clock += ms; } };
}

/** @param {() => unknown} fn */
const status = fn => { try { fn(); } catch (e) { assert.ok(e instanceof BoardError, e); return e.status; } return 200; };

test('agents claim the highest-priority eligible task and leases expire without heartbeats', () => {
  const { store, board, make, tick } = setup();
  const a = make('alpha');
  const low = store.createTask(OPERATOR, { boardId: board.id, title: 'low', priority: 'low' });
  const urgent = store.createTask(OPERATOR, { boardId: board.id, title: 'urgent', priority: 'urgent' });
  store.createTask(OPERATOR, { boardId: board.id, title: 'needs gpu', priority: 'urgent', requiredCapabilities: ['gpu'] });
  const seededUrgent = store.state.tasks.filter(t => t.status === 'todo' && t.priority === 'urgent' && !t.requiredCapabilities.length);
  assert.ok(seededUrgent.includes(urgent));

  const claimed = store.claimTask(a.actor, { boardId: board.id });
  assert.equal(claimed.priority, 'urgent');
  assert.equal(claimed.status, 'in_progress');
  assert.equal(claimed.assigneeId, a.agent.id);

  tick(50_000);
  store.heartbeat(a.actor, { status: 'working' });
  tick(50_000);
  assert.equal(store.expireLeases(), 0, 'heartbeat extended the lease');
  tick(61_000);
  assert.equal(store.expireLeases(), 1);
  assert.equal(claimed.status, 'todo');
  assert.equal(claimed.assigneeId, null);
  assert.ok(store.state.comments.some(c => c.taskId === claimed.id && /Lease expired/.test(c.text)));
  assert.ok(low);
});

test('capability requirements and assignment gate claims', () => {
  const { store, board, make } = setup();
  const a = make('alpha');
  const b = make('beta', ['gpu']);
  for (const t of store.state.tasks) t.status = 'done';
  const gpu = store.createTask(OPERATOR, { boardId: board.id, title: 'train', requiredCapabilities: ['gpu'] });
  assert.equal(store.claimTask(a.actor, {}), null);
  assert.equal(status(() => store.claimTask(a.actor, { taskId: gpu.id })), 409);
  assert.equal(store.claimTask(b.actor, {}).id, gpu.id);
  const forA = store.createTask(OPERATOR, { boardId: board.id, title: 'for alpha', assigneeId: a.agent.id });
  assert.equal(status(() => store.claimTask(b.actor, { taskId: forA.id })), 409);
  assert.equal(store.claimTask(a.actor, {}).id, forA.id);
});

test('approval-gated tasks wait in review; only the operator or another reviewer approves', () => {
  const { store, board, make } = setup();
  const a = make('alpha');
  const reviewer = make('rev', ['reviewer']);
  const t = store.createTask(OPERATOR, { boardId: board.id, title: 'publish', needsApproval: true, priority: 'urgent' });
  store.claimTask(a.actor, { taskId: t.id });
  assert.equal(status(() => store.updateTask(a.actor, t.id, { status: 'done' })), 409);
  store.completeTask(a.actor, t.id, { result: 'draft' });
  assert.equal(t.status, 'review');
  assert.equal(t.approval.state, 'pending');
  assert.equal(status(() => store.approveTask(a.actor, t.id, {})), 403);

  store.rejectTask(OPERATOR, t.id, { note: 'shorter please' });
  assert.equal(t.status, 'todo');
  assert.equal(t.assigneeId, a.agent.id, 'rejected work stays with its author');
  assert.equal(store.claimTask(a.actor, {}).id, t.id, 'the author re-claims it first');
  store.completeTask(a.actor, t.id, { result: 'short draft' });
  store.approveTask(reviewer.actor, t.id, { note: 'lgtm' });
  assert.equal(t.status, 'done');
  assert.equal(t.approval.by, reviewer.agent.id);
});

test('questions block the task; pause and stop are enforced server-side', () => {
  const { store, board, make } = setup();
  const a = make('alpha');
  const t = store.createTask(OPERATOR, { boardId: board.id, title: 'q', priority: 'urgent' });
  store.claimTask(a.actor, { taskId: t.id });
  store.addComment(a.actor, t.id, { kind: 'question', text: 'which env?' });
  assert.equal(t.status, 'blocked');
  assert.equal(t.lease, null);

  store.createCommand(OPERATOR, a.agent.id, { type: 'pause' });
  assert.equal(status(() => store.claimTask(a.actor, {})), 409);
  const hb = store.heartbeat(a.actor, {});
  assert.equal(hb.paused, true);
  assert.equal(hb.commands.length, 1);
  store.ackCommand(a.actor, hb.commands[0].id, { response: 'ok' });
  assert.equal(store.heartbeat(a.actor, {}).commands.length, 0);

  store.createCommand(OPERATOR, a.agent.id, { type: 'resume' });
  const t2 = store.claimTask(a.actor, {});
  store.createCommand(OPERATOR, a.agent.id, { type: 'stop' });
  assert.equal(t2.status, 'todo');
  assert.equal(t2.lease, null);
});

test('agents cannot touch other agents’ tasks or operator-only surfaces', () => {
  const { store, board, make } = setup();
  const a = make('alpha');
  const b = make('beta');
  const t = store.createTask(OPERATOR, { boardId: board.id, title: 'x', priority: 'urgent' });
  store.claimTask(a.actor, { taskId: t.id });
  assert.equal(status(() => store.updateTask(b.actor, t.id, { progress: 50 })), 403);
  assert.equal(status(() => store.completeTask(b.actor, t.id, {})), 403);
  assert.equal(status(() => store.createAgent(b.actor, { name: 'evil' })), 403);
  assert.equal(status(() => store.createCommand(b.actor, a.agent.id, { type: 'stop' })), 403);
  assert.equal(status(() => store.updateTask(a.actor, t.id, { assigneeId: b.agent.id })), 403);
  assert.equal(status(() => store.deletePage(a.actor, board.id)), 403);
  assert.equal(status(() => store.updateAgent(a.actor, a.agent.id, { capabilities: ['reviewer'] })), 403);
  assert.equal(status(() => store.updateAgent(a.actor, b.agent.id, { description: 'x' })), 403);
  store.updateAgent(a.actor, a.agent.id, { description: 'I summarize things' });
  assert.equal(store.authenticateAgent('ab_wrong'), null);
  const { token } = store.rotateToken(OPERATOR, a.agent.id);
  assert.equal(store.authenticateAgent(a.token), null);
  assert.equal(store.authenticateAgent(token).id, a.agent.id);
});

test('page version conflicts are reported; appends never conflict; nesting cycles are refused', () => {
  const { store } = setup();
  const p = store.createPage(OPERATOR, { title: 'Doc', markdown: '# Hi' });
  store.appendToPage(OPERATOR, p.id, { markdown: '- added' });
  assert.equal(p.blocks.length, 2);
  const err = (() => { try { store.updatePage(OPERATOR, p.id, { blocks: [], baseVersion: 1 }); } catch (e) { return e; } })();
  assert.equal(err.status, 409);
  assert.equal(err.current.id, p.id);
  const child = store.createPage(OPERATOR, { title: 'Child', parentId: p.id });
  assert.equal(status(() => store.updatePage(OPERATOR, p.id, { parentId: child.id })), 400);
  store.deletePage(OPERATOR, p.id);
  assert.equal(store.state.pages.some(x => x.id === child.id), false);
});

test('state persists across restarts and unknown schema versions are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentboard-'));
  const file = join(dir, 'board.json');
  const s1 = new Store({ file, leaseMs: 1000, presenceMs: 1000 });
  const { token } = s1.createAgent(OPERATOR, { name: 'persisted' });
  await s1.flush();
  assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(token), 'tokens are stored only as digests');
  const s2 = new Store({ file, leaseMs: 1000, presenceMs: 1000 });
  assert.equal(s2.authenticateAgent(token)?.agent.name, 'persisted');
  writeFileSync(file, JSON.stringify({ schemaVersion: 999 }));
  assert.throws(() => new Store({ file, leaseMs: 1000, presenceMs: 1000 }), /schemaVersion 999/);
});
