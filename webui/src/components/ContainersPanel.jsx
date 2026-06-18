import { useState, useRef } from 'preact/hooks';
import { Fragment } from 'preact';
import { containerStatus } from '../lib/status.js';
import '../style/containers.css';

function shortImage(img) {
  // strip registry prefix (hostname.tld/... or hostname:port/...)
  return img.replace(/^[^/]+\.[^/]+\//, '').replace(/^[^/]+:\d+\//, '');
}

function Ports({ ports }) {
  if (!ports) return <span class="val">—</span>;
  const parts = ports.split(', ');
  return (
    <div class="val">
      {parts.map((p, i) => {
        const m = p.match(/0\.0\.0\.0:(\d+)->/);
        if (m) {
          const port = m[1];
          const proto = port === '443' ? 'https' : 'http';
          return <span key={i}><a href={`${proto}://${location.hostname}:${port}`} target="_blank" rel="noopener">{p}</a>{i < parts.length - 1 ? ', ' : ''}</span>;
        }
        return <span key={i}>{p}{i < parts.length - 1 ? ', ' : ''}</span>;
      })}
    </div>
  );
}

export default function ContainersPanel({ ps = [], sendAction }) {
  const [expanded, setExpanded] = useState(null);
  const [rowBusy, setRowBusy]   = useState({});
  const [rowMsg, setRowMsg]     = useState({});
  const logsDialogRef = useRef(null);

  const running = ps.filter(c => (c.Status || '').startsWith('Up')).length;
  const stopped = ps.length - running;

  async function rowAction(name, command, params = {}) {
    setRowBusy(b => ({ ...b, [name]: true }));
    setRowMsg(m => ({ ...m, [name]: null }));
    try {
      const r = await sendAction(command, { name, ...params });
      const text = r?.result?.result ?? r?.result?.error ?? r?.error ?? 'done';
      flashRow(name, String(text));
    } catch (e) { flashRow(name, e.message); }
    finally { setRowBusy(b => ({ ...b, [name]: false })); }
  }

  function flashRow(name, text) {
    setRowMsg(m => ({ ...m, [name]: text }));
    setTimeout(() => setRowMsg(m => ({ ...m, [name]: null })), 4000);
  }

  async function showLogs(name) {
    const r = await sendAction('docker:logs', { name });
    const lines = r?.result?.lines ?? [];
    const dlg = logsDialogRef.current;
    dlg.querySelector('pre').textContent = lines.join('\n') || '(no output)';
    dlg.querySelector('.dlg-title').textContent = `Logs: ${name}`;
    dlg.showModal();
  }

  return (
    <div class="card containers-panel">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-container" /> Containers</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <span class="badge badge-green"><i class="ti ti-circle-filled" /> {running} running</span>
          {stopped > 0 && <span class="badge badge-red"><i class="ti ti-circle-filled" /> {stopped} stopped</span>}
        </div>
      </div>

      <div style="overflow-x:auto;">
        <table class="container-table">
          <thead>
            <tr>
              <th style="width:32px;" />
              <th>Name</th>
              <th>Image</th>
              <th>Status</th>
              <th>Uptime</th>
              <th class="col-size">Size</th>
              <th style="width:28px;" />
            </tr>
          </thead>
          <tbody>
            {ps.map(c => {
              const name = c.Names;
              const { cls, label, icon } = containerStatus(c.Status);
              const isExp = expanded === name;
              const isUp  = (c.Status || '').startsWith('Up');
              return (
                <Fragment key={name}>
                  <tr class={isExp ? 'expanded' : ''} onClick={() => setExpanded(isExp ? null : name)}>
                    <td style="padding-left:16px;"><i class="ti ti-brand-docker" style="font-size:16px;color:var(--accent);opacity:0.7;" /></td>
                    <td><div class="ct-name">{name}</div></td>
                    <td><div class="ct-image">{shortImage(c.Image || '')}</div></td>
                    <td><span class={`badge ${cls}`}><i class={`ti ${icon}`} /> {label}</span></td>
                    <td><span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">{c.RunningFor || '—'}</span></td>
                    <td class="col-size"><span class="ct-size">{c.Size?.split(' (')[0] || '—'}</span></td>
                    <td><i class={`ti ti-chevron-down ct-chevron${isExp ? ' rotated' : ''}`} /></td>
                  </tr>
                  {isExp && (
                    <tr class="expand-row">
                      <td colspan="7">
                        <div class="expand-content">
                          <div class="expand-group">
                            <label>Ports</label>
                            <Ports ports={c.Ports} />
                          </div>
                          <div class="expand-group">
                            <label>Networks</label>
                            <div class="val">{c.Networks || '—'}</div>
                          </div>
                          <div class="expand-group">
                            <label>Virtual size</label>
                            <div class="val">{c.Size?.match(/virtual (.+?)\)/)?.[1] ?? c.VirtualSize ?? '—'}</div>
                            <label style="margin-top:8px;">Created</label>
                            <div class="val">{c.CreatedAt || '—'}</div>
                          </div>
                          <div class="expand-group expand-actions" style="grid-column:1/-1;">
                            {rowMsg[name] && <span class="row-msg">{rowMsg[name]}</span>}
                            {rowBusy[name] && <i class="ti ti-loader-2 spin" />}
                            <button class="btn-sm" onClick={e => { e.stopPropagation(); rowAction(name, 'docker:restart'); }}>
                              <i class="ti ti-refresh" /> Restart
                            </button>
                            <button class="btn-sm" onClick={e => { e.stopPropagation(); rowAction(name, isUp ? 'docker:stop' : 'docker:start'); }}>
                              <i class={`ti ${isUp ? 'ti-player-stop' : 'ti-player-play'}`} /> {isUp ? 'Stop' : 'Start'}
                            </button>
                            <button class="btn-sm" onClick={e => { e.stopPropagation(); showLogs(name); }}>
                              <i class="ti ti-file-description" /> Logs
                            </button>
                            <button class="btn-sm danger" onClick={e => { e.stopPropagation(); confirm(`Remove ${name}?`) && rowAction(name, 'docker:remove'); }}>
                              <i class="ti ti-trash" /> Remove
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <dialog ref={logsDialogRef} class="compose-dialog">
        <div class="compose-header">
          <strong class="dlg-title">Logs</strong>
          <button class="btn-sm" onClick={() => logsDialogRef.current.close()}>Close</button>
        </div>
        <pre class="compose-pre" />
      </dialog>
    </div>
  );
}
