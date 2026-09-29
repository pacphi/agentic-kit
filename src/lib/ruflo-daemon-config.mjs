// ak-managed Ruflo daemon settings, so the daemon that runs a project's memory
// backup and distillation starts on use and does its work.
//
// Facts (Ruflo 3.46.1, @claude-flow/cli dist/src):
// - the daemon reads FLAT dotted keys from <root>/.claude-flow/config.json,
//   JSON before YAML, once, in its constructor (services/worker-daemon.js
//   139-144, 354-416). A daemon started before a write never sees it.
// - `ruflo config set` writes nested keys through ConfigFileManager and can
//   create claude-flow.config.json with a relocated memory root
//   (ruvnet/ruflo#3449), so ak never uses it; it edits only its own flat keys.
// - `daemon.idleSecs: 0` kept pre-3.46.0 daemons from ending themselves before
//   the first backup (ruvnet/ruflo#3194, fixed in 3.46.0 by PR #3421:
//   worker-daemon.js:1019-1024 now counts idle from process start).
// - macOS os.freemem() excludes the file cache and the darwin default floor is
//   5% (worker-daemon.js:165, 589-596), so workers defer on a busy machine
//   (ruvnet/ruflo#2935, open). `minFreeMemoryPercent: 0` is the workaround the
//   daemon's own comment names (:648).
// - start-on-use (services/daemon-autostart.js:56-88, called for every
//   non-daemon command from index.js:194-201) refuses when
//   .claude/settings.json claudeFlow.daemon.autoStart or claude-flow.config.json
//   daemon.autostart is false, or RUFLO_DAEMON_AUTOSTART is off. `ruflo init`
//   writes the settings key false (init/settings-generator.js:123).
// - Ruflo's memory root reads claude-flow.config.json, then
//   .claude-flow/config.json, falling through a file with no `memory` key
//   (memory/memory-initializer.js:128-150), so this daemon-only file
//   coexists with ak's memory pin.
//
// ak turns the settings key from false to true under its own recorded intent
// (kit.json rufloDaemon.autoStart, default on) and keeps a receipt of the old
// value; it never edits claude-flow.config.json daemon.autostart or the
// environment variable. Receipts live in kit.json rufloDaemon.receipts, keyed
// by the resolved project root. reconcileRufloDaemon never runs a command;
// applyRufloDaemon (sync) restarts a live daemon so it reads what changed.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';
import { projectDaemonAlive } from './daemons.mjs';
import { writePrivateFileAtomic } from './file-write.mjs';
import { pendingDeferral } from './memory-maintenance.mjs';
import { rufloProjectRoot } from './ruflo-components/apply.mjs';
import { readJson, writeJsonWithBackup } from './settings.mjs';
import { cmpVersions } from './versions.mjs';
import * as paths from './paths.mjs';

/** The first Ruflo whose daemon no longer ends itself early (ruvnet/ruflo#3194, PR #3421). */
export const IDLE_FIX_VERSION = '3.46.0';
export const IDLE_KEY = 'daemon.idleSecs';
export const MEMORY_FLOOR_KEY = 'daemon.resourceThresholds.minFreeMemoryPercent';
export const DAEMON_CONFIG_RELATIVE = path.join('.claude-flow', 'config.json');
const MAX_CONFIG_BYTES = 1024 * 1024;

const readJsonObject = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/** Ruflo's own test for a Ruflo project (3.46.1 services/daemon-autostart.js:90-123,
 *  isRufloProject): a durable marker, never a bare .claude-flow/ folder, which
 *  Ruflo's startup migration can create by itself (the regression that
 *  function's own comment describes). */
export function durableRufloProject(root) {
  const direct = [
    ['.claude-flow', 'config.yaml'], ['.claude-flow', 'config.yml'], ['.claude-flow', 'config.json'],
    ['claude-flow.config.json'], ['.swarm', 'memory.db'],
  ];
  if (direct.some((parts) => fs.existsSync(path.join(root, ...parts)))) return true;
  const settings = readJsonObject(path.join(root, '.claude', 'settings.json'));
  if (settings && typeof settings === 'object' && 'claudeFlow' in settings) return true;
  const servers = readJsonObject(path.join(root, '.mcp.json'))?.mcpServers;
  return !!servers && typeof servers === 'object' && ('ruflo' in servers || 'claude-flow' in servers);
}

/** The Ruflo project around `cwd` whose daemon settings ak manages: the
 *  project-scope gate (rufloProjectRoot) AND a durable Ruflo marker. Writing
 *  .claude-flow/config.json is itself such a marker, so ak must never write it
 *  where Ruflo would not already start a daemon. */
