#!/usr/bin/env node
// @ts-check
/**
 * `agentboard-mcp`: a Model Context Protocol server over stdio that exposes the
 * board to MCP clients as tools. It authenticates as one agent through
 * `AGENTBOARD_URL` and `AGENTBOARD_TOKEN`, and keeps that agent online by
 * sending a heartbeat every 15 seconds while the client is connected.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout; diagnostics go to stderr.
 */

import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentboardClient } from '../client/index.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * @typedef {{ name: string, description: string, inputSchema: object, run: (board: AgentboardClient, args: any) => Promise<unknown> }} Tool
 */

const id = { type: 'string', description: 'Id such as tsk_… or pg_…' };

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: 'board_whoami',
    description: 'Show which agent this connection is, its capabilities, and pending operator commands.',
    inputSchema: { type: 'object', properties: {} },
    async run(board) {
      const [me, hb] = await Promise.all([board.me(), board.heartbeat()]);
      return { ...me, paused: hb.paused, pendingCommands: hb.commands };
    },
  },
  {
    name: 'board_heartbeat',
    description: 'Report your status to the operator and receive pending commands (pause, resume, stop, messages). Acknowledge each command with board_ack_command.',
    inputSchema: { type: 'object', properties: { status: { enum: ['idle', 'working', 'paused', 'error'] }, note: { type: 'string', description: 'One line shown next to your name.' } } },
    run: (board, a) => board.heartbeat({ status: a.status, note: a.note }),
  },
  {
    name: 'board_ack_command',
    description: 'Acknowledge an operator command after acting on it.',
    inputSchema: { type: 'object', properties: { commandId: id, response: { type: 'string' } }, required: ['commandId'] },
    run: (board, a) => board.ack(a.commandId, a.response),
  },
  {
    name: 'board_list_tasks',
    description: 'List tasks. Filter by board, status (backlog, todo, in_progress, review, blocked, done), or mine=true for tasks assigned to you.',
    inputSchema: { type: 'object', properties: { boardId: id, status: { type: 'string' }, mine: { type: 'boolean' } } },
    async run(board, a) {
      const tasks = await board.listTasks({ boardId: a.boardId, status: a.status, assignee: a.mine ? 'me' : undefined });
      return tasks.map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, assigneeId: t.assigneeId, labels: t.labels, needsApproval: t.needsApproval }));
    },
  },
  {
    name: 'board_get_task',
    description: 'Read a task with its full description, result, and timeline.',
    inputSchema: { type: 'object', properties: { taskId: id }, required: ['taskId'] },
    run: (board, a) => board.getTask(a.taskId),
  },
  {
    name: 'board_claim_task',
    description: 'Claim a task to work on. Without taskId, claims the highest-priority eligible task in To do (optionally on one board). Returns null when nothing is available. The claim is a lease kept alive by heartbeats.',
    inputSchema: { type: 'object', properties: { taskId: id, boardId: id } },
    run: (board, a) => board.claim({ taskId: a.taskId, boardId: a.boardId }),
  },
  {
    name: 'board_report_progress',
    description: 'Post a progress update on a task you are working on.',
    inputSchema: { type: 'object', properties: { taskId: id, text: { type: 'string' }, percent: { type: 'number', minimum: 0, maximum: 100 } }, required: ['taskId', 'text'] },
    run: (board, a) => board.comment(a.taskId, a.text, { kind: 'progress', progress: a.percent }),
  },
  {
    name: 'board_ask_operator',
    description: 'Ask the human operator a question about a task. The task moves to Blocked until they answer on its timeline.',
    inputSchema: { type: 'object', properties: { taskId: id, question: { type: 'string' } }, required: ['taskId', 'question'] },
    run: (board, a) => board.comment(a.taskId, a.question, { kind: 'question' }),
  },
  {
    name: 'board_complete_task',
    description: 'Finish a task with a Markdown result. Tasks that require approval go to Review for the operator.',
    inputSchema: { type: 'object', properties: { taskId: id, result: { type: 'string', description: 'Markdown summary of what you did.' } }, required: ['taskId', 'result'] },
    run: (board, a) => board.complete(a.taskId, a.result),
  },
  {
    name: 'board_release_task',
    description: 'Give a task back to the queue when you cannot finish it.',
    inputSchema: { type: 'object', properties: { taskId: id, reason: { type: 'string' } }, required: ['taskId'] },
    run: (board, a) => board.release(a.taskId, a.reason),
  },
  {
    name: 'board_create_task',
    description: 'Create a task on a board (use board_list_pages to find boards, kind=board).',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: id, title: { type: 'string' }, description: { type: 'string' },
        priority: { enum: ['low', 'normal', 'high', 'urgent'] }, labels: { type: 'array', items: { type: 'string' } },
        status: { enum: ['backlog', 'todo'] },
      },
      required: ['boardId', 'title'],
    },
    run: (board, a) => board.createTask(a),
  },
  {
    name: 'board_list_pages',
    description: 'List pages and boards in the workspace (titles, ids, parent ids, kinds).',
    inputSchema: { type: 'object', properties: {} },
    run: board => board.listPages(),
  },
  {
    name: 'board_read_page',
    description: 'Read a page as Markdown.',
    inputSchema: { type: 'object', properties: { pageId: id }, required: ['pageId'] },
    async run(board, a) {
      const p = await board.getPage(a.pageId);
      return `# ${p.title}\n\n${p.markdown}`;
    },
  },
  {
    name: 'board_create_page',
    description: 'Create a page from Markdown, optionally nested under a parent page.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' }, parentId: id, icon: { type: 'string', description: 'One emoji.' } }, required: ['title'] },
    async run(board, a) {
      const p = await board.createPage(a);
      return { id: p.id, title: p.title };
    },
  },
  {
    name: 'board_append_to_page',
    description: 'Append Markdown to the end of a page (reports, logs, notes).',
    inputSchema: { type: 'object', properties: { pageId: id, markdown: { type: 'string' } }, required: ['pageId', 'markdown'] },
    async run(board, a) {
      const p = await board.appendToPage(a.pageId, a.markdown);
      return { id: p.id, version: p.version };
    },
  },
];

/**
 * Handles one JSON-RPC message.
 * @param {AgentboardClient} board
 * @param {any} msg
 * @returns {Promise<object | null>} the response, or null for notifications
 */
export async function handleMessage(board, msg) {
  const reply = (/** @type {unknown} */ result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (/** @type {number} */ code, /** @type {string} */ message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'agentboard', version: '0.1.0' },
        instructions: 'Agentboard is the shared task board and wiki. Claim tasks with board_claim_task, post progress, ask the operator when blocked, and complete tasks with a Markdown result. Check board_heartbeat for operator commands.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `unknown tool ${msg.params?.name}`);
      try {
        const out = await tool.run(board, msg.params?.arguments ?? {});
        return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Error: ${/** @type {Error} */ (err).message}` }], isError: true });
      }
    }
    default:
      return isNotification ? null : fail(-32601, `method not found: ${msg.method}`);
  }
}

const isEntry = (() => {
  try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } // argv[1] absent or unresolvable: imported, not run
})();

if (isEntry) {
  let board;
  try {
    board = new AgentboardClient();
  } catch (err) {
    console.error(`agentboard-mcp: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  const client = board;
  const beat = () => client.heartbeat().catch(err => console.error(`agentboard-mcp: heartbeat failed: ${err.message}`));
  beat();
  const timer = setInterval(beat, 15_000);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const res = await handleMessage(client, msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
  rl.on('close', () => { clearInterval(timer); process.exit(0); });
}
