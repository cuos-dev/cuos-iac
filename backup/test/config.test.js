// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicRepository } from '../config.js';

const base = { backup_repository: '/srv/restic', backup_password: 'pw' };

test('defaults', () => {
  const c = loadConfig(base, {});
  assert.equal(c.schedule, '0 3 * * *');
  assert.deepEqual(c.paths, ['/data']);
  assert.deepEqual(c.retention, { daily: 7, weekly: 4, monthly: 6 });
  assert.equal(c.check, '0 5 * * 0');
  assert.equal(c.forget, true);
});

test('the repository and the password are required, with messages that do not contain the secret', () => {
  assert.throws(() => loadConfig({}, {}), /backup_repository is not set/);
  assert.throws(() => loadConfig({ backup_repository: '/x' }, {}), /backup_password is not set/);
  assert.equal(loadConfig({}, { BACKUP_REPOSITORY: '/x', BACKUP_PASSWORD: 'p' }).repository, '/x');
});

test('check: words, a cron expression, or off', () => {
  assert.equal(loadConfig({ ...base, backup_check: 'daily' }, {}).check, '0 5 * * *');
  assert.equal(loadConfig({ ...base, backup_check: '15 4 * * 6' }, {}).check, '15 4 * * 6');
  assert.equal(loadConfig({ ...base, backup_check: 'off' }, {}).check, null);
  assert.throws(() => loadConfig({ ...base, backup_check: 'sometimes' }, {}));
});

test('backup_sqlite: absolute paths only', () => {
  assert.deepEqual(loadConfig({ ...base, backup_sqlite: ['/src/a.db'] }, {}).sqlite, ['/src/a.db']);
  assert.deepEqual(loadConfig(base, {}).sqlite, []);
  assert.throws(() => loadConfig({ ...base, backup_sqlite: ['a.db'] }, {}), /absolute/);
});

test('bad values are refused', () => {
  assert.throws(() => loadConfig({ ...base, backup_schedule: 'nope' }, {}));
  assert.throws(() => loadConfig({ ...base, backup_paths: ['relative'] }, {}), /absolute/);
  assert.throws(() => loadConfig({ ...base, backup_paths: 'x' }, {}), /list of strings/);
  assert.throws(() => loadConfig({ ...base, backup_retention: { daily: -1 } }, {}), /whole number/);
  assert.throws(() => loadConfig({ ...base, backup_retention: { fortnightly: 2 } }, {}), /unknown key/);
  assert.throws(() => loadConfig({ ...base, backup_env: { RESTIC_PASSWORD: 'x' } }, {}), /not allowed/);
  assert.throws(() => loadConfig({ ...base, backup_env: { lower: 'x' } }, {}), /not allowed/);
});

test('retention that keeps nothing is refused unless this device does not forget', () => {
  assert.throws(() => loadConfig({ ...base, backup_retention: { daily: 0, weekly: 0, monthly: 0 } }, {}), /keeps nothing/);
  assert.equal(loadConfig({ ...base, backup_forget: false, backup_retention: { daily: 0, weekly: 0, monthly: 0 } }, {}).forget, false);
});

test('an sftp key needs the pinned host key', () => {
  assert.throws(() => loadConfig({ backup_repository: 'sftp:u@h:/r', backup_password: 'p', backup_ssh_key: 'KEY' }, {}), /known_hosts/);
  assert.ok(loadConfig({ backup_repository: 'sftp:u@h:/r', backup_password: 'p', backup_ssh_key: 'KEY', backup_known_hosts: 'h ssh-ed25519 AAAA' }, {}));
});

test('a password inside the repository URL is not shown', () => {
  assert.equal(publicRepository('rest:https://user:secret@host:8000/repo'), 'rest:https://user@host:8000/repo');
  assert.equal(publicRepository('sftp:u@h:/r'), 'sftp:u@h:/r');
  assert.equal(publicRepository('/srv/restic'), '/srv/restic');
});
