// SPDX-License-Identifier: Apache-2.0
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
const DATA_DIR = process.env.FLEET_DATA_DIR || '/data';
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(CLIENTS_FILE)) {
  fs.writeFileSync(CLIENTS_FILE, '{}');
}

function loadClients() {
  try { return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); } catch { return {}; }
}
function saveClients(clients) {
  const tmp = CLIENTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clients, null, 2));
  fs.renameSync(tmp, CLIENTS_FILE);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const clients = loadClients();

const app = express();
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.engine('handlebars', engine());
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'views'));

// Basic Auth middleware (single admin user)
const ADMIN_USER = process.env.FLEET_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.FLEET_ADMIN_PASS || 'admin';
function requireAuth(req, res, next) {
  const creds = auth(req);
  if (!creds || creds.name !== ADMIN_USER || creds.pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Fleet"');
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// List clients
app.get('/api/clients', requireAuth, (req, res) => {
  res.json(Object.values(clients));
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

function max(a, b) {
  return a > b ? a : b;
}

// Simple Web UI
app.get('/', requireAuth, (req, res) => res.redirect('./ui'));
app.get('/ui', requireAuth, (req, res) => {
  const list = Object.values(clients).map(c => ({
    id: c.id,
    hostname: c.hostname || '-',
    connection: c.status,
    state: (c.metrics?.app_state?.iac_state !== "idle" ? c.metrics?.app_state?.iac_state : c.metrics?.state?.state),
    last_update: max(c.metrics?.app_state?.last_iac_update, c.metrics?.state?.last_update_date),
    metrics: c.metrics || { resources: {}, state: {} }
  }));
  res.render('clients', { clients: list });
});
function action(req) {
  const id = req.body?.id;
  if (!id) return {
    'error': true,
    'message': 'Error: No instance defined'
  };
  const c = clients[id];
  if (!c) return {
    'error': true,
    'message': 'Error: Instance not found'
  };
  const ws = wsConnections.get(id);
  if (!ws) return {
    'error': true,
    'message': 'Error: Instance offline'
  };

  const action = req.body?.action;
  ws.send(JSON.stringify({ type: 'update_trigger', reason: 'manual' }));
  return {
    'message': 'Update triggered'
  };
}
app.post('/action', requireAuth, (req, res) => {
  res.render('action', { result: action(req) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wsConnections = new Map();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Path pattern: /ws/<secret>
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'ws' || parts[1] !== WS_SECRET) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
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
        id: uuid,
        hostname,
        cuos_version,
        tags,
        repo_url,
        repo_branch,
        protocol_version,
        last_update: clients[uuid]?.last_update || null,
        connected_at: now,
        last_seen: now,
        status: 'online'
      };
      saveClients(clients);
      wsConnections.set(uuid, ws);
      ws.send(JSON.stringify({ type: 'server_welcome', server_time: now }));
    } else if (msg.type === 'heartbeat') {
      const { uuid } = msg;
      if (uuid && clients[uuid]) {
        clients[uuid].last_seen = new Date().toISOString();
      }
    } else if (msg.type === 'update_status') {
      const { uuid, phase, success, error } = msg;
      if (uuid && clients[uuid]) {
        clients[uuid].status = phase === 'finished' ? (success ? 'online' : 'error') : 'updating';
        if (phase === 'finished' && success) {
          clients[uuid].last_update = new Date().toISOString();
        }
        saveClients(clients);
      }
    } else if (msg.type === 'metrics') {
      const { uuid, state, resources, app_state } = msg;
      if (uuid && clients[uuid]) {
        clients[uuid].last_seen = new Date().toISOString();
        clients[uuid].metrics = { state, resources, app_state, collected_at: new Date().toISOString() };
      }
    }
  });
  ws.on('close', () => {
    for (const [id, conn] of wsConnections.entries()) {
      if (conn === ws) {
        wsConnections.delete(id);
        if (clients[id]) {
          clients[id].status = 'offline';
          saveClients(clients);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'fleet server started', port: PORT }));
});
