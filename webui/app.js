import express from 'express';
import basicAuth from 'basic-auth';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import bcrypt from 'bcrypt';
import { WebSocketServer } from 'ws';

const IAC_SOCKET_PATH = '/socket/cuos-iac.sock';
let USER = 'admin', PASS = 'admin';

let config = {};
try {
  config = JSON.parse(await fs.readFile('/system.json', 'utf8'));
  if (config.iac_user && config.iac_password) { USER = config.iac_user; PASS = config.iac_password; }
  else console.warn('system.json missing iac_user/iac_password, using defaults');
} catch (e) {
  if (e.code !== 'ENOENT') { console.error('Error reading system.json:', e.message); process.exit(1); }
  console.warn('system.json not found, using defaults');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.static(path.join(__dirname, 'dist')));

function checkCreds(user) {
  if (!user || user.name !== USER) return false;
  const isHash = PASS.startsWith('$2b$') || PASS.startsWith('$2a$') || PASS.startsWith('$2y$');
  return isHash ? bcrypt.compareSync(user.pass, PASS) : user.pass === PASS;
}

function auth(req, res, next) {
  if (checkCreds(basicAuth(req))) return next();
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
      resources.ram_percent = Math.round((resources.mem_used_mb / resources.mem_total_mb) * 100);
      resources.disk_percent = Math.round((resources.disk_used_mb / resources.disk_total_mb) * 100);
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
    const fresh = lastLogTs ? logs.filter(l => l.date > lastLogTs) : logs.slice(-100);
    if (!fresh.length) return;
    lastLogTs = fresh.at(-1).date;
    for (const l of fresh) broadcast({ type: 'log', ...tagLog(l) });
  } catch {}
}

setInterval(pollState, 2000);
setInterval(pollLogs, 5000);

// --- Express routes ---

app.use(auth);

app.get('/api/config', (req, res) => {
  const rawUrl = config.iac_repo_url || '';
  res.json({
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
  'docker:logs', 'docker:remove', 'docker:version', 'compose:file',
]);

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

// --- server + WebSocket ---

const PORT = 3000;
const server = app.listen(PORT, () => console.log(`webui listening on :${PORT}`));
const wss = new WebSocketServer({ noServer: true });

// ponytail: browsers forward cached basic-auth on same-origin WS upgrades; check it here
server.on('upgrade', (req, socket, head) => {
  if (!checkCreds(basicAuth(req))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});

wss.on('connection', ws => {
  clients.add(ws);
  if (lastStateSerialized) ws.send(lastStateSerialized); // immediate paint on connect
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'action') return;
    const { id, command, type: _, ...data } = msg;
    if (!ALLOWED.has(command)) { ws.send(JSON.stringify({ type: 'action_result', id, error: 'unknown command' })); return; }
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
