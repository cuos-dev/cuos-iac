import { useEffect, useRef, useState } from 'preact/hooks';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

const META = {
  cuos_cpu_usage:    { label: 'CPU %',  color: '#BA7517' },
  cuos_ram_percent:  { label: 'RAM %',  color: '#378ADD' },
  cuos_disk_percent: { label: 'Disk %', color: '#1D9E75' },
};

function UChart({ values, color, label }) {
  const el = useRef(null);
  useEffect(() => {
    if (!el.current || !values?.length) return;
    const u = new uPlot({
      width: 220, height: 80,
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      series: [{}, { label, stroke: color, width: 1.5, fill: color + '28' }],
    }, [values.map(([t]) => Number(t)), values.map(([, v]) => parseFloat(v))], el.current);
    return () => u.destroy();
  }, [values]);
  if (!values?.length) return <span class="muted" style="font-size:11px">no data</span>;
  return <div ref={el} />;
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
                <UChart values={values} color={META[metric]?.color} label={META[metric]?.label} />
              </div>
            ))
        }
      </div>
    </div>
  );
}
