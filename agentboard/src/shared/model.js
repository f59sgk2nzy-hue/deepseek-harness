// @ts-check
/**
 * Enumerations and record types shared by the server, the client SDK, and the UI.
 *
 * @typedef {import('./markdown.js').Block} Block
 * @typedef {'backlog'|'todo'|'in_progress'|'review'|'blocked'|'done'} TaskStatus
 * @typedef {'low'|'normal'|'high'|'urgent'} Priority
 * @typedef {'agent'|'bot'} AgentKind
 * @typedef {'idle'|'working'|'paused'|'error'|'offline'} AgentStatus
 * @typedef {'pause'|'resume'|'stop'|'message'|'custom'} CommandType
 *
 * @typedef {{
 *   id: string, parentId: string | null, title: string, icon: string,
 *   kind: 'doc' | 'board', blocks: Block[], version: number,
 *   createdBy: string, createdAt: string, updatedAt: string,
 * }} Page
 *
 * @typedef {{ state: 'pending' | 'approved' | 'rejected', by: string | null, note: string, at: string | null }} Approval
 *
 * @typedef {{
 *   id: string, boardId: string, title: string, description: string,
 *   status: TaskStatus, priority: Priority, labels: string[],
 *   requiredCapabilities: string[], assigneeId: string | null,
 *   lease: { agentId: string, expiresAt: string } | null,
 *   needsApproval: boolean, approval: Approval | null,
 *   progress: number, result: string, order: number,
 *   createdBy: string, createdAt: string, updatedAt: string,
 * }} Task
 *
 * @typedef {'comment'|'progress'|'question'|'log'|'system'} CommentKind
 * @typedef {{ id: string, taskId: string, authorId: string, kind: CommentKind, text: string, at: string }} Comment
 *
 * @typedef {{
 *   id: string, name: string, kind: AgentKind, description: string,
 *   capabilities: string[], status: AgentStatus, statusNote: string,
 *   paused: boolean, currentTaskId: string | null, meta: Record<string, string | number | boolean>,
 *   lastSeenAt: string | null, createdAt: string,
 * }} Agent
 *
 * @typedef {{
 *   id: string, agentId: string, type: CommandType, payload: string,
 *   createdBy: string, createdAt: string, ackedAt: string | null, response: string,
 * }} Command
 *
 * @typedef {{ id: string, at: string, actorId: string, type: string, summary: string, pageId?: string, taskId?: string, agentId?: string }} Activity
 */

/** Kanban columns in display order. */
export const TASK_STATUSES = /** @type {const} */ (['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done']);

/** Human-readable column titles keyed by status. */
export const STATUS_LABELS = /** @type {Record<TaskStatus, string>} */ ({
  backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done',
});

/** Priorities from lowest to highest; claim order prefers higher priorities. */
export const PRIORITIES = /** @type {const} */ (['low', 'normal', 'high', 'urgent']);

/** Agent kinds: `agent` reasons with a model; `bot` runs fixed automation. */
export const AGENT_KINDS = /** @type {const} */ (['agent', 'bot']);

/** Statuses an agent may report in a heartbeat. `offline` is derived from presence, never reported. */
export const REPORTABLE_AGENT_STATUSES = /** @type {const} */ (['idle', 'working', 'paused', 'error']);

/** Commands an operator can queue for an agent. */
export const COMMAND_TYPES = /** @type {const} */ (['pause', 'resume', 'stop', 'message', 'custom']);

/** Kinds of task timeline entries. `system` entries are written only by the server. */
export const COMMENT_KINDS = /** @type {const} */ (['comment', 'progress', 'question', 'log', 'system']);

/** Actor id the server records for operator (admin-token) actions. */
export const OPERATOR_ID = 'operator';

/** Actor id the server records for its own actions, such as lease expiry. */
export const SYSTEM_ID = 'system';
