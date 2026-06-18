export default function NetworkCard({ resources = {} }) {
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-network" /> Network</div>
      </div>
      <div class="card-body" style="padding:14px 18px;">
        <Row k="IP address" v={resources.ip} />
        <Row k="DNS"        v={resources.dns} />
        <Row k="NTP"        v={resources.ntp} />
        <Row k="Gateway"    v={resources.gateway} />
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
