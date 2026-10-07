# Write gate and command gate in report-only mode

## Status

**Done** (2026-10-06). Design for card P0-07, issue [#327](https://github.com/pacphi/agentic-kit/issues/327),
epic [#295](https://github.com/pacphi/agentic-kit/issues/295), release `4.0.0-beta.1`. Implemented
in report-only mode on `feat/327-write-and-command-gate`. The enforcing version is P7-01
(`4.0.0-beta.4`). This card unblocks #328 (contract tests).

## Outcome

The rule in [ADR-0064](../adr/0064-project-scoped-management.md) and the
[design](../plans/2026-10-01-project-scope-only-design.md) ("Making it stick", items 1 and 2) becomes
measurable: ak writes only inside the project root, the cache and the Codex register. This card
reports every write and command that breaks the rule and changes no behaviour. It does not throw,
refuse or block anything.

Success is the card's two acceptance criteria:

- every out-of-scope write and command is reported in tests;
- the lint rule flags direct `fs` writes in writer modules.

## What the code looks like today

- `src/lib/file-write.mjs` holds the two sanctioned writers, `writeFileWithBackup` and
  `writePrivateFileAtomic`. About 27 modules call them.
- Direct `fs` writes sit in 64 files, 245 call sites (for example `uninstall.mjs`,
  `statusline.mjs`, `aqe-store-merge.mjs`). A gate inside `file-write.mjs` alone sees fewer than
  half of the writes. The lint rule is the only view of the rest until later cards migrate them.
- `src/lib/exec.mjs` `run()` is the subprocess wrapper. 44 files use it, but 26 files import
  `child_process` directly. A gate in `run()` does not see those.
- `paths.mjs` has `cacheDir()` and the user-level helpers `claudeDir`, `codexDir` and
  `opencodeDir`. There is no notion of "the project root" at write time, and no Codex register
  yet (that is card P3-02, `4.0.0-beta.2`).
- `exec.mjs` already scopes an `AbortSignal` with `AsyncLocalStorage` (`withAbortSignal`). The
  new scope follows that pattern.

## Design

### 1. `src/lib/scope-gate.mjs`

One new module. It imports only `node:` built-ins and a new leaf module, `cache-dir.mjs`.

`paths.mjs` imports `file-write.mjs`, so `scope-gate.mjs` cannot import `paths.mjs` for
`cacheDir()` without a cycle (`file-write` → `scope-gate` → `paths` → `file-write`). The plan
therefore moves `xdgBase`, `cacheBase` and `cacheDir` into `src/lib/cache-dir.mjs`, which imports
only `node:` built-ins, and `paths.mjs` re-exports them unchanged. No caller changes.

- **Scope.** `withWriteScope({ root }, fn)` runs `fn` with the project root held in an
  `AsyncLocalStorage`. With no scope set, the root is empty and only the cache is allowed.
  Nothing in this card sets a scope outside tests: opted-in roots arrive with P1 and #330.
- **Write check.** `checkWrite(file, op)` allows a path under the scope root or under
  `cacheDir()`. Anything else records an `OutOfScopeWrite`.
  - It resolves the real path of the nearest existing ancestor, so a symlink or `..` segment
    cannot move a write out of scope unseen.
  - It compares case-insensitively on Windows and macOS, and exactly on Linux.
  - It has its own containment helper. It does not import `isInside` from
    `footprint/consumers.mjs`, because a gate must not depend on a measurement module.
- **Command check.** `checkCommand(cmd, args, cwd)` records an `OutOfScopeCommand` for:
  - `npm install -g`, `npm i -g` and `--global` forms;
  - `claude mcp add` with `-s user` or `--scope user`;
  - `codex mcp add`;
  - `launchctl` with any arguments.

  `claude mcp|plugin … -s local|project` is allowed only when `cwd` is inside the scope root.
  Matching is on the parsed argv, never on a joined string.

  A `claude mcp` or `claude plugin` change with no `-s` is not reported. `--help` does not state
  the default scope for either command, and this card does not guess it. Pinning the defaults
  is a follow-up for P7-01.
- **Collector.** Violations go to an in-process list: `{ kind, target, op, scopeRoot, time }`.
  Tests read it through `violations()` and reset it with `clearViolations()`. The list holds at
  most 1,000 entries and counts what it drops, because the dashboard server is long-lived.
  Nothing is written to disk and nothing prints in production.
- **One switch.** `ENFORCEMENT = 'report'` is the only mode. The `OutOfScopeWrite` and
  `OutOfScopeCommand` error classes are exported now so P7-01 flips the constant to throw
  without touching any caller.

### 2. Two hooks

- Both `file-write.mjs` writers call `checkWrite(file, 'write')` before they change anything.
  The tmp and `.bak` siblings sit in the same directory, so one check on `file` covers them.
- `run()` in `exec.mjs` calls `checkCommand(cmd, args, opts.cwd)` before it resolves the shim.

In report mode neither call changes a result.

### 3. The lint rule, at `warn`

A new `src/**` block in `eslint.config.mjs`, using built-in rules only, so there is no custom
plugin to maintain:

- `no-restricted-imports` for named imports of the `fs` write functions from `node:fs` and
  `node:fs/promises`, and for `claudeDir`, `codexDir` and `opencodeDir` from `paths.mjs`;
- `no-restricted-properties` for the write methods on `fs`, `fsp` and `fs.promises`;
- `no-restricted-syntax` for calls through an aliased `fs` namespace import.

"Writer modules" means all of `src/**` except `file-write.mjs`, `scope-gate.mjs` and `paths.mjs`.
`bin/**` and `tests/**` are not covered.

Warnings do not fail CI (`eslint .` has no `--max-warnings`). Measured against `main`, the rule adds about 326 warnings in 103 files, on top of 73 today. The PR
records the count so later migration cards can show it falling.

### 4. Tests

- **Unit matrix** for `checkWrite` and `checkCommand`:
  - in the root, in the cache, outside both;
  - `..` and symlink escape;
  - case folding on a case-insensitive filesystem;
  - each blocked command and its allowed variant, with `cwd` inside and outside the root.
- **Integration**: `writeFileWithBackup`, `writePrivateFileAtomic` and `run()` record the right
  violation under `sandboxHome()`, and still perform the write or spawn.
- **Lint**: an ESLint API test asserts the rule flags a fixture with a direct write and ignores
  `file-write.mjs`.
- Focused command: `node scripts/run-tests.mjs focus tests/kit/scope-gate.test.mjs`, then
  `pnpm test` and `pnpm run lint`.

## Out of scope

- Throwing and refusing: P7-01 (`4.0.0-beta.4`).
- Wiring `withWriteScope` into command entry points: P1 and #330.
- The Codex register and its capability: P3-02.
- The contract tests and the `HOME` baseline: #328.
- The 26 files that spawn through `child_process` directly. They keep bypassing the command
  gate. A follow-up issue is proposed, not filed.
- Migrating the 64 files with direct writes onto `file-write.mjs`.

## Risks and decisions

- **Reports are expected to be large.** Every machine-level write today, such as
  `~/.claude/settings.json`, is reported in beta.1. That is the point: #328 baselines them.
- **Real-path resolution costs a few `stat` calls per write.** Each write already makes several
  syscalls (mkdir, copy, write, rename), so the cost is accepted.
- **A hook in `run()` must not break `run()`'s never-throws shape.** `checkCommand` itself never
  throws in report mode; a bug in it is caught and dropped rather than failing a spawn.
- **Docs.** ADR-0064's write-gate wording gets an `Updated` line saying the gate is report-only
  until P7-01, and `docs/maintainer.md` gets one sentence on reading `violations()` in tests.
  No user guide changes: users see nothing.

## Verification

- `node scripts/run-tests.mjs focus tests/kit/scope-gate.test.mjs`
- `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run lint:cc`, `pnpm run lint:md`,
  `pnpm run build`
- `node scripts/run-tests.mjs focus tests/kit/docs-layout.test.mjs`
