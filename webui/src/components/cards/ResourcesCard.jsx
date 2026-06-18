function barFill(pct) {
  if (pct >= 85) return 'fill-red';
  if (pct >= 70) return 'fill-amber';
  return 'fill-blue';
}

function Cell({ label, pct }) {
  return (
    <div class="resource-item">
      <div class="resource-label">{label}</div>
      <div class="resource-val">{pct}%</div>
      <div class="resource-bar">
        <div class={`resource-bar-fill ${barFill(pct)}`} style={`width:${pct}%`} />
      </div>
    </div>
  );
}

export default function ResourcesCard({ resources = {} }) {
  const cpu  = resources.cpu_percent  ?? 0;
  const mem  = resources.ram_percent  ?? 0;
  const disk = resources.disk_percent ?? 0;

  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-activity" /> Resources</div>
      </div>
      <div class="card-body">
        <div class="resource-grid">
          <Cell label="CPU"    pct={cpu} />
          <Cell label="Memory" pct={mem} />
          <Cell label="Disk"   pct={disk} />
          <div class="resource-item">
            <div class="resource-label">Network</div>
            <div class="resource-val" style="font-size:15px;">↑↓</div>
            <div class="resource-net">
              {resources.net_tx_mbps != null
                ? `↑ ${resources.net_tx_mbps} MB/s · ↓ ${resources.net_rx_mbps} MB/s`
                : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
