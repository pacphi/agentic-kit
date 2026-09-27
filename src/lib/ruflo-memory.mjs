// One project-memory launch contract for every host. CLAUDE_FLOW_DB_PATH is
// read only by the `ruflo memory ...` CLI (it selects the memory.db file). The
// MCP memory_* tools never read it: the native AgentDB bridge derives
// agentdb-memory.db from the memory root (CLAUDE_FLOW_MEMORY_PATH, else
// <cwd>/.swarm). The two land in one directory only because this contract pins
// the cwd to the project root and the pin sits in <root>/.swarm
// (@claude-flow/cli memory-initializer.js resolveDbPath/getMemoryRoot and
// memory-bridge.js getAgentDbPath, 3.45.0). `ak x verify memory` observes
// which interface sees which write.
//
// Where the store lives (audit 2026-09-26 Addendum 2, problem 2): the Git
// repository root; else the plain work folder itself; but never the filesystem
// root, the home folder itself, a temporary root, or a tool's own folder
// (~/.codex, ~/.claude, ~/.config, …). Codex often starts there, and a store
// created there either fails (the filesystem root is read-only) or lands where
// no other host looks. Those route to ONE user-level store
// (paths.userMemoryDir) pinned through both CLAUDE_FLOW_MEMORY_PATH and
// CLAUDE_FLOW_DB_PATH, with Ruflo started inside it so cwd-relative files
// (AgentDB's agentdb.rvf, RuVector's ruvector.db) land beside it. A temporary
// root means the root itself: a disposable project below it (ak x verify
// memory's sandbox) is a plain work folder and keeps its own store.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { loadKitConfig } from './config.mjs';
import { managedAgentBrowserEnv } from './agent-browser.mjs';
import { installedVersion } from './versions.mjs';
import { componentEnv, RC_KEYS, supports } from './ruflo-components/env.mjs';
import { managedIntent } from './ruflo-components/config.mjs';
import { componentById } from './ruflo-components/catalogue.mjs';

// Every comparison goes through the path flavour `p` (the host's by default,
// injectable so Windows rules are testable anywhere). path.relative applies
// that platform's own rules, so on Windows `c:\users\me` and `C:\Users\Me`
// are the same folder, as the filesystem treats them.
const realOr = (p, file) => { try { return fs.realpathSync(file); } catch { return p.resolve(file); } };
const same = (p, a, b) => p.relative(a, b) === '';
const inside = (p, child, parent) => {
  const rel = p.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
};
/** `~/…` for a folder under the home folder, else the absolute path. */
export function homeRelative(file, home = paths.home, p = path) {
  const rel = p.relative(realOr(p, home), realOr(p, file));
  return rel && !rel.startsWith('..') && !p.isAbsolute(rel) ? `~/${rel.split(p.sep).join('/')}` : file;
}

/** Why `dir` (a real path) must not hold a Ruflo store, or null. A temporary
 *  root inside a tool folder (Windows' %TEMP% under %LOCALAPPDATA%, a TMPDIR
 *  under ~/.cache) does not make the disposable projects below it the tool's:
 *  the deeper boundary wins, so they keep their own store. */
function unsuitableReason(dir, { home, env, platform, p }) {
  if (p.dirname(dir) === dir) return 'the filesystem root';
  if (same(p, dir, realOr(p, home))) return 'the home folder';
  const temps = paths.tempRoots({ env, platform, p }).map((temp) => realOr(p, temp));
  if (temps.some((temp) => same(p, dir, temp))) return 'a temporary folder';
  const tool = paths.toolInternalDirs({ home, env, platform, p }).find((folder) => {
    const real = realOr(p, folder);
    return inside(p, dir, real) && !temps.some((temp) => inside(p, temp, real) && inside(p, dir, temp));
  });
  return tool ? `inside ${homeRelative(tool, home, p)}, a tool's own folder` : null;
}

