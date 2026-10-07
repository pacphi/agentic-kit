// Whether ak manages a host — one vocabulary for every surface (ADR-0053,
// 2026-09-26 amendment). "Managed" is persisted intent: kit.json
// `integrations.hosts[id]` is on. It is a management fact, never a health
// verdict: a host ak does not manage can be installed and perfectly healthy.
// `ak status` rows, `ak host status`, `ak about` and the dashboard (header
// pill, health details, About, Hosts & Routing) all render these words.

import { HOST_REGISTRY } from './adapters/registries.mjs';

export const HOST_MANAGEMENT_LABELS = Object.freeze({
  managed: 'Managed by ak',
  found: 'Found, not managed',
  'not-installed': 'Not installed',
  // Presence could not be established (the PATH lookup itself failed), so
  // neither "found" nor "not installed" may be claimed.
  unassessed: 'Not managed',
});

// Participation = ak's per-activity routing policy may target the host: the
// dual-host routes, the AQE agent routes ak projects, and `ak run` pipelines
// (routes to an unmanaged host are pruned; routing.mjs pruneRoutesForHosts).
// The AQE provider chain, qe-court's own config and Ruflo's dual-mode skills
// are separate and can still call an installed host; they are not claimed.
export const NOT_PARTICIPATING = 'not participating: ak routes no work to this host';

/**
 * @param {{ enabled: boolean|null|undefined, present: boolean|string|null|undefined }} input
 *   `present` is true/false, or 'found'/'absent' from the readiness probe;
 *   anything else means presence was not established.
 * @returns {{ state: 'managed'|'found'|'not-installed'|'unassessed', label: string }}
 */
export function hostManagement({ enabled, present }) {
  /** @type {'managed'|'found'|'not-installed'|'unassessed'} */
  const state = enabled === true ? 'managed'
    : present === true || present === 'found' ? 'found'
      : present === false || present === 'absent' ? 'not-installed' : 'unassessed';
  return { state, label: HOST_MANAGEMENT_LABELS[state] };
}

/** The enabled set exactly as `ak host pick` reads it when `--host` is omitted:
 *  every truthy `integrations.hosts` key the host registry knows. A leftover key
 *  for an id the registry does not know (a retired external host) stays on disk
 *  but is not an enabled host, so it cannot block a provider-only retune. */
export function enabledHostIds(cfg) {
  const known = new Set(HOST_REGISTRY.map((host) => host.id));
  return Object.entries(cfg?.integrations?.hosts ?? {}).filter(([id, on]) => on && known.has(id)).map(([id]) => id);
}

const CANONICAL = ['claude', 'codex', 'opencode'];
const rank = (id) => { const i = CANONICAL.indexOf(id); return i < 0 ? CANONICAL.length : i; };

/** A copyable command that adds `host` to management. `pick --host` takes the
 *  COMPLETE desired set and disables anything left out, so the hint names every
 *  currently enabled host plus this one — never just the new host. Text only:
 *  no surface runs it for the user. */
export function hostEnableCommand(cfg, host) {
  const ids = [...new Set([...enabledHostIds(cfg), host])];
  ids.sort((a, b) => rank(a) - rank(b));
  return `ak host pick --host ${ids.join(',')}`;
}
