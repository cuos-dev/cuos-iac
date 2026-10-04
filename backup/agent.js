// SPDX-License-Identifier: Apache-2.0
// Backup agent: runs restic on a schedule, takes database dumps first, reports its status.
import fs from 'fs';
import net from 'net';
import path from 'path';
import { loadConfig, publicRepository } from './config.js';
import { parseCron, nextRun, matches } from './cron.js';
import { Restic } from './restic.js';
import { backupJob } from './job.js';

const SYSTEM_JSON = process.env.CUOS_SYSTEM_JSON || '/system.json';
const DATA_DIR = process.env.BACKUP_DATA_DIR || '/data';
const STAGING = process.env.BACKUP_STAGING_DIR || '/staging';
const IAC_SOCKET = process.env.IAC_SOCKET_PATH || '/socket/cuos-iac.sock';
const CONTROL_SOCKET = process.env.BACKUP_SOCKET_PATH || '/socket/cuos-backup.sock';
const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, msg, ...extra }));

let sys = {};
try { sys = JSON.parse(fs.readFileSync(SYSTEM_JSON, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') log('warn', `cannot read ${SYSTEM_JSON}: ${e.message}`); }
if (sys.enable_backup === false) { log('info', 'backup disabled via system.json'); process.exit(0); }

let cfg;
try { cfg = loadConfig(sys); }
catch (e) {
  log('error', `configuration: ${e.message}`);
  await new Promise(r => setTimeout(r, 3600 * 1000));    // do not spin under `restart: always`
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const restic = new Restic(cfg, { bin: process.env.RESTIC_BIN || 'restic', stateDir: path.join(DATA_DIR, 'restic') });
const scheduleCron = parseCron(cfg.schedule), checkCron = cfg.check ? parseCron(cfg.check) : null;

// ---- status ----
let status = { state: 'idle', repository: publicRepository(cfg.repository), schedule: cfg.schedule, last_run: null, last_check: null, snapshots: null, next_run: null, updated: null };
try { status = { ...status, ...JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')), state: 'idle' }; } catch {}

function iacApi(app_command, data = {}) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(IAC_SOCKET);
    c.setTimeout(10000, () => c.destroy(new Error('socket timeout')));
    c.on('connect', () => c.write(JSON.stringify({ app_command, ...data }) + '\n'));
    let out = '';
    c.on('data', d => { out += d; });
    c.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(out.trim()); } });
    c.on('error', reject);
  });
}

async function publish() {
  status.updated = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  status.next_run = nextRun(scheduleCron)?.toISOString() ?? null;
  // a run that should have happened (an hour of grace) and did not: the container was down, or the clock is wrong
  const due = status.last_run?.finished ? nextRun(scheduleCron, new Date(status.last_run.finished)) : null;
  status.overdue = !!due && status.state === 'idle' && Date.now() > due.getTime() + 3600_000;
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status)); } catch (e) { log('warn', `cannot save status: ${e.message}`); }
  try { await iacApi('backup:status:set', { status }); }   // an IaC manager without the command (or no socket) is not a problem
  catch {}
}

async function ping(ok) {
  const url = ok ? cfg.pingUrl : cfg.pingFailUrl;
  if (!url) return;
  try { await fetch(url, { signal: AbortSignal.timeout(10000) }); } catch (e) { log('warn', `ping failed: ${e.message}`); }
}

// ---- jobs ----
let busy = false;
async function runBackup(reason) {
  if (busy) return { error: 'a run is already in progress' };
  busy = true; status.state = 'running'; await publish();
  log('info', 'backup started', { reason });
  const rec = await backupJob({ cfg, restic, dockerBin: DOCKER_BIN, dockerEnv: process.env, stagingDir: STAGING });
  status.last_run = rec; status.state = 'idle';
  try { status.snapshots = (await restic.snapshots(1)).count; } catch {}
  log(rec.result === 'failed' ? 'error' : 'info', 'backup finished', { result: rec.result, error: rec.error, seconds: rec.seconds, snapshot: rec.snapshot_id });
  await publish(); await ping(rec.result === 'ok');
  busy = false;
  return rec;
}

async function runCheck() {
  if (busy) return;
  busy = true; status.state = 'checking'; await publish();
  const t = Date.now(); let ok = true, error = null;
  try { await restic.ensureRepo(); await restic.check(); } catch (e) { ok = false; error = String(e.message).slice(0, 500); }
  status.last_check = { time: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ok, error, seconds: Math.round((Date.now() - t) / 100) / 10 };
  status.state = 'idle'; log(ok ? 'info' : 'error', 'check finished', { ok, error });
  await publish(); if (!ok) await ping(false);
  busy = false;
}

// ---- control socket: { "command": "run" | "status" | "snapshots" } ----
// Reachable by whoever shares the socket volume (the web UI container, which decides who may ask).
function startControl() {
  try { fs.rmSync(CONTROL_SOCKET, { force: true }); } catch {}
  const server = net.createServer(conn => {
    let buf = '';
    conn.on('data', d => {
      buf += d;
      if (buf.length > 4096) return conn.destroy();
      if (!buf.includes('\n')) return;
      let msg; try { msg = JSON.parse(buf.split('\n')[0]); } catch { return conn.end(JSON.stringify({ error: 'invalid json' })); }
      handle(msg).then(r => conn.end(JSON.stringify(r)), e => conn.end(JSON.stringify({ error: String(e.message) })));
    });
    conn.on('error', () => {});
  });
  server.on('error', e => log('warn', `control socket: ${e.message}`));
  server.listen(CONTROL_SOCKET, () => { try { fs.chmodSync(CONTROL_SOCKET, 0o660); } catch {} });
}
async function handle(msg) {
  if (msg.command === 'status') return status;
  if (msg.command === 'snapshots') return restic.snapshots();
  if (msg.command === 'run') { if (busy) return { error: 'a run is already in progress' }; runBackup('manual'); return { result: 'started' }; }
  return { error: 'unknown command' };
}

// ---- main loop: look at the clock twice a minute, run what is due once per minute ----
log('info', 'backup agent started', { repository: status.repository, schedule: cfg.schedule, check: cfg.check, paths: cfg.paths });
startControl();
await publish();
let lastMinute = '';
setInterval(() => {
  const now = new Date(), key = now.toISOString().slice(0, 16);
  if (key === lastMinute) return;
  lastMinute = key;
  if (matches(scheduleCron, now)) runBackup('schedule');
  else if (checkCron && matches(checkCron, now)) runCheck();
}, 20000);
setInterval(publish, 5 * 60_000);   // a heartbeat: the UI calls a status that has gone quiet 'not reporting'

function shutdown() { try { fs.rmSync(CONTROL_SOCKET, { force: true }); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
