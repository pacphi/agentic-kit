# Branch 3 (`feat/ruflo-support-window`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt a rolling Ruflo support window, make Ruflo's backup and distillation actually run and be
reported, stop the false "defend is non-functional" alarm, adopt the Ruflo 3.46.x fixes, route Claude
Code's Ruflo MCP through ak's launcher, and clean ak's old memory probe rows once.

**Architecture:** Four sequential slices, each run by a fresh implementer in the worktree
`/Users/cphillipson/Development/active/ai/agentic-kit-b3`. Every behavior change is a unit commit,
test first. Ruflo facts come from the installed 3.46.1 source; older-version behavior comes from
fixtures or `npm pack` tarballs in the scratch area, never from a real install.

**Tech Stack:** Node 22+/26 ESM CLI (`bin/agentic-kit.mjs`), `node:test`, Ruflo / `@claude-flow/cli`
3.46.1 (`$(npm root -g)/ruflo/node_modules/@claude-flow/cli/dist/src`, written below as `CLI/`),
SQLite through `src/lib/sqlite.mjs`.

**Spec:** [program plan, Branch 3](../plans/2026-09-26-remediation-program.md#branch-3-featruflo-support-window),
[audit record](../plans/2026-09-26-issues-237-238-239-verification-and-decisions.md) (Addendum 2
Problem 2, Addendum 3 Items 1 and 6, "Ruflo support window", "Ruflo 3.46.0", "Retroactive upstream
sweep"), the SDD ledger's maintainer decisions B3-D1 to B3-D4, and the binding brief
`.superpowers/sdd/2026-09-26-remediation-program/briefs/common.md` in the main checkout.

## Global Constraints

- Ruflo support window: the newest six minors, never fewer than the minors released in the last 30 days (n-5, at least 30 days, rolling).
- Never run `pnpm` in the worktree; use `node --test`, `npx tsc -p tsconfig.json`, `npx eslint`, `npx markdownlint-cli2`, `node scripts/build-check.mjs`.
- Commits: conventional subject, one unit each, failing run shown before the passing run, no `Co-Authored-By` or any trailer-like last line; stage files by name; never commit `.harness/`, `.swarm/`, `.claude-flow/`, `.agentic-qe/`.
- Tests never write `~/.config/agentic-kit`, `~/.local/state/agentic-kit`, a repository's `.claude`/`.swarm`/`.claude-flow`/`.harness`, or a real memory store. Disposable runs use `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME HOME=$T` with `T=$(mktemp -d "$SCRATCH/ak.XXXXXX")` and assert every created path lies in `$T`.
- Never write Ruflo daemon settings through `ruflo config set` (ruvnet/ruflo#3449); flat keys in `.claude-flow/config.json` only.
- Runtime assets live under `src/` and are proven shipped with `npm pack --dry-run`.
- An ADR a task changes gets its Status, an `Updated` date and a one-line note in the same task's docs commit; user-facing docs describe the current state only.
- Never push, open or comment on pull requests or issues, or post upstream. Upstream comment drafts go to the report only.
- Every registry edit bumps `lastVerifiedAt` to the edit date and keeps each constraint's `nextRetestAt` on or after it (`src/lib/hook-audit/upstream.mjs:93-96`); run `node --test tests/kit/upstream-watch-registry.test.mjs` before committing.
- Branch 5 later edits `src/lib/heal.mjs` and `src/commands/x/verify.mjs`: keep hunks there small and local to the security functions.

## Review Focus

- **A user who set `autoStart: false` on purpose.** `ruflo init` writes the same value, so ak cannot tell them apart; expect ak to turn it on only under its own recorded intent, keep a receipt of the old value, show the setting in `ak status`, and restore it on `ak uninstall`. Pinned in Task 2.2.
- **A `.claude-flow/config.json` that already holds other keys or is malformed.** Expect ak to add or remove only its own flat keys and to leave a malformed file untouched and reported. Pinned in Task 2.2.
- **A Claude Code session started in a project subfolder once Ruflo enforces MCP policy on stdio (3.46.0+).** Ruflo reads `<cwd>/.harness/mcp-policy.json` (`CLI/mcp-tools/policy-enforcer.js:66`) and refuses every call when it is missing; expect tool calls to keep working. Opened by Task 3.3, closed and pinned by Task 4.1.
- **A machine with no remembered Ruflo release dates (fresh install, offline).** Expect `ak status` to say the window is not yet known and name `ak sync`, never to call the network and never to call the version unsupported. Pinned in Task 1.2.
- **`security defend` crashing after it detects a threat (ruvnet/ruflo#3473, still in 3.46.1).** Expect `ak x verify security` to report a detection from the JSON verdict and a crash as a crash, never a pass. Pinned in Task 3.1.

## Verification of the scope against the code (2026-09-27, Ruflo 3.46.1)

Each scope item was checked against the worktree at `be1c1d47` and the installed Ruflo 3.46.1.

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Rolling support window | **Confirmed.** ak declares no floor; `src/lib/versions.mjs` only compares against npm latest. | Minors by first publish (npm `time`): 3.46 2026-09-26, 3.45 09-24, 3.44 09-23, 3.43 09-23, 3.42 09-15, 3.41 09-10, 3.40 09-09, 3.39 09-08, 3.38 08-11. Today's window: n-5 gives 3.41, the 30-day rule gives 3.39, so the floor is **3.39.0**. |
| 2 | Status row for backup and distillation | **Mostly already done.** `src/commands/status/sections/project-memory.mjs:112-151` (`backupRow`, `distillRow`) reads `memoryMaintenanceStatus` (`src/lib/memory-maintenance.mjs`), which reads `.claude-flow/metrics/backup.json` and `consolidation.json` exactly as 3.46.1 writes them (`CLI/services/worker-daemon.js:1529,1619`). The daemons row (`src/commands/status/sections/daemons.mjs`) names the autostart setting. | Remaining gap: nobody reports *why* workers do not run while a daemon is alive (the macOS low-memory deferral, `worker-daemon.js:594`, logged to `.claude-flow/logs/daemon.log`), and the rows do not say that start-on-use will start the daemon. Task 2.1 is scoped to that delta. |
| 3 | Daemon auto-start with managed flat keys | **Confirmed, and the task wording is incomplete.** `src/commands/setup.mjs:569-573` (not 575-585) flips `claudeFlow.daemon.autoStart` true to false. Stopping that is not enough: `ruflo init` writes `false` (`CLI/init/settings-generator.js:123`) and Ruflo's start-on-use refuses when it reads `false` (`CLI/services/daemon-autostart.js:56-76,84-88,184`). ak must set it to `true` under a receipt. | #3194 idle fix is in 3.46.1 (`worker-daemon.js:1019-1024` counts idle from process start). #2935 is not fixed (`worker-daemon.js:590` still `os.freemem()`, `:165` darwin default 5). Daemon reads flat keys from `.claude-flow/config.json`, JSON before YAML (`worker-daemon.js:354-416`). Memory root reads `claude-flow.config.json` then `.claude-flow/config.json`, falling through when a file has no `memory` key (`CLI/memory/memory-initializer.js:128-150`), so a daemon-only `.claude-flow/config.json` coexists with the memory pin. |
| 4 | Security defend reported non-functional | **Confirmed wrong reporting.** 3.46.1 `security defend` falls back to a built-in engine when `@claude-flow/aidefence` is missing (`CLI/commands/security.js:954-965`, `CLI/security/builtin-aidefence.js`). The `aidefence_*` MCP tools still need the package (`CLI/mcp-tools/security-tools.js:42-110`), so the heal stays. | ak's wording: `status/sections/security.mjs:15-17`, `x/verify.mjs:214`, `about.mjs:169-175`, `heal.mjs:177`, footer `statusline-footer.cjs:377-403,698`. #3473 reproduced on 3.46.1 in a disposable folder: text mode prints `2 threat(s) detected` then `[ERROR] Cannot read properties of undefined (reading 'color')`, exit 1; `-o json` prints the full verdict with no crash (exit 1 on threat, 0 on clean). |
| 5 | Remove the CVE-counter overlay | **Confirmed, and already inert.** `upstreamCveCounterFabricated()` (`src/lib/statusline.mjs:111-118`) is false on 3.46.1 (`CLI/funnel/local-signals.js:15,41` has `totalCves: 0`), so `SEC_WRAP` is no longer injected. Removal is safe because the floor 3.39.0 is above the fix (3.32.2). | Code: `statusline.mjs:40-59,101-118,307,315`; `status/sections/statusline.mjs:44-57`; `sync.mjs:563-565,646,708`; `statusline-footer.cjs:706-780`. |
| 6 | Stale "#2986 pending" note | **Confirmed.** `status/sections/scaffold-agents.mjs:27`. Every supported version (3.39.0+) ships `migrate fix --agents` (3.38.2+). | Registry adjustment at `agentic-dependency-constraints.json:1193`. |
| 7a | #3415 governance on stdio | **Confirmed shipped in 3.46.0, and ak's boundary is wrong.** 3.46.1 wires `evaluateToolCall` into both stdio entry points (`CLI/../bin/cli.js:166-168`, `bin/mcp-server.js:32-35,181-182`). The 3.45.0 and 3.44.0 tarballs have none. ak says "3.44.0 and earlier" (`ruflo-components/snapshot.mjs:48-52`, `catalogue.mjs:19`, `policy.mjs:1-5`); the correct boundary is "below 3.46.0". | `npm pack @claude-flow/cli@3.45.0` in scratch: `grep -c evaluateToolCall bin/cli.js bin/mcp-server.js` gives 0 and 0. |
| 7b | #3167 init opt-out flags | **Confirmed fixed in 3.46.1** (`CLI/commands/init.js:116-118,300-305`). **Cannot be removed unconditionally:** 3.39 to 3.45 are inside the window and still defective. Planned as a version gate (decision flagged). Nothing parses init's output (`setup.mjs:508`), so dropping `--format json` is safe on 3.46.0+. | Constraint `ruflo-3.38.21-init-suppression-flags`. |
| 7c | #3166 agent-browser doctor row | **Confirmed shipped.** `CLI/commands/doctor.js:66-100` reports agent-browser against a 0.27.0 minimum. ak has no workaround, so adoption is registry-only. The doctor's fix text `npm install -g agent-browser@latest` conflicts with ak's `>=0.27.0 <0.28.0` range (`src/lib/agent-browser.mjs:17`): recorded as an investigation candidate, not filed. | Installed agent-browser 0.27.3. |
| 7d | #3193 YAML config | **Half shipped.** The daemon now parses `.claude-flow/config.yaml` (`worker-daemon.js:30-32,370-387`; `yaml` resolves from the CLI package). The memory root still reads JSON only (`memory-initializer.js:128-150`) and `ConfigFileManager` still creates `claude-flow.config.json` from defaults with `persistPath: ./data/memory` (`CLI/services/config-file-manager.js:8-11,31,104-110`). ak's memory pin stays; registry note only. | Issue still open. |
| 8 | Nightly note for #2885 | **Confirmed stale.** `.github/workflows/nightly.yml:80-85` says "open as of 2026-08-13"; the thread has an Aug 31 triage (better-sqlite3 plus onnxruntime on macOS arm64) and our Sep 26 inconclusive local test. | `gh issue view 2885` (read-only). |
| 8b | `.harness/` in git | **Evidence favors excluding only ak's own file.** Ruflo and Agentic QE commit their own `.harness/mcp-policy.json` (search_ruvnet: `ruflo/.harness/manifest.json`, `agentic-qe/.harness/mcp-policy.json`), so a blanket `.harness/` ignore would hide other tools' intended files. A committed ak-written file has no receipt on a teammate's machine, so `reconcilePolicy` returns `user-managed` and quietly stops managing it there (`ruflo-components/policy.mjs:57-62`). | Plan: add `.harness/mcp-policy.json` to `.git/info/exclude` only when ak writes the file (decision flagged). |
| D1 | Claude through `ak x ruflo-mcp` | **Confirmed needed, and it has a second benefit.** Claude's registration is `ruflo mcp start` (`src/lib/mcp.mjs:539-567`). In a subfolder, Claude's `agentdb-memory.db` derives from `<cwd>/.swarm` (see `ruflo-memory.mjs:1-8`), so it strays today, and the policy file lookup is cwd-relative. `rufloMcpLaunch` merges `componentEnv` over the inherited env (`ruflo-memory.mjs:103-138`), which would override a Claude user's settings env (ADR-0058 §3): the launcher needs a Claude mode that sets only the memory location. | `memoryProjectRoot` (`ruflo-memory.mjs:92-95`) is where harvest and setup pick their root. |
| D2 | One-time probe-row cleanup | **Confirmed #3450 still reproduces on 3.46.1.** In a disposable project, `memory store` wrote the row to both `memory.db` and `agentdb-memory.db`; `memory delete` only marked the `memory.db` row deleted; `memory purge` removed it from `memory.db` and left both mirror rows `active`. This repository's stores hold 0 probe rows today, so the real-data pass may find nothing, and must say so. | Probe key format `_setup/verify-${pid}-${Date.now()}`, namespace `_setup`, content `setup-verify` (`setup.mjs:583-585`). |

**Carried re-checks (RM5, RM6, RM8), all on 3.46.1, no comment drafted:**

- RM5 / ruvnet/ruflo#3450: reproduces unchanged (above). The only change is that `memory search` now warns that it did not search `agentdb-memory.db`; not material.
- RM6 / ruvnet/ruflo#3449: reproduces unchanged. `config set daemon.idleSecs 0` gives `Required option missing: --key/--value`; `-k daemon.idleSecs -v 0` gives `Both key and value are required`; `-k daemon.idleSecs -v 5` creates `claude-flow.config.json` with `memory.persistPath: "./data/memory"` and nested `daemon.idleSecs`. All already in the issue.
- RM8 / ruvnet/ruflo#2935: `worker-daemon.js:590` still reads `os.freemem()`, `:165` still defaults darwin to 5%. A reading today on the same 128 GB machine gave 5.96% free, straddling the default. Not material.

## Maintainer decisions this plan cannot make (recommended option planned)

1. **#3167 suppression:** gate ak's `--format json` and `RUFLO_NO_SKILLS_SH=1` to Ruflo below 3.46.0 (recommended; matches "version-gated" in the Ruflo dependency policy) or keep them until the window floor reaches 3.46.0.
2. **macOS memory threshold:** `daemon.resourceThresholds.minFreeMemoryPercent: 0` (recommended; the workaround Ruflo's own code comment names at `worker-daemon.js:648`) or `1`.
3. **`.harness/mcp-policy.json` in git:** `.git/info/exclude` entry written when ak writes the file (recommended; no tracked-file change), a managed `.gitignore` line, or nothing.
4. **Registry `supportWindow` field:** an optional field on the Ruflo dependency policy under schema 5 (recommended) or a schema bump to 6.
5. **#2885 macOS job (B3-D3):** GitHub runs `workflow_dispatch` only for a workflow file on the default branch, so the throwaway job uses `on: push` limited to its own short-lived branch. The controller pushes it under B3-D3; implementers never push.

## File structure

| File | Responsibility | Slice |
|---|---|---|
| `src/lib/ruflo-support-window.mjs` (new) | Minor first-publish dates from `npm view ruflo time --json`, window computation, remembered evidence in `kit.json` | 1 |
| `src/lib/hook-audit/agentic-dependency-constraints.json` | `supportWindow` on the Ruflo policy; watch entries moved to adopted/retired | 1, 3 |
| `src/lib/hook-audit/upstream.mjs` | Validate the optional `supportWindow` | 1 |
| `src/commands/status/sections/versions.mjs` | Window row | 1 |
| `src/commands/sync.mjs` | Record release dates on the forced lookup; probe-row cleanup step | 1, 4 |
| `scripts/upstream-watch/classify.mjs` | "Waiting for the window" before proposing removal | 1 |
| `src/lib/statusline.mjs`, `src/templates/statusline-footer.cjs`, `src/commands/status/sections/statusline.mjs` | Overlay removal; aidefence footer wording | 1, 3 |
| `src/lib/ruflo-daemon-config.mjs` (new) | Managed flat keys in `.claude-flow/config.json` and the autostart setting, with receipts | 2 |
| `src/commands/status/sections/daemons.mjs`, `src/lib/memory-maintenance.mjs` | Deferral reason and start-on-use state | 2 |
| `src/commands/setup.mjs` | Stop flipping autostart; call the daemon config reconcile; version-gated init suppression | 2, 3 |
| `src/commands/status/sections/security.mjs`, `src/commands/x/verify.mjs`, `src/commands/about.mjs`, `src/lib/heal.mjs`, `src/lib/natives.mjs` | Built-in engine awareness | 3 |
| `src/lib/ruflo-components/{snapshot,catalogue,policy,apply}.mjs` | Governance boundary 3.46.0; `.git/info/exclude` | 3 |
| `src/lib/ruflo-memory.mjs`, `src/commands/x/ruflo-mcp.mjs`, `src/lib/ruflo-mcp-transport.mjs`, `src/lib/mcp.mjs`, `src/lib/adapters/registries.mjs` | Claude through the launcher | 4 |
| `src/lib/memory-probe-cleanup.mjs` (new) | Find, back up, delete and receipt old probe rows | 4 |

---

## Slice 1: support window and retirements

### Task 1.1: Support-window policy in the registry

**Files:**

- Modify: `src/lib/hook-audit/agentic-dependency-constraints.json` (Ruflo entry of `dependencyPolicies`, line ~27)
- Modify: `src/lib/hook-audit/upstream.mjs:60-74`
- Test: `tests/kit/upstream-watch-registry.test.mjs`

**Interfaces:**

- Produces: `dependencyPolicies[ruflo].supportWindow = { newestMinors: 6, minDays: 30, basis: "first npm publish of each minor", unsupported: "ak status reports the installed Ruflo as unsupported and points to ak sync" }`. Validation: optional; when present `newestMinors` and `minDays` are positive integers and `basis` a string.

- [ ] **Step 1: Write the failing tests** (append to `tests/kit/upstream-watch-registry.test.mjs`, using its existing `withRegistry` and `errorsOf` helpers)

```js
test('the Ruflo dependency policy carries the rolling support window', () => {
  const doc = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const ruflo = doc.dependencyPolicies.find((p) => p.dependency === 'ruflo');
  assert.deepEqual({ n: ruflo.supportWindow.newestMinors, d: ruflo.supportWindow.minDays }, { n: 6, d: 30 });
});

test('an invalid support window invalidates the registry', () => {
  const errors = errorsOf((doc) => {
    doc.dependencyPolicies.find((p) => p.dependency === 'ruflo').supportWindow = { newestMinors: 0, minDays: 'x' };
  });
  assert.match(errors, /dependency policy 0 is invalid/);
});
```

- [ ] **Step 2: Run and see both fail**

Run: `node --test tests/kit/upstream-watch-registry.test.mjs`
Expected: the first fails on `ruflo.supportWindow` undefined; the second passes vacuously or fails because the invalid window is accepted. Record the output.

- [ ] **Step 3: Implement.** Add the object above to the Ruflo policy. In `upstream.mjs` extend the policy `valid` predicate:

```js
&& (entry.supportWindow === undefined || (
  Number.isInteger(entry.supportWindow?.newestMinors) && entry.supportWindow.newestMinors > 0
  && Number.isInteger(entry.supportWindow?.minDays) && entry.supportWindow.minDays > 0
  && typeof entry.supportWindow?.basis === 'string'))
```

- [ ] **Step 4: Run to pass.** `node --test tests/kit/upstream-watch-registry.test.mjs tests/kit/hook-upstream.test.mjs` passes.
- [ ] **Step 5: Commit** `feat(upstream): record the Ruflo support window on its dependency policy` (stage the three files by name).

### Task 1.2: Compute and report the window from remembered evidence

**Files:**

- Create: `src/lib/ruflo-support-window.mjs`
- Modify: `src/commands/status/sections/versions.mjs`, `src/commands/sync.mjs:107` (the forced `driftReport` call site)
- Test: `tests/kit/ruflo-support-window.test.mjs` (new), `tests/kit/versions.test.mjs`

**Interfaces:**

- Produces:
  - `minorFirstPublished(timeJson: Record<string,string>): Record<string,string>` maps `"3.46"` to the earliest ISO time of any stable `3.46.x` (prereleases and `created`/`modified` ignored).
  - `computeSupportWindow({ firstPublished, now, newestMinors, minDays }): { floor: string, minors: string[] } | null` where `floor` is `"<major>.<minor>.0"`: the older of the `newestMinors`-th newest minor and the oldest minor first published within `minDays` of `now`. `null` when `firstPublished` is empty.
  - `rememberedSupportWindow(cfg, { now, policy }): { floor, minors, observedAt } | null` reads `cfg.versionCheck.rufloMinors = { observedAt: number, firstPublished: {...} }`. No I/O besides the argument.
  - `recordRufloReleaseDates({ runner, cfg }): Promise<boolean>` runs `npm view ruflo time --json` (20 s timeout) and stores `cfg.versionCheck.rufloMinors`; returns false and leaves the old value on failure.
  - `supportWindowPolicy(): { newestMinors, minDays }` reads the registry via the existing loader, defaulting to 6 and 30 if the registry is unreadable.

- [ ] **Step 1: Write the failing unit tests** (`tests/kit/ruflo-support-window.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minorFirstPublished, computeSupportWindow, rememberedSupportWindow } from '../../src/lib/ruflo-support-window.mjs';

const TIME = { created: '2020-01-01T00:00:00Z', modified: '2026-09-27T00:00:00Z',
  '3.38.0': '2026-08-11T22:43:21Z', '3.39.0': '2026-09-08T16:52:33Z', '3.40.0': '2026-09-09T23:10:35Z',
  '3.41.0': '2026-09-10T11:59:59Z', '3.42.0': '2026-09-15T00:50:39Z', '3.43.0': '2026-09-23T15:05:58Z',
  '3.44.0': '2026-09-23T18:47:33Z', '3.45.0': '2026-09-24T22:54:53Z', '3.46.0-alpha.1': '2026-09-20T00:00:00Z',
  '3.46.0': '2026-09-26T22:34:55Z', '3.46.1': '2026-09-27T01:00:00Z' };
const NOW = Date.parse('2026-09-27T12:00:00Z');

test('first publish per minor ignores prereleases and metadata keys', () => {
  const m = minorFirstPublished(TIME);
  assert.equal(m['3.46'], '2026-09-26T22:34:55Z');
  assert.equal(m.created, undefined);
});

test('30-day rule widens n-5: today the floor is 3.39.0, not 3.41.0', () => {
  const w = computeSupportWindow({ firstPublished: minorFirstPublished(TIME), now: NOW, newestMinors: 6, minDays: 30 });
  assert.equal(w.floor, '3.39.0');
});

test('after a quiet month n-5 alone decides', () => {
  const w = computeSupportWindow({ firstPublished: minorFirstPublished(TIME), now: Date.parse('2026-12-01T00:00:00Z'), newestMinors: 6, minDays: 30 });
  assert.equal(w.floor, '3.41.0');
});

test('no remembered evidence gives null, never a guess', () => {
  assert.equal(rememberedSupportWindow({}, { now: NOW, policy: { newestMinors: 6, minDays: 30 } }), null);
});
```

- [ ] **Step 2: Write the failing section tests** (`tests/kit/versions.test.mjs`, reuse its sandbox and injected `driftReport`/`fetchLatest` seams). Cases, each asserting the Ruflo window row:
  - remembered floor 3.39.0, installed 3.46.1: `info`, message `Ruflo 3.46.1 is inside the support window (3.39.0 and newer; release dates observed <ISO>)`.
  - installed 3.38.2: `fail`, message contains `unsupported`, `below the support window (3.39.0 and newer)`, fix `sync upgrades Ruflo into the support window`, `repair: 'sync'`.
  - no `rufloMinors`: `info`, message "Ruflo support window not yet known: run ak sync to record Ruflo's release dates", and a spy runner proves no `npm` call was made by the section (the runner must record zero calls; `driftReport` is injected as a stub).
- [ ] **Step 3: Run and see them fail** (`node --test tests/kit/ruflo-support-window.test.mjs tests/kit/versions.test.mjs`: module not found / row missing).
- [ ] **Step 4: Implement** the module; add the row after the existing Ruflo row in `versions.mjs` (reads `loadKitConfig()` only); in `sync.mjs` call `recordRufloReleaseDates` right after the forced `driftReport` and save the config through the same path `driftReport` uses (`saveKitConfig`). Wire the sync step's `when` so a `versions` fail row plans it (it already does for `versions`).
- [ ] **Step 5: Run to pass**, plus `node --test tests/kit/sync-command.test.mjs tests/kit/status-repair-contract.test.mjs`.
- [ ] **Step 6: Commit** `feat(versions): support a rolling window of Ruflo minors (n-5, at least 30 days)`.

### Task 1.3: The watcher waits for the window before proposing removal

**Files:** Modify `scripts/upstream-watch/classify.mjs:157-190`, `scripts/upstream-watch/fetch.mjs` (reuse its npm read to get `time`); Test `tests/kit/upstream-watch-script.test.mjs`.

**Interfaces:** Consumes `computeSupportWindow` from Task 1.2. Produces a group `waiting-for-window` on a released Ruflo entry whose `doneWhen.release.minVersion` is above the floor; `dispatch` stays null for it.

- [ ] **Step 1: Failing test:** with floor 3.39.0, `entry('ruvnet/ruflo#3167', { status: 'released', doneWhen: { state: 'closed-completed', release: { channel: 'npm', name: 'ruflo', minVersion: '3.46.0' } } })` classifies with `groups` containing `waiting-for-window` and `dispatch === null`; the same entry with `minVersion: '3.32.2'` is dispatchable.
- [ ] **Step 2:** run, expect FAIL. **Step 3:** implement (floor passed in `context.supportFloor`; the CLI computes it from the npm `time` it already fetches; fixtures add a `time` object). **Step 4:** run to pass.
- [ ] **Step 5: Commit** `feat(upstream): hold workaround removals until the oldest supported Ruflo has the fix`.

### Task 1.4: Remove the retired CVE-counter overlay

**Files:** Modify `src/lib/statusline.mjs` (delete `SEC_WRAP`, `upstreamCveCounterFabricated`, the `securityOverlay` gate; keep `SEC_WRAP_STRIP` and its strip line with a comment "remove after one release"), `src/templates/statusline-footer.cjs` (delete `rufloLocalSecurity`, `rufloHonestInsight` and their comment block at 706-780), `src/commands/status/sections/statusline.mjs:44-57`, `src/commands/sync.mjs:563-565,646,708` (drop `statusline/cve`); Tests `tests/kit/statusline.test.mjs`, `tests/statusline-segments.test.cjs`, `tests/kit/sync-command.test.mjs:659`, `tests/kit/status-repair-contract.test.mjs:194-196`.

- [ ] **Step 1: Failing tests:** (a) a statusline source containing an old `/* ruflo-sec:BEGIN */ … /* ruflo-sec:END */` block is patched to a file with no `ruflo-sec` text and no `rufloLocalSecurity`; (b) the footer template does not define `rufloLocalSecurity` or `rufloHonestInsight`; (c) status never emits a `statusline/cve` row, even with a fixture `local-signals.js` containing `const totalCves = 3` and `scans.length`.
- [ ] **Step 2:** run, expect FAIL on (a) second clause and (b), (c).
- [ ] **Step 3:** delete the code; update the two repair-contract tests that asserted `statusline/cve` behavior to assert the subsystem no longer exists.
- [ ] **Step 4:** run `node --test tests/kit/statusline*.test.mjs tests/kit/sync-command.test.mjs tests/kit/status-repair-contract.test.mjs` and `node tests/statusline-segments.test.cjs`.
- [ ] **Step 5: Commit** `refactor(statusline): remove the retired CVE-counter overlay`. Registry: set `ruvnet/ruflo#2694` to `status: "adopted"` with a history line `{"date":"<today>","event":"adopted","note":"overlay removed; SEC_WRAP_STRIP kept one release; floor 3.39.0 >= 3.32.2"}` in the same commit (removal proof: the statusline suite passes against a 3.46.1 statusline fixture).

### Task 1.5: Drop the stale "#2986 pending" note

**Files:** Modify `src/commands/status/sections/scaffold-agents.mjs:4-7,24-28`; Test `tests/kit/scaffold.test.mjs`.

- [ ] **Step 1: Failing test:** with `upstreamFixAvailable()` false (fixture dist without `migrate-agent-restore.js`), the info row says ``installed Ruflo predates `migrate fix --agents` (added in 3.38.2, below the support window): run `ak sync` `` and does not match `/#2986 pending/`.
- [ ] **Step 2–4:** run (FAIL), change the message and the header comment, run (PASS).
- [ ] **Step 5: Commit** `docs(status): drop the stale "#2986 pending" note`. Registry `ruvnet/ruflo#2986` to `adopted` with history in the same commit.

### Task 1.6: Slice 1 docs

- [ ] Amend ADR-0041 §7 with one paragraph (and check `docs/ddd/` for a context that names Ruflo versions; update it or record that none does): the support window rule, where it lives (`supportWindow` on the Ruflo policy), remembered evidence in `kit.json` (`versionCheck.rufloMinors`, written only by `ak sync`), and "the watcher proposes removal only once the floor contains the fix". Add an `Updated: 2026-09-27` line.
- [ ] Update `docs/UPGRADING.md` (support window, what "unsupported" means), `docs/UPSTREAM-WATCH.md` (`waiting-for-window`), `docs/TROUBLESHOOTING.md` (statusline no longer overlays a CVE count).
- [ ] Run `npx markdownlint-cli2 docs/adr/0041-host-neutral-hook-configuration-assurance.md docs/UPGRADING.md docs/UPSTREAM-WATCH.md docs/TROUBLESHOOTING.md` and `node --test tests/kit/doc-citations.test.mjs`.
- [ ] Commit `docs(adr): record the Ruflo support window (ADR-0041 §7)`.

---

## Slice 2: daemon

### Task 2.1: Say why backup and distillation are not running

**Files:** Modify `src/lib/memory-maintenance.mjs` (add a bounded log reader), `src/commands/status/sections/daemons.mjs`, `src/commands/status/sections/project-memory.mjs:112-134`; Tests `tests/kit/memory-maintenance.test.mjs`, `tests/kit/daemons-status.test.mjs`.

**Interfaces:**

- Produces: `lastWorkerDeferral(root, { now }): { worker: 'backup'|'consolidate', reason: string, ageMs: number } | null`. Reads at most the last 64 KiB of `<root>/.claude-flow/logs/daemon.log`, matching lines `^\[(ISO)\] \[INFO\] Worker (backup|consolidate) deferred: (.+)$` (3.46.1 format, `worker-daemon.js:1156-1161`).

- [ ] **Step 1: Failing tests:**
  - A log whose last matching line is `[2026-09-27T10:00:00.000Z] [INFO] Worker consolidate deferred: Memory too low: 3.9% free` gives `{ worker: 'consolidate', reason: 'Memory too low: 3.9% free' }`; a 5 MB log is read only at its tail (assert via a file with the match in the last 1 KiB and 5 MB of padding, and time under 50 ms is not asserted, only correctness).
  - With a live daemon (inject `projectDaemonAlive` through the section's options) and that deferral, the memory section adds `warn` `Ruflo's daemon is running but deferred distillation 2 h ago: Memory too low: 3.9% free (macOS free-memory gate, ruvnet/ruflo#2935)` with fix `sync sets Ruflo's macOS memory threshold` and `repair: 'sync'` on darwin (the fix exists after Task 2.2), and `repair: 'manual'` elsewhere.
  - With no daemon and start-on-use on, the daemons row says ``none running for this project yet; Ruflo starts it on the next `ruflo` command here`` (level `info`); with start-on-use off it keeps today's message.
- [ ] **Step 2:** run, expect FAIL. **Step 3:** implement (extend `projectDaemonAlive` injection in `project-memory.mjs` the same way `daemons.mjs` injects `listDaemons`). **Step 4:** run `node --test tests/kit/memory-maintenance.test.mjs tests/kit/daemons-status.test.mjs tests/kit/project-memory-status.test.mjs`.
- [ ] **Step 5: Commit** `feat(status): show whether Ruflo's backup and distillation are running`.

### Task 2.2: Managed daemon settings and start-on-use

**Files:**

- Create: `src/lib/ruflo-daemon-config.mjs`
- Modify: `src/commands/setup.mjs:560-574` (replace the `autoStart → false` flip with a call to `reconcileRufloDaemon`), `src/commands/sync.mjs` (a `ruflo-daemon` step fired by a `daemons` row with `repair: 'sync'`), `src/commands/status/sections/daemons.mjs` (row for drift), `src/lib/trust-manifest.mjs` (disclose both writes), `src/commands/uninstall.mjs` (restore from receipts), `src/lib/daemons.mjs:210-235` (comment: ak no longer keeps it false)
- Test: `tests/kit/ruflo-daemon-config.test.mjs` (new), `tests/kit/setup-command.test.mjs`, `tests/kit/uninstall-command.test.mjs`

**Interfaces:**

- Produces:
  - `desiredDaemonKeys({ rufloVersion: string, platform: string }): Record<string, number>`: `{'daemon.idleSecs': 0}` when `cmpVersions(rufloVersion, '3.46.0') < 0`; `{'daemon.resourceThresholds.minFreeMemoryPercent': 0}` when `platform === 'darwin'` (until ruvnet/ruflo#2935 closes). Empty object otherwise.
  - `reconcileRufloDaemon(root, { rufloVersion, platform, receipts, dryRun }): { config: 'written'|'converged'|'removed'|'user-managed'|'absent', autostart: 'enabled'|'converged'|'user-managed', changed: boolean }`.
  - Receipts live in `kit.json` under `rufloDaemon.receipts[<resolved root>] = { configKeys: Record<string, number>, autostartBefore: false|null }`.
- Rules: `.claude-flow/config.json` is created only when `desiredDaemonKeys` is non-empty; existing foreign keys are preserved byte-for-byte in value (re-serialized with two-space JSON); a malformed or non-object file is `user-managed` and never written; a key ak wrote that is no longer desired (Ruflo upgraded to 3.46.0) is removed, and an ak-created file left empty is deleted. `.claude/settings.json` `claudeFlow.daemon.autoStart` is set to `true` only when it is exactly `false` and `kit.json` `rufloDaemon.autoStart !== false`; the old value goes in the receipt. `claude-flow.config.json` `daemon.autostart` and the `RUFLO_DAEMON_AUTOSTART` variable are never edited; status names them. Never runs `ruflo config set`.

- [ ] **Step 1: Failing unit tests** (temp project folders only):

```js
test('below 3.46.0 on macOS both keys are flat in .claude-flow/config.json', (t) => {
  const root = tmpProject(t);
  const receipts = {};
  const r = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts });
  assert.equal(r.config, 'written');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude-flow', 'config.json'), 'utf8'));
  assert.deepEqual(cfg, { 'daemon.idleSecs': 0, 'daemon.resourceThresholds.minFreeMemoryPercent': 0 });
  assert.equal(cfg.daemon, undefined, 'never nested keys (ruvnet/ruflo#3449)');
});

test('on 3.46.1 Linux nothing is written', (t) => {
  const root = tmpProject(t);
  assert.equal(reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'linux', receipts: {} }).config, 'absent');
  assert.equal(fs.existsSync(path.join(root, '.claude-flow', 'config.json')), false);
});

test('an upgrade to 3.46.0 removes only the idle key ak wrote', (t) => { /* write with 3.45.0, add a foreign key "providers": [], reconcile with 3.46.1 darwin: idleSecs gone, providers and the memory threshold kept */ });
test('a malformed config.json is user-managed and untouched', (t) => { /* write "{", reconcile, bytes unchanged, status user-managed */ });
test('the memory pin still wins and .swarm stays the memory root', (t) => {
  /* write claude-flow.config.json {"memory":{"persistPath":".swarm"}} and reconcile; then rufloConfigMemoryRoot(root) resolves to <root>/.swarm;
     remove claude-flow.config.json: rufloConfigMemoryRoot(root) is null (Ruflo falls back to <cwd>/.swarm) */
});
test('init\'s autoStart:false becomes true with a receipt, and uninstall restores it', (t) => { /* … */ });
test('kit.json rufloDaemon.autoStart:false leaves the setting alone', (t) => { /* … */ });
test('reconcile never spawns ruflo', (t) => { /* inject a runner that throws; reconcile completes */ });
```

- [ ] **Step 2:** run `node --test tests/kit/ruflo-daemon-config.test.mjs`, expect module-not-found FAIL. Add a failing `setup-command.test.mjs` case: after `run_project` with an injected runner in a sandbox project whose settings say `autoStart: true`, the value stays `true` (today it becomes `false`).
- [ ] **Step 3:** implement; `setup.mjs` calls `reconcileRufloDaemon` **before** `ruflo daemon start`, because the daemon reads `.claude-flow/config.json` once, in its constructor (`worker-daemon.js:139-144`), so a daemon started first never sees the managed keys. Add a setup test asserting the reconcile write happens before the runner's `daemon start` call; the daemons row reports drift (`ak-managed daemon settings differ from what this Ruflo version needs`) with `repair: 'sync'`.
- [ ] **Step 4:** run the three test files plus `node --test tests/kit/trust-manifest*.test.mjs tests/kit/status-repair-contract.test.mjs`.
- [ ] **Step 5: Commit** `feat(ruflo-daemon): enable auto-start with Ruflo's supported daemon settings`.

### Task 2.3: Prove on 3.46.1 that backup and distillation run

No code; the evidence goes into the slice report and the audit record.

- [ ] **Step 1:** build a disposable home and project: `SCR=<scratchpad>; T=$(mktemp -d "$SCR/ak.XXXXXX")`; `git init $T/proj`; inside `$T/proj` run `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME HOME=$T node <worktree>/bin/agentic-kit.mjs setup --project --yes --minimal --no-aqe --no-agent-browser --no-ruvnet-brain --no-deja-vu` (flags from `setup.mjs:66-84`). Assert every new path is under `$T`.
- [ ] **Step 2:** setup already started a daemon, which proves nothing about start-on-use: run `ruflo daemon stop` in `$T/proj` and confirm no live PID in `.claude-flow/daemon.pid`. Then `ruflo memory store -k proof --value one -n proof` (Ruflo's start-on-use, `CLI/index.js:189-204`) and confirm a new live PID and the log line `Daemon config loaded from …/.claude-flow/config.json`.
- [ ] **Step 3:** wait at least 11 minutes (consolidate first runs 6 min after start, backup 10 min; `worker-daemon.js:38,40`). `ruflo daemon trigger` exists but proves only a manual run, so do not substitute it. Use Monitor with an until-loop on `$T/proj/.claude-flow/metrics/backup.json`, not `sleep`.
- [ ] **Step 4:** record `backup.json` (`backedUp: true`), `consolidation.json` (`distillationEnabled: true`, no `error`), the snapshot file under `.swarm/backups/`, the daemon log lines, and `node bin/agentic-kit.mjs status --json` rows for `memory` and `daemons` from that project.
- [ ] **Step 5:** `ruflo daemon stop` in `$T/proj`; confirm no daemon for `$T` remains (`ruflo daemon status --all`); remove `$T`.
- [ ] **Step 6:** repeat Steps 1–5 with the 3.45.0 behavior simulated only at unit level (Task 2.2 tests); do not install 3.45.0 globally.

### Task 2.4: Slice 2 docs

- [ ] Check `docs/ddd/` for the memory and machine-footprint contexts' daemon wording.
- [ ] Addendum 3 Item 1 gets an implementation note (3.46.1 facts above, the autostart correction, the proof results). ADR-0058 is not touched here.
- [ ] `docs/SETUP.md` and `docs/TROUBLESHOOTING.md`: what ak writes in `.claude-flow/config.json` and `.claude/settings.json`, how to turn it off (`kit.json` `rufloDaemon.autoStart: false`, then `ak sync`).
- [ ] `ak setup --help` and `ak sync --help` mention the daemon step.
- [ ] Commit `docs(ruflo-daemon): document managed daemon settings and start-on-use`.

---

## Slice 3: security and 3.46.x adoptions

### Task 3.1: Defend is functional on the built-in engine; verify reads the verdict

**Files:** Modify `src/lib/natives.mjs` (add `rufloBuiltinDefence(): boolean`, true when `CLI/security/builtin-aidefence.js` exists under the global Ruflo), `src/commands/status/sections/security.mjs`, `src/commands/x/verify.mjs:210-222` (security function only), `src/commands/about.mjs:166-176`, `src/lib/heal.mjs:173-178` (detail text only), `src/templates/statusline-footer.cjs:377-403,698-705`; Tests `tests/kit/verify-command.test.mjs:60-80`, a new `tests/kit/security-status.test.mjs`, `tests/statusline-segments.test.cjs:455-470`, `tests/kit/about-*.test.mjs` as affected.

**Interfaces:** Produces `parseDefendVerdict(stdout: string): { safe: boolean, threats: number } | null` in `verify.mjs` (exported for tests): the last complete top-level JSON object in the output with a boolean `safe`, else `null`.

- [ ] **Step 1: Failing tests:**
  - Status with security present, aidefence absent, built-in engine present: `warn`, message `security defend uses Ruflo's built-in engine; @claude-flow/aidefence (adaptive learning and the aidefence_* MCP tools) is missing`, fix `sync reinstalls @claude-flow/aidefence`, `repair: 'sync'`. Aidefence absent and no built-in engine: today's `fail` row (kept for completeness, below the window).
  - `parseDefendVerdict` on the recorded 3.46.1 JSON output (store it as `tests/fixtures/ruflo-defend/threat.json.txt` and `clean.json.txt`, captured with `-o json` in a disposable folder) gives `{ safe: false, threats: 2 }` and `{ safe: true, threats: 0 }`; on the text-mode crash output (`tests/fixtures/ruflo-defend/threat-crash.txt`, containing `[ERROR] Cannot read properties of undefined (reading 'color')`) gives `null`.
  - `verifySecurity` with an injected runner: threat JSON exit 1 plus clean JSON exit 0 prints `defend: flags injection (2 threats), passes clean`; crash output exit 1 prints `defend crashed before reporting a verdict (ruvnet/ruflo#3473)` and fails; aidefence absent no longer returns early.
  - The footer renders no alarm when the built-in engine file exists and aidefence is absent.
- [ ] **Step 2:** run, expect FAIL. **Step 3:** implement: verify calls `ruflo security defend -i <text> -o json`; the footer's `rufloAidefenceState` returns `"builtin"` (no alarm) when `security/builtin-aidefence.js` exists; `healAidefence` detail becomes `installed (adaptive learning and aidefence_* MCP tools)`; About reports `attention('aidefence missing: defend uses the built-in engine; aidefence_* MCP tools unavailable')`.
- [ ] **Step 4:** run `node --test tests/kit/verify-command.test.mjs tests/kit/security-status.test.mjs tests/kit/about-*.test.mjs` and `node tests/statusline-segments.test.cjs`.
- [ ] **Step 5: Commit** `fix(security): stop reporting defend as non-functional when Ruflo ships the built-in engine`. Registry: `ruvnet/ruflo#2670` to `adopted`; `ruvnet/ruflo#3473` gets `kitImpact.files` = the verify and status files and an adjustment note "verify reads `-o json`; text-mode crash is reported as a crash".

### Task 3.2: #3167 init suppression gated below 3.46.0

**Files:** Modify `src/commands/setup.mjs:490-512`; Test `tests/kit/setup-command.test.mjs` (or the test that already imports `RUFLO_PROJECT_INIT_ARGS`).

**Interfaces:** `tests/kit/setup-command.test.mjs` imports `RUFLO_PROJECT_INIT_ARGS`/`_ENV`; update it in the same commit. Replace the two constants with `rufloProjectInitInvocation(rufloVersion: string): { args: string[], env: Record<string,string> }`. On 3.46.0 and newer: `['init','--full','--force','--no-global','--no-codex-detect','--no-skills-sh']`, `{}`. Below: today's args with `--format json` and `{ RUFLO_NO_SKILLS_SH: '1' }`. Unknown version: the older, safer form.

- [ ] **Step 1: Failing test** for the three cases. **Step 2:** FAIL. **Step 3:** implement; `rufloProjectInit` passes `installedVersion('ruflo')`.
- [ ] **Step 4: Removal proof** (the constraint's `sunsetWhen`): in a disposable home and empty folder, run `ruflo init --full --force --no-global --no-codex-detect` and, separately, `--no-skills-sh`, and both together, each through the public `ruflo` wrapper on 3.46.1; record that no `.codex/` projection and no skills.sh registration appear (compare `find . -newer marker` lists). Put the lists in the report.
- [ ] **Step 5: Commit** `feat(setup): drop the init opt-out suppression on Ruflo 3.46.0 and newer`. Registry in the same commit: `ruvnet/ruflo#3167` to `adopted` (history with the proof date), constraint `versionGate` to `apply to Ruflo below 3.46.0 (flags honoured from 3.46.0, PR #3434)`, `affected` widened to `["3.38.21", "3.39.x", "3.40.x", "3.41.x", "3.42.x", "3.43.x", "3.44.x", "3.45.x"]` in the form `affectedBy` accepts (check `src/lib/hook-audit/upstream.mjs` first), `lastVerifiedAt` bumped to today, `issueState` stays, `sunsetWhen` unchanged, `nextRetestAt` 14 days out per `recheckPolicy` (the date the floor reaches 3.46.0 cannot be known in advance).

### Task 3.3: #3415 governance enforced on stdio from 3.46.0

**Files:** Modify `src/lib/ruflo-components/snapshot.mjs:47-52`, `catalogue.mjs:19-22`, `policy.mjs:1-5`; Tests `tests/kit/ruflo-components-snapshot.test.mjs`, `ruflo-components-catalogue.test.mjs`.

- [ ] **Step 1: Failing tests** (through the snapshot builder the existing snapshot tests already call, since `governanceUnobservedReason` is module-private): with no audited calls, the `mcpGovernance` reason for Ruflo 3.45.0 includes the not-wired sentence (today it does not, because the boundary is 3.44.0), and for 3.46.0 it does not; the catalogue text for `mcpGovernance` says `Ruflo 3.46.0 and newer apply the policy on the stdio MCP launches; older versions do not`.
- [ ] **Step 2–4:** FAIL, change the boundary to `cmpVersions(rufloVersion, '3.46.0') < 0` and the texts, PASS.
- [ ] **Step 5: Live proof** in a disposable project on 3.46.1: write an ak policy with `maxToolCallsPerTurn: 2`, start `ruflo mcp start` with `RUFLO_MCP_ENFORCE_POLICY=1` and cwd = project root, send `initialize` and three `tools/call` for `memory_stats` over stdio (reuse `src/lib/mcp-tool-call.mjs`), and record that the third is refused and the audit log (`src/lib/ruflo-components/evidence.mjs` `AUDIT_LOG`, which is in `os.tmpdir()`: set `TMPDIR` to `$T/tmp`) records the calls. Then repeat from a subfolder with no `.harness/`: record that every call is refused. That is the Claude subfolder exposure; it stays open until Task 4.1 and is listed in the slice report.
- [ ] **Step 6: Commit** `fix(ruflo-components): governance is enforced on stdio from Ruflo 3.46.0`. Registry `ruvnet/ruflo#3415` to `adopted` in the same commit.

### Task 3.4: Keep ak's policy file out of git

**Files:** Modify `src/lib/ruflo-components/policy.mjs` (after a `written` result), `src/lib/ruflo-components/apply.mjs` (report it), `src/lib/trust-manifest.mjs:165-181` (disclose); Test `tests/kit/ruflo-components-convergence.test.mjs`.

**Interfaces:** `excludeFromGit(root, relative = '.harness/mcp-policy.json'): 'added'|'present'|'no-git'` appends one line under a `# agentic-kit` comment to the file `git rev-parse --git-path info/exclude` names. Git reads `info/exclude` from the common dir, so for a linked worktree follow the `.git` file's `gitdir:` and then that folder's `commondir` (gitrepository-layout); `<main>/.git/worktrees/<name>/info/exclude` is never read. Resolve without spawning git (read the two files); removal on `reconcilePolicy` `removed` deletes the same line.

- [ ] **Step 1: Failing tests:** in a temp repository (`git init`), and in a linked worktree of it (`git worktree add`, where the line must land in the main repository's `.git/info/exclude` and `git check-ignore .harness/mcp-policy.json` must succeed from the worktree), a `written` policy leaves `info/exclude` containing `.harness/mcp-policy.json` once after two reconciles; a `foreign` policy adds nothing; a non-repository returns `no-git`; `removed` deletes the line; `.gitignore` is never touched.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(ruflo-components): keep ak's MCP policy file out of git`.

### Task 3.5: #3166 and #3193 registry adoption

- [ ] Registry only, one commit each with the evidence line in `history`:
  - `ruvnet/ruflo#3166`: `mapping: "mapped"`, `kitImpact: { refs: ["no ak workaround; doctor row since 3.46.0 (PR #3441)"], files: [] }`, `adjustment: "none"`, `status: "retired"`. Note in the report: doctor's fix text `npm install -g agent-browser@latest` conflicts with ak's `>=0.27.0 <0.28.0` pin (investigation candidate). Commit `chore(upstream): retire ruvnet/ruflo#3166 (doctor reports agent-browser since 3.46.0)`.
  - `ruvnet/ruflo#3193`: history `{"event":"released","note":"PR #3420 in 3.46.0: the daemon parses config.yaml; memory settings in config.yaml are still not read (memory-initializer.js getMemoryRoot), so ak keeps the memory pin"}`, status stays `watching`. Commit `chore(upstream): record the partial #3193 fix shipped in Ruflo 3.46.0`.
- [ ] Run `node --test tests/kit/upstream-watch-registry.test.mjs tests/kit/upstream-watch-script.test.mjs` before each commit.

### Task 3.6: #2885 nightly note and the throwaway macOS job (B3-D3)

- [ ] Edit `.github/workflows/nightly.yml:80-85`: "tracked upstream at ruvnet/ruflo#2885 (open; Aug 31 triage points at better-sqlite3 with onnxruntime-node on macOS arm64; a local single-thread test on Sep 26 was inconclusive)". Keep `continue-on-error`. Commit `docs(ci): correct the nightly note for ruvnet/ruflo#2885`.
- [ ] Write, but do not commit or push, the probe workflow to `/Users/cphillipson/Development/active/ai/agentic-kit/.superpowers/sdd/2026-09-26-remediation-program/reports/b3-ruflo-2885-probe.yml` (the implementer works only on this branch; the controller creates `probe/ruflo-2885`, adds the file as `.github/workflows/ruflo-2885-probe.yml` and pushes under B3-D3): `on: push: branches: [probe/ruflo-2885]`, `runs-on: macos-26-arm64` (confirm the label in GitHub's runner-images list before use), a matrix `mitigation: [off, on]` times `run: [1..10]`, each installing the released Ruflo, running `ruflo memory search` against a seeded disposable store, recording the exit code (134 = abort), with the single-thread ONNX setting from our Sep 26 comment when `mitigation: on`. The controller pushes it under B3-D3, collects the 20 results, deletes the remote branch, and drafts any #2885 comment into the report only.

### Task 3.7: Slice 3 docs

- [ ] Check `docs/ddd/` for governance and security wording.
- [ ] ADR-0058: `Updated: <date>` with "Ruflo 3.46.0 enforces the policy on stdio (#3415); ak's boundary corrected from 3.44.0 to below 3.46.0; ak excludes its policy file from git". Update the §table line 101 wording.
- [ ] `docs/TROUBLESHOOTING.md` security section; `docs/HOST-SUPPORT.md` and `docs/SETUP.md` init flags.
- [ ] Commit `docs(adr): record governance on stdio and the security wording (ADR-0058)`.

---

## Slice 4: maintainer decisions B3-D1 and B3-D2

### Task 4.1: The launcher's Claude mode

**Files:** Modify `src/lib/ruflo-memory.mjs:103-138`, `src/commands/x/ruflo-mcp.mjs`, `src/lib/ruflo-mcp-transport.mjs:6`; Tests `tests/kit/ruflo-memory.test.mjs`, `tests/kit/ruflo-memory-location.test.mjs`, `tests/kit/codex-mcp.test.mjs` (transport recognition).

**Interfaces:**

- `rufloMcpLaunch(cwd, env, { cfg, rufloVersion, home, host = 'codex' })`. With `host: 'claude'` it returns `env: { ...env, ...managedAgentBrowserEnv({ enabled: cfg.agentBrowser !== false }), ...memoryEnv }`: ak's own agent-browser config stays (Claude's registration carries it today and `agentBrowserMcpConfigured`, `mcp.mjs:120-124`, checks it), but no `componentEnv` and no governance deletion (ADR-0058 §3: Claude receives component keys from its settings env). `cwd` is `location.root` in both modes.
- `ak x ruflo-mcp --host claude` parses the flag (`options = { host: { type: 'string' } }`), accepts only `claude` or `codex`, and exits 2 on anything else.
- `isRufloMcpTransport` accepts `['x','ruflo-mcp']` and `['x','ruflo-mcp','--host','claude']`.

- [ ] **Step 1: Failing tests:** (a) Claude mode keeps an inherited `RUFLO_INTELLIGENCE_MODE=fast` that `componentEnv` would override, still sets `AGENT_BROWSER_CONFIG` to ak's managed value, and sets `CLAUDE_FLOW_DB_PATH` to `<repo>/.swarm/memory.db` from a subfolder with `cwd` = repo root; (b) from `$HOME` it sets both memory variables to the user store; (c) Codex mode is unchanged; (d) transport recognition for the new args; (e) an unknown `--host` exits 2.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Subfolder governance regression** (closes the Task 3.3 exposure): with a fake `ruflo` on `PATH` in a sandbox (the existing `fakeGlobalRoot` helpers), assert `ak x ruflo-mcp --host claude` started from `<repo>/sub/dir` spawns with `cwd === <repo>` so `<repo>/.harness/mcp-policy.json` is the file Ruflo reads.
- [ ] **Step 6: Commit** `feat(ruflo-mcp): a Claude mode that pins only the memory location`.

### Task 4.2: Register Claude's Ruflo MCP through the launcher

**Files:** Modify `src/lib/mcp.mjs:126-137,539-567` (desired entry `{ command: 'ak', args: ['x','ruflo-mcp','--host','claude'], env: managedAgentBrowserEnv(...) }`, keeping the `-e AGENT_BROWSER_CONFIG=…` registration so `agentBrowserMcpConfigured` stays true; `src/lib/execution/claude.mjs:19` gets the same `--host claude` args; ak's old `ruflo mcp start` user entry with only `AGENT_BROWSER_CONFIG` becomes `replaceable`; a user-written entry stays `preserved`), `src/lib/adapters/registries.mjs:258` (value), `src/commands/status/sections/mcp.mjs` (row names the store the launcher picks from the current folder, using `rufloMemoryLocation`), `src/commands/status/sections/project-memory.mjs:157-159` and `user-memory.mjs` (drop "Claude's own Ruflo registration is unchanged"; say "Claude Code's and Codex's Ruflo launcher"); Tests `tests/kit/mcp-scopes.test.mjs`, `tests/kit/adapter-registries.test.mjs`, `tests/kit/project-memory-status.test.mjs`.

- [ ] **Step 1: Failing tests:** `register()` with a topology holding ak's old entry removes it and adds `claude mcp add claude-flow -s user -- ak x ruflo-mcp --host claude` (assert the runner calls); an already-desired entry makes no calls; a user entry with an extra env key is preserved and `ok: false`; a failed add restores the removed entries (existing pattern); the status row reads ``Claude Code's Ruflo MCP starts through `ak x ruflo-mcp`; from here it uses <store>``.
- [ ] **Step 2–4:** FAIL, implement, PASS. Also check `ak` resolves on `PATH`: when `which ak` fails, `register()` returns `{ ok: false, reason: 'ak-not-on-path' }` and status says so (Codex already depends on the same).
- [ ] **Step 5: Disposable proof, recorded not asserted in unit tests:** in a sandbox home, register with the real `claude mcp add` if Claude Code is installed, start `claude` headless in a subfolder of a disposable repository with `--mcp-config` pointing at the same entry (the pattern in `src/lib/execution/claude.mjs:19`), call `memory_store`, and record which `agentdb-memory.db` received the row and the MCP server's cwd (`ps -o command,cwd`). This settles the assumption that Claude Code starts user-scope stdio servers in the session folder; if it does not, report it before continuing.
- [ ] **Step 6: Commit** `feat(mcp): route Claude Code's Ruflo MCP through ak x ruflo-mcp`.

### Task 4.3: Claude-side harvest and setup follow the same store rule

**Files:** Modify `src/lib/harvest.mjs` (take `rufloMemoryLocation(cwd)` and use its `root`, `dir` and `db` directly; for `kind === 'user'` pin `CLAUDE_FLOW_MEMORY_PATH=dir` and `CLAUDE_FLOW_DB_PATH=db`, and pass `--db <db>` to distill; do not call `paths.projectMemoryDb(root)`, which would give `~/.claude-flow/memory/.swarm/memory.db` while the user store is flat, `ruflo-memory.mjs:86`), `src/lib/ruflo-memory.mjs:88-100` (leave `memoryProjectRoot` unchanged: `daemons.mjs:20` and `projectMemoryEnv` rely on it; update its comment to say harvest no longer uses it), `src/commands/setup.mjs` (project setup from an unsuitable folder refuses with `this folder is <reason>; run ak setup from a project folder`); Tests `tests/kit/ruflo-memory.test.mjs`, `tests/kit/harvest*.test.mjs` (the file that covers `planHarvest`), `tests/kit/setup-command.test.mjs`.

- [ ] **Step 1: Failing tests:** `runHarvest` from `$HOME` with a spy runner uses `cwd` = `paths.userMemoryDir(home)`, env `CLAUDE_FLOW_DB_PATH` = `<userMemoryDir>/memory.db` (flat, no `.swarm`) and `CLAUDE_FLOW_MEMORY_PATH` = `<userMemoryDir>`; from a repository subfolder it still uses `<repo>/.swarm/memory.db`; the daemons row for `$HOME` is unchanged; project setup from `$HOME` refuses without spawning anything.
- [ ] **Step 2–4:** FAIL, implement, PASS; run `node --test tests/kit/ruflo-memory*.test.mjs tests/kit/setup-*.test.mjs`.
- [ ] **Step 5: Commit** `fix(memory): Claude-side harvest and setup use the user-level store outside projects`.

### Task 4.4: One-time cleanup of old setup probe rows (B3-D2)

**Files:** Create `src/lib/memory-probe-cleanup.mjs`; Modify `src/commands/sync.mjs` (a `memory-probe-cleanup` step, planned when a `memory` row with `repair: 'sync'` names probe rows), `src/commands/status/sections/project-memory.mjs` and `user-memory.mjs` (row), `src/lib/project-memory.mjs` (reuse `withDb`, `lookupEntry`); Test `tests/kit/memory-probe-cleanup.test.mjs` (new).

**Interfaces:**

- `PROBE = { namespace: '_setup', key: /^_setup\/verify-\d+-\d+$/, content: 'setup-verify' }`.
- `findProbeRows(dir): Array<{ file, rows: Array<{ id, key, status }> }>` over `memory.db` and `agentdb-memory.db` in `dir`, read-only, any `status`.
- `cleanupProbeRows(dirs, { dryRun, backupRoot, now }): { receipt: { at, stores: Array<{ file, backup, deleted: string[] }> } }`: for each store with rows, first `VACUUM INTO '<backupRoot>/<ISO>/<basename-of-dir>-<file>'`, then `DELETE FROM memory_entries WHERE id IN (...)` for exactly the matched ids, then `PRAGMA wal_checkpoint(TRUNCATE)`; receipt written to `<state>/agentic-kit/memory-probe-cleanup/<ISO>.json`; `kit.json` `cleanups.setupProbeRows[<resolved file>] = <ISO>` so a store is cleaned at most once.
- Scope: the current project's canonical `.swarm` (from `rufloMemoryLocation`) and the user-level store. Other projects are named in the report only.

- [ ] **Step 1: Failing tests** (build both stores with the schema columns seen on 3.46.1: `id key namespace content type … status`):
  - Rows `_setup/verify-12-1700000000000` / `setup-verify` in both files, plus decoys `_setup/verify-x` (wrong key), `_setup/verify-1-2` with content `other`, and a user row in namespace `_setup` with key `_setup/verify-3-4` but namespace `mine`: only the two exact rows are deleted.
  - `dryRun` deletes nothing and returns the same plan.
  - The backup file exists and opens with the rows still in it; the receipt lists them.
  - A second run finds nothing and writes no second receipt; the status row disappears.
  - A store Ruflo holds open with WAL: the delete still succeeds (use a second connection kept open in the test).
  - After the delete, `PRAGMA foreign_key_check` and `PRAGMA quick_check` are clean on a fixture that also has rows in the AgentDB tables (the 3.46.1 disposable store gained rows only in `memory_entries`, but a populated store may link other tables).
- [ ] **Step 2–4:** FAIL, implement, PASS. Status row: `info` when none, `warn` `N old ak setup probe rows in <file> (and its AgentDB mirror, ruvnet/ruflo#3450)` with fix `sync backs up the store and removes exactly those rows` and `repair: 'sync'`.
- [ ] **Step 5: Disposable proof on 3.46.1:** create the rows with Ruflo's own `memory store` as in the verification table, run `node bin/agentic-kit.mjs sync --dry-run` then `sync` in the sandbox, and record before and after counts in both files.
- [ ] **Step 6: Real-data preview (read-only):** `node bin/agentic-kit.mjs sync --dry-run` from this repository. Today's read found 0 rows in `.swarm/memory.db` and `.swarm/agentdb-memory.db`; report the preview's count for the user-level store too. Do not run the real cleanup; that is the controller's real-data pass.
- [ ] **Step 7: Commit** `feat(sync): remove ak's old setup probe rows once, with a backup and receipt`.

### Task 4.5: Decisions B3-D1 to B3-D4 in the audit record, and slice docs

- [ ] Append to the audit record a section `### Branch 3 decisions (2026-09-27)` with four entries in the record's decision format (**The situation.** / **The problem.** / **What the user sees.** / **What should be the case.** / **The choices.** / **Recommendation … Choice: …**), taken from the ledger lines for B3-D1, B3-D2, B3-D3 and B3-D4 (D4 recorded as superseded: the machine already runs 3.46.1; no upgrade step). Add the implementation commits under each.
- [ ] Check `docs/ddd/` for the MCP registration and memory-location wording.
- [ ] ADR-0058 §3 `Updated`: Claude Code now reaches Ruflo through `ak x ruflo-mcp --host claude`, which sets only the memory location; component keys still come from Claude's settings env. ADR-0016 one-line note on the registration change.
- [ ] `docs/HOST-SUPPORT.md`, `docs/SETUP.md`, `docs/UPGRADING.md` (the registration migrates on the next `ak sync`), `docs/TROUBLESHOOTING.md` (probe-row cleanup), `ak x ruflo-mcp --help`.
- [ ] Commit `docs(audit): record Branch 3 decisions and the Claude launcher route`.

---

## Gate (after every slice, run by the gate agent)

Run the full gate set from the common brief (`briefs/common.md` "Gate set"), including the fingerprint before and after, `npm pack --dry-run | grep -E 'ruflo-support-window|ruflo-daemon-config|memory-probe-cleanup'` once those files exist, and `node --test tests/kit/doc-citations.test.mjs tests/kit/ga-surface-guard.test.mjs`. Record pass/fail counts, coverage and the fingerprint diff verbatim in the slice report.

## Self-review notes

- Every scope item has a task: 1 → 1.1–1.3, 1.6; 2 → 2.1; 3 → 2.2–2.4; 4 → 3.1; 5 → 1.4; 6 → 1.5; 7 → 3.2, 3.3, 3.5; 8 → 3.4, 3.6; D1 → 4.1–4.3; D2 → 4.4; decisions → 4.5.
- Names used across tasks: `computeSupportWindow`, `rememberedSupportWindow`, `recordRufloReleaseDates` (1.2, 1.3); `desiredDaemonKeys`, `reconcileRufloDaemon` (2.2, 2.1's fix text); `rufloMcpLaunch(..., { host })` (4.1, 4.2); `findProbeRows`, `cleanupProbeRows` (4.4).
- Review Focus lines map to tests in 2.2 (two lines), 3.3/4.1, 1.2 and 3.1.
