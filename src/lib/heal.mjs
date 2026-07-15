// Heal actions — the mutations `sync` applies. Each returns
// {ok, detail} and is idempotent. Ports of: ruflo-patch-native,
// _ruflo_ensure_aidefence, _ruflo_aqe_ensure_native, _ruflo_aqe_ensure_ruvector_native,
// the package-upgrade step (with the npm >=11.17 allow-scripts handling verified
// on the 2026-07-14 upgrade), and the RVF quarantine.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';
import { rufloRoot, aqeRoot } from './paths.mjs';
import { agentdbLocations, bsq3IsNative, bsq3Root, aidefencePresent } from './natives.mjs';
import { KIT_PKG } from './versions.mjs';
import { scanRvf, quarantine } from './rvf.mjs';

// Packages whose install scripts must run for natives to build (npm >=11.17
// blocks them by default). Curated on the live 3.28/3.12.2 upgrade.
const ALLOW_SCRIPTS = [
  'ruflo', 'agentic-qe', '@claude-flow/cli', 'better-sqlite3', 'hnswlib-node',
  'agentdb', 'agentic-flow', 'argon2', 'onnxruntime-node', 'sharp', 'protobufjs',
  '@google/genai', 'tldjs', 'vibium',
].join(',');

// NB: `--allow-scripts` is rejected for project-scoped installs (EALLOWSCRIPTS,
// npm >=11.17) — it is a global-install flag only. Plain installs still get
// native better-sqlite3 because 12.x resolves a usable prebuilt without a
// lifecycle script (verified live 2026-07-14).
async function npmInstallInto(dir, spec) {
  return run('npm', ['install', spec, '--no-save', '--no-audit', '--no-fund'],
    { cwd: dir, timeout: 300_000 });
}

const failTail = (r) =>
  `FAILED (${(r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200)})`;

/** Deterministic native better-sqlite3 for one location — an escalation
 *  ladder, verifying after each rung, stopping at the first binding:
 *  1. plain install — enough on npm <11.17, or when npm's content store
 *     already holds a built copy of the exact version (why plain installs
 *     look like they "work": it depends on cache history, not on scripts).
 *  2. npm approve-scripts + rebuild — npm ≥11.17's sanctioned path for the
 *     blocked install script (approve-scripts pins the exact version into
 *     the location's package.json; harmless no-op failure on older npm).
 *     rebuild also recovers a stale half-built build/ dir.
 *  3. run the package's own install script directly — explicit `npm run`
 *     is user-invoked and never gated by allow-scripts. */
export async function ensureNativeBsq3(dir) {
  await npmInstallInto(dir, 'better-sqlite3@^12');
  if (bsq3IsNative(dir)) return { ok: true, how: 'native installed' };
  await run('npm', ['approve-scripts', 'better-sqlite3'], { cwd: dir, timeout: 60_000 });
  let r = await run('npm', ['rebuild', 'better-sqlite3'], { cwd: dir, timeout: 300_000 });
  if (bsq3IsNative(dir)) return { ok: true, how: 'native rebuilt (scripts approved)' };
  const pkgRoot = bsq3Root(dir);
  if (pkgRoot) {
    r = await run('npm', ['run', 'install'], { cwd: pkgRoot, timeout: 300_000 });
    if (bsq3IsNative(dir)) return { ok: true, how: 'native built via package install script' };
  }
  return { ok: false, how: failTail(r) };
}

/** Native better-sqlite3 into every agentdb location that lacks it. */
export async function healNatives() {
  const details = [];
  for (const dir of agentdbLocations()) {
    // Re-check right before installing: an upgrade earlier in the same sync
    // can remove a location (e.g. agentic-flow/node_modules/agentdb, gone in
    // the 3.29.0 tree) between enumeration and heal.
    if (!fs.existsSync(dir)) continue;
    if (bsq3IsNative(dir)) continue;
    details.push(`${dir}: ${(await ensureNativeBsq3(dir)).how}`);
  }
  if (fs.existsSync(aqeRoot()) && !bsq3IsNative(aqeRoot())) {
    details.push(`agentic-qe: ${(await ensureNativeBsq3(aqeRoot())).how}`);
  }
  return { ok: !details.some((d) => d.includes('FAILED')), detail: details.join('; ') || 'already native everywhere' };
}

/** @claude-flow/aidefence back into the ruflo tree (ruvnet/ruflo#2670). */
export async function healAidefence() {
  if (aidefencePresent()) return { ok: true, detail: 'already present' };
  const r = await npmInstallInto(rufloRoot(), '@claude-flow/aidefence');
  return { ok: aidefencePresent(), detail: r.code === 0 ? 'installed (defend functional again)' : r.stderr.slice(0, 200) };
}

/** Optional native sublinear solver for agentic-qe (best-effort). */
export async function healAqeSolver() {
  if (!fs.existsSync(aqeRoot())) return { ok: true, detail: 'agentic-qe not installed' };
  const probe = path.join(aqeRoot(), 'node_modules', '@ruvector', 'solver-node', 'package.json');
  if (fs.existsSync(probe)) return { ok: true, detail: 'already present' };
  const r = await npmInstallInto(aqeRoot(), '@ruvector/solver-node');
  return { ok: true, detail: r.code === 0 ? 'installed' : 'unavailable (TS fallback is fine <50K nodes)' };
}

/** Quarantine corrupt/oversized RVF artifacts in a project. */
export function healRvf(projectAqeDir) {
  const findings = scanRvf(projectAqeDir);
  const removed = findings.flatMap((f) => quarantine(f));
  return { ok: true, detail: removed.length ? `quarantined: ${removed.join(', ')}` : 'healthy' };
}

/** Upgrade a global package to latest (with allow-scripts). */
export async function upgradePackage(pkg) {
  const r = await run('npm', ['install', '-g', `--allow-scripts=${ALLOW_SCRIPTS}`, `${pkg}@latest`],
    { timeout: 600_000 });
  return { ok: r.code === 0, detail: r.code === 0 ? 'upgraded' : r.stderr.split('\n').slice(-3).join(' ') };
}

/** Upgrade the kit itself to a pinned version. Runs LAST in sync: npm
 *  replaces the kit's files on disk, so the new code applies from the next
 *  ak invocation — never mid-run. Pinning the exact version (not a dist-tag)
 *  installs precisely what the drift check saw. */
export async function selfUpdate(version) {
  const r = await run('npm', ['install', '-g', `${KIT_PKG}@${version}`], { timeout: 300_000 });
  return {
    ok: r.code === 0,
    detail: r.code === 0
      ? `kit upgraded to ${version} (applies from the next ak run)`
      : `FAILED (${(r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200)})`,
  };
}

/** Stop all ruflo daemons before an upgrade (3.27+; best-effort). */
export async function stopAllDaemons() {
  const r = await run('ruflo', ['daemon', 'stop', '--all'], { timeout: 60_000 });
  return { ok: true, detail: r.code === 0 ? 'stopped all' : 'none or unsupported' };
}
