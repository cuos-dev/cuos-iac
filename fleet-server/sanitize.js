// SPDX-License-Identifier: Apache-2.0
// Small helpers for what a device reports about itself. The same file lives in fleet-agent/clean.js (the agent cleans
// before it sends, the server cleans again on intake, because a protocol 1 agent cannot be changed). Keep both identical.

// A repository URL without credentials, query or fragment: `https://user:token@host/org/repo.git` -> `https://host/org/repo.git`.
// An scp-like address (`git@host:org/repo.git`) has no password in it and stays.
export function cleanRepoUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!s) return '';
  try {
    const x = new URL(s);
    x.username = ''; x.password = ''; x.search = ''; x.hash = '';
    return x.toString();
  } catch {
    return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1').replace(/[?#].*$/, '');
  }
}

// The version of an image reference, for a table cell: `ghcr.io/org/cuos-system:v0.6.1@sha256:ab…` -> `v0.6.1`,
// a reference with only a digest -> `sha256:` and 12 characters, a plain version stays as it is.
export function shortVersion(v) {
  if (typeof v !== 'string') return null;
  const first = v.trim().split(/\s+/)[0];
  if (!first) return null;
  const [ref, digest] = first.split('@');
  const last = ref.slice(ref.lastIndexOf('/') + 1);
  const colon = last.indexOf(':');
  if (colon >= 0) return last.slice(colon + 1).slice(0, 64) || null;
  if (digest) return digest.slice(0, 'sha256:'.length + 12);
  return last.slice(0, 64);
}

// The device's own address: the `src` of its default route, else the address of the interface that route leaves by,
// else the first one that is not loopback. (`default_route_ip` of the CuOS resources is the GATEWAY.)
export function primaryIp(r) {
  if (!r || typeof r !== 'object') return null;
  const routes = Array.isArray(r.routes) ? r.routes : [];
  const def = routes.find(x => typeof x === 'string' && /^default\b/.test(x));
  const src = def?.match(/\bsrc\s+(\S+)/)?.[1];
  if (src) return src;
  const dev = def?.match(/\bdev\s+(\S+)/)?.[1];
  const nets = (Array.isArray(r.network) ? r.network : []).filter(n => n && typeof n.ip === 'string' && n.ip);
  const pick = nets.find(n => n.interface === dev) || nets.find(n => !/^127\./.test(n.ip));
  return pick ? pick.ip.split('/')[0] : null;
}

// What the backup container reports (iac `backup:status`), reduced to what the fleet needs: when, whether it worked, how big.
// Strings are cut, numbers checked, anything else dropped. The error text may name a path or a host: the owner can leave the whole
// thing out with fleet_share.backup = false.
const BACKUP_RESULTS = ['ok', 'partial', 'failed'];
const BACKUP_STATES = ['idle', 'running', 'checking'];
export function cleanBackup(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const lr = b.last_run && typeof b.last_run === 'object' ? b.last_run : null;
  const lc = b.last_check && typeof b.last_check === 'object' ? b.last_check : null;
  if (!lr && !lc && !BACKUP_STATES.includes(b.state)) return null;
  return {
    state: BACKUP_STATES.includes(b.state) ? b.state : null,
    updated: str(b.updated, 32),
    overdue: b.overdue === true,
    snapshots: Number.isInteger(b.snapshots) && b.snapshots >= 0 ? b.snapshots : null,
    next_run: str(b.next_run, 32),
    last_run: lr ? {
      finished: str(lr.finished, 32), result: BACKUP_RESULTS.includes(lr.result) ? lr.result : null,
      seconds: num(lr.seconds), bytes: num(lr.bytes), data_added: num(lr.data_added),
      // dumps: a list from the backup container, a count once cleaned
      dumps: Array.isArray(lr.dumps) ? lr.dumps.length : Number.isInteger(lr.dumps) && lr.dumps >= 0 ? lr.dumps : null, error: str(lr.error, 200), warning: str(lr.warning, 200),
    } : null,
    last_check: lc ? { time: str(lc.time, 32), ok: lc.ok === true, error: str(lc.error, 200) } : null,
  };
}
