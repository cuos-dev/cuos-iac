// SPDX-License-Identifier: Apache-2.0
// Stand-in for VictoriaMetrics and VictoriaLogs (one port, both APIs) for local UI development.
// Usage: node dev/mock-backends.js [port]
import http from 'http';

const PORT = Number(process.argv[2]) || 18428;
const rnd = seed => { let x = 0; for (const c of String(seed)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); };

// --- VictoriaMetrics: /api/v1/query_range -------------------------------------------------
const BASE = { cuos_cpu_usage: [35, 25], cuos_ram_percent: [55, 10], cuos_disk_percent: [40, 3] };
function queryRange(q) {
  const m = /^(\w+)\{uuid="([^"]*)"\}$/.exec(q.get('query') || '');
  if (!m) return { status: 'success', data: { resultType: 'matrix', result: [] } };
  const [, metric, uuid] = m;
  const [mid, amp] = BASE[metric] ?? [50, 10];
  const start = Number(q.get('start')), end = Number(q.get('end')), step = Number(q.get('step')) || 60;
  const r = rnd(uuid + metric), phase = r() * 6.28, values = [];
  for (let t = start; t <= end; t += step) {
    const v = mid + amp * Math.sin(t / 3600 + phase) + (r() - 0.5) * amp * 0.4;
    values.push([t, String(Math.max(1, Math.min(99, v)).toFixed(2))]);
  }
  return { status: 'success', data: { resultType: 'matrix', result: [{ metric: { __name__: metric, uuid }, values }] } };
}

// --- VictoriaLogs: /select/logsql/query (NDJSON) ---------------------------------------------
const MSGS = [
  ['dockerd', 'ignoring event container=traefik type=health_status'],
  ['systemd', 'Started Periodic Command Scheduler.'],
  ['cuos-iac', 'Info: no new commit.'],
  ['kernel', 'eth0: link up'],
  ['sshd', 'error: maximum authentication attempts exceeded for root'],
  ['cuos-iac', 'Info: repo is up to date.'],
];
const TICK = 7000;
function logs(query, startIso, limit) {
  const host = /hostname:(\S+)/.exec(query)?.[1] ?? 'unknown';
  const filter = /AND \((.*)\)$/.exec(query)?.[1]?.toLowerCase();
  const now = Date.now(), from = startIso ? new Date(startIso).getTime() : now - limit * TICK;
  const out = [];
  for (let t = Math.ceil(from / TICK) * TICK; t <= now && out.length < limit; t += TICK) {
    const [unit, msg] = MSGS[(t / TICK) % MSGS.length];
    if (filter && !`${unit} ${msg}`.toLowerCase().includes(filter)) continue;
    out.push(JSON.stringify({ _time: new Date(t).toISOString(), _msg: msg, unit, hostname: host }));
  }
  return out.join('\n');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = ''; for await (const c of req) body += c;
  if (url.pathname === '/api/v1/query_range') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(queryRange(url.searchParams))); }
  if (url.pathname === '/select/logsql/query') {
    const f = new URLSearchParams(body);
    return res.end(logs(f.get('query') || '', f.get('start'), Number(f.get('limit')) || 100));
  }
  if (url.pathname === '/api/v1/import/prometheus' || url.pathname === '/insert/jsonline') { res.statusCode = 204; return res.end(); }
  res.statusCode = 404; res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`[mock-backends] VM + VL on :${PORT}`));
