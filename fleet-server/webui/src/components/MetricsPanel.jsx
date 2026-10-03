import { useEffect, useRef, useState } from 'preact/hooks';
import uPlot from 'uplot';
import { useResolvedTheme } from '../lib/theme.js';
import 'uplot/dist/uPlot.min.css';

const META = {
  cuos_cpu_usage:    { label: 'CPU %',  color: '#BA7517' },
  cuos_ram_percent:  { label: 'RAM %',  color: '#378ADD' },
  cuos_disk_percent: { label: 'Disk %', color: '#1D9E75' },
};

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const pad = n => String(n).padStart(2, '0');

function UChart({ values, color, label, range }) {
  const el = useRef(null);
  const theme = useResolvedTheme();   // redraw when the theme changes
  useEffect(() => {
    if (!el.current || !values?.length) return;
    const muted = css('--text-muted', '#7A928B'), grid = css('--border', '#DDE8E5');
    const time = range === '7d'
      ? t => { const d = new Date(t * 1000); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`; }
      : t => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const axis = { stroke: muted, font: '10px DM Mono, monospace', grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 } };
    const u = new uPlot({
      width: Math.max(160, el.current.clientWidth), height: 100,
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      scales: { y: { range: [0, 100] } },
      axes: [{ ...axis, size: 26, values: (_, ticks) => ticks.map(time) }, { ...axis, size: 42, values: (_, ticks) => ticks.map(v => v + '%') }],
      series: [{}, { label, stroke: color, width: 1.5, fill: color + '28' }],
    }, [values.map(([t]) => Number(t)), values.map(([, v]) => parseFloat(v))], el.current);
    const ro = new ResizeObserver(() => u.setSize({ width: Math.max(160, el.current.clientWidth), height: 100 }));
    ro.observe(el.current);
    return () => { ro.disconnect(); u.destroy(); };
  }, [values, theme]);
  if (!values?.length) return <span class="muted" style="font-size:11px">no data</span>;
  return <div ref={el} class="chart-box" />;
}

export function MetricsPanel({ deviceId }) {
  const [range, setRange] = useState('1h');
  const [data, setData]   = useState(null);

  useEffect(() => {
    setData(null);
    fetch(`/api/metrics/${deviceId}?range=${range}`)
      .then(r => r.json()).then(setData).catch(() => setData([]));
  }, [deviceId, range]);

  return (
    <div class="metrics-panel">
      <div class="metrics-header">
        <span>Metrics history</span>
        {['1h', '24h', '7d'].map(r => (
          <button key={r} class={`ftab ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>{r}</button>
        ))}
      </div>
      <div class="metrics-charts">
        {data === null
          ? <span class="muted">Loading…</span>
          : data.map(({ metric, values }) => (
              <div key={metric} class="chart-wrap">
                <div class="chart-label">{META[metric]?.label || metric}</div>
                <UChart values={values} color={META[metric]?.color} label={META[metric]?.label} range={range} />
              </div>
            ))
        }
      </div>
    </div>
  );
}
