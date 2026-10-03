// SPDX-License-Identifier: Apache-2.0
// End-to-end check of the server's login, roles, API keys, agent connection and id validation against a RUNNING dev server.
//   npm run dev:mock        (in another terminal)
//   node dev/e2e-auth.mjs
// Prints one line per check; the expected values are in dev/README.md.
import WebSocket from 'ws';

const RUN = Date.now().toString(36);   // ids are unique per run: an id that is already enrolled would wait for approval instead
const B = process.env.FLEET_URL || 'http://127.0.0.1:8085';
const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const bearer = k => ({ authorization: 'Bearer ' + k });
const code = async (path, headers = {}, method = 'GET', body) => (await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...headers }, body })).status;
const row = (l, v) => console.log(l.padEnd(34), v);
row('GET /api/clients no auth', await code('/api/clients'));
row('  admin / viewer / wrong', [await code('/api/clients', basic('admin', 'admin')), await code('/api/clients', basic('viewer', 'viewer')), await code('/api/clients', basic('admin', 'x'))].join(' / '));
row('  api key admin / ro / bad', [await code('/api/clients', bearer('dev-admin-key')), await code('/api/clients', bearer('dev-ro-key')), await code('/api/clients', bearer('nope'))].join(' / '));
const id = '00000000-0000-4000-8000-000000000001';
row('POST update: viewer/ro-key', [await code(`/api/clients/${id}/update`, basic('viewer', 'viewer'), 'POST'), await code(`/api/clients/${id}/update`, bearer('dev-ro-key'), 'POST')].join(' / '));
row('POST update: admin/admin-key', [await code(`/api/clients/${id}/update`, basic('admin', 'admin'), 'POST'), await code(`/api/clients/${id}/update`, bearer('dev-admin-key'), 'POST')].join(' / '));
row('POST bulk-update: viewer/admin', [await code('/api/bulk-update', basic('viewer', 'viewer'), 'POST', JSON.stringify({ ids: [id] })), await code('/api/bulk-update', basic('admin', 'admin'), 'POST', JSON.stringify({ ids: [id] }))].join(' / '));
row('GET /ui/ no auth / viewer', [await code('/ui/'), await code('/ui/', basic('viewer', 'viewer'))].join(' / '));
const meta = async (u) => JSON.stringify((await (await fetch(B + '/api/meta', { headers: basic(u, u) })).json()).user);
row('meta.user admin / viewer', (await meta('admin')) + ' ' + (await meta('viewer')));

// agent websocket
const agent = (url, opts) => new Promise(res => { const w = new WebSocket(url, opts); w.on('open', () => res({ w, ok: true })); w.on('unexpected-response', (_, r) => res({ ok: false, code: r.statusCode })); w.on('error', () => {}); });
const A = B.replace(/^http/, 'ws');
const hdrOk = await agent(A + '/ws', { headers: bearer('dev-fleet-secret') }); row('agent WS /ws + Bearer header', hdrOk.ok ? 'open' : hdrOk.code); hdrOk.w?.close();
const legacy = await agent(A + '/ws/dev-fleet-secret'); row('agent WS secret in the URL (removed): refused', legacy.ok ? 'open' : legacy.code); legacy.w?.close();
const bad1 = await agent(A + '/ws/wrong'); const bad2 = await agent(A + '/ws', { headers: bearer('wrong') }); const bad3 = await agent(A + '/ws'); row('agent WS wrong secret/hdr/none', [bad1.code, bad2.code, bad3.code].join(' / '));
const evil = await agent(A + '/ws', { headers: bearer('dev-fleet-secret') });
const closed = new Promise(r => evil.w.on('close', (c, reason) => r(`${c} ${reason}`)));
evil.w.send(JSON.stringify({ type: 'client_hello', uuid: 'x"} or {job=~".*', hostname: 'h' }));
row('hello with injected uuid', await Promise.race([closed, new Promise(r => setTimeout(() => r('still open'), 1500))]));
