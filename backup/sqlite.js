// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { run } from './exec.js';

// Consistent copies of SQLite databases that are in use, taken with SQLite's own backup (`.backup`) through a
// READ-ONLY connection, so the backup container may mount the data read-only and the application never notices.
// - A database in rollback-journal mode can always be read this way.
// - A database in WAL mode needs its -wal and -shm files to exist (they do while the application has it open);
//   on a read-only mount a closed database in WAL mode cannot be opened, and that is reported, not hidden.
// The copy is checked (`PRAGMA quick_check`) before it counts.

const nameFor = p => p.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\/+/g, '__').slice(0, 150) || 'db';
const SAFE = /^[A-Za-z0-9._\/-]+$/;   // what may appear in the destination path we hand to the sqlite3 shell

// the files a live database leaves next to itself; restic should not take them as they are when the snapshot exists
export const sidecars = p => [p, `${p}-wal`, `${p}-shm`, `${p}-journal`];

// Returns { done: [{ path, name, bytes, seconds }], failed: [{ path, error }] }. Never throws for one bad database.
export async function snapshotSqlite(paths, dir, { sqliteBin = 'sqlite3', env, timeoutSec = 600 } = {}) {
  const done = [], failed = [];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const used = new Set();
  for (const p of paths) {
    const started = Date.now();
    let tmp = null;
    try {
      if (!fs.existsSync(p)) throw new Error('the file does not exist');
      let name = nameFor(p); while (used.has(name)) name += '_'; used.add(name);
      const final = path.join(dir, name); tmp = final + '.part';
      if (!SAFE.test(tmp)) throw new Error('the staging path has unusual characters');
      fs.rmSync(tmp, { force: true });
      const b = await run(sqliteBin, ['-readonly', p, '.timeout 30000', `.backup '${tmp}'`], { env, timeoutMs: timeoutSec * 1000 });
      if (b.code !== 0) throw new Error((b.timedOut ? 'timed out' : b.stderr.trim() || `exit ${b.code}`).slice(0, 300));
      const c = await run(sqliteBin, [tmp, 'PRAGMA quick_check;'], { env, timeoutMs: 120000 });
      if (c.code !== 0 || c.stdout.trim() !== 'ok') throw new Error(`the copy is not sound: ${(c.stdout || c.stderr).trim().slice(0, 200)}`);
      fs.renameSync(tmp, final);
      done.push({ path: p, name: `sqlite/${name}`, bytes: fs.statSync(final).size, seconds: Math.round((Date.now() - started) / 100) / 10 });
    } catch (e) {
      if (tmp) fs.rmSync(tmp, { force: true });
      failed.push({ path: p, error: String(e.message ?? e) });
    }
  }
  return { done, failed };
}
