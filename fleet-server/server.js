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
import { EventEmitter } from 'events';
import { createStore } from './store.js';

const PORT          = process.env.FLEET_SERVER_PORT  || 8085;
const WS_SECRET     = process.env.FLEET_SECRET       || 'changeme';
const LATEST_CUOS   = process.env.FLEET_LATEST_CUOS  || null;
const LATEST_AGENT  = process.env.FLEET_LATEST_AGENT || null;
const UI_WS_NONCE  = crypto.randomBytes(16).toString('hex'); // per-boot, injected into the page
const DATA_DIR = process.env.FLEET_DATA_DIR || '/data';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- SQLite ---
const db = new Database(path.join(DATA_DIR, 'fleet.db'));
db.pragma('journal_mode = WAL');     // logs arrive continuously: readers must not block the writer
const store = createStore(db);
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
  CREATE TABLE IF NOT EXISTS update_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    phase TEXT,
    success INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ue_device ON update_events(device_id, ts);
`);
// ponytail: migrate existing DBs; ignore error if column already exists
try { db.exec(`ALTER TABLE devices ADD COLUMN agent_version TEXT`); } catch {}
try { db.exec(`ALTER TABLE devices ADD COLUMN shares TEXT`); } catch {}
// enrollment: a token per device (only its hash is stored), see "Enrollment" below
for (const col of ['token_hash TEXT', 'prev_token_hash TEXT', 'token_created TEXT', 'enroll_state TEXT', 'pending_since TEXT', 'pending_addr TEXT', 'pending_hostname TEXT']) {
  try { db.exec(`ALTER TABLE devices ADD COLUMN ${col}`); } catch {}
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash)`);

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
  insertEvent:  db.prepare(`INSERT INTO update_events (device_id, ts, phase, success, error) VALUES (@deviceId, @ts, @phase, @success, @error)`),
  allDevices:   db.prepare(`SELECT * FROM devices`),
  byToken:      db.prepare(`SELECT id, token_hash, prev_token_hash FROM devices WHERE token_hash=@h OR prev_token_hash=@h`),
  setToken:     db.prepare(`UPDATE devices SET prev_token_hash=@prev, token_hash=@hash, token_created=@now, enroll_state='active', pending_since=NULL, pending_addr=NULL, pending_hostname=NULL WHERE id=@id`),
  dropPrev:     db.prepare(`UPDATE devices SET prev_token_hash=NULL WHERE id=@id`),
  revoke:       db.prepare(`UPDATE devices SET token_hash=NULL, prev_token_hash=NULL, token_created=NULL, enroll_state='revoked' WHERE id=@id`),
  setRequest:   db.prepare(`UPDATE devices SET pending_since=@since, pending_addr=@addr, pending_hostname=@hostname WHERE id=@id`),
  setEnrollState: db.prepare(`UPDATE devices SET enroll_state=@state WHERE id=@id`),
  deleteDevice: db.prepare(`DELETE FROM devices WHERE id=@id`),
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
const LOG_SOURCES = ['iac', 'system'];
function sanitizeShares(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    resources: raw.resources !== false,
    iac_state: raw.iac_state !== false,
    network: NETWORK_LEVELS.includes(raw.network) ? raw.network : 'summary',
    logs: Array.isArray(raw.logs) ? LOG_SOURCES.filter(x => raw.logs.includes(x)) : [],
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

// Retention. Load samples are small; log lines are bounded by age and by a row cap per device.
const RETENTION = {
  sampleDays: Number(process.env.FLEET_RETENTION_DAYS) || 30,
  logDays: Number(process.env.FLEET_LOG_RETENTION_DAYS) || 7,
  maxLogRows: Number(process.env.FLEET_LOG_MAX_ROWS) || 20000,
};
const prune = () => store.prune(RETENTION).catch(e => console.error(JSON.stringify({ level: 'error', msg: 'prune failed', error: e.message })));
prune(); setInterval(prune, 3600_000).unref();

// Load all devices into memory; mark all offline until they reconnect
db.prepare(`UPDATE devices SET status='offline'`).run();
function rowToDevice(row) {
  const { token_hash, prev_token_hash, token_created, enroll_state, pending_since, pending_addr, pending_hostname, ...rest } = row;
  return {
    ...rest, tags: JSON.parse(row.tags || '[]'), metrics: row.metrics ? JSON.parse(row.metrics) : null, shares: row.shares ? JSON.parse(row.shares) : null,
    enrollment: { state: enroll_state || null, has_token: !!token_hash, token_created: token_created || null,
      request: pending_since ? { since: pending_since, addr: pending_addr, hostname: pending_hostname } : null },
  };
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
const WEBHOOK_EVENTS = new Set((process.env.FLEET_WEBHOOK_EVENTS || 'device_online,device_offline,device_pending,update_success,update_failed').split(',').filter(Boolean));
function fireWebhook(event, device) {
  if (!WEBHOOK_URL || !WEBHOOK_EVENTS.has(event)) return;
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, device: { id: device.id, hostname: device.hostname, tags: device.tags }, ts: new Date().toISOString() }),
  }).catch(e => console.error(JSON.stringify({ level: 'error', msg: 'webhook failed', error: e.message })));
}

