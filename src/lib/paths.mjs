// All platform-specific filesystem locations in ONE place. Every other module
// asks this one; nothing else may compute a home-relative or global-npm path.
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const home = os.homedir();
const isWindows = process.platform === 'win32';

/** Kit config dir: XDG on POSIX, %APPDATA% on Windows. */
function configBase() {
  if (isWindows) return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}
export const configDir = () => path.join(configBase(), 'agentic-kit');
/** The ruflo-era config dir — read-fallback for kit.json migration and the
 *  target of uninstall's legacy shell-kit cleanup. */
export const legacyConfigDir = () => path.join(configBase(), 'ruflo');

export const kitConfigPath = () => path.join(configDir(), 'kit.json');
export const legacyKitConfigPath = () => path.join(legacyConfigDir(), 'kit.json');

/** Claude Code user-level locations (same shape on all platforms). */
export const claudeDir = () => path.join(home, '.claude');
export const claudeMdPath = () => path.join(claudeDir(), 'CLAUDE.md');
export const claudeSettingsPath = () => path.join(claudeDir(), 'settings.json');
export const claudeUserMcpPath = () => path.join(home, '.claude.json');
export const claudeSkillsDir = () => path.join(claudeDir(), 'skills');

/** Per-project locations, relative to a project root. */
export const projectSettings = (root) => path.join(root, '.claude', 'settings.json');
export const projectSettingsLocal = (root) => path.join(root, '.claude', 'settings.local.json');
export const projectStatusline = (root) => path.join(root, '.claude', 'helpers', 'statusline.cjs');
export const projectMemoryDb = (root) => path.join(root, '.swarm', 'memory.db');
export const projectClaudeFlowDir = (root) => path.join(root, '.claude-flow');
export const projectAqeDir = (root) => path.join(root, '.agentic-qe');

let _globalRoot = null;
/** npm's global node_modules. Cached per process. Derivation order mirrors
 *  upstream #2221: `npm root -g` is authoritative; execPath-derived candidates
 *  cover environments where npm itself is missing from PATH (rare). */
export function globalRoot() {
  if (_globalRoot) return _globalRoot;
  try {
    _globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: isWindows, // npm is npm.cmd on Windows
    }).trim();
  } catch {
    const binDir = path.dirname(process.execPath);
    for (const cand of [
      path.join(binDir, '..', 'lib', 'node_modules'), // POSIX layout
      path.join(binDir, 'node_modules'),              // Windows / some managers
    ]) {
      if (fs.existsSync(cand)) { _globalRoot = path.resolve(cand); break; }
    }
  }
  if (!_globalRoot) throw new Error('cannot determine npm global root (is npm installed?)');
  return _globalRoot;
}

/** For tests: override the cached global root. */
export function _setGlobalRootForTest(p) { _globalRoot = p; }

/** npm's npx cache (`<npm-cache>/_npx`). Resolved from npm_config_cache or the
 *  platform default (~/.npm on POSIX, %LocalAppData%\npm-cache on npm>=7
 *  Windows) WITHOUT spawning npm: a `npm config set cache` userconfig custom
 *  path would be missed, but a miss only means an empty scan — the stale-env
 *  prune quietly does nothing, it never prunes the wrong directory. */
export const npxCacheDir = () => {
  const cache = process.env.npm_config_cache
    || (isWindows
      ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'npm-cache')
      : path.join(home, '.npm'));
  return path.join(cache, '_npx');
};

/** Nearest ancestor of `cwd` (inclusive) containing `.git`, or null. Bounded
 *  walk. The project-vs-user scope decision MUST use this, not a cwd-only
 *  probe: a cwd-only check run from a repo SUBDIR reports "not a project" and
 *  sends project-scoped env (ENABLE_* and AQE_LLM_PROVIDER) into the machine-wide
 *  user settings — while the sibling gates skip their project work — and the
 *  leak is then invisible/unreversible from the repo root. */
export function repoRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export const rufloRoot = () => path.join(globalRoot(), 'ruflo');
export const rufloNodeModules = () => path.join(rufloRoot(), 'node_modules');
export const rufloCliDist = () =>
  path.join(rufloNodeModules(), '@claude-flow', 'cli', 'dist', 'src');
export const aqeRoot = () => path.join(globalRoot(), 'agentic-qe');

export { isWindows, home };
