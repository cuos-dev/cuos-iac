// SPDX-License-Identifier: Apache-2.0
// Dev helper: publish a fleet agent status to the running mock (what the real agent does with fleet:status:set), to see
// the Fleet card in every state.
//   node dev/fleet-status.mjs '{"state":"refused","error":"The server does not accept the fleet secret."}'
//   node dev/fleet-status.mjs reset        (back to the demo status)
import net from 'net';
import os from 'os';
import path from 'path';

const arg = process.argv[2];
if (!arg) { console.error('usage: node dev/fleet-status.mjs \'<json>\' | reset'); process.exit(2); }
const base = { server: 'fleet.example.com', state: 'connected', enrollment: 'enrolled', device_id: '5f0c2a9e-3b71-4d6a-9a1e-0c8b7d2e4f10', since: new Date().toISOString(), error: null, last_remote_update: null,
  shares: { resources: true, iac_state: true, network: 'summary', logs: ['iac'], remote_update: true } };
const status = arg === 'reset' ? { ...base, demo: true } : { ...base, ...JSON.parse(arg), updated: new Date().toISOString() };
const c = net.createConnection(process.env.IAC_SOCKET_PATH || path.join(os.tmpdir(), 'cuos-webui-dev', 'cuos-iac.sock'));
c.on('connect', () => c.write(JSON.stringify({ app_command: 'fleet:status:set', status }) + '\n'));
c.on('data', d => process.stdout.write(String(d)));
c.on('end', () => process.exit(0));
