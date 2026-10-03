// SPDX-License-Identifier: Apache-2.0
// What a device announces it shares. (null only for a record that predates the manifest.)
export const sharesOf = d => d.shares ?? { resources: true, iac_state: true, network: 'summary', logs: [], remote_update: true, unknown: true };

export const canRemoteUpdate = d => sharesOf(d).remote_update !== false;
// the log sources a device announced ("iac", "system"); none = nothing is forwarded
export const logSources = d => sharesOf(d).logs ?? [];
export const sharesLogs = d => logSources(d).length > 0;

// every address a device reported, for search and display
export function addressesOf(d) {
  const r = d.metrics?.resources || {};
  const ips = (r.network || []).map(n => (n.ip || '').split('/')[0]).filter(Boolean);
  return [...new Set([r.default_route_ip, ...ips].filter(Boolean))];
}
