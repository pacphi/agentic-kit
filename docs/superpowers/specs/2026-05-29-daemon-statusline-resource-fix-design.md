# Daemon & Statusline Resource Leak — Design Spec

**Date:** 2026-05-29
**Branch:** `fix/daemon-statusline-resource-leak`
**Status:** Approved (investigation + scoping complete)
**Issue:** [#3 — install.sh fills Claude Code sandbox tmpfs, causing session crashes (ENOSPC)](https://github.com/pacphi/ruflo-machine-ref/issues/3)

## Problem

Issue #3 reports that, after running the kit, Claude Code sessions crash with
`ENOSPC` ("the temp filesystem at /private/tmp/claude-501/<project>/<uuid>/tasks
is full (0MB free)"). The report names three root causes. Investigation against
the actual kit code confirms two of them (one with a correction) and refutes the
third:

### Confirmed — RC1: the kit starts daemons and never stops them

`ruflo-setup-project` (`shell/ruflo-functions.sh`) unconditionally runs
`ruflo daemon start`. **Nothing in the kit ever stops a daemon** — not
`ruflo-setup-project`, not `uninstall.sh`, and not `bin/ruflo-parity-test`, whose
teardown only `rm -rf`s the throwaway `/tmp/test-*` workspace it created while
leaving the daemon that workspace spawned orphaned and pointed at a now-deleted
directory.

Observed live during investigation: **18 `ruflo daemon` processes running**,
~11 of them attached to deleted `/private/tmp/test-2026.05.28.*` workspaces from
prior parity-test runs. This is a real, reproducible process/resource leak.

*Nuance / correction:* the daemons run **detached**, so they do not write into
Claude Code's per-session sandbox `tasks` tmpfs directly. The most direct filler
of that tmpfs is the **high-frequency hook + statusline subprocess output** that
Claude Code captures per prompt/Bash/edit/render. The issue conflates two real
problems introduced by the kit (daemon leak + subprocess churn); both are fixed
here.

### Confirmed (with correction) — RC2: statusline spawns sqlite3 every render

The activation-footer block injected by `ruflo-fix-statusline-version` runs **2–4
`sqlite3` subprocesses per statusline render**, gated on `.agentic-qe/memory.db`
existing (it commonly does, and is ~52 MB in this repo). The kit's `statusLine`
config uses `refreshMs: 5000` with **no `timeout`**, so this fires every ~5s.

*Correction to the report:* each call is bounded by
`execFileSync(..., { timeout: 1500 })`, so it **cannot "hang indefinitely"** —
worst case ~6s for 4 calls. The genuine problem is the per-5s subprocess **churn**,
not an unbounded hang.

### Refuted — RC3: `daemon.autoStart: true`

The kit never writes `claudeFlow.daemon.autoStart`. That key is emitted by
upstream `ruflo init`. In this repo it is currently **`false`**. The real daemon
trigger is the explicit `ruflo daemon start` in `ruflo-setup-project` (RC1), not
`autoStart`. We add a *defensive* guard but do not claim the kit set it.

## Goals

1. **Stop creating orphan daemons.** `bin/ruflo-parity-test` must stop the daemon
   for the throwaway workspace it created, on every exit path.
2. **Idempotent daemon start.** `ruflo-setup-project` must not start a second
   daemon when one is already running for the same workspace.
3. **Symmetric teardown.** `uninstall.sh` must be able to stop daemons (the
   project's, with `--this-project`; stale ones always).
4. **A stale-daemon GC helper.** A `ruflo-daemon-gc` shell function that lists and
   (optionally) kills daemons whose `--workspace` directory no longer exists.
5. **Cut statusline churn.** Cache the QE footer metrics to a small file with a
   TTL so most 5s renders spawn **zero** sqlite3 processes, and collapse the 2–4
   queries into **one** `sqlite3` invocation on a cache miss.
6. **One-time cleanup now.** Kill the existing stale orphan daemons on this
   machine (workspace-gone only), after showing the list.
7. **Document** the `CLAUDE_CODE_TMPDIR` workaround and the daemon lifecycle in
   `docs/TROUBLESHOOTING.md`.

## Non-goals

- **Do not** make the daemon opt-in or remove `ruflo daemon start` from
  `ruflo-setup-project`. The daemon is what makes self-learning continuous
  (ruflo-reference.md). We keep it and fix the leak (per scoping decision).
- **Do not** modify upstream `ruflo`/`agentic-qe` behavior or the generated
  `.claude/settings.json` schema beyond a defensive `daemon.autoStart` guard that
  is only applied if the file is present and the value is `true`.
- **Do not** kill live-project daemons during the one-time cleanup — only those
  whose workspace directory no longer exists.
- **Do not** change the statusline's visual output. Caching is transparent; the
  rendered footer is byte-for-byte the same as before within the TTL window.

## Behavior

### Daemon lifecycle

| Surface | Before | After |
|---|---|---|
| `ruflo-setup-project` | always `ruflo daemon start` | start only if no daemon for this workspace (idempotent) |
| `bin/ruflo-parity-test` | `rm -rf` test dir; daemon orphaned | stop the test-workspace daemon in `cleanup_on_exit`, then `rm -rf` |
| `uninstall.sh --this-project` | reverts statusline only | also stops this project's daemon |
| `uninstall.sh` (any mode) | — | runs `ruflo-daemon-gc --kill` for stale (workspace-gone) daemons |
| `ruflo-daemon-gc` (new) | n/a | list orphans; `--kill` stops them; never touches live-workspace daemons |

A daemon is **stale/orphan** iff its `--workspace <dir>` path does not exist on
disk. A daemon is **this project's** iff its `--workspace` equals `pwd -P`.

### Statusline cache (R5)

On render, `rufloActivationSegments` computes the QE footer like so:

- Cache file: `.claude-flow/cache/qe-statusline.json` (same dir family the kit
  already writes, e.g. `.claude-flow/neural/`). Holds `{ ts, line }`.
- If the cache file exists and is younger than `RUFLO_QE_STATUSLINE_TTL_MS`
  (default 60000) → return the cached `line`, **zero sqlite3 spawns**.
- On miss → run **one** `sqlite3` invocation (see below), build the line, write
  the cache, return it.
- All failures are swallowed (footer is best-effort; a cache or sqlite3 error
  yields `""`, exactly as today).

**TTL-only (no DB-mtime gate).** The QE `memory.db` is written constantly by the
AQE hooks, so gating the cache on "cache newer than DB mtime" would invalidate it
on nearly every render and defeat the purpose. The footer counts are cosmetic;
being ≤60s stale is fine. A future `RUFLO_QE_STATUSLINE_TTL_MS=0` disables the
cache.

**Single-spawn SQL (verified against the real 52 MB DB).** A semicolon-batched
SQL *argument* aborts on the first error (`sqlite3` bails when SQL is passed as an
argv string), which would drop counts whenever a candidate vector table is absent
(the table name varies across AQE versions: `qe_pattern_embeddings` / `vectors` /
`embeddings`). Therefore the single call MUST:

1. Pass the SQL on **stdin** (`execFileSync("sqlite3", [db], { input })`) with a
   leading `.bail off` so a missing table does not abort the remaining statements.
2. Emit **labeled rows** so order/absence is unambiguous, in vector priority
   order:
   ```
   .bail off
   SELECT 'pat',COUNT(*) FROM qe_patterns;
   SELECT 'vec',COUNT(*) FROM qe_pattern_embeddings;
   SELECT 'vec',COUNT(*) FROM vectors;
   SELECT 'vec',COUNT(*) FROM embeddings;
   SELECT 'traj',COUNT(*) FROM qe_trajectories;
   ```
3. **Recover `e.stdout` in the `catch`** — `sqlite3` still exits non-zero when any
   statement errored (even with `.bail off`), so `execFileSync` throws; the rows
   that did run are on `e.stdout` and MUST be read from the thrown error.
4. Parse rows as `label|value`; `pat`/`traj` map directly; for `vec` take the
   **first non-zero** value (replicates the original "first existing table with
   count > 0 in priority order" behavior exactly).

## Requirements

- **R1.** `bin/ruflo-parity-test` MUST stop the daemon bound to its throwaway
  workspace on every exit (success, failure, INT/TERM), before/with the existing
  `rm -rf`, and MUST do so even when `--cleanup` is not passed (the daemon is an
  orphan regardless of whether the dir is kept).
- **R2.** `ruflo-setup-project` MUST NOT start a second daemon if one is already
  running for the current workspace; it MUST print which path it took.
- **R3.** A new `ruflo-daemon-gc` function MUST list daemons whose `--workspace`
  directory is missing; with `--kill` it MUST stop exactly those and no others;
  with no flag it MUST only list (dry preview). It MUST be a no-op (exit 0) when
  none are stale.
- **R4.** `uninstall.sh` MUST stop stale daemons (via the GC logic) and, with
  `--this-project`, MUST also stop the current repo's daemon. It MUST NOT kill
  unrelated live-workspace daemons.
- **R5.** The injected statusline footer MUST cache QE metrics with a TTL
  (default 60000ms, `RUFLO_QE_STATUSLINE_TTL_MS` override), MUST collapse to a
  single `sqlite3` call on a cache miss (stdin + `.bail off`, `e.stdout` recovery,
  labeled rows), and MUST produce rendered output identical to the pre-change
  footer for the same DB state.
- **R6.** A defensive guard MUST set `claudeFlow.daemon.autoStart` to `false` in
  `.claude/settings.json` **only if** that file exists and the value is currently
  `true`; absence of the key or file is a silent no-op.
- **R7.** The one-time machine cleanup MUST present the list of stale daemons and
  kill only workspace-gone daemons, leaving live-project daemons untouched.
- **R8.** `docs/TROUBLESHOOTING.md` MUST document (a) the daemon lifecycle and
  `ruflo-daemon-gc`, and (b) the `CLAUDE_CODE_TMPDIR` workaround for users with
  many hooks.
- **R9.** All shell changes MUST pass `bash -n` and (if installed) `shellcheck`,
  and the injected JS MUST pass `node --check` after injection.
- **R10.** (DRY) The ruflo-daemon `ps`-parser MUST be defined exactly once, in a
  shared `shell/ruflo-daemon-lib.sh`, sourced by `shell/ruflo-functions.sh`,
  `uninstall.sh`, and `bin/ruflo-parity-test`. Because the bin scripts run
  standalone from `~/.local/bin`, `install.sh` MUST deploy the lib to a stable
  absolute path (`~/.config/ruflo/ruflo-daemon-lib.sh`) and `uninstall.sh` MUST
  remove it. Each consumer MUST resolve the lib as "installed copy, else repo
  sibling" and degrade gracefully (skip teardown / print a hint) if it is absent.

## Verification

- `bash -n shell/ruflo-functions.sh uninstall.sh bin/ruflo-parity-test`
- `shellcheck` on the three files (if installed) — no new errors.
- `ruflo-daemon-gc` against a synthetic deleted-workspace daemon: lists it;
  `--kill` stops it; a live-workspace daemon is never listed.
- Re-run `ruflo-parity-test --cleanup` and confirm **no** new orphan daemon
  remains (`ps | grep daemon` count unchanged afterward).
- Render the patched statusline twice within the TTL; confirm the 2nd render
  spawns **no** sqlite3 (`dtruss`/strace-free check: a sentinel mtime on the cache
  file is unchanged) and output is byte-identical.
- `node --check` on the freshly injected `.claude/helpers/statusline.cjs`.
