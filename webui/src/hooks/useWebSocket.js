// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect, useRef } from 'preact/hooks';

export function useWebSocket() {
  const [state, setState]       = useState(null);
  const [logs, setLogs]         = useState([]);
  const [connected, setConnected] = useState(false);
  const ws      = useRef(null);
  const pending = useRef(new Map()); // id → { resolve, reject }

  useEffect(() => {
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws.current = new WebSocket(`${proto}://${location.host}/ws`);
      ws.current.onopen  = () => setConnected(true);
      ws.current.onclose = () => {
        setConnected(false);
        // fail waiting actions now instead of letting them hit the 30s timeout
        for (const p of pending.current.values()) p.reject(new Error('connection lost'));
        pending.current.clear();
        setTimeout(connect, 3000);
      };
      ws.current.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state')         setState(msg);
        else if (msg.type === 'log_history') setLogs(msg.entries.slice(-200));
        else if (msg.type === 'log')      setLogs(prev => [...prev, msg].slice(-200));
        else if (msg.type === 'action_result') {
          const p = pending.current.get(msg.id);
          if (p) { pending.current.delete(msg.id); p.resolve(msg); }
        }
      };
    }
    connect();
    return () => ws.current?.close();
  }, []);

  function sendAction(command, params = {}) {
    return new Promise((resolve, reject) => {
      if (ws.current?.readyState !== 1) return reject(new Error('not connected'));
      const id = Math.random().toString(36).slice(2);
      pending.current.set(id, { resolve, reject });
      ws.current?.send(JSON.stringify({ type: 'action', id, command, ...params }));
      // ponytail: 30s hard timeout; upgrade to per-command timeouts if needed
      setTimeout(() => {
        if (!pending.current.has(id)) return;
        pending.current.delete(id);
        reject(new Error('action timeout'));
      }, 30000);
    });
  }

  return { state, logs, connected, sendAction };
}
