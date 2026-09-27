// Ruflo's project JSON configuration and the memory root it selects
// (ruvnet/ruflo#3193, audit 2026-09-26 Addendum 2, problem 1).
//
// Two Ruflo rules meet here (@claude-flow/cli 3.45.0):
//  - getMemoryRoot (memory/memory-initializer.js): CLAUDE_FLOW_MEMORY_PATH,
//    else the first of claude-flow.config.json / .claude-flow/config.json in
//    the working directory whose `memory.persistPath ?? memory.path` is a
//    non-empty string (resolved against the working directory), else
//    <cwd>/.swarm. `ruflo init` writes .claude-flow/config.yaml, which this
//    lookup never reads.
//  - ConfigFileManager (services/config-file-manager.js): commands that
//    persist settings (`providers configure`, `config set`) write to the first
//    of those two files that exists, else to an existing CLAUDE_FLOW_CONFIG
//    file, else they CREATE claude-flow.config.json from Ruflo's defaults,
//    which include `memory.persistPath: "./data/memory"`.
// So the first provider ak registers in a project without Ruflo JSON
// configuration silently moves Ruflo's memory root away from .swarm, and the
// CLI reports "Database not found". Pinning `.swarm` first keeps it: Ruflo
// 3.45.0 keeps an existing persistPath and only adds its own keys (verified
// 2026-09-26). The guard also re-reads after each command, so a future Ruflo
// that overwrites the pin is caught, undone, and reported.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Ruflo's project configuration files, in its lookup order. `name` is the
 *  display form (forward slashes on every platform). */
const PROJECT_CONFIGS = Object.freeze([
  Object.freeze({ name: 'claude-flow.config.json', parts: ['claude-flow.config.json'] }),
  Object.freeze({ name: '.claude-flow/config.json', parts: ['.claude-flow', 'config.json'] }),
]);
/** Ruflo's own default memory folder, relative to the working directory. */
export const MEMORY_ROOT_PIN = '.swarm';
export const MEMORY_ROOT_UPSTREAM = 'ruvnet/ruflo#3193';

const readConfig = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

/** The configuration setting getMemoryRoot uses in `dir`, or null when Ruflo
 *  falls back to <dir>/.swarm: `{ file, name, key, value, resolved }`. A file
 *  that is malformed, or has no usable memory path, falls through to the next
 *  one, exactly as Ruflo's loop does. */
export function rufloConfigMemoryRoot(dir) {
  for (const { name, parts } of PROJECT_CONFIGS) {
    const file = path.join(dir, ...parts);
    if (!fs.existsSync(file)) continue;
    const memory = readConfig(file)?.memory;
    const value = memory?.persistPath ?? memory?.path;
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const key = memory?.persistPath != null ? 'memory.persistPath' : 'memory.path';
    return { file, name, key, value, resolved: path.resolve(dir, value) };
  }
  return null;
}

/** The file Ruflo's ConfigFileManager would write in `dir`, or null when it
 *  would create claude-flow.config.json from its defaults. */
export function rufloConfigTarget(dir, env = process.env) {
  for (const { parts } of PROJECT_CONFIGS) {
    const file = path.join(dir, ...parts);
    if (fs.existsSync(file)) return file;
  }
  const envPath = env.CLAUDE_FLOW_CONFIG;
  if (envPath && fs.existsSync(path.resolve(dir, envPath))) return path.resolve(dir, envPath);
  return null;
}

function samePath(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return path.resolve(a) === path.resolve(b) || real(a) === real(b);
}

/** Does Ruflo's configuration in `dir` point memory somewhere other than
 *  <dir>/.swarm? Returns the setting that does, or null. */
export function rufloMemoryRedirect(dir) {
  const setting = rufloConfigMemoryRoot(dir);
  return setting && !samePath(setting.resolved, path.join(dir, MEMORY_ROOT_PIN)) ? setting : null;
}

// Replace a JSON file in place: temp file + rename, keeping its mode, the way
// Ruflo's own writeAtomic does. No .bak: the file is Ruflo's, rewritten by it
// moments earlier, and only one key goes back.
function rewriteJson(file, data) {
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const restoreValue = (dir, before, after, target) => {
  if (before && before.file === after.file && before.key === after.key) return before.value;
  const relative = path.relative(dir, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : target;
};

/**
 * Keep Ruflo's memory root where it is while Ruflo commands that persist
 * configuration run in `dir`. When Ruflo would create its configuration from
 * defaults, a minimal claude-flow.config.json pinning `.swarm` is written first
 * (never over an existing file). `check()` after each command re-reads the
 * configuration; if the root moved, the previous value is put back into the
 * file Ruflo changed (Ruflo's other keys stay) and `{ moved: true, restored }`
 * says so. `error` is set when the pin could not be written: running the
 * command would then move memory, so the caller must not run it.
 * @param {string} dir
 * @param {{ env?: Record<string, string|undefined> }} [options]
 */
export function guardRufloMemoryRoot(dir, { env = process.env } = {}) {
  let pinned = null;
  if (!rufloConfigTarget(dir, env)) {
    const file = path.join(dir, ...PROJECT_CONFIGS[0].parts);
    try {
      fs.writeFileSync(file, `${JSON.stringify({ memory: { persistPath: MEMORY_ROOT_PIN } }, null, 2)}\n`, { flag: 'wx' });
      pinned = file;
    } catch (e) {
      if (e?.code !== 'EEXIST') return { pinned: null, error: `${e?.code ?? e?.message ?? e}`, check: () => ({ moved: false }) };
    }
  }
  const before = rufloConfigMemoryRoot(dir);
  const expected = before?.resolved ?? path.join(dir, MEMORY_ROOT_PIN);
  const check = () => {
    const after = rufloConfigMemoryRoot(dir);
    if (samePath(after?.resolved ?? path.join(dir, MEMORY_ROOT_PIN), expected)) return { moved: false };
    // A root can only move through a configuration setting, so `after` is set.
    const value = restoreValue(dir, before, after, expected);
    try {
      const data = readConfig(after.file) ?? {};
      data.memory = { ...(data.memory ?? {}) };
      const field = after.key.slice('memory.'.length);
      data.memory[field] = value;
      rewriteJson(after.file, data);
    } catch { /* reported below as not restored */ }
    const now = rufloConfigMemoryRoot(dir);
    const restored = samePath(now?.resolved ?? path.join(dir, MEMORY_ROOT_PIN), expected);
    return { moved: true, restored, name: after.name, key: after.key, value: after.value, restoredValue: value };
  };
  return { pinned, error: null, check };
}
