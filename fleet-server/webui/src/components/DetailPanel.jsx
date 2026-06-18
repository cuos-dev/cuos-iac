import { useEffect, useState } from 'preact/hooks';
import { fmt } from '../lib/fmt.js';
import { MetricsPanel } from './MetricsPanel.jsx';
import { LogStream } from './LogStream.jsx';

export function DetailPanel({ device: d, meta }) {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    fetch(`/api/clients/${d.id}`)
      .then(r => r.json())
      .then(data => setEvents(data.recent_events ?? []));
  }, [d.id]);

  const r = d.metrics?.resources || {};
  const s = d.metrics?.state     || {};

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

        {meta?.hasVm && <MetricsPanel deviceId={d.id} />}
        {meta?.hasVl && <LogStream device={d} />}
      </td>
    </tr>
  );
}
