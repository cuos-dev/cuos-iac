// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect } from 'preact/hooks';
import { fmt } from '../../lib/fmt.js';

// What the optional backup container reports (it publishes through the IaC container). Everyone can see
// whether the last backup worked; an administrator can start one and look at the snapshots.
const STALE_MS = 15 * 60_000;     // the container re-publishes every 5 minutes
const RESULT = {
  ok:      ['badge-green', 'ok'],
  partial: ['badge-amber', 'incomplete'],
  failed:  ['badge-red',   'failed'],
};

function size(bytes) {
  if (bytes == null) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = Number(bytes);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export default function BackupCard({ backup = {}, sendAction, canAct }) {
  const [busy, setBusy]   = useState(false);
  const [msg, setMsg]     = useState(null);
  const [snaps, setSnaps] = useState(null);
  const [now, setNow]     = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  const last = backup.last_run, chk = backup.last_check;
  const running = backup.state === 'running' || backup.state === 'checking';
  const silent = backup.updated && now - Date.parse(backup.updated) > STALE_MS;
  const [cls, label] = running ? ['badge-amber', backup.state === 'checking' ? 'checking…' : 'running…']
    : silent ? ['badge-gray', 'not reporting']
    : last ? (RESULT[last.result] ?? ['badge-gray', last.result])
    : ['badge-gray', 'no backup yet'];

  async function act(command, after) {
    setBusy(true); setMsg(null);
    try {
      const r = await sendAction(command);
      const res = r?.result;
      const err = r?.error ?? res?.error;
      if (err) setMsg(String(err)); else after?.(res);
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }
  const runNow = () => act('backup:run', () => setMsg('Backup started'));
  const listSnaps = () => act('backup:snapshots', res => setSnaps(res));

  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-database-export" /> Backup</div>
        <span class={`badge ${cls}`}>{label}</span>
      </div>
      <div class="card-body" style="padding:14px 18px;">
        <Row k="Last backup" v={last?.finished ? fmt(last.finished) : null} />
        <Row k="Took" v={last?.seconds != null ? `${last.seconds} s` : null} />
        <Row k="Data" v={last?.bytes != null ? `${size(last.bytes)} (${size(last.data_added) ?? '0 B'} new)` : null} />
        <Row k="Snapshots" v={backup.snapshots != null ? String(backup.snapshots) : null} />
        <Row k="Next backup" v={backup.next_run ? fmt(backup.next_run) : null} />
        <Row k="Last check" v={chk ? `${fmt(chk.time)} · ${chk.ok ? 'ok' : 'failed'}` : null} />
        <Row k="Repository" v={backup.repository} />

        {silent && <Note kind="warn">The backup container has not reported for {Math.max(1, Math.round((now - Date.parse(backup.updated)) / 60000))} min. It may not be running.</Note>}
        {backup.overdue && !silent && <Note kind="warn">A scheduled backup is overdue.</Note>}
        {last?.error && <Note kind="err">{last.error}</Note>}
        {last?.warning && <Note kind="warn">{last.warning}</Note>}
        {backup.last_check && !backup.last_check.ok && backup.last_check.error && <Note kind="err">Check: {backup.last_check.error}</Note>}

        {Array.isArray(last?.dumps) && last.dumps.length > 0 && (
          <>
            <div class="fleet-share-title">Database dumps</div>
            <ul class="fleet-shares">
              {last.dumps.map(d => <li key={d.name} class="share-on"><i class="ti ti-check" /> <span>{d.name}</span><span class="fleet-note-text"> · {size(d.bytes)}</span></li>)}
            </ul>
          </>
        )}

        {canAct && (
          <div class="backup-actions">
            <button class="btn-sm" disabled={busy || running} onClick={runNow}><i class={`ti ${busy ? 'ti-loader-2 spin' : 'ti-player-play'}`} /> Back up now</button>
            <button class="btn-sm" disabled={busy} onClick={listSnaps}><i class="ti ti-list" /> Snapshots</button>
          </div>
        )}
        {msg && <div class="action-result">{msg}</div>}
        {snaps?.list && (
          <div class="backup-snaps">
            {snaps.list.length === 0 && <div class="fleet-hint">No snapshots yet.</div>}
            {snaps.list.map(s => <div key={s.id} class="backup-snap"><code>{s.id}</code> <span>{fmt(s.time)}</span></div>)}
            {snaps.count > snaps.list.length && <div class="fleet-hint">… and {snaps.count - snaps.list.length} older.</div>}
          </div>
        )}
        <div class="fleet-hint">Configured in <code>system.json</code> (<code>backup_*</code>). Restoring is done by hand, see the backup README.</div>
      </div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div class="info-row">
      <span class="info-key">{k}</span>
      <span class="info-val truncate" title={v || undefined}>{v || '—'}</span>
    </div>
  );
}
function Note({ kind, children }) { return <div class={`fleet-note fleet-note-${kind}`}>{children}</div>; }
