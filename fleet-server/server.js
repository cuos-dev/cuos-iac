// SPDX-License-Identifier: Apache-2.0
// Fleet Server
import express from 'express';
import path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { parse as parseBasicAuth } from 'basic-auth';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const PORT          = process.env.FLEET_SERVER_PORT  || 8085;
const WS_SECRET     = process.env.FLEET_SECRET       || 'changeme';
const LATEST_CUOS   = process.env.FLEET_LATEST_CUOS  || null;
const LATEST_AGENT  = process.env.FLEET_LATEST_AGENT || null;
const UI_WS_NONCE  = crypto.randomBytes(16).toString('hex'); // per-boot, injected into the page
const FLEET_VM_URL = process.env.FLEET_VM_URL; // VictoriaMetrics base, e.g. http://victoriametrics:8428
const FLEET_VL_URL = process.env.FLEET_VL_URL; // VictoriaLogs base, e.g. http://victorialogs:9428
const DATA_DIR = process.env.FLEET_DATA_DIR || '/data';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- SQLite ---
const db = new Database(path.join(DATA_DIR, 'fleet.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    hostname TEXT,
    cuos_version TEXT,
    agent_version TEXT,
    tags TEXT,
    repo_url TEXT,
    repo_branch TEXT,
    protocol_version INTEGER DEFAULT 1,
    status TEXT DEFAULT 'offline',
    connected_at TEXT,
    last_seen TEXT,
    last_update TEXT,
    metrics TEXT
  );
  CREATE TABLE IF NOT EXISTS metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    metrics TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS update_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    phase TEXT,
    success INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mh_device ON metrics_history(device_id, collected_at);
  CREATE INDEX IF NOT EXISTS idx_ue_device ON update_events(device_id, ts);
`);
// ponytail: migrate existing DBs; ignore error if column already exists
try { db.exec(`ALTER TABLE devices ADD COLUMN agent_version TEXT`); } catch {}
try { db.exec(`ALTER TABLE devices ADD COLUMN shares TEXT`); } catch {}

const stmts = {
  upsertDevice: db.prepare(`
    INSERT INTO devices (id, hostname, cuos_version, agent_version, tags, repo_url, repo_branch, protocol_version, status, connected_at, last_seen, last_update, metrics, shares)
    VALUES (@id, @hostname, @cuosVersion, @agentVersion, @tags, @repoUrl, @repoBranch, @protocolVersion, @status, @connectedAt, @lastSeen, @lastUpdate, @metrics, @shares)
    ON CONFLICT(id) DO UPDATE SET
      hostname=excluded.hostname, cuos_version=excluded.cuos_version, agent_version=excluded.agent_version, tags=excluded.tags,
      repo_url=excluded.repo_url, repo_branch=excluded.repo_branch,
      protocol_version=excluded.protocol_version, status=excluded.status,
      connected_at=excluded.connected_at, last_seen=excluded.last_seen,
      last_update=COALESCE(excluded.last_update, devices.last_update),
      metrics=COALESCE(excluded.metrics, devices.metrics),
      shares=excluded.shares
  `),
  updateStatus: db.prepare(`UPDATE devices SET status=@status, last_update=COALESCE(@lastUpdate, last_update), last_seen=@lastSeen WHERE id=@id`),
  updateSeen:   db.prepare(`UPDATE devices SET last_seen=@lastSeen WHERE id=@id`),
  updateMetrics:db.prepare(`UPDATE devices SET metrics=@metrics, last_seen=@lastSeen WHERE id=@id`),
  insertMetrics:db.prepare(`INSERT INTO metrics_history (device_id, collected_at, metrics) VALUES (@deviceId, @collectedAt, @metrics)`),
  pruneMetrics: db.prepare(`DELETE FROM metrics_history WHERE device_id=@deviceId AND collected_at < datetime('now', '-7 days')`),
  insertEvent:  db.prepare(`INSERT INTO update_events (device_id, ts, phase, success, error) VALUES (@deviceId, @ts, @phase, @success, @error)`),
  allDevices:   db.prepare(`SELECT * FROM devices`),
};

// Migrate from clients.json if present
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
if (fs.existsSync(CLIENTS_FILE)) {
  try {
    const old = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
    db.transaction(() => {
      for (const c of Object.values(old)) {
        stmts.upsertDevice.run({
          id: c.id, hostname: c.hostname || null, cuosVersion: c.cuos_version || null,
          tags: JSON.stringify(c.tags || []), repoUrl: c.repo_url || null, repoBranch: c.repo_branch || null,
          protocolVersion: c.protocol_version || 1, status: 'offline',
          connectedAt: c.connected_at || null, lastSeen: c.last_seen || null,
          lastUpdate: c.last_update || null, metrics: c.metrics ? JSON.stringify(c.metrics) : null, shares: null,
        });
      }
    })();
    fs.renameSync(CLIENTS_FILE, CLIENTS_FILE + '.migrated');
    console.log(JSON.stringify({ level: 'info', msg: 'migrated clients.json to SQLite' }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'clients.json migration failed', error: e.message }));
  }
}

// What a device says it shares (protocol 2). null = protocol 1 agent, which sends everything.
// The agent is the real boundary; the server scrubs once more so stored data can never go beyond
// the announced manifest. Field lists mirror fleet-agent/share.js.
const NETWORK_LEVELS = ['none', 'summary', 'full'];
function sanitizeShares(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    resources: raw.resources !== false,
    iac_state: raw.iac_state !== false,
    network: NETWORK_LEVELS.includes(raw.network) ? raw.network : 'summary',
    logs: raw.logs === true,
    remote_update: raw.remote_update !== false,
  };
}
const NET_SUMMARY = ['default_route_ip'];
const NET_FULL = [...NET_SUMMARY, 'network', 'dns_servers', 'ntp_servers', 'ntp_service_active', 'ntp_synchronizede', 'routes'];
const LOAD_FIELDS = ['cpu_usage', 'cpu_cores', 'ram_percent', 'mem_used_mb', 'mem_total_mb', 'disk_percent', 'disk_used_mb', 'disk_total_mb', 'uptime_seconds', 'virt_type'];
function scrubResources(resources, shares) {
  if (!shares || !resources || typeof resources !== 'object') return resources;
  const keep = new Set([...(shares.resources ? LOAD_FIELDS : []), ...(shares.network === 'full' ? NET_FULL : shares.network === 'summary' ? NET_SUMMARY : [])]);
  return Object.fromEntries(Object.entries(resources).filter(([k]) => keep.has(k)));
}

// Load all devices into memory; mark all offline until they reconnect
db.prepare(`UPDATE devices SET status='offline'`).run();
function rowToDevice(row) {
  return { ...row, tags: JSON.parse(row.tags || '[]'), metrics: row.metrics ? JSON.parse(row.metrics) : null, shares: row.shares ? JSON.parse(row.shares) : null };
}
const clients = {};
for (const row of stmts.allDevices.all()) clients[row.id] = rowToDevice(row);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// behind a reverse proxy set FLEET_TRUST_PROXY (true, a hop count or a subnet name) so req.ip is the client, not the proxy
if (process.env.FLEET_TRUST_PROXY) {
  const t = process.env.FLEET_TRUST_PROXY;
  app.set('trust proxy', t === 'true' ? true : /^\d+$/.test(t) ? Number(t) : t);
}
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- Auth: Basic Auth for browsers, Bearer keys for automation ---------------------------------
// Users come from FLEET_USERS_FILE (default: <data dir>/users.json), a JSON array of
//   { "name": "...", "password": "<bcrypt hash or plain text>", "role": "admin" | "viewer" }
// FLEET_ADMIN_USER / FLEET_ADMIN_PASS still work and are an admin. A user without a role is a
// viewer (least privilege); an unknown role is rejected, never promoted.
// FLEET_API_KEYS are admin keys, FLEET_API_KEYS_READONLY are viewer keys.
const ROLES = new Set(['admin', 'viewer']);
const warn = msg => console.warn(JSON.stringify({ level: 'warn', msg }));
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const isHash = p => /^\$2[aby]\$/.test(p);
const keySet = name => new Set((process.env[name] || '').split(',').filter(Boolean));
const API_KEYS = keySet('FLEET_API_KEYS');
const API_KEYS_READONLY = keySet('FLEET_API_KEYS_READONLY');

function loadUsers() {
  const users = [];
  const add = (u, origin) => {
    const role = u?.role ?? 'viewer';
    if (!u?.name || !u?.password || !ROLES.has(role)) return warn(`ignoring invalid user entry in ${origin}`);
    if (users.some(x => x.name === u.name)) return warn(`ignoring duplicate user "${u.name}" in ${origin}`);
    users.push({ name: String(u.name), password: String(u.password), role });
  };
  const file = process.env.FLEET_USERS_FILE || path.join(DATA_DIR, 'users.json');
  if (fs.existsSync(file)) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')).forEach(u => add(u, file)); }
    catch (e) { console.error(JSON.stringify({ level: 'error', msg: `cannot read ${file}`, error: e.message })); process.exit(1); }
  }
  if (process.env.FLEET_ADMIN_USER || process.env.FLEET_ADMIN_PASS || !users.length) {
    add({ name: process.env.FLEET_ADMIN_USER || 'admin', password: process.env.FLEET_ADMIN_PASS || 'admin', role: 'admin' }, 'FLEET_ADMIN_*');
  }
  if (!users.some(u => u.role === 'admin')) warn('no admin user configured: nobody can trigger updates');
  return users;
}
const USERS = loadUsers();
if (WS_SECRET === 'changeme') warn('FLEET_SECRET is the default "changeme": agents can be impersonated, set your own');
if (USERS.some(u => u.name === 'admin' && u.password === 'admin')) warn('the admin user still has the default password "admin": set FLEET_ADMIN_PASS or a users file');

const DUMMY_HASH = bcrypt.hashSync('not-a-password', 10);   // keeps timing similar for unknown users
function checkCreds(cred) {
  if (!cred) return null;
  const user = USERS.find(u => u.name === cred.name);
  if (!user) { bcrypt.compareSync(cred.pass, DUMMY_HASH); return null; }
  const ok = isHash(user.password) ? bcrypt.compareSync(cred.pass, user.password) : safeEq(cred.pass, user.password);
  return ok ? user : null;
}

// Slow down password guessing: 10 failures per client address and 5 minutes, then 429.
const failures = new Map();   // ip -> { n, since }
const WINDOW = 5 * 60_000, MAX_FAILS = 10;
const tooMany = ip => { const f = failures.get(ip); if (!f) return false; if (Date.now() - f.since > WINDOW) { failures.delete(ip); return false; } return f.n >= MAX_FAILS; };
const failed = ip => { const f = failures.get(ip); if (!f || Date.now() - f.since > WINDOW) failures.set(ip, { n: 1, since: Date.now() }); else f.n++; };

// basic-auth v3 takes the header string (v2 took the request) and throws on a missing header
const auth = req => (req.headers.authorization ? parseBasicAuth(req.headers.authorization) : undefined);

function authenticate(minRole) {
  return (req, res, next) => {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'too_many_attempts' });
    let user = null;
    const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (bearer) {
      if ([...API_KEYS].some(k => safeEq(k, bearer[1]))) user = { name: 'api-key', role: 'admin' };
      else if ([...API_KEYS_READONLY].some(k => safeEq(k, bearer[1]))) user = { name: 'api-key (read-only)', role: 'viewer' };
    } else {
      const cred = auth(req);
      user = checkCreds(cred);
      if (cred && !user) failed(req.ip);       // a missing header is the browser's first request, not a failure
    }
    if (!user) { res.set('WWW-Authenticate', 'Basic realm="Fleet"'); return res.status(401).json({ error: 'unauthorized' }); }
    if (minRole === 'admin' && user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    req.user = user;
    next();
  };
}
const requireAuth = authenticate('viewer');     // any signed-in user, read access
const requireAdmin = authenticate('admin');     // triggers updates, reads logs

// the UI itself is behind the login too (it used to be served to anyone)
app.use('/ui', requireAuth, express.static(path.join(__dirname, 'webui/dist')));

// Webhooks (3.2)
const WEBHOOK_URL = process.env.FLEET_WEBHOOK_URL;
const WEBHOOK_EVENTS = new Set((process.env.FLEET_WEBHOOK_EVENTS || 'device_online,device_offline,update_success,update_failed').split(',').filter(Boolean));
function fireWebhook(event, device) {
  if (!WEBHOOK_URL || !WEBHOOK_EVENTS.has(event)) return;
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, device: { id: device.id, hostname: device.hostname, tags: device.tags }, ts: new Date().toISOString() }),
  }).catch(e => console.error(JSON.stringify({ level: 'error', msg: 'webhook failed', error: e.message })));
}

// Ingest proxy — agents push through fleet-server; VM/VL stay internal
app.post('/api/ingest/metrics', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!bearer || !safeEq(bearer[1], WS_SECRET)) return res.status(401).end();
  if (!FLEET_VM_URL) return res.status(503).end();
  fetch(`${FLEET_VM_URL}/api/v1/import/prometheus`, { method: 'POST', body: req.body })
    .then(r => res.status(r.status).end())
    .catch(() => res.status(502).end());
});

app.post('/api/ingest/logs', express.raw({ type: '*/*', limit: '4mb' }), (req, res) => {
  const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!bearer || !safeEq(bearer[1], WS_SECRET)) return res.status(401).end();
  if (!FLEET_VL_URL) return res.status(503).end();
  fetch(`${FLEET_VL_URL}/insert/jsonline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: req.body,
  }).then(r => res.status(r.status).end())
    .catch(() => res.status(502).end());
});

