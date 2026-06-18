import { fmt } from '../../lib/fmt.js';

export default function IaCCard({ appState = {}, config = {} }) {
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title"><i class="ti ti-git-branch" /> IaC</div>
        <span class="section-badge">Manager</span>
      </div>
      <div class="card-body" style="padding:14px 18px;">
        <Row k="Started" v={fmt(appState.iac_started)} />
        <div class="info-row">
          <span class="info-key">Repo URL</span>
          <span class="info-val truncate" title={config.iac_repo_url}>{config.iac_repo_url || '—'}</span>
        </div>
        <Row k="Branch" v={config.iac_repo_branch || appState.iac_branch || '—'} />
        <div class="info-row">
          <span class="info-key">Commit</span>
          <span class="info-val">
            {appState.commit
              ? <span class="commit-hash">{appState.commit.slice(0, 8)}</span>
              : '—'}
          </span>
        </div>
        <Row k="Repo updated" v={fmt(appState.last_iac_update_check)} />
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