export function rufloDaemonProjectRoot(cwd) {
  const root = rufloProjectRoot(cwd);
  return root && durableRufloProject(root) ? root : null;
}

/** The flat keys ak wants in .claude-flow/config.json for this Ruflo and platform. */
export function desiredDaemonKeys({ rufloVersion, platform }) {
  const keys = {};
  if (typeof rufloVersion === 'string' && /^\d+\.\d+\.\d+/.test(rufloVersion)
    && cmpVersions(rufloVersion, IDLE_FIX_VERSION) < 0) keys[IDLE_KEY] = 0;
  // Until ruvnet/ruflo#2935 is fixed upstream.
  if (platform === 'darwin') keys[MEMORY_FLOOR_KEY] = 0;
  return keys;
}

/** 'absent' | 'invalid' (unreadable, oversized, symlink, not a JSON object) | 'object'. */
function readDaemonConfig(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return { state: 'invalid' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? { state: 'object', value } : { state: 'invalid' };
  } catch (error) {
    return error?.code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid' };
  }
}

const pathPresent = (candidate) => {
  try { fs.lstatSync(candidate); return true; } catch (error) { return error?.code !== 'ENOENT'; }
};

/** A desired key ak leaves to the user: the file is unreadable (`invalid`),
 *  or it holds the user's own value `have` instead of `want`.
 *  @typedef {{ key: string, want: number, have?: unknown }} HeldKey
 *  @typedef {{ invalid: boolean, entries: HeldKey[], reason?: 'yaml-shadow'|'higher-priority-json' } | null} HeldConfig */

/** Plan the config.json edit: which owned keys to drop, which to set. */
function planConfig(current, owned, desired) {
  const next = { ...current };
  const nextOwned = { ...owned };
  let removed = false; let written = false;
  /** @type {HeldKey[]} */
  const conflicts = [];
  for (const [key, value] of Object.entries(owned)) {
    if (Object.hasOwn(desired, key)) continue;
    if (next[key] === value) { delete next[key]; removed = true; }
    delete nextOwned[key]; // gone, or a user value now: no longer ak's
  }
  for (const [key, value] of Object.entries(desired)) {
    if (!Object.hasOwn(next, key)) { next[key] = value; nextOwned[key] = value; written = true; continue; }
    if (next[key] === value) continue; // ak's (receipt kept) or the user's own identical value
    if (Object.hasOwn(owned, key) && next[key] === owned[key]) { next[key] = value; nextOwned[key] = value; written = true; continue; }
    conflicts.push({ key, want: value, have: next[key] });
    delete nextOwned[key];
  }
  return { next, nextOwned, removed, written, conflicts };
}

/** @returns {{status: string, changed: boolean, held: HeldConfig}} */
function reconcileConfig(root, receipt, desired, dryRun) {
  const file = path.join(root, DAEMON_CONFIG_RELATIVE);
  // Never follow a user-controlled .claude-flow link (or special file) when
  // reading, creating, replacing or removing config.json.
  try {
    const dir = fs.lstatSync(path.dirname(file));
    if (!dir.isDirectory() || dir.isSymbolicLink()) {
      const entries = Object.entries(desired).map(([key, want]) => ({ key, want }));
      return { status: 'user-managed', changed: false, held: entries.length ? { invalid: true, entries } : null };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      const entries = Object.entries(desired).map(([key, want]) => ({ key, want }));
      return { status: 'user-managed', changed: false, held: entries.length ? { invalid: true, entries } : null };
    }
  }
  const higherPriority = pathPresent(path.join(root, 'claude-flow.config.json'));
  const owned = receipt.configKeys ?? {};
  const current = readDaemonConfig(file);
  if (current.state === 'invalid') {
    const entries = Object.entries(desired).map(([key, want]) => ({ key, want }));
    return { status: 'user-managed', changed: false, held: entries.length ? { invalid: true, entries } : null };
  }
  if (current.state === 'absent') {
    receipt.configKeys = {};
    receipt.configCreated = false;
    if (!Object.keys(desired).length) return { status: 'absent', changed: false, held: null };
    // Ruflo 3.48.0 chooses root JSON, then .claude-flow/config.json, then
    // config.yaml/yml. Creating our JSON over YAML would hide all user YAML
    // daemon values; under root JSON this file would have no effect at all.
    const yaml = ['config.yaml', 'config.yml'].some((name) => pathPresent(path.join(root, '.claude-flow', name)));
    if (higherPriority || yaml) return {
      status: 'user-managed', changed: false,
      held: {
        invalid: false, reason: higherPriority ? 'higher-priority-json' : 'yaml-shadow',
        entries: Object.entries(desired).map(([key, want]) => ({ key, want })),
      },
    };
    if (!dryRun) {
      writePrivateFileAtomic(file, `${JSON.stringify(desired, null, 2)}\n`);
      receipt.configKeys = { ...desired };
      receipt.configCreated = true;
    }
    return { status: 'written', changed: true, held: null };
  }
  // A root JSON file wins even over existing .claude-flow/config.json. Keep
  // receipted still-needed keys and clean obsolete ones, but add no new keys
  // to a file the daemon does not read.
  const effectiveDesired = higherPriority
    ? Object.fromEntries(Object.entries(desired).filter(([key]) => Object.hasOwn(owned, key)))
    : desired;
  const plan = planConfig(current.value, owned, effectiveDesired);
  const changed = plan.written || plan.removed;
  const empty = Object.keys(plan.next).length === 0;
  if (!dryRun) {
    if (changed && empty && receipt.configCreated === true) fs.rmSync(file);
    else if (changed) writePrivateFileAtomic(file, `${JSON.stringify(plan.next, null, 2)}\n`);
    receipt.configKeys = plan.nextOwned;
    receipt.configCreated ??= false;
    if (changed && empty && receipt.configCreated === true) receipt.configCreated = false;
  }
  /** @type {HeldConfig} */
  const held = higherPriority && Object.keys(desired).length
    ? { invalid: false, reason: 'higher-priority-json', entries: Object.entries(desired).map(([key, want]) => ({ key, want })) }
    : plan.conflicts.length ? { invalid: false, entries: plan.conflicts } : null;
  if (plan.written) return { status: 'written', changed, held };
  if (plan.removed) return { status: 'removed', changed, held };
  return { status: held ? 'user-managed' : 'converged', changed: false, held };
}

