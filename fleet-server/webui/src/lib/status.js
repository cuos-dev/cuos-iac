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
  return d.status === 'error' || iacHealth(d.metrics?.app_state?.iac_state) === 'error';
}

// a device (new, or a known one that lost its token) waiting for an administrator
export const hasRequest = d => !!d.enrollment?.request;
