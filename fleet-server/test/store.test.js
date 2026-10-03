import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createStore } from '../store.js';

test('store: samples, logs, filters, retention and erasure', async () => {
  const db = new Database(':memory:'); db.exec('CREATE TABLE metrics_history (x)');
  const st = createStore(db);
assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='metrics_history'").get(), undefined, 'old history table is dropped');

// samples: bucket averages, a second sample in the same second replaces the first
const t0 = Math.floor(1_700_000_000 / 3600) * 3600;   // on the hour, so two hours are two buckets
for (let i = 0; i < 120; i++) await st.addSample('a', t0 + i * 60, { cpu: i % 2 ? 20 : 40, ram: 50, disk: 10 });
await st.addSample('a', t0, { cpu: 40, ram: 50, disk: 10 });
const s = await st.series('a', t0, t0 + 7200, 3600);
assert.equal(s.length, 2); assert.equal(Math.round(s[0].cpu), 30); assert.equal(s[0].t % 3600, 0);
assert.equal((await st.series('b', t0, t0 + 7200, 60)).length, 0, 'other devices are separate');

// logs
const now = Date.now();
const rows = [
  { ts: now - 5000, source: 'iac', unit: 'cuos-iac', priority: 6, message: 'Info: repo is up to date.' },
  { ts: now - 4000, source: 'iac', unit: 'cuos-iac', priority: 3, message: 'Error: compose failed 100% of the time' },
  { ts: now - 3000, source: 'system', unit: 'sshd.service', priority: 4, message: 'Failed password for root' },
  { ts: now - 2000, source: 'system', unit: 'docker.service', priority: 6, message: 'under_score and %percent' },
];
const ins = await st.addLogs('a', rows); assert.deepEqual(ins.map(r => r.id), [1, 2, 3, 4]); assert.ok(ins[0].time.endsWith('Z'));
await st.addLogs('b', [{ ts: now, source: 'iac', unit: 'x', priority: 6, message: 'other device' }]);
const all = await st.queryLogs('a'); assert.equal(all.length, 4); assert.equal(all[0].message, rows[0].message, 'oldest first');
assert.equal((await st.queryLogs('a', { limit: 2 })).map(r => r.id).join(), '3,4', 'the newest ones, oldest first');
assert.equal((await st.queryLogs('a', { source: 'system' })).length, 2);
assert.equal((await st.queryLogs('a', { maxPriority: 4 })).length, 2);
assert.equal((await st.queryLogs('a', { q: 'FAILED PASS' })).length, 1, 'case-insensitive');
assert.equal((await st.queryLogs('a', { q: 'sshd' })).length, 1, 'matches the unit too');
assert.equal((await st.queryLogs('a', { q: '%' })).length, 2, 'a % is a literal, not a wildcard');     // "100%" and "%percent"
assert.equal((await st.queryLogs('a', { q: '_' })).length, 1, 'a _ is a literal');
assert.equal((await st.queryLogs('a', { q: "'; DROP TABLE logs; --" })).length, 0); assert.equal((await st.queryLogs('a')).length, 4);
assert.equal((await st.queryLogs('a', { afterId: 2 })).length, 2);
assert.equal(await st.lastLogId('a'), 4);

// retention
await st.addLogs('c', Array.from({ length: 30 }, (_, i) => ({ ts: now - i, source: 'iac', unit: 'u', priority: 6, message: 'm' + i })));
await st.addLogs('a', [{ ts: now - 10 * 86400_000, source: 'iac', unit: 'old', priority: 6, message: 'ancient' }]);
await st.addSample('a', Math.floor(now / 1000) - 40 * 86400, { cpu: 1 });
await st.prune({ sampleDays: 30, logDays: 7, maxLogRows: 10 });
assert.equal((await st.queryLogs('a', { q: 'ancient' })).length, 0, 'old lines go');
assert.equal((await st.queryLogs('c', { limit: 1000 })).length, 10, 'per-device cap keeps the newest 10');
// the cap keeps the most recently arrived rows (by id), which is arrival order
assert.equal((await st.queryLogs('c', { limit: 1000 }))[0].message, 'm20'); assert.equal((await st.queryLogs('c', { limit: 1000 })).at(-1).message, 'm29');
assert.equal((await st.queryLogs('a', { limit: 1000 })).length, 4, 'other devices untouched');
assert.equal(db.prepare('SELECT COUNT(*) c FROM samples WHERE ts < ?').get(Math.floor(now / 1000) - 30 * 86400).c, 0);

// erase
await st.deleteDevice('a');
assert.equal((await st.queryLogs('a')).length, 0); assert.equal((await st.series('a', 0, 2e9, 60)).length, 0);
assert.equal((await st.queryLogs('b')).length, 1, 'only that device');
});
