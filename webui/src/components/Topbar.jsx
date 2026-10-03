import { useState, useEffect } from 'preact/hooks';
import { iacHealth } from '../lib/status.js';
import '../style/topbar.css';

export default function Topbar({ hostname, iacState, connected }) {
  const [time, setTime] = useState('');

  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleString('de-DE'));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const health = iacHealth(iacState);
  const dotCls = !connected ? 'grey' : health === 'error' ? 'err' : health === 'busy' ? 'warn' : '';
  const label  = !connected ? 'Reconnecting…' : health === 'error' ? `Error: ${iacState}` : health === 'busy' ? 'Updating…' : 'Connected';

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
