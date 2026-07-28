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
 *  an unmanaged tool must not cost a probe. */
export async function drift({ force = false } = {}) {
  const installed = installedVersion(RUVECTOR_PKG);
  if (!installed) return classifyDrift({ installed: null, latest: null });
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const cached = cfg.versionCheck?.ruvector ?? {};
  const fresh = !force && cached.last && Date.now() - cached.last < ttlMs;
  let latest = fresh ? cached.latest ?? null : null;
  if (!fresh) {
    latest = await latestVersion(RUVECTOR_PKG);
    cfg.versionCheck = { ...cfg.versionCheck, ruvector: { last: Date.now(), latest } };
    try { saveKitConfig(cfg); } catch { /* read-only envs: next call re-fetches */ }
  }
  return classifyDrift({ installed, latest });
}
