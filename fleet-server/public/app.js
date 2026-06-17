// ponytail: CDN Preact + htm, no build step
import { html, render, useState, useEffect, useRef } from 'https://esm.sh/htm/preact/standalone';

const NONCE  = window.__WS_NONCE__;
const HAS_VM = !!window.__HAS_VM__;
const HAS_VL = !!window.__HAS_VL__;
const fmt = {
  date: ts => ts ? new Date(ts.endsWith('Z') ? ts : ts + 'Z').toLocaleString() : '—',
  pct:  v  => v != null ? `${Math.round(v)}%` : '—',
};
const STATUS_COLOR = { online: '#0a0', offline: '#888', updating: '#e67e22', error: '#c00' };

function Badge({ s }) {
  return html`<span style="color:${STATUS_COLOR[s] || '#555'};font-weight:600">${s || '—'}</span>`;
}

function useFleet() {
  const [devices, setDevices] = useState([]);
  const [ok, setOk] = useState(false);
  const ws = useRef(null);
  useEffect(() => {
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${proto}//${location.host}/ui-ws/${NONCE}`);
      ws.current = sock;
      sock.onopen = () => setOk(true);
      sock.onclose = () => { setOk(false); setTimeout(connect, 3000); };
      sock.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'state') setDevices(m.devices); };
    }
    connect();
    return () => ws.current?.close();
  }, []);
  return { devices, ok };
}

// ponytail: hand-rolled SVG sparkline, no chart lib; add uPlot if you need zoom/hover
function Sparkline({ values, color = '#0a0', width = 200, height = 40 }) {
  if (!values?.length) return html`<span style="color:#999;font-size:11px">no data</span>`;
  const nums = values.map(([, v]) => parseFloat(v));
  const min = Math.min(...nums), range = (Math.max(...nums) - min) || 1;
  const pts = nums.map((v, i) =>
    `${(i / (nums.length - 1)) * width},${(height - 4) - ((v - min) / range) * (height - 8) + 2}`
  ).join(' ');
  const last = Math.round(nums.at(-1));
  return html`<svg width=${width} height=${height} style="display:block;overflow:visible">
    <polyline points=${pts} fill="none" stroke=${color} stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <text x=${width + 4} y=${height - 2} font-size="10" fill="#666">${last}%</text>
  </svg>`;
}

function MetricsPanel({ deviceId }) {
  const [range, setRange] = useState('1h');
  const [data, setData]   = useState(null);
  useEffect(() => {
    setData(null);
    fetch(`/api/metrics/${deviceId}?range=${range}`).then(r => r.json()).then(setData).catch(() => setData([]));
  }, [deviceId, range]);
  const META = {
    cuos_cpu_usage:    { label: 'CPU',  color: '#e67e22' },
    cuos_ram_percent:  { label: 'RAM',  color: '#3498db' },
    cuos_disk_percent: { label: 'Disk', color: '#9b59b6' },
  };
  return html`<div style="margin-top:12px">
    <b style="font-size:13px">Metrics history</b>
    ${['1h','24h','7d'].map(r => html`
      <button onClick=${() => setRange(r)}
        style="margin-left:6px;font-size:11px;padding:1px 6px;${range===r ? 'font-weight:bold' : ''}">${r}</button>`)}
    <div style="display:flex;gap:24px;margin-top:8px;flex-wrap:wrap">
      ${data === null
        ? html`<span style="color:#999;font-size:12px">Loading…</span>`
        : (data || []).map(({ metric, values }) => html`
            <div>
              <div style="font-size:11px;color:#666;margin-bottom:3px">${META[metric]?.label || metric}</div>
              <${Sparkline} values=${values} color=${META[metric]?.color} />
            </div>`)}
    </div>
  </div>`;
}

