// All platform-specific filesystem locations in ONE place. Every other module
// asks this one; nothing else may compute a home-relative or global-npm path.
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { writePrivateFileAtomic } from './file-write.mjs';

const home = os.homedir();
const isWindows = process.platform === 'win32';

/** The XDG Base Directory spec ignores relative environment overrides. */
export function xdgBase(name, fallback, { env = process.env, p = path } = {}) {
  const value = env[name];
  return value && p.isAbsolute(value) ? value : fallback;
}

/** Kit config dir: XDG on POSIX, %APPDATA% on Windows. */
function configBase() {
  if (isWindows) return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return xdgBase('XDG_CONFIG_HOME', path.join(home, '.config'));
}
export function stateBase({ env = process.env, home: h = home, platform = process.platform, p = path } = {}) {
  if (platform === 'win32') return env.LOCALAPPDATA || p.join(h, 'AppData', 'Local');
  return xdgBase('XDG_STATE_HOME', p.join(h, '.local', 'state'), { env, p });
}
/** The user's cache base: XDG on POSIX, %LOCALAPPDATA% on Windows (the base stateBase() uses there). */
export function cacheBase({ env = process.env, home: h = home, platform = process.platform, p = path } = {}) {
  if (platform === 'win32') return env.LOCALAPPDATA || p.join(h, 'AppData', 'Local');
  return xdgBase('XDG_CACHE_HOME', p.join(h, '.cache'), { env, p });
}
/** The kit's cache of derived data it can rebuild: `<cache base>/agentic-kit` on macOS and Linux, and
 *  `%LOCALAPPDATA%\agentic-kit\cache` on Windows, where stateBase() already owns `…\agentic-kit`. */
export function cacheDir(opts = {}) {
  const { platform = process.platform, p = path } = opts;
  const base = cacheBase(opts);
  return platform === 'win32' ? p.join(base, 'agentic-kit', 'cache') : p.join(base, 'agentic-kit');
}
export const configDir = () => path.join(configBase(), 'agentic-kit');
export const telemetryDir = () => path.join(configDir(), 'telemetry');
export const hookHealingTransactionsDir = () => path.join(stateBase(), 'agentic-kit', 'hook-healing');
export const maintenanceControlDir = () => path.join(stateBase(), 'agentic-kit', 'maintenance');
/** Backups and receipts of the one-time setup probe-row cleanup (memory-probe-cleanup.mjs). */
export const memoryProbeCleanupDir = () => path.join(stateBase(), 'agentic-kit', 'memory-probe-cleanup');
/** Backups, archived stray AQE stores and receipts of `ak x aqe-store merge` (aqe-store-merge.mjs). */
export const aqeStoreMergeDir = () => path.join(stateBase(), 'agentic-kit', 'aqe-store-merge');
/** Shared evidence envelope store: live checks, ruflo-components, and other per-id evidence. */
export const evidenceDir = () => path.join(stateBase(), 'agentic-kit', 'evidence');
/** Receipts for edits ak makes inside another tool's install (install-edits.mjs). */
export const installEditsPath = () => path.join(stateBase(), 'agentic-kit', 'install-edits.json');
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
/** Hermes user-level configuration; keep discovery roots absolute. */
export const hermesDir = () => path.resolve(process.env.HERMES_HOME || path.join(home, '.hermes'));

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

/** The one user-level Ruflo memory store, for launches outside any usable
 *  project folder (ruflo-memory.mjs rufloMemoryLocation). Ruflo defines no
 *  user-level memory store; it keeps its user-level state in ~/.claude-flow
 *  (@claude-flow/cli 3.45.0: memory/intelligence.js `~/.claude-flow/neural`,
 *  update/rate-limiter.js, services/global-ai-budget.js, commands/daemon.js),
 *  so ak's store follows that convention as ~/.claude-flow/memory. */
export const userMemoryDir = (h = home, p = path) => p.join(h, '.claude-flow', 'memory');

/** Folders that belong to a tool rather than to the user's work: a Ruflo
 *  store is never created inside one. Environment overrides and the defaults
 *  both count (a store under either is equally out of sight). The XDG-style
 *  folders count on every platform: cross-platform CLIs keep them under the
 *  Windows home too (Claude Code's native installer uses ~\.local\bin, tools
 *  built on xdg-basedir use ~\.config). `p` is the path flavour, injectable so
 *  Windows rules can be tested on any host (see globalRootCandidates). */
