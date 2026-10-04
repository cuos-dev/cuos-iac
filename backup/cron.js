// SPDX-License-Identifier: Apache-2.0
// A small matcher for five field cron expressions (minute hour day-of-month month day-of-week):
// `*`, numbers, lists (1,2), ranges (1-5) and steps (*/5, 1-10/2). Names (mon, jan) and `@daily` style
// shortcuts are not supported on purpose. Day-of-month and day-of-week work like in cron: when both are
// restricted, either may match. Times are in the container's time zone (TZ).

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },   // 0 and 7 are Sunday
];

function parseField(text, { name, min, max }) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`invalid ${name}: "${part}"`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`invalid step in ${name}: "${part}"`);
    let lo, hi;
    if (m[1] === '*') { lo = min; hi = max === 7 ? 6 : max; }
    else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(Number); }
    else { lo = Number(m[1]); hi = m[2] === undefined ? lo : max; }
    if (lo < min || hi > max || lo > hi) throw new Error(`${name} out of range (${min}-${max}): "${part}"`);
    for (let v = lo; v <= hi; v += step) set.add(name === 'day of week' && v === 7 ? 0 : v);
  }
  return set;
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('cron expression must be a string');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron expression has five fields, got ${parts.length}: "${expr}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

export function matches(cron, d) {
  if (!cron.minute.has(d.getMinutes()) || !cron.hour.has(d.getHours()) || !cron.month.has(d.getMonth() + 1)) return false;
  const domOk = cron.dom.has(d.getDate()), dowOk = cron.dow.has(d.getDay());
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dowOk;
  if (cron.dowAny) return domOk;
  return domOk || dowOk;
}

// the first minute after `from` that matches; looks four years ahead (covers 29 February), then gives up
export function nextRun(cron, from = new Date()) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 4 * 366 * 24 * 60; i++) {
    if (matches(cron, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
