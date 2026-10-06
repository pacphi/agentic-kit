# Write gate and command gate (report-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

## Status

**Done** (2026-10-06). Implements card P0-07, issue
[#327](https://github.com/pacphi/agentic-kit/issues/327), release `4.0.0-beta.1`. Executed on
`feat/327-write-and-command-gate`. This card unblocks #328.

**Goal:** Report every write outside the project root and the cache, and every user-level command,
without changing any behaviour, and add a warn-level lint rule for direct `fs` writes.

**Architecture:** A new `src/lib/scope-gate.mjs` holds an `AsyncLocalStorage` write scope, a capped
in-process violation collector, `checkWrite` and `checkCommand`. Two thin hooks call it from
`file-write.mjs` and `exec.mjs` `run()`. A new leaf `cache-dir.mjs` (extracted from `paths.mjs`)
breaks an import cycle. A new `src/**` block in `eslint.config.mjs` warns on direct writes.

**Tech Stack:** Node 22+ ES modules (`.mjs`), `node:test`, ESLint 10 flat config, zero runtime
dependencies.

**Spec:** [2026-10-06-write-and-command-gate-design.md](2026-10-06-write-and-command-gate-design.md)

## Global Constraints

- Report-only: `ENFORCEMENT = 'report'`. Nothing throws or refuses in this card; throwing is P7-01.
- The violation list holds at most 1,000 entries and counts what it drops. Nothing is written to
  disk and nothing prints in production.
- Zero runtime dependencies. `scope-gate.mjs` imports only `node:` built-ins and `cache-dir.mjs`.
  It never imports `paths.mjs` or `exec.mjs`.
- The lint rule uses built-in ESLint rules only, at `warn`. Scope: `src/**/*.mjs` except
  `src/lib/file-write.mjs`, `src/lib/scope-gate.mjs` and `src/lib/paths.mjs`.
- Comments and `test(...)` titles must not carry transient labels such as "Task 3", "Step 2",
  "Fix round 2" or "Branch 6a". CI runs `pnpm run test:quality` to enforce this.
- Files stay under 500 lines. No secrets, no `Co-Authored-By` trailer.
- Commit messages: `<type>(<scope>): <description>`.
- Run tests with `node scripts/run-tests.mjs focus <file>`, never bare `node --test`.
- This worktree starts with no `node_modules`. Run `pnpm install --frozen-lockfile` once in it
  (safe because nothing is symlinked), and never `pnpm` in a worktree that has a symlinked
  `node_modules`.

## Review Focus

Failure modes the spec implies but no obvious test covers. Each has a test in the task that owns
the code:

1. A symlinked scope root (macOS `/var` → `/private/var`): a write through the real path and one
   through the link must both be in scope. Task 2.
2. A relative file path: it resolves against `process.cwd()` and is reported with its absolute
   path. Task 2.
3. A scope root given with a trailing separator, and a sibling folder sharing a name prefix. Task 2.
4. A long-lived process: the collector must stop growing at its cap and count what it dropped.
   Task 2.
5. A Windows-style command path such as `C:\Program Files\nodejs\npm.cmd`, and a missing `args`
   list: both must classify or be ignored without throwing. Task 3.

---

### Task 1: Extract the cache helpers into a leaf module

**Files:**

- Create: `src/lib/cache-dir.mjs`
- Modify: `src/lib/paths.mjs:13-39`
- Test: `tests/kit/cache-dir.test.mjs`

**Interfaces:**

- Consumes: nothing.
- Produces: `xdgBase(name, fallback, { env, p })`, `cacheBase(opts)` and `cacheDir(opts)` from
  `src/lib/cache-dir.mjs`. `paths.mjs` re-exports all three, so every existing import keeps working.

- [ ] **Step 1: Write the failing test**

Create `tests/kit/cache-dir.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as leaf from '../../src/lib/cache-dir.mjs';
import * as paths from '../../src/lib/paths.mjs';

test('paths.mjs re-exports the cache helpers unchanged', () => {
  assert.equal(paths.xdgBase, leaf.xdgBase);
  assert.equal(paths.cacheBase, leaf.cacheBase);
  assert.equal(paths.cacheDir, leaf.cacheDir);
});

test('cacheDir follows an absolute XDG_CACHE_HOME and ignores a relative one', () => {
  const posix = { home: '/h', platform: 'linux', p: path.posix };
  assert.equal(leaf.cacheDir({ ...posix, env: { XDG_CACHE_HOME: '/x/cache' } }), '/x/cache/agentic-kit');
  assert.equal(leaf.cacheDir({ ...posix, env: { XDG_CACHE_HOME: 'relative' } }), '/h/.cache/agentic-kit');
});

test('cacheDir on Windows lives under LOCALAPPDATA\\agentic-kit\\cache', () => {
  const win = { home: 'C:\\h', platform: 'win32', p: path.win32 };
  assert.equal(leaf.cacheDir({ ...win, env: { LOCALAPPDATA: 'C:\\L' } }), 'C:\\L\\agentic-kit\\cache');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node scripts/run-tests.mjs focus tests/kit/cache-dir.test.mjs`
Expected: FAIL with `Cannot find module '.../src/lib/cache-dir.mjs'`.

- [ ] **Step 3: Create the leaf module**

Create `src/lib/cache-dir.mjs`:

```js
// The kit's cache location and the XDG rule it shares with paths.mjs. A leaf
// module (node: built-ins only) so scope-gate.mjs can read the cache folder
// without importing paths.mjs, which imports file-write.mjs, which imports
// scope-gate.mjs.
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

/** The XDG Base Directory spec ignores relative environment overrides. */
export function xdgBase(name, fallback, { env = process.env, p = path } = {}) {
  const value = env[name];
  return value && p.isAbsolute(value) ? value : fallback;
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
```

- [ ] **Step 4: Make `paths.mjs` import and re-export them**

In `src/lib/paths.mjs`, view lines 10-40 first. Delete the three definitions: `xdgBase` (lines
13-17), `cacheBase` (lines 28-32) and `cacheDir` (lines 33-39), with their doc comments. Keep
`configBase()` and `stateBase()`. Add, directly under the existing `import { writePrivateFileAtomic }`
line:

```js
import { xdgBase, cacheBase, cacheDir } from './cache-dir.mjs';
export { xdgBase, cacheBase, cacheDir };
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `node scripts/run-tests.mjs focus tests/kit/cache-dir.test.mjs`
Expected: PASS, 3 tests.

Run: `node_modules/.bin/tsc -p tsconfig.json`
Expected: no output (no type errors).

- [ ] **Step 6: Run the tests that import paths.mjs**

Run: `node scripts/run-tests.mjs focus tests/kit/paths-global-root.test.mjs`
Expected: PASS.

Run: `node scripts/run-tests.mjs focus tests/kit/paths-global-root-evidence.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/cache-dir.mjs src/lib/paths.mjs tests/kit/cache-dir.test.mjs
git commit -m "refactor(paths): move the cache helpers into a leaf module (P0-07)

scope-gate.mjs needs cacheDir() but cannot import paths.mjs, which imports
file-write.mjs. paths.mjs re-exports the helpers unchanged."
```

---

### Task 2: The scope, the collector and `checkWrite`

**Files:**

- Create: `src/lib/scope-gate.mjs`
- Test: `tests/kit/scope-gate.test.mjs`

**Interfaces:**

- Consumes: `cacheDir()` from `src/lib/cache-dir.mjs`.
- Produces, all exported from `src/lib/scope-gate.mjs`:
  - `ENFORCEMENT: 'report'`, `MAX_VIOLATIONS: 1000`
  - `class OutOfScopeWrite extends Error`, `class OutOfScopeCommand extends Error`, each carrying
    `.violation`
  - `withWriteScope({ root }, fn)` returns `fn`'s result
  - `checkWrite(file, op = 'write', { mode = ENFORCEMENT } = {})` returns the violation or `null`
  - `isInside(parent, child, { foldCase } = {})` returns a boolean
  - `violations()` returns a copy of the recorded list, `droppedViolations()` returns a number,
    `clearViolations()` resets both
  - a violation is `{ kind, target, op, scopeRoot, time }` (commands add `rule` and `cwd`)

- [ ] **Step 1: Write the failing tests**

Create `tests/kit/scope-gate.test.mjs`:

```js
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkWrite, clearViolations, droppedViolations, isInside, MAX_VIOLATIONS, OutOfScopeWrite,
  violations, withWriteScope,
} from '../../src/lib/scope-gate.mjs';
import { cacheDir } from '../../src/lib/cache-dir.mjs';
import { rmrf, sandboxHome } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const home = sandboxHome('scope-gate');
after(() => rmrf(home));
beforeEach(() => clearViolations());

