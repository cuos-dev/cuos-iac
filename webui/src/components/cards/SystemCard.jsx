export default function SystemCard({ system = {}, cuosState = {} }) {
  const osVersion = cuosState?.os_version ?? cuosState?.version ?? cuosState?.cuos_version ?? '—';
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-cpu" /> System</div>
      </div>
      <div class="card-body" style="padding:14px 18px;">
        <Row k="Hostname"   v={system.hostname} />
        <Row k="OS version" v={osVersion} />
        <Row k="Kernel"     v={system.kernel} />
        <Row k="Uptime"     v={system.uptime} />
        <Row k="Docker"     v={system.docker} />
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
