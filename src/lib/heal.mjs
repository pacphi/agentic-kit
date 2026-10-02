// Heal actions — the mutations `sync` applies. Each returns
// {ok, status, usable, detail} and is idempotent. `status` is one of
// ok|degraded|failed|skipped; callers must not infer subsystem health from
// mere on-disk presence after a failed operation. Ports of: ruflo-patch-native,
// _ruflo_ensure_aidefence, _ruflo_aqe_ensure_native, _ruflo_aqe_ensure_ruvector_native,
// the package-upgrade step (with explicit npm global lifecycle policy), and the
// RVF quarantine.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';
import { rufloRoot, aqeRoot, installEditsPath } from './paths.mjs';
import { pruneInstallEdits, recordInstallEdit } from './install-edits.mjs';
import { agentdbLocations, bsq3IsNative, bsq3Root, deriveBsq3Spec, selfSpecConflicts, rufloMemoryContexts, aidefencePresent, probeBsq3Runtime, recordNativeRuntimeEvidence } from './natives.mjs';
import { scanRvf, quarantine } from './rvf.mjs';
import {
  INSTALL_SPEC, INSTALL_ARGS, UPDATE_ARGS as RB_UPDATE_ARGS, UPDATE_ENV as RB_UPDATE_ENV,
  RELEASE_ASSET as RB_RELEASE_ASSET, NIGHTLY_LABEL as RB_NIGHTLY_LABEL, nightlyAgentPlist as rbNightlyPlist,
  present as rbPresent, updaterPresent as rbUpdaterPresent, installedReleaseOnDisk as rbReleaseOnDisk,
  latestRelease as rbLatestRelease, recordInstalledRelease as rbRecord, recordHeldRefresh as rbRecordHeld,
} from './ruvnet-brain.mjs';
import { globalInstallArgs, installGlobalCli } from './npm-global-install.mjs';

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
 *  `runner` is injectable so the ladder is testable without npm or a network.
 *
 *  Every manifest edit is receipted first (install-edits.mjs; audit Addendum 2,
 *  problem 3): file, field, original value, ak's value and time, written to
 *  `ledger` BEFORE `npm pkg set`, so status and About can show it and
 *  `ak uninstall` can put the original back.
 *  @param {string} dir
 *  @param {{ runner?: typeof run, ledger?: string, now?: () => number }} [options] */
