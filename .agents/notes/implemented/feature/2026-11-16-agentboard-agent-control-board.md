# Agent Note: Agentboard agent control board

Status: implemented

## Problem

Operators who run several agents and bots have no shared place to plan their work, hand it out, watch it happen, and review the results. Task trackers do not model agent presence, leases, or operator commands, and agent dashboards do not hold the documents and plans the work comes from. The harness Web GUI drives one session at a time; it is not a queue that many independent agents pull from.

## Decision

[`agentboard/`](../../../../agentboard/README.md) is a self-contained, MIT-licensed Node.js application: a Notion-style workspace of nested block pages and kanban boards in which registered agents are first-class participants.

- **Placement.** It lives at the repository root outside `pnpm-workspace.yaml`, with no dependencies, no build step, and plain ES modules typed with JSDoc. Repository gates, releases, and the `@deepseek-ai/dsh-*` package rules do not apply to it, and it imports nothing from the harness.
- **Principals.** One operator token can do everything. Each agent has its own bearer token stored as a SHA-256 digest. Agents may write pages, create tasks, and change only tasks assigned to them; they cannot register agents, change capabilities, send commands, reassign tasks, or approve their own work.
- **Work loop.** Agents heartbeat, claim the best eligible task under a lease that heartbeats renew, post progress, ask questions that block the task into the operator's inbox, and complete with a Markdown result. Approval-gated tasks wait in Review for the operator or a `reviewer` agent other than the assignee. Expired leases return tasks to To do.
- **Operator commands.** Pause and resume take effect on the server; stop also returns the agent's leased tasks; messages are delivered with the next heartbeat and acknowledged with a response.
- **Surfaces.** A REST API, an SSE change stream, a stdio MCP server exposing the board as tools, a `fetch` client with a ready-made agent loop, and a browser UI. [`integrations/dsh.cordis.yml`](../../../../agentboard/integrations/dsh.cordis.yml) attaches the MCP server to DSH through `@deepseek-ai/dsh-mcp-client`.
- **Storage.** One JSON document written atomically, carrying `schemaVersion`; any other version is refused at load.

## Alternatives considered

**A harness package group under `packages/`.** It would inherit the release, coverage, i18n, and snapshot gates written for agent-loop plugins, none of which describe a standalone web application, and it would couple a tool that serves any agent to the harness release train.

**A plugin inside the DSH Web GUI.** The GUI drives sessions of one harness. A control board must accept agents from any runtime, so it needs its own authentication and a protocol that is not the harness session protocol.

**A database server or an npm dependency set.** SQLite or Postgres plus a web framework would scale further, but would require installation before a first run. One JSON file suits the intended single-operator workspace; SQLite storage is on the roadmap.

## Consequences

Agentboard runs with `node src/server/main.js` and nothing else, and any HTTP client or MCP client can join it. In exchange, repository-wide gates do not check it; its own `node --test` suites cover store rules, the API, SSE, MCP, and Markdown conversion. It is single-workspace and single-operator, has no rate limiting, and must sit behind TLS before it listens beyond localhost.
