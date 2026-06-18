import { useState, useEffect } from 'preact/hooks';
import { useWebSocket }  from './hooks/useWebSocket.js';
import { setFmtConfig }  from './lib/fmt.js';
import Topbar            from './components/Topbar.jsx';
import UpdatePanel       from './components/UpdatePanel.jsx';
import ContainersPanel   from './components/ContainersPanel.jsx';
import LogsPanel         from './components/LogsPanel.jsx';
import Sidebar           from './components/Sidebar.jsx';

export default function App() {
  const { state, logs, connected, sendAction } = useWebSocket();
  const { cuosState, resources, ps, appState, progress, system } = state ?? {};
  const [config, setConfig] = useState({});

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(cfg => { setFmtConfig(cfg); setConfig(cfg); })
      .catch(() => {});
  }, []);

  return (
    <>
      <Topbar hostname={system?.hostname} iacState={appState?.iac_state} connected={connected} />
      <div class="layout">
        <UpdatePanel
          appState={appState ?? {}}
          config={config}
          progress={progress}
          sendAction={sendAction}
        />
        <ContainersPanel ps={ps ?? []} sendAction={sendAction} />
        <LogsPanel logs={logs} />
        <Sidebar
          cuosState={cuosState}
          resources={resources ?? {}}
          appState={appState ?? {}}
          system={system ?? {}}
          config={config}
          ps={ps ?? []}
          sendAction={sendAction}
        />
      </div>
    </>
  );
}
