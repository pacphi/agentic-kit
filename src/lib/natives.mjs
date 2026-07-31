// Native-dependency health for the global ruflo/agentic-qe trees: better-sqlite3
// native bindings in every agentdb location (the historical WASM-fallback bug —
// root-fixed upstream since 3.10.6 #2219, but npm >=11.17 allow-scripts can still
// skip native builds on upgrade), and the @claude-flow/aidefence presence that
// `security defend` needs (dropped from the 3.28 tree — ruvnet/ruflo#2670).
import fs from 'node:fs';
import path from 'node:path';
import { rufloRoot, rufloNodeModules, aqeRoot } from './paths.mjs';
import { run } from './exec.mjs';
import { readJson } from './settings.mjs';

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

// The packages ruflo's memory RUNTIME resolves better-sqlite3 from — not the
// agentdb copies above. @claude-flow/memory is the store; @claude-flow/cli is what
// `npx ruflo memory` runs. #45: these can be WASM-only while the agentdb copy is
// native, so the agentdb-only status was a false positive. Older ruflo trees may
// lack either package — filter to what exists so heal/status skip silently.
export function rufloMemoryContexts() {
  const nm = rufloNodeModules();
  return [
    { context: 'memory', dir: path.join(nm, '@claude-flow', 'memory') },
    { context: 'cli', dir: path.join(nm, '@claude-flow', 'cli') },
  ].filter((c) => fs.existsSync(c.dir));
}

// A PLAIN semver range/version — the only override/dependency form npm install can
// take by value. Reference forms (`$agentdb`) and protocols (workspace:/file:/link:/
// npm:/git+ssh:) are NOT installable specs, so they must be skipped during
// derivation rather than emitted (they'd make npm error). Requires a version digit
// so bare `*`/`latest`/`x` fall through to the caller's fallback.
const isPlainSemver = (v) =>
  typeof v === 'string' && /\d/.test(v) && !v.includes(':') && !v.trimStart().startsWith('$');

// better-sqlite3 first declares/supports Node 26 in 12.10.0. npm treats it as
// optional through agentdb and silently removes 12.9.0 on Node 26 while still
// exiting zero, so a stale exact ruflo override cannot be followed literally.
const nodeCompatibleBsq3Spec = (spec, nodeMajor) => {
  if (nodeMajor < 26) return spec;
  const match = String(spec).match(/(\d+)\.(\d+)(?:\.\d+)?/);
  if (match && Number(match[1]) === 12 && Number(match[2]) < 10) return '^12.10.0';
  return spec;
};

/** The install spec for better-sqlite3 in `dir`, derived from the containing
 *  npm tree. Ancestor overrides win over the nested package's dependency:
 *  ruflo pins 12.x while agentdb still declares optional ^11.8.1, which npm
 *  cannot build on Node 26. Installing from agentdb with the local declaration
 *  therefore installs, fails, and removes 11.x even though the effective ruflo
 *  tree requires 12.x. After overrides, use the target package's own optional
 *  or regular dependency, then fallback. Non-semver forms are skipped. */
