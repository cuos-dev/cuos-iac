// SPDX-License-Identifier: Apache-2.0
import { useState } from 'preact/hooks';
import { useAction } from '../hooks/useAction.js';
import { isOutdated } from '../lib/version.js';
import { fmt } from '../lib/fmt.js';
import { iacHealth, hasProblem, hasRequest } from '../lib/status.js';
import { sharesOf, canRemoteUpdate } from '../lib/shares.js';
import { DetailPanel } from './DetailPanel.jsx';
import { ApproveReject } from './EnrollmentActions.jsx';

const STATUS_BADGE = {
  pending:  { cls: 'badge-amber', icon: 'ti-user-question', label: 'pending approval' },
  online:   { cls: 'badge-teal',  icon: 'ti-circle-filled', label: 'online' },
  offline:  { cls: 'badge-gray',  icon: 'ti-circle',        label: 'offline' },
  updating: { cls: 'badge-amber', icon: 'ti-refresh spin',  label: 'updating' },
  error:    { cls: 'badge-red',   icon: 'ti-alert-circle',  label: 'error' },
};

const IAC_BADGE = { ok: 'badge-green', busy: 'badge-amber', error: 'badge-red' };

function MiniBar({ val, label }) {
  const pct   = val != null ? Math.round(val) : null;
  const color = pct == null ? 'var(--gray-200)'
    : pct >= 85 ? 'var(--red-400)'
    : pct >= 70 ? 'var(--amber-400)'
    : 'var(--teal-400)';
  return (
    <div class="mini-bar-cell" title={`${label}: ${pct != null ? pct + '%' : '—'}`}>
      <span class="mini-bar-label">{pct != null ? pct + '%' : '—'}</span>
      <div class="mini-bar-track">
        <div class="mini-bar-fill" style={`width:${pct ?? 0}%;background:${color}`} />
      </div>
    </div>
  );
}

export function DeviceRow({ device: d, latestCuos, latestAgent, meta, canAct }) {
  const [open, setOpen]       = useState(false);
  const { run, pending, done, error } = useAction();
  const offline = d.status === 'offline';
  const sh = sharesOf(d);
  const permitted = canRemoteUpdate(d);
  const r  = d.metrics?.resources || {};
  const as = d.metrics?.app_state  || {};

  const waiting = hasRequest(d);
  const isNew   = d.enrollment?.state === 'pending';
  const sb     = STATUS_BADGE[isNew ? 'pending' : d.status] || { cls: 'badge-gray', icon: 'ti-circle', label: d.status || '—' };
  const iacCls = IAC_BADGE[iacHealth(as.iac_state)] || 'badge-gray';
  const dotCls = hasProblem(d) ? 'dot-error'
    : d.status === 'updating' ? 'dot-warn'
    : d.status === 'online' ? 'dot-online' : 'dot-offline';
  const busy = pending || d.status === 'updating';

  // "done" only means the trigger was accepted; the update itself is shown by the device status
  const btnIcon  = busy ? 'ti-loader-2 spin' : done ? 'ti-check' : 'ti-refresh';
  const btnLabel = busy ? 'Updating…' : done ? 'Triggered' : error ? 'Error' : 'Update';
  const btnCls   = `tbl-btn ${done ? 'done' : error ? 'error' : 'primary'} ${(offline || busy || !permitted) ? 'disabled' : ''}`;

  return (
    <>
      <tr class="device-row" onClick={() => setOpen(x => !x)}>
        <td>
          <div class="device-cell">
            <div class={`device-dot ${dotCls}`} />
            <div>
              <div class="device-name">{d.hostname || '—'}{waiting && !isNew && <span class="badge badge-amber req-chip" title="A device with this id asked to be enrolled again"><i class="ti ti-user-question" /> re-enrollment</span>}</div>
              <div class="device-id" title={d.id}>{d.id}</div>
            </div>
          </div>
        </td>
        <td><span class={`badge ${sb.cls}`}><i class={`ti ${sb.icon}`} /> {sb.label}</span></td>
        <td>
          {d.cuos_version
            ? <span class={`version-chip ${isOutdated(d.cuos_version, latestCuos) ? 'outdated' : ''}`}>{d.cuos_version}</span>
            : <span class="muted">—</span>}
        </td>
        <td class="col-agent">
          {d.agent_version
            ? <span class={`version-chip ${isOutdated(d.agent_version, latestAgent) ? 'outdated' : ''}`}>{d.agent_version}</span>
            : <span class="muted">—</span>}
        </td>
        <td class="col-ip">{r.default_route_ip
          ? <span class="mono">{r.default_route_ip}</span>
          : sh.network === 'none' ? <span class="muted not-shared" title="The device owner does not share addresses"><i class="ti ti-lock" /> not shared</span> : <span class="muted">—</span>}</td>
        <td class="col-iac">
          {as.iac_state
            ? <span class={`badge ${iacCls}`} title={as.iac_error || as.iac_state}>{as.iac_state}</span>
            : sh.iac_state === false ? <span class="muted not-shared" title="The device owner does not share the IaC state"><i class="ti ti-lock" /> not shared</span> : <span class="muted">—</span>}
        </td>
        <td class="col-cpu">
          <div class="mini-bars">
            {sh.resources === false ? <span class="muted not-shared" title="The device owner does not share load data"><i class="ti ti-lock" /> not shared</span> : <>
            <MiniBar val={r.cpu_usage}    label="CPU" />
            <MiniBar val={r.ram_percent}  label="RAM" />
            <MiniBar val={r.disk_percent} label="Disk" />
            </>}
          </div>
        </td>
        <td class="col-uptime"><span class="muted">{fmt.uptime(r.uptime_seconds)}</span></td>
        <td><span class={`last-seen ${fmt.lastSeenClass(d.last_seen)}`}>{fmt.relative(d.last_seen)}</span></td>
        <td onClick={e => e.stopPropagation()}>
          {canAct && waiting ? <ApproveReject device={d} /> : <div class="action-cell">
            {canAct && <button class={btnCls} onClick={() => run(`/api/clients/${d.id}/update`)} disabled={offline || busy || !permitted} title={!permitted ? 'This device does not allow remote updates' : error || undefined}>
              <i class={`ti ${btnIcon}`} /> {btnLabel}
            </button>}
            <button class="tbl-btn" onClick={() => setOpen(x => !x)}>
              <i class={`ti ${open ? 'ti-chevron-up' : 'ti-info-circle'}`} />
            </button>
          </div>}
        </td>
      </tr>
      {open && <DetailPanel device={d} meta={meta} canAct={canAct} />}
    </>
  );
}
