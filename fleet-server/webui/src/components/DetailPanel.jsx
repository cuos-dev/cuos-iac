import { useEffect, useState } from 'preact/hooks';
import { fmt } from '../lib/fmt.js';
import { MetricsPanel } from './MetricsPanel.jsx';
import { LogStream } from './LogStream.jsx';
import { sharesOf, sharesLogs } from '../lib/shares.js';

export function DetailPanel({ device: d, meta }) {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    fetch(`/api/clients/${d.id}`)
      .then(r => r.json())
      .then(data => setEvents(data.recent_events ?? []));
  }, [d.id]);

  const r = d.metrics?.resources || {};
  const s = d.metrics?.state     || {};
  const sh = sharesOf(d);
  const ifaces = Array.isArray(r.network) ? r.network : [];

  return (
    <tr>
      <td colspan="10" class="detail-cell">
        <div class="detail-grid">
          <section>
            <h4>Device</h4>
            <dl>
              <dt>Tags</dt>     <dd>{(d.tags || []).join(', ') || '—'}</dd>
              <dt>Repo</dt>     <dd class="mono-sm">{d.repo_url || '—'}</dd>
              <dt>Branch</dt>   <dd>{d.repo_branch || '—'}</dd>
              <dt>Version</dt>  <dd>{s.version || d.cuos_version || '—'}</dd>
              <dt>Agent</dt>    <dd>{d.agent_version || '—'}</dd>
              <dt>Last seen</dt><dd>{fmt.date(d.last_seen)}</dd>
              <dt>Protocol</dt> <dd>{d.protocol_version ?? '—'}</dd>
            </dl>
            <a class="device-link" href={`http://${d.hostname}:8030/`} target="_blank" rel="noreferrer">
              <i class="ti ti-external-link" /> Open device UI
            </a>
          </section>

          <section>
            <h4>Resources</h4>
            <dl>
              <dt>CPU</dt>    <dd>{fmt.pct(r.cpu_usage)} ({r.cpu_cores ?? '—'} cores)</dd>
              <dt>RAM</dt>    <dd>{fmt.pct(r.ram_percent)} ({r.mem_used_mb ?? '—'} / {r.mem_total_mb ?? '—'} MB)</dd>
              <dt>Disk</dt>   <dd>{fmt.pct(r.disk_percent)} ({r.disk_used_mb ?? '—'} / {r.disk_total_mb ?? '—'} MB)</dd>
              <dt>IP</dt>     <dd class="mono-sm">{r.default_route_ip || '—'}</dd>
              <dt>Uptime</dt> <dd>{fmt.uptime(r.uptime_seconds)}</dd>
            </dl>
          </section>

          <section>
            <h4>Network</h4>
            {sh.network === 'none'
              ? <span class="muted"><i class="ti ti-lock" /> Not shared by this device.</span>
              : <>
                  <dl>
                    {ifaces.map((n, i) => <><dt>{n.interface || `if ${i + 1}`}</dt><dd class="mono-sm">{n.ip}</dd></>)}
                    <dt>Gateway</dt><dd class="mono-sm">{r.default_route_ip || '—'}</dd>
                    {sh.network === 'full' && <><dt>DNS</dt><dd class="mono-sm">{(r.dns_servers || []).join(', ') || '—'}</dd>
                    <dt>NTP</dt><dd class="mono-sm">{(r.ntp_servers || []).join(', ') || '—'}{r.ntp_service_active !== undefined && (r.ntp_synchronizede ?? r.ntp_synchronized) ? ' (synced)' : ''}</dd></>}
                  </dl>
                  {(r.routes || []).length > 0 && (
                    <details class="routes"><summary>Routes ({r.routes.length})</summary>
                      <ul>{r.routes.map((x, i) => <li key={i}>{x}</li>)}</ul>
                    </details>
                  )}
                  {sh.network === 'summary' && <div class="muted" style="font-size:11px;margin-top:4px">The device shares only its default route address.</div>}
                </>}
          </section>

          <section>
            <h4>Sharing</h4>
            {sh.legacy
              ? <span class="muted">Legacy agent (protocol 1): sends everything, the owner cannot limit it. Update the agent to get privacy settings.</span>
              : <ul class="share-list">
                  <ShareRow label="Load (CPU, RAM, disk)" on={sh.resources} />
                  <ShareRow label="IaC state" on={sh.iac_state} />
                  <ShareRow label="Addresses" on={sh.network !== 'none'} note={sh.network} />
                  <ShareRow label="Logs" on={sh.logs} />
                  <ShareRow label="Remote update" on={sh.remote_update} note={sh.remote_update ? 'allowed' : 'not allowed'} />
                </ul>}
          </section>

          <section>
            <h4>Recent updates</h4>
            {events === null
              ? <span class="muted">Loading…</span>
              : events.length === 0
                ? <span class="muted">No history.</span>
                : <ul class="event-list">
                    {events.map((e, i) => (
                      <li key={i} class={e.success ? 'ev-ok' : 'ev-fail'}>
                        <i class={`ti ${e.success ? 'ti-check' : 'ti-x'}`} />
                        <span class="muted">{fmt.date(e.ts)}</span>
                        <span>{e.phase}</span>
                        {e.error && <span class="ev-error"> — {e.error}</span>}
                      </li>
                    ))}
                  </ul>
            }
          </section>
        </div>

        {meta?.hasVm && sh.resources !== false && <MetricsPanel deviceId={d.id} />}
        {meta?.hasVl && sharesLogs(d) && <LogStream device={d} />}
      </td>
    </tr>
  );
}

function ShareRow({ label, on, note }) {
  return (
    <li class={on ? 'share-on' : 'share-off'}>
      <i class={`ti ${on ? 'ti-check' : 'ti-lock'}`} /> <span>{label}</span>
      {note && <span class="muted"> · {note}</span>}
    </li>
  );
}