test('a write inside the scope root is not reported', (t) => {
  const root = tempDir('scope-root', t);
  withWriteScope({ root }, () => checkWrite(path.join(root, 'a', 'b.txt'), 'write'));
  assert.deepEqual(violations(), []);
});

test('a write inside the cache is not reported even with no scope set', () => {
  checkWrite(path.join(cacheDir(), 'x.json'), 'write');
  assert.deepEqual(violations(), []);
});

test('a write outside the root and the cache is reported with its details', (t) => {
  const root = tempDir('scope-root', t);
  const outside = tempDir('scope-outside', t);
  const target = path.join(outside, 'settings.json');
  withWriteScope({ root }, () => checkWrite(target, 'write'));
  assert.equal(violations().length, 1);
  const [only] = violations();
  assert.equal(only.kind, 'OutOfScopeWrite');
  assert.equal(only.target, target);
  assert.equal(only.op, 'write');
  assert.equal(only.scopeRoot, root);
});

test('with no scope set every write outside the cache is reported', (t) => {
  const outside = tempDir('scope-outside', t);
  checkWrite(path.join(outside, 'a.txt'), 'write');
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].scopeRoot, null);
});

test('a dot-dot segment cannot carry a write out of the root unseen', (t) => {
  const root = tempDir('scope-root', t);
  withWriteScope({ root }, () => checkWrite(path.join(root, '..', 'escape.txt'), 'write'));
  assert.equal(violations().length, 1);
});

