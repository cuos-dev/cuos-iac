// SPDX-License-Identifier: Apache-2.0
// Dev only: a week of load history for the fake agents, so the 24h and 7d charts have something to show.
// Runs once after the server has created its database.
import Database from 'better-sqlite3';
import path from 'path';

const file = path.join(process.env.FLEET_DATA_DIR, 'fleet.db');
const COUNT = Number(process.env.FAKE_AGENTS) || 18;
const rnd = seed => { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); };

await new Promise(r => setTimeout(r, 2500));                   // let the server create the tables
const db = new Database(file); db.pragma('busy_timeout = 5000');
const ins = db.prepare('INSERT OR REPLACE INTO samples (device_id, ts, cpu, ram, disk, mem_used, disk_used) VALUES (?, ?, ?, ?, ?, ?, ?)');
const now = Math.floor(Date.now() / 1000), step = 300;
db.transaction(() => {
  for (let i = 0; i < COUNT; i++) {
    const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, r = rnd(i + 7);
    const base = { cpu: 8 + r() * 60, ram: 30 + r() * 55, disk: 20 + r() * 65 }, ph = r() * 6.28;
    for (let t = now - 7 * 86400; t < now - 120; t += step) {
      const day = Math.sin((t / 86400) * 6.28 + ph), cl = v => Math.max(1, Math.min(99, v));
      ins.run(id, t, cl(base.cpu + 18 * day + (r() - 0.5) * 12), cl(base.ram + 4 * day + (r() - 0.5) * 3), cl(base.disk + (t - (now - 7 * 86400)) / 86400 * 0.3), 0, 0);
    }
  }
})();
console.log(`[seed] ${COUNT} devices x 7 days of samples`);