/**
 * Where a Ruflo memory launch from `cwd` keeps its store:
 * `{ kind: 'project'|'folder'|'user', root, dir, db, reason }`. `root` is the
 * working directory the launch uses; `dir` holds memory.db and
 * agentdb-memory.db; `reason` says why a user-level store was chosen. `p` is
 * the path flavour (tests pass path.win32 to apply Windows rules on any host).
 * @param {string} [cwd]
 * @param {{ home?: string, env?: Record<string, string|undefined>, platform?: string, p?: typeof path }} [options]
 */
export function rufloMemoryLocation(cwd = process.cwd(), {
  home = paths.home, env = process.env, platform = process.platform, p = path,
} = {}) {
  const options = { home, env, platform, p };
  let reason = null;
  for (const [kind, candidate] of [['project', paths.repoRoot(cwd, p)], ['folder', cwd]]) {
    if (!candidate) continue;
    const root = realOr(p, candidate);
    const why = unsuitableReason(root, options);
    if (!why) return { kind, root, dir: p.join(root, '.swarm'), db: paths.projectMemoryDb(root, p), reason: null };
    reason ??= why;
  }
  const dir = paths.userMemoryDir(home, p);
  return { kind: 'user', root: dir, dir, db: p.join(dir, 'memory.db'), reason };
}

/** The project root every ak memory contract pins: the launcher's root for a
 *  project or plain folder. Outside any usable folder (the user-level store's
 *  cases) it stays the repository root or folder, for the callers that are not
 *  the Codex launcher (Claude-side harvest and setup; a follow-up decision). */
export function memoryProjectRoot(cwd = process.cwd(), options = {}) {
  const location = rufloMemoryLocation(cwd, options);
  return location.kind === 'user' ? fs.realpathSync(paths.repoRoot(cwd) ?? cwd) : location.root;
}

export function projectMemoryEnv(cwd = process.cwd(), env = {}) {
  const root = memoryProjectRoot(cwd);
  return { ...env, CLAUDE_FLOW_DB_PATH: paths.projectMemoryDb(root) };
}

export function rufloMcpLaunch(cwd = process.cwd(), env = process.env, {
  cfg = loadKitConfig(), rufloVersion = installedVersion('ruflo'), home = paths.home,
} = {}) {
  const location = rufloMemoryLocation(cwd, { home, env });
  const root = location.root;
  const rc = componentEnv(root, cfg, rufloVersion);
  const merged = {
    ...env,
    ...managedAgentBrowserEnv({ enabled: cfg.agentBrowser !== false }),
    ...rc,
  };
  // Governance is a project-scoped ak-owned key: when managed, ak either sets
  // it (valid policy) or actively clears a stale/inherited value (no/invalid
  // policy) — never leaves ruflo pointed at a policy file it can no longer
  // see, which would make it fail closed on every tool call (when ruflo's
  // enforcer is reachable; ruflo 3.44.0's stdio entry points do not reach it,
  // see ADR-0058 upstream request 6). When governance
  // is not managed, an inherited value is the user's own choice and is left
  // untouched.
  if (managedIntent(cfg, 'mcpGovernance') && supports(rufloVersion, componentById('mcpGovernance').minRuflo) && !(RC_KEYS.enforce in rc)) {
    delete merged[RC_KEYS.enforce];
  }
  // The user-level store has no project root to derive agentdb-memory.db
  // from, so the memory root is pinned too; a project keeps Ruflo's own
  // <cwd>/.swarm derivation (and any CLAUDE_FLOW_MEMORY_PATH the user set).
  const memoryEnv = location.kind === 'user'
    ? { CLAUDE_FLOW_MEMORY_PATH: location.dir, CLAUDE_FLOW_DB_PATH: location.db }
    : { CLAUDE_FLOW_DB_PATH: location.db };
  return {
    command: 'ruflo',
    args: ['mcp', 'start'],
    cwd: root,
    env: { ...merged, ...memoryEnv },
    location,
  };
}
