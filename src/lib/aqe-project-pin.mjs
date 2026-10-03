// B5-D1/B5-D1a/B5-D1b (retired, agentic-qe#735): ak used to pin AQE to the project
// root. AQE found its store three ways and each fell back to the working
// directory: the project root (AQE_PROJECT_ROOT, agentic-qe dist/kernel/
// project-root.js), the memory database (AQE_MEMORY_PATH, dist/learning/
// embedder-identity-store.js, which never read the root) and the storage folder
// its token bootstrap created (AQE_STORAGE_PATH, dist/init/token-bootstrap.js). A
// command, hook or MCP server started in a subfolder therefore made its own
// `.agentic-qe` there (upstream agentic-qe#735). Released agentic-qe (>=3.14.5)
// resolves all three from a project-root search (.git or package.json boundary,
// agentic-qe dist/kernel/project-root.js's findProjectRoot) on its own, so ak no
// longer writes this pin: `reconcileAqePin`'s callers (sync, setup) now always
// pass `enabled: false`. The write path below (`enabled: true` or the default
// heuristic) stays only so a pin an older ak version wrote — absolute paths in the
// project's `.claude/settings.local.json` env, the `.mcp.json` agentic-qe entry,
// the project `.codex/config.toml` agentic-qe env and its
// `[shell_environment_policy.set]` table, each under a receipt — is released back
// to its receipted before-state on the next sync, setup, or `ak uninstall`
// (releaseAqePins). Files git tracks (`.mcp.json`, the project `.codex/config.toml`)
// were never pinned (maintainer decision B5-M5): a committed absolute path would
// point teammates' AQE at a path that does not exist on their machines.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { aqeTomlEnvironment, shellEnvironmentSet } from './aqe-embedding-toml.mjs';
import { recognizedAqeTransport, parseEmbeddingJson } from './aqe-embedding-transport.mjs';
import { planOwnedEnv, applyOwnedEnv, jsonTopLevelEnvEditor, readRegularConfig } from './owned-env-projection.mjs';
import { projectAqeDir, repoRoot } from './paths.mjs';

export const AQE_PIN_RECEIPT = '.agentic-kit-aqe-pin.json';
export const AQE_SHELL_PIN_RECEIPT = '.agentic-kit-aqe-shell-pin.json';
export const AQE_PIN_KEYS = Object.freeze(['AQE_PROJECT_ROOT', 'AQE_MEMORY_PATH', 'AQE_STORAGE_PATH']);
/** The relative value `aqe init` writes (agentic-qe dist/init/settings-merge.js:142,
 *  platform-config-generator.js:147,188); ak replaces it under the receipt, also when AQE
 *  writes it back over ak's value (re-init after an upgrade, review M4). AQE writes no
 *  AQE_STORAGE_PATH into any config (3.14.4 sets '.agentic-qe' only in its daemon's
 *  process env, init/phases/10-workers.js:169), so that key has no AQE default to adopt. */
const AQE_OWN_MEMORY_PATH = '.agentic-qe/memory.db';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {string} root @param {{pathApi?: typeof path, realpath?: (p: string) => string}} [options] */
export function desiredAqePin(root, { pathApi = path, realpath = fs.realpathSync } = {}) {
  const real = realpath(root);
  const storage = pathApi.join(real, '.agentic-qe');
  return { AQE_PROJECT_ROOT: real, AQE_MEMORY_PATH: pathApi.join(storage, 'memory.db'), AQE_STORAGE_PATH: storage };
}

/** The `.mcp.json` agentic-qe entry's env, for a transport ak recognizes. */
function mcpServerEnvEditor(source) {
  const doc = source === null ? {} : parseEmbeddingJson(source);
  if (!plain(doc)) throw new Error('configuration is not an object');
  const registration = doc.mcpServers?.['agentic-qe'];
  if (!registration) return { missing: true };
  if (!plain(registration) || !recognizedAqeTransport(registration.command, registration.args)) {
    throw new Error('unrecognized AQE MCP transport preserved');
  }
  if (registration.env !== undefined && !plain(registration.env)) throw new Error('environment is not an object');
  return {
    get: (key) => (registration.env && Object.hasOwn(registration.env, key)
      ? { present: true, value: registration.env[key] } : { present: false }),
    render(nextStates) {
      registration.env ??= {};
      for (const [key, next] of Object.entries(nextStates)) {
        if (next.present) registration.env[key] = next.value; else delete registration.env[key];
      }
      if (Object.keys(registration.env).length === 0) delete registration.env;
      return JSON.stringify(doc, null, 2) + '\n';
    },
  };
}

