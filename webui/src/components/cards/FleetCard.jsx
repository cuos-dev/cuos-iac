import { useState, useEffect } from 'preact/hooks';
import { fmt } from '../../lib/fmt.js';

// What the fleet agent reports about itself (it publishes through the IaC container). Read-only transparency
// for whoever owns this device: which server, is it connected, and exactly what it is allowed to share.
const STATE = {
  connected:    ['badge-green', 'connected'],
  connecting:   ['badge-amber', 'connecting…'],
  pending:      ['badge-amber', 'waiting for approval'],
  refused:      ['badge-red',   'refused'],
  disconnected: ['badge-amber', 'disconnected'],
};
const ENROLLMENT = { enrolled: 'enrolled', waiting: 'waiting for approval', bootstrap: 'not enrolled yet' };
const STALE_MS = 120_000;     // the agent refreshes every 30 s

export default function FleetCard({ fleet = {} }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

  const age = fleet.updated ? now - Date.parse(fleet.updated) : Infinity;
  const stale = age > STALE_MS;
  const [cls, label] = stale ? ['badge-gray', 'not reporting'] : (STATE[fleet.state] ?? ['badge-gray', fleet.state || 'unknown']);
  const sh = fleet.shares ?? {};
  const logs = Array.isArray(sh.logs) ? sh.logs : [];
  const last = fleet.last_remote_update;

  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-topology-star-3" /> Fleet</div>
        <span class={`badge ${cls}`}>{label}</span>
      </div>
      <div class="card-body" style="padding:14px 18px;">
        <Row k="Server" v={fleet.server} />
        <Row k="Device ID" v={fleet.device_id ? `${String(fleet.device_id).slice(0, 8)}…` : null} title={fleet.device_id} />
        <Row k="Enrollment" v={ENROLLMENT[fleet.enrollment] ?? fleet.enrollment} />
        <Row k="Since" v={fleet.since ? fmt(fleet.since) : null} />

        {stale && <Note kind="warn">The fleet agent has not reported for {Math.max(1, Math.round(age / 60000)) } min. It may not be running.</Note>}
        {!stale && fleet.error && <Note kind={fleet.state === 'refused' ? 'err' : 'warn'}>{fleet.error}</Note>}

        <div class="fleet-share-title">Shared with the server</div>
        <ul class="fleet-shares">
          <Share on={sh.resources !== false} label="Load (CPU, RAM, disk)" />
          <Share on={sh.iac_state !== false} label="IaC state" />
          <Share on={sh.network !== 'none'} label="Addresses" note={sh.network === 'full' ? 'all interfaces, routes, DNS' : sh.network === 'none' ? undefined : 'default route only'} />
          <Share on={logs.length > 0} label="Logs" note={logs.length ? logs.join(', ') : undefined} />
          <Share on={sh.remote_update !== false} label="Remote update" note={sh.remote_update === false ? 'not allowed' : 'allowed'} />
        </ul>

        {last && (
          <div class="fleet-last">
            <i class={`ti ${last.allowed === false ? 'ti-lock' : 'ti-refresh'}`} />{' '}
            {last.allowed === false ? 'Update request refused' : 'Update requested'}{last.by ? ` by ${last.by}` : ''} · {fmt(last.at)}
          </div>
        )}
        <div class="fleet-hint">Changed in <code>system.json</code> (<code>fleet_share</code>). The server shows the same list.</div>
      </div>
    </div>
  );
}

function Row({ k, v, title }) {
  return (
    <div class="info-row">
      <span class="info-key">{k}</span>
      <span class="info-val truncate" title={title || v || undefined}>{v || '—'}</span>
    </div>
  );
}
function Note({ kind, children }) { return <div class={`fleet-note fleet-note-${kind}`}>{children}</div>; }
function Share({ on, label, note }) {
  return (
    <li class={on ? 'share-on' : 'share-off'}>
      <i class={`ti ${on ? 'ti-check' : 'ti-lock'}`} /> <span>{label}</span>
      {note && <span class="fleet-note-text"> · {note}</span>}
    </li>
  );
}
