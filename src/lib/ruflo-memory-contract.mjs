// Which Ruflo interface reads which project-memory file, bound to the exact
// release and platform where that was observed. Anything else is not evidence
// of a fix or of a regression, so callers fall back to "unverified".
//
// Observed (issue #213): `ruflo memory ...` resolves its file with --path, then
// CLAUDE_FLOW_DB_PATH, then the memory root, and lands in memory.db (a CLI store
// is also mirrored into agentdb-memory.db); the MCP memory_* handlers pass no
// path and, with the native bridge, use agentdb-memory.db only. So a CLI write is
// visible to MCP and an MCP write is not visible to a CLI read.
// Evidence:
//   3.42.4 darwin — the memory-routes proof and hand-run cross-process probes, plus
//     that release's source (2026-09-20).
//   3.45.0 darwin — the memory-routes proof's own environment in a disposable project
//     (2026-09-26): CLI store → both files; MCP store → agentdb-memory.db, backend
//     "sqlite (bridge, brute-force cosine)"; MCP read of the CLI key found it; CLI
//     read of the MCP key "Key not found" plus Ruflo's warning naming the unread
//     sibling. Source: memory-initializer.js resolveDbPath/getMemoryRoot and
//     memory-bridge.js getAgentDbPath.
// Ruflo 3.39.2 behaved differently (a CLI write was not visible to MCP), so
// neighbouring releases are NOT inferred. Without the native bridge (default on
// Windows, or after an init failure) MCP falls back to memory.db, which is why
// the claim names the bridge and why Windows and Linux are unobserved.
// Add a pair only after `ak status --refresh=live --only memory-routes` shows
// the same routing there.
// scripts/ruflo-memory-routing-repro.mjs reproduces it through the public CLI and
// MCP server only, for an upstream-shareable record.
import { installedVersion } from './versions.mjs';

export const OBSERVED_ROUTING = Object.freeze([
  Object.freeze({ version: '3.42.4', platform: 'darwin' }),
  Object.freeze({ version: '3.45.0', platform: 'darwin' }),
]);

/** The @claude-flow/cli that decides routing floats under the `ruflo` wrapper,
 *  so gate on it rather than on the wrapper's own version. */
export function installedRoutingVersion() {
  return installedVersion('ruflo/node_modules/@claude-flow/cli') ?? installedVersion('@claude-flow/cli');
}

export function memoryRoutingObserved(cliVersion, platform = process.platform) {
  // Exact equality is the whole gate: a prerelease, build tag or malformed value can never equal an observed release.
  return OBSERVED_ROUTING.some((seen) => seen.version === cliVersion && seen.platform === platform);
}

export function twoStoreMessage(cliVersion, platform = process.platform) {
  if (!memoryRoutingObserved(cliVersion, platform)) {
    return 'two project memory stores coexist; preserve both. CLI --path selects a store; '
      + 'MCP routing needs separate verification. See Troubleshooting: Ruflo memory stores and routing';
  }
  return 'two project memory stores coexist; preserve both. With the native bridge, CLI memory commands read '
    + 'memory.db and MCP memory tools use agentdb-memory.db, so a read through one does not cover the other; '
    + 'CLI --path selects the other store. `ak status --refresh=live --only memory-routes` observes this for the installed Ruflo. '
    + 'See Troubleshooting: Ruflo memory stores and routing';
}
