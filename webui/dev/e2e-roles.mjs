// SPDX-License-Identifier: Apache-2.0
// End-to-end check of the web UI users and roles against a RUNNING dev setup.
//   npm run dev:mock        (in another terminal)
//   node dev/e2e-roles.mjs          [WEBUI_URL=http://127.0.0.1:3000]
// Prints one line per check; the expected values are in dev/README.md.
import WebSocket from 'ws';

const RUN = Date.now().toString(36);   // ids are unique per run: an id that is already enrolled would wait for approval instead
const B = process.env.WEBUI_URL || 'http://127.0.0.1:3000';
const hdr = (u, p) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const status = async (u, p) => (await fetch(B + '/api/config', { headers: u ? hdr(u, p) : {} })).status;
console.log('no auth        ->', await status());
console.log('admin/admin    ->', await status('admin', 'admin'));
console.log('viewer/viewer  ->', await status('viewer', 'viewer'));
console.log('viewer/wrong   ->', await status('viewer', 'nope'));
console.log('ghost/x        ->', await status('ghost', 'x'));
for (const u of ['admin', 'viewer']) console.log(u, 'config.user ->', JSON.stringify((await (await fetch(B + '/api/config', { headers: hdr(u, u) })).json()).user));

async function actions(user, cmds) {
  const ws = new WebSocket(B.replace(/^http/, 'ws') + '/ws', { headers: hdr(user, user) });
  await new Promise(r => ws.on('open', r));
  const out = {}; const got = new Promise(res => ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'action_result') { out[m.id] = m.error ?? 'ok'; if (Object.keys(out).length === cmds.length) res(); } }));
  cmds.forEach(([c, extra], i) => ws.send(JSON.stringify({ type: 'action', id: c + i, command: c, ...extra })));
  await got; ws.close(); return out;
}
const cmds = [['ps'], ['docker:logs', { name: 'iac-traefik-1' }], ['docker:restart', { name: 'iac-traefik-1' }], ['update'], ['cuos:reboot'], ['compose:file'], ['config', { config: 'x' }], ['backup:run'], ['backup:snapshots'], ['nope']];
console.log('viewer:', JSON.stringify(await actions('viewer', cmds)));
console.log('admin: ', JSON.stringify(await actions('admin', cmds.filter(c => c[0] !== 'cuos:reboot'))));
// unauthenticated WS upgrade
const bad = new WebSocket(B.replace(/^http/, 'ws') + '/ws'); bad.on('error', e => console.log('ws no auth ->', e.message)); await new Promise(r => setTimeout(r, 500));
