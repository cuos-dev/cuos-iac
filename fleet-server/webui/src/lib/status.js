// SPDX-License-Identifier: Apache-2.0
// iac_state comes from the device (iac/entrypoint.sh): running | updating | starting, anything
// else ("pull repo failed", "docker compose failed", ...) is a failure.
export function iacHealth(state) {
  if (!state) return 'unknown';
  if (state === 'running') return 'ok';
  if (state === 'updating' || state === 'starting') return 'busy';
  return 'error';
}

// A device needs attention when its last update failed or its IaC manager is in a failed state.
// (Offline is a separate state and has its own counter.)
export function hasProblem(d) {
  return d.status === 'error' || iacHealth(d.metrics?.app_state?.iac_state) === 'error' || ['error', 'overdue'].includes(backupHealth(d.metrics?.backup));
}

// The optional backup container's status, as the device shared it: none | busy | ok | warn (incomplete) | error | overdue.
// 'overdue' wins over a good last run: the device says a scheduled backup did not happen.
export function backupHealth(b) {
  if (!b) return 'none';
  if (b.state === 'running' || b.state === 'checking') return 'busy';
  if (b.last_run?.result === 'failed' || b.last_check?.ok === false) return 'error';
  if (b.overdue) return 'overdue';
  if (b.last_run?.result === 'partial') return 'warn';
  if (b.last_run?.result === 'ok') return 'ok';
  return 'none';
}

// a device (new, or a known one that lost its token) waiting for an administrator
export const hasRequest = d => !!d.enrollment?.request;
