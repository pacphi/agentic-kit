// All platform-specific filesystem locations in ONE place. Every other module
// asks this one; nothing else may compute a home-relative or global-npm path.
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const home = os.homedir();
const isWindows = process.platform === 'win32';

/** Kit config dir: XDG on POSIX, %APPDATA% on Windows. Same content as the
 *  shell kit's ~/.config/ruflo so an in-place migration is a no-op on POSIX. */
export function configDir() {
  if (isWindows) {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ruflo');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ruflo');
}

export const kitConfigPath = () => path.join(configDir(), 'kit.json');

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

export const rufloRoot = () => path.join(globalRoot(), 'ruflo');
export const rufloNodeModules = () => path.join(rufloRoot(), 'node_modules');
export const rufloCliDist = () =>
  path.join(rufloNodeModules(), '@claude-flow', 'cli', 'dist', 'src');
export const aqeRoot = () => path.join(globalRoot(), 'agentic-qe');

export { isWindows, home };
