// Native-dependency health for the global ruflo/agentic-qe trees: better-sqlite3
// native bindings in every agentdb location (the historical WASM-fallback bug —
// root-fixed upstream since 3.10.6 #2219, but npm >=11.17 allow-scripts can still
// skip native builds on upgrade), and the @claude-flow/aidefence presence that
// `security defend` needs (dropped from the 3.28 tree — ruvnet/ruflo#2670).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { rufloNodeModules, aqeRoot } from './paths.mjs';

/** agentdb locations under the global ruflo tree (mirrors ruflo-patch-native). */
export function agentdbLocations() {
  const base = rufloNodeModules();
  return ['agentdb', path.join('agentic-flow', 'node_modules', 'agentdb')]
    .map((rel) => path.join(base, rel))
    .filter((p) => fs.existsSync(p));
}

/** Does better-sqlite3, as resolved from `fromDir` (real Node resolution),
 *  have a native binding? Mirrors ruflo-patch-native's check. */
export function bsq3IsNative(fromDir) {
  let entry;
  try {
    const req = createRequire(path.join(fromDir, 'noop.js'));
    entry = req.resolve('better-sqlite3'); // …/better-sqlite3/lib/index.js
  } catch {
    return false; // not resolvable at all
  }
  const pkgRoot = path.join(entry.slice(0, entry.lastIndexOf(`${path.sep}better-sqlite3${path.sep}`)), 'better-sqlite3');
  return fs.existsSync(path.join(pkgRoot, 'build', 'Release', 'better_sqlite3.node'));
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
