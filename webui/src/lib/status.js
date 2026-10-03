// Docker `ps` Status strings, e.g. "Up 3 hours", "Up 5 minutes (unhealthy)",
// "Up 10 seconds (health: starting)", "Exited (0) 2 hours ago", "Restarting (1) 5 seconds ago".
// kind: ok = fine, warn = transitional, bad = needs attention, idle = not running, not an error.
export function containerStatus(statusStr = '') {
  const s = statusStr;
  if (s.startsWith('Up')) {
    if (s.includes('(Paused)'))          return { kind: 'warn', cls: 'badge-amber', label: 'paused',    icon: 'ti-player-pause' };
    if (s.includes('(unhealthy)'))       return { kind: 'bad',  cls: 'badge-red',   label: 'unhealthy', icon: 'ti-alert-triangle' };
    if (s.includes('(health: starting)')) return { kind: 'warn', cls: 'badge-amber', label: 'starting',  icon: 'ti-loader-2' };
    if (s.includes('(healthy)'))         return { kind: 'ok',   cls: 'badge-green', label: 'healthy',   icon: 'ti-circle-check' };
    return                                      { kind: 'ok',   cls: 'badge-green', label: 'running',   icon: 'ti-circle-filled' };
  }
  const exit = s.match(/^Exited \((\d+)\)/);
  // exit code 0 is a normal end (init/one-shot containers), not a failure
  if (exit) return exit[1] === '0'
    ? { kind: 'idle', cls: 'badge-gray', label: 'exited',              icon: 'ti-circle-check' }
    : { kind: 'bad',  cls: 'badge-red',  label: `exited (${exit[1]})`,  icon: 'ti-circle-x' };
  if (s.startsWith('Restarting')) return { kind: 'warn', cls: 'badge-amber', label: 'restarting', icon: 'ti-rotate-clockwise' };
  if (s.startsWith('Created'))    return { kind: 'idle', cls: 'badge-gray',  label: 'created',    icon: 'ti-circle-dashed' };
  if (s.startsWith('Removing'))   return { kind: 'warn', cls: 'badge-amber', label: 'removing',   icon: 'ti-loader-2' };
  if (s.startsWith('Dead'))       return { kind: 'bad',  cls: 'badge-red',   label: 'dead',       icon: 'ti-circle-x' };
  return { kind: 'idle', cls: 'badge-gray', label: s.split(' ')[0].toLowerCase() || 'unknown', icon: 'ti-circle-dashed' };
}

// `ps` only has "RunningFor" = age of the container, so uptime comes from the Status text
export function containerUptime(statusStr = '') {
  return statusStr.startsWith('Up') ? statusStr.replace(/^Up\s+/, '').replace(/\s*\(.*\)$/, '') : '';
}

export function summarize(ps = []) {
  const n = { ok: 0, warn: 0, bad: 0, idle: 0 };
  for (const c of ps) n[containerStatus(c.Status).kind]++;
  return n;
}

// iac_state is written by iac/entrypoint.sh: running | updating | starting, anything else
// ("pull repo failed", "verification failed", "docker compose failed", ...) is a failure.
export function iacHealth(iacState) {
  if (!iacState) return 'unknown';
  if (iacState === 'running') return 'ok';
  if (iacState === 'updating' || iacState === 'starting') return 'busy';
  return 'error';
}
