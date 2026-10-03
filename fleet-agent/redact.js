// SPDX-License-Identifier: Apache-2.0
// Scrub log lines before they leave the device. The owner can add patterns in system.json:
//
//   "fleet_share": { "logs": ["iac"], "logs_redact": { "builtin": true, "ips": false, "patterns": ["serial=\\w+"] } }
//
// builtin: credentials, tokens, private keys, passwords in URLs (default on)
// ips:     keep only the first three octets of IPv4 addresses (default off: it makes debugging harder)
// patterns: your own regular expressions, replaced by [redacted]

const BUILTIN = [
  [/(authorization:\s*(?:bearer|basic)\s+)[^\s"']+/gi, '$1[redacted]'],
  [/\bft_[A-Za-z0-9_-]{20,}/g, '[redacted-token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted-private-key]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[redacted]@'],
];

export function makeRedactor(opts = {}, warn = () => {}) {
  const rules = [];
  if (opts.builtin !== false) rules.push(...BUILTIN);
  if (opts.ips === true) rules.push([/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g, '$1.x']);
  for (const p of Array.isArray(opts.patterns) ? opts.patterns : []) {
    try { rules.push([new RegExp(p, 'g'), '[redacted]']); } catch { warn(`ignoring invalid logs_redact pattern: ${p}`); }
  }
  return text => rules.reduce((t, [re, to]) => t.replace(re, to), String(text));
}
