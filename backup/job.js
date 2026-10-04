// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { discover, takeDumps } from './dumps.js';
import { snapshotSqlite, sidecars } from './sqlite.js';
import { publicRepository } from './config.js';

const iso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const short = e => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 500);

// One backup run: dumps -> restic backup (data + dumps) -> forget. Returns the record that goes into the status.
//   result: 'ok' | 'partial' (the snapshot exists, some files were unreadable) | 'failed'
export async function backupJob({ cfg, restic, dockerBin, dockerEnv, stagingDir, sqliteBin = 'sqlite3' }) {
  const started = Date.now();
  const rec = { started: iso(), finished: null, result: 'failed', error: null, warning: null, dumps: [], snapshot_id: null, files_new: null, data_added: null, bytes: null, seconds: null };
  fs.rmSync(stagingDir, { recursive: true, force: true });
  try {
    await restic.ensureRepo();
    await restic.unlock();
    const { dumps, excludes } = await discover(dockerBin, dockerEnv);
    rec.dumps = await takeDumps(dumps, stagingDir, { dockerBin, env: dockerEnv, timeoutSec: cfg.dumpTimeout });
    // SQLite files that are in use: a consistent copy instead of the live file. When the copy fails the file stays in the
    // backup as it is (better than nothing) and the run is only 'partial'.
    const lite = cfg.sqlite.length ? await snapshotSqlite(cfg.sqlite, path.join(stagingDir, 'sqlite'), { sqliteBin, env: dockerEnv }) : { done: [], failed: [] };
    rec.dumps.push(...lite.done.map(d => ({ name: d.name, container: null, bytes: d.bytes, seconds: d.seconds })));
    const liteExcludes = lite.done.flatMap(d => sidecars(d.path));
    const liteWarning = lite.failed.map(f => `sqlite ${f.path}: ${f.error}`).join('; ');
    const paths = [...cfg.paths.filter(p => fs.existsSync(p)), ...(rec.dumps.length ? [stagingDir] : [])];
    const missing = cfg.paths.filter(p => !fs.existsSync(p));
    if (!paths.length) throw new Error(`none of backup_paths exists: ${cfg.paths.join(', ')}`);
    const b = await restic.backup(paths, { excludes: [...cfg.exclude, ...excludes, ...liteExcludes], host: cfg.hostname });
    rec.snapshot_id = b.summary?.snapshot_id?.slice(0, 8) ?? null;
    rec.files_new = b.summary?.files_new ?? null;
    rec.data_added = b.summary?.data_added ?? null;
    rec.bytes = b.summary?.total_bytes_processed ?? null;
    rec.warning = [missing.length ? `missing paths: ${missing.join(', ')}` : '', liteWarning, b.warning || ''].filter(Boolean).join('; ') || null;
    rec.result = b.code === 3 || missing.length || lite.failed.length ? 'partial' : 'ok';
    if (cfg.forget) {
      try { await restic.forget(cfg.retention, cfg.hostname); }
      catch (e) { rec.warning = [rec.warning, short(e)].filter(Boolean).join('; '); rec.result = 'partial'; }   // the data is safe, the old snapshots stay
    }
  } catch (e) {
    rec.error = short(e);
    rec.result = 'failed';
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    rec.finished = iso();
    rec.seconds = Math.round((Date.now() - started) / 100) / 10;
  }
  return rec;
}

export const describeRepository = publicRepository;
