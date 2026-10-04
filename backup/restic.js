// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { run } from './exec.js';
import { publicRepository } from './config.js';

// restic exit codes (0.17+): 3 = some files could not be read (the snapshot exists), 10 = no repository there, 11 = locked, 12 = wrong password
const NO_REPO = /Is there a repository at the following location\?|repository does not exist/;

// sftp:user@host:/path  or  sftp://user@host[:port]/path  ->  { user, host, port }
export function parseSftp(repository) {
  const m = repository.match(/^sftp:(?:\/\/)?(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?[:/]/);
  return m ? { user: m[1], host: m[2], port: m[3] } : null;
}

export class Restic {
  // opts.bin: the restic program; opts.stateDir: where the ssh key material goes (mode 600)
  constructor(cfg, { bin = 'restic', stateDir = '/tmp/restic-state' } = {}) {
    this.cfg = cfg; this.bin = bin; this.stateDir = stateDir;
    this.env = { ...process.env, ...cfg.extraEnv, RESTIC_REPOSITORY: cfg.repository, RESTIC_PASSWORD: cfg.password, RESTIC_CACHE_DIR: path.join(stateDir, 'cache') };
    this.extra = this.sftpOptions();
  }

  // a private key and the pinned host key, used with `-o sftp.command` so that ssh never asks and never trusts blindly
  sftpOptions() {
    const { cfg } = this;
    const sftp = parseSftp(cfg.repository);
    if (!sftp || !cfg.sshKey) return [];
    const dir = path.join(this.stateDir, 'ssh');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = path.join(dir, 'id'), hosts = path.join(dir, 'known_hosts');
    fs.writeFileSync(key, cfg.sshKey.endsWith('\n') ? cfg.sshKey : cfg.sshKey + '\n', { mode: 0o600 });
    fs.writeFileSync(hosts, cfg.knownHosts.endsWith('\n') ? cfg.knownHosts : cfg.knownHosts + '\n', { mode: 0o600 });
    const target = `${sftp.user ? sftp.user + '@' : ''}${sftp.host}`;
    const cmd = ['ssh', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${hosts}`, '-o', 'StrictHostKeyChecking=yes',
      ...(sftp.port ? ['-p', sftp.port] : []), target, '-s', 'sftp'].join(' ');
    return ['-o', `sftp.command=${cmd}`];
  }

  async exec(args, opts = {}) {
    return run(this.bin, [...this.extra, ...args], { env: this.env, ...opts });
  }

  // never leaks a password that is part of the repository URL
  scrub(text) {
    let t = String(text);
    if (this.cfg.password) t = t.split(this.cfg.password).join('***');
    return t.split(this.cfg.repository).join(publicRepository(this.cfg.repository)).trim();
  }

  fail(what, r) {
    return new Error(`${what} failed (exit ${r.code}): ${this.scrub(r.stderr || r.stdout).slice(-500)}`);
  }

  // makes sure there is a repository we can open; creates one only when there is none at all
  async ensureRepo() {
    const r = await this.exec(['cat', 'config']);
    if (r.code === 0) return 'present';
    if (r.code === 10 || NO_REPO.test(r.stderr)) {
      const i = await this.exec(['init']);
      if (i.code !== 0) throw this.fail('restic init', i);
      return 'created';
    }
    throw this.fail('opening the repository', r);   // wrong password, unreachable, locked ...: never "init" over it
  }

  async unlock() { await this.exec(['unlock']); }   // removes stale locks only

  // returns { code, summary }; code 3 means some files could not be read
  async backup(paths, { excludes = [], host }) {
    const args = ['backup', '--json', '--host', host, ...excludes.flatMap(e => ['--exclude', e]), ...paths];
    const r = await this.exec(args);
    if (r.code !== 0 && r.code !== 3) throw this.fail('restic backup', r);
    const summary = r.stdout.split('\n').reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).find(j => j?.message_type === 'summary') || null;
    return { code: r.code, summary, warning: r.code === 3 ? this.scrub(r.stderr).slice(-300) : null };
  }

  async forget(retention, host) {
    const keep = Object.entries(retention).filter(([, v]) => v > 0).flatMap(([k, v]) => [`--keep-${k}`, String(v)]);
    if (!keep.length) return;
    const r = await this.exec(['forget', '--prune', '--host', host, '--group-by', 'host', ...keep]);
    if (r.code !== 0) throw this.fail('restic forget', r);
  }

  async check() {
    const r = await this.exec(['check']);
    if (r.code !== 0) throw this.fail('restic check', r);
  }

  async snapshots(limit = 50) {
    const r = await this.exec(['snapshots', '--json']);
    if (r.code !== 0) throw this.fail('restic snapshots', r);
    const all = JSON.parse(r.stdout || '[]');
    return { count: all.length, list: all.slice(-limit).reverse().map(s => ({ id: s.short_id, time: s.time, host: s.hostname, paths: s.paths, tags: s.tags || [] })) };
  }
}
