// SPDX-License-Identifier: Apache-2.0
// Mock of the cuos-iac unix socket API (iac/api/trigger) for local UI development.
// Protocol: one JSON line {app_command, ...params} in, one JSON document out, then close.
// Usage: node dev/mock-iac.js [socket-path]
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SOCKET = process.argv[2] || process.env.IAC_SOCKET_PATH || path.join(os.tmpdir(), 'cuos-webui-dev', 'cuos-iac.sock');
fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
fs.rmSync(SOCKET, { force: true });

const iso = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const rnd = (a, b) => a + Math.random() * (b - a);

// --- simulated state ---------------------------------------------------------

const state = {
  iac_state: 'running',                // real values: starting | updating | running | "<step> failed"
  last_iac_start: iso(new Date(Date.now() - 3600e3)),
  last_iac_update_check: iso(new Date(Date.now() - 90e3)),
  iac_commit: '3f9c2a71b0d84e5c9a1e6f7d2b8c4a90e1d5f3b2',
  iac_branch: 'main',
  last_iac_update: iso(new Date(Date.now() - 2 * 86400e3)),
};

let containers = [
  { Names: 'iac-traefik-1',  Image: 'docker.io/library/traefik:v3.1', Status: 'Up 3 hours',         RunningFor: '3 hours ago', Size: '12.3MB (virtual 189MB)', Ports: '0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp', Networks: 'iac_default', CreatedAt: '2026-10-03 07:12:01 +0200 CEST' },
  { Names: 'iac-zigbee2mqtt-1', Image: 'ghcr.io/koenkk/zigbee2mqtt:2.1', Status: 'Up 3 hours (healthy)', RunningFor: '3 hours ago', Size: '4.1MB (virtual 312MB)',  Ports: '0.0.0.0:8080->8080/tcp', Networks: 'iac_default', CreatedAt: '2026-10-03 07:12:03 +0200 CEST' },
  { Names: 'iac-mosquitto-1', Image: 'eclipse-mosquitto:2',            Status: 'Up 3 hours',         RunningFor: '3 hours ago', Size: '0B (virtual 12.6MB)',    Ports: '0.0.0.0:1883->1883/tcp', Networks: 'iac_default', CreatedAt: '2026-10-03 07:12:02 +0200 CEST' },
  { Names: 'iac-db-migrate-1', Image: 'registry.example.com/acme/migrate:5', Status: 'Exited (0) 3 hours ago', RunningFor: '3 hours ago', Size: '0B (virtual 64MB)', Ports: '', Networks: 'iac_default', CreatedAt: '2026-10-03 07:11:58 +0200 CEST' },
  { Names: 'iac-influxdb-1', Image: 'influxdb:2.7', Status: 'Up 5 minutes (unhealthy)', RunningFor: '3 hours ago', Size: '2MB (virtual 310MB)', Ports: '0.0.0.0:8086->8086/tcp', Networks: 'iac_default', CreatedAt: '2026-10-03 07:12:05 +0200 CEST' },
  { Names: 'iac-nodered-1', Image: 'nodered/node-red:4', Status: 'Up 10 seconds (health: starting)', RunningFor: '10 seconds ago', Size: '1MB (virtual 420MB)', Ports: '0.0.0.0:1880->1880/tcp', Networks: 'iac_default', CreatedAt: '2026-10-03 10:12:05 +0200 CEST' },
  { Names: 'iac-grafana-1',  Image: 'registry.example.com/grafana/grafana:11', Status: 'Exited (1) 2 minutes ago', RunningFor: '3 hours ago', Size: '1.2MB (virtual 486MB)', Ports: '', Networks: 'iac_default', CreatedAt: '2026-10-03 07:12:04 +0200 CEST' },
];

// fleet agent status as iac/api/trigger keeps it (fleet:status / fleet:status:set); starts with a demo so the
// card is visible without an agent. A real agent (or any caller) replaces it with fleet:status:set.
let fleet = {
  server: 'fleet.example.com', state: 'connected', since: iso(new Date(Date.now() - 5400e3)), error: null,
  device_id: '5f0c2a9e-3b71-4d6a-9a1e-0c8b7d2e4f10', enrollment: 'enrolled', agent_version: '0.5.2', last_remote_update: null, demo: true,
  shares: { resources: true, iac_state: true, network: 'summary', logs: ['iac'], remote_update: true },
};
const fleetFresh = () => ({ ...fleet, updated: fleet.demo === false ? fleet.updated : iso() });   // the demo keeps looking alive

let progress = [];       // list of {step,status,ts}, same shape as iac/entrypoint.sh emit_progress
const logs = [];         // {date,level,message}; iac lines carry the "[cuos-iac] " prefix like the real log

function log(level, message) { logs.push({ date: iso(), level, message }); if (logs.length > 500) logs.shift(); }

for (const m of ['kernel: eth0: link up', 'kernel: eth1: link up', 'dockerd: API listen on /var/run/docker.sock', '[cuos-iac] Info: repo is up to date.'])
  log('info', m);

setInterval(() => {
  const pick = [
    ['info', 'systemd[1]: Started Periodic Command Scheduler.'],
    ['info', 'dockerd: ignoring event container=iac-traefik-1 type=health_status'],
    ['info', '[cuos-iac] Info: no new commit.'],
    ['warn', 'kernel: nf_conntrack: table full, dropping packet'],
    ['err',  'sshd[812]: error: maximum authentication attempts exceeded for root'],
  ];
  const [l, m] = pick[Math.floor(Math.random() * pick.length)];
  log(l, m);
}, 4000);

