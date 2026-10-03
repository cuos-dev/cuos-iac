// SPDX-License-Identifier: Apache-2.0
// Fake cuos-iac agents that speak the fleet protocol (fleet-agent/agent.js) to a local fleet-server.
// Usage: node dev/fake-agents.js   (FLEET_URL, FLEET_SECRET, FAKE_AGENTS to override)
import WebSocket from 'ws';

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
    mode: i % 7 === 5 ? 'offline' : i % 8 === 3 ? 'failing' : i % 5 === 4 ? 'flaky' : 'normal',
    base: { cpu: rand(8, 70), ram: rand(30, 90), disk: rand(20, 92) },
    ip: `192.168.${10 + (i % 4)}.${20 + n}`,
  };
}

function run(a) {
  const ws = new WebSocket(`${URL_}/ws/${SECRET}`);
  let iac = a.mode === 'failing' ? 'docker compose failed' : 'running';
  let timers = [];
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));

  const metrics = () => {
    const jitter = (v, d) => Math.max(1, Math.min(99, v + rand(-d, d)));
    const cpu = jitter(a.base.cpu, 8), ram = jitter(a.base.ram, 2), disk = a.base.disk;
    send({ type: 'metrics', uuid: a.uuid,
      state: { version: a.cuos_version },
      resources: { cpu_usage: cpu, cpu_cores: 4, ram_percent: Math.round(ram), mem_used_mb: Math.round(ram * 38), mem_total_mb: 3800,
        disk_percent: Math.round(disk), disk_used_mb: Math.round(disk * 290), disk_total_mb: 29000,
        uptime_seconds: 3600 * (5 + a.uuid.length) + Math.floor(process.uptime()), default_route_ip: a.ip, virt_type: 'none' },
      app_state: { iac_state: iac, iac_commit: 'a1b2c3d4e5f6', last_iac_start: new Date().toISOString(), ...(iac.includes('failed') ? { iac_error: 'docker compose up failed' } : {}) } });
  };

  ws.on('open', () => {
    send({ type: 'client_hello', uuid: a.uuid, hostname: a.hostname, cuos_version: a.cuos_version, agent_version: a.agent_version,
      tags: a.tags, repo_url: 'https://git.example.com/acme/home-iac.git', repo_branch: 'main', protocol_version: 1 });
    metrics();
    if (a.mode === 'offline') { setTimeout(() => ws.close(), 1500); return; }     // known to the server, never comes back
    timers = [setInterval(() => send({ type: 'heartbeat', uuid: a.uuid }), 10000), setInterval(metrics, 5000)];
  });

  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type !== 'update_trigger') return;
    iac = 'updating'; send({ type: 'update_status', uuid: a.uuid, phase: 'start' }); metrics();
    setTimeout(() => {
      const ok = a.mode !== 'flaky' && a.mode !== 'failing';
      iac = ok ? 'running' : 'docker compose failed';
      send({ type: 'update_status', uuid: a.uuid, phase: 'finished', success: ok, error: ok ? undefined : 'docker compose up failed' });
      metrics();
    }, 4000 + Math.random() * 3000);
  });

  ws.on('close', () => { timers.forEach(clearInterval); if (a.mode !== 'offline') setTimeout(() => run(a), 3000); });
  ws.on('error', () => {});
}

setTimeout(() => { for (let i = 0; i < COUNT; i++) setTimeout(() => run(spec(i)), i * 150); console.log(`[fake-agents] ${COUNT} agents -> ${URL_}`); }, 800);