function reconcileAutostart(root, receipt, wanted, dryRun) {
  const file = paths.projectSettings(root);
  if (!fs.existsSync(file)) return { status: 'converged', changed: false };
  const settings = readJson(file);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { status: 'user-managed', changed: false };
  const daemon = settings.claudeFlow?.daemon;
  const value = daemon && typeof daemon === 'object' ? daemon.autoStart : undefined;
  if (!wanted) {
    if (receipt.autostartBefore !== false) return { status: 'user-managed', changed: false };
    if (value !== true) { if (!dryRun) receipt.autostartBefore = null; return { status: 'user-managed', changed: false }; }
    if (!dryRun) {
      daemon.autoStart = false;
      writeJsonWithBackup(file, settings);
      receipt.autostartBefore = null;
    }
    return { status: 'restored', changed: true };
  }
  if (value !== false) return { status: 'converged', changed: false };
  if (!dryRun) {
    daemon.autoStart = true;
    writeJsonWithBackup(file, settings);
    // The first value ak saw is the one uninstall restores.
    if (receipt.autostartBefore !== false) receipt.autostartBefore = false;
  }
  return { status: 'enabled', changed: true };
}

const hasOwnership = (receipt) => Object.keys(receipt.configKeys ?? {}).length > 0
  || receipt.configCreated === true || receipt.autostartBefore === false;

/**
 * Converge one project's managed daemon settings.
 * @param {string} root the Ruflo project root
 * @param {{rufloVersion?: (string|null), platform?: string, receipts: Record<string, any>,
 *   autoStart?: boolean, dryRun?: boolean, desired?: Record<string, number>, runner?: unknown}} options
 *   `autoStart` is kit.json rufloDaemon.autoStart !== false; `runner` is accepted and never used.
 * @returns {{config: string, autostart: string, changed: boolean, held: HeldConfig}}
 *   `held` names the desired keys ak cannot manage here (null when none).
 */
export function reconcileRufloDaemon(root, {
  rufloVersion = null, platform = process.platform, receipts, autoStart = true, dryRun = false,
  desired = desiredDaemonKeys({ rufloVersion, platform }),
} = /** @type {any} */ ({})) {
  const key = path.resolve(root);
  const receipt = structuredClone(receipts[key] ?? {});
  const config = reconcileConfig(root, receipt, desired, dryRun);
  const autostart = reconcileAutostart(root, receipt, autoStart, dryRun);
  if (!dryRun) {
    if (hasOwnership(receipt)) receipts[key] = receipt;
    else delete receipts[key];
  }
  return {
    config: config.status, autostart: autostart.status, changed: config.changed || autostart.changed, held: config.held,
  };
}

/** Uninstall: drop every key ak wrote, delete a file ak created and left
 *  empty, and put back the autoStart value ak changed. A value the user
 *  edited since is kept and its receipt dropped. */