export async function ensureNativeBsq3(dir, { runner = run, ledger = installEditsPath(), now = Date.now } = {}) {
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
      recordInstallEdit({ file: path.join(dir, 'package.json'), section: field, name: 'better-sqlite3', to: spec, now }, { ledger });
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

/** Rebuild a binding FILE that exists but provably will not load (built for
 *  another Node ABI or platform, or damaged). The file is removed first:
 *  prebuild-install extracts over an existing file in place (tar-fs writes through
 *  createWriteStream), and a Node process started before a Node upgrade can still
 *  map the old file. A new file gets a new inode, and the ladder runs exactly as
 *  for a missing binding. Success is the load test passing, not a file on disk. */
async function rebuildUnloadable(dir, runner, ledger) {
  const binding = path.join(bsq3Root(dir), 'build', 'Release', 'better_sqlite3.node');
  try {
    fs.rmSync(binding, { force: true });
  } catch (e) {
    return { ok: false, how: `FAILED (could not remove the binding that will not load: ${e.code ?? e.message})` };
  }
  const built = await ensureNativeBsq3(dir, { runner, ledger });
  if (!built.ok) return built;
  const after = await probeBsq3Runtime(dir, { runner });
  if (after.state === 'native') return built;
  if (after.state === 'unavailable') return { ok: false, how: `FAILED (rebuilt binding still does not load: ${after.reason})` };
  return { ok: true, how: `${built.how}; load unverified (${after.reason})` };
}

/** One ruflo memory-runtime context. A missing binding file takes the build
 *  ladder as before. A present file is load-tested, the same test status uses,
 *  and rebuilt only when the probe proves it will not load (`unavailable`). An
 *  `inconclusive` probe (timeout, crash) never triggers a rebuild in ruflo's tree.
 *  Whatever the FINAL state turns out to be is recorded as evidence, so a plain
 *  `ak status` right after `ak sync` shows the repaired state without needing a
 *  second `--refresh` (ADR-0063). */
async function healRuntimeContext({ context, dir }, runner, ledger) {
  if (!bsq3IsNative(dir)) {
    const built = await ensureNativeBsq3(dir, { runner, ledger });
    recordNativeRuntimeEvidence(context, dir, await probeBsq3Runtime(dir, { runner }));
    return built.how;
  }
  const probe = await probeBsq3Runtime(dir, { runner });
  if (probe.state === 'native') {
    recordNativeRuntimeEvidence(context, dir, probe);
    return null;
  }
  if (probe.state === 'inconclusive') {
    recordNativeRuntimeEvidence(context, dir, probe);
    return `load probe inconclusive (${probe.reason}), not rebuilt`;
  }
  const rebuilt = await rebuildUnloadable(dir, runner, ledger);
  recordNativeRuntimeEvidence(context, dir, await probeBsq3Runtime(dir, { runner }));
  return rebuilt.how;
}

/** Native better-sqlite3 into every location the runtime resolves: the agentdb
 *  copies, agentic-qe, AND the ruflo memory-runtime contexts (@claude-flow/memory
 *  + /cli) — the copies `npx ruflo memory` actually loads. #45: healing only
 *  agentdb left ruflo's own memory on the WASM fallback (memory store failing)
 *  while status still read agentdb-native. `runner` and the receipt `ledger`
 *  are injectable for hermetic tests. Receipts whose files no longer hold ak's
 *  value (Ruflo was upgraded or reinstalled) are forgotten first. */
export async function healNatives({ runner = run, ledger = installEditsPath() } = {}) {
  pruneInstallEdits({ ledger });
  const details = [];
  for (const dir of agentdbLocations()) {
    // Re-check right before installing: an upgrade earlier in the same sync
    // can remove a location (e.g. agentic-flow/node_modules/agentdb, gone in
    // the 3.29.0 tree) between enumeration and heal.
    if (!fs.existsSync(dir)) continue;
    if (bsq3IsNative(dir)) continue;
    details.push(`${dir}: ${(await ensureNativeBsq3(dir, { runner, ledger })).how}`);
  }
  if (fs.existsSync(aqeRoot()) && !bsq3IsNative(aqeRoot())) {
    details.push(`agentic-qe: ${(await ensureNativeBsq3(aqeRoot(), { runner, ledger })).how}`);
  }
  // ruflo memory runtime — missing contexts are already filtered out (older trees
  // may lack either package, EC-2), so this is a silent no-op on them. Sequential:
  // both contexts can resolve one shared copy, and a rebuild for the first
  // changes what the second one's probe sees.
  for (const { context, dir } of rufloMemoryContexts()) {
    const how = await healRuntimeContext({ context, dir }, runner, ledger);
    if (how) details.push(`@claude-flow/${context}: ${how}`);
  }
  return { ok: !details.some((d) => d.includes('FAILED')), detail: details.join('; ') || 'already native everywhere' };
}

/** @claude-flow/aidefence back into the ruflo tree (ruvnet/ruflo#2670). */
export async function healAidefence() {
  if (aidefencePresent()) return { ok: true, detail: 'already present' };
  const r = await npmInstallInto(rufloRoot(), '@claude-flow/aidefence');
  return { ok: aidefencePresent(), detail: r.code === 0 ? 'installed (adaptive learning and aidefence_* MCP tools)' : r.stderr.slice(0, 200) };
}

/** Quarantine oversized (runaway-append) RVF stores in a project — the one RVF
 *  failure mode left to the kit. Lock/corruption handling is agentic-qe's own
 *  job since 3.12.3; see src/lib/rvf.mjs for the history. */
export function healRvf(projectAqeDir) {
  const findings = scanRvf(projectAqeDir);
  const removed = findings.flatMap((f) => quarantine(f));
  return { ok: true, detail: removed.length ? `quarantined: ${removed.join(', ')}` : 'healthy' };
}

/** Upgrade a global package to latest (with allow-scripts). With `bin`, the
 *  package's CLI must also start afterwards (see installGlobalCli).
 *  @param {string} pkg
 *  @param {{ bin?: string|null, runner?: typeof run, sleep?: (ms: number) => Promise<void> }} [opts] */
export async function upgradePackage(pkg, { bin = null, runner = run, sleep } = {}) {
  if (bin) {
    const r = await installGlobalCli(`${pkg}@latest`, bin, { runner, sleep });
    return { ok: r.ok, detail: r.ok ? (r.retried ? 'upgraded (missing platform files repaired on retry)' : 'upgraded') : r.detail };
  }
  const r = await runner('npm', globalInstallArgs(`${pkg}@latest`),
    { timeout: 600_000 });
  return { ok: r.code === 0, detail: r.code === 0 ? 'upgraded' : r.stderr.split('\n').slice(-3).join(' ') };
}

/** Refresh an existing Brain through the bundle's own updater. `--update`
 *  ignores `--version`, so success is judged by the release on disk, never by
 *  the tag ak asked about: a changed release is stamped; an unchanged one is
 *  `degraded` (the updater ran, nothing landed) and stamps nothing. A refusal or
 *  a no-op is held (recordRefusal) so the next sync does not repeat it. */
async function refreshBrainWithUpdater({ runner, present, recordRelease, recordRefusal, releaseOnDisk, tag }) {
  const before = releaseOnDisk();
  const r = await runner('npx', ['-y', INSTALL_SPEC, ...RB_UPDATE_ARGS],
    { timeout: 900_000, env: { ...RB_UPDATE_ENV } });
  if (r.code !== 0) return refreshFailure(r, { present, recordRefusal, tag });
  const after = releaseOnDisk();
  if (!after || after === before) {
    const detail = `updater ran; installed release still ${before ? `v${before}` : 'unknown'}${tag ? ` (latest v${tag})` : ''}`;
    recordRefusal({ detail, latest: tag });
    return { ok: false, status: 'degraded', usable: true, detail };
  }
  recordRelease(after);
  return { ok: true, status: 'ok', usable: true, detail: `updated to release v${after}` };
}

/** A failed refresh of an EXISTING install. A deliberate refusal by the
 *  installer or updater is held for this release pair; anything else (a
 *  network error, a timeout) stays retryable by the next sync. */
function refreshFailure(r, { present, recordRefusal, tag }) {
  const detail = brainInstallFailure(r);
  if (brainRefused(r)) recordRefusal({ detail, latest: tag });
  return { ok: false, status: 'failed', usable: present(), detail };
}

/** Install (or refresh) the RuvNet Brain. The heal, not its caller, chooses the
 *  path from what is on disk:
 *   · the bundle ships kb/forge-update.mjs → `--update` (the installer's own
 *     refresh; a forced fresh install is refused for a Brain with private stores,
 *     after downloading the whole bundle — #237 §4);
 *   · a present bundle without the updater → pinned `--force` reinstall, the
 *     only refresh a pre-updater bundle can take;
 *   · nothing installed → pinned fresh install.
 *  Every path stamps only the release observed on disk (SOURCE.json releaseTag);
 *  a pinned install of a pre-stamping bundle falls back to the pinned tag.
 *  Runs `--no-stack --no-enhance`: ak already manages ruflo/RuVector and owns
 *  the CLAUDE.md grounding block.
 *  `cfg`: the caller's in-memory kit config. A caller that saves its own copy
 *  later (sync, setup) passes it, so the release stamp and a held refresh are
 *  written through that copy instead of being erased by the caller's next save. */
export async function installRuvnetBrain({
  cfg = undefined,
  runner = run, latestRelease = rbLatestRelease, present = rbPresent,
  recordRelease = (tag) => rbRecord(tag, cfg),
  updaterPresent = rbUpdaterPresent, releaseOnDisk = rbReleaseOnDisk,
  recordRefusal = (refusal) => rbRecordHeld(refusal, cfg),
} = {}) {
  const release = await latestRelease();
  const tag = release?.version ?? null;
  // Do not launch the installer for a release that cannot possibly land. Its
  // own fallback constructs the same absent /ruvnet-brain.zip URL, waits for
  // that 404, then emits a generic half-install footer. Preserve the existing
  // install and surface the upstream publishing defect directly.
  if (release?.releaseAssetAvailable === false) {
    return {
      ok: false, status: 'failed', usable: present(),
      detail: `release v${tag} is missing ${RB_RELEASE_ASSET}; automatic update is blocked upstream and the existing Brain was left unchanged`,
    };
  }
  if (updaterPresent()) {
    return refreshBrainWithUpdater({ runner, present, recordRelease, recordRefusal, releaseOnDisk, tag });
  }
  // Pin the installer to the resolved tag (--version v<tag>) so a release
  // published mid-install cannot land something other than what was resolved.
  const reinstall = present();
  const args = ['-y', INSTALL_SPEC, ...INSTALL_ARGS,
    ...(tag ? ['--version', `v${tag}`] : []),
    ...(reinstall ? ['--force'] : [])];
  const r = await runner('npx', args, { timeout: 900_000 });
  if (r.code !== 0) {
    // Presence after a non-zero exit can be a stale or partial prior install. It
    // is useful evidence for `usable`, never proof that this install succeeded.
    if (reinstall) return refreshFailure(r, { present, recordRefusal, tag });
    return { ok: false, status: 'failed', usable: present(), detail: brainInstallFailure(r) };
  }
  const stamped = releaseOnDisk() ?? tag;
  if (stamped) recordRelease(stamped);
  return {
    ok: true, status: 'ok', usable: true,
    detail: stamped ? `installed release v${stamped}` : 'installed (release tag unknown)',
  };
}

// ANSI SGR/escape stripper for installer output (ESC built via fromCharCode so
// the regex stays clean under eslint no-control-regex).
const BRAIN_ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const BRAIN_CAUSAL = /\[forge-update\]\s*ERROR:|install stopped:|can't update:|HTTP\s+\d{3}|no matching .*\.zip asset/i;
// The installer's remediation line after a refusal ("Run npx ruvnet-brain
// --update so …", "Fix: re-run the installer — npx ruvnet-brain …").
const BRAIN_HINT = /^(?:Run|Fix:)\s.*\bnpx ruvnet-brain\b/i;
// Deliberate refusals by the installer (`die()` → "install stopped:") or the
// bundle's updater ("[forge-update] ERROR:", "refusing to update", missing
// updater) — as opposed to a transient network or timeout failure.
const BRAIN_REFUSAL = /install stopped:|\[forge-update\]\s*ERROR:|refusing to update|can't update:/i;
// A specific, permanent subtype of BRAIN_REFUSAL (ADR-0061): forge-update's
// legacy-backup reclaim (reclaimBackups(), upstream issue #35) refuses to
// create another full-KB rollback copy while any kb.bak-*/kb.install-preserved-*
// snapshot from a prior update remains unresolved. Retrying --update can never
// clear this (the snapshots are never touched by --update). On 2026-09-27, with
// ruvnet-brain 4.3.29, deleting kb/ (npx ruvnet-brain --uninstall) and
// reinstalling fresh took a different code path (obtainBundle(), not
// forge-update.mjs) that was not blocked by it — see stuinfla/ruvnet-brain#335.
// Later installers are unverified (ADR-0061 §5). Exported so status can give
// this one subtype of held refusal different, actionable remediation text.
export const BRAIN_RECLAIM_STUCK = /unresolved rollback state exists|refusing to create another full-KB copy/i;

/** Did the installer or updater refuse, rather than fail transiently? */
export function brainRefused(result) {
  return BRAIN_REFUSAL.test(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.replace(BRAIN_ANSI, ''));
}

/** Prefer the installer's causal error, plus its remediation hint, over its
 *  generic closing reassurance. Newer updater failures write the release-asset
 *  error to stdout while the final "Nothing is left half-installed" footer
 *  lands on stderr. Terminal color codes never reach a status/sync detail. */
export function brainInstallFailure(result) {
  const lines = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.replace(BRAIN_ANSI, '')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const causal = lines.filter((line) => BRAIN_CAUSAL.test(line)).slice(-2);
  const hint = causal.length ? lines.filter((line) => BRAIN_HINT.test(line)).slice(-1) : [];
  const chosen = [...causal, ...hint].join(' | ') || lines.slice(-2).join(' ') || `exit ${result?.code ?? 1}`;
  return chosen.slice(0, 320);
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

/** Stop all ruflo daemons before an upgrade (3.27+; best-effort). */
export async function stopAllDaemons() {
  const r = await run('ruflo', ['daemon', 'stop', '--all'], { timeout: 60_000 });
  return { ok: true, detail: r.code === 0 ? 'stopped all' : 'none or unsupported' };
}
