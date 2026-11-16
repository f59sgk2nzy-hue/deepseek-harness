#!/usr/bin/env node
// @ts-check
/**
 * Runs each claimed task through DeepSeek Harness: `pnpm dsh --profile headless "<task>"`
 * in a working directory, streams output to the task timeline, and completes the task
 * with the tail of the transcript. A `stop` command kills the run.
 *
 *   AGENTBOARD_TOKEN=ab_... DEEPSEEK_API_KEY=sk-... node examples/dsh-worker.js
 *
 * Environment: DSH_CWD (default: the repository that contains agentboard/),
 * DSH_PROFILE (default headless), DSH_COMMAND (default pnpm).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentboardClient, runAgentLoop } from '../src/client/index.js';

const cwd = process.env.DSH_CWD ?? fileURLToPath(new URL('../..', import.meta.url));
const profile = process.env.DSH_PROFILE ?? 'headless';
const command = process.env.DSH_COMMAND ?? 'pnpm';
const board = new AgentboardClient();

await runAgentLoop(board, {
  heartbeatMs: 5000,
  async work(task, { progress, signal }) {
    const prompt = `${task.title}\n\n${task.description}`.trim();
    await progress(`Starting dsh --profile ${profile} in ${cwd}`, 5);
    const child = spawn(command, ['dsh', '--profile', profile, prompt], { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let pending = '';
    const flush = async () => {
      if (!pending.trim()) return;
      const chunk = pending;
      pending = '';
      await board.comment(task.id, '```\n' + chunk.slice(-4000) + '\n```', { kind: 'log' });
    };
    const timer = setInterval(() => { flush().catch(() => { /* a dropped log chunk is acceptable; the final result carries the tail */ }); }, 4000);
    child.stdout.on('data', d => { output += d; pending += d; });
    child.stderr.on('data', d => { pending += d; });
    const code = await new Promise(resolve => {
      child.on('error', err => resolve(signal.aborted ? 'aborted' : err.message));
      child.on('close', resolve);
    });
    clearInterval(timer);
    await flush();
    if (code !== 0) throw new Error(`dsh exited with ${code}`);
    return `## dsh result\n\n${output.trim().slice(-20000) || '_no output_'}`;
  },
});
