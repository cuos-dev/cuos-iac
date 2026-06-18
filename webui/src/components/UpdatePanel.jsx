import { useState, useEffect } from 'preact/hooks';
import { fmt } from '../lib/fmt.js';

function pad(n) { return String(n).padStart(2, '0'); }

function fmtCountdown(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function toMs(ts) {
  if (!ts) return null;
  const s = String(ts);
  return new Date(s.endsWith('Z') ? s : s + 'Z').getTime();
}

function ProgressSteps({ steps }) {
  return (
    <div class="progress-steps">
      {steps.map((s, i) => {
        const status = s.status ?? 'pending';
        const icon = status === 'done' ? 'ti-circle-check' : status === 'running' ? 'ti-loader-2 spin' : 'ti-circle';
        return (
          <div key={i} class={`progress-step step-${status}`}>
            <i class={`ti ${icon}`} /> {s.step ?? s.name ?? s.label ?? s}
          </div>
        );
      })}
    </div>
  );
}

export default function UpdatePanel({ appState = {}, config = {}, progress, sendAction }) {
  const [triggering, setTriggering] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const poll   = config.iac_poll_interval ?? 21600;
  const manual = config.iac_manual_updates;
  const isUpdating = appState.iac_state === 'updating' || triggering;
  const lastMs = toMs(appState.last_iac_update_check);

  let remaining = 0, pct = 0;
  if (!manual && lastMs) {
    remaining = Math.max(0, poll - Math.floor((now - lastMs) / 1000));
    pct = ((poll - remaining) / poll) * 100;
  }

  async function triggerUpdate() {
    setTriggering(true);
    try { await sendAction('update'); } catch {} // iac will push state updates via WS
    finally { setTriggering(false); }
  }

  const steps = Array.isArray(progress) && progress.length > 0 ? progress : null;

  return (
    <div class="card update-panel">
      <div class="update-inner">
        <div class="timer-block">
          <div class="timer-label">{isUpdating ? 'Updating…' : 'Next update in'}</div>
          <div class="timer-display">
            {manual ? '∞' : fmtCountdown(remaining)}
          </div>
          <div class="progress-bar-wrap" style="width:100%;margin-top:8px;">
            <div class="progress-bar-fill" style={`width:${pct}%`} />
          </div>
        </div>
        <div class="divider-v" />
        <div class="update-actions">
          <div class="update-meta">
            Last update: <strong>{fmt(appState.last_iac_update_check) || '—'}</strong><br />
            Commit: {appState.commit
              ? <span class="commit-hash">{appState.commit.slice(0, 8)}</span>
              : '—'}<br />
            Branch: <strong>{config.iac_repo_branch || appState.iac_branch || '—'}</strong>
          </div>
          {isUpdating && steps
            ? <ProgressSteps steps={steps} />
            : <button class="btn-update" onClick={triggerUpdate} disabled={isUpdating}>
                <i class={`ti ${isUpdating ? 'ti-loader-2 spin' : 'ti-refresh'}`} />
                {isUpdating ? 'Updating…' : 'Trigger update now'}
              </button>}
        </div>
      </div>
    </div>
  );
}
