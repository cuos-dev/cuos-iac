export const fmt = {
  date: ts => {
    if (!ts) return '—';
    const s = String(ts);
    const d = new Date(s.endsWith('Z') ? s : s + 'Z');
    return isNaN(d) ? s : d.toLocaleString();
  },
  pct: v => v != null ? `${Math.round(v)}%` : '—',
  uptime: s => {
    if (!s) return '—';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  },
  lastSeenClass: ts => {
    if (!ts) return 'dead';
    const age = (Date.now() - new Date(ts.endsWith('Z') ? ts : ts + 'Z')) / 1000;
    if (age < 300) return 'recent';
    if (age < 3600) return 'stale';
    return 'dead';
  },
};