export function deriveBsq3Spec(dir, fallback = '^12', nodeMajor = Number(process.versions.node.split('.')[0])) {
  const start = path.resolve(dir);
  let current = start;
  for (;;) {
    const override = readJson(path.join(current, 'package.json'), {})?.overrides?.['better-sqlite3'];
    if (isPlainSemver(override)) return nodeCompatibleBsq3Spec(override, nodeMajor);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const pkg = readJson(path.join(start, 'package.json'), {}) ?? {};
  for (const field of ['optionalDependencies', 'dependencies']) {
    const declared = pkg[field]?.['better-sqlite3'];
    if (isPlainSemver(declared)) return nodeCompatibleBsq3Spec(declared, nodeMajor);
  }
  return nodeCompatibleBsq3Spec(fallback, nodeMajor);
}

// package.json fields that pin better-sqlite3 to a specific spec WITHIN `dir`
// itself (as opposed to an ancestor's override). npm's arborist requires a
// root package's own `overrides`, `optionalDependencies`, and `dependencies`
// entries for the same package to agree with each other AND with whatever
// version an explicit `npm install pkg@spec` in that directory requests
// (EOVERRIDE otherwise) — verified live: bumping only `overrides` to Node
// 26's ^12.10.0 while `optionalDependencies` still said ^12.9.0 traded an
// "explicit install conflicts with override" error for an "override conflicts
// with direct dependency" one. All self-declared fields must move together.
const SELF_SPEC_FIELDS = ['overrides', 'optionalDependencies', 'dependencies'];

/** Fields in `dir`'s OWN package.json that declare a plain-semver spec for
 *  better-sqlite3 different from `spec` — installing `spec` there would trip
 *  npm's EOVERRIDE. Empty array when nothing conflicts (including when the
 *  package declares no such fields at all). */
export function selfSpecConflicts(dir, spec) {
  const pkg = readJson(path.join(path.resolve(dir), 'package.json'), {}) ?? {};
  return SELF_SPEC_FIELDS.filter((field) => {
    const declared = pkg[field]?.['better-sqlite3'];
    return isPlainSemver(declared) && declared !== spec;
  });
}

// A truthful load-test of the binding as node resolution finds it FROM `dir`: an
// ABI-mismatched or absent binding throws on `require` (exactly `ruflo doctor`'s
// "Could not locate the bindings file"), so requiring it, opening :memory:, and
// running SELECT 1 in a child process is the real WASM-vs-native answer — not a
// file-existence guess. Kept in a child process so a broken addon can't crash ak.
const RUNTIME_PROBE =
  "const D=require(require.resolve('better-sqlite3',{paths:[process.argv[1]]}));"
  + "const db=new D(':memory:');const r=db.prepare('SELECT 1 AS ok').get();db.close();"
  + 'process.exit(r&&r.ok===1?0:3);';

/** Load-test better-sqlite3 as resolved from `dir`. Injectable runner keeps the
 *  test spawn-free. Returns {ok} or {ok:false, reason}. */
export async function probeBsq3Runtime(dir, { runner = run } = {}) {
  // Generous timeout for a cold `node` spawn on CI; a real native require returns
  // well under the status budget (probes run in parallel, see rufloRuntimeNatives).
  const r = await runner('node', ['-e', RUNTIME_PROBE, dir], { cwd: dir, timeout: 8000 });
  if (r.code === 0) return { ok: true };
  return { ok: false, reason: (r.stderr || `exit ${r.code}`).trim().split('\n').pop().slice(0, 160) };
}

/** Per-context native-binding truth for ruflo's memory runtime. {installed:false}
 *  when ruflo is absent (EC-1: status/pre-flight skip, never crash). Probes run in
 *  parallel to stay inside the status time budget. */
export async function rufloRuntimeNatives({ runner = run } = {}) {
  let installed;
  try { installed = fs.existsSync(rufloRoot()); } catch { installed = false; }
  if (!installed) return { installed: false, contexts: [] };
  const contexts = await Promise.all(rufloMemoryContexts().map(async ({ context, dir }) => {
    const res = await probeBsq3Runtime(dir, { runner });
    return { context, dir, ok: res.ok, reason: res.reason };
  }));
  return { installed: true, contexts };
}

/** Drift for a CLAUDE_FLOW_DB_PATH pin in .claude/settings.local.json `env`: warn
 *  when the pinned DB's directory is missing OR the path lies outside the project.
 *  Warn-only (the pin may be deliberate); `sync` never touches it. path.relative
 *  for containment so drive-letter/Windows paths compare correctly, not by prefix.
 *  Returns null when there is no pin (EC-4: absent/unparseable settings). */
export function dbPathPinStatus({ settingsLocalFile, projectRoot }) {
  const pinned = readJson(settingsLocalFile)?.env?.CLAUDE_FLOW_DB_PATH;
  if (!pinned) return null;
  if (!fs.existsSync(path.dirname(pinned))) return { warn: true, pinned, reason: 'directory does not exist' };
  const rel = path.relative(projectRoot, pinned);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { warn: true, pinned, reason: 'outside the project root' };
  return { warn: false, pinned };
}

// npm only hoists a @claude-flow/* package to the top of ruflo's node_modules when
// every dependent can share one version; a conflicting sibling (e.g. @claude-flow/cli
// pinning a different range) leaves it nested under that dependent instead. A
// top-level-only check then false-negatives on a package that IS installed — seen
// with @claude-flow/security landing under cli/node_modules instead of hoisting.
// Check the top level plus the known @claude-flow/* dependents (mirrors
// rufloMemoryContexts' consumer list) rather than a full recursive search.
function claudeFlowPackagePresent(name) {
  const nm = rufloNodeModules();
  const roots = [nm, path.join(nm, '@claude-flow', 'cli', 'node_modules')];
  return roots.some((root) => fs.existsSync(path.join(root, '@claude-flow', name, 'package.json')));
}

export const aidefencePresent = () => claudeFlowPackagePresent('aidefence');

export const securityPresent = () => claudeFlowPackagePresent('security');
