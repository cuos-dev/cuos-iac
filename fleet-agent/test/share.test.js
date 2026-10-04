import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShares, filterResources, filterAppState } from '../share.js';
import { makeRedactor } from '../redact.js';

const R = { cpu_usage: 5, ram_percent: 40, disk_percent: 10, uptime_seconds: 9, default_route_ip: '10.0.0.1', network: [{ interface: 'eth0', ip: '10.0.0.5/24' }], dns_servers: ['1.1.1.1'], ntp_servers: ['x'], routes: ['default via 10.0.0.1'], secret_extra: 'x' };
const keys = o => Object.keys(o).sort().join(',');

test('shares: safe defaults, and junk never widens what is shared', () => {
  assert.deepEqual(resolveShares({}), { resources: true, iac_state: true, network: 'summary', logs: [], remote_update: true, backup: true });
  assert.equal(resolveShares({ fleet_share: { network: 'everything' } }).network, 'summary');
  assert.equal(resolveShares({ fleet_share: 'yes' }).network, 'summary');
  assert.equal(resolveShares({ fleet_share: { remote_update: false } }).remote_update, false);
});

test('shares: log sources are chosen explicitly', () => {
  assert.deepEqual(resolveShares({ fleet_share: { logs: ['iac'] } }).logs, ['iac']);
  assert.deepEqual(resolveShares({ fleet_share: { logs: 'iac' } }).logs, ['iac']);
  assert.deepEqual(resolveShares({ fleet_share: { logs: ['iac', 'system'] }, fleet_log_units: ['a.service'] }).logs, ['iac', 'system']);
  assert.deepEqual(resolveShares({ fleet_share: { logs: ['system'] } }).logs, [], 'system without units shares nothing');
  for (const bad of [true, 'all', 'off', false, ['containers'], 7, null]) assert.deepEqual(resolveShares({ fleet_share: { logs: bad }, fleet_log_units: ['a'] }).logs, [], `bad value ${JSON.stringify(bad)}`);
  assert.deepEqual(resolveShares({ fleet_log_units: ['a.service'] }).logs, [], 'units alone do not switch forwarding on');
});

test('filterResources: only what is shared, unknown fields never pass', () => {
  const f = (cfg) => filterResources(R, resolveShares({ fleet_share: cfg }));
  assert.equal(keys(f({})), 'cpu_usage,default_route_ip,disk_percent,ram_percent,uptime_seconds');
  assert.ok(!('network' in f({})) && !('routes' in f({})) && !('dns_servers' in f({})));
  assert.ok('network' in f({ network: 'full' }) && 'routes' in f({ network: 'full' }));
  assert.equal(keys(f({ network: 'none' })), 'cpu_usage,disk_percent,ram_percent,uptime_seconds');
  assert.equal(keys(f({ resources: false, network: 'none' })), '');
  assert.ok(!('secret_extra' in f({ network: 'full' })));
  assert.deepEqual(filterAppState({ iac_state: 'running' }, resolveShares({ fleet_share: { iac_state: false } })), {});
});

test('redact: credentials, tokens, keys and URL passwords are scrubbed, normal lines stay', () => {
  const r = makeRedactor();
  const cases = [
    ['login failed password=hunter2 user=bob', 'password=[redacted]', 'hunter2'],
    ['{"api_key": "abc123", "x": 1}', '"api_key": [redacted]', 'abc123'],
    ['GET /x Authorization: Bearer abc.def.ghi', 'Authorization: Bearer [redacted]', 'abc.def'],
    ['token ft_' + 'A'.repeat(43) + ' issued', '[redacted-token]', 'AAAA'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', '[redacted-jwt]', 'eyJzdWI'],
    ['clone https://bob:s3cret@git.example.com/x.git failed', 'https://bob:[redacted]@git.example.com', 's3cret'],
    ['key -----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY----- done', '[redacted-private-key]', 'AAAA'],
  ];
  for (const [inp, want, secret] of cases) { const out = r(inp); assert.ok(out.includes(want), `${inp} -> ${out}`); assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`); }
  assert.equal(r('Info: repo is up to date.'), 'Info: repo is up to date.');
  assert.equal(r('connect from 10.1.2.3'), 'connect from 10.1.2.3', 'ips are kept by default');
});

test('redact: options', () => {
  assert.equal(makeRedactor({ ips: true })('connect from 10.1.2.3'), 'connect from 10.1.2.x');
  assert.equal(makeRedactor({ patterns: ['serial=\\w+'] })('dev serial=AB12 ok'), 'dev [redacted] ok');
  assert.equal(makeRedactor({ builtin: false })('password=x'), 'password=x');
  let warned = ''; makeRedactor({ patterns: ['('] }, m => (warned = m)); assert.ok(warned.includes('invalid'));
});
