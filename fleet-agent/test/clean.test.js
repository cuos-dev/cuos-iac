// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRepoUrl, shortVersion, primaryIp } from '../clean.js';

test('a repository URL loses its credentials, query and fragment', () => {
  assert.equal(cleanRepoUrl('https://oldies:github_pat_XYZ@github.com/oldies/iac.git'), 'https://github.com/oldies/iac.git');
  assert.equal(cleanRepoUrl('https://token@github.com/o/r.git?x=1#y'), 'https://github.com/o/r.git');
  assert.equal(cleanRepoUrl('https://github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(cleanRepoUrl('git@github.com:o/r.git'), 'git@github.com:o/r.git');
  assert.equal(cleanRepoUrl('ssh://git:secret@host/r.git'), 'ssh://host/r.git');
  assert.equal(cleanRepoUrl(''), '');
  assert.equal(cleanRepoUrl(null), null);
  assert.ok(!String(cleanRepoUrl('https://a:b@c/d')).includes('b@'));
});

test('an image reference becomes a short version', () => {
  assert.equal(shortVersion('ghcr.io/cuos-dev/cuos-system:v0.6.1@sha256:' + 'a'.repeat(64)), 'v0.6.1');
  assert.equal(shortVersion('ghcr.io/cuos-dev/cuos-system:v0.6.1'), 'v0.6.1');
  assert.equal(shortVersion('ghcr.io/cuos-dev/cuos-system@sha256:0123456789abcdef0123'), 'sha256:0123456789ab');
  assert.equal(shortVersion('v0.6.1'), 'v0.6.1');
  assert.equal(shortVersion('localhost:5000/cuos-system:dev'), 'dev');
  assert.equal(shortVersion('  v1.2 \n'), 'v1.2');
  assert.equal(shortVersion(''), null);
  assert.equal(shortVersion(null), null);
});

test('the primary address is the device, not the gateway', () => {
  const r = {
    default_route_ip: '192.168.1.1',
    network: [{ interface: 'lo', ip: '127.0.0.1/8' }, { interface: 'eth0', ip: '192.168.1.50/24' }, { interface: 'eth1', ip: '10.0.0.5/24' }],
    routes: ['default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50 metric 100', '10.0.0.0/24 dev eth1 proto kernel src 10.0.0.5'],
  };
  assert.equal(primaryIp(r), '192.168.1.50');
  assert.equal(primaryIp({ ...r, routes: ['default via 192.168.1.1 dev eth1 metric 100'] }), '10.0.0.5');   // no src: the interface of the route
  assert.equal(primaryIp({ network: [{ interface: 'lo', ip: '127.0.0.1/8' }, { interface: 'ens3', ip: '172.20.0.9/16' }] }), '172.20.0.9');
  assert.equal(primaryIp({ default_route_ip: '192.168.1.1' }), null);   // only the gateway is known: no guess
  assert.equal(primaryIp(null), null);
});
