// Heal actions — the mutations `sync` applies. Each returns
// {ok, detail} and is idempotent. Ports of: ruflo-patch-native,
// _ruflo_ensure_aidefence, _ruflo_aqe_ensure_native, _ruflo_aqe_ensure_ruvector_native,
// the package-upgrade step (with the npm >=11.17 allow-scripts handling verified
// on the 2026-07-14 upgrade), and the RVF quarantine.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';
import { rufloRoot, aqeRoot } from './paths.mjs';
import { agentdbLocations, bsq3IsNative, aidefencePresent } from './natives.mjs';
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

/** Native better-sqlite3 into every agentdb location that lacks it. */
export async function healNatives() {
  const details = [];
  for (const dir of agentdbLocations()) {
    // Re-check right before installing: an upgrade earlier in the same sync
    // can remove a location (e.g. agentic-flow/node_modules/agentdb, gone in
    // the 3.29.0 tree) between enumeration and heal.
    if (!fs.existsSync(dir)) continue;
    if (bsq3IsNative(dir)) continue;
    const r = await npmInstallInto(dir, 'better-sqlite3@^12');
    details.push(`${dir}: ${r.code === 0 && bsq3IsNative(dir)
      ? 'native installed'
      : `FAILED (${(r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200)})`}`);
  }
  if (fs.existsSync(aqeRoot()) && !bsq3IsNative(aqeRoot())) {
    const r = await npmInstallInto(aqeRoot(), 'better-sqlite3@^12');
    details.push(`agentic-qe: ${r.code === 0 && bsq3IsNative(aqeRoot())
      ? 'native installed'
      : `FAILED (${(r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200)})`}`);
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

/** Stop all ruflo daemons before an upgrade (3.27+; best-effort). */
export async function stopAllDaemons() {
  const r = await run('ruflo', ['daemon', 'stop', '--all'], { timeout: 60_000 });
  return { ok: true, detail: r.code === 0 ? 'stopped all' : 'none or unsupported' };
}
