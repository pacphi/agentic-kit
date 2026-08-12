// Heal actions — the mutations `sync` applies. Each returns
// {ok, status, usable, detail} and is idempotent. `status` is one of
// ok|degraded|failed|skipped; callers must not infer subsystem health from
// mere on-disk presence after a failed operation. Ports of: ruflo-patch-native,
// _ruflo_ensure_aidefence, _ruflo_aqe_ensure_native, _ruflo_aqe_ensure_ruvector_native,
// the package-upgrade step (with the npm >=11.17 allow-scripts handling verified
// on the 2026-07-14 upgrade), and the RVF quarantine.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';
import { rufloRoot, aqeRoot } from './paths.mjs';
import { agentdbLocations, bsq3IsNative, bsq3Root, deriveBsq3Spec, selfSpecConflicts, rufloMemoryContexts, aidefencePresent } from './natives.mjs';
import { KIT_PKG } from './versions.mjs';
import { scanRvf, quarantine } from './rvf.mjs';
import { INSTALL_SPEC, INSTALL_ARGS, NIGHTLY_LABEL as RB_NIGHTLY_LABEL, nightlyAgentPlist as rbNightlyPlist, present as rbPresent, latestVersion as rbLatest, recordInstalledRelease as rbRecord } from './ruvnet-brain.mjs';
import { PKG as ADB_PKG, present as adbPresent, coherence as adbCoherence } from './agentdb.mjs';

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
async function npmInstallInto(dir, spec, runner = run) {
  return runner('npm', ['install', spec, '--no-save', '--no-audit', '--no-fund'],
    { cwd: dir, timeout: 300_000 });
}

const failTail = (r) =>
  `FAILED (${(r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200)})`;

/** Deterministic native better-sqlite3 for one location.
 *
 *  Heals the copy that node resolution ALREADY finds, IN PLACE. Installing
 *  better-sqlite3 into `dir` itself is the last resort, not the first rung:
 *  a `--no-save` install plants a copy no package.json in the tree declares,
 *  and the next `npm install` into the ruflo root (healAidefence's, say)
 *  reconciles the tree and PRUNES it as extraneous — silently reverting the
 *  heal to the shared, half-built copy underneath. That is exactly how a sync
 *  reported "native installed" and then failed its own convergence proof with
 *  a WASM fallback: both reports were true, 30 seconds apart.
 *
 *  Ladder, verifying after each rung, stopping at the first binding:
 *  1. the resolved package's own install script — `prebuild-install ||
 *     node-gyp rebuild`, which fetches a prebuilt when one exists. Explicit
 *     `npm run` is user-invoked and never gated by npm >=11.17 allow-scripts,
 *     and it recovers a stale half-built build/ dir.
 *  2. npm approve-scripts + rebuild — npm >=11.17's sanctioned path for the
 *     blocked install script (harmless no-op failure on older npm).
 *  3. install a copy into `dir` — only when better-sqlite3 is not resolvable
 *     from `dir` at all, so there is nothing in place to build.
 *
 *  `runner` is injectable so the ladder is testable without npm or a network. */
export async function ensureNativeBsq3(dir, { runner = run } = {}) {
  let pkgRoot = bsq3Root(dir);
  if (!pkgRoot) {
    // Derive the spec from THIS tree's own overrides/deps: a hardcoded `@^12` is
    // EOVERRIDE-rejected in a tree that pins better-sqlite3 (ruflo root pins
    // 12.9.0, @claude-flow/cli pins ^12.9.0) — verified live. The derived spec
    // also raises stale 12.x pins to Node 26's first supported release.
    const spec = deriveBsq3Spec(dir);
    // The bump above only rewrites the value ak passes to `npm install` — it
    // doesn't touch package.json. When `dir` declares better-sqlite3 itself
    // (overrides/optionalDependencies/dependencies), npm requires those
    // self-declared fields to agree with each other AND with the explicit
    // install spec, or it's EOVERRIDE — verified live: bumping only the
    // install spec (leaving `overrides: ^12.9.0` in place) failed with
    // "conflicts with direct dependency"; bumping `overrides` alone then
    // failed with "Override ... conflicts with direct dependency" against
    // the still-stale `optionalDependencies`. All conflicting fields have to
    // move together before the install runs.
    for (const field of selfSpecConflicts(dir, spec)) {
      await runner('npm', ['pkg', 'set', `${field}.better-sqlite3=${spec}`], { cwd: dir, timeout: 30_000 });
    }
    const installed = await npmInstallInto(dir, `better-sqlite3@${spec}`, runner);
    if (bsq3IsNative(dir)) return { ok: true, how: 'native installed' };
    pkgRoot = bsq3Root(dir);
    if (!pkgRoot) {
      return {
        ok: false,
        how: installed.code === 0
          ? 'FAILED (better-sqlite3 not resolvable after npm reported success)'
          : failTail(installed),
      };
    }
  }
  // node-gyp compiling sqlite3 from source is slow; 300s truncated it mid-build.
  await runner('npm', ['run', 'install'], { cwd: pkgRoot, timeout: 600_000 });
  if (bsq3IsNative(dir)) return { ok: true, how: 'native built in place' };
  await runner('npm', ['approve-scripts', 'better-sqlite3'], { cwd: pkgRoot, timeout: 60_000 });
  const r = await runner('npm', ['rebuild', 'better-sqlite3'], { cwd: pkgRoot, timeout: 600_000 });
  if (bsq3IsNative(dir)) return { ok: true, how: 'native rebuilt (scripts approved)' };
  return { ok: false, how: failTail(r) };
}

