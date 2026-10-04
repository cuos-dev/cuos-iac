// SPDX-License-Identifier: Apache-2.0
// Fleet Agent MVP
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import net from 'net';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { resolveShares, filterResources, filterAppState, filterBackup } from './share.js';
import { makeRedactor } from './redact.js';
import { cleanRepoUrl, shortVersion, primaryIp } from './clean.js';
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
// A server with a certificate of its own (not from a public CA): its certificate, or the CA that signed it, as PEM text.
// The connection is still checked against it, nothing is switched off.
const fleetCa = typeof systemConfig.fleet_ca === 'string' && systemConfig.fleet_ca.includes('BEGIN CERTIFICATE') ? systemConfig.fleet_ca : undefined;
const tags = systemConfig.fleet_tags || [];
const repoUrl = cleanRepoUrl(systemConfig.iac_repo_url || '') || '';   // never with the token that may be in it
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
// ---- Status for the device owner ----
// Published through the IaC container (fleet:status:set) so the device's own WebUI can show what this agent
// is doing: which server, connected or not, enrolled or waiting, and what it shares. It never contains the
// secret or the token. An IaC container without these commands just ignores the call.
const serverHost = (() => { try { return new URL(fleetServerUrl).host; } catch { return String(fleetServerUrl).replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]*@/, '').split('/')[0]; } })();
const status = {
  server: serverHost, state: 'connecting', since: new Date().toISOString(), error: null,
  device_id: uuid, enrollment: token ? 'enrolled' : 'bootstrap', shares, agent_version: agentVersion, last_remote_update: null,
};
let publishTimer;
function publish() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => { status.updated = new Date().toISOString(); iacApi('fleet:status:set', { status }).catch(() => {}); }, 300);
}
function setState(state, error = null) {
  if (status.state !== state) status.since = new Date().toISOString();
  status.state = state; status.error = error;
  publish();
}
setInterval(publish, 30_000);                // the WebUI treats a status that stops refreshing as "agent not running"

// what the server's refusal reasons mean for a person
const REFUSALS = {
  bad_secret: 'The server does not accept the fleet secret.',
  token_unknown: 'The server does not know this device token.',
  too_many_attempts: 'Too many failed attempts; the server is pausing this address.',
  rejected: 'An administrator rejected this device.',
  'token revoked': 'The token of this device was revoked; it has to be approved again.',
  forgotten: 'An administrator removed this device from the server.',
  're-enrolled': 'This device was enrolled again from another connection.',
  'uuid does not match token': 'The device id does not match its token.',
  'protocol too old': 'The server needs a newer agent.',
  'invalid uuid': 'The server refused the device id.',
};
const refusalText = reason => REFUSALS[reason] || `The server refused the connection (${reason}).`;

let tokenRefusals = 0;   // the server not knowing our token several times in a row: it was revoked or the server lost its data

function connect() {
  setState('connecting');
  const wsUrl = fleetServerUrl.replace(/\/$/, '') + '/ws';
  console.log('Connecting to', wsUrl, token ? '(with device token)' : '(with the bootstrap secret)');
  ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token || fleetSecret}` }, ...(fleetCa ? { ca: fleetCa } : {}) });
  const mine = ws;
  let reconnecting = false;
  const retry = () => { if (!reconnecting) { reconnecting = true; scheduleReconnect(); } };

  ws.on('unexpected-response', (req, res) => {
    const reason = res.headers['x-fleet-reason'] || String(res.statusCode);
    res.resume(); req.destroy();
    console.error(`Server refused the connection: ${reason}`);
    setState('refused', refusalText(reason));
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
      cuos_version: shortVersion(cuosVersion),
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
    if (msg.type === 'server_welcome') { admitted = true; status.enrollment = token ? 'enrolled' : 'bootstrap'; setState('connected'); startHeartbeat(); }   // admitted: from here on we report
    else if (msg.type === 'enrolled' || msg.type === 'token_rotate') {
      if (typeof msg.token === 'string' && msg.token.startsWith('ft_')) { saveToken(msg.token); console.log(msg.type === 'enrolled' ? 'Enrolled, device token stored.' : 'Device token rotated.'); status.enrollment = 'enrolled'; publish(); }
    }
    else if (msg.type === 'pending') { console.log(`Waiting for an administrator to approve this device (${msg.reason || ''}).`); status.enrollment = 'waiting'; setState('pending', msg.reason === 'approval required' ? 'Waiting for an administrator to approve this device.' : 'This device id is already known to the server without its token; waiting for an administrator.'); }
    else if (msg.type === 'update_trigger') handleUpdateTrigger(msg);
  });
  ws.on('close', (code, reason) => {
    admitted = false;
    const why = String(reason || '');
    if (code === 1008 && why) setState('refused', refusalText(why));                    // the server closed us on purpose
    else if (status.state !== 'refused' && status.state !== 'pending') setState('disconnected', 'The connection was lost.');
    retry();
  });
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
  status.last_remote_update = { at: new Date().toISOString(), by: typeof msg.requested_by === 'string' ? msg.requested_by.slice(0, 64) : null, allowed: shares.remote_update };
  publish();
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
  let backupData = null;
  if (shares.backup) { try { backupData = await iacApi('backup:status'); } catch {} }   // an IaC manager without the command answers with text: ignored
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
      primary_ip: primaryIp(resourcesData),
      dns_servers: resourcesData.dns_servers,
      ntp_servers: resourcesData.ntp_servers,
      ntp_service_active: resourcesData.ntp_service_active,
      ntp_synchronizede: resourcesData.ntp_synchronizede,
      routes: resourcesData.routes
    }, shares),
    app_state: filterAppState(appStateData, shares),
    backup: filterBackup(backupData, shares)
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
  let missing = false;
  proc.on('error', e => {
    if (e.code === 'ENOENT') {
      missing = true;
      console.error('System logs are not forwarded: there is no journalctl in this container (and the host journal is not mounted). Remove "system" from fleet_share.logs, or use an image that has them.');
    } else console.error('journalctl:', e.message);
  });
  proc.on('close', () => {
    if (missing) return;       // it will not appear by waiting
    console.log('journalctl exited, restarting in 10s');
    setTimeout(() => startJournal(units), 10000);
  });
}

connect();
if (shares.logs.includes('iac')) { pollIacLog(); setInterval(pollIacLog, 5000); }
if (shares.logs.includes('system')) startJournal(logUnits);
