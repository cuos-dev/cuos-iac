// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'preact/hooks';
import { fmt } from '../lib/fmt.js';
import { MetricsPanel } from './MetricsPanel.jsx';
import { LogStream } from './LogStream.jsx';
import { ApproveReject } from './EnrollmentActions.jsx';
import { useAction } from '../hooks/useAction.js';
import { sharesOf, sharesLogs, logSources } from '../lib/shares.js';

export function DetailPanel({ device: d, meta, canAct }) {
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
      <td colspan="11" class="detail-cell">
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
              <dt>Protocol</dt> <dd>{d.protocol_version ?? '—'}{(d.protocol_version ?? 2) < 2 && ' (old agent: upgrade it for a device token and privacy settings)'}</dd>
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
              <dt>IP</dt>     <dd class="mono-sm">{r.primary_ip || (sh.network === 'none' ? 'not shared' : '—')}</dd>
              <dt>Uptime</dt> <dd>{fmt.uptime(r.uptime_seconds)}</dd>
            </dl>
          </section>

          <section>
            <h4>Network</h4>
            {sh.network === 'none'
              ? <span class="muted"><i class="ti ti-lock" /> Not shared by this device.</span>
              : <>
                  <dl>
                    {ifaces.length === 0 && r.primary_ip && <><dt>Address</dt><dd class="mono-sm">{r.primary_ip}</dd></>}
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
                  {sh.network === 'summary' && <div class="muted" style="font-size:11px;margin-top:4px">The device shares only its own address and its gateway.</div>}
                </>}
          </section>

          {(d.metrics?.backup || sh.backup === false) && (
            <section>
              <h4>Backup</h4>
              <BackupInfo b={d.metrics?.backup} shared={sh.backup !== false} />
            </section>
          )}

          <section>
            <h4>Sharing</h4>
            {sh.unknown
              ? <span class="muted">This record has no sharing information yet; it appears when the device connects.</span>
              : <ul class="share-list">
                  <ShareRow label="Load (CPU, RAM, disk)" on={sh.resources} />
                  <ShareRow label="IaC state" on={sh.iac_state} />
                  <ShareRow label="Addresses" on={sh.network !== 'none'} note={sh.network} />
                  <ShareRow label="Logs" on={logSources(d).length > 0} note={logSources(d).join(', ') || undefined} />
                  <ShareRow label="Backup status" on={sh.backup !== false} />
                  <ShareRow label="Remote update" on={sh.remote_update} note={sh.remote_update ? 'allowed' : 'not allowed'} />
                </ul>}
          </section>

          <section>
            <h4>Enrollment</h4>
            <Enrollment device={d} canAct={canAct} />
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

        {meta?.hasMetrics && sh.resources !== false && <MetricsPanel deviceId={d.id} />}
        {meta?.hasLogs && sharesLogs(d) && <LogStream device={d} />}
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

function size(bytes) {
  if (bytes == null) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = Number(bytes);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function BackupInfo({ b, shared }) {
  if (!b) return <span class="muted"><i class="ti ti-lock" /> {shared ? 'No backup status reported.' : 'Not shared by this device.'}</span>;
  const r = b.last_run, c = b.last_check;
  return (
    <>
      <dl>
        <dt>Last backup</dt><dd>{r?.finished ? fmt.date(r.finished) : '—'}</dd>
        <dt>Result</dt><dd>{r?.result ? ({ ok: 'ok', partial: 'incomplete', failed: 'failed' }[r.result]) : '—'}{b.overdue ? ' · a scheduled backup is overdue' : ''}</dd>
        <dt>Took</dt><dd>{r?.seconds != null ? `${r.seconds} s` : '—'}</dd>
        <dt>Data</dt><dd>{r?.bytes != null ? `${size(r.bytes)} (${size(r.data_added) ?? '0 B'} new)` : '—'}</dd>
        <dt>Dumps</dt><dd>{r?.dumps ?? '—'}</dd>
        <dt>Snapshots</dt><dd>{b.snapshots ?? '—'}</dd>
        <dt>Next</dt><dd>{b.next_run ? fmt.date(b.next_run) : '—'}</dd>
        <dt>Last check</dt><dd>{c ? `${fmt.date(c.time)} · ${c.ok ? 'ok' : 'failed'}` : '—'}</dd>
      </dl>
      {r?.error && <div class="enroll-warn"><i class="ti ti-alert-triangle" /> {r.error}</div>}
      {r?.warning && <div class="muted" style="font-size:11px;margin-top:4px">{r.warning}</div>}
      {c && !c.ok && c.error && <div class="enroll-warn"><i class="ti ti-alert-triangle" /> Check: {c.error}</div>}
    </>
  );
}

function Enrollment({ device: d, canAct }) {
  const rotate = useAction(), revoke = useAction(), forget = useAction();
  const e = d.enrollment || {};
  const state = e.state === 'active' ? 'token active' : e.state === 'revoked' ? 'revoked: must be approved again' : e.state === 'pending' ? 'waiting for approval' : e.state === 'legacy' ? 'protocol 1: shared secret, no token' : 'not enrolled';
  return (
    <>
      <dl>
        <dt>State</dt>   <dd>{state}</dd>
        <dt>Token</dt>   <dd>{e.has_token ? `issued ${fmt.date(e.token_created)}` : '—'}</dd>
      </dl>
      {e.request && (
        <div class="enroll-request">
          <div><i class="ti ti-user-question" /> {e.state === 'pending' ? 'Asks to be enrolled' : 'A device with this id asks to be enrolled again'}</div>
          <div class="muted" style="font-size:11px">"{e.request.hostname || '?'}" from {String(e.request.addr || '?').replace('::ffff:', '')} · {fmt.date(e.request.since)}{e.request.live ? '' : ' · not connected right now'}</div>
          {e.state !== 'pending' && d.status === 'online' && <div class="enroll-warn"><i class="ti ti-alert-triangle" /> The real device is online with its token. Approving gives the requester a new token and the old one stops working.</div>}
          {canAct && <div style="margin-top:6px"><ApproveReject device={d} /></div>}
        </div>
      )}
      {canAct && (
        <div style="margin-top:8px">
          <button class="tbl-btn" disabled={forget.pending} title="Remove the device and everything stored about it: history, logs, events"
            onClick={() => confirm(`Forget ${d.hostname || d.id}? Its record, load history, logs and update events are deleted. If the device still has its token it can enrol again as a new device.`) && forget.run(`/api/clients/${d.id}`, 'DELETE')}>
            <i class="ti ti-trash" /> Forget device
          </button>
        </div>
      )}
      {canAct && e.has_token && (
        <div class="action-cell" style="margin-top:8px">
          <button class={`tbl-btn ${d.status === 'online' ? '' : 'disabled'}`} disabled={d.status !== 'online' || rotate.pending}
            title={d.status === 'online' ? 'Hand the device a new token' : 'The device must be online'} onClick={() => rotate.run(`/api/clients/${d.id}/rotate-token`)}>
            <i class={`ti ${rotate.pending ? 'ti-loader-2 spin' : 'ti-refresh'}`} /> Rotate token
          </button>
          <button class="tbl-btn" disabled={revoke.pending} title="Take the token away: the device has to be approved again"
            onClick={() => confirm(`Revoke the token of ${d.hostname || d.id}? The device will be disconnected and has to be approved again.`) && revoke.run(`/api/clients/${d.id}/revoke`)}>
            <i class="ti ti-ban" /> Revoke
          </button>
        </div>
      )}
    </>
  );
}
