// SPDX-License-Identifier: Apache-2.0
// Fake cuos-iac agents that speak the fleet protocol (fleet-agent/agent.js) to a local fleet-server.
// Usage: node dev/fake-agents.js   (FLEET_URL, FLEET_SECRET, FAKE_AGENTS to override)
import WebSocket from 'ws';
import { resolveShares, filterResources, filterAppState } from '../../fleet-agent/share.js';   // the real agent's filters
import { makeRedactor } from '../../fleet-agent/redact.js';

const URL_ = process.env.FLEET_URL || 'ws://127.0.0.1:8085';
const SECRET = process.env.FLEET_SECRET || 'dev-fleet-secret';
const COUNT = Number(process.env.FAKE_AGENTS) || 18;      // > 15 so the table paginates
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

const NAMES = ['hall', 'kitchen', 'garage', 'office', 'workshop', 'cellar', 'attic', 'garden', 'barn', 'shop', 'lab', 'depot'];
function spec(i) {
  const n = i + 1;
  return {
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    hostname: `${NAMES[i % NAMES.length]}-${String(n).padStart(2, '0')}`,
    cuos_version: i % 6 === 2 ? '2026.9.3' : '2026.10.1',          // some outdated
    agent_version: i % 9 === 4 ? '0.4.0' : '0.5.2',
    tags: i % 3 === 0 ? ['prod', 'edge'] : i % 3 === 1 ? ['prod'] : ['test'],
    // behaviour: normal | offline | failing (iac_state error) | flaky (updates fail)
    mode: i % 7 === 5 ? 'offline' : i % 8 === 3 ? 'failing' : i % 5 === 4 ? 'flaky' : (i === 11 || i === 16) ? 'amnesia' : 'normal',
    base: { cpu: rand(8, 70), ram: rand(30, 90), disk: rand(20, 92) },
    ip: `192.168.${10 + (i % 4)}.${20 + n}`,
    // privacy profile, as the owner would write it in system.json
    share: { 0: { logs: ['iac'] }, 3: { logs: ['iac'] }, 6: { logs: ['iac', 'system'] }, 9: { logs: ['iac'] }, 12: { logs: ['iac'] }, 15: { logs: ['iac', 'system'], logs_redact: { ips: true } }, 4: { network: 'full' }, 1: { network: 'full' }, 2: { remote_update: false }, 6: { resources: false },
             7: { network: 'none' }, 8: { iac_state: false }, 10: { remote_update: false, network: 'full' } }[i],
    units: ['sshd.service', 'docker.service'],
  };
}

const tokens = new Map();   // device id -> token, stands in for /data/state_fleet_token