const EDITORS = {
  settings: (source) => jsonTopLevelEnvEditor(source),
  mcp: mcpServerEnvEditor,
  toml: (source) => aqeTomlEnvironment(source, [...AQE_PIN_KEYS]),
  shell: (source) => shellEnvironmentSet(source, [...AQE_PIN_KEYS]),
};

const adoptable = (key, current) => key === 'AQE_MEMORY_PATH' && current.value === AQE_OWN_MEMORY_PATH;

/** Whether git tracks `file` in the repository at `root` (shell-free). Anything but
 *  a clean yes (untracked, not a repository, no git) reads as not tracked. */
export function gitTracks(root, file) {
  if (!fs.existsSync(file)) return false;
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', path.relative(root, file)],
    { cwd: root, stdio: 'ignore', shell: false, timeout: 10_000, windowsHide: true });
  return result.status === 0;
}

function targets(cfg, root, active, tracks = gitTracks) {
  const hosts = cfg?.integrations?.hosts ?? { claude: true };
  const codex = path.join(root, '.codex', 'config.toml');
  const list = [
    { file: path.join(root, '.claude', 'settings.local.json'), kind: 'settings', host: !!hosts.claude, shared: false },
    { file: path.join(root, '.mcp.json'), kind: 'mcp', host: !!hosts.claude, shared: true },
    { file: codex, kind: 'toml', host: !!hosts.codex, shared: true },
    { file: codex, kind: 'shell', host: !!hosts.codex, shared: true, receipt: AQE_SHELL_PIN_RECEIPT, where: `${codex} [shell_environment_policy.set]` },
  ];
  const trackedFiles = new Map();
  const isTracked = (file) => {
    if (!trackedFiles.has(file)) trackedFiles.set(file, tracks(root, file));
    return trackedFiles.get(file);
  };
  return list
    .map((t) => {
      const wanted = active && t.host;
      const tracked = wanted && t.shared && isTracked(t.file);
      return { file: t.file, kind: t.kind, receipt: t.receipt ?? AQE_PIN_RECEIPT, where: t.where ?? t.file,
        boundary: root, enabled: wanted && !tracked, tracked };
    })
    .filter((t) => t.enabled || t.tracked || fs.existsSync(`${t.file}${t.receipt}`));
}

const TRACKED_REASON = 'git tracks this file: a committed absolute path would point teammates\' AQE at a path that does not exist on their machines';

const isAbsoluteAny = (value) => typeof value === 'string' && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));

/** The first absolute pin value naming a root other than this one (a settings file
 *  copied from another checkout), or null. */
function foreignRootOf(current, desired) {
  const key = AQE_PIN_KEYS.find((k) => isAbsoluteAny(current[k]) && current[k] !== desired[k]);
  return key ? current[key] : null;
}

function currentValues(target) {
  try {
    const source = readRegularConfig(target.file);
    const editor = EDITORS[target.kind](source);
    if (editor.missing) return {};
    return Object.fromEntries(AQE_PIN_KEYS.filter((k) => editor.get(k).present).map((k) => [k, editor.get(k).value]));
  } catch { return {}; }
}

function reconcileTarget(target, desired, dryRun) {
  const wanted = Object.fromEntries(AQE_PIN_KEYS.map((k) => [k, { present: true, value: desired[k] }]));
  const current = currentValues(target);
  /** @type {{file: string, kind: string, where: string, current: Record<string, string>, foreignRoot: string|null, reason: string|null}} */
  const base = { file: target.file, kind: target.kind, where: target.where, current, foreignRoot: foreignRootOf(current, desired), reason: null };
  if (target.tracked) {
    // Not pinned (B5-M5); a pin ak wrote before git tracked the file is released.
    const released = fs.existsSync(`${target.file}${target.receipt}`) ? reconcileTarget({ ...target, tracked: false }, desired, dryRun) : null;
    if (released?.status === 'failed' || released?.status === 'conflict') return released;
    return { ...base, foreignRoot: null, status: 'tracked', changed: !!released?.changed, keys: released?.keys ?? {}, conflicts: released?.conflicts ?? [], reason: TRACKED_REASON };
  }
  let plan;
  try {
    plan = planOwnedEnv(target, wanted, {
      receiptSuffix: target.receipt, format: 'multi', editorFor: EDITORS[target.kind], adoptable, trackCreated: true,
    });
  } catch (error) {
    // Planning refused the whole file (unrecognized transport, invalid or non-regular
    // configuration, a pending receipt): preserved, a hand fix.
    return { ...base, status: 'conflict', changed: false, keys: {}, conflicts: [], reason: error.message };
  }
  if (plan.changed && !dryRun) {
    try { applyOwnedEnv(plan, { backupTag: 'aqe-pin', keepBackups: 1 }); } catch (error) {
      return { ...base, status: 'failed', changed: false, keys: plan.keys ?? {}, conflicts: plan.conflicts ?? [], reason: error.message };
    }
  }
  return { ...base, status: plan.status, changed: plan.changed, keys: plan.keys ?? {}, conflicts: plan.conflicts ?? [] };
}

