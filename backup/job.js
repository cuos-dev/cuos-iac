// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import { discover, takeDumps } from './dumps.js';
import { publicRepository } from './config.js';

const iso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const short = e => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 500);

// One backup run: dumps -> restic backup (data + dumps) -> forget. Returns the record that goes into the status.
//   result: 'ok' | 'partial' (the snapshot exists, some files were unreadable) | 'failed'
export async function backupJob({ cfg, restic, dockerBin, dockerEnv, stagingDir }) {
  const started = Date.now();
  const rec = { started: iso(), finished: null, result: 'failed', error: null, warning: null, dumps: [], snapshot_id: null, files_new: null, data_added: null, bytes: null, seconds: null };
  fs.rmSync(stagingDir, { recursive: true, force: true });
  try {
    await restic.ensureRepo();
    await restic.unlock();
    const { dumps, excludes } = await discover(dockerBin, dockerEnv);
    rec.dumps = await takeDumps(dumps, stagingDir, { dockerBin, env: dockerEnv, timeoutSec: cfg.dumpTimeout });
    const paths = [...cfg.paths.filter(p => fs.existsSync(p)), ...(rec.dumps.length ? [stagingDir] : [])];
    const missing = cfg.paths.filter(p => !fs.existsSync(p));
    if (!paths.length) throw new Error(`none of backup_paths exists: ${cfg.paths.join(', ')}`);
    const b = await restic.backup(paths, { excludes: [...cfg.exclude, ...excludes], host: cfg.hostname });
    rec.snapshot_id = b.summary?.snapshot_id?.slice(0, 8) ?? null;
    rec.files_new = b.summary?.files_new ?? null;
    rec.data_added = b.summary?.data_added ?? null;
    rec.bytes = b.summary?.total_bytes_processed ?? null;
    rec.warning = [missing.length ? `missing paths: ${missing.join(', ')}` : '', b.warning || ''].filter(Boolean).join('; ') || null;
    rec.result = b.code === 3 || missing.length ? 'partial' : 'ok';
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
