// SPDX-License-Identifier: Apache-2.0
// End-to-end check of protocol 1 agents (the old fleet-agent: /ws/<secret>, no token) against a RUNNING dev server.
//   npm run dev:mock        (in another terminal, fresh database)
//   node dev/e2e-legacy.mjs          [FLEET_URL=http://127.0.0.1:8085]
// Prints one line per check; the expected values are in dev/README.md.
import WebSocket from 'ws';

const RUN = Date.now().toString(36);
const B = process.env.FLEET_URL || 'http://127.0.0.1:8085', WSB = B.replace(/^http/, 'ws') + '/ws', SECRET = process.env.FLEET_SECRET || 'dev-fleet-secret';
const adm = { authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') };
const api = async (path, method = 'GET') => { const r = await fetch(B + path, { method, headers: adm }); return { status: r.status, body: await r.json().catch(() => null) }; };
const dev = async id => (await api('/api/clients/' + id)).body;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = (l, v) => console.log(l.padEnd(52), v);

// what the old agent does: the secret in the path, hello with protocol_version 1 and the uuid in every message
async function oldAgent(uuid, { path = '/' + SECRET, protocol = 1 } = {}) {
  const inbox = []; const ws = new WebSocket(WSB + path);
  const res = await new Promise(r => { ws.on('open', () => r({ ok: true })); ws.on('unexpected-response', (_, x) => r({ ok: false, code: x.statusCode })); ws.on('error', () => {}); });
  if (!res.ok) return res;
  let closed = null; ws.on('close', (c, why) => { closed = `${c} ${why}`; }); ws.on('message', raw => inbox.push(JSON.parse(raw)));
  ws.send(JSON.stringify({ type: 'client_hello', uuid, hostname: 'old-' + uuid.slice(-4), cuos_version: '0.3', tags: [], repo_url: '', repo_branch: 'main', protocol_version: protocol }));
  await sleep(400);
  return { ok: true, ws, inbox, closed: () => closed };
}
const id = n => `legacy-${RUN}-${n}`;

console.log('## 1 a protocol 1 agent is admitted, reports, and can be updated');
const a = id(1), o = await oldAgent(a);
out('welcome received, no token handed out', `${o.inbox.some(m => m.type === 'server_welcome')} / ${!o.inbox.some(m => m.type === 'enrolled')}`);
o.ws.send(JSON.stringify({ type: 'metrics', uuid: a, state: { state: 'running' }, resources: { cpu_usage: 11, network: [{ interface: 'eth0', ip: '10.0.0.5/24' }], routes: ['default via 10.0.0.1'] }, app_state: { iac_state: 'running' } }));
o.ws.send(JSON.stringify({ type: 'heartbeat', uuid: a })); await sleep(300);
let d = await dev(a);
out('online, protocol 1, state legacy, no token', `${d.status} / ${d.protocol_version} / ${d.enrollment.state} / ${d.enrollment.has_token}`);
out('everything it sends is kept (no shares)', `${d.shares === null} / ${d.metrics?.resources?.cpu_usage} / ${!!d.metrics?.resources?.network}`);
const up = await api(`/api/clients/${a}/update`, 'POST'); await sleep(300);
out('update trigger reaches it', `${up.status} / ${o.inbox.some(m => m.type === 'update_trigger')}`);
o.ws.send(JSON.stringify({ type: 'update_status', uuid: a, phase: 'finished', success: true })); await sleep(300);
out('update status recorded', (await dev(a)).status);

console.log('## 2 messages cannot speak for another device');
const b = id(2), o2 = await oldAgent(b);
o2.ws.send(JSON.stringify({ type: 'metrics', uuid: a, state: {}, resources: { cpu_usage: 99 }, app_state: {} })); await sleep(300);
out('device 1 unchanged by device 2', (await dev(a)).metrics?.resources?.cpu_usage === 11);
o.ws.close(); o2.ws.close();

console.log('## 3 doors that stay closed');
out('wrong secret in the path', (await oldAgent(id(3), { path: '/wrong' })).code);
const p2 = await oldAgent(id(4), { protocol: 2 });
out('protocol 2 hello on the old path is closed', p2.closed());
const bad = await new Promise(r => { const ws = new WebSocket(WSB + '/x/y/z'); ws.on('unexpected-response', (_, x) => r(x.statusCode)); ws.on('open', () => r('open')); ws.on('error', () => {}); });
out('other paths', bad);

console.log('## 4 a device that has a token cannot be taken over through the old door');
const tok = id(5);
const mod = await new Promise(r => { const ws = new WebSocket(WSB, { headers: { authorization: 'Bearer ' + SECRET } }); const inbox = []; ws.on('message', m => inbox.push(JSON.parse(m))); ws.on('open', () => { ws.send(JSON.stringify({ type: 'client_hello', uuid: tok, hostname: 'new', protocol_version: 2, shares: {} })); setTimeout(() => r({ ws, inbox }), 500); }); });
out('new agent enrolled with a token', mod.inbox.some(m => m.type === 'enrolled'));
const take = await oldAgent(tok);
out('old agent with the same id is closed', take.closed());
out('record untouched (hostname, protocol)', `${(await dev(tok)).hostname} / ${(await dev(tok)).protocol_version}`);
mod.ws.close();

console.log('## 5 revoke keeps a legacy device out; an upgraded agent takes over a legacy id');
const c = id(6), o3 = await oldAgent(c); out('admitted', (await dev(c)).enrollment.state);
await api(`/api/clients/${c}/revoke`, 'POST'); await sleep(300);
out('revoked: closed', o3.closed());
const again = await oldAgent(c); out('revoked: reconnect refused', again.closed());
const e = id(7), o4 = await oldAgent(e); o4.ws.close(); await sleep(200);
const up2 = await new Promise(r => { const ws = new WebSocket(WSB, { headers: { authorization: 'Bearer ' + SECRET } }); const inbox = []; ws.on('message', m => inbox.push(JSON.parse(m))); ws.on('open', () => { ws.send(JSON.stringify({ type: 'client_hello', uuid: e, hostname: 'upgraded', protocol_version: 2, shares: {} })); setTimeout(() => r({ ws, inbox }), 500); }); });
d = await dev(e);
out('upgraded agent gets a token for its old id', `${up2.inbox.some(m => m.type === 'enrolled')} / ${d.enrollment.state} / ${d.protocol_version}`);
up2.ws.close();
process.exit(0);