// Simulated update run, mirrors the steps iac/entrypoint.sh emits
const STEPS = ['clone_or_pull', 'verify_commit', 'decrypt_files', 'apply_system_json', 'compose_up'];
let runs = 0;            // every odd run fails at compose_up, the next one recovers
function runUpdate() {
  if (state.iac_state === 'updating') return;
  const willFail = ++runs % 2 === 1;
  state.iac_state = 'updating';
  progress = [];
  log('info', '[cuos-iac] Info: update started.');
  let i = 0;
  const next = () => {
    if (i > 0) progress[i - 1] = { ...progress[i - 1], status: 'done', ts: iso() };
    if (willFail && i === STEPS.length) {
      progress[i - 1] = { ...progress[i - 1], status: 'failed', ts: iso() };
      state.iac_state = 'docker compose failed';
      state.iac_error = "docker compose up failed: service 'influxdb' is unhealthy";
      state.iac_error_date = iso();
      log('err', '[cuos-iac] Error: docker compose up failed.');
      return;
    }
    if (i === STEPS.length) {
      state.iac_state = 'running';
      state.last_iac_update_check = iso();
      state.iac_commit = [...Array(40)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
      log('info', `[cuos-iac] Info: now at ${state.iac_commit.slice(0, 8)}.`);
      return;
    }
    progress[i] = { step: STEPS[i], status: 'in_progress', ts: iso() };
    i++;
    setTimeout(next, 1500);
  };
  next();
}

// --- command handlers ----------------------------------------------------------

const byName = n => containers.find(c => c.Names === n);
const guard = (p, fn) => { const c = byName(p.name); return c ? fn(c) : { error: 'container not found in managed project' }; };

const handlers = {
  ps: () => containers,
  state: () => state,
  progress: () => progress,
  'cuos:state': () => ({ state: 'running', version: '2026.10.1', slot: 'A', start_date: iso(new Date(Date.now() - 86400e3)), last_update_date: iso(new Date(Date.now() - 6 * 86400e3)), last_update_check: iso(new Date(Date.now() - 3600e3)), update_state: 'up to date' }),
  'cuos:log': () => logs,
  'cuos:resources': () => ({
    cpu_usage: rnd(5, 60), mem_used_mb: Math.round(rnd(900, 1500)), mem_total_mb: 3800,
    disk_used_mb: 11200, disk_total_mb: 29000,
    network: [{ interface: 'eth0', ip: '192.168.1.50/24' }, { interface: 'eth1', ip: '10.10.0.5/24' }],
    dns_servers: ['192.168.1.1', '1.1.1.1'], ntp_servers: ['pool.ntp.org', 'time.cloudflare.com'],
    virt_type: 'kvm', ntp_service_active: true, ntp_synchronizede: true,
    routes: ['default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50 metric 100', '10.10.0.0/24 dev eth1 proto kernel scope link src 10.10.0.5', '172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown'],
    default_route_ip: '192.168.1.1', net_tx_mbps: +rnd(0, 2).toFixed(2), net_rx_mbps: +rnd(0, 5).toFixed(2),
  }),
  'docker:version': () => ({ version: '27.3.1', api: '1.47' }),
  'fleet:status': () => (fleet ? fleetFresh() : {}),
  'fleet:status:set': p => {
    if (!p.status || typeof p.status !== 'object' || JSON.stringify(p.status).length > 4096) return { error: 'invalid status' };
    fleet = { ...p.status, demo: false }; return { result: 'ok' };
  },
  'docker:logs': p => guard(p, c => ({ lines: [...Array(20)].map((_, i) => `${iso()} ${c.Names} log line ${i + 1}`) })),
  'docker:restart': p => guard(p, c => { c.Status = 'Up Less than a second'; return { result: 'ok' }; }),
  'docker:stop':    p => guard(p, c => { c.Status = 'Exited (0) Less than a second ago'; return { result: 'ok' }; }),
  'docker:start':   p => guard(p, c => { c.Status = 'Up Less than a second'; return { result: 'ok' }; }),
  'docker:recreate': p => guard(p, c => { c.Status = 'Up Less than a second'; return { result: 'ok' }; }),
  'docker:remove':  p => guard(p, c => { containers = containers.filter(x => x !== c); return { result: 'ok' }; }),
  'compose:file': () => ({ content: 'services:\n  traefik:\n    image: traefik:v3.1\n    ports: ["80:80", "443:443"]\n  mosquitto:\n    image: eclipse-mosquitto:2\n' }),
  'dry-run': () => ({ has_changes: true, diff: '3c3\n<   "iac_poll_interval": 21600,\n---\n>   "iac_poll_interval": 300,' }),
  update: () => { runUpdate(); return ''; },          // real one prints nothing (killall sleep)
  config: () => 'Config signed by dev\nPassing config to system ...',
  'cuos:update': () => '', 'cuos:reboot': () => '', 'cuos:shutdown': () => '', 'cuos:rollback': () => '',
};

net.createServer(conn => {
  let buf = '';
  conn.on('data', d => {
    buf += d;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    let req = {};
    try { req = JSON.parse(buf.slice(0, nl)); } catch {}
    const h = handlers[req.app_command];
    const out = h ? h(req) : 'No valid command provided. Exiting.';
    conn.end(typeof out === 'string' ? out + '\n' : JSON.stringify(out));
  });
  conn.on('error', () => {});
}).listen(SOCKET, () => console.log(`[mock-iac] listening on ${SOCKET}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { fs.rmSync(SOCKET, { force: true }); process.exit(0); });
