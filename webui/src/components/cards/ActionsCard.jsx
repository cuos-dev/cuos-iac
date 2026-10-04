// SPDX-License-Identifier: Apache-2.0
import { useState, useRef } from 'preact/hooks';

export default function ActionsCard({ sendAction, ps = [] }) {
  const [busy, setBusy] = useState(null);
  const [msg, setMsg]   = useState(null);
  const dialogRef = useRef(null);
  const configRef = useRef(null);
  const [signed, setSigned] = useState('');

  async function act(key, command, params = {}) {
    setBusy(key); setMsg(null);
    try {
      const r = await sendAction(command, params);
      const res = r?.result;
      // cuos:* and update answer with an empty string when they worked
      const text = r?.error ?? res?.error ?? res?.result ?? (res === '' || res == null ? 'OK' : typeof res === 'string' ? res : JSON.stringify(res));
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

  async function sendConfig() {
    const config = signed.trim();
    if (!config) return;
    configRef.current.close();
    await act('config', 'config', { config });
    setSigned('');
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
          <Btn icon="ti-git-pull-request" label="Pull repo now"          k="pull"    busy={busy} onClick={() => act('pull', 'update')} />
          <Btn icon="ti-file-text"       label="View compose file"      k="compose" busy={busy} onClick={viewCompose} />
          <Btn icon="ti-shield-check"    label="Run health check"       k="health"  busy={busy} onClick={healthCheck} />
          <Btn icon="ti-file-certificate" label="Apply signed config"  k="config"  busy={busy} onClick={() => configRef.current.showModal()} />
          <Btn icon="ti-download"        label="Manual system update"  k="osupd"   busy={busy}
            onClick={() => confirm('Check for and install an OS update now?') && act('osupd', 'cuos:update')} />
          <Btn icon="ti-power"           label="Reboot system"          k="reboot"  busy={busy} danger
            onClick={() => confirm('Reboot the system?') && act('reboot', 'cuos:reboot')} />
          <Btn icon="ti-player-stop"     label="Shutdown system"        k="shutdown" busy={busy} danger
            onClick={() => confirm('Shut the system down? It has to be started again by hand.') && act('shutdown', 'cuos:shutdown')} />
          <Btn icon="ti-arrow-back-up"   label="Rollback OS update"     k="rollback" busy={busy} danger
            onClick={() => confirm('Roll back the OS update?') && act('rollback', 'cuos:rollback')} />
        </div>
        {msg && <div class="action-result">{msg}</div>}
        <dialog ref={dialogRef} class="compose-dialog">
          <div class="compose-header">
            <strong>docker-compose.yml</strong>
            <button class="btn-sm" onClick={() => dialogRef.current.close()}>Close</button>
          </div>
          <pre class="compose-pre" />
        </dialog>
        <dialog ref={configRef} class="compose-dialog">
          <div class="compose-header">
            <strong>Signed configuration</strong>
            <button class="btn-sm" onClick={() => configRef.current.close()}>Cancel</button>
          </div>
          <p class="config-hint">Paste the output of <code>tool.sh config-sign system.json</code>. The signature is only valid for 15 minutes.</p>
          <textarea class="config-input" value={signed} onInput={e => setSigned(e.currentTarget.value)} spellcheck={false} />
          <div class="config-actions"><button class="btn-sm" onClick={sendConfig} disabled={!signed.trim()}>Send</button></div>
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