// List clients
app.get('/api/clients', requireAuth, (req, res) => {
  res.json(publicDevices());
});

// Device detail + recent update events
app.get('/api/clients/:id', requireAuth, (req, res) => {
  const c = clients[req.params.id];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const events = db.prepare('SELECT ts, phase, success, error FROM update_events WHERE device_id=? ORDER BY ts DESC LIMIT 20').all(req.params.id);
  res.json({ ...publicDevice(c), recent_events: events });
});

// Load history from the database (what the agents report over their connection)
app.get('/api/metrics/:id', requireAuth, async (req, res) => {
  const c = clients[req.params.id];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const ranges = { '1h': [3600, 60], '24h': [86400, 300], '7d': [604800, 3600] };
  const [secs, step] = ranges[req.query.range] || ranges['1h'];
  const to = Math.floor(Date.now() / 1000);
  try {
    const rows = await store.series(c.id, to - secs, to, step);
    const pick = k => rows.filter(r => r[k] != null).map(r => [r.t, r[k]]);
    res.json([{ metric: 'cuos_cpu_usage', values: pick('cpu') }, { metric: 'cuos_ram_percent', values: pick('ram') }, { metric: 'cuos_disk_percent', values: pick('disk') }]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Device logs (admins only: they can hold personal data). Filters: q (text in message or unit),
// source (iac | system), level (a syslog priority 0-7: shows that and everything more severe).
const logFilter = query => ({
  q: typeof query.q === 'string' && query.q ? query.q.slice(0, 200) : undefined,
  source: LOG_SOURCES.includes(query.source) ? query.source : undefined,
  maxPriority: /^[0-7]$/.test(query.level) ? Number(query.level) : undefined,
});
const matchLog = (r, f) => (!f.source || r.source === f.source)
  && (f.maxPriority === undefined || r.priority <= f.maxPriority)
  && (!f.q || `${r.message}`.toLowerCase().includes(f.q.toLowerCase()) || `${r.unit || ''}`.toLowerCase().includes(f.q.toLowerCase()));

app.get('/api/logs/:id', requireAdmin, async (req, res) => {
  const c = clients[req.params.id];
  if (!c) return res.status(404).json({ error: 'not_found' });
  try { res.json(await store.queryLogs(c.id, { ...logFilter(req.query), limit: req.query.limit })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// live tail: the last lines, then every batch as it arrives
const logBus = new EventEmitter().setMaxListeners(0);
app.get('/api/logs/:id/stream', requireAdmin, async (req, res) => {
  const c = clients[req.params.id];
  if (!c) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const f = logFilter(req.query), send = r => res.write(`data: ${JSON.stringify(r)}\n\n`);
  const onRows = rows => rows.filter(r => matchLog(r, f)).forEach(send);
  logBus.on(c.id, onRows);                                   // subscribe first so nothing falls between backlog and live
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
  req.on('close', () => { clearInterval(keepalive); logBus.off(c.id, onRows); });
  try { (await store.queryLogs(c.id, { ...f, limit: 50 })).forEach(send); } catch {}
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

app.get('/api/meta', requireAuth, (req, res) => res.json({ user: { name: req.user.name, role: req.user.role }, wsNonce: UI_WS_NONCE, hasMetrics: true, hasLogs: req.user.role === 'admin', name: process.env.FLEET_NAME || null }));
app.get('/', requireAuth, (req, res) => res.redirect('./ui'));
app.get('/ui/*path', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'webui/dist/index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });   // an agent's batch is far below this
const wsConnections = new Map();   // device id -> admitted agent connection
const pendingConns = new Map();    // device id -> connection waiting for an admin
const uiWss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const uiConnections = new Set();

// what the UI and the API get: no internals, and whether a waiting device is still connected
function publicDevice(c) {
  const req = c.enrollment?.request;
  if (!req) return c;
  const ws = pendingConns.get(c.id);
  return { ...c, enrollment: { ...c.enrollment, request: { ...req, live: !!ws && ws.readyState === 1 } } };
}
const publicDevices = () => Object.values(clients).map(publicDevice);
const statePayload = () => JSON.stringify({ type: 'state', devices: publicDevices(), config: { latestCuos: LATEST_CUOS, latestAgent: LATEST_AGENT } });
function broadcastState() {
  if (!uiConnections.size) return;
  const msg = statePayload();
  for (const ws of uiConnections) { if (ws.readyState === 1) ws.send(msg); }
}

// --- Enrollment ------------------------------------------------------------------------------
// FLEET_SECRET is only the bootstrap secret. A device that presents it together with its id gets a token
// of its own (issued here, 256 bit, only the hash is kept) and uses that from then on. A connection is bound
// to the id its token belongs to, so one device cannot speak for another.
//  - FLEET_ENROLLMENT=auto (default): unknown ids are enrolled at once; =approve: an admin confirms first.
//  - A known id that arrives with the bootstrap secret again (token lost, or revoked) is never taken over
//    silently: it waits for an admin while its connection stays open. The old token keeps working meanwhile.
//  - Rotating issues a new token over the live connection; the old one stays valid until the new one is used.
// Tokens travel in the Authorization header and once in 'enrolled'/'token_rotate': run this behind TLS.
const ENROLLMENT = process.env.FLEET_ENROLLMENT === 'approve' ? 'approve' : 'auto';
const newToken = () => 'ft_' + crypto.randomBytes(32).toString('base64url');
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
const getTokenHash = db.prepare('SELECT token_hash FROM devices WHERE id=?');
const audit = (msg, extra = {}) => console.log(JSON.stringify({ level: 'info', msg, ...extra }));

function setEnrollment(id, patch) { if (clients[id]) clients[id].enrollment = { ...clients[id].enrollment, ...patch }; }

function issueToken(id, keepPrevious) {
  const token = newToken(), now = new Date().toISOString();
  stmts.setToken.run({ id, hash: hashToken(token), prev: keepPrevious ? (getTokenHash.get(id)?.token_hash ?? null) : null, now });
  setEnrollment(id, { state: 'active', has_token: true, token_created: now, request: null });
  return token;
}

const clientIp = req => {
  if (process.env.FLEET_TRUST_PROXY) { const f = (req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return req.socket.remoteAddress;
};
function deny(socket, code, reason) {
  const text = { 401: 'Unauthorized', 429: 'Too Many Requests' }[code] || 'Error';
  socket.write(`HTTP/1.1 ${code} ${text}\r\n${reason ? `X-Fleet-Reason: ${reason}\r\n` : ''}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function agentUpgrade(req, socket, head) {
  const ip = clientIp(req);
  if (tooMany(ip)) return deny(socket, 429, 'too_many_attempts');
  const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!bearer) return deny(socket, 401);
  const cred = bearer[1];
  let ctx;
  if (cred.startsWith('ft_')) {
    const h = hashToken(cred), row = stmts.byToken.get({ h });
    if (!row) return deny(socket, 401, 'token_unknown');          // revoked, replaced, or this server lost its data
    if (row.token_hash === h && row.prev_token_hash) stmts.dropPrev.run({ id: row.id });   // the new token works: the old one can go
    ctx = { mode: 'token', deviceId: row.id };
  } else if (safeEq(cred, WS_SECRET)) {
    ctx = { mode: 'bootstrap' };
  } else {
    failed(ip);
    return deny(socket, 401, 'bad_secret');
  }
  wss.handleUpgrade(req, socket, head, ws => { ws.ctx = ctx; ws.addr = ip; wss.emit('connection', ws, req); });
}

server.on('upgrade', (req, socket, head) => {
  const parts = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').filter(Boolean);
  if (parts.length === 1 && parts[0] === 'ws') return agentUpgrade(req, socket, head);
  if (parts.length === 2 && parts[0] === 'ui-ws' && safeEq(parts[1], UI_WS_NONCE)) {
    return uiWss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', wsError('ui'));
      uiConnections.add(ws);
      ws.send(statePayload());
      ws.on('close', () => uiConnections.delete(ws));
    });
  }
  deny(socket, 401);
});

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

// write what a device reported about itself and make it the current record
function applyHello(id, h, status) {
  const now = new Date().toISOString();
  clients[id] = {
    id, hostname: h.hostname, cuos_version: h.cuos_version, agent_version: h.agent_version, tags: h.tags, repo_url: h.repo_url,
    repo_branch: h.repo_branch, protocol_version: h.protocol_version, shares: h.shares,
    last_update: clients[id]?.last_update || null,
    connected_at: now, last_seen: now, status,
    // a device that now shares less must not keep showing what it shared before
    metrics: clients[id]?.metrics
      ? { ...clients[id].metrics, resources: scrubResources(clients[id].metrics.resources, h.shares), app_state: h.shares && !h.shares.iac_state ? {} : clients[id].metrics.app_state }
      : null,
    enrollment: clients[id]?.enrollment || { state: null, has_token: false, token_created: null, request: null },
  };
  stmts.upsertDevice.run({
    id, hostname: h.hostname, cuosVersion: h.cuos_version, agentVersion: h.agent_version || null,
    tags: JSON.stringify(h.tags), repoUrl: h.repo_url, repoBranch: h.repo_branch, protocolVersion: h.protocol_version, status,
    connectedAt: now, lastSeen: now, lastUpdate: null, metrics: null, shares: h.shares ? JSON.stringify(h.shares) : null,
  });
}

function admit(ws, id) {
  ws.deviceId = id;
  wsConnections.set(id, ws);
  ws.send(JSON.stringify({ type: 'server_welcome', server_time: new Date().toISOString() }));
  fireWebhook('device_online', clients[id]);
}

function onHello(ws, msg) {
  if (ws.deviceId || ws.pendingFor) return;                               // one hello per connection
  const uuid = msg.uuid;
  if (typeof uuid !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(uuid)) { ws.close(1008, 'invalid uuid'); return; }
  if ((msg.protocol_version ?? 1) < 2) { ws.close(1008, 'protocol too old'); return; }
  if (ws.ctx.mode === 'token' && ws.ctx.deviceId !== uuid) { ws.close(1008, 'uuid does not match token'); return; }
  const hello = {
    hostname: str(msg.hostname, 128), cuos_version: str(msg.cuos_version, 64), agent_version: str(msg.agent_version, 64),
    tags: Array.isArray(msg.tags) ? msg.tags.filter(t => typeof t === 'string').slice(0, 20).map(t => t.slice(0, 64)) : [],
    repo_url: str(msg.repo_url, 256), repo_branch: str(msg.repo_branch, 128), protocol_version: msg.protocol_version, shares: sanitizeShares(msg.shares),
  };
  const known = clients[uuid], state = known?.enrollment?.state;

  if (ws.ctx.mode === 'token') {                                          // has its token: normal connection
    applyHello(uuid, hello, 'online');
    admit(ws, uuid); broadcastState();
    return;
  }
  // bootstrap secret from here on
  if ((!known || !state) && ENROLLMENT === 'auto') {                      // new device, open enrollment
    applyHello(uuid, hello, 'online');
    const token = issueToken(uuid, false);
    audit('device enrolled', { id: uuid, hostname: hello.hostname, addr: ws.addr });
    ws.send(JSON.stringify({ type: 'enrolled', token }));
    admit(ws, uuid); broadcastState();
    return;
  }
  // wait for an admin: a new device when approval is on, or a known id that lost (or lost the right to) its token
  const since = new Date().toISOString();
  if (!known || !state || state === 'pending') {
    applyHello(uuid, hello, 'pending');
    stmts.setEnrollState.run({ id: uuid, state: 'pending' });
    setEnrollment(uuid, { state: 'pending' });
  }                                                                       // known + active/revoked: the stored record stays untouched
  stmts.setRequest.run({ id: uuid, since, addr: ws.addr, hostname: hello.hostname });
  setEnrollment(uuid, { request: { since, addr: ws.addr, hostname: hello.hostname } });
  pendingConns.get(uuid)?.close(1008, 'superseded');
  pendingConns.set(uuid, ws); ws.pendingFor = uuid; ws.hello = hello;
  ws.send(JSON.stringify({ type: 'pending', reason: known && state && state !== 'pending' ? 'known device without its token' : 'approval required' }));
  audit('enrollment waiting for approval', { id: uuid, hostname: hello.hostname, addr: ws.addr, known: !!state && state !== 'pending' });
  fireWebhook('device_pending', clients[uuid]);
  broadcastState();
}

// --- Log intake -------------------------------------------------------------------------------
// The server decides who a line belongs to (the connection), and what it accepts: only sources the
// device announced, bounded size, and a rate limit per device so one noisy host cannot fill the disk.
const LOG_BATCH_MAX = 500, LOG_LINE_MAX = 2000, LOG_BURST = 2000, LOG_PER_SEC = 50;
const logBuckets = new Map();   // device id -> { tokens, last }
function logBudget(id, wanted) {
  const now = Date.now(), b = logBuckets.get(id) || { tokens: LOG_BURST, last: now };
  b.tokens = Math.min(LOG_BURST, b.tokens + (now - b.last) / 1000 * LOG_PER_SEC); b.last = now;
  const take = Math.min(wanted, Math.floor(b.tokens));
  b.tokens -= take; logBuckets.set(id, b);
  return take;
}
function ingestLogs(id, entries) {
  const allowed = clients[id]?.shares?.logs || [];
  if (!allowed.length || !Array.isArray(entries)) return;
  const now = Date.now();
  const batch = entries.slice(0, Math.min(LOG_BATCH_MAX, logBudget(id, entries.length)));
  const rows = [];
  for (const e of batch) {
    if (!e || typeof e.m !== 'string' || !allowed.includes(e.s)) continue;
    const t = Number(e.t);
    rows.push({
      ts: Number.isFinite(t) && t > now - 86400_000 && t < now + 300_000 ? Math.round(t) : now,   // trust the device's clock only within reason
      source: e.s, unit: typeof e.u === 'string' ? e.u.slice(0, 64) : null,
      priority: Number.isInteger(e.p) && e.p >= 0 && e.p <= 7 ? e.p : 6, message: e.m.slice(0, LOG_LINE_MAX),
    });
  }
  if (!rows.length) return;
  store.addLogs(id, rows).then(inserted => logBus.emit(id, inserted))
    .catch(e => console.error(JSON.stringify({ level: 'error', msg: 'log insert failed', error: e.message })));
}

// A broken or oversized frame is reported as an 'error' on the connection; without a listener that
// would take the whole process down. Log it, the library closes the connection itself.
const wsError = who => err => console.warn(JSON.stringify({ level: 'warn', msg: `${who} connection error`, error: err.message }));

wss.on('connection', (ws) => {
  ws.on('error', wsError('agent'));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'client_hello') return onHello(ws, msg);
    const uuid = ws.deviceId;            // the connection decides who is speaking, never a uuid inside a message
    if (!uuid || !clients[uuid]) return;
    const now = new Date().toISOString();
    if (msg.type === 'heartbeat') {
      clients[uuid].last_seen = now;
      stmts.updateSeen.run({ lastSeen: now, id: uuid });
    } else if (msg.type === 'update_status') {
      const { phase, success, error } = msg;
      const status = phase === 'finished' ? (success ? 'online' : 'error') : 'updating';
      const lastUpdate = (phase === 'finished' && success) ? now : null;
      clients[uuid].status = status;
      if (lastUpdate) clients[uuid].last_update = lastUpdate;
      stmts.updateStatus.run({ status, lastUpdate, lastSeen: now, id: uuid });
      stmts.insertEvent.run({ deviceId: uuid, ts: now, phase: String(phase).slice(0, 32), success: success ? 1 : 0, error: error ? String(error).slice(0, 200) : null });
      if (phase === 'finished') fireWebhook(success ? 'update_success' : 'update_failed', clients[uuid]);
      broadcastState();
    } else if (msg.type === 'update_denied') {
      stmts.insertEvent.run({ deviceId: uuid, ts: now, phase: 'denied', success: 0, error: String(msg.reason || 'not permitted').slice(0, 200) });
      broadcastState();
    } else if (msg.type === 'logs') {
      ingestLogs(uuid, msg.entries);
    } else if (msg.type === 'metrics') {
      const { state, resources, app_state } = msg;
      const shares = clients[uuid].shares;
      const metricsObj = { state, resources: scrubResources(resources, shares), app_state: shares && !shares.iac_state ? {} : app_state, collected_at: now };
      const metricsJson = JSON.stringify(metricsObj);
      clients[uuid].last_seen = now;
      clients[uuid].metrics = metricsObj;
      stmts.updateMetrics.run({ metrics: metricsJson, lastSeen: now, id: uuid });
      const r = metricsObj.resources;
      if (r && typeof r === 'object' && Object.keys(r).length && shares?.resources !== false) {
        const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        store.addSample(uuid, Math.floor(Date.now() / 1000), { cpu: n(r.cpu_usage), ram: n(r.ram_percent), disk: n(r.disk_percent), memUsed: n(r.mem_used_mb), diskUsed: n(r.disk_used_mb) })
          .catch(e => console.error(JSON.stringify({ level: 'error', msg: 'sample failed', error: e.message })));
      }
      broadcastState();
    }
  });
  ws.on('close', () => {
    if (ws.pendingFor && pendingConns.get(ws.pendingFor) === ws) { pendingConns.delete(ws.pendingFor); broadcastState(); }
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

// --- Admin: decide about devices ---------------------------------------------------------------
const need = (res, c) => (c ? true : (res.status(404).json({ error: 'not_found' }), false));

// let a waiting device in (hands it a fresh token; an older token of the same id stops working)
app.post('/api/clients/:id/approve', requireAdmin, (req, res) => {
  const id = req.params.id, c = clients[id];
  if (!need(res, c)) return;
  const ws = pendingConns.get(id);
  if (!c.enrollment?.request) return res.status(409).json({ error: 'no_request' });
  if (!ws || ws.readyState !== 1) return res.status(409).json({ error: 'device_not_waiting' });   // the token is only handed out on the live, bootstrap-authenticated connection
  wsConnections.get(id)?.close(1008, 're-enrolled');
  const token = issueToken(id, false);
  stmts.setRequest.run({ id, since: null, addr: null, hostname: null });
  pendingConns.delete(id);
  applyHello(id, ws.hello, 'online');
  audit('device approved', { id, by: req.user.name, addr: ws.addr });
  ws.send(JSON.stringify({ type: 'enrolled', token }));
  admit(ws, id);
  broadcastState();
  res.json({ status: 'approved' });
});

app.post('/api/clients/:id/reject', requireAdmin, (req, res) => {
  const id = req.params.id, c = clients[id];
  if (!need(res, c)) return;
  if (!c.enrollment?.request) return res.status(409).json({ error: 'no_request' });
  pendingConns.get(id)?.close(1008, 'rejected');
  pendingConns.delete(id);
  audit('enrollment rejected', { id, by: req.user.name });
  if (c.enrollment.state === 'pending' && !c.enrollment.has_token) { delete clients[id]; stmts.deleteDevice.run({ id }); }   // never admitted: forget it
  else { stmts.setRequest.run({ id, since: null, addr: null, hostname: null }); setEnrollment(id, { request: null }); }
  broadcastState();
  res.json({ status: 'rejected' });
});

// forget a device: disconnects it and deletes everything stored about it (record, history, logs, events)
app.delete('/api/clients/:id', requireAdmin, async (req, res) => {
  const id = req.params.id, c = clients[id];
  if (!need(res, c)) return;
  wsConnections.get(id)?.close(1008, 'forgotten');
  pendingConns.get(id)?.close(1008, 'forgotten');
  wsConnections.delete(id); pendingConns.delete(id); logBuckets.delete(id);
  delete clients[id];
  stmts.deleteDevice.run({ id });
  db.prepare('DELETE FROM update_events WHERE device_id=?').run(id);
  await store.deleteDevice(id);
  audit('device forgotten', { id, by: req.user.name });
  broadcastState();
  res.json({ status: 'deleted' });
});

// take a device's token away: it must be approved again before it can connect
app.post('/api/clients/:id/revoke', requireAdmin, (req, res) => {
  const id = req.params.id, c = clients[id];
  if (!need(res, c)) return;
  stmts.revoke.run({ id });
  setEnrollment(id, { state: 'revoked', has_token: false, token_created: null });
  wsConnections.get(id)?.close(1008, 'token revoked');
  audit('token revoked', { id, by: req.user.name });
  broadcastState();
  res.json({ status: 'revoked' });
});

// new token over the live connection; the old one stays valid until the new one has been used
app.post('/api/clients/:id/rotate-token', requireAdmin, (req, res) => {
  const id = req.params.id, c = clients[id];
  if (!need(res, c)) return;
  const ws = wsConnections.get(id);
  if (!ws || !c.enrollment?.has_token) return res.status(409).json({ error: 'device_offline' });
  ws.send(JSON.stringify({ type: 'token_rotate', token: issueToken(id, true) }));
  audit('token rotated', { id, by: req.user.name });
  broadcastState();
  res.json({ status: 'rotated' });
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'fleet server started', port: PORT }));
});