test('a symlink inside the root that points outside is reported', { skip: process.platform === 'win32' }, (t) => {
  const root = tempDir('scope-root', t);
  const outside = tempDir('scope-outside', t);
  fs.symlinkSync(outside, path.join(root, 'link'));
  withWriteScope({ root }, () => checkWrite(path.join(root, 'link', 'file.txt'), 'write'));
  assert.equal(violations().length, 1);
});

test('a symlinked scope root accepts writes through the link and through the real path', { skip: process.platform === 'win32' }, (t) => {
  const real = tempDir('scope-real', t);
  const link = path.join(tempDir('scope-links', t), 'project');
  fs.symlinkSync(real, link);
  withWriteScope({ root: link }, () => {
    checkWrite(path.join(link, 'a.txt'), 'write');
    checkWrite(path.join(real, 'b.txt'), 'write');
  });
  assert.deepEqual(violations(), []);
});

test('a relative file path is resolved against the working directory and reported absolutely', (t) => {
  const outside = tempDir('scope-outside', t);
  const target = path.join(outside, 'rel.txt');
  checkWrite(path.relative(process.cwd(), target), 'write');
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].target, target);
});

test('isInside accepts the folder itself and a trailing separator', () => {
  const dir = path.resolve('/a/proj');
  assert.equal(isInside(dir, dir), true);
  assert.equal(isInside(`${dir}${path.sep}`, path.join(dir, 'f')), true);
});

test('isInside rejects a sibling that shares a name prefix', () => {
  assert.equal(isInside(path.resolve('/a/proj'), path.resolve('/a/proj-two/f')), false);
});

test('isInside folds case only when asked', () => {
  assert.equal(isInside(path.resolve('/Proj'), path.resolve('/proj/a.txt'), { foldCase: true }), true);
});

test('isInside is exact on a case-sensitive platform', { skip: process.platform !== 'linux' }, () => {
  assert.equal(isInside(path.resolve('/Proj'), path.resolve('/proj/a.txt'), { foldCase: false }), false);
});

test('the scope holds across an await', async (t) => {
  const root = tempDir('scope-root', t);
  await withWriteScope({ root }, async () => {
    await Promise.resolve();
    checkWrite(path.join(root, 'late.txt'), 'write');
  });
  assert.deepEqual(violations(), []);
});

test('a path that cannot be probed is dropped instead of thrown', () => {
  assert.doesNotThrow(() => checkWrite('bad\0path', 'write'));
  assert.deepEqual(violations(), []);
});

test('the enforce mode records the violation and throws OutOfScopeWrite', (t) => {
  const outside = tempDir('scope-outside', t);
  assert.throws(() => checkWrite(path.join(outside, 'a.txt'), 'write', { mode: 'enforce' }), OutOfScopeWrite);
  assert.equal(violations().length, 1);
});

test('the list stops at its cap and counts what it dropped', (t) => {
  const outside = tempDir('scope-outside', t);
  for (let index = 0; index < MAX_VIOLATIONS + 5; index += 1) {
    checkWrite(path.join(outside, `f${index}.txt`), 'write');
  }
  assert.equal(violations().length, MAX_VIOLATIONS);
  assert.equal(droppedViolations(), 5);
});

