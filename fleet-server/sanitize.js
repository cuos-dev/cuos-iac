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
