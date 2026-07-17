// agentdb — a first-class, folded-in data-plane tool.
//
// agentdb ships TWO ways: (1) as a LIBRARY bundled inside ruflo's tree
// (ruflo/node_modules/agentdb — used programmatically, no CLI), and (2) as a
// standalone npm package `agentdb` whose global bin exposes the CLI
// (`skill consolidate`, `reflexion store`, `skill search`) that `ak x harvest`
// drives. The kit manages the standalone global.
//
// The catch: agentdb is a DATA-PLANE tool — its CLI writes the same cognitive
// store (.rvf / sql.js) that ruflo's bundled agentdb reads and writes. A global
// whose store schema DIVERGES from ruflo's bundled copy is the corruption class
// the kit already firefights (the brain.rvf / FsyncFailed saga). So instead of
// chasing npm-latest, the kit pins the global to ruflo's BUNDLED version — the
// store stays coherent by construction — and the coherence guard warns if they
// ever skew on the core (major.minor.patch) version.
import fs from 'node:fs';
import path from 'node:path';
import { rufloNodeModules } from './paths.mjs';
import { installedVersion } from './versions.mjs';

export const PKG = 'agentdb';

/** Base version (drops any prerelease tail): "3.0.0-alpha.17" → "3.0.0". */
const base = (v) => String(v).split('-')[0];

/** Installed global agentdb version, or null. `agentdb` is a normal global npm
 *  package, so the shared `installedVersion` (globalRoot/pkg/package.json) works. */
export function globalVersion() {
  return installedVersion(PKG);
}

/** The agentdb version ruflo BUNDLES — the schema authority for the shared
 *  store. Null if ruflo isn't installed or its tree lacks agentdb. */
export function bundledVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(rufloNodeModules(), 'agentdb', 'package.json'), 'utf8'),
    ).version;
  } catch {
    return null;
  }
}

/** Is the standalone agentdb CLI installed on the global? */
export function present() {
  return globalVersion() != null;
}

/**
 * Coherence between the managed global and ruflo's bundled agentdb.
 *   skew: null          — identical, or bundled unknown so nothing to compare
 *         'prerelease'  — same core (3.0.0), different prerelease — tolerated
 *         'core'        — different major.minor.patch — STORE-CORRUPTION RISK
 * `ok` is false only for a core skew. `target` is the version the kit installs
 * to (ruflo's bundled version; null when unknown → caller falls back to latest).
 */
export function classifyCoherence({ global, bundled }) {
  if (!global) return { present: false, ok: true, global: null, bundled: bundled ?? null, skew: null, target: bundled ?? null };
  if (!bundled) return { present: true, ok: true, global, bundled: null, skew: null, target: null };
  if (base(global) !== base(bundled)) {
    return { present: true, ok: false, global, bundled, skew: 'core', target: bundled };
  }
  const skew = global === bundled ? null : 'prerelease';
  return { present: true, ok: true, global, bundled, skew, target: bundled };
}

export function coherence() {
  return classifyCoherence({ global: globalVersion(), bundled: bundledVersion() });
}

/** The version the kit should install/repair the global TO: ruflo's bundled
 *  version (keeps the store coherent), or null when bundled is unknown. */
export function targetVersion() {
  return bundledVersion();
}
