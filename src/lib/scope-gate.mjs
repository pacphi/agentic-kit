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
