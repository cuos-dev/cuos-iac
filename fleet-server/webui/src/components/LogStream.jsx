import { useEffect, useRef, useState } from 'preact/hooks';

export function LogStream({ device }) {
  const [logs, setLogs]   = useState([]);
  const [running, setRun] = useState(false);
  const [q, setQ]         = useState('');
  const esRef  = useRef(null);
  const boxRef = useRef(null);

  function start(query) {
    esRef.current?.close();
    setLogs([]); setRun(true);
    const qs = query ? `?q=${encodeURIComponent(query)}` : '';
    const es = new EventSource(`/api/logs/${device.id}/stream${qs}`);
    esRef.current = es;
    es.onmessage = e => setLogs(prev => {
      const next = [...prev, JSON.parse(e.data)];
      return next.length > 200 ? next.slice(-200) : next;
    });
    es.onerror = () => { setRun(false); es.close(); };
  }

  function stop() { esRef.current?.close(); setRun(false); }

  useEffect(() => { start(''); return () => esRef.current?.close(); }, [device.id]);

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
          onKeyDown={e => e.key === 'Enter' && start(q)}
          placeholder="LogsQL filter (Enter)…" class="log-filter" />
        {running
          ? <button class="tbl-btn" onClick={stop}>■ Stop</button>
          : <button class="tbl-btn" onClick={() => start(q)}>▶ Start</button>
        }
      </div>
      <div class="log-box" ref={boxRef}>
        {logs.length === 0
          ? <span class="log-empty">{running ? 'Waiting for logs…' : 'Stopped.'}</span>
          : logs.map((l, i) => (
              <div key={i} class="log-line">
                <span class="log-time">{(l._time || '').slice(0, 19).replace('T', ' ')}</span>
                <span class="log-unit">[{l.unit || '?'}]</span>
                <span class="log-msg">{l._msg}</span>
              </div>
            ))
        }
      </div>
    </div>
  );
}
