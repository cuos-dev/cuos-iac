// What a device announces it shares (protocol 2). null = a protocol 1 agent: it sends everything.
export const sharesOf = d => d.shares ?? { resources: true, iac_state: true, network: 'full', logs: null, remote_update: true, legacy: true };

export const canRemoteUpdate = d => sharesOf(d).remote_update !== false;
// logs: true/false from a v2 agent, null (unknown) from a v1 agent: show the panel, it may have data
export const sharesLogs = d => sharesOf(d).logs !== false;

// every address a device reported, for search and display
export function addressesOf(d) {
  const r = d.metrics?.resources || {};
  const ips = (r.network || []).map(n => (n.ip || '').split('/')[0]).filter(Boolean);
  return [...new Set([r.default_route_ip, ...ips].filter(Boolean))];
}
