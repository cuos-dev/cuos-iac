// SPDX-License-Identifier: Apache-2.0
// Time series and device logs.
//
// Every method is async on purpose: a MariaDB or PostgreSQL implementation can replace this file without
// server.js noticing. (Devices, enrolment and update events still use SQLite statements in server.js
// directly; moving those would be the rest of such a migration.)

const like = s => '%' + String(s).replace(/[\\%_]/g, c => '\\' + c) + '%';
const iso = ms => new Date(ms).toISOString();

export function createStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      device_id TEXT NOT NULL, ts INTEGER NOT NULL,
      cpu REAL, ram REAL, disk REAL, mem_used REAL, disk_used REAL,
      PRIMARY KEY (device_id, ts)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, ts INTEGER NOT NULL,
      source TEXT NOT NULL, unit TEXT, priority INTEGER, message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_device ON logs(device_id, id);
    DROP TABLE IF EXISTS metrics_history;     -- replaced by samples (the old table held a JSON copy per message)
  `);

  const insSample = db.prepare(`INSERT OR REPLACE INTO samples (device_id, ts, cpu, ram, disk, mem_used, disk_used) VALUES (@id, @ts, @cpu, @ram, @disk, @memUsed, @diskUsed)`);
  // integer division on purpose: a JS number is bound as REAL, and plain ts / @step would not bucket at all
  const series = db.prepare(`SELECT (ts / CAST(@step AS INTEGER)) * CAST(@step AS INTEGER) AS t, AVG(cpu) AS cpu, AVG(ram) AS ram, AVG(disk) AS disk FROM samples WHERE device_id=@id AND ts BETWEEN @from AND @to GROUP BY t ORDER BY t`);
  const insLog = db.prepare(`INSERT INTO logs (device_id, ts, source, unit, priority, message) VALUES (@id, @ts, @source, @unit, @priority, @message)`);
  const insMany = db.transaction((id, rows) => rows.map(r => ({ ...r, id: undefined, rowid: Number(insLog.run({ id, ts: r.ts, source: r.source, unit: r.unit, priority: r.priority, message: r.message }).lastInsertRowid) })));
  const lastLog = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM logs WHERE device_id=?`);

  const publicLog = (r, ts = r.ts) => ({ id: r.id ?? r.rowid, time: iso(ts), source: r.source, unit: r.unit, priority: r.priority, message: r.message });

  return {
    // one point of load data; a second one in the same second replaces the first
    async addSample(id, tsSec, v) {
      insSample.run({ id, ts: tsSec, cpu: v.cpu ?? null, ram: v.ram ?? null, disk: v.disk ?? null, memUsed: v.memUsed ?? null, diskUsed: v.diskUsed ?? null });
    },
    // averaged into buckets of `stepSec`: [{ t, cpu, ram, disk }]
    async series(id, fromSec, toSec, stepSec) {
      return series.all({ id, from: fromSec, to: toSec, step: stepSec });
    },

    // rows: [{ ts (ms), source, unit, priority, message }] -> the stored rows with their ids
    async addLogs(id, rows) {
      return insMany(id, rows).map(r => publicLog(r));
    },
    // newest `limit` lines matching the filter, oldest first. filter: { q, source, maxPriority, afterId }
    async queryLogs(id, { limit = 100, q, source, maxPriority, afterId } = {}) {
      const where = ['device_id = @id'], p = { id, limit: Math.min(Math.max(Number(limit) || 100, 1), 1000) };
      if (source) { where.push('source = @source'); p.source = source; }
      if (Number.isInteger(maxPriority)) { where.push('priority <= @maxPriority'); p.maxPriority = maxPriority; }
      if (q) { where.push(`(message LIKE @q ESCAPE '\\' OR unit LIKE @q ESCAPE '\\')`); p.q = like(q); }
      if (afterId) { where.push('id > @afterId'); p.afterId = afterId; }
      const rows = db.prepare(`SELECT id, ts, source, unit, priority, message FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT @limit`).all(p);
      return rows.reverse().map(r => publicLog(r));
    },
    async lastLogId(id) { return lastLog.get(id).id; },

    // retention; call now and then
    async prune({ sampleDays, logDays, maxLogRows }) {
      const now = Date.now();
      db.prepare('DELETE FROM samples WHERE ts < ?').run(Math.floor(now / 1000) - sampleDays * 86400);
      db.prepare('DELETE FROM logs WHERE ts < ?').run(now - logDays * 86400_000);
      for (const { device_id } of db.prepare('SELECT device_id FROM logs GROUP BY device_id HAVING COUNT(*) > ?').all(maxLogRows)) {
        db.prepare('DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE device_id=? ORDER BY id DESC LIMIT -1 OFFSET ?)').run(device_id, maxLogRows);
      }
    },
    // everything stored about a device
    async deleteDevice(id) {
      db.prepare('DELETE FROM samples WHERE device_id=?').run(id);
      db.prepare('DELETE FROM logs WHERE device_id=?').run(id);
    },
  };
}