/**
 * Retired (agentic-qe#735, fixed in released agentic-qe >=3.14.5): every current
 * caller passes `enabled: false`, so this only releases a pin an older ak version
 * wrote, wherever a receipt still exists. Passing `enabled: true` (or omitting it
 * in a project whose `.agentic-qe` exists) still writes the pin; nothing calls it
 * that way anymore outside this module's own tests.
 * `ok` is false only when a write failed: a value ak preserves is a hand fix
 * (audit decision 13), not a failed sync.
 * @param {any} cfg @param {string} cwd @param {{dryRun?: boolean, enabled?: boolean, tracks?: (root: string, file: string) => boolean}} [options]
 */
export function reconcileAqePin(cfg, cwd = process.cwd(), { dryRun = false, enabled, tracks = gitTracks } = {}) {
  const root = repoRoot(cwd);
  if (root === null) return { ok: true, changed: false, root: null, findings: [], detail: 'not inside a repository; AQE not pinned' };
  const active = enabled ?? (cfg?.aqe !== false && fs.existsSync(projectAqeDir(root)));
  const desired = desiredAqePin(root);
  const findings = targets(cfg, root, active, tracks).map((target) => reconcileTarget(target, desired, dryRun));
  const ok = findings.every((f) => f.status !== 'failed');
  const changed = findings.some((f) => f.changed);
  const preserved = findings.filter((f) => f.status === 'conflict' || (f.status !== 'tracked' && f.conflicts.length));
  const tracked = [...new Set(findings.filter((f) => f.status === 'tracked').map((f) => f.file))];
  const trackedNote = tracked.length ? `AQE not pinned in ${tracked.join(', ')} (tracked by git; a committed absolute path would not exist on teammates' machines)` : '';
  const detail = !ok ? `AQE pin not written: ${findings.filter((f) => f.status === 'failed').map((f) => `${f.where} (${f.reason})`).join(', ')}`
    : preserved.length ? [`AQE pin: ak preserved values it does not own in ${preserved.map((f) => f.where).join(', ')}`, trackedNote].filter(Boolean).join('; ')
      : trackedNote || (changed ? `AQE ${active ? 'pinned to' : 'pin released in'} ${root}` : 'AQE pin converged');
  return { ok, changed, root, active, desired, findings, detail };
}

/** Whether ak holds a pin receipt in this project. */
export function aqePinReceiptPresent(root) {
  return targets({ integrations: { hosts: {} } }, root, false, () => false).length > 0;
}

const owned = (cfg) => {
  cfg.integrations ??= {};
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.aqePin ??= {};
  cfg.integrations.ownership.aqePin.projects ??= {};
  return cfg.integrations.ownership.aqePin.projects;
};

/** Remember a project that holds a pin receipt, so `ak uninstall` can release it from
 *  any folder. Returns true when kit.json gained the project. */
export function recordAqePinProject(cfg, root) {
  if (!root || !aqePinReceiptPresent(root)) return false;
  const projects = owned(cfg);
  const key = path.resolve(root);
  if (projects[key]) return false;
  projects[key] = true;
  return true;
}

/** `ak uninstall`: release the pin in every recorded project and the current one.
 *  @param {any} cfg @param {{cwd?: string}} [options] */
export function releaseAqePins(cfg, { cwd = process.cwd() } = {}) {
  const projects = owned(cfg);
  const roots = new Set(Object.keys(projects));
  const here = repoRoot(cwd);
  if (here && aqePinReceiptPresent(here)) roots.add(path.resolve(here));
  const lines = [];
  let ok = true;
  for (const root of roots) {
    if (!fs.existsSync(root)) { delete projects[root]; continue; }
    const result = reconcileAqePin(cfg, root, { enabled: false });
    const kept = result.findings.flatMap((f) => [f.reason, ...f.conflicts.map((c) => c.reason)]);
    if (result.ok && !aqePinReceiptPresent(root)) {
      delete projects[root];
      if (result.changed) lines.push({ level: 'ok', text: `AQE pin removed in ${root}` });
    } else {
      ok = false;
      lines.push({ level: 'warn', text: `AQE pin in ${root}: not fully released (${[result.detail, ...kept].filter(Boolean).join('; ')})` });
    }
  }
  return { ok, lines };
}
