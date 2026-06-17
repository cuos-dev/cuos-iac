import express from 'express';
import basicAuth from 'basic-auth';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import bcrypt from 'bcrypt';

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
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const user = basicAuth(req);
  if (!user || user.name !== USER) {
    res.set('WWW-Authenticate', 'Basic realm="cuos"');
    return res.status(401).send('Authentication required.');
  }
  const isHash = PASS.startsWith('$2b$') || PASS.startsWith('$2a$') || PASS.startsWith('$2y$');
  if (isHash ? !bcrypt.compareSync(user.pass, PASS) : user.pass !== PASS) {
    res.set('WWW-Authenticate', 'Basic realm="cuos"');
    return res.status(401).send('Authentication required.');
  }
  next();
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

// SSE: poll all IaC state every 2s, push on change
app.get('/api/state', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  let last = '';
  async function poll() {
    try {
      const [cuosState, resources, ps, appState, progress] = await Promise.all([
        iacApi('cuos:state'), iacApi('cuos:resources'), iacApi('ps'), iacApi('state'), iacApi('progress'),
      ]);
      if (resources && typeof resources === 'object') {
        resources.ram_percent = Math.round((resources.mem_used_mb / resources.mem_total_mb) * 100);
        resources.disk_percent = Math.round((resources.disk_used_mb / resources.disk_total_mb) * 100);
      }
      const payload = JSON.stringify({ cuosState, resources, ps, appState, progress });
      if (payload !== last) { last = payload; res.write(`data: ${payload}\n\n`); }
    } catch {}  // ponytail: socket errors silently dropped; client reconnects
  }
  poll();
  const timer = setInterval(poll, 2000);
  req.on('close', () => clearInterval(timer));
});

// SSE: poll cuos:log every 5s, stream new entries (no journalctl needed inside container)
app.get('/api/logs/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  let lastTs = '';
  async function poll() {
    try {
      const logs = await iacApi('cuos:log');
      if (!Array.isArray(logs)) return;
      const fresh = lastTs ? logs.filter(l => l.date > lastTs) : logs.slice(-100);
      if (fresh.length) {
        lastTs = fresh.at(-1).date;
        for (const l of fresh) res.write(`data: ${JSON.stringify(l)}\n\n`);
      }
    } catch {}
  }
  poll();
  const timer = setInterval(poll, 5000);
  req.on('close', () => clearInterval(timer));
});

// Proxy actions to IaC socket
const ALLOWED = new Set([
  'update', 'cuos:update', 'cuos:shutdown', 'cuos:reboot', 'cuos:rollback', 'config',
  'docker:restart', 'docker:recreate', 'docker:stop', 'docker:start', 'dry-run',
]);
app.post('/api/action', async (req, res) => {
  const { command, ...data } = req.body;
  if (!ALLOWED.has(command)) return res.status(400).json({ error: 'unknown command' });
  try {
    const result = await iacApi(command, data);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA shell
const SPA = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CuOS IaC</title>
  <link rel="stylesheet" href="/public/style.css">
</head>
<body><div id="app"></div>
<script type="module" src="/public/app.js"></script>
</body>
</html>`;

app.get('/', (req, res) => res.send(SPA));

const PORT = 3000;
const server = app.listen(PORT, () => console.log(`webui listening on :${PORT}`));
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 1000); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