function LogPanel({ device }) {
  const [logs, setLogs] = useState(null);
  const [q, setQ]       = useState('');
  function load(query) {
    setLogs(null);
    const qs = query ? `?q=${encodeURIComponent(query)}` : '';
    fetch(`/api/logs/${device.id}${qs}`).then(r => r.json()).then(setLogs).catch(() => setLogs([]));
  }
  useEffect(() => { load(''); }, [device.id]);
  return html`<div style="margin-top:12px">
    <b style="font-size:13px">Logs</b>
    <input value=${q} onInput=${e => setQ(e.target.value)} onKeyDown=${e => e.key === 'Enter' && load(q)}
      placeholder="LogsQL filter (Enter)…"
      style="margin-left:8px;font-size:12px;padding:2px 6px;border:1px solid #ccc;border-radius:3px;width:200px"/>
    <button onClick=${() => load(q)} style="margin-left:4px;font-size:12px;padding:1px 8px">Search</button>
    <div style="font-family:monospace;font-size:11px;max-height:180px;overflow-y:auto;background:#1a1a1a;color:#ddd;padding:8px;margin-top:6px;border-radius:4px">
      ${logs === null
        ? 'Loading…'
        : logs.length === 0
          ? html`<span style="color:#555">No logs found.</span>`
          : logs.map(l => html`
              <div style="padding:1px 0;border-bottom:1px solid #2a2a2a">
                <span style="color:#777">${(l._time || '').slice(0, 19).replace('T', ' ')}</span>
                ${' '}<span style="color:#6af">[${l.unit || '?'}]</span>
                ${' '}${l._msg}
              </div>`)}
    </div>
  </div>`;
}

function Detail({ device }) {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    fetch(`/api/clients/${device.id}`).then(r => r.json()).then(d => setEvents(d.recent_events ?? []));
  }, [device.id]);
  const r = device.metrics?.resources || {};
  const s = device.metrics?.state || {};
  return html`
    <tr><td colspan="9" style="background:#f4f5f7;padding:12px 16px;border-top:none">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;font-size:13px">
        <div>
          <b>Device</b><br/>
          Tags: ${(device.tags || []).join(', ') || '—'}<br/>
          Repo: ${device.repo_url || '—'}<br/>
          Branch: ${device.repo_branch || '—'}<br/>
          Version: ${s.version || '—'}
        </div>
        <div>
          <b>Resources</b><br/>
          CPU: ${fmt.pct(r.cpu_usage)}<br/>
          RAM: ${fmt.pct(r.ram_percent)}<br/>
          Disk: ${fmt.pct(r.disk_percent)}
        </div>
        <div>
          <b>Recent updates</b><br/>
          ${events === null
            ? 'Loading…'
            : events.length === 0
              ? 'No history.'
              : events.map(e => html`
                  <div style="margin:2px 0">
                    <span style="color:${e.success ? '#0a0' : '#c00'}">${e.success ? '✓' : '✗'}</span>
                    ${' '}<span style="color:#555;font-size:12px">${fmt.date(e.ts)}</span>
                    ${' '}${e.phase}
                    ${e.error ? html`<span style="color:#c00"> — ${e.error}</span>` : ''}
                  </div>`)}
        </div>
      </div>
      <div style="margin-top:10px">
        <a href="http://${device.hostname}:8030/" target="_blank" style="font-size:13px">Open device UI →</a>
      </div>
      ${HAS_VM && html`<${MetricsPanel} deviceId=${device.id} />`}
      ${HAS_VL && html`<${LogPanel} device=${device} />`}
    </td></tr>`;
}

