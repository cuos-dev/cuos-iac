// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { run } from './exec.js';

export const LABEL = 'cuos.backup.dump';
const NAME_OK = /^[A-Za-z0-9._-]{1,100}$/;

// Containers that say how to dump themselves, with these labels (in their compose definition):
//   cuos.backup.dump         the command, run with `sh -c` inside the container; its stdout is the dump
//   cuos.backup.dump.name    file name of the dump (default <service>.dump)
//   cuos.backup.exclude      restic exclude patterns (comma or newline separated), for the database's own files
export function parseLabels(entries) {
  const dumps = [], excludes = [], seen = new Set();
  for (const { container, labels = {} } of entries) {
    const cmd = labels[LABEL];
    if (!cmd) continue;
    const service = labels['com.docker.compose.service'] || container.replace(/^\//, '');
    const name = labels['cuos.backup.dump.name'] || `${service}.dump`;
    if (!NAME_OK.test(name) || name === '.' || name === '..') throw new Error(`${container}: invalid dump name "${name}"`);
    if (seen.has(name)) throw new Error(`two containers dump to "${name}" (set cuos.backup.dump.name)`);
    seen.add(name);
    dumps.push({ container: container.replace(/^\//, ''), name, command: cmd });
    for (const p of String(labels['cuos.backup.exclude'] || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean)) excludes.push(p);
  }
  return { dumps, excludes };
}

// asks docker which running containers carry the dump label
export async function discover(dockerBin, env) {
  const ps = await run(dockerBin, ['ps', '--filter', `label=${LABEL}`, '--format', '{{.ID}}'], { env });
  if (ps.code !== 0) throw new Error(`docker ps failed: ${ps.stderr.trim().slice(0, 300)}`);
  const ids = ps.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return { dumps: [], excludes: [] };
  const insp = await run(dockerBin, ['inspect', '--format', '{{.Name}}\t{{json .Config.Labels}}', ...ids], { env });
  if (insp.code !== 0) throw new Error(`docker inspect failed: ${insp.stderr.trim().slice(0, 300)}`);
  const entries = insp.stdout.split('\n').filter(Boolean).map(line => {
    const i = line.indexOf('\t');
    return { container: line.slice(0, i), labels: JSON.parse(line.slice(i + 1)) || {} };
  });
  return parseLabels(entries);
}

// Runs every dump into `dir`. A dump that fails, times out or is empty fails the whole run:
// a backup that silently contains no database is worse than none. Files appear under their final name only when complete.
export async function takeDumps(dumps, dir, { dockerBin, env, timeoutSec }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const results = [];
  for (const d of dumps) {
    const started = Date.now(), final = path.join(dir, d.name), tmp = final + '.part';
    const r = await run(dockerBin, ['exec', d.container, 'sh', '-c', d.command], { env, timeoutMs: timeoutSec * 1000, stdoutFile: tmp });
    if (r.code !== 0 || r.bytes === 0) {
      fs.rmSync(tmp, { force: true });
      const why = r.timedOut ? `timed out after ${timeoutSec}s` : r.code !== 0 ? `exit ${r.code}: ${r.stderr.trim().slice(-300)}` : 'the dump is empty';
      throw new Error(`dump ${d.name} (${d.container}) failed: ${why}`);
    }
    fs.renameSync(tmp, final);
    results.push({ name: d.name, container: d.container, bytes: r.bytes, seconds: Math.round((Date.now() - started) / 100) / 10 });
  }
  return results;
}