export function toolInternalDirs({ home: h = home, env = process.env, platform = process.platform, p = path } = {}) {
  const dirs = [
    p.join(h, '.claude'), env.CLAUDE_CONFIG_DIR,
    p.join(h, '.codex'), env.CODEX_HOME,
    p.join(h, '.claude-flow'), p.join(h, '.ruflo'),
    p.join(h, '.config'), xdgBase('XDG_CONFIG_HOME', null, { env, p }),
    p.join(h, '.local'), xdgBase('XDG_DATA_HOME', null, { env, p }),
    xdgBase('XDG_STATE_HOME', null, { env, p }), p.join(h, '.cache'),
    xdgBase('XDG_CACHE_HOME', null, { env, p }),
  ];
  if (platform === 'win32') dirs.push(p.join(h, 'AppData'), env.APPDATA, env.LOCALAPPDATA);
  if (platform === 'darwin') dirs.push(p.join(h, 'Library', 'Application Support'), p.join(h, 'Library', 'Caches'));
  return [...new Set(dirs.filter(Boolean).map((dir) => p.resolve(dir)))];
}

/** The temporary roots themselves. A folder BELOW one (a disposable project)
 *  is ordinary work and is not listed. */
export function tempRoots({ env = process.env, platform = process.platform, p = path } = {}) {
  const roots = [os.tmpdir(), env.TMPDIR, env.TEMP, env.TMP];
  if (platform !== 'win32') roots.push('/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp');
  return [...new Set(roots.filter(Boolean).map((dir) => p.resolve(dir)))];
}

/** Per-project locations, relative to a project root. */
export const projectSettings = (root) => path.join(root, '.claude', 'settings.json');
export const projectSettingsLocal = (root) => path.join(root, '.claude', 'settings.local.json');
export const projectStatusline = (root) => path.join(root, '.claude', 'helpers', 'statusline.cjs');
export const projectMemoryDb = (root, p = path) => p.join(root, '.swarm', 'memory.db');
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

const GLOBAL_ROOT_EVIDENCE_MAX_AGE_MS = 24 * 3600_000;

// paths.mjs cannot import src/lib/evidence.mjs's readEvidence/writeEvidence:
// evidence.mjs itself imports paths.mjs for evidenceDir() (`export const
// evidenceDir = paths.evidenceDir`), and paths.mjs is the module almost every
// real entry point loads first — a minimal repro confirms whichever of the
// pair is entered FIRST throws "Cannot access '...' before initialization" on
// that line the moment the other imports back (a `const` read of a binding
// the peer hasn't assigned yet). This local envelope writes the exact same
// on-disk shape (kind/id.json under evidenceDir(), the same record fields) so
// nothing downstream needs to know it isn't the shared helper — it just
// avoids the require cycle.
function globalRootEvidenceFile() {
  return path.join(evidenceDir(), 'npm-global-root', 'machine.json');
}

/** Exported so tests can compute the same key without duplicating (and
 *  risking drifting from) this hashing logic — mirrors `_setGlobalRootForTest`
 *  as a small, deliberate test-support surface. */
export function globalRootInputsKey(env = process.env) {
  const normalized = {
    execPath: process.execPath, PATH: env.PATH ?? '', npm_config_prefix: env.npm_config_prefix ?? '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

function readGlobalRootEvidence(inputsKey) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(globalRootEvidenceFile(), 'utf8'));
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || record.version !== 1) return null;
  if (record.inputsKey !== inputsKey) return null;
  const checkedAtMs = Date.parse(record.checkedAt);
  if (!Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > GLOBAL_ROOT_EVIDENCE_MAX_AGE_MS) return null;
  return typeof record.result?.path === 'string' ? record.result.path : null;
}

function writeGlobalRootEvidence(inputsKey, resolvedPath, source) {
  const record = {
    version: 1,
    kind: 'npm-global-root',
    id: 'machine',
    source,
    checkedAt: new Date().toISOString(),
    inputsKey,
    inputs: { execPath: process.execPath },
    result: { path: resolvedPath },
  };
  try {
    writePrivateFileAtomic(globalRootEvidenceFile(), `${JSON.stringify(record)}\n`);
  } catch {
    // Best-effort cache: a failed write just means the next call probes again.
  }
}

