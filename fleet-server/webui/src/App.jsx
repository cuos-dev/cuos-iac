import { useState } from 'preact/hooks';
import { useFleet } from './hooks/useFleet.js';
import { computeLatest, isOutdated } from './lib/version.js';
import { Topbar } from './components/Topbar.jsx';
import { SummaryCards } from './components/SummaryCards.jsx';
import { DeviceTable } from './components/DeviceTable.jsx';

export function App() {
  const { devices, config, meta, ok } = useFleet();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const latestCuos  = config.latestCuos  || computeLatest(devices, 'cuos_version');
  const latestAgent = config.latestAgent || computeLatest(devices, 'agent_version');

  const online   = devices.filter(d => d.status === 'online').length;
  const offline  = devices.filter(d => d.status === 'offline').length;
  const outdated = devices.filter(d => isOutdated(d.cuos_version, latestCuos) || isOutdated(d.agent_version, latestAgent)).length;
  const updating = devices.filter(d => d.status === 'updating').length;

  return (
    <>
      <Topbar online={online} offline={offline} outdated={outdated} ok={ok} />
      <div class="main">
        <SummaryCards total={devices.length} online={online} offline={offline} outdated={outdated} updating={updating} />
        <DeviceTable
          devices={devices}
          latestCuos={latestCuos}
          latestAgent={latestAgent}
          meta={meta}
          filter={filter}
          search={search}
          onFilter={setFilter}
          onSearch={setSearch}
        />
      </div>
    </>
  );
}
