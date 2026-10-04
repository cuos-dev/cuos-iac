// SPDX-License-Identifier: Apache-2.0
import { fmt } from '../../lib/fmt.js';

export default function SystemCard({ system = {}, cuosState = {}, resources = {} }) {
  const osVersion = cuosState?.os_version ?? cuosState?.version ?? cuosState?.cuos_version;
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-cpu" /> System</div>
      </div>
      <div class="card-body" style="padding:14px 18px;">
        <Row k="Hostname"   v={system.hostname} />
        <Row k="OS state"   v={cuosState?.state} />
        <Row k="OS version" v={osVersion} />
        <Row k="Slot"       v={cuosState?.slot} />
        <Row k="Kernel"     v={system.kernel} />
        <Row k="Uptime"     v={system.uptime} />
        <Row k="Docker"     v={system.docker} />
        <Row k="Virtualization" v={resources.virt_type} />
        <Row k="System start"      v={cuosState?.start_date && fmt(cuosState.start_date)} />
        <Row k="Last OS update"    v={cuosState?.last_update_date && fmt(cuosState.last_update_date)} />
        <Row k="Last update check" v={cuosState?.last_update_check && fmt(cuosState.last_update_check)} />
        <Row k="Update status"     v={cuosState?.update_state} />
      </div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div class="info-row">
      <span class="info-key">{k}</span>
      <span class="info-val">{v || '—'}</span>
    </div>
  );
}
