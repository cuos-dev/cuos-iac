// SPDX-License-Identifier: Apache-2.0
// Starts mock-iac, the real backend (app.js) against it, and the Vite dev server.
// Usage: npm run dev:mock   ->  http://localhost:5173  (basic auth is injected by the Vite proxy)
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const socket = path.join(os.tmpdir(), 'cuos-webui-dev', 'cuos-iac.sock');
const env = { ...process.env, IAC_SOCKET_PATH: socket, SYSTEM_JSON: path.join(root, 'dev', 'system.json'), PORT: '3000', BACKUP_SOCKET_PATH: path.join(os.tmpdir(), 'cuos-webui-dev', 'cuos-backup.sock') };

const run = (name, args) => {
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = d => String(d).split('\n').filter(Boolean).forEach(l => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag); p.stderr.on('data', tag);
  p.on('exit', code => { console.log(`[${name}] exited (${code})`); shutdown(); });
  return p;
};

const mock = run('mock', ['dev/mock-iac.js']);
await new Promise(r => setTimeout(r, 500));            // app.js asks docker:version once at startup
const kids = [mock, run('app', ['app.js']), run('vite', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'])];

function shutdown() { for (const k of kids) k.kill(); setTimeout(() => process.exit(0), 300); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
