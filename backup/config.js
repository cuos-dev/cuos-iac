// SPDX-License-Identifier: Apache-2.0
import { parseCron } from './cron.js';

const CHECK_WORDS = { daily: '0 5 * * *', weekly: '0 5 * * 0', monthly: '0 5 1 * *' };
const DEFAULT_RETENTION = { daily: 7, weekly: 4, monthly: 6 };
const KEEP_KEYS = ['last', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'];
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const list = (v, what) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x)) throw new Error(`${what} must be a list of strings`);
  return v;
};

// Turns the device's system.json into what the agent needs, and says what is wrong with it.
// Throws an Error with a message for the owner; secrets never appear in a message.
export function loadConfig(sys = {}, env = process.env) {
  const repository = sys.backup_repository || env.BACKUP_REPOSITORY;
  if (!repository || typeof repository !== 'string') throw new Error('backup_repository is not set');
  const password = sys.backup_password || env.BACKUP_PASSWORD;
  if (!password || typeof password !== 'string') throw new Error('backup_password is not set');

  const schedule = sys.backup_schedule ?? '0 3 * * *';
  parseCron(schedule);

  let check = sys.backup_check ?? 'weekly';
  if (check === false || check === 'off') check = null;
  else {
    check = CHECK_WORDS[check] ?? check;
    parseCron(check);
  }

  const paths = list(sys.backup_paths, 'backup_paths') ?? ['/data'];
  for (const p of paths) if (!p.startsWith('/')) throw new Error(`backup_paths must be absolute: "${p}"`);
  const exclude = list(sys.backup_exclude, 'backup_exclude') ?? [];

  const retention = { ...DEFAULT_RETENTION, ...(sys.backup_retention || {}) };
  for (const [k, v] of Object.entries(retention)) {
    if (!KEEP_KEYS.includes(k)) throw new Error(`backup_retention: unknown key "${k}"`);
    if (!Number.isInteger(v) || v < 0) throw new Error(`backup_retention.${k} must be a whole number, 0 or more`);
  }
  const forget = sys.backup_forget !== false;
  if (forget && !Object.values(retention).some(v => v > 0)) throw new Error('backup_retention keeps nothing: refusing to forget every snapshot');

  const extraEnv = {};
  for (const [k, v] of Object.entries(sys.backup_env || {})) {
    if (!ENV_NAME.test(k) || /^(RESTIC_PASSWORD|RESTIC_REPOSITORY|PATH|LD_PRELOAD)/.test(k)) throw new Error(`backup_env: "${k}" is not allowed`);
    if (typeof v !== 'string') throw new Error(`backup_env.${k} must be a string`);
    extraEnv[k] = v;
  }

  const sshKey = sys.backup_ssh_key, knownHosts = sys.backup_known_hosts;
  if (/^sftp:/.test(repository) && (sshKey || knownHosts) && !(sshKey && knownHosts)) throw new Error('an sftp target with a key needs backup_known_hosts as well (the host key is always checked)');

  const dumpTimeout = sys.backup_dump_timeout_sec ?? 3600;
  if (!Number.isInteger(dumpTimeout) || dumpTimeout < 1) throw new Error('backup_dump_timeout_sec must be a positive whole number');

  return {
    repository, password, schedule, check, paths, exclude, retention, forget, extraEnv, sshKey, knownHosts, dumpTimeout,
    pingUrl: sys.backup_ping_url || null, pingFailUrl: sys.backup_ping_fail_url || null,
    hostname: String(sys.hostname || sys.system_name || 'cuos').slice(0, 64),
  };
}

// the repository for display: no password inside a URL
export function publicRepository(repository) {
  return String(repository).replace(/(:\/\/[^/:@]+):[^@/]*@/, '$1@');
}
