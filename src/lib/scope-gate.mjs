// Report-only scope gate (ADR-0064, "Making it stick"). It records writes
// outside the project root and the cache, and commands that change user-level
// state. While ENFORCEMENT is 'report' it never blocks or changes anything.
// Imports only node: built-ins and cache-dir.mjs, so file-write.mjs and
// exec.mjs can call it without an import cycle.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './cache-dir.mjs';

/** 'report' records and carries on; any other value makes the checks throw. */
export const ENFORCEMENT = 'report';
export const MAX_VIOLATIONS = 1000;

export class OutOfScopeWrite extends Error {
  constructor(violation) {
    super(`write outside the project scope: ${violation.target}`);
    this.name = 'OutOfScopeWrite';
    this.violation = violation;
  }
}

export class OutOfScopeCommand extends Error {
  constructor(violation) {
    super(`command outside the project scope: ${violation.target}`);
    this.name = 'OutOfScopeCommand';
    this.violation = violation;
  }
}

const scopeStore = new AsyncLocalStorage();
const recorded = [];
let dropped = 0;
const foldsCase = process.platform === 'win32' || process.platform === 'darwin';
const now = () => new Date().toISOString();

/** Run `fn` with `root` as the project root for every check made inside it.
 *  @template T @param {{ root: string | null }} scope @param {() => T} fn @returns {T} */
export const withWriteScope = ({ root }, fn) => scopeStore.run({ root: root ? path.resolve(root) : null }, fn);

/** A copy of the violations recorded so far. */
export const violations = () => recorded.slice();
/** How many violations were dropped because the list was full. */
export const droppedViolations = () => dropped;
export function clearViolations() {
  recorded.length = 0;
  dropped = 0;
}

/** True when `child` is `parent` or lies beneath it. Both must be absolute. */
export function isInside(parent, child, { foldCase = foldsCase } = {}) {
  const from = foldCase ? parent.toLowerCase() : parent;
  const to = foldCase ? child.toLowerCase() : child;
  const rel = path.relative(from, to);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The absolute path with symlinks resolved on the nearest existing ancestor, so a link or a
 *  dot-dot segment cannot carry a write out of scope unseen. Unknown errors propagate. */
function realPath(target) {
  const full = path.resolve(target);
  const tail = [];
  let current = full;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.slice().reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return full;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

const scopeRoot = () => {
  const root = scopeStore.getStore()?.root;
  return root ? realPath(root) : null;
};

/** Record `violation`, then throw `ErrorClass` unless the mode is 'report'. */
function settle(violation, ErrorClass, mode) {
  if (!violation) return null;
  if (recorded.length < MAX_VIOLATIONS) recorded.push(Object.freeze(violation));
  else dropped += 1;
  if (mode !== 'report') throw new ErrorClass(violation);
  return violation;
}

/** Report a write to `file` unless it lies under the scope root or the cache.
 *  @param {string} file @param {string} [op] @param {{ mode?: string }} [options]
 *  @returns {object | null} the violation, or null when the write is in scope */
export function checkWrite(file, op = 'write', { mode = ENFORCEMENT } = {}) {
  let violation = null;
  try {
    const target = realPath(file);
    const root = scopeRoot();
    const inScope = (root && isInside(root, target)) || isInside(realPath(cacheDir()), target);
    if (!inScope) violation = { kind: 'OutOfScopeWrite', target, op, scopeRoot: root, time: now() };
  } catch { /* a failed probe must not break the write it observes */ }
  return settle(violation, OutOfScopeWrite, mode);
}

const NPM_INSTALL_VERBS = new Set(['install', 'i', 'add']);
const CLAUDE_VERBS = {
  mcp: new Set(['add', 'add-json', 'add-from-claude-desktop', 'remove', 'reset-project-choices']),
  plugin: new Set(['install', 'uninstall', 'enable', 'disable', 'update']),
};

/** The command's bare name: any folder and a Windows shim extension are dropped. */
const commandName = (cmd) => String(cmd).split(/[\\/]/).pop().replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();

const isGlobalNpm = (args) => args.some((arg, index) => arg === '-g' || arg === '--global'
  || arg === '--location=global' || (arg === '--location' && args[index + 1] === 'global'));

/** The value of `-s`, `--scope`, `-s=` or `--scope=`, or null when no scope is given. */
function scopeOption(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-s' || args[index] === '--scope') return args[index + 1] ?? null;
    const inline = /^(?:-s|--scope)=(.+)$/.exec(args[index]);
    if (inline) return inline[1];
  }
  return null;
}

/** A claude change with no `-s` is not classified: `--help` does not state the default scope. */
function claudeRule(args, cwd, root) {
  const area = args[0] === 'plugins' ? 'plugin' : args[0];
  if (!CLAUDE_VERBS[area]?.has(args[1])) return null;
  const scope = scopeOption(args);
  if (scope === 'user') return `claude-${area}-user-scope`;
  if (scope === 'local' || scope === 'project') {
    return root && isInside(root, cwd) ? null : `claude-${area}-scope-outside-root`;
  }
  return null;
}

function commandRule(cmd, args, cwd, root) {
  const name = commandName(cmd);
  if (name === 'launchctl') return 'launchctl';
  if (name === 'npm') return args.some((arg) => NPM_INSTALL_VERBS.has(arg)) && isGlobalNpm(args) ? 'npm-install-global' : null;
  if (name === 'codex') return args[0] === 'mcp' && args[1] === 'add' ? 'codex-mcp-add' : null;
  if (name === 'claude') return claudeRule(args, cwd, root);
  return null;
}

/** Report a command that changes user-level state, or runs a project-scoped claude change from
 *  outside the scope root. Matching is on parsed argv, never on a joined string.
 *  @param {string} cmd @param {string[]} [args] @param {string} [cwd] @param {{ mode?: string }} [options]
 *  @returns {object | null} the violation, or null when the command is allowed */
export function checkCommand(cmd, args = [], cwd = undefined, { mode = ENFORCEMENT } = {}) {
  let violation = null;
  try {
    const argv = (args ?? []).map(String);
    const root = scopeRoot();
    const where = realPath(cwd ?? process.cwd());
    const rule = commandRule(cmd, argv, where, root);
    if (rule) {
      violation = {
        kind: 'OutOfScopeCommand', rule, target: [String(cmd), ...argv].join(' '),
        op: 'exec', scopeRoot: root, cwd: where, time: now(),
      };
    }
  } catch { /* observing a command must not break it */ }
  return settle(violation, OutOfScopeCommand, mode);
}
