#!/usr/bin/env node
// @ts-check
/**
 * Demo bot: claims tasks, reports staged progress, and completes them with a short
 * report. Useful for trying the board without a model.
 *
 *   AGENTBOARD_TOKEN=ab_... node examples/echo-bot.js
 */

import { AgentboardClient, runAgentLoop } from '../src/client/index.js';

const board = new AgentboardClient();
const steps = ['Reading the task', 'Gathering context', 'Drafting the result', 'Double-checking'];

await runAgentLoop(board, {
  async work(task, { progress, signal }) {
    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) return;
      await progress(steps[i], Math.round(((i + 1) / (steps.length + 1)) * 100));
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return [
      `## ${task.title}`,
      '',
      `Echo bot processed this task at ${new Date().toLocaleTimeString()}.`,
      '',
      '- [x] Read the description',
      `- [x] Finished ${steps.length} steps`,
      '',
      task.description ? `> ${task.description.split('\n')[0]}` : '',
    ].join('\n');
  },
  onMessage(cmd) {
    return `echo: ${cmd.payload}`;
  },
});
