import { useState, useEffect } from 'preact/hooks';
import '../style/topbar.css';

export default function Topbar({ hostname, iacState, connected }) {
  const [time, setTime] = useState('');

  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleString('de-DE'));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const dotCls = connected ? (iacState === 'updating' ? 'warn' : '') : 'grey';
  const label  = connected ? (iacState === 'updating' ? 'Updating…' : 'Connected') : 'Reconnecting…';

  return (
    <div class="topbar">
      <div class="topbar-brand">
        <div class="brand-icon"><i class="ti ti-server-2" /></div>
        IaC Manager
        {hostname && <span class="topbar-host">/ {hostname}</span>}
      </div>
      <div class="topbar-meta">
        <span><span class={`status-dot ${dotCls}`} />{label}</span>
        <span>{time}</span>
      </div>
    </div>
  );
}