test('clearViolations empties the list and the dropped count', (t) => {
  const outside = tempDir('scope-outside', t);
  checkWrite(path.join(outside, 'a.txt'), 'write');
  clearViolations();
  assert.deepEqual(violations(), []);
  assert.equal(droppedViolations(), 0);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node scripts/run-tests.mjs focus tests/kit/scope-gate.test.mjs`
Expected: FAIL with `Cannot find module '.../src/lib/scope-gate.mjs'`.

- [ ] **Step 3: Write the module**

Create `src/lib/scope-gate.mjs`:

```js
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
```

- [ ] **Step 4: Run the tests**

Run: `node scripts/run-tests.mjs focus tests/kit/scope-gate.test.mjs`
Expected: PASS, 17 tests. A platform-gated test may skip: the exact-case test off Linux, and the two
symlink tests on Windows.

- [ ] **Step 5: Typecheck**

Run: `node_modules/.bin/tsc -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scope-gate.mjs tests/kit/scope-gate.test.mjs
git commit -m "feat(scope-gate): record writes outside the project scope (P0-07)

An AsyncLocalStorage write scope, a capped in-process collector and
checkWrite. Report-only: ENFORCEMENT stays 'report' until P7-01."
```

---

### Task 3: `checkCommand`

**Files:**

- Modify: `src/lib/scope-gate.mjs` (append)
- Test: `tests/kit/scope-gate.test.mjs` (append)

**Interfaces:**

- Consumes from Task 2, all in the same file: `scopeStore`, `scopeRoot()`, `realPath`, `isInside`,
  `settle`, `now`, `OutOfScopeCommand`, `ENFORCEMENT`.
- Produces: `checkCommand(cmd, args = [], cwd = undefined, { mode = ENFORCEMENT } = {})` returns the
  violation or `null`. A violation is `{ kind: 'OutOfScopeCommand', rule, target, op: 'exec',
  scopeRoot, cwd, time }`, with `rule` one of `npm-install-global`, `claude-mcp-user-scope`,
  `claude-plugin-user-scope`, `claude-mcp-scope-outside-root`, `claude-plugin-scope-outside-root`,
  `codex-mcp-add`, `launchctl`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/kit/scope-gate.test.mjs`, and add `checkCommand` and `OutOfScopeCommand` to the
import list at the top:

```js
test('blocked commands are reported under the matching rule', (t) => {
  const root = tempDir('scope-root', t);
  const cases = [
    ['npm', ['install', '-g', 'ruflo'], 'npm-install-global'],
    ['npm', ['i', '--global', 'x'], 'npm-install-global'],
    ['npm', ['install', '--location=global', 'x'], 'npm-install-global'],
    ['npm', ['install', '--location', 'global', 'x'], 'npm-install-global'],
    ['claude', ['mcp', 'add', '-s', 'user', 'srv', 'cmd'], 'claude-mcp-user-scope'],
    ['claude', ['mcp', 'add', '--scope=user', 'srv', 'cmd'], 'claude-mcp-user-scope'],
    ['claude', ['plugin', 'install', '--scope', 'user', 'p'], 'claude-plugin-user-scope'],
    ['claude', ['plugins', 'install', '-s', 'user', 'p'], 'claude-plugin-user-scope'],
    ['codex', ['mcp', 'add', 'srv', '--', 'cmd'], 'codex-mcp-add'],
    ['launchctl', ['load', 'x.plist'], 'launchctl'],
    ['/usr/local/bin/launchctl', ['list'], 'launchctl'],
    ['C:\\Program Files\\nodejs\\npm.cmd', ['install', '-g', 'x'], 'npm-install-global'],
  ];
  for (const [cmd, args, rule] of cases) {
    clearViolations();
    withWriteScope({ root }, () => checkCommand(cmd, args, root));
    assert.equal(violations().length, 1, `${cmd} ${args.join(' ')}`);
    assert.equal(violations()[0].rule, rule, `${cmd} ${args.join(' ')}`);
  }
});

test('ordinary commands and in-root project-scoped claude commands are not reported', (t) => {
  const root = tempDir('scope-root', t);
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  const cases = [
    ['npm', ['install']],
    ['npm', ['install', 'left-pad']],
    ['npm', ['run', 'build']],
    ['claude', ['mcp', 'list']],
    ['claude', ['mcp', 'add', '-s', 'project', 'srv', 'cmd']],
    ['claude', ['mcp', 'add', '-s', 'local', 'srv', 'cmd']],
    ['claude', ['plugin', 'install', '-s', 'project', 'p']],
    ['claude', ['mcp', 'add', 'srv', 'cmd']],
    ['codex', ['exec', 'x']],
    ['git', ['status']],
  ];
  for (const [cmd, args] of cases) {
    withWriteScope({ root }, () => checkCommand(cmd, args, sub));
  }
  assert.deepEqual(violations(), []);
});

test('a project-scoped claude command from outside the root is reported', (t) => {
  const root = tempDir('scope-root', t);
  const outside = tempDir('scope-outside', t);
  withWriteScope({ root }, () => checkCommand('claude', ['mcp', 'add', '-s', 'project', 'srv', 'cmd'], outside));
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].rule, 'claude-mcp-scope-outside-root');
});

test('a project-scoped claude command with no scope set is reported', (t) => {
  const outside = tempDir('scope-outside', t);
  checkCommand('claude', ['plugin', 'install', '-s', 'local', 'p'], outside);
  assert.equal(violations()[0].rule, 'claude-plugin-scope-outside-root');
});

test('a command report names the full command line and the working folder', (t) => {
  const root = tempDir('scope-root', t);
  withWriteScope({ root }, () => checkCommand('npm', ['install', '-g', 'x'], root));
  const [only] = violations();
  assert.equal(only.kind, 'OutOfScopeCommand');
  assert.equal(only.target, 'npm install -g x');
  assert.equal(only.op, 'exec');
  assert.equal(only.cwd, root);
  assert.equal(only.scopeRoot, root);
});

test('a missing args list is ignored without throwing', () => {
  assert.doesNotThrow(() => checkCommand('git', undefined));
  assert.deepEqual(violations(), []);
});

test('the enforce mode records the command and throws OutOfScopeCommand', () => {
  assert.throws(() => checkCommand('launchctl', ['list'], undefined, { mode: 'enforce' }), OutOfScopeCommand);
  assert.equal(violations().length, 1);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node scripts/run-tests.mjs focus tests/kit/scope-gate.test.mjs`
Expected: FAIL with `checkCommand is not a function` (or a missing-export SyntaxError).

- [ ] **Step 3: Append the implementation**

Append to `src/lib/scope-gate.mjs`:

```js
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
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `node scripts/run-tests.mjs focus tests/kit/scope-gate.test.mjs`
Expected: PASS, 24 tests, with the same platform skips as before.

Run: `node_modules/.bin/tsc -p tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scope-gate.mjs tests/kit/scope-gate.test.mjs
git commit -m "feat(scope-gate): record user-level commands (P0-07)

checkCommand reports npm install -g, claude mcp|plugin at user scope,
codex mcp add and launchctl, and project-scoped claude changes made from
outside the scope root. A claude change with no -s is not classified."
```

---

### Task 4: Hook the gate into `file-write.mjs` and `run()`

**Files:**

- Modify: `src/lib/file-write.mjs` (two functions and one import)
- Modify: `src/lib/exec.mjs:282` (one import and one call)
- Test: `tests/kit/scope-gate-hooks.test.mjs`

**Interfaces:**

- Consumes: `checkWrite(file, op)`, `checkCommand(cmd, args, cwd)`, `withWriteScope`, `violations`,
  `clearViolations` from `src/lib/scope-gate.mjs`; `cacheDir()` from `src/lib/cache-dir.mjs`.
- Produces: no new exports. Both writers and `run()` behave exactly as before and also record.

- [ ] **Step 1: Write the failing tests**

Create `tests/kit/scope-gate-hooks.test.mjs`:

```js
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../../src/lib/cache-dir.mjs';
import { run } from '../../src/lib/exec.mjs';
import { writeFileWithBackup, writePrivateFileAtomic } from '../../src/lib/file-write.mjs';
import { clearViolations, violations, withWriteScope } from '../../src/lib/scope-gate.mjs';
import { rmrf, sandboxHome } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const home = sandboxHome('scope-gate-hooks');
after(() => rmrf(home));
beforeEach(() => clearViolations());

test('writeFileWithBackup reports a write outside the root and still performs it', (t) => {
  const root = tempDir('hooks-root', t);
  const outside = tempDir('hooks-outside', t);
  const file = path.join(outside, 'settings.json');
  withWriteScope({ root }, () => writeFileWithBackup(file, '{}\n'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].target, file);
});

test('writeFileWithBackup inside the root is not reported', (t) => {
  const root = tempDir('hooks-root', t);
  withWriteScope({ root }, () => writeFileWithBackup(path.join(root, 'CLAUDE.md'), 'x\n'));
  assert.deepEqual(violations(), []);
});

test('writePrivateFileAtomic reports outside the cache and accepts a write inside it', (t) => {
  const outside = tempDir('hooks-outside', t);
  writePrivateFileAtomic(path.join(outside, 'store.json'), '{}');
  assert.equal(violations().length, 1);
  clearViolations();
  const inCache = path.join(cacheDir(), 'store.json');
  writePrivateFileAtomic(inCache, '{}');
  assert.equal(fs.readFileSync(inCache, 'utf8'), '{}');
  assert.deepEqual(violations(), []);
});

test('run reports a user-level command and still returns the spawn failure', async () => {
  const result = await run('launchctl', ['list']);
  assert.notEqual(result.code, 0);
  assert.equal(typeof result.stderr, 'string');
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].rule, 'launchctl');
});

