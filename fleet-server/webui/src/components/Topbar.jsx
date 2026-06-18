import { useState, useEffect } from 'preact/hooks';

function Stat({ val, label }) {
  return (
    <div class="topbar-stat">
      <div class="topbar-stat-val">{val ?? '—'}</div>
      <div class="topbar-stat-label">{label}</div>
    </div>
  );
}

export function Topbar({ online, offline, outdated, ok }) {
  const [now, setNow] = useState(() => new Date().toLocaleString());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toLocaleString()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div class="topbar">
      <div class="topbar-brand">
        <div class="brand-icon"><i class="ti ti-topology-star-3" /></div>
        Fleet Server
        <span class="topbar-sub">/ production</span>
        <span class={`ws-dot ${ok ? 'ws-dot-ok' : 'ws-dot-off'}`} title={ok ? 'live' : 'reconnecting…'} />
      </div>
      <div class="topbar-stats">
        <Stat val={online}   label="online" />
        <div class="topbar-divider" />
        <Stat val={offline}  label="offline" />
        <div class="topbar-divider" />
        <Stat val={outdated} label="outdated" />
        <div class="topbar-divider topbar-clock" />
        <div class="topbar-stat topbar-clock">
          <div class="topbar-stat-val">{now}</div>
          <div class="topbar-stat-label">server time</div>
        </div>
      </div>
    </div>
  );
}
