import { useState } from 'preact/hooks';
import { useAction } from '../hooks/useAction.js';
import { isOutdated } from '../lib/version.js';
import { fmt } from '../lib/fmt.js';
import { DetailPanel } from './DetailPanel.jsx';

const STATUS_BADGE = {
  online:   { cls: 'badge-teal',  icon: 'ti-circle-filled', label: 'online' },
  offline:  { cls: 'badge-gray',  icon: 'ti-circle',        label: 'offline' },
  updating: { cls: 'badge-amber', icon: 'ti-refresh spin',  label: 'updating' },
  error:    { cls: 'badge-red',   icon: 'ti-alert-circle',  label: 'error' },
};

const IAC_BADGE = {
  running:  'badge-green',
  updating: 'badge-amber',
  error:    'badge-red',
};

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

export function DeviceRow({ device: d, latestCuos, latestAgent, meta }) {
  const [open, setOpen]       = useState(false);
  const { run, pending, done, error } = useAction();
  const offline = d.status === 'offline';
  const r  = d.metrics?.resources || {};
  const as = d.metrics?.app_state  || {};

  const sb     = STATUS_BADGE[d.status] || { cls: 'badge-gray', icon: 'ti-circle', label: d.status || '—' };
  const iacCls = IAC_BADGE[as.iac_state] || 'badge-gray';
  const dotCls = d.status === 'online' ? 'dot-online' : d.status === 'warn' ? 'dot-warn' : 'dot-offline';

  const btnIcon  = pending ? 'ti-loader-2 spin' : done ? 'ti-check' : 'ti-refresh';
  const btnLabel = pending ? 'Updating…' : done ? 'Done' : error ? 'Error' : 'Update';
  const btnCls   = `tbl-btn ${done ? 'done' : error ? 'error' : 'primary'} ${(offline || pending) ? 'disabled' : ''}`;

  return (
    <>
      <tr class="device-row" onClick={() => setOpen(x => !x)}>
        <td>
          <div class="device-cell">
            <div class={`device-dot ${dotCls}`} />
            <div>
              <div class="device-name">{d.hostname || '—'}</div>
              <div class="device-id">{d.id}</div>
            </div>
          </div>
        </td>
        <td><span class={`badge ${sb.cls}`}><i class={`ti ${sb.icon}`} /> {sb.label}</span></td>
        <td>
          {d.cuos_version
            ? <span class={`version-chip ${isOutdated(d.cuos_version, latestCuos) ? 'outdated' : ''}`}>{d.cuos_version}</span>
            : <span class="muted">—</span>}
        </td>
        <td>
          {d.agent_version
            ? <span class={`version-chip ${isOutdated(d.agent_version, latestAgent) ? 'outdated' : ''}`}>{d.agent_version}</span>
            : <span class="muted">—</span>}
        </td>
        <td><span class="mono">{r.default_route_ip || '—'}</span></td>
        <td>
          {as.iac_state
            ? <span class={`badge ${iacCls}`}>{as.iac_state}</span>
            : <span class="muted">—</span>}
        </td>
        <td>
          <div class="mini-bars">
            <MiniBar val={r.cpu_usage}    label="CPU" />
            <MiniBar val={r.ram_percent}  label="RAM" />
            <MiniBar val={r.disk_percent} label="Disk" />
          </div>
        </td>
        <td><span class="muted">{fmt.uptime(r.uptime_seconds)}</span></td>
        <td><span class={`last-seen ${fmt.lastSeenClass(d.last_seen)}`}>{fmt.relative(d.last_seen)}</span></td>
        <td onClick={e => e.stopPropagation()}>
          <div class="action-cell">
            <button class={btnCls} onClick={() => run(`/api/clients/${d.id}/update`)} disabled={offline || pending}>
              <i class={`ti ${btnIcon}`} /> {btnLabel}
            </button>
            <button class="tbl-btn" onClick={() => setOpen(x => !x)}>
              <i class={`ti ${open ? 'ti-chevron-up' : 'ti-info-circle'}`} />
            </button>
          </div>
        </td>
      </tr>
      {open && <DetailPanel device={d} meta={meta} />}
    </>
  );
}
