// SPDX-License-Identifier: Apache-2.0
// What this device is willing to tell the fleet server. The owner decides, in system.json:
//
//   "fleet_share": {
//     "resources":     true,        // cpu, ram, disk, uptime
//     "iac_state":     true,        // state, commit, error of the IaC manager
//     "network":       "summary",   // "none" | "summary" (own address and gateway) | "full" (all interfaces, routes, dns, ntp)
//     "logs":          [],          // sources to forward: "iac" (the IaC manager's lines of the CuOS log) and/or
//                                   // "system" (the journal units named in fleet_log_units). Default: nothing.
//     "logs_redact":   { "builtin": true, "ips": false, "patterns": [] }   // see redact.js
//     "remote_update": true         // may the server ask this device to check its repository now
//   }
//
// Nothing outside of this leaves the device, and the resolved choice is announced in client_hello so
// the server and its UI can show what is (not) available. The server scrubs again as a second guard.

const NETWORK_LEVELS = ['none', 'summary', 'full'];

const LOG_SOURCES = ['iac', 'system'];

export function resolveShares(cfg = {}) {
  const s = cfg.fleet_share && typeof cfg.fleet_share === 'object' ? cfg.fleet_share : {};
  const units = Array.isArray(cfg.fleet_log_units) ? cfg.fleet_log_units : [];
  return {
    resources: s.resources !== false,
    iac_state: s.iac_state !== false,
    network: NETWORK_LEVELS.includes(s.network) ? s.network : 'summary',
    // only sources the owner names; anything else (true, typos, "all") shares nothing. "system" needs units to read.
    logs: LOG_SOURCES.filter(src => (Array.isArray(s.logs) ? s.logs : [s.logs]).includes(src) && (src !== 'system' || units.length > 0)),
    remote_update: s.remote_update !== false,
  };
}

const SUMMARY = ['default_route_ip', 'primary_ip'];   // the gateway and the device's own address
const FULL = [...SUMMARY, 'network', 'dns_servers', 'ntp_servers', 'ntp_service_active', 'ntp_synchronizede', 'routes'];
const LOAD = ['cpu_usage', 'cpu_cores', 'ram_percent', 'mem_used_mb', 'mem_total_mb', 'disk_percent', 'disk_used_mb', 'disk_total_mb', 'uptime_seconds', 'virt_type'];

export function filterResources(resources = {}, shares) {
  const keep = new Set([
    ...(shares.resources ? LOAD : []),
    ...(shares.network === 'full' ? FULL : shares.network === 'summary' ? SUMMARY : []),
  ]);
  return Object.fromEntries(Object.entries(resources).filter(([k]) => keep.has(k)));
}

export const filterAppState = (appState, shares) => (shares.iac_state ? appState : {});
