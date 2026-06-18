import IaCCard       from './cards/IaCCard.jsx';
import NetworkCard   from './cards/NetworkCard.jsx';
import SystemCard    from './cards/SystemCard.jsx';
import ResourcesCard from './cards/ResourcesCard.jsx';
import ActionsCard   from './cards/ActionsCard.jsx';
import '../style/sidebar.css';

export default function Sidebar({ cuosState, resources = {}, appState = {}, system = {}, config, ps, sendAction }) {
  return (
    <div class="sidebar">
      <IaCCard       appState={appState} config={config} />
      <NetworkCard   resources={resources} />
      <SystemCard    system={system} cuosState={cuosState} />
      <ResourcesCard resources={resources} />
      <ActionsCard   sendAction={sendAction} ps={ps} />
    </div>
  );
}
