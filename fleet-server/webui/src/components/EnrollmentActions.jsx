// SPDX-License-Identifier: Apache-2.0
import { useAction } from '../hooks/useAction.js';

// approve / reject for a device that waits at the door; only meaningful for admins
export function ApproveReject({ device: d }) {
  const approve = useAction(), reject = useAction();
  const live = d.enrollment?.request?.live;
  const busy = approve.pending || reject.pending;
  return (
    <div class="action-cell">
      <button class={`tbl-btn primary ${(!live || busy) ? 'disabled' : ''}`} disabled={!live || busy}
        title={live ? 'Let this device in' : 'The device is not connected right now'}
        onClick={() => approve.run(`/api/clients/${d.id}/approve`)}>
        <i class={`ti ${approve.pending ? 'ti-loader-2 spin' : 'ti-check'}`} /> Approve
      </button>
      <button class={`tbl-btn ${busy ? 'disabled' : ''}`} disabled={busy} title="Refuse this request"
        onClick={() => reject.run(`/api/clients/${d.id}/reject`)}>
        <i class="ti ti-x" />
      </button>
    </div>
  );
}
