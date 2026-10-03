// SPDX-License-Identifier: Apache-2.0
// End-to-end check of enrolment, tokens and the admin decisions against a RUNNING dev server.
//   npm run dev:mock        (in another terminal, fresh database)
//   node dev/e2e-enrollment.mjs          [FLEET_URL=http://127.0.0.1:8085]
// Prints one line per check; the expected values are in dev/README.md. Needs the dev users/keys of dev/run.js.
import WebSocket from 'ws';

const RUN = Date.now().toString(36);   // ids are unique per run: an id that is already enrolled would wait for approval instead
const B = process.env.FLEET_URL || 'http://127.0.0.1:8085', WSU = B.replace(/^http/, 'ws') + '/ws', SECRET = process.env.FLEET_SECRET || 'dev-fleet-secret';
const adm = { authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') };
const api = async (path, method = 'GET') => { const r = await fetch(B + path, { method, headers: adm }); return { status: r.status, body: await r.json().catch(() => null) }; };
const dev = async id => (await api('/api/clients/' + id)).body;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = (l, v) => console.log(l.padEnd(52), v);

// a scripted agent: connects with a credential, says hello for `uuid`, collects what the server sends
async function agent(cred, uuid, extra = {}) {
  const inbox = []; const ws = new WebSocket(WSU, { headers: cred ? { authorization: 'Bearer ' + cred } : {} });
  const res = await new Promise(r => { ws.on('open', () => r({ ok: true })); ws.on('unexpected-response', (_, x) => r({ ok: false, code: x.statusCode, reason: x.headers['x-fleet-reason'] })); ws.on('error', () => {}); });
  if (!res.ok) return res;
  let closed = null; ws.on('close', (c, why) => { closed = `${c} ${why}`; }); ws.on('message', raw => inbox.push(JSON.parse(raw)));
  ws.send(JSON.stringify({ type: 'client_hello', uuid, hostname: extra.hostname || 'scripted', cuos_version: '1', agent_version: '1', tags: [], repo_url: '', repo_branch: 'main', protocol_version: 2, shares: { resources: true, iac_state: true, network: 'summary', logs: false, remote_update: true } }));
  await sleep(400);
  return { ok: true, ws, inbox, closed: () => closed, token: () => inbox.find(m => m.type === 'enrolled' || m.type === 'token_rotate')?.token };
}

const A = '00000000-0000-4000-8000-000000000002';   // kitchen-02, enrolled, online

console.log('## 1 impersonation: bootstrap secret + the id of an enrolled device');
const before = await dev(A);
const imp = await agent(SECRET, A, { hostname: 'EVIL' });
const after = await dev(A);
out('server answered', imp.inbox.map(m => m.type + (m.reason ? ` (${m.reason})` : '')).join(', '));
out('stored hostname unchanged / request recorded', `${after.hostname === before.hostname} / ${!!after.enrollment.request}`);
out('no token handed out', !imp.token());
out('real device keeps its status', after.status);

console.log('## 2 a pending connection cannot report anything');
imp.ws.send(JSON.stringify({ type: 'metrics', uuid: A, state: {}, resources: { cpu_usage: 99 }, app_state: {} })); await sleep(300);
out('kitchen-02 cpu_usage unchanged', (await dev(A)).metrics?.resources?.cpu_usage !== 99);
out('request is live for the admin', (await dev(A)).enrollment.request.live);

console.log('## 3 reject keeps the device, drops the request');
out('reject', (await api(`/api/clients/${A}/reject`, 'POST')).status);
out('  request cleared / still active / evil conn closed', `${!(await dev(A)).enrollment.request} / ${(await dev(A)).enrollment.state} / ${imp.closed()}`);

console.log('## 4 a connection is bound to its device (token of one, messages for another)');
const t1 = await agent(SECRET, `bind-test-1-${RUN}`); const tok1 = t1.token();
out(`enrolled bind-test-1-${RUN} (auto)`, !!tok1);
const withTok = await agent(tok1, `bind-test-1-${RUN}`);
out('reconnect with the token', withTok.ok ? withTok.inbox.map(m => m.type).join(',') : withTok.code);
const wrongId = await agent(tok1, A);
out(`token of bind-test-1-${RUN} claiming kitchen-02`, wrongId.ok ? wrongId.closed() : wrongId.code);
withTok.ws.send(JSON.stringify({ type: 'metrics', uuid: A, state: {}, resources: { cpu_usage: 77 }, app_state: {} })); await sleep(300);
out('metrics "for kitchen-02" via the other connection', (await dev(A)).metrics?.resources?.cpu_usage === 77 ? 'ACCEPTED (bad)' : 'ignored');

console.log('## 5 revoke');
out('revoke', (await api(`/api/clients/bind-test-1-${RUN}/revoke`, 'POST')).status);
await sleep(300);
out('  live connection closed', withTok.closed());
const stale = await agent(tok1, `bind-test-1-${RUN}`); out('  old token', stale.ok ? 'accepted (bad)' : `${stale.code} ${stale.reason}`);
const re = await agent(SECRET, `bind-test-1-${RUN}`);
out('  bootstrap again -> waits (no token)', `${re.inbox.map(m => m.type).join(',')} / token ${!!re.token()}`);
out('  approve', (await api(`/api/clients/bind-test-1-${RUN}/approve`, 'POST')).status);
await sleep(300); out('  gets a new token', !!re.token() && re.token() !== tok1);
const tok2 = re.token();

console.log('## 6 rotate: old token stays valid until the new one is used');
out('rotate', (await api(`/api/clients/bind-test-1-${RUN}/rotate-token`, 'POST')).status);
await sleep(300); const tok3 = re.inbox.filter(m => m.type === 'token_rotate').at(-1)?.token; out('  new token delivered', !!tok3 && tok3 !== tok2);
const viaOld = await agent(tok2, `bind-test-1-${RUN}`); out('  old token still works once', viaOld.ok);
viaOld.ws.close(); await sleep(200);
const viaNew = await agent(tok3, `bind-test-1-${RUN}`); out('  new token works', viaNew.ok);
viaNew.ws.close(); await sleep(200);
const oldAfter = await agent(tok2, `bind-test-1-${RUN}`); out('  old token after the new one was used', oldAfter.ok ? 'accepted (bad)' : `${oldAfter.code} ${oldAfter.reason}`);

console.log('## 7 viewer cannot decide');
const view = { authorization: 'Basic ' + Buffer.from('viewer:viewer').toString('base64') };
for (const a of ['approve', 'reject', 'revoke', 'rotate-token']) out(`  viewer POST ${a}`, (await fetch(`${B}/api/clients/${A}/${a}`, { method: 'POST', headers: view })).status);
process.exit(0);
