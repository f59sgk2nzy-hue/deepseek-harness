#!/usr/bin/env node
// @ts-check
/**
 * `agentboard` command: starts the board server.
 *
 *   agentboard [--port 4317] [--host 127.0.0.1] [--data ./.agentboard] [--lease 300] [--memory]
 *
 * The admin token comes from `AGENTBOARD_ADMIN_TOKEN`, else from `<data>/admin-token`,
 * which is generated (mode 0600) on first start.
 */

import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { createApp } from './app.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.AGENTBOARD_PORT ?? '4317' },
    host: { type: 'string', default: process.env.AGENTBOARD_HOST ?? '127.0.0.1' },
    data: { type: 'string', default: process.env.AGENTBOARD_DATA ?? '.agentboard' },
    lease: { type: 'string', default: process.env.AGENTBOARD_LEASE_SECONDS ?? '300' },
    presence: { type: 'string', default: process.env.AGENTBOARD_PRESENCE_SECONDS ?? '45' },
    memory: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: agentboard [options]

  --port <n>        listen port (AGENTBOARD_PORT, default 4317)
  --host <addr>     listen address (AGENTBOARD_HOST, default 127.0.0.1)
  --data <dir>      state directory (AGENTBOARD_DATA, default ./.agentboard)
  --lease <sec>     task lease length without heartbeats (default 300)
  --presence <sec>  heartbeat age after which an agent shows offline (default 45)
  --memory          keep state in memory only
`);
  process.exit(0);
}

/**
 * @param {string} raw
 * @param {string} flag
 * @returns {number}
 */
function positiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`agentboard: --${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`agentboard: --port must be 0–65535, got ${JSON.stringify(values.port)}`);
  process.exit(2);
}
const leaseMs = positiveInt(values.lease, 'lease') * 1000;
const presenceMs = positiveInt(values.presence, 'presence') * 1000;
const dataDir = resolve(values.data);

let adminToken = process.env.AGENTBOARD_ADMIN_TOKEN;
if (!adminToken) {
  if (values.memory) adminToken = `admin_${randomBytes(24).toString('base64url')}`;
  else {
    const tokenFile = join(dataDir, 'admin-token');
    mkdirSync(dataDir, { recursive: true });
    if (!existsSync(tokenFile)) writeFileSync(tokenFile, `admin_${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
    adminToken = readFileSync(tokenFile, 'utf8').trim();
  }
}

const store = new Store({ file: values.memory ? null : join(dataDir, 'board.json'), leaseMs, presenceMs });
const app = createApp({ store, adminToken });

app.server.listen(port, values.host, () => {
  const addr = /** @type {import('node:net').AddressInfo} */ (app.server.address());
  const shown = values.host === '0.0.0.0' || values.host === '::' ? 'localhost' : values.host.includes(':') ? `[${values.host}]` : values.host;
  const base = `http://${shown}:${addr.port}`;
  console.log(`Agentboard is running at ${base}`);
  console.log(`Open the board:  ${base}/#token=${encodeURIComponent(adminToken)}`);
  console.log(values.memory ? 'State: in memory (lost on exit)' : `State: ${join(dataDir, 'board.json')}`);
  if (values.host !== '127.0.0.1' && values.host !== 'localhost' && values.host !== '::1') {
    console.warn('Warning: listening beyond localhost over plain HTTP; put a TLS proxy in front before exposing it.');
  }
});

let closing = false;
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, async () => {
    if (closing) process.exit(1);
    closing = true;
    await app.close();
    process.exit(0);
  });
}
