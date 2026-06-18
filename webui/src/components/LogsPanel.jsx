import { useState, useEffect, useRef } from 'preact/hooks';
import '../style/logs.css';

const FILTERS = ['all', 'os', 'iac', 'err'];

export default function LogsPanel({ logs = [] }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const bodyRef    = useRef(null);
  const atBottom   = useRef(true);

  const filtered = logs.filter(l => {
    if (filter === 'os'  && l.src   !== 'os')  return false;
    if (filter === 'iac' && l.src   !== 'iac') return false;
    if (filter === 'err' && l.level !== 'err') return false;
    if (search && !(l.message || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  function onScroll() {
    const el = bodyRef.current;
    atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  }

  useEffect(() => {
    if (atBottom.current && bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs.length]); // scroll only when new entries arrive, not on filter change

  return (
    <div class="card logs-panel">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-file-description" /> Logs</div>
      </div>
      <div class="logs-toolbar">
        {FILTERS.map(f => (
          <button key={f} class={`logs-filter-btn${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'err' ? 'Errors' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <div class="logs-search">
          <i class="ti ti-search" />
          <input type="text" placeholder="Filter logs…" value={search} onInput={e => setSearch(e.target.value)} />
        </div>
      </div>
      <div class="logs-body" ref={bodyRef} onScroll={onScroll}>
        {filtered.map((l, i) => (
          <div key={i} class="log-entry">
            <span class="log-ts">{(l.date || '').slice(11, 19) || '—'}</span>
            <span class={`log-src src-${l.src || 'os'}`}>{l.src || 'os'}</span>
            <span class={`log-level lvl-${l.level || 'info'}`}>{l.level || 'info'}</span>
            <span class="log-msg">{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