// List clients
app.get('/api/clients', requireAuth, (req, res) => {
  res.json(Object.values(clients));
});

// Device detail + recent update events
app.get('/api/clients/:id', requireAuth, (req, res) => {
  const c = clients[req.params.id];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const events = db.prepare('SELECT ts, phase, success, error FROM update_events WHERE device_id=? ORDER BY ts DESC LIMIT 20').all(req.params.id);
  res.json({ ...c, recent_events: events });
});

// Historical metrics proxy — 2.4 (requires FLEET_VM_URL)
app.get('/api/metrics/:id', requireAuth, async (req, res) => {
  if (!FLEET_VM_URL) return res.status(503).json({ error: 'not_configured' });
  const c = clients[req.params.id];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const ranges = { '1h': [3600, 60], '24h': [86400, 300], '7d': [604800, 3600] };
  const [secs, step] = ranges[req.query.range] || ranges['1h'];
  const end = Math.floor(Date.now() / 1000), start = end - secs;
  try {
    const results = await Promise.all(['cuos_cpu_usage', 'cuos_ram_percent', 'cuos_disk_percent'].map(async m => {
      const qs = new URLSearchParams({ query: `${m}{uuid="${c.id}"}`, start, end, step });
      const r = await fetch(`${FLEET_VM_URL}/api/v1/query_range?${qs}`).then(r => r.json());
      return { metric: m, values: r?.data?.result?.[0]?.values || [] };
    }));
    res.json(results);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Log query proxy — 2.5 (requires FLEET_VL_URL)
// logs can hold personal data (ssh user names, addresses): admins only, not viewers or read-only keys
app.get('/api/logs/:id', requireAdmin, async (req, res) => {
  if (!FLEET_VL_URL) return res.status(503).json({ error: 'not_configured' });
  const c = clients[req.params.id];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const base = `hostname:${JSON.stringify(String(c.hostname))}`;
  const q = req.query.q ? `${base} AND (${req.query.q})` : base;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const r = await fetch(`${FLEET_VL_URL}/select/logsql/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query: q, limit: String(limit) }),
    });
    const text = await r.text();
    const logs = text.trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json(logs);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Log tail stream via SSE — polls VL every 3s, advances cursor to avoid duplicates
app.get('/api/logs/:id/stream', requireAdmin, (req, res) => {
  if (!FLEET_VL_URL) return res.status(503).end();
  const c = clients[req.params.id];
  if (!c) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const userFilter = req.query.q ? ` AND (${req.query.q})` : '';
  const query = `hostname:${JSON.stringify(String(c.hostname))}${userFilter}`;
  let since = new Date(Date.now() - 60_000).toISOString();
  async function poll() {
    try {
      const r = await fetch(`${FLEET_VL_URL}/select/logsql/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query, limit: '200', start: since }),
      });
      const lines = (await r.text()).trim().split('\n').filter(Boolean);
      const logs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (logs.length) {
        since = new Date(new Date(logs.at(-1)._time).getTime() + 1).toISOString();
        for (const log of logs) res.write(`data: ${JSON.stringify(log)}\n\n`);
      }
    } catch {}
  }
  poll();
  const timer = setInterval(poll, 3000);
  req.on('close', () => clearInterval(timer));
});

