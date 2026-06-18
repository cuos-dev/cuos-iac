import { useState } from 'preact/hooks';

export function useAction(sendAction) {
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);

  async function run(command, params = {}) {
    setLoading(true); setResult(null);
    try {
      const r = await sendAction(command, params);
      setResult(r.result ?? r.error ?? r);
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setLoading(false);
    }
  }

  return { run, loading, result, clear: () => setResult(null) };
}
