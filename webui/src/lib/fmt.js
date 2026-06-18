let locale = 'de-DE', tz = 'Europe/Berlin';
export function setFmtConfig(cfg) { locale = cfg.locale; tz = cfg.tz; }
export function fmt(ts) {
  if (!ts) return '—';
  const s = String(ts);
  const d = new Date(s.endsWith('Z') ? s : s + 'Z');
  return isNaN(d) ? s : d.toLocaleString(locale, { timeZone: tz });
}