test('run reports a global npm install made from its working folder', async (t) => {
  const root = tempDir('hooks-root', t);
  const result = await withWriteScope({ root }, () => run('npm', ['install', '-g', 'x'], { cwd: root }));
  assert.notEqual(result.code, 0);
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].rule, 'npm-install-global');
  assert.equal(violations()[0].cwd, root);
});

test('run does not report an ordinary command', async () => {
  await run('git', ['--version']);
  assert.deepEqual(violations(), []);
});
```

`sandboxHome` leaves `PATH` pointing at a folder that does not exist, so every `run()` spawn fails
with ENOENT at once and nothing real launches.

- [ ] **Step 2: Run them and confirm they fail**

Run: `node scripts/run-tests.mjs focus tests/kit/scope-gate-hooks.test.mjs`
Expected: FAIL. The assertions on `violations().length` get `0`, because nothing calls the gate yet.

- [ ] **Step 3: Hook `file-write.mjs`**

In `src/lib/file-write.mjs` add one import under `import { randomBytes } from 'node:crypto';`:

```js
import { checkWrite } from './scope-gate.mjs';
```

Add this as the first statement of `writeFileWithBackup`, above `const dir = path.dirname(file);`:

```js
  checkWrite(file, 'write');
```

Add this as the first statement of `writePrivateFileAtomic`, above
`fsImpl.mkdirSync(path.dirname(file), { recursive: true });`:

```js
  checkWrite(file, 'write');
