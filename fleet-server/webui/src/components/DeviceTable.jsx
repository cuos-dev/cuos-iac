// SPDX-License-Identifier: Apache-2.0
import { useState } from 'preact/hooks';
import { isOutdated } from '../lib/version.js';
import { hasProblem, hasRequest } from '../lib/status.js';
import { addressesOf } from '../lib/shares.js';
import { DeviceRow } from './DeviceRow.jsx';

const PAGE_SIZE = 15;
const FILTERS   = ['all', 'online', 'offline', 'problems', 'pending', 'outdated'];
// 'name' keeps rows where they are; 'attention' floats problems, then offline, then updating to the top
const rank = d => hasProblem(d) ? 0 : d.status === 'offline' ? 1 : d.status === 'updating' ? 2 : 3;
const SORTS = {
  name:      (a, b) => (a.hostname || a.id).localeCompare(b.hostname || b.id, undefined, { numeric: true }),
  attention: (a, b) => rank(a) - rank(b) || SORTS.name(a, b),
};

export function DeviceTable({ devices, latestCuos, latestAgent, meta, canAct, filter, search, onFilter, onSearch }) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState('name');

  const filtered = devices.filter(d => {
    if (filter === 'online'   && d.status !== 'online') return false;
    if (filter === 'offline'  && d.status !== 'offline') return false;
    if (filter === 'problems' && !hasProblem(d)) return false;
    if (filter === 'pending'  && !hasRequest(d)) return false;
    if (filter === 'outdated' && !isOutdated(d.cuos_version, latestCuos) && !isOutdated(d.agent_version, latestAgent)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (d.hostname || '').toLowerCase().includes(q)
          || (d.id || '').toLowerCase().includes(q)
          || addressesOf(d).some(ip => ip.includes(q));
    }
    return true;
  });

  filtered.sort(SORTS[sort]);
  const waiting  = devices.filter(hasRequest).length;
  const pages    = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const p        = Math.min(page, pages - 1);
  const pageRows = filtered.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
  const from     = filtered.length === 0 ? 0 : p * PAGE_SIZE + 1;
  const to       = Math.min(p * PAGE_SIZE + PAGE_SIZE, filtered.length);

  function setFilter(f) { onFilter(f); setPage(0); }
  function setSearch(v) { onSearch(v); setPage(0); }

  return (
    <div class="table-card">
      {waiting > 0 && filter !== 'pending' && (
        <div class="pending-banner" role="status">
          <i class="ti ti-user-question" /> {waiting === 1 ? '1 device is' : `${waiting} devices are`} waiting for approval
          <button class="tbl-btn" onClick={() => setFilter('pending')}>Show</button>
        </div>
      )}
      <div class="table-toolbar">
        <div class="toolbar-title"><i class="ti ti-devices" /> Devices</div>
        <div class="filter-tabs">
          {FILTERS.map(f => (
            <button key={f} class={`ftab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <select class="sort-select" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort devices">
          <option value="name">Sort: name</option>
          <option value="attention">Sort: attention first</option>
        </select>
        <div class="search-box">
          <i class="ti ti-search" />
          <input type="text" placeholder="Search hostname, IP, ID…" value={search}
            onInput={e => setSearch(e.target.value)} />
        </div>
      </div>

      <div style="overflow-x:auto">
        <table class="fleet-table">
          <thead>
            <tr>
              <th style="width:200px">Device</th>
              <th style="width:90px">Status</th>
              <th style="width:95px">CuOS ver.</th>
              <th style="width:95px" class="col-agent">Agent ver.</th>
              <th style="width:115px" class="col-ip">IP address</th>
              <th style="width:150px" class="col-iac">IaC state</th>
              <th style="width:135px" class="col-backup">Backup</th>
              <th style="width:135px" class="col-cpu">CPU / RAM / Disk</th>
              <th style="width:80px" class="col-uptime">Uptime</th>
              <th style="width:90px">Last seen</th>
              <th style="width:145px">{canAct ? 'Actions' : 'Details'}</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0
              ? <tr><td colspan="11" class="empty-row">No devices match filter</td></tr>
              : pageRows.map(d => (
                  <DeviceRow key={d.id} device={d} latestCuos={latestCuos} latestAgent={latestAgent} meta={meta} canAct={canAct} />
                ))
            }
          </tbody>
        </table>
      </div>

      <div class="pagination">
        <span>Showing {from}–{to} of {filtered.length} devices</span>
        <div class="page-btns">
          {Array.from({ length: pages }, (_, i) => (
            <button key={i} class={`page-btn ${i === p ? 'active' : ''}`} onClick={() => setPage(i)}>{i + 1}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
