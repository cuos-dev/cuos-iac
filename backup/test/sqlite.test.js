// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { snapshotSqlite, sidecars } from '../sqlite.js';

const have = spawnSync('sqlite3', ['--version']).status === 0;
const sql = (db, q) => spawnSync('sqlite3', [db, q], { encoding: 'utf8' }).stdout.trim();

test('sidecars lists what a live database leaves next to itself', () => {
  assert.deepEqual(sidecars('/d/a.db'), ['/d/a.db', '/d/a.db-wal', '/d/a.db-shm', '/d/a.db-journal']);
});

test('a database is copied consistently, also while an application holds it open in WAL mode', { skip: !have }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-'));
  const db = path.join(tmp, 'app.db');
  // an application: one long-lived connection that keeps writing
  const app = spawn('sqlite3', [db], { stdio: ['pipe', 'ignore', 'ignore'] });
  app.stdin.write('PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);\n');
  const writer = setInterval(() => app.stdin.write("BEGIN; INSERT INTO t(v) VALUES (hex(randomblob(300))); INSERT INTO t(v) VALUES ('x'); COMMIT;\n"), 10);
  await new Promise(r => setTimeout(r, 600));
  const out = path.join(tmp, 'out');
  const r = await snapshotSqlite([db], out, {});
  clearInterval(writer); app.stdin.end();
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(r.done[0].path, db);
  assert.match(r.done[0].name, /^sqlite\/.*app\.db$/);
  const copy = path.join(out, r.done[0].name.replace('sqlite/', ''));
  assert.equal(sql(copy, 'PRAGMA integrity_check;'), 'ok');
  assert.ok(Number(sql(copy, 'select count(*) from t;')) > 0);
  assert.ok(!fs.readdirSync(out).some(f => f.endsWith('.part')));
  fs.rmSync(tmp, { recursive: true });
});

test('a missing file and a damaged file are reported per database, the others still work', { skip: !have }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-'));
  const good = path.join(tmp, 'good.db'), bad = path.join(tmp, 'bad.db'), gone = path.join(tmp, 'gone.db');
  sql(good, 'CREATE TABLE t(a); INSERT INTO t VALUES (1);');
  fs.writeFileSync(bad, 'this is not a database, but long enough to be read as one'.repeat(40));
  const r = await snapshotSqlite([gone, bad, good], path.join(tmp, 'out'), {});
  assert.deepEqual(r.done.map(d => d.path), [good]);
  assert.deepEqual(r.failed.map(f => f.path).sort(), [bad, gone].sort());
  assert.match(r.failed.find(f => f.path === gone).error, /does not exist/);
  assert.ok(!fs.readdirSync(path.join(tmp, 'out')).some(f => f.endsWith('.part')), 'no partial file is left behind');
  fs.rmSync(tmp, { recursive: true });
});

test('two databases with the same file name do not overwrite each other', { skip: !have }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-'));
  fs.mkdirSync(path.join(tmp, 'a')); fs.mkdirSync(path.join(tmp, 'b'));
  sql(path.join(tmp, 'a', 'data.db'), 'CREATE TABLE t(a); INSERT INTO t VALUES (1);');
  sql(path.join(tmp, 'b', 'data.db'), 'CREATE TABLE t(a); INSERT INTO t VALUES (2);');
  const r = await snapshotSqlite([path.join(tmp, 'a', 'data.db'), path.join(tmp, 'b', 'data.db')], path.join(tmp, 'out'), {});
  assert.equal(new Set(r.done.map(d => d.name)).size, 2);
  fs.rmSync(tmp, { recursive: true });
});
