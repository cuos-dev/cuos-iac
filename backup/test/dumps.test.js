// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseLabels, takeDumps } from '../dumps.js';

test('labels become dumps and excludes', () => {
  const r = parseLabels([
    { container: '/iac-postgresql-1', labels: { 'com.docker.compose.service': 'postgresql', 'cuos.backup.dump': 'pg_dumpall -U postgres', 'cuos.backup.exclude': '/data/pg, /data/pg2\n/data/pg3' } },
    { container: '/iac-mariadb-1', labels: { 'cuos.backup.dump': 'mariadb-dump --all-databases', 'cuos.backup.dump.name': 'maria.sql' } },
    { container: '/other', labels: {} },
  ]);
  assert.deepEqual(r.dumps, [
    { container: 'iac-postgresql-1', name: 'postgresql.dump', command: 'pg_dumpall -U postgres' },
    { container: 'iac-mariadb-1', name: 'maria.sql', command: 'mariadb-dump --all-databases' },
  ]);
  assert.deepEqual(r.excludes, ['/data/pg', '/data/pg2', '/data/pg3']);
});

test('dump names cannot leave the staging directory, and cannot collide', () => {
  for (const name of ['../x', 'a/b', '..', '', 'a b'])
    assert.throws(() => parseLabels([{ container: 'c', labels: { 'cuos.backup.dump': 'x', 'cuos.backup.dump.name': name || ' ' } }]), /invalid dump name/, name);
  assert.throws(() => parseLabels([
    { container: 'a', labels: { 'cuos.backup.dump': 'x', 'cuos.backup.dump.name': 'same' } },
    { container: 'b', labels: { 'cuos.backup.dump': 'x', 'cuos.backup.dump.name': 'same' } },
  ]), /two containers/);
});

// a stand-in for the docker CLI: `docker exec <container> sh -c <cmd>` runs <cmd> here
function fakeDocker(dir) {
  const p = path.join(dir, 'docker');
  fs.writeFileSync(p, '#!/bin/sh\n[ "$1" = exec ] && shift 2 && shift 2 && exec sh -c "$1"\nexit 9\n', { mode: 0o755 });
  return p;
}

test('takeDumps writes complete dumps, and fails on an error, an empty dump, or a timeout', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dumps-'));
  const opts = { dockerBin: fakeDocker(tmp), env: process.env, timeoutSec: 1 };
  const out = path.join(tmp, 'staging');
  const ok = await takeDumps([{ container: 'c', name: 'a.sql', command: 'echo SELECT 1' }], out, opts);
  assert.equal(fs.readFileSync(path.join(out, 'a.sql'), 'utf8'), 'SELECT 1\n');
  assert.equal(ok[0].bytes, 9);
  await assert.rejects(takeDumps([{ container: 'c', name: 'b.sql', command: 'echo boom >&2; exit 3' }], out, opts), /exit 3: boom/);
  await assert.rejects(takeDumps([{ container: 'c', name: 'c.sql', command: 'true' }], out, opts), /empty/);
  await assert.rejects(takeDumps([{ container: 'c', name: 'd.sql', command: 'sleep 5' }], out, opts), /timed out/);
  assert.ok(!fs.existsSync(path.join(out, 'b.sql.part')), 'no partial file is left behind');
  assert.ok(!fs.existsSync(path.join(out, 'b.sql')));
  fs.rmSync(tmp, { recursive: true });
});
