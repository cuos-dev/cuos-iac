// SPDX-License-Identifier: Apache-2.0
// End-to-end check of the backup status a device reports, against a RUNNING dev server.
//   npm run dev:mock        (in another terminal)       node dev/e2e-backup.mjs          [FLEET_URL=http://127.0.0.1:8085]
import WebSocket from 'ws';

const RUN = Date.now().toString(36);
const B = process.env.FLEET_URL || 'http://127.0.0.1:8085', WSU = B.replace(/^http/, 'ws') + '/ws', SECRET = process.env.FLEET_SECRET || 'dev-fleet-secret';
const adm = { authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') };
const dev = async id => (await (await fetch(B + '/api/clients/' + id, { headers: adm })).json());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = (l, v) => console.log(l.padEnd(56), v);

async function agent(id, shares, backup) {
  const ws = new WebSocket(WSU, { headers: { authorization: 'Bearer ' + SECRET } });
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'client_hello', uuid: id, hostname: 'bk-' + id.slice(-3), protocol_version: 2, shares }));
  await sleep(400);
  ws.send(JSON.stringify({ type: 'metrics', uuid: id, state: {}, resources: {}, app_state: {}, backup }));
  await sleep(400);
  return ws;
}
const status = { state: 'idle', repository: 'rest:http://user:pw@nas/x', snapshots: 3, overdue: false, next_run: '2026-10-05T01:00:00Z',
  last_run: { finished: '2026-10-04T01:00:00Z', result: 'failed', error: 'dump x failed', seconds: 2, bytes: 100, dumps: [{ name: 'a.sql', container: 'iac-secret-1' }], evil: '<script>' }, extra: 'x'.repeat(5000) };

console.log('## a device that shares its backup status');
const a = `bk-${RUN}-a`, wa = await agent(a, { resources: true, iac_state: true, network: 'summary', logs: [], remote_update: true, backup: true }, status);
let d = await dev(a), b = d.metrics?.backup;
out('shares.backup', d.shares?.backup);
out('stored: result / dumps (count) / snapshots', `${b?.last_run?.result} / ${b?.last_run?.dumps} / ${b?.snapshots}`);
out('no repository, no container name, no extra fields', !JSON.stringify(b).includes('nas/x') && !JSON.stringify(b).includes('iac-secret') && !('extra' in b) && !('evil' in b.last_run));
wa.close();

console.log('## a device that does not share it');
const c = `bk-${RUN}-c`, wc = await agent(c, { resources: true, iac_state: true, network: 'summary', logs: [], remote_update: true, backup: false }, status);
d = await dev(c);
out('shares.backup / stored backup', `${d.shares?.backup} / ${d.metrics?.backup}`);
wc.close();

console.log('## junk instead of a status');
const j = `bk-${RUN}-j`, wj = await agent(j, { resources: true, iac_state: true, network: 'summary', logs: [], remote_update: true, backup: true }, 'not an object');
out('stored backup', (await dev(j)).metrics?.backup);
wj.close();
process.exit(0);