function Row({ d, selected, onSelect, onTrigger }) {
  const [open, setOpen] = useState(false);
  const a = d.metrics?.app_state || {};
  const iac = a.iac_state !== 'idle' ? a.iac_state : (d.metrics?.state?.state || '—');
  const lastUp = a.last_iac_update || d.metrics?.state?.last_update_date;
  const r = d.metrics?.resources || {};
  return html`
    <tr style="cursor:pointer" onClick=${() => setOpen(x => !x)}>
      <td onClick=${e => e.stopPropagation()}>
        <input type="checkbox" checked=${selected} onChange=${e => onSelect(e.target.checked)} />
      </td>
      <td>${d.hostname || '—'}</td>
      <td><${Badge} s=${d.status} /></td>
      <td><${Badge} s=${iac} /></td>
      <td class="num">${fmt.date(lastUp)}</td>
      <td class="num">${fmt.pct(r.cpu_usage)}</td>
      <td class="num">${fmt.pct(r.ram_percent)}</td>
      <td class="num">${fmt.pct(r.disk_percent)}</td>
      <td onClick=${e => e.stopPropagation()}>
        <button onClick=${onTrigger} disabled=${d.status === 'offline'}>Update</button>
      </td>
    </tr>
    ${open && html`<${Detail} device=${d} />`}`;
}

function App() {
  const { devices, ok } = useFleet();
  const [q, setQ]         = useState('');
  const [sf, setSf]        = useState('all');
  const [sel, setSel]      = useState(new Set());
  const [bulkMsg, setBulk] = useState('');

  const shown = devices.filter(d => {
    if (sf !== 'all' && d.status !== sf) return false;
    if (!q) return true;
    const lq = q.toLowerCase();
    return (d.hostname || '').toLowerCase().includes(lq) || (d.tags || []).some(t => t.toLowerCase().includes(lq));
  });

  const counts = devices.reduce((a, d) => { a[d.status] = (a[d.status] || 0) + 1; return a; }, {});

  function trigger(id) { fetch(`/api/clients/${id}/update`, { method: 'POST' }).catch(() => {}); }

  function bulkTrigger() {
    fetch('/api/bulk-update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...sel] }),
    }).then(r => r.json()).then(d => {
      setBulk(`Triggered: ${d.triggered.length} | Offline: ${d.offline.length}`);
      setSel(new Set());
      setTimeout(() => setBulk(''), 4000);
    });
  }

  function toggleSel(id, on) { setSel(s => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; }); }

  return html`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <h1 style="margin:0;font-size:20px">CuOS Fleet</h1>
      <span style="font-size:12px;color:${ok ? '#0a0' : '#c00'}">${ok ? '● live' : '○ reconnecting…'}</span>
    </div>

    <div style="display:flex;gap:16px;margin-bottom:10px;font-size:13px;flex-wrap:wrap">
      <span>Total <b>${devices.length}</b></span>
      ${Object.entries(counts).map(([s, n]) => html`
        <span><span style="color:${STATUS_COLOR[s] || '#555'}">${s}</span> <b>${n}</b></span>`)}
    </div>

    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center">
      <input placeholder="Filter hostname or tag…" value=${q} onInput=${e => setQ(e.target.value)}
        style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;width:220px"/>
      <select value=${sf} onChange=${e => setSf(e.target.value)}
        style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px">
        <option value="all">All</option>
        <option value="online">Online</option>
        <option value="offline">Offline</option>
        <option value="updating">Updating</option>
        <option value="error">Error</option>
      </select>
      ${sel.size > 0 && html`
        <button onClick=${bulkTrigger} style="padding:4px 12px;font-size:13px">
          Trigger update (${sel.size})
        </button>`}
      ${bulkMsg && html`<span style="color:#0a0;font-size:13px">${bulkMsg}</span>`}
    </div>

    <table>
      <thead><tr>
        <th style="width:32px"></th>
        <th>Hostname</th><th>Connection</th><th>IaC State</th>
        <th>Last Update</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${shown.length === 0 && html`<tr><td colspan="9" style="text-align:center;color:#999;padding:20px">No devices</td></tr>`}
        ${shown.map(d => html`<${Row} key=${d.id} d=${d}
          selected=${sel.has(d.id)} onSelect=${on => toggleSel(d.id, on)}
          onTrigger=${() => trigger(d.id)} />`)}
      </tbody>
    </table>`;
}

render(html`<${App}/>`, document.getElementById('app'));
