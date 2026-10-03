// SPDX-License-Identifier: Apache-2.0
// Fleet Agent MVP
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import net from 'net';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { resolveShares, filterResources, filterAppState } from './share.js';
import { makeRedactor } from './redact.js';
const agentVersion = createRequire(import.meta.url)('./package.json').version;

// ---- Configuration Loading ----
const SYSTEM_JSON = process.env.CUOS_SYSTEM_JSON || '/system.json';
function loadSystemConfig() {
  try {
    return JSON.parse(fs.readFileSync(SYSTEM_JSON, 'utf8'));
  } catch {
    return {}; // fallback
  }
}
let systemConfig = loadSystemConfig();

const fleetEnabled = systemConfig.enable_fleet ?? true;
if (!fleetEnabled) {
  console.log('Fleet disabled via system.json');
  process.exit(0);
}

const fleetServerUrl = systemConfig.fleet_server_url || process.env.FLEET_SERVER_URL;
const fleetSecret = systemConfig.fleet_secret || process.env.FLEET_SECRET || 'changeme';
const tags = systemConfig.fleet_tags || [];
const repoUrl = systemConfig.iac_repo_url || '';
const repoBranch = systemConfig.iac_repo_branch || 'main';
const heartbeatIntervalSec = systemConfig.heartbeat_interval_sec || 30;
// ponytail: these are read once; restart agent to pick up changes
const hostname = systemConfig.hostname || systemConfig.system_name || systemConfig['iac_repo_subdir'] || 'unknown';
const metricsIntervalSec = systemConfig.metrics_interval_sec || 60;
const logUnits = systemConfig.fleet_log_units || [];
const shares = resolveShares(systemConfig);   // read once like the rest; restart the agent to change it

if (!fleetServerUrl) {
  console.error('No fleet_server_url configured');
  await new Promise((resolve)=>setTimeout(resolve, 3000*1000));
  process.exit(1);
}


// ---- UUID persistence ----
const UUID_FILE = process.env.FLEET_UUID_FILE || '/data/state_fleet_uuid';
let uuid = systemConfig.fleet_uuid;          // pinned in system.json: survives a lost /data
try {
  if (!uuid && fs.existsSync(UUID_FILE)) uuid = fs.readFileSync(UUID_FILE, 'utf8').trim();
} catch {}
if (!uuid) {
  uuid = crypto.randomUUID();
  try { fs.writeFileSync(UUID_FILE, uuid); }
  catch (e) {
    // without a stored id every restart registers as a new device
    console.error(`WARNING: cannot store the device id in ${UUID_FILE} (${e.message}). ` +
      'This device will show up as a new one after every restart. Set "fleet_uuid" in system.json or make /data persistent.');
  }
}

// ---- iacApi (Unix socket) ----
const SOCKET_PATH = process.env.IAC_SOCKET_PATH || '/socket/cuos-iac.sock';
function iacApi(app_command, data = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH);
    client.on('connect', () => {
      client.write(JSON.stringify({ app_command, ...data }) + '\n');
    });
    let response = '';
    client.on('data', chunk => { response += chunk.toString(); });
    client.on('end', () => {
      try { resolve(JSON.parse(response)); } catch { resolve(response.trim()); }
    });
    client.on('error', reject);
  });
}

let backoffMs = 5000;
const MAX_BACKOFF = 180000;
let ws;

// ---- Device token ----
// fleet_secret is only the bootstrap secret. The server hands this device a token of its own the first time
// (or after an admin approved it) and the agent uses that from then on. It lives next to the device id in /data.
const TOKEN_FILE = process.env.FLEET_TOKEN_FILE || '/data/state_fleet_token';
let token = null;
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch {}
function saveToken(t) {
  token = t;
  try { fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 }); }
  catch (e) {
    console.error(`WARNING: cannot store the device token in ${TOKEN_FILE} (${e.message}). ` +
      'After a restart this device has to be approved again. Make /data persistent.');
  }
}
function dropToken() { token = null; try { fs.rmSync(TOKEN_FILE, { force: true }); } catch {} }
let tokenRefusals = 0;   // the server not knowing our token several times in a row: it was revoked or the server lost its data

