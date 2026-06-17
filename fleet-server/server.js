// Fleet Server MVP
import express from 'express';
import { engine } from 'express-handlebars';
import bodyParser from 'body-parser';
import path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import fs from 'fs';
import auth from 'basic-auth';
import Handlebars from 'handlebars';
import Database from 'better-sqlite3';
import crypto from 'crypto';

const locale = process.env.LOCALE || 'de-DE';
const timeZone = process.env.TZ || 'Europe/Berlin';

Handlebars.registerHelper('formatDate', function(dateStr) {
  if (!dateStr) return '';
  if (!dateStr.match(/Z$/)) dateStr = dateStr+"Z";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString(locale, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '');
});

const PORT = process.env.FLEET_SERVER_PORT || 8085;
const WS_SECRET = process.env.FLEET_SECRET || 'changeme';
const UI_WS_NONCE = crypto.randomBytes(16).toString('hex'); // per-boot, injected into the page
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

const stmts = {
  upsertDevice: db.prepare(`
    INSERT INTO devices (id, hostname, cuos_version, tags, repo_url, repo_branch, protocol_version, status, connected_at, last_seen, last_update, metrics)
    VALUES (@id, @hostname, @cuosVersion, @tags, @repoUrl, @repoBranch, @protocolVersion, @status, @connectedAt, @lastSeen, @lastUpdate, @metrics)
    ON CONFLICT(id) DO UPDATE SET
      hostname=excluded.hostname, cuos_version=excluded.cuos_version, tags=excluded.tags,
      repo_url=excluded.repo_url, repo_branch=excluded.repo_branch,
      protocol_version=excluded.protocol_version, status=excluded.status,
      connected_at=excluded.connected_at, last_seen=excluded.last_seen,
      last_update=COALESCE(excluded.last_update, devices.last_update),
      metrics=COALESCE(excluded.metrics, devices.metrics)
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
          lastUpdate: c.last_update || null, metrics: c.metrics ? JSON.stringify(c.metrics) : null,
        });
      }
    })();
    fs.renameSync(CLIENTS_FILE, CLIENTS_FILE + '.migrated');
    console.log(JSON.stringify({ level: 'info', msg: 'migrated clients.json to SQLite' }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'clients.json migration failed', error: e.message }));
  }
}

// Load all devices into memory; mark all offline until they reconnect
db.prepare(`UPDATE devices SET status='offline'`).run();
function rowToDevice(row) {
  return { ...row, tags: JSON.parse(row.tags || '[]'), metrics: row.metrics ? JSON.parse(row.metrics) : null };
}
const clients = {};
for (const row of stmts.allDevices.all()) clients[row.id] = rowToDevice(row);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.engine('handlebars', engine());
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Auth — Basic Auth for browser, Bearer token for automation (3.3)
const ADMIN_USER = process.env.FLEET_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.FLEET_ADMIN_PASS || 'admin';
const API_KEYS = new Set((process.env.FLEET_API_KEYS || '').split(',').filter(Boolean));
function requireAuth(req, res, next) {
  const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (bearer && API_KEYS.has(bearer[1])) return next();
  const creds = auth(req);
  if (creds && creds.name === ADMIN_USER && creds.pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Fleet"');
  return res.status(401).json({ error: 'unauthorized' });
}

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

// Bulk update trigger
app.post('/api/bulk-update', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be array' });
  const triggered = [], offline = [];
  for (const id of ids) {
    const ws = wsConnections.get(id);
    if (ws) { ws.send(JSON.stringify({ type: 'update_trigger', reason: 'manual' })); triggered.push(id); }
    else offline.push(id);
  }
  res.json({ triggered, offline });
});

// Trigger update
app.post('/api/clients/:id/update', requireAuth, (req, res) => {
  const id = req.params.id;
  const c = clients[id];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const ws = wsConnections.get(id);
  if (!ws) return res.status(409).json({ error: 'client_offline' });
  ws.send(JSON.stringify({ type: 'update_trigger', reason: 'manual' }));
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

app.get('/', requireAuth, (req, res) => res.redirect('./ui'));
app.get('/ui', requireAuth, (req, res) => res.render('fleet', { wsNonce: UI_WS_NONCE }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wsConnections = new Map();
const uiWss = new WebSocketServer({ noServer: true });
const uiConnections = new Set();
function broadcastState() {
  if (!uiConnections.size) return;
  const msg = JSON.stringify({ type: 'state', devices: Object.values(clients) });
  for (const ws of uiConnections) { if (ws.readyState === 1) ws.send(msg); }
}

server.on('upgrade', (req, socket, head) => {
  const parts = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'ws' && parts[1] === WS_SECRET) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else if (parts.length === 2 && parts[0] === 'ui-ws' && parts[1] === UI_WS_NONCE) {
    uiWss.handleUpgrade(req, socket, head, ws => {
      uiConnections.add(ws);
      ws.send(JSON.stringify({ type: 'state', devices: Object.values(clients) }));
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
        tags = [],
        repo_url,
        repo_branch,
        protocol_version = 1
      } = msg;
      if (!uuid || typeof uuid !== 'string') return;
      const now = new Date().toISOString();
      clients[uuid] = {
        id: uuid, hostname, cuos_version, tags, repo_url, repo_branch, protocol_version,
        last_update: clients[uuid]?.last_update || null,
        connected_at: now, last_seen: now, status: 'online',
        metrics: clients[uuid]?.metrics || null,
      };
      stmts.upsertDevice.run({
        id: uuid, hostname, cuosVersion: cuos_version,
        tags: JSON.stringify(tags), repoUrl: repo_url, repoBranch: repo_branch,
        protocolVersion: protocol_version, status: 'online',
        connectedAt: now, lastSeen: now, lastUpdate: null, metrics: null,
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
    } else if (msg.type === 'metrics') {
      const { uuid, state, resources, app_state } = msg;
      if (uuid && clients[uuid]) {
        const now = new Date().toISOString();
        const metricsObj = { state, resources, app_state, collected_at: now };
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
