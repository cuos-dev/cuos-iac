// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import { parse as parseBasicAuth } from 'basic-auth';
import net from 'net';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import bcrypt from 'bcrypt';
import { WebSocketServer } from 'ws';

// overridable so the UI can run against a mock (see dev/)
const IAC_SOCKET_PATH = process.env.IAC_SOCKET_PATH || '/socket/cuos-iac.sock';
const SYSTEM_JSON     = process.env.SYSTEM_JSON     || '/system.json';
let config = {};
try {
  config = JSON.parse(await fs.readFile(SYSTEM_JSON, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') { console.error('Error reading system.json:', e.message); process.exit(1); }
  console.warn('system.json not found, using defaults');
}

// --- users and roles ---
// system.json: "iac_users": [{ "name": "...", "password": "<bcrypt hash or plain>", "role": "admin" | "viewer" }]
// The older "iac_user" / "iac_password" pair still works and is an admin. A user without a
// role is a viewer (least privilege); an unknown role is rejected, never promoted.
const ROLES = new Set(['admin', 'viewer']);

function loadUsers(cfg) {
  const users = [];
  const add = (u, origin) => {
    const role = u?.role ?? 'viewer';
    if (!u?.name || !u?.password || !ROLES.has(role)) { console.warn(`ignoring invalid user entry in ${origin}`); return; }
    if (users.some(x => x.name === u.name)) { console.warn(`ignoring duplicate user "${u.name}" in ${origin}`); return; }
    users.push({ name: String(u.name), password: String(u.password), role });
  };
  if (Array.isArray(cfg.iac_users)) cfg.iac_users.forEach(u => add(u, 'iac_users'));
  if (cfg.iac_user && cfg.iac_password) add({ name: cfg.iac_user, password: cfg.iac_password, role: 'admin' }, 'iac_user');
  if (!users.length) {
    console.warn('system.json has no usable users (iac_users / iac_user+iac_password), using admin/admin');
    users.push({ name: 'admin', password: 'admin', role: 'admin' });
  } else if (!users.some(u => u.role === 'admin')) {
    console.warn('no admin user configured: every action will be refused');
  }
  return users;
}
const USERS = loadUsers(config);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.static(path.join(__dirname, 'dist')));

// basic-auth v3 takes the header string (v2 took the request) and throws on a missing header
const basicAuth = req => (req.headers.authorization ? parseBasicAuth(req.headers.authorization) : undefined);

const isHash = p => /^\$2[aby]\$/.test(p);
const sha = v => crypto.createHash('sha256').update(v).digest();
const DUMMY_HASH = bcrypt.hashSync('not-a-password', 10);   // keeps timing similar for unknown users

// returns the matching user or null
function checkCreds(cred) {
  if (!cred) return null;
  const user = USERS.find(u => u.name === cred.name);
  if (!user) { bcrypt.compareSync(cred.pass, DUMMY_HASH); return null; }
  const ok = isHash(user.password)
    ? bcrypt.compareSync(cred.pass, user.password)
    : crypto.timingSafeEqual(sha(cred.pass), sha(user.password));
  return ok ? user : null;
}

function auth(req, res, next) {
  const user = checkCreds(basicAuth(req));
  if (user) { req.user = user; return next(); }
  res.set('WWW-Authenticate', 'Basic realm="cuos"');
  res.status(401).send('Authentication required.');
}

function iacApi(app_command, data = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(IAC_SOCKET_PATH);
    client.on('connect', () => client.write(JSON.stringify({ app_command, ...data }) + '\n'));
    let response = '';
    client.on('data', chunk => (response += chunk.toString()));
    client.on('end', () => { try { resolve(JSON.parse(response)); } catch { resolve(response.trim()); } });
    client.on('error', reject);
  });
}

// --- system info ---

const IAC_PREFIX = '[cuos-iac] ';
function tagLog(entry) {
  if (entry.src) return entry;
  if ((entry.message || '').startsWith(IAC_PREFIX))
    return { ...entry, src: 'iac', message: entry.message.slice(IAC_PREFIX.length) };
  return { ...entry, src: 'os' };
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// ponytail: docker version cached at startup — almost never changes, not worth polling
let dockerVersion = null;
try { dockerVersion = (await iacApi('docker:version'))?.version ?? null; } catch {}

function getSystem() {
  return { hostname: os.hostname(), kernel: os.release(), uptime: fmtUptime(Math.floor(os.uptime())), docker: dockerVersion };
}

// --- WebSocket broadcast state ---

const clients = new Set();
let lastStateSerialized = null;
let lastLogTs = '';
const recentLogs = [];                 // sent to clients on connect, so a reload doesn't start with an empty log
const LOG_HISTORY = 200;

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1 /* OPEN */) ws.send(str);
}

