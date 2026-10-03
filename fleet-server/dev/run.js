// SPDX-License-Identifier: Apache-2.0
// Starts mock VM/VL, the real fleet-server against them, fake agents and the Vite dev server.
// Usage: npm run dev:mock   ->  http://127.0.0.1:5173/ui/  (basic auth is injected by the Vite proxy)
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(os.tmpdir(), 'cuos-fleet-dev');
fs.rmSync(data, { recursive: true, force: true });          // fresh database every start
const env = {
  ...process.env, FLEET_DATA_DIR: data, FLEET_SERVER_PORT: '8085', FLEET_SECRET: 'dev-fleet-secret',
  FLEET_VM_URL: 'http://127.0.0.1:18428', FLEET_VL_URL: 'http://127.0.0.1:18428',
  FLEET_USERS_FILE: path.join(root, 'dev', 'users.json'),
  FLEET_API_KEYS: 'dev-admin-key', FLEET_API_KEYS_READONLY: 'dev-ro-key',
  FLEET_LATEST_CUOS: '2026.10.1', FLEET_LATEST_AGENT: '0.5.2',
};

const kids = [];
const run = (name, args, cwd = root) => {
  const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = d => String(d).split('\n').filter(Boolean).forEach(l => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag); p.stderr.on('data', tag);
  p.on('exit', code => { console.log(`[${name}] exited (${code})`); shutdown(); });
  kids.push(p);
};

run('mock', ['dev/mock-backends.js']);
await new Promise(r => setTimeout(r, 400));
run('server', ['server.js']);
run('agents', ['dev/fake-agents.js']);
run('vite', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], path.join(root, 'webui'));

function shutdown() { for (const k of kids) k.kill(); setTimeout(() => process.exit(0), 300); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
