// SPDX-License-Identifier: Apache-2.0
// `ip route` keywords get highlighted, like in the old UI
const ROUTE_KW = /\b(default|via|dev|proto|scope|src|linkdown|metric)\b/g;

function Route({ line }) {
  return <li>{String(line).split(ROUTE_KW).map((part, i) => i % 2 ? <span key={i} class="route-kw">{part}</span> : part)}</li>;
}

// the field really is spelled "ntp_synchronizede" in the cuos resources (and so in the agent)
function ntpStatus(r) {
  const synced = r.ntp_synchronizede ?? r.ntp_synchronized;
  if (r.ntp_service_active === undefined && synced === undefined) return null;
  if (!r.ntp_service_active) return { cls: 'badge-gray',  label: 'inactive' };
  return synced ? { cls: 'badge-green', label: 'synced' } : { cls: 'badge-amber', label: 'not synced' };
}

export default function NetworkCard({ resources = {} }) {
  const ifaces = Array.isArray(resources.network) ? resources.network : [];
  const dns    = resources.dns_servers ?? [];
  const ntp    = resources.ntp_servers ?? [];
  const routes = resources.routes ?? [];
  const ntpSt  = ntpStatus(resources);

  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-network" /> Network</div>
      </div>
      <div class="card-body" style="padding:14px 18px;">
        {ifaces.length === 0 && <Row k="IP address" />}
        {ifaces.map((n, i) => <Row key={i} k={n.interface || `Interface ${i + 1}`} v={n.ip} />)}
        <Row k="Gateway" v={resources.default_route_ip} />
        <Row k="DNS" v={dns.join(', ')} />
        <div class="info-row">
          <span class="info-key">NTP</span>
          <span class="info-val">
            {ntp.join(', ') || '—'}
            {ntpSt && <span class={`badge ${ntpSt.cls}`} style="margin-left:6px;">{ntpSt.label}</span>}
          </span>
        </div>
        {routes.length > 0 && (
          <details class="routes">
            <summary>Routes ({routes.length})</summary>
            <ul>{routes.map((r, i) => <Route key={i} line={r} />)}</ul>
          </details>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div class="info-row">
      <span class="info-key">{k}</span>
      <span class="info-val">{v || '—'}</span>
    </div>
  );
}
