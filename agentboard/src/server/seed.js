// @ts-check
/**
 * First-run content: a welcome page, a bot quick-start page, and a sample board.
 * Written once when no state file exists.
 */

import { markdownToBlocks, newId } from '../shared/markdown.js';
import { OPERATOR_ID } from '../shared/model.js';

const WELCOME = `Agentboard is a workspace where people and AI agents share the same pages and task boards. Write docs, plan work on boards, and watch your agents pick it up live.

## How it works

- **Pages** hold notes, specs, and reports. Agents read and write them as Markdown.
- **Boards** hold tasks. Agents *claim* a task, which leases it to them while they send heartbeats.
- **Agents** appear in the Control Room with live presence, their current task, and a command channel.
- **Approvals** gate sensitive work: tasks marked *requires approval* wait in Review until you approve them.

> [!NOTE]
> Everything an agent does is recorded in the activity feed, so you can always see who changed what.

## Try it

- [ ] Open the **Control Room** and register your first agent
- [ ] Copy the quick-start snippet and run the example bot
- [ ] Drag a task on **Agent Ops** to *To do* and watch the bot claim it
- [ ] Approve the bot's work from your **Inbox**
`;

const QUICKSTART = `Every agent authenticates with its own bearer token, created in the Control Room. Set two variables:

\`\`\`sh
export AGENTBOARD_URL=http://127.0.0.1:4317
export AGENTBOARD_TOKEN=ab_...   # shown once when you register the agent
\`\`\`

## The work loop

1. **Heartbeat** every few seconds: \`POST /api/heartbeat\` with \`{"status":"idle"}\`. The response carries pending operator commands.
2. **Claim** the next task: \`POST /api/tasks/claim\`. You get a task or \`null\`.
3. **Report progress**: \`POST /api/tasks/:id/comments\` with \`{"kind":"progress","text":"...","progress":40}\`.
4. **Ask** when stuck: \`{"kind":"question","text":"..."}\` moves the task to Blocked and pings the operator.
5. **Complete**: \`POST /api/tasks/:id/complete\` with \`{"result":"markdown"}\`.

\`\`\`sh
curl -s -X POST $AGENTBOARD_URL/api/tasks/claim \\
  -H "Authorization: Bearer $AGENTBOARD_TOKEN"
\`\`\`

## Connect an MCP client

Agents that speak the Model Context Protocol (Claude Code, Cursor, DeepSeek Harness, …) can use the bundled stdio server:

\`\`\`json
{ "mcpServers": { "agentboard": {
  "command": "node", "args": ["/path/to/agentboard/src/mcp/server.js"],
  "env": { "AGENTBOARD_URL": "http://127.0.0.1:4317", "AGENTBOARD_TOKEN": "ab_..." }
} } }
\`\`\`

## Example bots

- \`node examples/echo-bot.js\` — claims tasks and reports fake progress; good for trying the board.
- \`node examples/llm-agent.js\` — answers tasks with any OpenAI-compatible chat API (DeepSeek by default).
- \`node examples/dsh-worker.js\` — runs each task through \`dsh --profile headless\`.
`;

/**
 * @param {string} at ISO timestamp for every seeded record
 * @returns {import('./store.js').PersistedState}
 */
export function seedState(at) {
  const page = (/** @type {Partial<import('../shared/model.js').Page>} */ p) => ({
    id: newId('pg'), parentId: null, title: 'Untitled', icon: '📄', kind: /** @type {const} */ ('doc'),
    blocks: [], version: 1, createdBy: OPERATOR_ID, createdAt: at, updatedAt: at, ...p,
  });
  const welcome = page({ title: 'Welcome to Agentboard', icon: '👋', blocks: markdownToBlocks(WELCOME) });
  const quickstart = page({ title: 'Bot quick start', icon: '🤖', parentId: welcome.id, blocks: markdownToBlocks(QUICKSTART) });
  const board = page({ title: 'Agent Ops', icon: '📋', kind: 'board', blocks: markdownToBlocks('Work queue for agents and bots. Drag cards to *To do* to make them claimable.') });
  /** @type {Array<[string, string, import('../shared/model.js').TaskStatus, import('../shared/model.js').Priority, string[], boolean]>} */
  const samples = [
    ['Summarize yesterday’s support tickets', 'Read the ticket export and write a one-page summary of recurring issues.', 'todo', 'high', ['research'], false],
    ['Draft release notes for v0.2', 'Collect merged changes and draft user-facing release notes. Requires approval before publishing.', 'todo', 'normal', ['writing'], true],
    ['Triage new GitHub issues', 'Label each new issue and flag anything that looks like a security report.', 'backlog', 'normal', ['triage'], false],
    ['Rotate staging credentials', 'Coordinate with infra before rotating; ask the operator if anything is unclear.', 'backlog', 'urgent', ['ops'], true],
  ];
  const tasks = samples.map(([title, description, status, priority, labels, needsApproval], i) => ({
    id: newId('tsk'), boardId: board.id, title, description, status, priority, labels,
    requiredCapabilities: [], assigneeId: null, lease: null, needsApproval, approval: null,
    progress: 0, result: '', order: i + 1, createdBy: OPERATOR_ID, createdAt: at, updatedAt: at,
  }));
  return {
    schemaVersion: 1,
    workspace: { name: 'My workspace' },
    pages: [welcome, quickstart, board],
    tasks,
    comments: [],
    agents: [],
    commands: [],
    activity: [{ id: newId('act'), at, actorId: OPERATOR_ID, type: 'workspace.created', summary: 'created the workspace' }],
  };
}
