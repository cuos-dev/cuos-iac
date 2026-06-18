import { useState, useRef } from 'preact/hooks';

export default function ActionsCard({ sendAction, ps = [] }) {
  const [busy, setBusy] = useState(null);
  const [msg, setMsg]   = useState(null);
  const dialogRef = useRef(null);

  async function act(key, command, params = {}) {
    setBusy(key); setMsg(null);
    try {
      const r = await sendAction(command, params);
      const text = r?.result?.error ?? r?.error ?? r?.result?.result ?? JSON.stringify(r?.result ?? '');
      flash(String(text));
    } catch (e) { flash(e.message); }
    finally { setBusy(null); }
  }

  function flash(text) {
    setMsg(text);
    setTimeout(() => setMsg(null), 4000);
  }

  async function viewCompose() {
    setBusy('compose');
    try {
      const r = await sendAction('compose:file');
      const content = r?.result?.content;
      if (content) {
        dialogRef.current.querySelector('pre').textContent = content;
        dialogRef.current.showModal();
      }
    } finally { setBusy(null); }
  }

  async function healthCheck() {
    setBusy('health'); setMsg(null);
    try {
      const r = await sendAction('ps');
      const list = Array.isArray(r?.result) ? r.result : ps;
      const running = list.filter(c => (c.Status || '').startsWith('Up')).length;
      flash(`${running} running, ${list.length - running} stopped`);
    } catch (e) { flash(e.message); }
    finally { setBusy(null); }
  }

  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-terminal-2" /> Actions</div>
      </div>
      <div class="card-body">
        <div class="actions-list">
          <Btn icon="ti-refresh-dot"     label="Restart all containers" k="restart" busy={busy} onClick={() => act('restart', 'update')} />
          <Btn icon="ti-git-pull-request" label="Pull repo now"          k="pull"    busy={busy} onClick={() => act('pull', 'update')} />
          <Btn icon="ti-file-text"       label="View compose file"      k="compose" busy={busy} onClick={viewCompose} />
          <Btn icon="ti-shield-check"    label="Run health check"       k="health"  busy={busy} onClick={healthCheck} />
          <Btn icon="ti-power"           label="Reboot system"          k="reboot"  busy={busy} danger
            onClick={() => confirm('Reboot the system?') && act('reboot', 'cuos:reboot')} />
        </div>
        {msg && <div class="action-result">{msg}</div>}
        <dialog ref={dialogRef} class="compose-dialog">
          <div class="compose-header">
            <strong>docker-compose.yml</strong>
            <button class="btn-sm" onClick={() => dialogRef.current.close()}>Close</button>
          </div>
          <pre class="compose-pre" />
        </dialog>
      </div>
    </div>
  );
}

function Btn({ icon, label, k, busy, onClick, danger }) {
  const isMe = busy === k;
  return (
    <button class={`action-btn${danger ? ' danger-action' : ''}`} onClick={onClick} disabled={!!busy}>
      <i class={`ti ${isMe ? 'ti-loader-2 spin' : icon}`} /> {label}
    </button>
  );
}
