// SPDX-License-Identifier: Apache-2.0
import { fmt } from '../../lib/fmt.js';

export default function IaCCard({ appState = {}, config = {} }) {
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-git-branch" /> IaC</div>
        <span class="section-badge">Manager</span>
      </div>
      <div class="card-body" style="padding:14px 18px;">
        <div class="info-row">
          <span class="info-key">Repository</span>
          <span class="info-val truncate" title={config.iac_repo_url}>
            {config.iac_repo_url
              ? <a href={config.iac_repo_url} target="_blank" rel="noopener">{config.iac_repo_name || config.iac_repo_url}</a>
              : '—'}
          </span>
        </div>
        <Row k="Manager started" v={fmt(appState.iac_started)} />
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