function run(a) {
  const shares = resolveShares({ fleet_share: a.share, fleet_log_units: a.units });
  const redact = makeRedactor(a.share?.logs_redact);
  const headers = { Authorization: `Bearer ${tokens.get(a.uuid) || SECRET}` };
  const ws = new WebSocket(`${URL_}/ws`, { headers });
  let iac = a.mode === 'failing' ? 'docker compose failed' : 'running';
  let timers = [];
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const retry = () => { timers.forEach(clearInterval); if (a.mode !== 'offline' || !a.seen) setTimeout(() => run(a), 3000); };

  const full = (cpu, ram, disk) => ({ cpu_usage: cpu, cpu_cores: 4, ram_percent: Math.round(ram), mem_used_mb: Math.round(ram * 38), mem_total_mb: 3800,
    disk_percent: Math.round(disk), disk_used_mb: Math.round(disk * 290), disk_total_mb: 29000,
    uptime_seconds: 3600 * (5 + a.uuid.length) + Math.floor(process.uptime()), default_route_ip: a.ip, virt_type: 'none',
    network: [{ interface: 'eth0', ip: `${a.ip}/24` }, { interface: 'eth1', ip: '10.10.0.5/24' }],
    dns_servers: ['192.168.1.1', '1.1.1.1'], ntp_servers: ['pool.ntp.org'], ntp_service_active: true, ntp_synchronizede: true,
    routes: [`default via ${a.ip.replace(/\.\d+$/, '.1')} dev eth0 proto dhcp metric 100`, '10.10.0.0/24 dev eth1 proto kernel scope link src 10.10.0.5'] });

  // log lines as the real agent would queue them (scrubbed first); only the sources this device shares
  const LINES = [
    ['iac', 'cuos-iac', 6, 'Info: no new commit.'], ['iac', 'cuos-iac', 6, 'Info: repo is up to date.'],
    ['iac', 'cuos-iac', 4, 'Warning: registry slow, retrying pull'], ['iac', 'cuos-iac', 3, 'Error: docker compose up failed for service influxdb'],
    ['system', 'sshd.service', 6, 'Accepted publickey for deploy from 192.168.1.20 port 51234'],
    ['system', 'sshd.service', 4, 'Failed password for root from 203.0.113.9 port 40022 password=hunter2'],
    ['system', 'docker.service', 6, 'clone https://bot:s3cret@git.example.com/acme/home-iac.git done'],
  ];
  const sendLogs = () => {
    const entries = [];
    for (let k = 0; k < 1 + Math.floor(rand(0, 3)); k++) {
      const [s, u, p, m] = pick(LINES);
      if (shares.logs.includes(s)) entries.push({ t: Date.now(), s, u, p, m: redact(m) });
    }
    if (entries.length) send({ type: 'logs', entries });
  };

  const metrics = () => {
    const jitter = (v, d) => Math.max(1, Math.min(99, v + rand(-d, d)));
    const cpu = jitter(a.base.cpu, 8), ram = jitter(a.base.ram, 2), disk = a.base.disk;
    send({ type: 'metrics', uuid: a.uuid,
      state: { version: a.cuos_version },
      resources: filterResources(full(cpu, ram, disk), shares),
      app_state: filterAppState({ iac_state: iac, iac_commit: 'a1b2c3d4e5f6', last_iac_start: new Date().toISOString(), ...(iac.includes('failed') ? { iac_error: 'docker compose up failed' } : {}) }, shares) });
  };

  ws.on('unexpected-response', (req, res) => { console.log(`[fake-agents] ${a.hostname}: refused (${res.headers['x-fleet-reason'] || res.statusCode})`); res.resume(); req.destroy(); retry(); });
  ws.on('open', () => {
    send({ type: 'client_hello', uuid: a.uuid, hostname: a.hostname, cuos_version: a.cuos_version, agent_version: a.agent_version,
      tags: a.tags, repo_url: 'https://git.example.com/acme/home-iac.git', repo_branch: 'main', protocol_version: 2, shares });
  });

  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'enrolled' || m.type === 'token_rotate') tokens.set(a.uuid, m.token);
    else if (m.type === 'server_welcome') {
      a.seen = true;
      metrics();
      if (a.mode === 'offline') { setTimeout(() => ws.close(), 1500); return; }     // known to the server, never comes back
      timers = [setInterval(() => send({ type: 'heartbeat', uuid: a.uuid }), 10000), setInterval(metrics, 5000), setInterval(sendLogs, 5000)];
      // lost /data: forget the token and come back with the bootstrap secret only -> has to be approved
      if (a.mode === 'amnesia' && !a.forgot) setTimeout(() => { a.forgot = true; tokens.delete(a.uuid); ws.close(); }, 12000);
    }
    else if (m.type === 'update_trigger') {
      if (!shares.remote_update) return send({ type: 'update_denied', uuid: a.uuid, reason: 'remote update is not permitted on this device' });
      iac = 'updating'; send({ type: 'update_status', uuid: a.uuid, phase: 'start' }); metrics();
      setTimeout(() => {
        const ok = a.mode !== 'flaky' && a.mode !== 'failing';
        iac = ok ? 'running' : 'docker compose failed';
        send({ type: 'update_status', uuid: a.uuid, phase: 'finished', success: ok, error: ok ? undefined : 'docker compose up failed' });
        metrics();
      }, 4000 + Math.random() * 3000);
    }
  });

  ws.on('close', retry);
  ws.on('error', () => {});
}

setTimeout(() => { for (let i = 0; i < COUNT; i++) setTimeout(() => run(spec(i)), i * 150); console.log(`[fake-agents] ${COUNT} agents -> ${URL_}`); }, 800);