async function pollState() {
  try {
    const [cuosState, resources, ps, appState, progress] = await Promise.all([
      iacApi('cuos:state'), iacApi('cuos:resources'), iacApi('ps'), iacApi('state'), iacApi('progress'),
    ]);
    if (resources && typeof resources === 'object') {
      resources.ram_percent  = Math.round((resources.mem_used_mb  / resources.mem_total_mb)  * 100);
      resources.disk_percent = Math.round((resources.disk_used_mb / resources.disk_total_mb) * 100);
      resources.cpu_percent  = Math.round(resources.cpu_usage ?? 0);
    }
    if (appState && typeof appState === 'object') {
      appState.iac_started = appState.last_iac_start ?? null;
      appState.commit      = appState.iac_commit ?? null;
    }
    const msg = { type: 'state', cuosState, resources, ps, appState, progress, system: getSystem() };
    const str = JSON.stringify(msg);
    if (str === lastStateSerialized) return;
    lastStateSerialized = str;
    for (const ws of clients) if (ws.readyState === 1) ws.send(str);
  } catch {} // ponytail: socket errors silently dropped; clients reconnect
}

async function pollLogs() {
  try {
    const logs = await iacApi('cuos:log');
    if (!Array.isArray(logs)) return;
    const fresh = lastLogTs ? logs.filter(l => l.date > lastLogTs) : logs.slice(-LOG_HISTORY);
    if (!fresh.length) return;
    lastLogTs = fresh.at(-1).date;
    for (const l of fresh) {
      const entry = { type: 'log', ...tagLog(l) };
      recentLogs.push(entry);
      if (recentLogs.length > LOG_HISTORY) recentLogs.shift();
      broadcast(entry);
    }
  } catch {}
}

setInterval(pollState, 2000);
setInterval(pollLogs, 5000);

// --- Express routes ---

app.use(auth);

app.get('/api/config', (req, res) => {
  const rawUrl = config.iac_repo_url || '';
  res.json({
    user: { name: req.user.name, role: req.user.role },
    locale: process.env.LOCALE || 'de-DE',
    tz: process.env.TZ || 'Europe/Berlin',
    iac_poll_interval: config.iac_poll_interval || 21600,
    iac_manual_updates: !!config.iac_manual_updates,
    iac_repo_url: rawUrl.replace(/^(https?:\/\/)[^/]+@/, '$1').replace(/^git@[^:]+:/, 'https://').replace(/\.git$/, ''),
    iac_repo_name: rawUrl.replace(/^https?:\/\/.+\//, '').replace(/^git@[^:]+:/, '').replace(/\.git$/, ''),
    iac_repo_branch: config.iac_repo_branch || 'main',
  });
});

const ALLOWED = new Set([
  'update', 'cuos:update', 'cuos:shutdown', 'cuos:reboot', 'cuos:rollback', 'config',
  'docker:restart', 'docker:recreate', 'docker:stop', 'docker:start', 'dry-run',
  'docker:logs', 'docker:remove', 'docker:version', 'compose:file', 'ps',
]);

// Everything in ALLOWED is for admins; viewers get the read-only subset.
const VIEWER_ALLOWED = new Set(['ps', 'docker:version', 'docker:logs']);
const permitted = (role, command) => ALLOWED.has(command) && (role === 'admin' || VIEWER_ALLOWED.has(command));

app.use((_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

// --- server + WebSocket ---

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, () => console.log(`webui listening on :${PORT}`));
const wss = new WebSocketServer({ noServer: true });

// ponytail: browsers forward cached basic-auth on same-origin WS upgrades; check it here
server.on('upgrade', (req, socket, head) => {
  const user = checkCreds(basicAuth(req));
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => { ws.user = user; wss.emit('connection', ws); });
});

wss.on('connection', ws => {
  clients.add(ws);
  if (lastStateSerialized) ws.send(lastStateSerialized); // immediate paint on connect
  if (recentLogs.length) ws.send(JSON.stringify({ type: 'log_history', entries: recentLogs }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'action') return;
    const { id, command, type: _, ...data } = msg;
    if (!ALLOWED.has(command)) { ws.send(JSON.stringify({ type: 'action_result', id, error: 'unknown command' })); return; }
    if (!permitted(ws.user.role, command)) {
      console.warn(`denied: ${ws.user.name} (${ws.user.role}) tried ${command}`);
      ws.send(JSON.stringify({ type: 'action_result', id, command, error: 'forbidden' }));
      return;
    }
    try {
      const result = await iacApi(command, data);
      ws.send(JSON.stringify({ type: 'action_result', id, command, result }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'action_result', id, command, error: e.message }));
    }
  });
});

function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 1000); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