// Bulk update trigger
app.post('/api/bulk-update', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be array' });
  const triggered = [], offline = [], denied = [];
  for (const id of ids) {
    const ws = wsConnections.get(id);
    if (clients[id]?.shares?.remote_update === false) denied.push(id);
    else if (ws) { ws.send(JSON.stringify({ type: 'update_trigger', reason: 'manual', requested_by: req.user.name })); triggered.push(id); }
    else offline.push(id);
  }
  res.json({ triggered, offline, denied });
});

// Trigger update
app.post('/api/clients/:id/update', requireAdmin, (req, res) => {
  const id = req.params.id;
  const c = clients[id];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const ws = wsConnections.get(id);
  if (c.shares?.remote_update === false) return res.status(409).json({ error: 'update_not_permitted' });
  if (!ws) return res.status(409).json({ error: 'client_offline' });
  ws.send(JSON.stringify({ type: 'update_trigger', reason: 'manual', requested_by: req.user.name }));
  res.json({ status: 'triggered' });
});

// Direct connect link generation (simple host link)
app.get('/api/clients/:id/direct', requireAuth, (req, res) => {
  const id = req.params.id;
  const c = clients[id];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const url = `http://${c.hostname}:8030`;
  res.json({ url });
});

app.get('/api/meta', requireAuth, (req, res) => res.json({ user: { name: req.user.name, role: req.user.role }, wsNonce: UI_WS_NONCE, hasVm: !!FLEET_VM_URL, hasVl: !!FLEET_VL_URL && req.user.role === 'admin', name: process.env.FLEET_NAME || null }));
app.get('/', requireAuth, (req, res) => res.redirect('./ui'));
app.get('/ui/*path', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'webui/dist/index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wsConnections = new Map();
const uiWss = new WebSocketServer({ noServer: true });
const uiConnections = new Set();
function broadcastState() {
  if (!uiConnections.size) return;
  const msg = JSON.stringify({ type: 'state', devices: Object.values(clients), config: { latestCuos: LATEST_CUOS, latestAgent: LATEST_AGENT } });
  for (const ws of uiConnections) { if (ws.readyState === 1) ws.send(msg); }
}

server.on('upgrade', (req, socket, head) => {
  const parts = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').filter(Boolean);
  const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  const agentOk = (parts.length === 1 && parts[0] === 'ws' && bearer && safeEq(bearer[1], WS_SECRET))
    || (parts.length === 2 && parts[0] === 'ws' && safeEq(parts[1], WS_SECRET));   // legacy: secret in the URL ends up in proxy logs
  if (agentOk) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else if (parts.length === 2 && parts[0] === 'ui-ws' && safeEq(parts[1], UI_WS_NONCE)) {
    uiWss.handleUpgrade(req, socket, head, ws => {
      uiConnections.add(ws);
      ws.send(JSON.stringify({ type: 'state', devices: Object.values(clients), config: { latestCuos: LATEST_CUOS, latestAgent: LATEST_AGENT } }));
      ws.on('close', () => uiConnections.delete(ws));
    });
  } else {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'client_hello') {
      const {
        uuid,
        hostname,
        cuos_version,
        agent_version,
        tags = [],
        repo_url,
        repo_branch,
        protocol_version = 1
      } = msg;
      const shares = protocol_version >= 2 ? sanitizeShares(msg.shares) : null;
      if (!uuid || typeof uuid !== 'string') return;
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(uuid)) { ws.close(1008, 'invalid uuid'); return; }
      const now = new Date().toISOString();
      clients[uuid] = {
        id: uuid, hostname, cuos_version, agent_version, tags, repo_url, repo_branch, protocol_version, shares,
        last_update: clients[uuid]?.last_update || null,
        connected_at: now, last_seen: now, status: 'online',
        // a device that now shares less must not keep showing what it shared before
        metrics: clients[uuid]?.metrics
          ? { ...clients[uuid].metrics, resources: scrubResources(clients[uuid].metrics.resources, shares), app_state: shares && !shares.iac_state ? {} : clients[uuid].metrics.app_state }
          : null,
      };
      stmts.upsertDevice.run({
        id: uuid, hostname, cuosVersion: cuos_version, agentVersion: agent_version || null,
        tags: JSON.stringify(tags), repoUrl: repo_url, repoBranch: repo_branch,
        protocolVersion: protocol_version, status: 'online',
        connectedAt: now, lastSeen: now, lastUpdate: null, metrics: null, shares: shares ? JSON.stringify(shares) : null,
      });
      wsConnections.set(uuid, ws);
      ws.send(JSON.stringify({ type: 'server_welcome', server_time: now }));
      fireWebhook('device_online', clients[uuid]);
      broadcastState();
    } else if (msg.type === 'heartbeat') {
      const { uuid } = msg;
      if (uuid && clients[uuid]) {
        const now = new Date().toISOString();
        clients[uuid].last_seen = now;
        stmts.updateSeen.run({ lastSeen: now, id: uuid });
      }
    } else if (msg.type === 'update_status') {
      const { uuid, phase, success, error } = msg;
      if (uuid && clients[uuid]) {
        const now = new Date().toISOString();
        const status = phase === 'finished' ? (success ? 'online' : 'error') : 'updating';
        const lastUpdate = (phase === 'finished' && success) ? now : null;
        clients[uuid].status = status;
        if (lastUpdate) clients[uuid].last_update = lastUpdate;
        stmts.updateStatus.run({ status, lastUpdate, lastSeen: now, id: uuid });
        stmts.insertEvent.run({ deviceId: uuid, ts: now, phase, success: success ? 1 : 0, error: error || null });
        if (phase === 'finished') fireWebhook(success ? 'update_success' : 'update_failed', clients[uuid]);
        broadcastState();
      }
    } else if (msg.type === 'update_denied') {
      const { uuid, reason } = msg;
      if (uuid && clients[uuid]) {
        const now = new Date().toISOString();
        stmts.insertEvent.run({ deviceId: uuid, ts: now, phase: 'denied', success: 0, error: String(reason || 'not permitted').slice(0, 200) });
        broadcastState();
      }
    } else if (msg.type === 'metrics') {
      const { uuid, state, resources, app_state } = msg;
      if (uuid && clients[uuid]) {
        const now = new Date().toISOString();
        const shares = clients[uuid].shares;
        const metricsObj = { state, resources: scrubResources(resources, shares), app_state: shares && !shares.iac_state ? {} : app_state, collected_at: now };
        const metricsJson = JSON.stringify(metricsObj);
        clients[uuid].last_seen = now;
        clients[uuid].metrics = metricsObj;
        stmts.updateMetrics.run({ metrics: metricsJson, lastSeen: now, id: uuid });
        stmts.insertMetrics.run({ deviceId: uuid, collectedAt: now, metrics: metricsJson });
        stmts.pruneMetrics.run({ deviceId: uuid });
        broadcastState();
      }
    }
  });
  ws.on('close', () => {
    for (const [id, conn] of wsConnections.entries()) {
      if (conn === ws) {
        wsConnections.delete(id);
        if (clients[id]) {
          const now = new Date().toISOString();
          clients[id].status = 'offline';
          stmts.updateStatus.run({ status: 'offline', lastUpdate: null, lastSeen: now, id });
          fireWebhook('device_offline', clients[id]);
          broadcastState();
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'fleet server started', port: PORT }));
});
