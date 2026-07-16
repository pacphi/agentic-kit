// Native-dependency health for the global ruflo/agentic-qe trees: better-sqlite3
// native bindings in every agentdb location (the historical WASM-fallback bug —
// root-fixed upstream since 3.10.6 #2219, but npm >=11.17 allow-scripts can still
// skip native builds on upgrade), and the @claude-flow/aidefence presence that
// `security defend` needs (dropped from the 3.28 tree — ruvnet/ruflo#2670).
import fs from 'node:fs';
import path from 'node:path';
import { rufloNodeModules, aqeRoot } from './paths.mjs';

/** agentdb locations under the global ruflo tree (mirrors ruflo-patch-native). */
export function agentdbLocations() {
  const base = rufloNodeModules();
  return ['agentdb', path.join('agentic-flow', 'node_modules', 'agentdb')]
    .map((rel) => path.join(base, rel))
    .filter((p) => fs.existsSync(p));
}

/** Package root of better-sqlite3 as resolved from `fromDir`, or null if not
 *  found. Walks up the node_modules chain reading disk fresh on every call —
 *  the node resolution equivalent, but WITHOUT createRequire().resolve(), whose
 *  process-wide cache (Module._pathCache/_realpathCache) goes stale after an
 *  in-process `npm install` reshapes the tree. That staleness made `sync`'s
 *  final convergence proof report a false WASM fallback on a location the
 *  earlier heal (and a fresh process) both saw as native. */
export function bsq3Root(fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const cand = path.join(dir, 'node_modules', 'better-sqlite3');
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/** Does better-sqlite3, as resolved from `fromDir`, have a native binding?
 *  Mirrors ruflo-patch-native's check. */
export function bsq3IsNative(fromDir) {
  const root = bsq3Root(fromDir);
  return !!root && fs.existsSync(path.join(root, 'build', 'Release', 'better_sqlite3.node'));
}

export function nativesStatus() {
  const locations = agentdbLocations().map((dir) => ({ dir, native: bsq3IsNative(dir) }));
  const aqe = fs.existsSync(aqeRoot())
    ? { dir: aqeRoot(), native: bsq3IsNative(aqeRoot()) }
    : null;
  return { locations, aqe };
}

export const aidefencePresent = () =>
  fs.existsSync(path.join(rufloNodeModules(), '@claude-flow', 'aidefence', 'package.json'));

export const securityPresent = () =>
  fs.existsSync(path.join(rufloNodeModules(), '@claude-flow', 'security', 'package.json'));
