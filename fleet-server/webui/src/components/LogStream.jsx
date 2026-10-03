import { useEffect, useRef, useState } from 'preact/hooks';

const LEVELS = [['', 'all levels'], ['4', 'warnings and errors'], ['3', 'errors only']];
const sev = p => (p <= 3 ? 'err' : p === 4 ? 'warn' : 'info');

// Live tail of a device's logs, read from the server's database. Admins only (the server enforces it).
export function LogStream({ device }) {
  const [logs, setLogs]   = useState([]);
  const [running, setRun] = useState(false);
  const [q, setQ]         = useState('');
  const [source, setSource] = useState('');
  const [level, setLevel]   = useState('');
  const esRef  = useRef(null);
  const boxRef = useRef(null);
  const sources = device.shares?.logs ?? [];

  function start(next = {}) {
    esRef.current?.close();
    const f = { q, source, level, ...next };
    setLogs([]); setRun(true);
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const es = new EventSource(`/api/logs/${device.id}/stream${qs ? '?' + qs : ''}`);
    esRef.current = es;
    es.onmessage = e => setLogs(prev => {
      const next = [...prev, JSON.parse(e.data)];
      return next.length > 300 ? next.slice(-300) : next;
    });
    es.onerror = () => { setRun(false); es.close(); };
  }

  function stop() { esRef.current?.close(); setRun(false); }

  useEffect(() => { start(); return () => esRef.current?.close(); }, [device.id]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && el.scrollHeight - el.scrollTop <= el.clientHeight + 60) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div class="log-stream">
      <div class="log-header">
        <span>Logs</span>
        <span class={`log-dot ${running ? 'log-dot-live' : ''}`}>{running ? '● live' : '○ stopped'}</span>
        <input value={q} onInput={e => setQ(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && start({ q: e.target.value })}
          placeholder="Text in message or unit (Enter)…" class="log-filter" aria-label="Filter logs" />
        {sources.length > 1 && (
          <select class="sort-select" value={source} onChange={e => { setSource(e.target.value); start({ source: e.target.value }); }} aria-label="Log source">
            <option value="">all sources</option>
            {sources.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <select class="sort-select" value={level} onChange={e => { setLevel(e.target.value); start({ level: e.target.value }); }} aria-label="Severity">
          {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {running
          ? <button class="tbl-btn" onClick={stop}>■ Stop</button>
          : <button class="tbl-btn" onClick={() => start()}>▶ Start</button>
        }
      </div>
      <div class="log-box" ref={boxRef}>
        {logs.length === 0
          ? <span class="log-empty">{running ? 'Waiting for logs…' : 'Stopped.'}</span>
          : logs.map(l => (
              <div key={l.id} class={`log-line log-${sev(l.priority)}`}>
                <span class="log-time">{(l.time || '').slice(0, 19).replace('T', ' ')}</span>
                <span class="log-unit">[{l.unit || l.source}]</span>
                <span class="log-msg">{l.message}</span>
              </div>
            ))
        }
      </div>
    </div>
  );
}
