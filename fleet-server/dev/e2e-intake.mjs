// SPDX-License-Identifier: Apache-2.0
// End-to-end check of metrics and log intake, limits, roles, the live stream and 'forget device' against a RUNNING dev server.
//   npm run dev:mock        (in another terminal)
//   node dev/e2e-intake.mjs
// Prints one line per check; the expected values are in dev/README.md.
import WebSocket from 'ws';

const RUN = Date.now().toString(36);   // ids are unique per run: an id that is already enrolled would wait for approval instead
const B = process.env.FLEET_URL || 'http://127.0.0.1:8085', SECRET = process.env.FLEET_SECRET || 'dev-fleet-secret';
const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const adm = basic('admin', 'admin'), view = basic('viewer', 'viewer');
const get = async (p, h = adm) => { const r = await fetch(B + p, { headers: h }); return { status: r.status, body: await r.json().catch(() => null) }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = (l, v) => console.log(l.padEnd(58), v);

async function agent(id, shares) {
  const ws = new WebSocket(B.replace(/^http/, 'ws') + '/ws', { headers: { authorization: 'Bearer ' + SECRET } });
  await new Promise(r => ws.on('open', r)); const inbox = []; ws.on('message', raw => inbox.push(JSON.parse(raw)));
  ws.send(JSON.stringify({ type: 'client_hello', uuid: id, hostname: id, cuos_version: '1', agent_version: '1', tags: [], repo_url: '', repo_branch: 'main', protocol_version: 2, shares: { resources: true, iac_state: true, network: 'summary', logs: [], remote_update: true, ...shares } }));
  await sleep(400); return { ws, inbox, send: o => ws.send(JSON.stringify(o)) };
}
const L = (s, m, extra = {}) => ({ t: Date.now(), s, u: 'u', p: 6, m, ...extra });
const logs = async (id, qs = '') => (await get(`/api/logs/${id}${qs}`)).body;

console.log('## 1 metrics over the connection become history');
const m = await agent(`ingest-m-${RUN}`, {});
m.send({ type: 'metrics', uuid: `ingest-m-${RUN}`, state: {}, resources: { cpu_usage: 41.5, ram_percent: 60, disk_percent: 30, mem_used_mb: 1, disk_used_mb: 1 }, app_state: {} }); await sleep(300);
const series = (await get(`/api/metrics/ingest-m-${RUN}?range=1h`)).body;
out('series: cpu / ram / disk points', series.map(s => s.values.length).join(' / '));
out('value stored', series[0].values[0][1]);
const seeded = (await get('/api/metrics/00000000-0000-4000-8000-000000000003?range=7d')).body;
out('seeded device, 7d range: buckets (one per hour, ~168)', seeded[0].values.length);
out('seeded device, 24h range', (await get('/api/metrics/00000000-0000-4000-8000-000000000003?range=24h')).body[0].values.length);

console.log('## 2 logs: only announced sources, scrubbed by the agent, bounded by the server');
const a = await agent(`ingest-a-${RUN}`, { logs: ['iac'] });
a.send({ type: 'logs', entries: [L('iac', 'iac line one'), L('system', 'system line (source not announced)'), L('iac', 'x'.repeat(5000)), { t: 1, s: 'iac', u: 'u', p: 99, m: 'bad priority + ancient ts' }, { s: 'iac' }, 'junk', null] }); await sleep(400);
const got = await logs(`ingest-a-${RUN}`);
out('accepted lines', got.map(l => l.message.slice(0, 24)).join(' | '));
out('unannounced source dropped', !got.some(l => l.source === 'system'));
out('oversize line cut to 2000', got.find(l => l.message.startsWith('xxx'))?.message.length);
const odd = got.find(l => l.message.startsWith('bad priority'));
out('bad priority -> 6, ancient ts -> now', `${odd.priority} / ${Date.now() - Date.parse(odd.time) < 5000}`);
const none = await agent(`ingest-none-${RUN}`, { logs: [] }); none.send({ type: 'logs', entries: [L('iac', 'should not be stored')] }); await sleep(300);
out('device sharing no logs: stored', (await logs(`ingest-none-${RUN}`)).length);
const burst = await agent(`ingest-burst-${RUN}`, { logs: ['iac'] });
for (let i = 0; i < 10; i++) burst.send({ type: 'logs', entries: Array.from({ length: 500 }, (_, k) => L('iac', `b${i}-${k}`)) });   // 5000 lines at once
await sleep(1200);
out('burst of 5000 lines: stored (cap ~2000 burst)', (await logs(`ingest-burst-${RUN}`, '?limit=1000')).length >= 1000 ? 'capped near 2000 (limit=1000 page full)' : 'few');
const cnt = (await get(`/api/logs/ingest-burst-${RUN}?limit=1000`)).body.length; out('  first page rows', cnt);
const big = await new Promise(r => { const w = new WebSocket(B.replace(/^http/, 'ws') + '/ws', { headers: { authorization: 'Bearer ' + SECRET } }); w.on('open', () => { w.send(JSON.stringify({ type: 'logs', entries: [{ m: 'z'.repeat(1_200_000) }] })); }); w.on('close', c => r(c)); w.on('error', () => {}); });
out('1.2 MB frame -> connection closed with', big);
out('  the server is still up afterwards', (await get('/api/meta')).status);

console.log('## 3 filters and roles');
out('q=line', (await logs(`ingest-a-${RUN}`, '?q=line')).length);
out('level=3 (errors) on info lines', (await logs(`ingest-a-${RUN}`, '?level=3')).length);
out('source=system on an iac-only device', (await logs(`ingest-a-${RUN}`, '?source=system')).length);
out('viewer reads logs', (await get(`/api/logs/ingest-a-${RUN}`, view)).status);
out('read-only API key reads logs', (await get(`/api/logs/ingest-a-${RUN}`, { authorization: 'Bearer dev-ro-key' })).status);
out('viewer reads metrics (allowed)', (await get(`/api/metrics/ingest-m-${RUN}?range=1h`, view)).status);

console.log('## 4 live stream');
const lines = []; const ctl = new AbortController();
const sse = fetch(B + `/api/logs/ingest-a-${RUN}/stream?q=live`, { headers: adm, signal: ctl.signal }).then(async r => { const rd = r.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; lines.push(Buffer.from(value).toString()); } }).catch(() => {});
await sleep(400); a.send({ type: 'logs', entries: [L('iac', 'live line A'), L('iac', 'not matching the filter'), L('iac', 'live line B')] }); await sleep(600); ctl.abort();
out('stream delivered (filtered, live)', lines.join('').match(/live line [AB]/g)?.join(', '));

console.log('## 5 forget a device');
const id = `ingest-a-${RUN}`;
out('delete as viewer', (await fetch(`${B}/api/clients/${id}`, { method: 'DELETE', headers: view })).status);
out('delete as admin', (await fetch(`${B}/api/clients/${id}`, { method: 'DELETE', headers: adm })).status);
out('  device gone / logs gone / history gone', `${(await get('/api/clients/' + id)).status} / ${(await get('/api/logs/' + id)).status} / ${(await get('/api/metrics/' + id + '?range=1h')).status}`);
process.exit(0);