/** Native better-sqlite3 into every location the runtime resolves: the agentdb
 *  copies, agentic-qe, AND the ruflo memory-runtime contexts (@claude-flow/memory
 *  + /cli) — the copies `npx ruflo memory` actually loads. #45: healing only
 *  agentdb left ruflo's own memory on the WASM fallback (memory store failing)
 *  while status still read agentdb-native. `runner` injectable for hermetic tests. */
export async function healNatives({ runner = run } = {}) {
  const details = [];
  for (const dir of agentdbLocations()) {
    // Re-check right before installing: an upgrade earlier in the same sync
    // can remove a location (e.g. agentic-flow/node_modules/agentdb, gone in
    // the 3.29.0 tree) between enumeration and heal.
    if (!fs.existsSync(dir)) continue;
    if (bsq3IsNative(dir)) continue;
    details.push(`${dir}: ${(await ensureNativeBsq3(dir, { runner })).how}`);
  }
  if (fs.existsSync(aqeRoot()) && !bsq3IsNative(aqeRoot())) {
    details.push(`agentic-qe: ${(await ensureNativeBsq3(aqeRoot(), { runner })).how}`);
  }
  // ruflo memory runtime — missing contexts are already filtered out (older trees
  // may lack either package, EC-2), so this is a silent no-op on them.
  for (const { context, dir } of rufloMemoryContexts()) {
    if (bsq3IsNative(dir)) continue;
    details.push(`@claude-flow/${context}: ${(await ensureNativeBsq3(dir, { runner })).how}`);
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
  if (!fs.existsSync(aqeRoot())) {
    return { ok: true, status: 'skipped', usable: false, detail: 'agentic-qe not installed' };
  }
  const probe = path.join(aqeRoot(), 'node_modules', '@ruvector', 'solver-node', 'package.json');
  if (fs.existsSync(probe)) return { ok: true, status: 'ok', usable: true, detail: 'already present' };
  // The native accelerator was never published to npm, and upstream resolved
  // its own half by documenting the TypeScript solver as the implementation
  // (agentic-qe#617 → #620, shipped in aqe 3.13.10). Attempting the install
  // would only manufacture a 404 warning for a by-design state (#135). The
  // probe above still detects a native that arrives by any other route.
  return {
    ok: true, status: 'ok', usable: true,
    detail: 'native solver unpublished upstream (agentic-qe#617) — TypeScript fallback is the implementation (<50K nodes)',
  };
}

/** Quarantine oversized (runaway-append) RVF stores in a project — the one RVF
 *  failure mode left to the kit. Lock/corruption handling is agentic-qe's own
 *  job since 3.12.3; see src/lib/rvf.mjs for the history. */
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

/** Install (or update to latest) the RuvNet Brain via its npx installer.
 *  The installer is idempotent and skips the ~2 GB download when the KB is
 *  already present — pass force:true to bypass that skip (used when a drift
 *  check saw a newer release). Runs `--no-stack --no-enhance`: ak already
 *  manages ruflo/RuVector and owns the CLAUDE.md grounding block. */
export async function installRuvnetBrain({
  force = false, runner = run, latestVersion = rbLatest,
  present = rbPresent, recordRelease = rbRecord,
} = {}) {
  // Resolve the release tag FIRST and pin the installer to it (--version v<tag>),
  // so the bundle that lands on disk is exactly the release ak stamps — the old
  // install-then-stamp order left a window where a release published mid-install
  // made the stamp disagree with disk. Offline (tag null): the installer's own
  // latest logic applies and the stamp is best-effort afterwards, as before.
  const tag = await latestVersion();
  const args = ['-y', INSTALL_SPEC, ...INSTALL_ARGS,
    ...(tag ? ['--version', `v${tag}`] : []),
    ...(force ? ['--force'] : [])];
  const r = await runner('npx', args, { timeout: 900_000 });
  if (r.code === 0) {
    // Stamp the release-tag namespace so drift converges — the plugin's own
    // semver never tracks the KB release, so we can't use it.
    const stamped = tag ?? await latestVersion();
    if (stamped) recordRelease(stamped);
    return {
      ok: true, status: 'ok', usable: true,
      detail: stamped ? `installed release v${stamped}` : 'installed (release tag unknown)',
    };
  }
  // Presence after a non-zero exit can be a stale or partial prior install. It
  // is useful evidence for `usable`, never proof that this install succeeded.
  return {
    ok: false, status: 'failed', usable: present(),
    detail: (r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200),
  };
}

/** Disable the brain installer's nightly self-update LaunchAgent (macOS-only —
 *  the installer never schedules anything elsewhere). ak is the single owner of
 *  brain updates (`ak sync` + the release stamp); the installer's 03:47
 *  forge-update job rewrites the KB outside that record, and on the released
 *  v3.3.1 bundle it applies downloads without signature verification. Mirrors
 *  `npx ruvnet-brain --disable-nightly` exactly, and BOTH steps are required:
 *  bootout unloads the job from the live launchd session (file removal alone
 *  leaves it scheduled until logout); removing the plist stops launchd from
 *  re-registering it at next login. Idempotent; the user can re-enroll
 *  deliberately with `npx ruvnet-brain --enable-nightly` (status will re-flag),
 *  or set ruvnetBrain:false in kit.json to have ak stand down entirely. */
export async function disableRuvnetBrainNightly({ runner = run } = {}) {
  if (process.platform !== 'darwin') return { ok: true, detail: 'not macOS — installer never schedules here' };
  const plist = rbNightlyPlist();
  if (!fs.existsSync(plist)) return { ok: true, detail: 'nightly self-updater already off' };
  // Failure is fine: "not loaded" is exactly the state we want.
  await runner('launchctl', ['bootout', `gui/${process.getuid()}/${RB_NIGHTLY_LABEL}`]);
  try { fs.rmSync(plist); } catch (e) {
    return { ok: false, detail: `couldn't remove ${plist}: ${e.message} — remove it by hand or run \`npx ruvnet-brain --disable-nightly\`` };
  }
  return { ok: true, detail: 'nightly self-updater disabled (LaunchAgent removed; brain updates flow through ak sync)' };
}

/** Ensure the standalone agentdb CLI is present AND coherent with ruflo's
 *  bundled agentdb. Pins the global to the bundled version (not npm-latest) so
 *  the shared cognitive store never skews on the core version — a core skew is
 *  the corruption risk this heal exists to prevent. Idempotent: a no-op when
 *  already present and coherent. */
export async function healAgentdb({
  runner = run, coherence = adbCoherence, present = adbPresent,
} = {}) {
  const c = coherence();
  // Already present and coherent (identical or prerelease-only diff) → nothing.
  if (c.present && c.ok && c.skew !== 'core') {
    return { ok: true, detail: `present ${c.global}${c.skew === 'prerelease' ? ` (bundled ${c.bundled}; prerelease diff ok)` : ' (coherent with ruflo)'}` };
  }
  // Pin to ruflo's bundled version; fall back to latest only when unknown.
  const spec = c.target ? `${ADB_PKG}@${c.target}` : `${ADB_PKG}@latest`;
  const r = await runner('npm', ['install', '-g', `--allow-scripts=${ALLOW_SCRIPTS}`, spec], { timeout: 600_000 });
  if (r.code !== 0) {
    return {
      ok: false, status: 'failed', usable: present(),
      detail: (r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200),
    };
  }
  const verb = !c.present ? 'installed' : 'repaired coherence →';
  return { ok: true, status: 'ok', usable: true, detail: `${verb} ${c.target ?? 'latest'} (matches ruflo's bundled agentdb)` };
}

/** Stop all ruflo daemons before an upgrade (3.27+; best-effort). */
export async function stopAllDaemons() {
  const r = await run('ruflo', ['daemon', 'stop', '--all'], { timeout: 60_000 });
  return { ok: true, detail: r.code === 0 ? 'stopped all' : 'none or unsupported' };
}
