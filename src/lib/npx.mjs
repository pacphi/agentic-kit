// Stale npx-cache detection for the ruflo family. npx envs (`<npm-cache>/_npx/
// <hash>/`) are snapshots keyed by requested spec: once `npx @claude-flow/cli`
// caches a version, `--prefer-offline` serves that copy forever — upgrading the
// global install never touches it. That is how a machine running a fixed ruflo
// 3.32.2 kept executing a cached 3.28.0 (statusline npx fallback) and rendering
// its fabricated CVE counter; six such envs held ~6.4 GB of retired code.
//
// Prune rule — conservative by construction, a miss only means "not pruned":
//   · every package the env is keyed to (its package.json dependencies) must be
//     kit-managed — an env we can't fully judge is left alone;
//   · each managed package needs an installed global baseline to compare against
//     — no baseline, no judgement, no prune;
//   · at least one cached copy must be STRICTLY older than its baseline
//     (equal-or-newer stays: a current cache is what a pre-install machine's
//     npx fallback runs).
// Envs are pure caches; npx re-fetches on demand, so removal is always safe.
import fs from 'node:fs';
import path from 'node:path';
import { npxCacheDir, rufloNodeModules } from './paths.mjs';
import { installedVersion, cmpVersions } from './versions.mjs';

const readPkg = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
};

/** Installed baseline per managed package. @claude-flow/cli is ruflo's NESTED
 *  dependency (never a top-level global), so it can't go through
 *  installedVersion — the same layout fact behind the statusline bin fix. */
export function managedBaseline(pkg) {
  if (pkg === '@claude-flow/cli') {
    return readPkg(path.join(rufloNodeModules(), '@claude-flow', 'cli'))?.version ?? null;
  }
  if (pkg === 'ruflo' || pkg === 'agentic-qe') return installedVersion(pkg);
  return null; // not a package the kit manages — never judged, never pruned
}

/** Stale envs under the npx cache. Returns [{dir, stale: [{pkg, cached, installed}]}].
 *  `root`/`baseline` are injectable so tests run against fixtures, no real cache. */
export function scanNpxStale({ root = npxCacheDir(), baseline = managedBaseline } = {}) {
  let entries;
  try { entries = fs.readdirSync(root); } catch { return []; } // no cache dir: nothing to do
  const out = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    const keyed = readPkg(dir)?.dependencies;
    const pkgs = keyed ? Object.keys(keyed) : [];
    if (!pkgs.length) continue;
    const judged = pkgs.map((pkg) => ({
      pkg,
      installed: baseline(pkg),
      cached: readPkg(path.join(dir, 'node_modules', pkg))?.version ?? null,
    }));
    // One unjudgeable package (unmanaged, no baseline, unreadable copy) exempts
    // the whole env — partial verdicts are how wrong prunes happen.
    if (judged.some((j) => !j.installed || !j.cached)) continue;
    const stale = judged.filter((j) => cmpVersions(j.cached, j.installed) < 0);
    if (stale.length) out.push({ dir, stale });
  }
  return out;
}

/** Remove stale envs. Returns {ok, detail}; ok=false only on a failed removal.
 *  @param {{ root?: string, baseline?: (pkg: string) => string | null }} [opts] */
export function pruneNpxStale({ root, baseline } = {}) {
  const found = scanNpxStale({ ...(root && { root }), ...(baseline && { baseline }) });
  if (!found.length) return { ok: true, detail: 'no stale envs' };
  const removed = []; const failed = [];
  for (const e of found) {
    const label = e.stale.map((s) => `${s.pkg}@${s.cached}`).join('+');
    try { fs.rmSync(e.dir, { recursive: true, force: true }); removed.push(label); } catch { failed.push(label); }
  }
  const parts = [];
  if (removed.length) parts.push(`pruned ${removed.length} env(s): ${removed.join(', ')} (npx re-fetches on demand)`);
  if (failed.length) parts.push(`FAILED to remove: ${failed.join(', ')}`);
  return { ok: !failed.length, detail: parts.join('; ') };
}
