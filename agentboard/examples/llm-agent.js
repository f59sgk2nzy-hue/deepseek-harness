#!/usr/bin/env node
// @ts-check
/**
 * Model-backed agent: answers each claimed task with an OpenAI-compatible chat
 * completions API (DeepSeek by default). The model sees the task, its timeline
 * (including operator answers and review notes), and any operator messages. When
 * the model replies with `QUESTION: …` the agent asks the operator and moves on.
 *
 *   AGENTBOARD_TOKEN=ab_... DEEPSEEK_API_KEY=sk-... node examples/llm-agent.js
 *
 * Environment: LLM_BASE_URL (default https://api.deepseek.com), LLM_API_KEY or
 * DEEPSEEK_API_KEY, LLM_MODEL (default deepseek-chat).
 */

import { AgentboardClient, TaskBlocked, runAgentLoop } from '../src/client/index.js';

const baseUrl = (process.env.LLM_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const apiKey = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
const model = process.env.LLM_MODEL ?? 'deepseek-chat';
if (!apiKey) {
  console.error('llm-agent: set LLM_API_KEY or DEEPSEEK_API_KEY');
  process.exit(2);
}

const board = new AgentboardClient();
/** Operator messages received through commands, oldest first. */
const guidance = [];

/**
 * @param {Array<{ role: string, content: string }>} messages
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function chat(messages, signal) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.3 }),
    signal,
  });
  if (!res.ok) throw new Error(`model API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

await runAgentLoop(board, {
  async work(task, { progress, signal }) {
    const full = await board.getTask(task.id);
    const timeline = full.comments.map(c => `[${c.kind} by ${c.authorId}] ${c.text}`).join('\n');
    await progress(`Thinking with ${model}…`, 20);
    const answer = await chat([
      {
        role: 'system',
        content: 'You are an agent working tasks from a shared team board. Produce the deliverable the task asks for, in Markdown, concise and complete. ' +
          'If the task cannot be done without information only a human has, reply with exactly one line starting with "QUESTION:" and nothing else.' +
          (guidance.length ? `\n\nOperator guidance:\n${guidance.map(g => `- ${g}`).join('\n')}` : ''),
      },
      { role: 'user', content: `# ${full.title}\n\n${full.description || '(no description)'}${timeline ? `\n\n## Timeline\n${timeline}` : ''}` },
    ], signal);
    const question = /^\s*QUESTION:\s*(.+)$/s.exec(answer);
    if (question) {
      await board.comment(task.id, question[1].trim(), { kind: 'question' });
      throw new TaskBlocked('asked the operator');
    }
    await progress('Draft ready', 90);
    return answer;
  },
  onMessage(cmd) {
    guidance.push(cmd.payload);
    return 'noted for upcoming tasks';
  },
});
