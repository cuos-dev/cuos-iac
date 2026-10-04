// SPDX-License-Identifier: Apache-2.0
// The whole run against a real restic and a local repository; docker is a small stand-in script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { loadConfig } from '../config.js';
import { Restic } from '../restic.js';
import { backupJob } from '../job.js';

const haveRestic = spawnSync('restic', ['version']).status === 0;

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'job-'));
  const data = path.join(tmp, 'data'); fs.mkdirSync(path.join(data, 'z2m'), { recursive: true });
  fs.writeFileSync(path.join(data, 'z2m', 'configuration.yaml'), 'permit_join: false\n');
  fs.mkdirSync(path.join(data, 'pgdata')); fs.writeFileSync(path.join(data, 'pgdata', 'raw'), 'live database files');
  // docker stand-in: one labelled container, whose dump command is whatever is in $DUMP_CMD
  const docker = path.join(tmp, 'docker');
  fs.writeFileSync(docker, `#!/bin/sh
case "$1" in
  ps) echo abc123 ;;
  inspect) printf '/iac-pg-1\\t{"com.docker.compose.service":"pg","cuos.backup.dump":"x","cuos.backup.exclude":"%s/pgdata"}\\n' "$DATA" ;;
  exec) shift 2; shift 2; exec sh -c "$DUMP_CMD" ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
  const cfg = (extra = {}) => loadConfig({ backup_repository: path.join(tmp, 'repo'), backup_password: 'pw', backup_paths: [data], backup_forget: false, hostname: 'testbox', ...extra }, {});
  const env = (dump) => ({ ...process.env, DATA: data, DUMP_CMD: dump });
  const job = (c, dump, over = {}) => backupJob({ cfg: c, restic: new Restic(c, { stateDir: path.join(tmp, 'state') }), dockerBin: docker, dockerEnv: env(dump), stagingDir: path.join(tmp, 'staging'), ...over });
  const restic = (c, ...args) => spawnSync('restic', args, { env: { ...process.env, RESTIC_REPOSITORY: c.repository, RESTIC_PASSWORD: c.password }, encoding: 'utf8' });
  return { tmp, data, cfg, job, restic };
}

test('a run backs up the data and the dump, leaves the live database files out, and cleans up', { skip: !haveRestic }, async () => {
  const { tmp, cfg, job, restic } = setup(), c = cfg();
  const rec = await job(c, 'echo CREATE TABLE t');
  assert.equal(rec.result, 'ok', rec.error);
  assert.equal(rec.dumps.length, 1);
  assert.match(rec.snapshot_id, /^[0-9a-f]{8}$/);
  const ls = restic(c, 'ls', 'latest').stdout;
  assert.match(ls, /configuration\.yaml/);
  assert.match(ls, /pg\.dump/);
  assert.doesNotMatch(ls, /pgdata\/raw/);
  assert.equal(restic(c, 'dump', 'latest', path.join(tmp, 'staging', 'pg.dump')).stdout, 'CREATE TABLE t\n');
  assert.ok(!fs.existsSync(path.join(tmp, 'staging')), 'the staging directory is gone');
  assert.equal(JSON.parse(restic(c, 'snapshots', '--json').stdout)[0].hostname, 'testbox');
  fs.rmSync(tmp, { recursive: true });
});

test('a failing dump fails the run and no snapshot is made', { skip: !haveRestic }, async () => {
  const { tmp, cfg, job, restic } = setup(), c = cfg();
  assert.equal((await job(c, 'echo ok')).result, 'ok');
  const rec = await job(c, 'echo "pg_dump: connection refused" >&2; exit 1');
  assert.equal(rec.result, 'failed');
  assert.match(rec.error, /connection refused/);
  assert.equal(JSON.parse(restic(c, 'snapshots', '--json').stdout).length, 1);
  assert.ok(!fs.existsSync(path.join(tmp, 'staging')));
  fs.rmSync(tmp, { recursive: true });
});

test('a wrong password is an error and never a new repository', { skip: !haveRestic }, async () => {
  const { tmp, cfg, job } = setup(), c = cfg();
  assert.equal((await job(c, 'echo ok')).result, 'ok');
  const rec = await job(cfg({ backup_password: 'other' }), 'echo ok');
  assert.equal(rec.result, 'failed');
  assert.match(rec.error, /opening the repository/);
  assert.doesNotMatch(rec.error, /other/);
  assert.equal(fs.readdirSync(path.join(tmp, 'repo', 'keys')).length, 1, 'no second key was added to the repository');
  fs.rmSync(tmp, { recursive: true });
});

test('a missing path makes the run partial, not failed', { skip: !haveRestic }, async () => {
  const { tmp, data, cfg, job } = setup();
  const rec = await job(cfg({ backup_paths: [data, '/nonexistent/path'] }), 'echo ok');
  assert.equal(rec.result, 'partial');
  assert.match(rec.warning, /missing paths/);
  assert.ok(rec.snapshot_id);
  fs.rmSync(tmp, { recursive: true });
});

test('forget keeps what the retention says', { skip: !haveRestic }, async () => {
  const { tmp, cfg, job, restic } = setup(), c = cfg({ backup_forget: true, backup_retention: { last: 2, daily: 0, weekly: 0, monthly: 0 } });
  for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(tmp, 'data', 'n'), String(i)); assert.equal((await job(c, 'echo ' + i)).result, 'ok'); }
  assert.equal(JSON.parse(restic(c, 'snapshots', '--json').stdout).length, 2);
  fs.rmSync(tmp, { recursive: true });
});