let _globalRoot = null;
/** npm's global node_modules. Cached per process AND across processes via the
 *  evidence store (kind 'npm-global-root', 24h TTL — this fact is stable
 *  enough on a given machine that a stale answer is low-risk, and it is
 *  invalidated the moment PATH/npm_config_prefix/execPath change). Derivation
 *  order mirrors upstream #2221: `npm root -g` is authoritative; execPath-
 *  derived candidates cover environments where npm itself is missing from
 *  PATH — which is not as rare as it reads, since every sandboxed test and
 *  hook runs that way.
 *
 *  `refresh` DEFAULTS TO FALSE here (unlike every other evidence-gated check
 *  in this branch, which defaults to `true`): this function had no gating
 *  concept before, was always spawn-on-every-call regardless of caller, and
 *  every existing call site invokes it bare (`globalRoot()`) — so a
 *  cache-first default is what closes the gap for all of them for free,
 *  without needing every caller updated. Pass `refresh: true` for a call site
 *  that genuinely needs a forced fresh read.
 *
 *  `record` ALSO DEFAULTS TO FALSE here (the opposite of every other
 *  evidence-gated check in this branch, whose libraries are reached only from
 *  status.mjs's own collect() tree). globalRoot() is instead the single most
 *  transitively-called function in the codebase — installedVersion(),
 *  rufloRoot(), aqeRoot(), rufloCliPkgRoot() and dozens of their own callers
 *  all route through a bare `globalRoot()` with zero args, in setup, sync,
 *  uninstall, heal, audit and every test that touches any of them. A
 *  record-defaults-true design would make evidence writes a silent side
 *  effect of nearly any ak invocation (or test), including reads sync's own
 *  `record: false` plan-computation pass never intended to persist anything
 *  (that flag can't reach globalRoot(): versions.mjs, which calls
 *  installedVersion() → globalRoot(), is a separate call path this exception
 *  does not thread `record` through — see ADR-0063).
 *  Persisting is instead the responsibility of the one caller that actually
 *  owns the branch's `refresh`/`record` contract end-to-end — status.mjs's
 *  collect() warms the in-process memo once, with the real refresh/record,
 *  right after loadKitConfig() — so every other bare `globalRoot()` call in
 *  that same process (however deep) reuses the memo for free and never
 *  itself decides whether to write. */
export function globalRoot({ refresh = false, record = false, source = 'status' } = {}) {
  if (_globalRoot && !refresh) return _globalRoot;
  const inputsKey = globalRootInputsKey();
  if (!refresh) {
    const cached = readGlobalRootEvidence(inputsKey);
    if (cached) { _globalRoot = cached; return _globalRoot; }
  }
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
  if (record) writeGlobalRootEvidence(inputsKey, _globalRoot, source);
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
export function repoRoot(cwd = process.cwd(), p = path) {
  let dir = p.resolve(cwd);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(p.join(dir, '.git'))) return dir;
    const parent = p.dirname(dir);
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

/** Bounded local inputs whose changes invalidate dashboard host-health evidence.
 * Includes native custom roots and ancestor project layers. Remote policy is
 * time-bound observation, never claimed to be snapshotted by this local list. */
export function hostHealthInputPaths(cwd, env = process.env) {
  const claude = env.CLAUDE_CONFIG_DIR || claudeDir();
  const codex = env.CODEX_HOME || codexDir();
  const opencode = env.OPENCODE_CONFIG_DIR || opencodeDir();
  const files = [
    path.join(claude, 'settings.json'), path.join(claude, '.credentials.json'), claudeUserMcpPath(),
    claudeManagedSettingsPath(), path.join(codex, 'config.toml'), path.join(codex, 'auth.json'),
    path.join(codex, 'requirements.toml'), '/etc/codex/config.toml', '/etc/codex/requirements.toml',
    ...(process.platform === 'win32' ? [path.join(env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex', 'config.toml')] : []),
    path.join(opencode, 'config.json'), path.join(opencode, 'opencode.json'), path.join(opencode, 'opencode.jsonc'),
    path.join(xdgBase('XDG_STATE_HOME', path.join(home, '.local', 'state'), { env }), 'opencode', 'model.json'),
    path.join(xdgBase('XDG_DATA_HOME', path.join(home, '.local', 'share'), { env }), 'opencode', 'auth.json'),
    env.OPENCODE_CONFIG,
  ].filter(Boolean);
  let root = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    for (const relative of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json',
      '.codex/config.toml', '.codex/hooks.json', 'opencode.json', 'opencode.jsonc',
      '.opencode/opencode.json', '.opencode/opencode.jsonc']) files.push(path.join(root, relative));
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return [...new Set(files.map(file => path.resolve(file)))];
}
