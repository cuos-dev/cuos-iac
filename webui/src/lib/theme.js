// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect } from 'preact/hooks';

// pref: 'system' | 'light' | 'dark'; the resolved theme goes to <html data-theme>.
const KEY = 'cuos-theme';
const ORDER = ['system', 'light', 'dark'];
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function readPref() {
  try { const v = localStorage.getItem(KEY); return ORDER.includes(v) ? v : 'system'; } catch { return 'system'; }
}

function apply(pref) {
  const dark = pref === 'dark' || (pref === 'system' && !!mq?.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

export function useTheme() {
  const [pref, setPref] = useState(readPref);

  useEffect(() => {
    apply(pref);
    if (pref !== 'system' || !mq) return;
    const onChange = () => apply('system');   // follow the OS while on "system"
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    try { localStorage.setItem(KEY, next); } catch {}
    setPref(next);
  }

  return { pref, cycle };
}
