// RuVector CLI — drift detection for a global `ruvector` install ak does NOT own.
//
// Unlike ruflo/agentic-qe/the host CLIs, ruvector is not part of ak's managed set:
// users register it as an MCP server by hand, and a stale global then serves stale
// tools with nothing reporting it. So this is DETECTION + OPT-IN UPGRADE ONLY —
// presence is never nudged, and an absent ruvector produces no rows and no plan.
// Shaped after ruvnet-brain.mjs (present / classifyDrift / TTL-cached drift), but
// ruvector IS a plain npm global, so the version primitives come from versions.mjs
// rather than a parallel filesystem/GitHub-releases path.
import { installedVersion, latestVersion, cmpVersions } from './versions.mjs';
import { loadKitConfig, saveKitConfig } from './config.mjs';
import { ruvectorRegistered } from './mcp.mjs';

export const RUVECTOR_PKG = 'ruvector';

/** Installed globally? Detection only — ak never installs ruvector. */
export function present() {
  return !!installedVersion(RUVECTOR_PKG);
}

/** May ak keep this global current? Registration IS the opt-in — a user who
 *  wired the MCP server up by hand has signalled they depend on the tool — and
 *  `kit.json ruvector:false` is the escape hatch (mirrors ruvnetBrain/aqe/agentdb).
 *  Both must hold: ak never touches a global nobody asked it to manage. */
export function managed(cfg = loadKitConfig()) {
  return cfg.ruvector !== false && ruvectorRegistered();
}

/** Pure drift classifier. `latest` null (offline / npm unreachable) is always
 *  "unknown", never "outdated" — mirrors ruvnet-brain's classifyDrift. */
export function classifyDrift({ installed, latest }) {
  if (!installed) return { present: false, outdated: false, installed: null, latest: latest ?? null };
  return {
    present: true,
    outdated: !!(latest && cmpVersions(latest, installed) > 0),
    installed,
    latest: latest ?? null,
  };
}

/** Installed-vs-latest, TTL-cached in kit.json alongside the other version
 *  windows, so status/dashboard hit npm at most once per window. force=true
 *  bypasses the cache. Skips the network entirely when ruvector is absent —
 *  an unmanaged tool must not cost a probe. A failed lookup never erases a
 *  good one: the recorded latest (and `observedAt`, when it was seen) stays
 *  and is reported as a cache fallback, and `last` is restamped so the next
 *  lookup waits one TTL window (`force` retries sooner). cacheOnly=true
 *  reports the recorded latest with no network and no write (`ak sync --skip
 *  ruvector`); record=false looks it up without saving anything (`ak sync
 *  --dry-run`, ADR-0063).
 *  @param {{ force?: boolean, cacheOnly?: boolean, record?: boolean,
 *   fetchLatest?: (pkg: string, tag?: string) => Promise<string | null> }} [opts] */
export async function drift({ force = false, cacheOnly = false, record = true, fetchLatest = latestVersion } = {}) {
  const installed = installedVersion(RUVECTOR_PKG);
  if (!installed) return classifyDrift({ installed: null, latest: null });
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const cached = cfg.versionCheck?.ruvector ?? {};
  const fresh = !force && cached.last && Date.now() - cached.last < ttlMs;
  const recorded = (latestSource) => ({ ...classifyDrift({ installed, latest: cached.latest ?? null }), latestSource });
  if (fresh) return recorded('cache');
  if (cacheOnly) return recorded('cache-fallback');
  const latest = await fetchLatest(RUVECTOR_PKG);
  const now = Date.now();
  const save = (entry) => {
    cfg.versionCheck = { ...cfg.versionCheck, ruvector: { ...entry, last: now } };
    try { saveKitConfig(cfg); } catch { /* read-only envs: next call re-fetches */ }
  };
  if (!latest) {
    if (record) save({ ...cached, observedAt: cached.observedAt ?? cached.last });
    return recorded('cache-fallback');
  }
  if (record) save({ latest, observedAt: now });
  return { ...classifyDrift({ installed, latest }), latestSource: 'live' };
}
