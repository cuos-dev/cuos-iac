import { useEffect, useRef, useState } from 'preact/hooks';

export function useFleet() {
  const [devices, setDevices] = useState([]);
  const [config, setConfig]   = useState({ latestCuos: null, latestAgent: null });
  const [meta, setMeta]       = useState(null);
  const [ok, setOk]           = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    fetch('/api/meta')
      .then(r => r.json())
      .then(m => { setMeta(m); connect(m.wsNonce); });
  }, []);

  function connect(nonce) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ui-ws/${nonce}`);
    wsRef.current = sock;
    sock.onopen  = () => setOk(true);
    sock.onclose = () => { setOk(false); setTimeout(() => connect(nonce), 3000); };
    sock.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type !== 'state') return;
      setDevices(m.devices ?? []);
      if (m.config) setConfig(c => ({ ...c, ...m.config }));
    };
  }

  return { devices, config, meta, ok };
}
