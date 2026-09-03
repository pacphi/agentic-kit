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
function stateBase() {
  if (isWindows) return process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
}
export const configDir = () => path.join(configBase(), 'agentic-kit');
export const hookHealingTransactionsDir = () => path.join(stateBase(), 'agentic-kit', 'hook-healing');
export const maintenanceControlDir = () => path.join(stateBase(), 'agentic-kit', 'maintenance');
/** The ruflo-era config dir — read-fallback for kit.json migration and the
 *  target of uninstall's legacy shell-kit cleanup. */
export const legacyConfigDir = () => path.join(configBase(), 'ruflo');

export const kitConfigPath = () => path.join(configDir(), 'kit.json');
/** Trusted process-scoped agent-browser config. Ruflo MCP children receive
 * this absolute path; repository agent-browser.json discovery is bypassed. */
export const agentBrowserConfigPath = () => path.join(configDir(), 'agent-browser.json');
export const observabilityWorkspacePath = () =>
  path.join(configDir(), 'observability-workspaces.json');
export const legacyKitConfigPath = () => path.join(legacyConfigDir(), 'kit.json');

/** Claude Code user-level locations (same shape on all platforms). */
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
export const claudeMdPath = () => path.join(claudeDir(), 'CLAUDE.md');
export const claudeSettingsPath = () => path.join(claudeDir(), 'settings.json');
/** Claude Code's machine-managed policy file, when the platform defines one. */
export const claudeManagedSettingsPath = (platform = process.platform) => ({
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
})[platform] ?? null;
export const claudeUserMcpPath = () => path.join(home, '.claude.json');
export const claudeSkillsDir = () => path.join(claudeDir(), 'skills');

/** OpenAI Codex user-level locations. `~/.codex` is codex's home; its global
 *  guidance file is AGENTS.md (the codex analogue of ~/.claude/CLAUDE.md). ak
 *  reads/writes this dir but NEVER creates it — its existence is the signal that
 *  codex is installed on the machine (see blocks.guidanceTargets). */
export const codexDir = () => path.join(home, '.codex');
export const codexAgentsMdPath = () => path.join(codexDir(), 'AGENTS.md');
export const codexConfigPath = () => path.join(codexDir(), 'config.toml');
export const codexPluginCacheDir = () => path.join(codexDir(), 'plugins', 'cache');

/** opencode user-level locations (XDG config home, same base as the kit's own
 *  configDir). `~/.config/opencode` is opencode's global config home; like
 *  ~/.codex, ak NEVER creates it — existence signals opencode is installed. */
export const opencodeDir = () => path.join(configBase(), 'opencode');
export const opencodeConfigPath = () => path.join(opencodeDir(), 'opencode.json');
export const opencodeAgentsMdPath = () => path.join(opencodeDir(), 'AGENTS.md');
export const opencodePluginsDir = () => path.join(opencodeDir(), 'plugins');
export const opencodeAgentsDir = () => path.join(opencodeDir(), 'agents');
export const opencodeSkillsDir = () => path.join(opencodeDir(), 'skills');

/** Per-project locations, relative to a project root. */
export const projectSettings = (root) => path.join(root, '.claude', 'settings.json');
export const projectSettingsLocal = (root) => path.join(root, '.claude', 'settings.local.json');
export const projectStatusline = (root) => path.join(root, '.claude', 'helpers', 'statusline.cjs');
export const projectMemoryDb = (root) => path.join(root, '.swarm', 'memory.db');
export const projectAgentDbMemoryDb = (root) => path.join(root, '.swarm', 'agentdb-memory.db');
export const projectClaudeFlowDir = (root) => path.join(root, '.claude-flow');
export const projectAqeDir = (root) => path.join(root, '.agentic-qe');

/** How many ancestors of the executable's bin/ dir may host a global tree.
 *  Homebrew's kegged layout needs four (`<prefix>/Cellar/node/<version>/bin`
 *  → `<prefix>`); the bound keeps the walk away from the filesystem root. */
const GLOBAL_ROOT_MAX_ASCENT = 5;

/** Spawn-free candidates for npm's global node_modules, nearest-first.
 *  Exported for tests: the layouts this must cover are host-specific, so they
 *  are asserted as data rather than reproduced by installing node five ways.
 *
 *  `npm_config_prefix` is npm's own documented override and wins when set.
 *  Otherwise the executable's location is the only evidence available. A plain
 *  POSIX install keeps the tree one level above `bin/`, but a *versioned*
 *  layout does not: Homebrew resolves `<prefix>/bin/node` to
 *  `<prefix>/Cellar/node/<version>/bin/node`, and mise/asdf/nvm place their
 *  shims similarly deep. `process.execPath` is already symlink-resolved by
 *  node, so the `<prefix>/bin/node` view is not observable here — walking the
 *  ancestors is how the linked prefix is recovered. */
export function globalRootCandidates(execPath = process.execPath, env = process.env, p = path) {
  const isRoot = (dir) => p.dirname(dir) === dir;
  const out = [];
  const prefix = env.npm_config_prefix;
  if (prefix) out.push(p.join(prefix, 'lib', 'node_modules'), p.join(prefix, 'node_modules'));
  const binDir = p.dirname(execPath);
  let dir = binDir;
  for (let ascent = 0; ascent < GLOBAL_ROOT_MAX_ASCENT; ascent += 1) {
    const parent = p.dirname(dir);
    if (parent === dir) break;
    // The filesystem root is not a prefix: `/lib/node_modules` (or `C:\lib\…`)
    // belongs to no install, so it is skipped rather than probed. The walk
    // still ascends past it in case an intermediate level qualifies.
    if (!isRoot(parent)) out.push(p.join(parent, 'lib', 'node_modules'));
    dir = parent;
  }
  out.push(p.join(binDir, 'node_modules')); // Windows / some managers
  return out;
}

/** First existing candidate, or null. Split out so the walk is testable
 *  against a fixture tree without touching the process-wide cache. */
export function resolveGlobalRoot(execPath = process.execPath, env = process.env, exists = fs.existsSync) {
  for (const cand of globalRootCandidates(execPath, env)) {
    if (exists(cand)) return path.resolve(cand);
  }
  return null;
}

let _globalRoot = null;
/** npm's global node_modules. Cached per process. Derivation order mirrors
 *  upstream #2221: `npm root -g` is authoritative; execPath-derived candidates
 *  cover environments where npm itself is missing from PATH — which is not as
 *  rare as it reads, since every sandboxed test and hook runs that way. */
export function globalRoot() {
  if (_globalRoot) return _globalRoot;
  try {
    _globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: isWindows, // npm is npm.cmd on Windows
    }).trim();
  } catch {
    _globalRoot = resolveGlobalRoot();
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

/** ruflo content sources for host integrations (opencode agents/skills).
 *  The published @claude-flow/cli package bundles a SUBSET (.claude/agents —
 *  the ADR-128 substrate set, .claude/skills); the FULL catalog (all agents +
 *  every plugin's skills + the platform SKILL.md) ships only in the git repo,
 *  which is mirrored by Claude Code's plugin marketplace clone
 *  (~/.claude/plugins/marketplaces/ruflo, auto-updated by claude). */
export const rufloCliPkgRoot = () => path.join(globalRoot(), '@claude-flow', 'cli');
export const rufloMarketplaceRoot = () =>
  path.join(home, '.claude', 'plugins', 'marketplaces', 'ruflo');

export { isWindows, home };
