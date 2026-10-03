// SPDX-License-Identifier: Apache-2.0
import { useState } from 'preact/hooks';

export function useAction() {
  const [pending, setPending] = useState(false);
  const [done, setDone]       = useState(false);
  const [error, setError]     = useState(null);

  async function run(url, method = 'POST') {
    setPending(true); setDone(false); setError(null);
    try {
      const r = await fetch(url, { method });
      if (!r.ok) throw new Error(await r.text());
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e) {
      setError(e.message);
      setTimeout(() => setError(null), 4000);
    } finally {
      setPending(false);
    }
  }

  return { run, pending, done, error };
}