function connect() {
  const wsUrl = fleetServerUrl.replace(/\/$/, '') + '/ws';
  console.log('Connecting to', wsUrl, token ? '(with device token)' : '(with the bootstrap secret)');
  ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token || fleetSecret}` } });
  const mine = ws;
  let reconnecting = false;
  const retry = () => { if (!reconnecting) { reconnecting = true; scheduleReconnect(); } };

  ws.on('unexpected-response', (req, res) => {
    const reason = res.headers['x-fleet-reason'] || String(res.statusCode);
    res.resume(); req.destroy();
    console.error(`Server refused the connection: ${reason}`);
    if (token && reason === 'token_unknown' && ++tokenRefusals >= 3) {
      console.error('The server does not know this device token any more; enrolling again with the bootstrap secret.');
      dropToken(); tokenRefusals = 0;
    }
    retry();
  });
  ws.on('open', async () => {
    backoffMs = 5000; tokenRefusals = 0;
    let cuosVersion = null;
    try { cuosVersion = await iacApi('cuos:version'); } catch {}
    mine.send(JSON.stringify({
      type: 'client_hello',
      uuid,
      hostname,
      cuos_version: cuosVersion,
      agent_version: agentVersion,
      tags,
      repo_url: repoUrl,
      repo_branch: repoBranch,
      protocol_version: 2,
      shares
    }));
  });
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'server_welcome') { admitted = true; startHeartbeat(); }   // admitted: from here on we report
    else if (msg.type === 'enrolled' || msg.type === 'token_rotate') {
      if (typeof msg.token === 'string' && msg.token.startsWith('ft_')) { saveToken(msg.token); console.log(msg.type === 'enrolled' ? 'Enrolled, device token stored.' : 'Device token rotated.'); }
    }
    else if (msg.type === 'pending') console.log(`Waiting for an administrator to approve this device (${msg.reason || ''}).`);
    else if (msg.type === 'update_trigger') handleUpdateTrigger(msg);
  });
  ws.on('close', () => { admitted = false; retry(); });
  ws.on('error', (err) => {
    console.error('WS error', err.message);
  });
}

let heartbeatTimer;
let metricsTimer;
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  clearInterval(metricsTimer);
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat', uuid }));
    }
  }, heartbeatIntervalSec * 1000);
  metricsTimer = setInterval(collectAndSendMetrics, metricsIntervalSec * 1000);
  // Sofort initial einmal senden
  collectAndSendMetrics();
}

function scheduleReconnect() {
  clearInterval(heartbeatTimer);
  clearInterval(metricsTimer);
  console.log('Disconnected, reconnect in', backoffMs / 1000, 's');
  setTimeout(() => {
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    connect();
  }, backoffMs);
}

async function handleUpdateTrigger(msg) {
  console.log(JSON.stringify({ msg: 'update trigger', requested_by: msg.requested_by || null, allowed: shares.remote_update }));
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!shares.remote_update) {
    ws.send(JSON.stringify({ type: 'update_denied', uuid, reason: 'remote update is not permitted on this device' }));
    return;
  }
  ws.send(JSON.stringify({ type: 'update_status', uuid, phase: 'start' }));
  let success = false;
  let error;
  try {
    // Use cuos API to trigger update similar to WebUI (app update)
    const resp = await iacApi('update');
    // Assume empty string or object means success (adjust later if richer status returned)
    success = resp !== null && resp !== undefined;
  } catch (e) {
    error = e.message;
  }
  ws.send(JSON.stringify({
    type: 'update_status',
    uuid,
    phase: 'finished',
    success,
    error
  }));
}

async function collectAndSendMetrics() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Reload config optionally (in case tags/version changed)
  systemConfig = loadSystemConfig();
  let stateData = {};
  let resourcesData = {};
  let appStateData = {};
  try { stateData = await iacApi('cuos:state'); } catch {}
  try { resourcesData = await iacApi('cuos:resources'); } catch {}
  try { appStateData = await iacApi('state'); } catch {}
  // Derived percentages
  if (resourcesData.mem_used_mb && resourcesData.mem_total_mb) {
    resourcesData.ram_percent = Math.round((resourcesData.mem_used_mb / resourcesData.mem_total_mb) * 100);
  }
  if (resourcesData.disk_used_mb && resourcesData.disk_total_mb) {
    resourcesData.disk_percent = Math.round((resourcesData.disk_used_mb / resourcesData.disk_total_mb) * 100);
  }
  const payload = {
    type: 'metrics',
    uuid,
    state: {
      state: stateData.state,
      version: stateData.version,
      start_date: stateData.start_date,
      last_update_date: stateData.last_update_date,
      last_update_check: stateData.last_update_check,
      partition: stateData.partition,
      update_state: stateData.update_state
    },
    resources: filterResources({
      cpu_usage: resourcesData.cpu_usage,
      cpu_cores: resourcesData.cpu_cores,
      ram_percent: resourcesData.ram_percent,
      mem_used_mb: resourcesData.mem_used_mb,
      mem_total_mb: resourcesData.mem_total_mb,
      disk_percent: resourcesData.disk_percent,
      disk_used_mb: resourcesData.disk_used_mb,
      disk_total_mb: resourcesData.disk_total_mb,
      uptime_seconds: Math.floor(os.uptime()),
      virt_type: resourcesData.virt_type,
      network: resourcesData.network,
      default_route_ip: resourcesData.default_route_ip,
      dns_servers: resourcesData.dns_servers,
      ntp_servers: resourcesData.ntp_servers,
      ntp_service_active: resourcesData.ntp_service_active,
      ntp_synchronizede: resourcesData.ntp_synchronizede,
      routes: resourcesData.routes
    }, shares),
    app_state: filterAppState(appStateData, shares)
  };
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.error('Failed to send metrics', e.message);
  }
}

// ---- Logs ----
// Sources are chosen by the owner (fleet_share.logs): "iac" = the IaC manager's lines from the CuOS log,
// "system" = journal units listed in fleet_log_units. Lines are scrubbed (redact.js), queued with a hard cap
// and sent over the same connection as everything else, only once the server has admitted this device.
// What does not fit while offline is dropped, oldest first.
const redact = makeRedactor(systemConfig.fleet_share?.logs_redact, m => console.error(m));
const QUEUE_MAX = 2000, BATCH = 400;
const logQueue = [];
let admitted = false;

function queueLog(source, unit, priority, message, time = Date.now()) {
  const m = redact(String(message)).slice(0, 2000);
  if (!m.trim()) return;
  logQueue.push({ t: time, s: source, u: String(unit || '').slice(0, 64), p: priority, m });
  if (logQueue.length > QUEUE_MAX) logQueue.splice(0, logQueue.length - QUEUE_MAX);
}

setInterval(() => {
  if (!admitted || !ws || ws.readyState !== WebSocket.OPEN) return;
  while (logQueue.length) {
    const batch = logQueue.splice(0, BATCH);
    try { ws.send(JSON.stringify({ type: 'logs', entries: batch })); }
    catch { logQueue.unshift(...batch); return; }
  }
}, 5000);

// "iac": the CuOS log API returns {date, level, message}; our own lines carry this prefix
const IAC_PREFIX = '[cuos-iac] ';
const PRIORITY = { err: 3, error: 3, warn: 4, warning: 4, info: 6, debug: 7 };
let lastIacDate = '';
async function pollIacLog() {
  try {
    const lines = await iacApi('cuos:log');
    if (!Array.isArray(lines)) return;
    const fresh = lastIacDate ? lines.filter(l => l.date > lastIacDate) : lines.slice(-50);
    for (const l of fresh) {
      if (String(l.message || '').startsWith(IAC_PREFIX)) queueLog('iac', 'cuos-iac', PRIORITY[l.level] ?? 6, l.message.slice(IAC_PREFIX.length), Date.parse(l.date) || Date.now());
    }
    if (fresh.length) lastIacDate = fresh.at(-1).date;
  } catch {}
}

// "system": journalctl for the named units
function startJournal(units) {
  let proc;
  try {
    proc = spawn('journalctl', ['-f', '-n', '0', '--output=json', ...units.flatMap(u => ['-u', u])]);
  } catch {
    console.error('journalctl unavailable, system log forwarding disabled');
    return;
  }
  let partial = '';
  proc.stdout.on('data', chunk => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        queueLog('system', e._SYSTEMD_UNIT || e.SYSLOG_IDENTIFIER, Number(e.PRIORITY) || 6, e.MESSAGE,
          e.__REALTIME_TIMESTAMP ? Number(e.__REALTIME_TIMESTAMP) / 1000 : Date.now());
      } catch {}
    }
  });
  proc.on('error', () => {});
  proc.on('close', () => {
    console.log('journalctl exited, restarting in 10s');
    setTimeout(() => startJournal(units), 10000);
  });
}

connect();
if (shares.logs.includes('iac')) { pollIacLog(); setInterval(pollIacLog, 5000); }
if (shares.logs.includes('system')) startJournal(logUnits);
