// ponytail: CDN Preact + htm, no build step
import { html, render, useState, useEffect, useRef } from 'https://esm.sh/htm/preact/standalone';

let CFG = {};
try { CFG = await (await fetch('/api/config')).json(); } catch {}

const fmt = ts => {
  if (!ts) return '—';
  const s = String(ts);
  const d = new Date(s.endsWith('Z') ? s : s + 'Z');
  return isNaN(d) ? s : d.toLocaleString(CFG.locale, { timeZone: CFG.tz });
};

function useSSE(url) {
  const [data, setData] = useState(null);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let es;
    function connect() {
      es = new EventSource(url);
      es.onmessage = e => { setOk(true); setData(JSON.parse(e.data)); };
      es.onerror = () => { setOk(false); es.close(); setTimeout(connect, 3000); };
    }
    connect();
    return () => es?.close();
  }, [url]);
  return { data, ok };
}

function Timer({ appState }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 490);
    return () => clearInterval(id);
  }, []);

  const iacState = appState?.iac_state || 'idle';
  const poll = CFG.iac_poll_interval || 21600;
  const manual = CFG.iac_manual_updates;
  const lastTs = appState?.last_iac_update_check;
  const lastUpdate = lastTs ? new Date((lastTs.endsWith('Z') ? lastTs : lastTs + 'Z')) : new Date();
  const elapsed = Math.floor((Date.now() - lastUpdate) / 1000);
  const remaining = Math.max(poll - elapsed, 0);

  let dashArray, dashOffset, timerText;
  if (iacState === 'updating' || (!manual && remaining <= 0)) {
    dashArray = '180 448';
    dashOffset = tick * 300;
    timerText = '';
  } else if (manual) {
    dashArray = '0 628';
    dashOffset = 628 / 4;
    timerText = '∞';
  } else {
    const pct = remaining / poll;
    dashArray = `${(628 * pct).toFixed(1)} ${(628 * (1 - pct)).toFixed(1)}`;
    dashOffset = 628 / 4;
    const h = Math.floor(remaining / 3600);
    const m = Math.floor(remaining / 60) % 60;
    const s = remaining % 60;
    timerText = (h ? `${String(h).padStart(2, '0')}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  return html`
    <div class="timer-block state-${iacState.replace(/[^a-zA-Z0-9]/g, '-')}">
      <svg class="timer-svg" width="220" height="220" viewBox="0 0 220 220">
        <circle class="timer-bg" cx="110" cy="110" r="100"/>
        <circle class="timer-fg" cx="110" cy="110" r="100"
          style="stroke-dasharray:${dashArray};stroke-dashoffset:${dashOffset}px"/>
        <text class="timer-text" x="50%" y="54%" text-anchor="middle" alignment-baseline="middle">${timerText}</text>
      </svg>
      <div class="iac-state">${iacState}</div>
      <div class="last-update">Last update: ${fmt(appState?.last_iac_update_check)}</div>
    </div>`;
}

function Bar({ label, pct, text }) {
  const color = (pct || 0) < 70 ? '#00BCD4' : (pct || 0) < 80 ? '#FFEB3B' : '#F44336';
  return html`<div class="resource-bar">
    <span class="resource-label">${label}</span>
    <div class="bar-bg">
      <div class="bar-fg" style="width:${pct || 0}%;background-color:${color}">
        <span class="bar-text">${Math.round(pct || 0)}%</span>
      </div>
    </div>
    <span class="resource-value">${text}</span>
  </div>`;
}

function Ports({ ports }) {
  if (!ports || typeof ports !== 'string') return html`${ports || ''}`;
  const parts = [];
  let last = 0;
  const re = /([0-9.]+):([0-9]+)->([0-9]+)(\/\w+)/g;
  let m;
  while ((m = re.exec(ports)) !== null) {
    if (m.index > last) parts.push(ports.slice(last, m.index));
    const [, ip, port, tport, proto] = m;
    const scheme = (port == 443 || port == 8443 || (port >= 4430 && port < 4440)) ? 'https' : 'http';
    const host = ip === '0.0.0.0' ? location.hostname : ip;
    parts.push(html`<a href="${scheme}://${host}:${port}" target="_blank">${ip}:${port}</a>→${tport}${proto} `);
    last = m.index + m[0].length;
  }
  if (last < ports.length) parts.push(ports.slice(last));
  return html`${parts}`;
}

function ContainerRow({ c }) {
  const [msg, setMsg] = useState('');
  async function action(cmd) {
    setMsg('…');
    try {
      const r = await fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, name: c.Names }),
      });
      const d = await r.json();
      setMsg(JSON.stringify(d.result ?? d.error));
      setTimeout(() => setMsg(''), 4000);
    } catch (e) { setMsg(e.message); }
  }
  const statusWord = (c.Status || '').split(' ')[0];
  const up = statusWord === 'Up';
  return html`
    <tr class="container-row">
      <td class="container-name">${c.Names}<br/><small style="color:#888">${c.ID}</small></td>
      <td class="container-image" style="font-size:0.85em">${c.Image}</td>
      <td class="container-created" style="font-size:0.85em">${c.RunningFor}</td>
      <td><span class="status-label status-${statusWord}">${c.Status}</span></td>
      <td style="font-size:0.85em">${c.Size}</td>
      <td style="font-size:0.8em">${c.Networks}<br/><${Ports} ports=${c.Ports}/></td>
      <td style="white-space:nowrap;font-size:0.85em">
        <button class="btn-sm" onClick=${() => action('docker:restart')} title="Restart">↺</button>
        <button class="btn-sm" onClick=${() => action('docker:recreate')} title="Force recreate">⬆</button>
        ${up
          ? html`<button class="btn-sm" onClick=${() => action('docker:stop')} title="Stop">■</button>`
          : html`<button class="btn-sm" onClick=${() => action('docker:start')} title="Start">▶</button>`}
        ${msg && html`<span style="color:#0a0;font-size:0.9em;margin-left:4px">${msg}</span>`}
      </td>
    </tr>`;
}

function LogStream() {
  const [logs, setLogs] = useState([]);
  const [running, setRun] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const esRef = useRef(null);
  const bottomRef = useRef(null);

  function start() {
    esRef.current?.close();
    setLogs([]);
    setRun(true);
    const es = new EventSource('/api/logs/stream');
    esRef.current = es;
    // ponytail: keep last 200 log lines in memory
    es.onmessage = e => setLogs(prev => [...prev, JSON.parse(e.data)].slice(-200));
    es.onerror = () => setRun(false);
  }
  function stop() { esRef.current?.close(); setRun(false); }

  useEffect(() => {
    if (autoScroll && logs.length) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, autoScroll]);

  return html`<div class="logs-container" style="width:90%;max-width:900px">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <button class="action-btn" style="padding:0.5em 1.5em;font-size:0.95em" onClick=${running ? stop : start}>
        ${running ? 'Stop' : 'Start'} live logs
      </button>
      <label style="font-size:0.9em;display:flex;align-items:center;gap:4px">
        <input type="checkbox" checked=${autoScroll} onChange=${e => setAutoScroll(e.target.checked)}/>
        Auto-scroll
      </label>
    </div>
    <div class="logs-content" style="max-height:50vh;overflow-y:auto;background:#0d0d0d;border:1px solid #333;padding:8px;border-radius:6px">
      ${!logs.length && html`<div class="log-entry no-logs">${running ? 'Waiting for logs…' : 'Click Start to stream IaC logs.'}</div>`}
      ${logs.map((l, i) => html`
        <div key=${i} class="log-entry ${(l.level || '').toLowerCase()}">
          <span class="log-timestamp">${fmt(l.date)}</span>
          <span class="log-message ${(l.level || '').toLowerCase()}">${l.message}</span>
        </div>`)}
      <div ref=${bottomRef}/>
    </div>
  </div>`;
}

const STEP_LABELS = {
  clone_repo:         'Pull repository',
  verify_commit:      'Verify commit signature',
  decrypt_files:      'Decrypt secrets',
  apply_system_json:  'Apply system.json',
  docker_build:       'Build images',
  docker_compose:     'Start services',
};

function ProgressSteps({ steps }) {
  if (!steps?.length) return null;
  const STATUS_ICON = { done: '✓', in_progress: '→', failed: '✗' };
  const STATUS_COLOR = { done: '#0a0', in_progress: '#fa0', failed: '#f44' };
  return html`<div style="margin-top:1em;text-align:left;font-size:0.95em;font-family:monospace">
    ${steps.map(s => html`
      <div style="color:${STATUS_COLOR[s.status] || '#888'};padding:2px 0">
        ${STATUS_ICON[s.status] || ' '} ${STEP_LABELS[s.step] || s.step}
      </div>`)}
  </div>`;
}

function Actions({ onAction, result, onClear, progress, iacState }) {
  const updating = iacState === 'updating';
  return html`<div style="margin-top:1.5em">
    ${updating
      ? html`<${ProgressSteps} steps=${progress}/>`
      : html`
        <a class="action-btn" href="#containers">Containers</a>
        <a class="action-btn" href="#system">System</a>
        <a class="action-btn" href="#logs">Logs</a>
        <a class="action-btn" href="#config">Config</a>
        <br/>
        <button class="action-btn" onClick=${() => onAction('update')}>Update IaC now</button>
        <button class="action-btn" onClick=${() => onAction('dry-run')}>Preview changes</button>
        <button class="action-btn" onClick=${() => confirm('Trigger system OS update?') && onAction('cuos:update')}>System Update</button>
        <button class="action-btn" onClick=${() => confirm('Reboot?') && onAction('cuos:reboot')}>Reboot</button>
        <button class="action-btn" onClick=${() => confirm('Shutdown?') && onAction('cuos:shutdown')}>Shutdown</button>
        <button class="action-btn danger" onClick=${() => confirm('Rollback OS update?') && onAction('cuos:rollback')}>Rollback OS</button>`}
    ${result && html`
      <div style="margin-top:10px;padding:8px 12px;background:#1a1a1a;border:1px solid #444;border-radius:6px;font-size:0.9em;white-space:pre-wrap;max-width:600px;word-break:break-word">
        ${result} <button onClick=${onClear} style="margin-left:8px;background:none;border:none;color:#888;cursor:pointer">×</button>
      </div>`}
  </div>`;
}

function App() {
  const { data, ok } = useSSE('/api/state');
  const [actionResult, setActionResult] = useState('');

  async function doAction(cmd, extra = {}) {
    try {
      const r = await fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, ...extra }),
      });
      const d = await r.json();
      setActionResult(typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? d.error, null, 2));
    } catch (e) { setActionResult(e.message); }
  }

  const { cuosState, resources: r, ps, appState, progress } = data || {};

  return html`
    <div style="position:fixed;top:8px;right:12px;font-size:11px;z-index:100;color:${ok ? '#0a0' : '#c00'}">
      ${ok ? '● live' : '○ reconnecting…'}
    </div>

    <div class="spa-container">

      <!-- 1. IaC State & Timer -->
      <section class="snap-section dark" id="home">
        <h1>CuOS IaC</h1>
        <${Timer} appState=${appState}/>
        <${Actions} onAction=${doAction} result=${actionResult} onClear=${() => setActionResult('')}
          progress=${progress} iacState=${appState?.iac_state}/>
      </section>

      <!-- 2. Containers -->
      <section class="snap-section light" id="containers">
        <h1>Container Status</h1>
        <div style="overflow-x:auto;width:100%;max-width:1100px">
          <table class="container-table">
            <thead><tr>
              <th>Name</th><th>Image</th><th>Created</th><th>Status</th><th>Size</th><th>Ports</th><th></th>
            </tr></thead>
            <tbody>
              ${!ps && html`<tr><td colspan="7" style="text-align:center;padding:20px;color:#999">Loading…</td></tr>`}
              ${(ps || []).map(c => html`<${ContainerRow} key=${c.ID} c=${c}/>`)}
            </tbody>
          </table>
        </div>
      </section>

      <!-- 3. System Info & Resources -->
      <section class="snap-section dark" id="system">
        <div class="sys-flex">
          <div class="sys-groups">
            ${cuosState && html`<div class="sys-group sys-main">
              <h2>System</h2>
              <div class="sys-row"><span class="sys-label">Status:</span> <span class="sys-value status-${cuosState.state}">${cuosState.state}</span></div>
              <div class="sys-row"><span class="sys-label">Virtualized:</span> <span class="sys-value">${r?.virt_type || '—'}</span></div>
              <div class="sys-row"><span class="sys-label">Version:</span> <span class="sys-value">${cuosState.version}</span></div>
              <div class="sys-row"><span class="sys-label">Started:</span> <span class="sys-value">${fmt(cuosState.start_date)}</span></div>
              <div class="sys-row"><span class="sys-label">Last update:</span> <span class="sys-value">${fmt(cuosState.last_update_date)}</span></div>
            </div>`}
            <div class="sys-group sys-iac">
              <h2>IaC</h2>
              <div class="sys-row"><span class="sys-label">Manager start:</span> <span class="sys-value">${fmt(appState?.last_iac_start)}</span></div>
              <div class="sys-row"><span class="sys-label">Repo:</span> <span class="sys-value">
                ${CFG.iac_repo_url
                  ? html`<a href="${CFG.iac_repo_url}" target="_blank">${CFG.iac_repo_name || CFG.iac_repo_url}</a>`
                  : '—'}
              </span></div>
              <div class="sys-row"><span class="sys-label">Branch:</span> <span class="sys-value">${CFG.iac_repo_branch || '—'}</span></div>
              <div class="sys-row"><span class="sys-label">Commit:</span> <span class="sys-value">${appState?.iac_commit ? fmt(appState.iac_commit) : '—'}</span></div>
              <div class="sys-row"><span class="sys-label">Last IaC update:</span> <span class="sys-value">${fmt(appState?.last_iac_update)}</span></div>
              ${appState?.error && html`<div class="sys-row"><span class="sys-label">Error:</span> <span class="sys-value" style="color:#f55">${appState.error}</span></div>`}
            </div>
            ${r && html`<div class="sys-group sys-network">
              <h2>Network</h2>
              ${(r.network || []).map(n => html`
                <div class="sys-row"><span class="sys-label">${n.interface}:</span> <span class="sys-value">${n.ip}</span></div>`)}
              <div class="sys-row"><span class="sys-label">Default route:</span> <span class="sys-value">${r.default_route_ip || '—'}</span></div>
              <div class="sys-row"><span class="sys-label">DNS:</span> <span class="sys-value">${(r.dns_servers || []).join(', ') || '—'}</span></div>
              <div class="sys-row"><span class="sys-label">NTP:</span> <span class="sys-value">${(r.ntp_servers || []).join(', ') || '—'}</span></div>
            </div>`}
          </div>
          ${r && html`<div class="sys-groups">
            <div class="sys-group sys-resources">
              <h2>Resources</h2>
              <div class="resource-bars">
                <${Bar} label="CPU" pct=${r.cpu_usage} text="${r.cpu_usage}% of ${r.cpu_cores} core(s)"/>
                <${Bar} label="RAM" pct=${r.ram_percent} text="${r.mem_used_mb} / ${r.mem_total_mb} MB"/>
                <${Bar} label="Disk" pct=${r.disk_percent} text="${r.disk_used_mb} / ${r.disk_total_mb} MB"/>
              </div>
            </div>
          </div>`}
        </div>
      </section>

      <!-- 4. IaC Logs -->
      <section class="snap-section light" id="logs">
        <h1>IaC Logs</h1>
        <${LogStream}/>
      </section>

      <!-- 5. Signed Config Submission -->
      <section class="snap-section dark" id="config">
        <${ConfigSection} onAction=${doAction}/>
      </section>

    </div>`;
}

function ConfigSection({ onAction }) {
  const [val, setVal] = useState('');
  const [result, setResult] = useState('');
  async function submit(e) {
    e.preventDefault();
    try {
      const r = await fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'config', config: val }),
      });
      const d = await r.json();
      setResult(typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? d.error, null, 2));
    } catch (e) { setResult(e.message); }
  }
  return html`
    <h1>CuOS IaC Config</h1>
    <p>Input signed configuration:</p>
    <p><code>tool.sh config-sign system.json</code></p>
    <form onSubmit=${submit} style="display:flex;flex-direction:column;align-items:flex-start;width:80vw;max-width:800px">
      <textarea value=${val} onInput=${e => setVal(e.target.value)}
        style="width:100%;height:300px;background:#1a1a1a;border:2px solid #444;color:#eee;font-family:monospace;font-size:12px;padding:8px;border-radius:6px;box-sizing:border-box"/>
      <button class="update-btn" type="submit" style="margin-top:1em">Submit</button>
    </form>
    ${result && html`<pre style="margin-top:12px;padding:10px;background:#1e1e1e;border:1px solid #444;font-size:12px;white-space:pre-wrap;max-width:80vw;border-radius:6px">${result}</pre>`}
    <a class="action-btn" href="#home" style="margin-top:1.5em">Back</a>`;
}

render(html`<${App}/>`, document.getElementById('app'));