```

- [ ] **Step 4: Hook `run()`**

In `src/lib/exec.mjs` add one import under `import { npmShimInvocation, ... } from './windows-npm-shim.mjs';`:

```js
import { checkCommand } from './scope-gate.mjs';
```

Add this as the first statement of `run`, above the `try {`:

```js
  checkCommand(cmd, args, opts.cwd);
```

- [ ] **Step 5: Run the hook tests, then the suites that already cover both modules**

Run: `node scripts/run-tests.mjs focus tests/kit/scope-gate-hooks.test.mjs`
Expected: PASS, 6 tests.

Run: `node scripts/run-tests.mjs unit`
Expected: 0 failures. Any test that used a fake `fsImpl` still passes, because `checkWrite` reads the
real file system only for the path probe.

- [ ] **Step 6: Typecheck**

Run: `node_modules/.bin/tsc -p tsconfig.json`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/lib/file-write.mjs src/lib/exec.mjs tests/kit/scope-gate-hooks.test.mjs
git commit -m "feat(scope-gate): report from file-write and run() (P0-07)

Both file writers call checkWrite before they change anything, and run()
calls checkCommand before it spawns. Behaviour is unchanged in report mode."
```

---

### Task 5: The lint rule, at warn

**Files:**

- Modify: `eslint.config.mjs` (a new block, plus constants above `export default`)
- Test: `tests/kit/scope-gate-lint.test.mjs`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: every message from this block contains the text `ADR-0064`, so a test can pick them out
  from other rules' messages.

- [ ] **Step 1: Write the failing test**

Create `tests/kit/scope-gate-lint.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.mjs') });

async function gateMessages(code, file) {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return result.messages.filter((message) => message.message.includes('ADR-0064'));
}

const WRITERS = {
  'a default fs import': "import fs from 'node:fs';\nfs.writeFileSync('x', 'y');\n",
  'a named fs import': "import { writeFileSync } from 'node:fs';\nwriteFileSync('x', 'y');\n",
  'a promises import': "import fsp from 'node:fs/promises';\nawait fsp.writeFile('x', 'y');\n",
  'fs.promises': "import fs from 'node:fs';\nawait fs.promises.rm('x');\n",
  'an injected fsImpl': 'export const f = (fsImpl) => fsImpl.mkdirSync("x");\n',
  'a named user-dir import': "import { codexDir } from './paths.mjs';\nexport const d = codexDir();\n",
  'a namespaced user-dir call': "import * as paths from './paths.mjs';\nexport const d = paths.claudeDir();\n",
};

for (const [name, code] of Object.entries(WRITERS)) {
  test(`the rule warns on ${name} in a writer module`, async () => {
    const messages = await gateMessages(code, 'src/lib/example.mjs');
    assert.ok(messages.length >= 1, name);
    assert.ok(messages.every((message) => message.severity === 1), 'warn, not error');
  });
}

test('the rule leaves reads alone', async () => {
  const code = "import fs from 'node:fs';\nexport const r = fs.readFileSync('x', 'utf8');\n";
  assert.deepEqual(await gateMessages(code, 'src/lib/example.mjs'), []);
});

test('the rule skips the three modules that own writes', async () => {
  const code = "import fs from 'node:fs';\nfs.writeFileSync('x', 'y');\n";
  for (const file of ['src/lib/file-write.mjs', 'src/lib/scope-gate.mjs', 'src/lib/paths.mjs']) {
    assert.deepEqual(await gateMessages(code, file), [], file);
  }
});

test('the rule does not reach tests or bin', async () => {
  const code = "import fs from 'node:fs';\nfs.writeFileSync('x', 'y');\n";
  assert.deepEqual(await gateMessages(code, 'tests/kit/example.mjs'), []);
  assert.deepEqual(await gateMessages(code, 'bin/example.mjs'), []);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node scripts/run-tests.mjs focus tests/kit/scope-gate-lint.test.mjs`
Expected: the seven "warns on" tests FAIL with `AssertionError ... name`, and the three negative
tests pass. If `Cannot find package 'eslint'`, run `pnpm install --frozen-lockfile` first.

- [ ] **Step 3: Add the constants**

In `eslint.config.mjs`, directly above `export default [`, add:

```js
// Project-scope write gate (ADR-0064, "Making it stick"): writers go through file-write.mjs, and
// user-level folders are resolved only in paths.mjs. A warning today; P7-01 makes it an error.
const FS_WRITE_METHODS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'rm', 'rmSync',
  'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'copyFile', 'copyFileSync',
  'cp', 'cpSync', 'unlink', 'unlinkSync', 'symlink', 'symlinkSync', 'link', 'linkSync', 'chmod',
  'chmodSync', 'chown', 'chownSync', 'truncate', 'truncateSync', 'utimes', 'utimesSync', 'createWriteStream',
];
const USER_DIR_HELPERS = ['claudeDir', 'codexDir', 'opencodeDir'];
const FS_MESSAGE = 'Write through file-write.mjs so the project-scope write gate sees it (ADR-0064).';
const USER_DIR_MESSAGE = 'Resolve user-level folders only in paths.mjs; a project writer must not target them (ADR-0064).';
```

- [ ] **Step 4: Add the block**

Add this object to the `export default [ ... ]` array, after the `complexity` block that lists
`files: ['src/**/*.{mjs,js,cjs}', 'bin/**/*.mjs']`:

```js
  {
    // Writer modules: all of src/ except the three modules that own writes and locations.
    files: ['src/**/*.mjs'],
    ignores: ['src/lib/file-write.mjs', 'src/lib/scope-gate.mjs', 'src/lib/paths.mjs'],
    rules: {
      'no-restricted-imports': ['warn', {
        paths: ['node:fs', 'fs', 'node:fs/promises', 'fs/promises']
          .map((name) => ({ name, importNames: FS_WRITE_METHODS, message: FS_MESSAGE })),
        patterns: [{ regex: '(^|/)paths\\.mjs$', importNames: USER_DIR_HELPERS, message: USER_DIR_MESSAGE }],
      }],
      'no-restricted-properties': ['warn', ...['fs', 'fsp', 'fsImpl'].flatMap((object) => FS_WRITE_METHODS
        .map((property) => ({ object, property, message: FS_MESSAGE })))],
      'no-restricted-syntax': ['warn',
        {
          selector: `CallExpression[callee.object.property.name='promises'][callee.property.name=/^(${FS_WRITE_METHODS.join('|')})$/]`,
          message: FS_MESSAGE,
        },
        {
          selector: `CallExpression[callee.object.name='paths'][callee.property.name=/^(${USER_DIR_HELPERS.join('|')})$/]`,
          message: USER_DIR_MESSAGE,
        },
      ],
    },
  },
```

- [ ] **Step 5: Run the test**

Run: `node scripts/run-tests.mjs focus tests/kit/scope-gate-lint.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 6: Confirm the lint run stays green and count the warnings**

Run: `node_modules/.bin/eslint . ; echo "exit=$?"`
Expected: `exit=0`. The summary shows 0 errors and many more warnings than before.

Run: `node_modules/.bin/eslint src -f json | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8'));let n=0;for(const f of r)for(const m of f.messages)if(m.message.includes('ADR-0064'))n+=1;console.log('write-gate warnings:',n)"`
Expected: about 326 warnings in about 103 files (measured against `main` on 2026-10-06, on top of the
73 warnings that exist today). Write the number down for the PR body.

- [ ] **Step 7: Commit**

```bash
git add eslint.config.mjs tests/kit/scope-gate-lint.test.mjs
git commit -m "feat(lint): warn on direct fs writes in writer modules (P0-07)

A warn-level block for src/**: fs write calls and imports, fs.promises
writes, and the claudeDir/codexDir/opencodeDir helpers. Built-in rules
only. file-write.mjs, scope-gate.mjs and paths.mjs are exempt."
```

---

### Task 6: Docs and the full gate

**Files:**

- Modify: `docs/adr/0064-project-scoped-management.md` (one line near the top)
- Modify: `docs/maintainer.md` (one short subsection before `## 5. Branching methodology`)

**Interfaces:**

- Consumes: the finished gate.
- Produces: nothing.

- [ ] **Step 1: Update the ADR**

In `docs/adr/0064-project-scoped-management.md`, add this line directly above the line that starts
`- **Update note:**`:

```markdown
- **Updated:** 2026-10-06 — the write gate and command gate ship in report-only mode in 4.0.0-beta.1 (#327): they record out-of-scope writes and commands and block nothing. They start refusing in 4.0.0-beta.4 (P7-01).
```

- [ ] **Step 2: Add the maintainer note**

In `docs/maintainer.md`, add this above `## 5. Branching methodology`:

```markdown
### Reading the scope gate

`src/lib/scope-gate.mjs` records writes outside the project root and the cache, and user-level
commands, until the gate starts refusing in 4.0.0-beta.4. Nothing prints. A test reads the list
with `violations()` and clears it with `clearViolations()`; wrap the code under test in
`withWriteScope({ root }, fn)` to set the project root. `pnpm run lint` shows the writers that
bypass `file-write.mjs` as warnings that mention ADR-0064.
```

- [ ] **Step 3: Run the documentation checks**

Run: `node_modules/.bin/markdownlint docs/adr/0064-project-scoped-management.md docs/maintainer.md docs/plans/2026-10-06-write-and-command-gate.md docs/plans/2026-10-06-write-and-command-gate-design.md`
Expected: no output.

Run: `node scripts/run-tests.mjs focus tests/kit/docs-layout.test.mjs`
Expected: PASS, 7 tests.

Run: `lychee --offline --include-fragments --config lychee.toml 'docs/**/*.md'`
Expected: 0 errors.

- [ ] **Step 4: Run the full gate**

Run each and expect success:

```bash
node_modules/.bin/tsc -p tsconfig.json
node_modules/.bin/eslint .
node_modules/.bin/eslint src bin --rule 'complexity: [2, 50]'
node scripts/run-tests.mjs focus tests/quality/comment-label-guard.test.mjs
node scripts/build-check.mjs
node scripts/run-tests.mjs unit
```

Expected: no type errors, 0 lint errors, 0 errors at the complexity ceiling, the comment guard
passes, `build-check: OK`, and the unit run reports 0 failures with coverage at or above the 70%
floors. If the unit run fails the real-state tripwire because a live Claude Code session wrote to
`.agentic-qe/`, rerun that file alone before changing any code.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0064-project-scoped-management.md docs/maintainer.md
git commit -m "docs: record that the scope gates are report-only until P7-01 (P0-07)"
```

- [ ] **Step 6: Hand off**

Do not push or open a PR without the maintainer's go-ahead. The PR body for #327 should state:
the write-gate warning count from Task 5, that the unit run and the full gate passed, what was not
run (`test:ui`), and the two known gaps: the 26 files that spawn through `child_process` directly,
and a `claude mcp|plugin` change with no `-s`. Closing keyword: `Closes #327`.
