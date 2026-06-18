function Card({ icon, cls, val, label }) {
  return (
    <div class="summary-card">
      <div class={`summary-icon ${cls}`}><i class={`ti ${icon}`} /></div>
      <div>
        <div class="summary-val">{val ?? '—'}</div>
        <div class="summary-label">{label}</div>
      </div>
    </div>
  );
}

export function SummaryCards({ total, online, offline, outdated, updating }) {
  return (
    <div class="summary-row">
      <Card icon="ti-topology-star-3"   cls="si-teal"  val={total}    label="Total devices" />
      <Card icon="ti-circle-check"      cls="si-green" val={online}   label="Online" />
      <Card icon="ti-circle-x"          cls="si-red"   val={offline}  label="Offline" />
      <Card icon="ti-clock-exclamation" cls="si-amber" val={outdated} label="Outdated" />
      <Card icon="ti-refresh"           cls="si-blue"  val={updating} label="Updating" />
    </div>
  );
}