export function releaseRufloDaemon(root, receipts) {
  const key = path.resolve(root);
  if (!receipts[key]) return { ok: true, changed: false, config: 'absent', autostart: 'user-managed' };
  try {
    const r = reconcileRufloDaemon(root, { receipts, autoStart: false, desired: {} });
    delete receipts[key];
    return { ok: true, ...r };
  } catch (error) {
    return { ok: false, changed: false, config: 'error', autostart: 'error', reason: error?.message ?? String(error) };
  }
}

/** Resolved project roots with a daemon-settings receipt. */
export function receiptedDaemonRoots(cfg) {
  return Object.keys(cfg?.rufloDaemon?.receipts ?? {});
}

/** kit.json's recorded intent and receipts, created on first use. */
export function daemonIntent(cfg) {
  cfg.rufloDaemon ??= {};
  cfg.rufloDaemon.receipts ??= {};
  return { autoStart: cfg.rufloDaemon.autoStart !== false, receipts: cfg.rufloDaemon.receipts };
}

/**
 * Sync: converge the Ruflo project around `cwd` (a git repository root with
 * .claude-flow/, the same gate as project-scope Ruflo components, that also
 * carries one of Ruflo's durable project markers) and restart
 * its live daemon when it runs with settings it read before this change, or is
 * still deferring work for low memory on macOS under a floor ak manages. A daemon that is not running
 * is left for Ruflo's start-on-use. Returns null outside a Ruflo project.
 * @param {string} cwd
 * @param {{cfg: any, rufloVersion?: (string|null), platform?: string, runner?: typeof run,
 *   alive?: (root: string) => boolean, dryRun?: boolean}} options
 */
export async function applyRufloDaemon(cwd, {
  cfg, rufloVersion = null, platform = process.platform, runner = run, alive = projectDaemonAlive, dryRun = false,
}) {
  const root = rufloDaemonProjectRoot(cwd);
  if (!root) return null;
  const intent = daemonIntent(cfg);
  const result = reconcileRufloDaemon(root, { rufloVersion, platform, receipts: intent.receipts, autoStart: intent.autoStart, dryRun });
  const configChanged = result.config === 'written' || result.config === 'removed';
  // A config.json that keeps the floor from ak (unreadable, or the user's own
  // value) changed nothing a restart would pick up.
  const floorHeld = result.held?.entries.some((e) => e.key === MEMORY_FLOOR_KEY) ?? false;
  const stillDeferring = platform === 'darwin' && !floorHeld
    && /^Memory too low/.test(pendingDeferral(root)?.reason ?? '');
  let restarted = false;
  if (!dryRun && (configChanged || stillDeferring) && alive(root)) {
    await runner('ruflo', ['daemon', 'stop'], { cwd: root, timeout: 60_000 });
    restarted = (await runner('ruflo', ['daemon', 'start'], { cwd: root, timeout: 60_000 })).code === 0;
  }
  return { root, result, restarted };
}

/** Status: the desired keys a user-managed config.json keeps from ak (a dry run).
 *  @returns {HeldConfig} */
export function daemonConfigHeld(root, { cfg, rufloVersion = null, platform = process.platform }) {
  const intent = daemonIntent(structuredClone(cfg ?? {}));
  const receipts = structuredClone(intent.receipts);
  return reconcileRufloDaemon(root, { rufloVersion, platform, receipts, autoStart: intent.autoStart, dryRun: true }).held;
}

/** Status: what a sync would change here, as phrases, or null when converged. */
export function daemonDrift(root, { cfg, rufloVersion = null, platform = process.platform }) {
  const intent = daemonIntent(structuredClone(cfg ?? {}));
  const receipts = structuredClone(intent.receipts);
  const r = reconcileRufloDaemon(root, { rufloVersion, platform, receipts, autoStart: intent.autoStart, dryRun: true });
  if (!r.changed) return null;
  const parts = [];
  const desired = desiredDaemonKeys({ rufloVersion, platform });
  if (r.config === 'written') {
    parts.push(`${DAEMON_CONFIG_RELATIVE} lacks ${Object.entries(desired).map(([k, v]) => `"${k}": ${v}`).join(', ')}`);
  }
  if (r.config === 'removed') parts.push(`${DAEMON_CONFIG_RELATIVE} holds keys ak wrote that this Ruflo no longer needs`);
  if (r.autostart === 'enabled') parts.push('.claude/settings.json claudeFlow.daemon.autoStart is false, so start-on-use is off');
  if (r.autostart === 'restored') parts.push('kit.json rufloDaemon.autoStart is false but ak turned start-on-use on here');
  return parts;
}
