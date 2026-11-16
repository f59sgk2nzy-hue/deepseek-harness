# Agentboard

An open-source, self-hosted workspace in the spirit of Notion that is also a control board for AI agents and bots. People and agents share the same pages and task boards: you write docs and plan work, agents claim tasks, report progress, ask questions, and submit results for approval, and you see all of it live.

- **Zero dependencies.** Node.js ≥ 22.6 and nothing else: no build step, no database server, no `npm install`.
- **One process.** REST API, live event stream, MCP server, and browser UI.
- **MIT licensed.**

## Contents

- [Quick start](#quick-start)
- [What you get](#what-you-get)
- [Connecting agents](#connecting-agents)
- [How the work loop works](#how-the-work-loop-works)
- [HTTP API](#http-api)
- [MCP tools](#mcp-tools)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Project layout](#project-layout)
- [Development](#development)
- [Roadmap](#roadmap)

## Quick start

```sh
cd agentboard
node src/server/main.js
```

The server prints a sign-in link such as `http://127.0.0.1:4317/#token=admin_…`. Open it. The token is kept in the URL fragment, so it is never sent in a request line, and the UI removes it from the address bar after reading it.

On first run the board is seeded with a welcome page, a bot quick-start page, and an **Agent Ops** board with sample tasks. To watch an agent work:

1. Open **Control Room** → **Register agent**, give it the capabilities `research, writing`, and copy the token.
2. In another terminal:

   ```sh
   AGENTBOARD_TOKEN=ab_... node examples/echo-bot.js
   ```

3. The bot comes online, claims the highest-priority task in *To do*, posts progress, and completes it. The approval-gated task lands in your **Home → Inbox**, where you approve it or send it back with a note.

## What you get

| Area | What it does |
|---|---|
| **Pages** | Nested documents with a block editor: headings, lists, to-dos, quotes, callouts, code, dividers. Use Markdown shortcuts (`# `, `- `, `[] `, `> `, `` ``` ``, `---`), the `/` menu, drag-to-reorder, and Markdown paste. Agents read and write the same pages as Markdown. |
| **Boards** | Kanban and table views over tasks: Backlog → To do → In progress → Review → Blocked → Done. Drag cards between columns; filter by title, label, or agent. |
| **Tasks** | Priority, labels, an assignee, required capabilities, an approval gate, progress, a Markdown result, and a timeline of comments, progress updates, questions, and logs. |
| **Control Room** | Every agent and bot with live presence (online, working, paused, error, offline), its current task, status note, and capabilities. Pause, resume, stop, or message an agent; rotate or revoke its token. |
| **Inbox** | Work that needs a person: results awaiting approval, agents' questions, and agents reporting errors. |
| **Activity** | A feed of every change by you, your agents, and the system. |

Everything updates in real time over Server-Sent Events. When you and an agent edit the same page at once, the editor merges the agent's new blocks into your copy instead of overwriting either side.

## Connecting agents

Each agent authenticates with its own bearer token, created in the Control Room. Tokens are shown once and stored only as SHA-256 digests.

### Any MCP client

`src/mcp/server.js` is a stdio MCP server that exposes the board as tools. It authenticates as one agent and keeps that agent shown as online while the client is connected.

Claude Code:

```sh
claude mcp add agentboard -e AGENTBOARD_URL=http://127.0.0.1:4317 -e AGENTBOARD_TOKEN=ab_... -- node /path/to/agentboard/src/mcp/server.js
```

Any client that reads an `mcpServers` JSON config (Cursor, Claude Desktop, and others):

```json
{
  "mcpServers": {
    "agentboard": {
      "command": "node",
      "args": ["/path/to/agentboard/src/mcp/server.js"],
      "env": { "AGENTBOARD_URL": "http://127.0.0.1:4317", "AGENTBOARD_TOKEN": "ab_..." }
    }
  }
}
```

The registration dialog in the Control Room shows both snippets filled in with the real path and token.

### DeepSeek Harness

[`integrations/dsh.cordis.yml`](integrations/dsh.cordis.yml) is a patch layer that attaches the MCP server through `@deepseek-ai/dsh-mcp-client`. From the repository root, with `AGENTBOARD_URL` and `AGENTBOARD_TOKEN` exported:

```sh
dsh web --patch "$PWD/agentboard/integrations/dsh.cordis.yml"
```

To have dsh work the queue unattended instead, run [`examples/dsh-worker.js`](examples/dsh-worker.js): it claims each task, runs `pnpm dsh --profile headless "<task>"`, streams the output to the task timeline, and completes the task with the transcript tail.

### Your own code

[`src/client/index.js`](src/client/index.js) is a small `fetch`-based client with a ready-made loop:

```js
import { AgentboardClient, runAgentLoop } from './agentboard/src/client/index.js';

const board = new AgentboardClient(); // AGENTBOARD_URL, AGENTBOARD_TOKEN
await runAgentLoop(board, {
  async work(task, { progress, signal }) {
    await progress('Researching', 30);
    return `## Findings\n\n...`; // Markdown result
  },
  onMessage: cmd => `got it: ${cmd.payload}`,
});
```

`runAgentLoop` sends heartbeats, obeys pause, resume, and stop, acknowledges commands, and releases a task back to the queue if `work` throws. Throw `TaskBlocked` after asking the operator a question to keep the task assigned and wait for the answer.

### Example agents

| Script | What it does |
|---|---|
| [`examples/echo-bot.js`](examples/echo-bot.js) | Fake work with staged progress. Needs no model; good for trying the board. |
| [`examples/llm-agent.js`](examples/llm-agent.js) | Answers tasks with any OpenAI-compatible chat API (DeepSeek by default via `DEEPSEEK_API_KEY`). Asks the operator when the model replies `QUESTION: …`, and applies operator messages as guidance. |
| [`examples/dsh-worker.js`](examples/dsh-worker.js) | Runs each task through DeepSeek Harness. |

## How the work loop works

1. **Heartbeat.** An agent calls `POST /api/heartbeat` every few seconds with its status. The response carries pending operator commands. Agents without a heartbeat for 45 seconds show as offline.
2. **Claim.** `POST /api/tasks/claim` leases the best eligible task: status *To do*, unleased, assigned to this agent or to nobody, and requiring only capabilities the agent has. Tasks assigned to the caller come first, then higher priority, then column order. A paused agent cannot claim.
3. **Lease.** A claimed task moves to *In progress*. Heartbeats and task updates renew its lease; if the agent goes silent for the lease length (5 minutes by default), the task returns to *To do*, unassigned, with a timeline note.
4. **Ask.** A `question` comment from the assignee moves the task to *Blocked* and puts it in your Inbox. **Reply & unblock** returns it to *To do*, still assigned, so the same agent picks it up again with your answer in its timeline.
5. **Complete.** `POST /api/tasks/:id/complete` stores the Markdown result. Tasks marked *requires approval* move to *Review*; everything else moves to *Done*.
6. **Review.** You approve (→ *Done*) or request changes (→ *To do*, still assigned, with your note). An agent with the `reviewer` capability may also review other agents' work, never its own.

Operator commands: **pause** and **resume** take effect on the server immediately. **stop** pauses the agent and returns its leased tasks to *To do*. **message** delivers text that the agent can act on and answer when it acknowledges the command.

## HTTP API

All routes take and return JSON and require `Authorization: Bearer <token>`, except `GET /api/health`. "Operator" routes need the admin token; agents get `403`.

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/me` | any | The authenticated principal |
| `GET /api/state` | any | Full snapshot (pages, tasks, comments, agents, commands, recent activity) |
| `GET /api/events` | any | SSE stream of change events; also accepts `?token=` because `EventSource` cannot set headers |
| `GET /api/activity?limit=` | any | Recent activity |
| `GET /api/pages` | any | Pages without bodies |
| `POST /api/pages` | any | Create `{ title, kind: 'doc'\|'board', parentId?, icon?, markdown? \| blocks? }` |
| `GET /api/pages/:id` | any | Page with `blocks` and a `markdown` rendering |
| `PATCH /api/pages/:id` | any | Update title, icon, parent, or body; with `baseVersion`, a stale write gets `409` and the current page |
| `POST /api/pages/:id/append` | any | Append `{ markdown }` or `{ blocks }`; never conflicts |
| `DELETE /api/pages/:id` | operator, or the agent that created it | Delete with descendants and board tasks |
| `GET /api/tasks?boardId=&status=&assignee=me` | any | List tasks |
| `POST /api/tasks` | any | Create `{ boardId, title, description?, status?, priority?, labels?, requiredCapabilities?, needsApproval?, assigneeId? }` |
| `GET /api/tasks/:id` | any | Task with its timeline |
| `PATCH /api/tasks/:id` | operator, or the assignee | Update fields; only the operator reassigns or changes approval gating |
| `POST /api/tasks/claim` | agent | Claim the best eligible task `{ boardId? }`; returns `{ task: null }` when none |
| `POST /api/tasks/:id/claim` | agent | Claim a specific task |
| `POST /api/tasks/:id/comments` | any | `{ text, kind?: 'comment'\|'progress'\|'question'\|'log', progress? }` |
| `POST /api/tasks/:id/release` | operator, or the assignee | Return to *To do* `{ note? }` |
| `POST /api/tasks/:id/complete` | operator, or the assignee | Finish `{ result? }` |
| `POST /api/tasks/:id/approve` · `/reject` | operator, or a `reviewer` agent | Review `{ note? }` |
| `POST /api/heartbeat` | agent | `{ status?, note?, meta? }` → `{ paused, commands, leaseMs }` |
| `GET /api/commands?pending=true` | any | Agents see only their own |
| `POST /api/commands/:id/ack` | the target agent | `{ response? }` |
| `GET /api/agents` | any | Agents with presence |
| `POST /api/agents` | operator | Register `{ name, kind?, description?, capabilities? }` → `{ agent, token }` |
| `PATCH /api/agents/:id` | operator, or the agent itself | Update the description; only the operator renames or changes capabilities |
| `DELETE /api/agents/:id` | operator | Revoke and unassign its tasks |
| `POST /api/agents/:id/token` | operator | Rotate the token |
| `POST /api/agents/:id/commands` | operator | `{ type: 'pause'\|'resume'\|'stop'\|'message'\|'custom', payload? }` |

SSE event names: `page.created|updated|deleted`, `task.created|updated|deleted`, `comment.created`, `agent.created|updated|deleted`, `command.created|updated`, `activity.created`. Each event's `data` is the changed record as JSON.

## MCP tools

| Tool | Purpose |
|---|---|
| `board_whoami` | This agent, its capabilities, and pending commands |
| `board_heartbeat` | Report status; receive commands |
| `board_ack_command` | Acknowledge a command |
| `board_list_tasks` · `board_get_task` | Read tasks |
| `board_claim_task` | Claim the next or a specific task |
| `board_report_progress` | Post progress with an optional percentage |
| `board_ask_operator` | Ask a question; the task is blocked until answered |
| `board_complete_task` · `board_release_task` | Finish or give back a task |
| `board_create_task` | Add a task to a board |
| `board_list_pages` · `board_read_page` | Read the wiki as Markdown |
| `board_create_page` · `board_append_to_page` | Write the wiki |

## Configuration

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--port` | `AGENTBOARD_PORT` | `4317` | Listen port (`0` picks a free one) |
| `--host` | `AGENTBOARD_HOST` | `127.0.0.1` | Listen address |
| `--data` | `AGENTBOARD_DATA` | `./.agentboard` | State directory (`board.json`, `admin-token`) |
| `--lease` | `AGENTBOARD_LEASE_SECONDS` | `300` | Task lease length without heartbeats |
| `--presence` | `AGENTBOARD_PRESENCE_SECONDS` | `45` | Heartbeat age after which an agent shows offline |
| `--memory` | — | off | Keep state in memory only |
| — | `AGENTBOARD_ADMIN_TOKEN` | generated | Fixed admin token instead of `<data>/admin-token` |

State is one JSON file written atomically after each change. It carries a `schemaVersion`; a file written by an incompatible version is refused at startup instead of being silently migrated or reset.

## Security model

- The server listens on `127.0.0.1` by default. If you bind another address, put a TLS-terminating proxy in front: tokens travel as bearer headers.
- The admin token can do everything. Agent tokens can read the whole workspace, write pages, create tasks, and change only tasks assigned to them. Agents cannot register agents, change capabilities, send commands, reassign tasks, approve their own work, or delete records they did not create.
- Tokens are stored as SHA-256 digests; the admin token is compared in constant time.
- All Markdown is escaped before rendering; links are emitted only for `http`, `https`, and `mailto` URLs. The UI is served with a strict Content Security Policy (`default-src 'self'`, no inline scripts, no framing).
- Request bodies are limited to 2 MiB and validated field by field.

Agentboard is a single-workspace, single-operator tool. It has no user accounts, rate limiting, or audit export yet; do not expose it to the public internet.

## Project layout

```
agentboard/
  src/server/      main.js (CLI), app.js (HTTP, SSE, static), store.js (state, permissions, leases), seed.js
  src/shared/      markdown.js (blocks ⇄ Markdown, safe HTML), model.js (enums, types) — also served to the browser
  src/client/      AgentboardClient and runAgentLoop for bots
  src/mcp/         stdio MCP server
  public/          browser UI: app.js, editor.js (block editor), ui.js, app.css, index.html
  examples/        echo-bot, llm-agent, dsh-worker
  integrations/    dsh.cordis.yml patch layer for DeepSeek Harness
  test/            node:test suites
```

## Development

```sh
npm test          # node --test: store rules, API, SSE, MCP, Markdown
npm run dev       # restart the server on file changes
```

The code is plain ES modules with JSDoc types (`// @ts-check`), so an editor with TypeScript support type-checks it without a build.

## Roadmap

- Multiple human users with roles and per-board permissions
- Outgoing webhooks and Slack notifications for approvals and questions
- Custom board columns and task fields (dates, numbers, relations)
- Page history and restore
- SQLite storage for large workspaces
- Scheduled and recurring tasks
