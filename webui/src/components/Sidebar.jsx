// SPDX-License-Identifier: Apache-2.0
import IaCCard       from './cards/IaCCard.jsx';
import NetworkCard   from './cards/NetworkCard.jsx';
import SystemCard    from './cards/SystemCard.jsx';
import ResourcesCard from './cards/ResourcesCard.jsx';
import ActionsCard   from './cards/ActionsCard.jsx';
import FleetCard     from './cards/FleetCard.jsx';
import BackupCard    from './cards/BackupCard.jsx';
import '../style/sidebar.css';

export default function Sidebar({ cuosState, resources = {}, appState = {}, system = {}, fleet, backup, config, ps, sendAction, canAct }) {
  return (
    <div class="sidebar">
      <ResourcesCard resources={resources} />
      {canAct && <ActionsCard sendAction={sendAction} ps={ps} />}
      {backup && <BackupCard backup={backup} sendAction={sendAction} canAct={canAct} />}
      {fleet && <FleetCard fleet={fleet} />}
      <NetworkCard   resources={resources} />
      <SystemCard    system={system} cuosState={cuosState} resources={resources} />
      <IaCCard       appState={appState} config={config} />
    </div>
  );
}
