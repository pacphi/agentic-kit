# Branch 2: Test Hermeticity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for `pnpm test` and `pnpm run test:ui` to change real user state without failing, and remove every known way the suite does it today.

**Architecture:** A cross-platform fingerprint library and a suite runner (both in `scripts/`) snapshot the real state directories before and after the existing test commands and fail, naming each changed path, when anything changed. The dashboard server refuses its real-state-writing defaults when a caller injected fakes. Shared test helpers give every spawned child and every in-process spawn a sandboxed environment and self-cleaning temporary folders; three UI checks become deterministic.

**Tech Stack:** Node 22.13+ ESM (`node:test`, `node:child_process`, `node:crypto`), Playwright (`tests/ui`), pnpm in CI (never in this worktree).

**Spec:** [Remediation program, Branch 2](2026-09-26-remediation-program.md#branch-2-fixtest-hermeticity); [audit record](../../audits/2026-09-26-issues-237-238-239-verification-and-decisions.md) Open items ("Needs the maintainer's action": the dashboard server's hermeticity guard gap; "Carried from the earlier stages": spawn tests inheriting `XDG_*`, UI suite outside `test:ui`; "Not run": the memory-routing live test uses the real home folder); SDD ledger deferred minors `hermeticity-suite-writes-enclosing-repo`, `hermeticity-temp-dir-leaks`, the `host-readiness.mjs` flake and the MNT-UX-007 flake.

## Global Constraints

- Commits carry no `Co-Authored-By` or other attribution trailer, and no trailer-like last line.
- Nothing is pushed, opened as a pull request, merged or posted without the maintainer's explicit go-ahead.
- Never run `pnpm` in this worktree (`node_modules` is a symlink). Use `node --test`, `npx tsc -p tsconfig.json`, `npx eslint`, `npx markdownlint-cli2`, `node scripts/build-check.mjs`.
- Stage files by name; never `git add -A`/`git add .`; never commit `.harness/`, `.swarm/`, `.claude-flow/`, `.agentic-qe/`.
- Disposable environments use `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME` (or `env -i`) and a `mktemp -d <template>` inside the scratch area; assert every created path lies inside it.
- Tests never write real user state: not the repository's `.claude`/`.swarm`, not `~/.config/agentic-kit`, not `~/.local/state/agentic-kit`, not any real memory store.
- Runtime assets live under `src/`; test tooling lives in `scripts/` or `tests/` (neither ships; `scripts/**/*.mjs` is type-checked by `tsconfig.json`).
- CI runs `pnpm test` on ubuntu, macOS and windows-latest with Node 22/24/26 and `pnpm run test:ui` on ubuntu Node 22 (`.github/workflows/ci.yml`). Everything here must work on Node 22.13 (no `--test-global-setup`: absent from `node --help` on 22.22.3) and on Windows paths.
- User-facing docs describe the current state only; an ADR a change alters gets Status, an `Updated` date and a one-line note.

## Verification of the scope against the code (done while writing this plan, at `be1c1d47`)

| # | Program-plan item | Verdict and evidence |
|---|---|---|
| 1 | Suite-wide real-state tripwire | **Confirmed missing.** Only per-file guards exist: `guardRealRepository()` watches seven repo files (`tests/kit/helpers/project-isolation.mjs:28-36`) and `assertUnchanged()` snapshots one tree. Nothing watches `~/.config/agentic-kit`, `~/.local/state/agentic-kit`, `%APPDATA%`/`%LOCALAPPDATA%` or the repo's `.swarm`/`.agentic-qe`/`.claude-flow`/`.harness`. `node --test` runs files in parallel child processes, so a "first/last test file" cannot order around the others; `--test-global-setup` is missing on Node 22.22.3. A wrapper runner is the only design that works on 22.13+. |
| 2 | Dashboard refuses defaults when fakes are injected | **Confirmed.** `managementProvider` (`src/lib/dashboard-server.mjs:992-1015`) throws only when `maintenance` is injected without a control root. With only `system` (or `fetchStatus`, `usage`, …) injected, `provideMaintenance` (`:1121-1128`) builds the default service over the real control root, and `refreshMaintenanceAfterSystem` (`:1172-1187`) runs it after every successful `?refresh=deep`. Commit `259f075` fixed the test that did this, not the product. `refreshMaintenanceAfterSystem` swallows errors (`.catch(() => null)`), so a refusal on that path must be logged to be visible. The real command (`src/commands/x/dashboard.mjs:90-94`) passes only `port`, `cwd`, `liveOptions`, so a guard keyed on injected collectors never touches it. |
| 3 | Spawn tests inherit the developer's `XDG_*` | **Confirmed.** The maintainer's shell exports all four `XDG_*` bases. `provider-cli`, `usage-cli`, `host-cli-migration`, `provider-refresh-cli`, `dry-run-nudge`, `prompts-mainline-boundary`, `hook-audit`, `cli-help` and others spread `...process.env` and pin only `HOME`/`XDG_CONFIG_HOME`/`APPDATA` (some also `XDG_DATA_HOME`); `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `LOCALAPPDATA` and `TMPDIR` pass through. 22 `...process.env` sites in `tests/kit` and `tests/*.cjs`. |
| 4 | Six tests create `$XDG_STATE_HOME/opencode` | **Confirmed, and wider.** Per-file probe (each of the 338 `tests/kit` files alone, with `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `LOCALAPPDATA`, `TMPDIR` redirected): exactly six files create `state/opencode`, **and** `cache/opencode/bin`, `data/opencode/{repos,log}` and `$TMPDIR/opencode` — the real OpenCode's own directories on a developer machine. Direct spawns: `opencode-stock-ruflo-gateway`, `provider-cli`, `provider-refresh-cli`. In-process (the test calls `src/lib/providers.mjs`/`adapters/lifecycle.mjs`, which spawn `opencode` with `process.env`): `integration-command-facts`, `opencode`, `provider-credentials`. |
| 5 | "Create temporary folders from a template — macOS `mktemp -d` ignores `TMPDIR`" | **Wrong as stated for the tests.** No test, script or template shells out to `mktemp` (`grep -rn mktemp tests scripts src/templates .github` is empty); all 188 test files that make temp folders use `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`, which honours `TMPDIR`. The `mktemp` gotcha applies to shell sessions (the brief's disposable-env line), not the suite. The real defect behind it is the temp-folder leak: reframed below as "the suite runs inside its own templated temp root and fails on leftovers". |
| 5b | Deferred minor `hermeticity-temp-dir-leaks` (~20 files) | **Confirmed, 59 files, not ~20** (table below). |
| 5c | Deferred minor `hermeticity-suite-writes-enclosing-repo` | **Confirmed by the Branch 0 review** (reports `review-hermeticity.md:122-132`, `refute-hermeticity.md:184-202`): `aqe-embedding-projection.test.mjs:200-222` deletes the fixture's `.git`, so `repoRoot()` (`src/lib/paths.mjs:206-215`) climbs to an enclosing repository; `status-aqe-drift.test.mjs:98` does the same with a `.git`-less temp dir; `opencode-stock-ruflo-gateway.test.mjs` runs real OpenCode from a `.git`-less workspace and OpenCode edited the enclosing repo's `package.json`, created `package-lock.json` and replaced the `node_modules` symlink. Only happens when `TMPDIR` is inside a git repository. |
| 6 | `tests/ui/maintenance-focus.mjs` "polyglot cards…" fails | **Test is stale; product is right.** Two causes, reproduced in headless Chrome: (a) the harness stubs `mntKindLabel`, `mntFacetValueLabel`, `mntIcon`, `mntAvailableTo` but not `mntProjectKindBadge`, which moved to `src/lib/dashboard/client/maintenance-cards.mjs:31`; the page throws `mntProjectKindBadge is not defined` and renders nothing (0 icons); (b) the test expects three icons plus a "+2 more languages" disclosure, which DDD-09 removed: `docs/LANGUAGE-LOGOS.md:11-12` ("there is no three-icon cap or additional-language disclosure"), `docs/MAINTENANCE.md:766`, and the unit test `tests/kit/maintenance-focus-client.test.mjs:44-46` (asserts all icons and no `mnt-language-more`). The file's other test passes; `tests/ui/maintenance-guidance.mjs` (also outside `test:ui`) passes. Both write screenshots to `/tmp`. |
| 7 | Memory-routing live test uses the real home | **Confirmed.** `tests/live/ruflo-memory-routing.test.mjs:24-30` makes a `.git`-less temp project and runs `ruflo` through `run()`, which merges `process.env` (`src/lib/exec.mjs:211`): real `HOME` and `XDG_*`; `rufloMcpLaunch` reads the real `kit.json` and `paths.home`. `tests/live/disposable-memory-project.mjs` already provides a `git init`-ed, daemon-off disposable project. |
| F1 | `host-readiness.mjs` dialog-title flake | **Mechanism found.** The dialog's `close` event is a queued task; its handler (`src/lib/dashboard/client/host-readiness.mjs:169`) focuses the badge of the *current* `HEALTH_HOST`. The test presses Escape, focuses the next badge, presses Enter; if the queued `close` runs after the new focus, focus jumps back to the previous badge and Enter reopens it: "Claude Code health" where "Codex health" was expected (`fix-wave-2.md:171`). |
| F2 | MNT-UX-007 flake | **Mechanism found.** After "Clear all" the test waits only for the chips to vanish (`tests/ui/dashboard-ui.mjs:2397-2398`), which happens synchronously, while the inventory query is still in flight (`mntRunInventoryQuery`, `src/lib/dashboard/client/maintenance-inventory.mjs:47-78`). When the response lands after the test focused row 0, `renderMntInventory()` replaces the list: tabindexes reset, focus is lost, and the before/after arrays are equal. `#mnt-results` carries no busy marker (`mntBusy` sets `aria-busy` on `#sys-maintenance` only). |

### Temp-folder leak table (per-file probe, each file alone with a fresh `TMPDIR`; `node-compile-cache` ignored)

about-install-edits 1 · adapter-grants 35 · agentdb-retirement 2 · blocks-drift-parity 2 · brain-held-refresh 1 · claude-window-ledger 12 · codex-mcp-convergence 2 · codex-plugins 1 (`outside-*`) · codex-state 7 · conformance-tiers 34 · dashboard-intel-integration 5 · drift-freshness 2 · heal-natives 2 · helper-stamp 25 · host-adapters-cli 75 · host-alignment 3 · host-cli-migration 30 · hosts 1 · integration-command-facts 1 (`opencode`) · intel-history 39 · intelligence-watch 10 · live-core 11 · live-qe-contract 1 · live-service 25 · live-tailer 3 · live-transcript 9 · maintenance-host-alignment 2 · maintenance-management-activity 1 · nudge 5 · opencode-stock-ruflo-gateway 1 (`opencode`) · opencode 1 (`opencode`) · project-census 13 · provider-cli 1 (`opencode`) · provider-credentials 1 (`opencode`) · provider-refresh-cli 1 (`opencode`) · providers-drift-parity 2 · quota 36 · reverse-bridge 8 · routing-retirement-convergence 1 · ruflo-components-convergence 1 · ruvnet-brain 7 · status-aqe-drift 9 · status-golden 2 · status-repair-contract 2 · statusline-config-dir-parity 1 · statusline 12 + `ruflo-daemon-count.json` + `ruvnet-brain-kb-size.json` · sync-host-repair 1 · sync-needs-your-action 2 · sync-self-freshness 1 · system-summary 2 · usage-claude-dedup 1 · usage-cli 2 · usage-codex-attribution 8 · usage-codex-large-rollout 13 · usage-deps-contract 1 · usage-index-v6 9 · usage-index 72 · usage-truncation 7 · verify-memory-routes 2.

`statusline`'s two JSON files are the live statusline's shared 30-second caches (`src/lib/daemons.mjs:276`, `src/templates/statusline-footer.cjs:423,501`): a test run poisons the developer's real footer.

### Probe side findings the implementers must respect

- `aqe-lifecycle-migration.test.mjs` fails ("owner or parent drift", `src/lib/hook-remediation/engine.mjs:344`) when `TMPDIR` is under `/private/tmp` (group `wheel`), and passes under the default `/var/folders/…/T` and under a user-owned sibling folder. Keep every temp root under `os.tmpdir()`; never relocate it to `/tmp`.
- `footprint-projects.test.mjs` fails when `TMPDIR`'s path contains a Claude-encoded-directory look-alike (`-Users-…`); it passes under `/var/folders/…/T/ak-suite-XXXXXX`-style paths. The suite temp root name must not contain such a segment.
- The fingerprint diff for this probe (brief's `fingerprint.sh`, before/after) was empty; the worktree's `git status --ignored` shows only `node_modules`.

## Review Focus

- **The maintainer's live sessions write the watched folders during a run.** The Claude Code statusline tee rewrites `claude-rate-limits.json` and `claude-context-windows/` in `~/.config/agentic-kit` on every render (`src/templates/statusline-footer.cjs:52-131`); Ruflo/AQE hooks churn the main checkout's `.swarm`, `.agentic-qe`, `.claude-flow`. Expected: a developer run does not fail on those, but still prints them under a separate heading; CI (no live session) is strict. Pinned in Task 1.1 (exclusion tests) and Task 1.2 (CI-strict test).
- **Windows.** `%APPDATA%\agentic-kit`, `%LOCALAPPDATA%\agentic-kit`, `~\AppData\…` fall-backs, case-insensitive duplicates, and a file locked by another process (`EBUSY`). Expected: roots resolve with `path.win32`, duplicates collapse, a locked file is recorded, not thrown. Pinned in Task 1.1 (win32 root tests, unreadable-file test).
- **A suite that fails before the tripwire compares.** Expected: the runner still takes the after-snapshot and prints changed paths even when a test command fails, and the exit code reflects the test failure. Pinned in Task 1.2.
- **A new spawn test that copies `...process.env`.** Expected: the static guard fails naming the file and line. Pinned in Task 2.1.
- **A temp root that sits inside a git repository.** Expected: the runner refuses to start with a message naming the enclosing repository, and "outside a git repository" tests skip with a reason instead of writing into it. Pinned in Tasks 2.4 and 2.5.

## Slices and interfaces

Three implementers run in sequence; each sees only its own slice. The names below are the contract between slices.

**Slice 1 produces:**

- `scripts/real-state-tripwire.mjs`
  - `export const REPO_STATE_DIRS: string[]` = `['.claude', '.swarm', '.agentic-qe', '.claude-flow', '.harness']`
  - `export function realStateRoots({ env, platform, homedir, repoRoot }): Array<{ kind: 'config'|'state'|'repo'|'user-file', dir: string, label: string }>`
  - `export function snapshotRoots(roots): Map<string, Entry>` where `Entry = { root: Root, rel: string, type: 'file'|'dir'|'link'|'absent-root'|'unreadable', size?: number, sha256?: string, target?: string, code?: string }`
  - `export function compareSnapshots(before, after, { strict }): { failing: Change[], concurrent: Change[] }` where `Change = { op: '+'|'-'|'~', path: string, rel: string, kind: string, before?: Entry, after?: Entry, writer?: string }`
  - `export function isStrict(env): boolean`
  - `export function formatReport(result): string`
  - CLI: `node scripts/real-state-tripwire.mjs snapshot <out.json> [--repo <dir>]` and `node scripts/real-state-tripwire.mjs compare <before.json> [--repo <dir>]` (exit 3 on a failing change).
- `scripts/run-tests.mjs`
  - `export const SUITES: { unit: string[][], ui: string[][] }` (argument vectors for `process.execPath`)
  - `export function runGuarded(commands, { env, repoRoot, platform, homedir, log }?): number` (exit code)
  - CLI: `node scripts/run-tests.mjs unit|ui` and `node scripts/run-tests.mjs exec [--repo <dir>] -- <node args…>`
  - `package.json`: `"test": "node scripts/run-tests.mjs unit"`, `"test:ui": "node scripts/run-tests.mjs ui"`.

**Slice 2 consumes** `runGuarded`/`SUITES` (adds the suite temp root to `runGuarded`) and **produces**, in `tests/kit/helpers/home-sandbox.mjs` (builtins only):

- `export const INHERITED_STATE_KEYS: string[]`
- `export function sandboxEnvFor(home): Record<string, string>`
- `export function spawnEnv(home, extra = {}): Record<string, string|undefined>`
- `export function redirectToolState(prefix): { base: string, restore: () => void }`

and `tests/kit/helpers/temp-dir.mjs`: `export function tempDir(prefix, t?): string`.

**Slice 3 consumes** `SUITES.ui` (adds two files) and changes product client code only in `host-readiness.mjs` and `maintenance-inventory.mjs`.

---

## Slice 1 — tripwire and dashboard guard

### Task 1.1: Cross-platform real-state fingerprint library

**Files:**

- Create: `scripts/real-state-tripwire.mjs`
- Test: `tests/kit/real-state-tripwire.test.mjs`

**Interfaces:**

- Consumes: nothing (must not import anything from `src/`; `src/lib/paths.mjs` snapshots `os.homedir()` at module scope).
- Produces: `REPO_STATE_DIRS`, `realStateRoots`, `snapshotRoots`, `compareSnapshots`, `isStrict`, `formatReport`, `CONCURRENT_WRITERS`, and the CLI above.

- [ ] **Step 1: Write the failing test**

```js
// tests/kit/real-state-tripwire.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REPO_STATE_DIRS, realStateRoots, snapshotRoots, compareSnapshots, isStrict, formatReport,
} from '../../scripts/real-state-tripwire.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'real-state-tripwire.mjs');
const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('POSIX roots: XDG bases, their defaults, the repo state folders and ak-owned user files', () => {
  const roots = realStateRoots({
    platform: 'linux', homedir: '/home/dev', repoRoot: '/src/kit',
    env: { XDG_CONFIG_HOME: '/x/cfg', XDG_STATE_HOME: '/x/state' },
  });
  const dirs = roots.map((r) => `${r.kind}:${r.dir}`);
  for (const want of [
    'config:/x/cfg/agentic-kit', 'config:/home/dev/.config/agentic-kit',
    'state:/x/state/agentic-kit', 'state:/home/dev/.local/state/agentic-kit',
    ...REPO_STATE_DIRS.map((d) => `repo:/src/kit/${d}`),
    'user-file:/home/dev/.claude/CLAUDE.md', 'user-file:/home/dev/.codex/AGENTS.md',
    'user-file:/x/cfg/opencode/AGENTS.md',
  ]) assert.ok(dirs.includes(want), `missing ${want} in ${dirs.join(', ')}`);
});

test('Windows roots use APPDATA/LOCALAPPDATA and collapse case-insensitive duplicates', () => {
  const roots = realStateRoots({
    platform: 'win32', homedir: 'C:\\Users\\dev', repoRoot: 'C:\\src\\kit',
    env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming', LOCALAPPDATA: 'c:\\users\\DEV\\appdata\\local' },
  });
  const dirs = roots.map((r) => `${r.kind}:${r.dir}`);
  assert.ok(dirs.includes('config:C:\\Users\\dev\\AppData\\Roaming\\agentic-kit'));
  assert.ok(dirs.includes('state:c:\\users\\DEV\\appdata\\local\\agentic-kit'));
  assert.equal(dirs.filter((d) => d.toLowerCase() === 'state:c:\\users\\dev\\appdata\\local\\agentic-kit').length, 1,
    'the LOCALAPPDATA root and the ~\\AppData\\Local fallback are one folder on Windows');
  assert.ok(dirs.includes('repo:C:\\src\\kit\\.claude'));
});

test('a created, removed or rewritten file is failing; an mtime-only touch is not', (t) => {
  const home = tmp(t, 'ak-trip');
  const cfg = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'kit.json'), '{}');
  fs.writeFileSync(path.join(cfg, 'gone.json'), '1');
  fs.writeFileSync(path.join(cfg, 'touched.json'), 'same');
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: path.join(home, 'repo'), env: {} });
  const before = snapshotRoots(roots);
  fs.writeFileSync(path.join(cfg, 'kit.json'), '{"changed":true}');
  fs.rmSync(path.join(cfg, 'gone.json'));
  fs.writeFileSync(path.join(cfg, 'new.json'), 'x');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(cfg, 'touched.json'), future, future);
  const { failing } = compareSnapshots(before, snapshotRoots(roots), { strict: true });
  assert.deepEqual(failing.map((c) => `${c.op} ${c.rel}`).sort(), ['+ new.json', '- gone.json', '~ kit.json']);
  const report = formatReport({ failing, concurrent: [] });
  assert.match(report, /3 path\(s\) changed/);
  assert.ok(report.includes(path.join(cfg, 'kit.json')), 'the report names the absolute path');
});

test('an empty folder a tool creates is a change (the opencode/ case)', (t) => {
  const home = tmp(t, 'ak-trip-dir');
  const state = path.join(home, '.local', 'state', 'agentic-kit');
  fs.mkdirSync(state, { recursive: true });
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: path.join(home, 'repo'), env: {} });
  const before = snapshotRoots(roots);
  fs.mkdirSync(path.join(state, 'maintenance'));
  const { failing } = compareSnapshots(before, snapshotRoots(roots), { strict: true });
  assert.deepEqual(failing.map((c) => `${c.op} ${c.rel}`), ['+ maintenance/']);
});

test('developer mode moves live-session writers to "concurrent"; strict mode fails them', (t) => {
  const home = tmp(t, 'ak-trip-conc');
  const repo = path.join(home, 'repo');
  const cfg = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(path.join(cfg, 'claude-context-windows'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.agentic-qe'), { recursive: true });
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: repo, env: {} });
  const before = snapshotRoots(roots);
  fs.writeFileSync(path.join(cfg, 'claude-rate-limits.json'), '{}');
  fs.writeFileSync(path.join(cfg, 'claude-context-windows', 's1.json'), '[]');
  fs.writeFileSync(path.join(repo, '.swarm', 'memory.db-wal'), 'x');
  fs.writeFileSync(path.join(repo, '.agentic-qe', 'llm-config.json'), '{}');
  const after = snapshotRoots(roots);
  const dev = compareSnapshots(before, after, { strict: false });
  assert.deepEqual(dev.failing.map((c) => c.rel), ['.agentic-qe/llm-config.json'],
    'ak-owned files inside hook-churned folders stay failing');
  assert.deepEqual(dev.concurrent.map((c) => c.rel).sort(),
    ['.swarm/memory.db-wal', 'claude-context-windows/s1.json', 'claude-rate-limits.json']);
  const strict = compareSnapshots(before, after, { strict: true });
  assert.equal(strict.concurrent.length, 0);
  assert.ok(strict.failing.some((c) => c.rel === 'claude-rate-limits.json'));
  assert.match(formatReport(dev), /concurrent writers \(not failing\)/);
});

test('CI and AK_TRIPWIRE_STRICT make the comparison strict', () => {
  assert.equal(isStrict({ CI: 'true' }), true);
  assert.equal(isStrict({ CI: '1' }), true);
  assert.equal(isStrict({ AK_TRIPWIRE_STRICT: '1' }), true);
  assert.equal(isStrict({}), false);
  assert.equal(isStrict({ CI: 'false' }), false);
});

test('an unreadable file is recorded, never thrown, and compares equal to itself', { skip: process.platform === 'win32' && 'chmod 000 does not deny reads on Windows' }, (t) => {
  const home = tmp(t, 'ak-trip-unread');
  const cfg = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfg, { recursive: true });
  const locked = path.join(cfg, 'locked.json');
  fs.writeFileSync(locked, 'secret');
  fs.chmodSync(locked, 0o000); // the folder stays writable, so the tmp cleanup still removes it
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: path.join(home, 'repo'), env: {} });
  const a = snapshotRoots(roots);
  const entry = [...a.values()].find((e) => e.rel === 'locked.json');
  if (process.getuid && process.getuid() === 0) return; // root reads anything
  assert.equal(entry.type, 'unreadable');
  assert.deepEqual(compareSnapshots(a, snapshotRoots(roots), { strict: true }).failing, []);
});

test('the CLI snapshot/compare pair exits 3 and names the changed path', (t) => {
  const home = tmp(t, 'ak-trip-cli');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CI: 'true',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  const out = path.join(home, 'before.json');
  const snap = spawnSync(process.execPath, [CLI, 'snapshot', out, '--repo', repo], { env, encoding: 'utf8' });
  assert.equal(snap.status, 0, snap.stderr);
  fs.mkdirSync(path.join(home, '.local', 'state', 'agentic-kit'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'state', 'agentic-kit', 'install-edits.json'), '{}');
  const cmp = spawnSync(process.execPath, [CLI, 'compare', out, '--repo', repo], { env, encoding: 'utf8' });
  assert.equal(cmp.status, 3, cmp.stdout + cmp.stderr);
  assert.match(cmp.stderr, /install-edits\.json/);
});
```

The developer-mode case has three concurrent changes because `claude-context-windows/` and `.swarm/` existed before the snapshot; only the new files appear.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/kit/real-state-tripwire.test.mjs`
Expected: FAIL — `Cannot find module …/scripts/real-state-tripwire.mjs`.

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
// scripts/real-state-tripwire.mjs
// Real-state tripwire: fingerprints every folder a test could write on the
// developer's machine and names each path that changed. Four incidents wrote
// real state (statusline version + env pins in the repo's .claude, the
// maintenance state, a heal receipt); this turns the next one into a failure.
// Imports only builtins: src/lib/paths.mjs snapshots os.homedir() at module
// scope and must never be loaded here. Node 22.13+.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_STATE_DIRS = ['.claude', '.swarm', '.agentic-qe', '.claude-flow', '.harness'];

/** Writers a live Claude Code / Ruflo / AQE session runs concurrently with a
 *  developer's test run. Excluded from failure only outside strict mode, and
 *  always printed. Each entry names the source that proves the writer. */
export const CONCURRENT_WRITERS = [
  { kind: 'config', pattern: /^claude-rate-limits\.json(\.[^/]*)?$/, writer: 'Claude Code statusline tee (src/templates/statusline-footer.cjs:52-66)' },
  { kind: 'config', pattern: /^claude-context-windows(\/|$)/, writer: 'Claude Code statusline context ledger (src/templates/statusline-footer.cjs:77-131)' },
  { kind: 'state', pattern: /^statusline-debug\.log$/, writer: 'statusline debug log (src/templates/statusline-footer.cjs:2-15)' },
  { kind: 'repo', pattern: /^\.swarm(\/|$)/, writer: 'Ruflo hooks and daemon of a live session' },
  { kind: 'repo', pattern: /^\.agentic-qe\/(?!llm-config\.json)/, writer: 'AQE hooks of a live session' },
  { kind: 'repo', pattern: /^\.claude-flow\/(?!config\.json$)/, writer: 'Ruflo hooks and statusline caches of a live session' },
];

export function isStrict(env = process.env) {
  return env.CI === 'true' || env.CI === '1' || env.AK_TRIPWIRE_STRICT === '1';
}

/**
 * Every real-state location a test could write, for the given platform.
 * @param {{ env?: Record<string, string|undefined>, platform?: string, homedir?: string, repoRoot: string }} o
 */
export function realStateRoots({ env = process.env, platform = process.platform, homedir = os.homedir(), repoRoot }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const configBases = [env.XDG_CONFIG_HOME, p.join(homedir, '.config'), env.APPDATA, p.join(homedir, 'AppData', 'Roaming')];
  const stateBases = [env.XDG_STATE_HOME, p.join(homedir, '.local', 'state'), env.LOCALAPPDATA, p.join(homedir, 'AppData', 'Local')];
  const primaryConfig = platform === 'win32'
    ? env.APPDATA || p.join(homedir, 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME || p.join(homedir, '.config');
  const roots = [
    ...configBases.filter(Boolean).map((base) => ({ kind: 'config', dir: p.join(base, 'agentic-kit') })),
    ...stateBases.filter(Boolean).map((base) => ({ kind: 'state', dir: p.join(base, 'agentic-kit') })),
    ...REPO_STATE_DIRS.map((name) => ({ kind: 'repo', dir: p.join(repoRoot, name), prefix: name })),
    // ak-managed guidance files in other tools' homes (sync/setup write them).
    { kind: 'user-file', dir: p.join(env.CLAUDE_CONFIG_DIR || p.join(homedir, '.claude'), 'CLAUDE.md') },
    { kind: 'user-file', dir: p.join(env.CODEX_HOME || p.join(homedir, '.codex'), 'AGENTS.md') },
    { kind: 'user-file', dir: p.join(primaryConfig, 'opencode', 'AGENTS.md') },
  ];
  const seen = new Set();
  return roots.filter((root) => {
    const key = platform === 'win32' ? p.normalize(root.dir).toLowerCase() : p.normalize(root.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((root) => ({ ...root, label: `${root.kind}:${root.dir}` }));
}

const toRel = (...parts) => parts.filter(Boolean).join('/');

function hashFile(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function record(out, root, rel, abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch (error) {
    if (error.code === 'ENOENT') return; // vanished between readdir and lstat
    out.set(abs, { root, rel, type: 'unreadable', code: error.code });
    return;
  }
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = fs.readlinkSync(abs); } catch { /* recorded as empty */ }
    out.set(abs, { root, rel, type: 'link', target });
  } else if (st.isDirectory()) {
    out.set(abs, { root, rel: `${rel}/`, type: 'dir' });
    let names;
    try { names = fs.readdirSync(abs); } catch (error) {
      out.set(abs, { root, rel: `${rel}/`, type: 'unreadable', code: error.code });
      return;
    }
    for (const name of names.sort()) record(out, root, toRel(rel, name), path.join(abs, name));
  } else {
    try { out.set(abs, { root, rel, type: 'file', size: st.size, sha256: hashFile(abs) }); } catch (error) {
      out.set(abs, { root, rel, type: 'unreadable', code: error.code });
    }
  }
}

/** Content-addressed snapshot of every root. Directory mtimes are ignored. */
export function snapshotRoots(roots) {
  const out = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) { out.set(`absent:${root.dir}`, { root, rel: '', type: 'absent-root' }); continue; }
    if (root.kind === 'user-file') { record(out, root, path.basename(root.dir), root.dir); continue; }
    // The root itself is an entry, so a run that CREATES ~/.local/state/agentic-kit
    // (even empty) is reported as `+ <root>/`.
    out.set(root.dir, { root, rel: root.prefix ? `${root.prefix}/` : './', type: 'dir' });
    let names;
    try { names = fs.readdirSync(root.dir); } catch (error) {
      out.set(root.dir, { root, rel: root.prefix ? `${root.prefix}/` : './', type: 'unreadable', code: error.code });
      continue;
    }
    for (const name of names.sort()) record(out, root, toRel(root.prefix, name), path.join(root.dir, name));
  }
  return out;
}

const same = (a, b) => a.type === b.type && a.sha256 === b.sha256 && a.target === b.target && a.code === b.code;

function writerFor(entry) {
  return CONCURRENT_WRITERS.find((w) => w.kind === entry.root.kind && w.pattern.test(entry.rel.replace(/\/$/, '')))?.writer;
}

export function compareSnapshots(before, after, { strict = isStrict() } = {}) {
  const changes = [];
  for (const [key, now] of after) {
    const was = before.get(key);
    if (now.type === 'absent-root') continue;
    if (!was) changes.push({ op: '+', path: key, rel: now.rel, kind: now.root.kind, after: now });
    else if (!same(was, now)) changes.push({ op: '~', path: key, rel: now.rel, kind: now.root.kind, before: was, after: now });
  }
  for (const [key, was] of before) {
    if (was.type === 'absent-root' || after.has(key)) continue;
    changes.push({ op: '-', path: key, rel: was.rel, kind: was.root.kind, before: was });
  }
  const failing = [];
  const concurrent = [];
  for (const change of changes) {
    const writer = writerFor(change.after || change.before);
    if (!strict && writer) concurrent.push({ ...change, writer });
    else failing.push(change);
  }
  const byPath = (a, b) => a.path.localeCompare(b.path);
  return { failing: failing.sort(byPath), concurrent: concurrent.sort(byPath) };
}

const size = (e) => (e && e.type === 'file' ? `${e.size} bytes` : e ? e.type : 'absent');

export function formatReport({ failing, concurrent }) {
  const lines = [];
  if (failing.length) {
    lines.push(`real-state tripwire: ${failing.length} path(s) changed during the run`);
    for (const c of failing) lines.push(`  ${c.op} ${c.path} (${size(c.before)} -> ${size(c.after)})`);
    lines.push('A test wrote real user state. If you ran ak, the dashboard or `ak sync` yourself during the run, '
      + 'check whether the listed file holds your data or fixture data, and re-run with nothing else running.');
  }
  if (concurrent.length) {
    lines.push(`real-state tripwire: ${concurrent.length} path(s) changed by concurrent writers (not failing)`);
    for (const c of concurrent) lines.push(`  ${c.op} ${c.path} — ${c.writer}`);
  }
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────
function repoArg(argv) {
  const i = argv.indexOf('--repo');
  return i >= 0 ? path.resolve(argv[i + 1]) : process.cwd();
}

function serialize(map) {
  return JSON.stringify([...map].map(([key, e]) => [key, { ...e, root: e.root.label }]));
}

function deserialize(text, roots) {
  const byLabel = new Map(roots.map((r) => [r.label, r]));
  return new Map(JSON.parse(text).map(([key, e]) => [key, { ...e, root: byLabel.get(e.root) ?? { kind: 'unknown', label: e.root } }]));
}

function main(argv) {
  const [command, file] = argv;
  const roots = realStateRoots({ repoRoot: repoArg(argv) });
  if (command === 'snapshot' && file) {
    fs.writeFileSync(file, serialize(snapshotRoots(roots)));
    return 0;
  }
  if (command === 'compare' && file) {
    const result = compareSnapshots(deserialize(fs.readFileSync(file, 'utf8'), roots), snapshotRoots(roots));
    const report = formatReport(result);
    if (report) console.error(report);
    return result.failing.length ? 3 : 0;
  }
  console.error('usage: real-state-tripwire.mjs snapshot|compare <file> [--repo <dir>]');
  return 2;
}

// Compare real paths (drive-letter case differs on Windows): a missed match would
// make `pnpm test` exit 0 having run nothing.
const isMain = () => {
  if (!process.argv[1]) return false;
  const a = fs.realpathSync.native(path.resolve(process.argv[1]));
  const b = fs.realpathSync.native(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
```

On POSIX `realStateRoots` also lists the `AppData` fall-backs; they are absent and cost one `existsSync` each.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/kit/real-state-tripwire.test.mjs && mise exec node@22.22.3 -- node --test tests/kit/real-state-tripwire.test.mjs`
Expected: PASS on both Node versions.

- [ ] **Step 5: Lint and type-check**

Run: `npx eslint scripts/real-state-tripwire.mjs tests/kit/real-state-tripwire.test.mjs && npx tsc -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/real-state-tripwire.mjs tests/kit/real-state-tripwire.test.mjs
git commit -m "test(guard): fingerprint real user state on every platform"
```

### Task 1.2: The suite runner fails when real state changed

**Files:**

- Create: `scripts/run-tests.mjs`
- Modify: `package.json` (`scripts.test`, `scripts["test:ui"]`)
- Modify: `AGENTS.md` (Testing → Running Tests: say that `pnpm test`/`pnpm run test:ui` run through the tripwire, what "concurrent writers" means, and `AK_TRIPWIRE_STRICT=1`)
- Test: `tests/kit/run-tests-runner.test.mjs`

**Interfaces:**

- Consumes: Task 1.1's `realStateRoots`, `snapshotRoots`, `compareSnapshots`, `isStrict`, `formatReport`.
- Produces: `SUITES`, `runGuarded(commands, opts) → number`, CLI `unit|ui|exec`.

- [ ] **Step 1: Write the failing test**

```js
// tests/kit/run-tests-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');

function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-runner-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), CI: 'true' };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'AK_TRIPWIRE_STRICT']) delete env[key];
  return { home, repo, env };
}

const stub = (dir, name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };

test('a command that writes real state fails the run and the path is named', (t) => {
  const { home, repo, env } = sandbox(t);
  const leak = stub(home, 'leak.mjs', `import fs from 'node:fs'; import path from 'node:path';
    const d = path.join(process.env.XDG_STATE_HOME, 'agentic-kit', 'maintenance');
    fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'latest-scan.json'), '{}');`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', leak], { env, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /real-state tripwire: watching \d+ roots \(strict\)/);
  assert.match(r.stderr, /latest-scan\.json/);
  assert.match(r.stderr, /maintenance\//);
});

test('a write into the repository .claude fails the run', (t) => {
  const { home, repo, env } = sandbox(t);
  const leak = stub(home, 'leak-repo.mjs', `import fs from 'node:fs'; import path from 'node:path';
    fs.mkdirSync(path.join(process.argv[2], '.claude', 'helpers'), { recursive: true });
    fs.writeFileSync(path.join(process.argv[2], '.claude', 'helpers', 'statusline.cjs'), '9.9.9');`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', leak, repo], { env, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /statusline\.cjs/);
});

test('a failing test command keeps its exit code and the tripwire still reports', (t) => {
  const { home, repo, env } = sandbox(t);
  const both = stub(home, 'both.mjs', `import fs from 'node:fs'; import path from 'node:path';
    fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME, 'agentic-kit'), { recursive: true });
    fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME, 'agentic-kit', 'kit.json'), '{}');
    process.exit(7);`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', both], { env, encoding: 'utf8' });
  assert.equal(r.status, 7);
  assert.match(r.stderr, /kit\.json/);
});

test('a clean command passes; concurrent-writer churn does not fail a developer run', (t) => {
  const { home, repo, env } = sandbox(t);
  delete env.CI;
  // The folder exists on any machine with a live statusline; creating it would be a real leak.
  fs.mkdirSync(path.join(home, '.config', 'agentic-kit'), { recursive: true });
  const tee = stub(home, 'tee.mjs', `import fs from 'node:fs'; import path from 'node:path';
    const d = path.join(process.env.XDG_CONFIG_HOME, 'agentic-kit');
    fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'claude-rate-limits.json'), '{}');`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', tee], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /concurrent writers \(not failing\)/);
});

test('SUITES keeps the exact commands package.json ran before', async () => {
  const { SUITES } = await import('../../scripts/run-tests.mjs');
  assert.deepEqual(SUITES.unit[0], ['--test', '--experimental-test-coverage', '--test-coverage-lines=70',
    '--test-coverage-branches=70', '--test-coverage-functions=70', 'tests/kit/*.test.mjs']);
  assert.deepEqual(SUITES.unit.slice(1).map((a) => a[0]), ['statusline-segments', 'statusline-window-ledger',
    'statusline-brain', 'health-history', 'dashboard', 'admin-model', 'admin'].map((f) => `tests/${f}.test.cjs`));
  assert.equal(SUITES.ui[0][0], 'tests/ui/dashboard-ui.mjs');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs unit');
  assert.equal(pkg.scripts['test:ui'], 'node scripts/run-tests.mjs ui');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/kit/run-tests-runner.test.mjs`
Expected: FAIL — runner missing (exit 1 with `Cannot find module`), `SUITES` import fails.

- [ ] **Step 3: Write the runner**

```js
#!/usr/bin/env node
// scripts/run-tests.mjs — runs a test suite between two real-state snapshots.
// `pnpm test` and `pnpm run test:ui` call this. Commands run in order and stop
// at the first failure (the old `&&` chain); the after-snapshot is taken either
// way. No shell: argument vectors for process.execPath, so it behaves the same
// on Windows; `node --test` expands the glob itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realStateRoots, snapshotRoots, compareSnapshots, isStrict, formatReport } from './real-state-tripwire.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COVERAGE = ['--experimental-test-coverage', '--test-coverage-lines=70',
  '--test-coverage-branches=70', '--test-coverage-functions=70'];

export const SUITES = {
  unit: [
    ['--test', ...COVERAGE, 'tests/kit/*.test.mjs'],
    ...['statusline-segments', 'statusline-window-ledger', 'statusline-brain', 'health-history',
      'dashboard', 'admin-model', 'admin'].map((name) => [`tests/${name}.test.cjs`]),
  ],
  ui: [
    ['tests/ui/dashboard-ui.mjs'],
    ['--test', 'tests/ui/dashboard-project-context.mjs', 'tests/ui/maintenance-projects.mjs',
      'tests/ui/maintenance-host-alignment.mjs', 'tests/ui/intelligence-picker.mjs',
      'tests/ui/usage-project-groups.mjs', 'tests/ui/context-coverage.mjs', 'tests/ui/host-readiness.mjs'],
  ],
};

/**
 * @param {string[][]} commands argument vectors for process.execPath
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot?: string, platform?: string, homedir?: string, log?: (s: string) => void }} [o]
 * @returns {number} exit code: the first failing command's, else 3 on a real-state change, else 0
 */
export function runGuarded(commands, {
  env = process.env, repoRoot = REPO, platform = process.platform, homedir = os.homedir(), log = console.error,
} = {}) {
  const roots = realStateRoots({ env, platform, homedir, repoRoot });
  const before = snapshotRoots(roots);
  // One line before anything runs, so a CI log proves the tripwire executed.
  log(`real-state tripwire: watching ${roots.length} roots (${isStrict(env) ? 'strict' : 'developer'})`);
  let code = 0;
  for (const args of commands) {
    const r = spawnSync(process.execPath, args, { cwd: repoRoot, env, stdio: 'inherit' });
    if (r.error) { log(`could not run node ${args.join(' ')}: ${r.error.message}`); code = 1; break; }
    if (r.status !== 0) { code = r.status ?? 1; break; }
  }
  const result = compareSnapshots(before, snapshotRoots(roots), { strict: isStrict(env) });
  const report = formatReport(result);
  if (report) log(report);
  return code || (result.failing.length ? 3 : 0);
}

function main(argv) {
  const [mode] = argv;
  if (mode === 'unit' || mode === 'ui') return runGuarded(SUITES[mode]);
  if (mode === 'exec') {
    const sep = argv.indexOf('--');
    const repoAt = argv.indexOf('--repo');
    if (sep < 0 || sep === argv.length - 1) { console.error('usage: run-tests.mjs exec [--repo <dir>] -- <node args…>'); return 2; }
    const repoRoot = repoAt >= 0 && repoAt < sep ? path.resolve(argv[repoAt + 1]) : REPO;
    return runGuarded([argv.slice(sep + 1)], { repoRoot });
  }
  console.error('usage: run-tests.mjs unit|ui|exec');
  return 2;
}

// Compare real paths (drive-letter case differs on Windows): a missed match would
// make `pnpm test` exit 0 having run nothing.
const isMain = () => {
  if (!process.argv[1]) return false;
  const a = fs.realpathSync.native(path.resolve(process.argv[1]));
  const b = fs.realpathSync.native(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
```

`os.homedir()` honours `HOME` on POSIX and `USERPROFILE` on Windows, which is how the runner test points `exec` at a sandbox home.

- [ ] **Step 4: Rewire `package.json`**

Replace the two script values exactly:

```json
"test": "node scripts/run-tests.mjs unit",
"test:ui": "node scripts/run-tests.mjs ui",
```

- [ ] **Step 5: Run the runner test, then the real suite through the runner**

Run: `node --test tests/kit/run-tests-runner.test.mjs`
Expected: PASS (5/5).

Run (disposable state for the run itself; the tripwire still watches your real folders):

```bash
S=$(mktemp -d "$PWD/../ak-b2.XXXXXX")
env XDG_STATE_HOME="$S/state" LOCALAPPDATA="$S/localappdata" node scripts/run-tests.mjs unit; echo "exit=$?"
```

Expected: the same pass counts as `node --test … "tests/kit/*.test.mjs"` plus the seven `.cjs` suites, and `exit=0`. `realStateRoots` watches both the redirected `XDG_STATE_HOME` and the default `~/.local/state/agentic-kit` (and the real config folder), so your real folders stay watched; any failing report line names a real leak — stop and record it before continuing. Then `rm -rf "$S"`.

- [ ] **Step 6: Update `AGENTS.md` Testing**

Under "Running Tests", replace the plain `pnpm test` description with:

```markdown
`pnpm test` and `pnpm run test:ui` run through `scripts/run-tests.mjs`, which fingerprints
`~/.config/agentic-kit`, `~/.local/state/agentic-kit` (or `%APPDATA%`/`%LOCALAPPDATA%` on
Windows), the Claude/Codex/OpenCode guidance files ak manages, and this repository's `.claude`,
`.swarm`, `.agentic-qe`, `.claude-flow` and `.harness` before and after the run. Any change fails
the run and is listed by path. Files a live Claude Code, Ruflo or AQE session writes during the
run are listed as "concurrent writers" and do not fail a local run; CI (or
`AK_TRIPWIRE_STRICT=1`) fails on them too. `node scripts/run-tests.mjs exec -- <node args>`
guards any single command the same way.
```

Run: `npx markdownlint-cli2 AGENTS.md`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/run-tests.mjs tests/kit/run-tests-runner.test.mjs package.json AGENTS.md
git commit -m "test(guard): fail the suite when real user state changes"
```

### Task 1.3: The dashboard refuses its real-state defaults when fakes are injected

**Files:**

- Modify: `src/lib/dashboard-server.mjs` (`managementProvider` `:992-1015`, `startDashboard` destructuring `:1054-1062`, `provideMaintenance` `:1121-1128`)
- Test: `tests/kit/dashboard-hermetic-defaults.test.mjs`
- Modify: `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md` (Open items → "The dashboard server's hermeticity guard has a gap": add "Fixed in Branch 2 (`<sha>`)")

**Interfaces:**

- Consumes: `sandboxHome`, `assertSandboxed` from `tests/kit/helpers/home-sandbox.mjs`; `waitUntil` from `tests/kit/helpers/wait-until.mjs`.
- Produces: `startDashboard` rule — when any of `fetchStatus, usage, limits, hooks, live, transcripts, intelWatch, discoverProjects, machineWideIntel, models, system, hostReadiness` is passed and neither `maintenance` nor `maintenanceOptions.controlRoot` is, the default maintenance service is refused (503 on its routes, one `console.error` naming `maintenanceOptions.controlRoot`), and the default management facade is refused unless `management` or `managementOptions.controlRoot` is passed.

- [ ] **Step 1: Write the failing test**

```js
// tests/kit/dashboard-hermetic-defaults.test.mjs
// Audit Open item: the guard fired only for an injected maintenance service; a
// caller that injected only a System collector still got the default
// maintenance service and facade over the REAL control root (the
// system-summary incident, 259f075). The home is sandboxed so a regression
// writes the sandbox, and the test reads the sandbox to prove it did not.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sandboxHome, assertSandboxed, rmrf } from './helpers/home-sandbox.mjs';
import { waitUntil } from './helpers/wait-until.mjs';

const home = sandboxHome('ak-dash-hermetic');
after(() => rmrf(home));
const paths = await import('../../src/lib/paths.mjs');
assertSandboxed(paths, home);
const { startDashboard } = await import('../../src/lib/dashboard-server.mjs');

function get(server, route) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, server.url), { headers: { 'x-dash-token': server.token } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}

const collector = () => ({
  async read() { return { runtime: {}, knownFiles: [], storage: {}, projects: [], snapshot: null, scan: { running: false } }; },
  async refreshDeep() { return { ok: true, persisted: { ok: true } }; },
  scanState() { return { running: true, phase: 'catalog' }; },
});

test('an injected System collector alone never builds the default maintenance service', async (t) => {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  t.after(() => { console.error = realError; });
  const server = await startDashboard({ port: 0, cwd: home, system: collector(), usage: {} });
  t.after(() => server.close());

  const deep = await get(server, 'api/system?refresh=deep');
  assert.equal(deep.status, 200);
  await waitUntil(() => errors.some((e) => /maintenanceOptions\.controlRoot/.test(e)),
    'the refused default maintenance service must be logged', { timeout: 5000 });
  const maintenance = await get(server, 'api/maintenance');
  assert.equal(maintenance.status, 503);
  assert.equal(fs.existsSync(path.join(paths.maintenanceControlDir())), false,
    `nothing may be written under ${paths.maintenanceControlDir()}`);
  assert.equal(errors.filter((e) => /maintenanceOptions\.controlRoot/.test(e)).length, 1, 'logged once, not per request');
});

test('an explicit control root keeps the default maintenance service available to fakes', async (t) => {
  const controlRoot = fs.mkdtempSync(path.join(home, 'control-'));
  const server = await startDashboard({ port: 0, cwd: home, system: collector(), usage: {},
    maintenanceOptions: { controlRoot } });
  t.after(() => server.close());
  const maintenance = await get(server, 'api/maintenance');
  assert.notEqual(maintenance.status, 503, maintenance.body);
  assert.equal(fs.existsSync(paths.maintenanceControlDir()), false);
});

test('a server with no injected collector keeps its defaults (the real command)', async (t) => {
  const { __test } = await import('../../src/lib/dashboard-server.mjs');
  assert.equal(__test.refusesDefaultState({}), false);
  assert.equal(__test.refusesDefaultState({ liveOptions: {} }), false);
  assert.equal(__test.refusesDefaultState({ system: {} }), true);
  assert.equal(__test.refusesDefaultState({ fetchStatus: async () => ({}) }), true);
  assert.equal(__test.refusesDefaultState({ system: {}, maintenanceOptions: { controlRoot: '/x' } }), false);
  assert.equal(__test.refusesDefaultState({ system: {}, maintenance: {} }), false);
});
```

If the injected `usage: {}` or the fake `read()` shape trips another route first, copy `fullPayload(3)` from `tests/kit/system-summary.test.mjs` into the fake instead of guessing; the assertions stay as written. The second test builds the real maintenance service over the thin fake collector; if that service needs collector methods the fake lacks (it then answers 503 for a different reason), give it the collector fixture `tests/kit/maintenance-dashboard-e2e.test.mjs` uses. Do not delete the case: it is the proof that the escape hatch still works.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/kit/dashboard-hermetic-defaults.test.mjs`
Expected: FAIL — the first test times out waiting for the log (the default service is built), and `maintenanceControlDir()` exists inside the sandbox; the third fails on `__test` being undefined.

- [ ] **Step 3: Implement the refusal**

In `src/lib/dashboard-server.mjs`, above `managementProvider`:

```js
/** Collectors a caller injects instead of the real ones. A server given any of
 *  them is a test or an embedder with fakes; its DEFAULT maintenance service and
 *  management facade would still write the user's real control root
 *  (~/.local/state/agentic-kit/maintenance), which is how the system-summary
 *  test overwrote real state (audit 2026-09-26, Open items). */
const INJECTABLE_COLLECTORS = ['fetchStatus', 'usage', 'limits', 'hooks', 'live', 'transcripts', 'intelWatch',
  'discoverProjects', 'machineWideIntel', 'models', 'system', 'hostReadiness'];

function refusesDefaultState(opts) {
  if (opts.maintenance !== undefined) return false;
  if (opts.maintenanceOptions?.controlRoot !== undefined) return false;
  return INJECTABLE_COLLECTORS.some((key) => opts[key] !== undefined);
}

const HERMETIC_REFUSAL = 'dashboard: refusing the default maintenance service — collectors were injected, so it would '
  + 'write the real state directory; inject `maintenance` or pass maintenanceOptions.controlRoot';

export const __test = { refusesDefaultState };
```

In `managementProvider`, add a `refused` parameter and, after the two `management` lines:

```js
  if (refused && managementOptions.controlRoot === undefined) return async () => null;
```

In `startDashboard`, keep the destructuring as is and compute, right after it:

```js
  const refused = refusesDefaultState({
    fetchStatus, usage, limits, hooks, live, transcripts, intelWatch, discoverProjects, machineWideIntel,
    models, system, hostReadiness, maintenance, maintenanceOptions,
  });
  let refusalLogged = false;
```

Replace the default branch of `provideMaintenance`:

```js
    ? maintenance : maintenance ? async () => maintenance : async () => {
      if (refused) {
        if (!refusalLogged) { refusalLogged = true; console.error(HERMETIC_REFUSAL); }
        throw new TypeError(HERMETIC_REFUSAL);
      }
      const [{ createMaintenanceService }, collector] = await Promise.all([
        import('./maintenance/service.mjs'), getSystem(),
      ]);
      return createMaintenanceService({ collector, ...maintenanceOptions });
    };
```

and pass `refused` into `managementProvider({ …, refused })`. `getMaintenance` memoizes the rejected promise, so the refusal is logged once and every maintenance route answers its existing 503.

- [ ] **Step 4: Run the new test, then every dashboard caller**

Run: `node --test tests/kit/dashboard-hermetic-defaults.test.mjs`
Expected: PASS (3/3).

Run: `node --test tests/kit/system-summary.test.mjs tests/kit/maintenance-dashboard-e2e.test.mjs tests/kit/maintenance-dashboard-api.test.mjs tests/kit/dashboard-context-hooks.test.mjs tests/kit/host-health-api.test.mjs tests/kit/dashboard-intel-integration.test.mjs tests/kit/model-dashboard-read-model.test.mjs && node tests/dashboard.test.cjs && node tests/ui/dashboard-ui.mjs`
Expected: all pass. A caller that now gets 503 where it expected maintenance data was relying on the real control root: give it an injected `maintenance` or a temp `maintenanceOptions.controlRoot`, and list it in the commit body.

- [ ] **Step 5: Record it in the audit record**

Append to the Open-items bullet "The dashboard server's hermeticity guard has a gap" the sentence: "Fixed on `fix/test-hermeticity`: a server given any injected collector refuses the default maintenance service and facade unless a control root is passed." Run `npx markdownlint-cli2 docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard-server.mjs tests/kit/dashboard-hermetic-defaults.test.mjs docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md
git commit -m "fix(dashboard): refuse default maintenance and management services in injected test servers"
```

### Slice 1 exit

- [ ] Run the gate set from the brief (`common.md`), with `node scripts/run-tests.mjs unit` in place of the raw `node --test` line once, and the brief's `fingerprint.sh` before/after. Record counts and both fingerprint diffs in the slice report.

---

## Slice 2 — environment and temporary folders

### Task 2.1: One sandboxed environment for every spawned child

**Files:**

- Modify: `tests/kit/helpers/home-sandbox.mjs` (add `INHERITED_STATE_KEYS`, `sandboxEnvFor`, `spawnEnv`, `redirectToolState`; make `sandboxHome` use `sandboxEnvFor`)
- Create: `tests/kit/spawn-env-guard.test.mjs`
- Modify: every file the guard names. Today: `tests/kit/provider-cli.test.mjs:75`, `usage-cli.test.mjs:183`, `host-cli-migration.test.mjs:19`, `provider-refresh-cli.test.mjs:55`, `dry-run-nudge.test.mjs:54`, `prompts-mainline-boundary.test.mjs:18`, `hook-audit.test.mjs:351,418,435`, `cli-help.test.mjs:11`, `host-health-connected.test.mjs:221`, and the remaining `...process.env` sites the guard prints (22 in total across `tests/kit` and `tests/*.cjs`).

**Interfaces:**

- Consumes: nothing.
- Produces:

```js
/** Environment keys that point a child at real per-user state. */
export const INHERITED_STATE_KEYS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'HERMES_HOME', 'CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH', 'npm_config_cache'];
/** Overrides that place every per-user base inside `home`. */
export function sandboxEnvFor(home) → Record<string, string>
/** process.env minus INHERITED_STATE_KEYS, plus sandboxEnvFor(home), plus `extra` (last wins). PATH is kept. */
export function spawnEnv(home, extra = {}) → Record<string, string|undefined>
/** For in-process tests whose code under test spawns tools: point XDG state/data/cache, LOCALAPPDATA and
 *  TMPDIR/TEMP/TMP at a fresh folder under os.tmpdir(); restore() puts the old values back and removes it. */
export function redirectToolState(prefix) → { base: string, restore: () => void }
```

- [ ] **Step 1: Write the failing guard**

```js
// tests/kit/spawn-env-guard.test.mjs
// A spawned child that inherits the developer's XDG_*/LOCALAPPDATA/TMPDIR writes
// that developer's real tool state (six files created ~/.local/state/opencode,
// ~/.cache/opencode and ~/.local/share/opencode this way). Every child env in
// tests/ is built by spawnEnv()/sandboxEnvFor(); a deliberate exception carries
// the marker comment `spawn-env: inherits (<reason>)` on the same line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnEnv, sandboxEnvFor, INHERITED_STATE_KEYS } from './helpers/home-sandbox.mjs';

const TESTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const HELPER = path.join(TESTS, 'kit', 'helpers', 'home-sandbox.mjs');
const INHERIT = /\.\.\.\s*process\.env\b|env:\s*process\.env\b/;

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures') files(full, out); } else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

test('no test builds a child environment from process.env outside the sandbox helper', () => {
  const offenders = [];
  for (const file of files(TESTS)) {
    if (file === SELF || file === HELPER) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (INHERIT.test(line) && !/spawn-env: inherits \(.+\)/.test(line)) offenders.push(`${path.relative(TESTS, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `use spawnEnv(home, extra) from tests/kit/helpers/home-sandbox.mjs:\n  ${offenders.join('\n  ')}`);
});

const tempHome = (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-spawn-env-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};

test('spawnEnv pins every per-user base inside the sandbox, whatever the parent exported', (t) => {
  const home = tempHome(t);
  const env = spawnEnv(home, { EXTRA: '1' });
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'npm_config_cache']) {
    assert.ok(env[key] && env[key].startsWith(home), `${key}=${env[key]} escapes ${home}`);
  }
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH']) {
    assert.equal(env[key], undefined, `${key} must not be inherited`);
  }
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.EXTRA, '1');
  assert.deepEqual(Object.keys(sandboxEnvFor(home)).sort(),
    INHERITED_STATE_KEYS.filter((k) => !['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH'].includes(k)).sort());
});

test('a real child sees the sandboxed state base, not the parent one', (t) => {
  const home = tempHome(t);
  const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.XDG_STATE_HOME, require("os").tmpdir()]))'],
    { env: spawnEnv(home), encoding: 'utf8' });
  const [state, tmp] = JSON.parse(r.stdout);
  assert.ok(state.startsWith(home));
  assert.ok(tmp.startsWith(home));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/kit/spawn-env-guard.test.mjs`
Expected: FAIL — `spawnEnv` is not exported; after adding it, the first test lists the 22 offending lines.

- [ ] **Step 3: Implement the helpers in `tests/kit/helpers/home-sandbox.mjs`**

```js
export const INHERITED_STATE_KEYS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'HERMES_HOME', 'CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH', 'npm_config_cache'];

export function sandboxEnvFor(home) {
  const cfg = path.join(home, '.config');
  const tmp = path.join(home, 'tmp');
  return {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: cfg, APPDATA: cfg,
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    npm_config_cache: path.join(home, '.npm'),
  };
}

export function spawnEnv(home, extra = {}) {
  const base = { ...process.env }; // spawn-env: inherits (the one sanctioned copy; state keys are removed below)
  for (const key of INHERITED_STATE_KEYS) delete base[key];
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  return { ...base, ...sandboxEnvFor(home), ...extra };
}

export function redirectToolState(prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-tools-`)));
  const keys = ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(tmp);
  Object.assign(process.env, {
    XDG_STATE_HOME: path.join(base, 'state'), XDG_DATA_HOME: path.join(base, 'data'),
    XDG_CACHE_HOME: path.join(base, 'cache'), LOCALAPPDATA: path.join(base, 'localappdata'),
    TMPDIR: tmp, TEMP: tmp, TMP: tmp,
  });
  return {
    base,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
```

Make `sandboxHome(prefix)` call `Object.assign(process.env, sandboxEnvFor(home))` for the keys it sets today and keep its extra lines (`PATH`, `NO_COLOR`, the three deletes). Do not set `TMPDIR` inside `sandboxHome` in this task (in-process `os.tmpdir()` changes would move every later `mkdtempSync` of that file into the sandbox home; that is Task 2.3's decision, file by file).

- [ ] **Step 4: Convert each offender**

Pattern for a CLI helper (example `tests/kit/provider-cli.test.mjs:70-85`):

```js
function ak(args, { cwd, home, env = {} }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd,
    env: spawnEnv(home, { NO_COLOR: '1', ...env }),
  });
}
```

Keep each file's own extra keys (`PATH`, cleared credentials, `OPENROUTER_MANAGEMENT_KEY: ''`) in `extra`. For `provider-refresh-cli.test.mjs:55-59`, strip `ALL_CREDENTIAL_ENV` from the result of `spawnEnv` before returning. For `cli-help.test.mjs:11` (no home today), create one `sandboxProject`-style home at module scope with `after(() => rmrf(home))`. `home-sandbox.mjs` is ESM: a `.cjs` suite cannot `require` it; load it with `const { spawnEnv } = await import(pathToFileURL(…).href)` inside the suite's async `main()`, the pattern `tests/dashboard.test.cjs:139` already uses. Where a file genuinely needs the parent environment (for example `tests/live/*` that must reach the real `ruflo`), add the marker comment with the reason instead.

- [ ] **Step 5: Run the guard and every converted file**

Run: `node --test tests/kit/spawn-env-guard.test.mjs` then `node --test` on each converted file, then `node tests/<name>.test.cjs` for converted `.cjs` suites.
Expected: PASS everywhere, the guard reports no offenders.

- [ ] **Step 6: Commit**

```bash
git add tests/kit/helpers/home-sandbox.mjs tests/kit/spawn-env-guard.test.mjs <each converted file by name>
git commit -m "test(env): stop spawn tests inheriting the developer's XDG_* variables"
```

### Task 2.2: Six tests stop creating OpenCode's real state, data, cache and temp folders

**Files:**

- Modify: `tests/kit/integration-command-facts.test.mjs`, `tests/kit/opencode.test.mjs`, `tests/kit/provider-credentials.test.mjs` (in-process: `redirectToolState`)
- Modify: `tests/kit/opencode-stock-ruflo-gateway.test.mjs`, `tests/kit/provider-cli.test.mjs`, `tests/kit/provider-refresh-cli.test.mjs` (direct spawns: must already use `spawnEnv` after Task 2.1; verify the OpenCode spawn at `opencode-stock-ruflo-gateway.test.mjs:391` passes `spawnEnv(…)`)
- Create: `tests/kit/opencode-state-hermeticity.test.mjs`

**Interfaces:**

- Consumes: `redirectToolState(prefix)`, `spawnEnv(home, extra)` from Task 2.1.

- [ ] **Step 1: Write the failing test**

```js
// tests/kit/opencode-state-hermeticity.test.mjs
// Six test files created OpenCode's own folders under the developer's
// XDG_STATE_HOME/XDG_CACHE_HOME/XDG_DATA_HOME and TMPDIR (per-file probe,
// Branch 2 plan). Runs the three in-process ones with those bases pointed at a
// watched folder and requires the folder to stay empty. The three direct-spawn
// files are covered by spawn-env-guard.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const IN_PROCESS = ['integration-command-facts', 'opencode', 'provider-credentials'];

for (const name of IN_PROCESS) {
  test(`${name}.test.mjs leaves the inherited tool-state bases untouched`, { timeout: 300_000 }, (t) => {
    const watched = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-oc-watch-')));
    t.after(() => fs.rmSync(watched, { recursive: true, force: true }));
    for (const d of ['state', 'data', 'cache', 'tmp']) fs.mkdirSync(path.join(watched, d));
    const r = spawnSync(process.execPath, ['--test', path.join(KIT, `${name}.test.mjs`)], {
      encoding: 'utf8',
      env: { ...process.env, // spawn-env: inherits (this test measures exactly what an inheriting run leaks)
        XDG_STATE_HOME: path.join(watched, 'state'), XDG_DATA_HOME: path.join(watched, 'data'),
        XDG_CACHE_HOME: path.join(watched, 'cache'), TMPDIR: path.join(watched, 'tmp'),
        TEMP: path.join(watched, 'tmp'), TMP: path.join(watched, 'tmp') },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const leaked = ['state', 'data', 'cache', 'tmp'].flatMap((d) => fs.readdirSync(path.join(watched, d))
      .filter((n) => n !== 'node-compile-cache').map((n) => `${d}/${n}`));
    assert.deepEqual(leaked, []);
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/kit/opencode-state-hermeticity.test.mjs`
Expected: FAIL for all three with `leaked` containing `state/opencode`, `data/opencode`, `cache/opencode`, `tmp/opencode`.

- [ ] **Step 3: Fix the three in-process files**

At module scope in each (after the imports; `paths.mjs` reads these variables lazily, so static imports are fine):

```js
import { after } from 'node:test';
import { redirectToolState } from './helpers/home-sandbox.mjs';

// Code under test spawns the real `opencode` with process.env; keep its
// state/data/cache/temp folders out of the developer's real ones.
const toolState = redirectToolState('ak-<file-name>');
after(() => toolState.restore());
```

If a test in these files asserts on `os.tmpdir()`-relative paths created before the redirect, move the redirect above those module-scope `mkdtempSync` calls.

- [ ] **Step 4: Prove the direct-spawn three with the per-file probe**

Run for each of `opencode-stock-ruflo-gateway`, `provider-cli`, `provider-refresh-cli`:

```bash
W=$(mktemp -d "$PWD/../ak-oc.XXXXXX"); mkdir -p "$W"/{state,data,cache,tmp}
env XDG_STATE_HOME="$W/state" XDG_DATA_HOME="$W/data" XDG_CACHE_HOME="$W/cache" TMPDIR="$W/tmp" node --test tests/kit/<name>.test.mjs
find "$W" -mindepth 2 -maxdepth 2 ! -name node-compile-cache; rm -rf "$W"
```

Expected: the `find` prints nothing. If one prints `opencode`, that file still has a spawn without `spawnEnv`: fix it, and extend `spawn-env-guard` if its pattern missed the form.

- [ ] **Step 5: Run the new test and the six files**

Run: `node --test tests/kit/opencode-state-hermeticity.test.mjs tests/kit/integration-command-facts.test.mjs tests/kit/opencode.test.mjs tests/kit/provider-credentials.test.mjs tests/kit/opencode-stock-ruflo-gateway.test.mjs tests/kit/provider-cli.test.mjs tests/kit/provider-refresh-cli.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/kit/opencode-state-hermeticity.test.mjs tests/kit/integration-command-facts.test.mjs tests/kit/opencode.test.mjs tests/kit/provider-credentials.test.mjs <any direct-spawn file changed in Step 4>
git commit -m "test(opencode): stop six tests creating \$XDG_STATE_HOME/opencode"
```

### Task 2.3: Every test removes the temporary folders it creates

**Files:**

- Create: `tests/kit/helpers/temp-dir.mjs`
- Modify: the 59 files in the leak table (use `tempDir(prefix, t)` or an `after()` removal; statusline: its two shared cache files)
- Test: `tests/kit/temp-dir-helper.test.mjs`

**Interfaces:**

- Produces: `export function tempDir(prefix, t)` — `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')))`, removed by `t.after` (or the file-level `after` when `t` is omitted), with `maxRetries: 3` for Windows `EBUSY`; the caller must `process.chdir` out of it first if it chdir-ed in.

- [ ] **Step 1: Write the failing test**

```js
// tests/kit/temp-dir-helper.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { tempDir } from './helpers/temp-dir.mjs';

let fromTest;
test('a per-test temp folder exists during the test', (t) => {
  fromTest = tempDir('ak-tempdir-probe', t);
  assert.ok(fs.statSync(fromTest).isDirectory());
  assert.ok(fromTest.startsWith(fs.realpathSync(os.tmpdir())));
});
test('and is gone after it', () => {
  assert.equal(fs.existsSync(fromTest), false);
});
```

- [ ] **Step 2: Run it to verify it fails** — `node --test tests/kit/temp-dir-helper.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement the helper**

```js
// tests/kit/helpers/temp-dir.mjs
// A temp folder that removes itself. 59 test files left 700+ folders behind per
// run (Branch 2 probe); this is the one way to make one.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix, t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  if (t) t.after(remove); else after(remove);
  return dir;
}
```

- [ ] **Step 4: Fix the leakers, file by file**

For each file in the leak table replace `fs.mkdtempSync(path.join(os.tmpdir(), 'ak-x-'))` with `tempDir('ak-x', t)` inside tests, or `tempDir('ak-x')` at module scope. Where a helper returns a temp dir without a `t` (e.g. `quota.test.mjs:17` `tmp()`, `live-service.test.mjs:9`), thread `t` through or register with the file-level `after`. `sandboxHome()` homes: add `after(() => rmrf(home))` beside each call that lacks it (`about-install-edits`, `brain-held-refresh`, `routing-retirement-convergence`, `sync-self-freshness`, `ruflo-components-convergence`, `sync-host-repair`, `statusline-config-dir-parity`, …). For `statusline.test.mjs`, run the rendering under `redirectToolState('ak-sl')` so `ruflo-daemon-count.json` and `ruvnet-brain-kb-size.json` (`src/lib/daemons.mjs:276`, `src/templates/statusline-footer.cjs:423,501`) land in its own temp folder and never in the live footer's cache.

After each batch of about ten files, re-run the probe for that batch:

```bash
P=$(mktemp -d "$PWD/../ak-leak.XXXXXX")
for f in <batch>; do D=$(mktemp -d "$P/$f.XXXXXX"); env TMPDIR="$D" node --test "tests/kit/$f.test.mjs" >/dev/null 2>&1 || echo "FAIL $f"; n=$(ls -A "$D" | grep -v '^node-compile-cache$' | wc -l); [ "$n" -eq 0 ] || echo "LEAK $f: $(ls -A "$D" | grep -v node-compile-cache | tr '\n' ' ')"; done
rm -rf "$P"
```

Expected: no `FAIL`, no `LEAK` lines. Keep `P` under the worktree's parent (user-owned, not inside a git repository, not under `/private/tmp`; see "Probe side findings").

- [ ] **Step 5: Commit** (one commit for the helper plus all files; list the file count in the body)

```bash
git add tests/kit/helpers/temp-dir.mjs tests/kit/temp-dir-helper.test.mjs <each changed file by name>
git commit -m "test(temp): remove every temporary folder a test creates"
```

### Task 2.4: The suite runs in its own templated temp root and fails on leftovers

Replaces program-plan item 5 ("create temporary folders from a template"): the suite, not a shell, is where a template belongs.

**Files:**

- Modify: `scripts/run-tests.mjs` (`runGuarded`)
- Modify: `tests/kit/run-tests-runner.test.mjs` (two tests)
- Modify: `AGENTS.md` (one sentence in the Testing paragraph from Task 1.2)

**Interfaces:**

- Consumes: `runGuarded` from Task 1.2.
- Produces: `runGuarded(commands, opts)` (same signature) — creates `fs.mkdtempSync(path.join(os.tmpdir(), "ak-suite-"))`, passes it as `TMPDIR`/`TEMP`/`TMP` to every command, refuses to start (exit 2) when it lies inside a git repository, and after the commands fails with exit 4 naming every leftover entry except `node-compile-cache`; it always removes the root.

- [ ] **Step 1: Write the failing tests** (append to `tests/kit/run-tests-runner.test.mjs`)

```js
test('a leftover temp folder fails the run and is named', (t) => {
  const { home, repo, env } = sandbox(t);
  const leaky = stub(home, 'leaky.mjs', `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    fs.mkdtempSync(path.join(os.tmpdir(), 'ak-leaky-'));`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', leaky], { env, encoding: 'utf8' });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /ak-leaky-/);
});

test('the runner refuses a temp root inside a git repository', (t) => {
  const { home, repo, env } = sandbox(t);
  const inside = path.join(repo, 'tmp');
  fs.mkdirSync(inside);
  const ok = stub(home, 'ok.mjs', '');
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', ok], { env: { ...env, TMPDIR: inside, TEMP: inside, TMP: inside }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /inside the git repository/);
});
```

- [ ] **Step 2: Run** — `node --test tests/kit/run-tests-runner.test.mjs` → the two new tests FAIL (exit 0).

- [ ] **Step 3: Implement** in `runGuarded` before the snapshot (`fs` is already imported since Task 1.2):

```js
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-suite-')));
  const enclosing = enclosingRepository(tempRoot);
  if (enclosing) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    log(`the suite temp root ${tempRoot} is inside the git repository ${enclosing}; tests that probe "outside a `
      + 'git repository" would write into it. Point TMPDIR outside any repository.');
    return 2;
  }
  const childEnv = { ...env, TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot };
```

use `childEnv` for the spawns, and after the commands (before the real-state compare):

```js
  const leftovers = fs.readdirSync(tempRoot).filter((name) => name !== 'node-compile-cache');
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
  if (leftovers.length) log(`temp folders left behind by the run (${leftovers.length}):\n  ${leftovers.join('\n  ')}`);
```

and return `code || (result.failing.length ? 3 : 0) || (leftovers.length ? 4 : 0)`. Add:

```js
function enclosingRepository(dir) {
  for (let cur = dir, i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}
```

- [ ] **Step 4: Run the runner tests, then the whole unit suite through the runner** (disposable state as in Task 1.2 Step 5).
Expected: PASS; the full run reports no leftovers (Task 2.3 fixed them) and exits 0. Any leftover it lists is fixed in its file, in this task.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-tests.mjs tests/kit/run-tests-runner.test.mjs AGENTS.md
git commit -m "test(runner): run the suite in its own temporary folder and fail on leftovers"
```

### Task 2.5: No test writes into an enclosing repository

**Files:**

- Modify: `tests/kit/aqe-embedding-projection.test.mjs:200-222`, `tests/kit/status-aqe-drift.test.mjs:98-100` (and every other "outside a git repository" test the probe below finds)
- Modify: `tests/kit/opencode-stock-ruflo-gateway.test.mjs` (the workspace OpenCode runs in gets its own `.git`)
- Test: the probe command below plus an in-file precondition

**Interfaces:**

- Consumes: `repoRoot` from `src/lib/paths.mjs` (read-only use in the precondition).

- [ ] **Step 1: Reproduce (the failing check)**

```bash
F=$(mktemp -d "$PWD/../ak-encl.XXXXXX"); mkdir "$F/.git" "$F/tmp"
for f in aqe-embedding-projection status-aqe-drift; do env TMPDIR="$F/tmp" node --test "tests/kit/$f.test.mjs" >/dev/null 2>&1; done
find "$F" -mindepth 1 -maxdepth 2 ! -path "$F/tmp*" ! -path "$F/.git"; rm -rf "$F"
```

Expected before the fix: `.claude/settings.local.json`, `.claude/settings.local.json.agentic-kit-aqe-embedding.json`, `.agentic-qe/llm-config.json` appear in `$F` (the fake enclosing repository). Also run `grep -rln "rmSync(path.join(.*'.git')" tests/kit` and `grep -rn "noproj\|outside a git" tests/kit` to find every sibling case; include them.

- [ ] **Step 2: Add a precondition to each "outside a git repository" test**

```js
import { repoRoot } from '../../src/lib/paths.mjs';
// …inside the test, right after the fixture's .git is removed (or the no-project dir is made):
const enclosing = repoRoot(cwd);
if (enclosing) { t.skip(`TMPDIR is inside the git repository ${enclosing}; this case would write into it`); return; }
```

(`status-aqe-drift.test.mjs` imports kit modules dynamically after `sandboxHome`; import `repoRoot` the same way there.)

- [ ] **Step 3: Give OpenCode's workspace its own repository** — in `opencode-stock-ruflo-gateway.test.mjs`, right after the workspace temp folder is created, `fs.mkdirSync(path.join(workspace, '.git'))` with a comment citing `review-hermeticity.md` (OpenCode edited the enclosing `package.json`, created `package-lock.json` and replaced `node_modules`).

- [ ] **Step 4: Re-run Step 1's probe** — Expected: `find` prints nothing; the two files report the precondition skips; with the default `TMPDIR` they pass with no skips (`node --test tests/kit/aqe-embedding-projection.test.mjs tests/kit/status-aqe-drift.test.mjs tests/kit/opencode-stock-ruflo-gateway.test.mjs`).

- [ ] **Step 5: Commit**

```bash
git add tests/kit/aqe-embedding-projection.test.mjs tests/kit/status-aqe-drift.test.mjs tests/kit/opencode-stock-ruflo-gateway.test.mjs <siblings found>
git commit -m "test(isolation): never write an enclosing repository from a temp project"
```

### Task 2.6: The memory-routing live test runs in a disposable home

**Files:**

- Modify: `tests/live/ruflo-memory-routing.test.mjs`
- Modify: `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md` ("Not run" → memory-routing bullet: runs in a disposable home now; the qe-court live test stays manual because it is paid)

**Interfaces:**

- Consumes: `sandboxHome` (home-sandbox.mjs), `createDisposableMemoryProject` (`tests/live/disposable-memory-project.mjs`).

- [ ] **Step 1: Write the failing assertion first** — add to the test, before `ruflo memory init`, an assertion that the home the probe uses is disposable:

```js
assert.ok(paths.home.startsWith(fs.realpathSync(os.tmpdir())), `the live probe must run in a disposable home, not ${paths.home}`);
```

with `paths` imported dynamically. Run `node --test tests/live/ruflo-memory-routing.test.mjs` → FAIL (real home) when `ruflo` is on PATH; if it is not, the test skips — say so in the report and prove the change with Step 4's fingerprint instead.

- [ ] **Step 2: Rewrite the module head**

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxHome, rmrf } from '../kit/helpers/home-sandbox.mjs';

const hasRuflo = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ruflo'], { stdio: 'ignore' }).status === 0;
// Disposable home: sandboxHome() redirects HOME/XDG_*/APPDATA/LOCALAPPDATA and
// blanks PATH; the real `ruflo` is still needed, so PATH is restored.
const realPath = process.env.PATH;
const home = sandboxHome('ak-live-routing');
process.env.PATH = realPath;
after(() => rmrf(home));
const paths = await import('../../src/lib/paths.mjs');
const { probeProjectMemoryRoutes } = await import('../../src/commands/x/verify.mjs');
const { installedRoutingVersion, memoryRoutingObserved } = await import('../../src/lib/ruflo-memory-contract.mjs');
const { createDisposableMemoryProject } = await import('./disposable-memory-project.mjs');
```

and in the test replace the temp-folder + `ruflo memory init` lines with:

```js
  const project = await createDisposableMemoryProject({ prefix: 'ak-live-routing-' });
  t.after(() => project.remove());
  const observation = await probeProjectMemoryRoutes(project.root, project.env, `live-${process.pid}`);
```

Read `disposable-memory-project.mjs` for the exact returned field names (`root`, `env`, and the removal function) and use them as they are; do not add a second removal path. If `installedRoutingVersion()` reads the global npm root through `HOME`-relative paths, check it still finds the installed Ruflo (mise installs live under the real `~/.local/share/mise`, reached through `PATH`, not `HOME`); if it does not, pass the real global root explicitly and note it in the commit body.

- [ ] **Step 3: Run it** — `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME node --test tests/live/ruflo-memory-routing.test.mjs` with the brief's `fingerprint.sh` before/after plus `ls -la ~/.claude-flow ~/.swarm 2>/dev/null` before/after.
Expected: PASS (or skip without `ruflo`); fingerprint diff empty; no new entries in `~/.claude-flow`/`~/.swarm`.

- [ ] **Step 4: Update the audit record's "Not run" bullet**, then `npx markdownlint-cli2` on it.

- [ ] **Step 5: Commit**

```bash
git add tests/live/ruflo-memory-routing.test.mjs docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md
git commit -m "test(live): run the memory-routing live test in a disposable home"
```

### Slice 2 exit

- [ ] Gate set from the brief, plus `node scripts/run-tests.mjs unit` once without any `XDG_*` redirect (the tripwire is now the guard) and the brief's fingerprint before/after. Record counts, the runner's report (it must be empty or list only concurrent writers), and the fingerprint diff.

---

## Slice 3 — UI checks

### Task 3.1: The polyglot card check matches all-language wrapping, and both Maintenance UI specs join `test:ui`

**Files:**

- Modify: `tests/ui/maintenance-focus.mjs:84-100` (and its `/tmp` screenshots at `:71,80,96,99`)
- Modify: `tests/ui/maintenance-guidance.mjs:50` (`/tmp` screenshot)
- Modify: `scripts/run-tests.mjs` (`SUITES.ui[1]`: add `tests/ui/maintenance-focus.mjs`, `tests/ui/maintenance-guidance.mjs`)
- Modify: `tests/kit/run-tests-runner.test.mjs` (the `SUITES` test lists the two files)
- Modify: `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md` ("UI suite outside `test:ui`" bullet: resolved, with the cause)

- [ ] **Step 1: Confirm the failure and its cause** — `node --test tests/ui/maintenance-focus.mjs` → "polyglot cards…" fails `0 !== 3`. Add `page.on('pageerror', e => errors.push(e.message))` before `addScriptTag` and assert `errors` is empty: it now fails with `mntProjectKindBadge is not defined` — the evidence for the commit body.

- [ ] **Step 2: Rewrite the test to the product contract (DDD-09, `docs/LANGUAGE-LOGOS.md:11-12`)**

```js
test('polyglot cards show every language as a labelled, wrapping icon with no disclosure', async (t) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 650 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const languages = [['rust','Rust'],['typescript','TypeScript'],['javascript','JavaScript'],['python','Python'],['java','Java']]
    .map(([id, name]) => ({ id, name, evidence: 'source' }));
  const state = { facets: {}, query: { navigation: { level: 'project', nodes: [{ value: 'prj_example', label: 'billing-service', count: 24, projectKind: 'git', languages }] }, groups: [] } };
  await page.setContent('<!doctype html><html data-theme="dark"><head><style>' + CSS + '</style></head><body><main style="padding:32px"><h2>Projects</h2><div id="cards"></div></main></body></html>');
  await page.addScriptTag({ content: 'var MNT=' + JSON.stringify(state) + ';var MNT_SCOPE_LABELS={};function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}function mntKindLabel(s){return s;}function mntFacetValueLabel(_,s){return s;}function mntIcon(){return "";}function mntAvailableTo(){return "";}\n'
    + source('maintenance-language-logos') + '\n' + source('maintenance-cards') + '\n' + source('maintenance-focus')
    + '\ndocument.getElementById("cards").innerHTML=renderMntFocusResults(false);' });
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('.mnt-language-icon:visible').count(), 5);
  assert.equal(await page.locator('.mnt-language-more').count(), 0);
  assert.equal(await page.getByText(/more languages/).count(), 0);
  assert.equal(await page.getByRole('img', { name: 'Python — Source language detected', exact: true }).isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'icons wrap instead of overflowing');
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'polyglot-projects.png') });
});
```

If loading `maintenance-cards` whole pulls in more undefined helpers (check `errors`), stub `mntProjectKindBadge` alone instead (`function mntProjectKindBadge(k){return '<span class="mnt-project-kind">'+esc(k)+'</span>';}`) and say which in the commit body. Define at the top of the file `const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.ui-artifacts');` (add the `path`/`fileURLToPath` imports) and point every other `/tmp/ak-…png` in this file and in `maintenance-guidance.mjs` at `path.join(SHOTS, '<same-name-without-ak->.png')`.

- [ ] **Step 3: Run** — `node --test tests/ui/maintenance-focus.mjs tests/ui/maintenance-guidance.mjs` → PASS (3/3). Then add both files to `SUITES.ui[1]` and to the runner test's expectation; `node --test tests/kit/run-tests-runner.test.mjs` → PASS; `node scripts/run-tests.mjs ui` (disposable `XDG_STATE_HOME`) → PASS.

- [ ] **Step 4: Audit record** — mark "UI suite outside `test:ui`" resolved: stale harness stub plus the DDD-09 contract; both specs now in `test:ui`.

- [ ] **Step 5: Commit**

```bash
git add tests/ui/maintenance-focus.mjs tests/ui/maintenance-guidance.mjs scripts/run-tests.mjs tests/kit/run-tests-runner.test.mjs docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md
git commit -m "test(ui): check polyglot cards against all-language wrapping and run both Maintenance specs in test:ui"
```

### Task 3.2: A closing health dialog never pulls focus off the next badge

**Files:**

- Modify: `src/lib/dashboard/client/host-readiness.mjs:169` (the `close` handler)
- Modify: `tests/ui/host-readiness.mjs` (new deterministic test; `/tmp` screenshots at `:67,70,184` → `.ui-artifacts/`)
- Modify: `src/lib/dashboard/page.mjs` only if the embedded client copy is generated from the module (check how `renderPage` embeds `host-readiness.mjs`; the UI spec reads the module file directly)

- [ ] **Step 1: Write the deterministic failing test** (append to `tests/ui/host-readiness.mjs`, reusing its `report()`, `source()`, route setup)

```js
test('a dialog close that lands after the user moved on does not steal focus back', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('http://health.test/**', route => route.fulfill({ contentType: 'text/html',
    body: renderPage({ name: 'Health fixture', version: 'test' }).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') }));
  await page.goto('http://health.test/');
  await page.addScriptTag({ content: `${esc.toString()}\nfunction authHeaders(){return {};}\n${source('usage')}\n${source('host-readiness')}\nwireHostHealth();` });
  await page.evaluate(data => globalThis.renderHostReadiness(data), report());
  await page.locator('[data-health-host="claude"]').click();
  // The race, made deterministic: close the dialog and move focus in the SAME
  // task, then let the queued `close` event run.
  const focused = await page.evaluate(async () => {
    const dialog = document.getElementById('host-health-dialog');
    const next = document.querySelector('[data-health-host="codex"]');
    dialog.close();
    next.focus();
    await new Promise(resolve => setTimeout(resolve, 0)); // one task: the queued close event runs first
    return document.activeElement && document.activeElement.getAttribute('data-health-host');
  });
  assert.equal(focused, 'codex');
});
```

The `setTimeout(…, 0)` here is a task-queue flush that orders the queued `close` event before the read, not a wait for time; it is the reproduction, not the fix.

- [ ] **Step 2: Run** — `node --test tests/ui/host-readiness.mjs` → the new test FAILS (`'claude' !== 'codex'`), proving the mechanism behind `fix-wave-2.md:171`.

- [ ] **Step 3: Fix the product**

```js
  // Return focus to the badge that opened the dialog — but only when focus is
  // still in the dialog or nowhere. The `close` event is a queued task; a user
  // (or a fast keyboard sequence) may already have moved on to another badge.
  dialog.addEventListener('close', function () {
    var active = document.activeElement;
    if (active && active !== document.body && !dialog.contains(active)) return;
    var button = region.querySelector('[data-health-host="' + HEALTH_HOST + '"]');
    if (button) button.focus();
  });
```

- [ ] **Step 4: Harden the existing loop without sleeps** — in the first test's per-host loop, after `page.keyboard.press('Escape')`, wait for the dialog to be closed and the badge focused as a condition:

```js
    await page.waitForFunction(h => !document.getElementById('host-health-dialog').open
      && document.activeElement === document.querySelector('[data-health-host="' + h + '"]'), host);
```

and after `Enter`, wait for the title instead of reading it once:

```js
    await page.waitForFunction(n => document.getElementById('host-health-dialog').open
      && document.getElementById('host-health-title').textContent === n + ' health', name);
```

Replace the three `/tmp/ak-health-*.png` paths with `.ui-artifacts/` paths as in Task 3.1.

- [ ] **Step 5: Run it repeatedly** — `for i in $(seq 1 20); do node --test tests/ui/host-readiness.mjs >/dev/null 2>&1 || echo "FAIL run $i"; done` → no `FAIL` lines; also run `node --test tests/kit/*host-readiness*.test.mjs tests/kit/dashboard-*.test.mjs` if any unit test covers the client.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard/client/host-readiness.mjs tests/ui/host-readiness.mjs
git commit -m "fix(dashboard): keep a closing health dialog from pulling focus off the next badge"
```

### Task 3.3: The results list says when it is busy, and MNT-UX-007 waits for it

**Files:**

- Modify: `src/lib/dashboard/client/maintenance-inventory.mjs:47-78` (`mntRunInventoryQuery`)
- Modify: `tests/ui/dashboard-ui.mjs` (the `/api/maintenance/v2/` route mock at `:1468`, and the MNT-UX-007 block at `:2397-2413`)

- [ ] **Step 1: Make the race permanent and deterministic in the test (the failing test)**

In `tests/ui/dashboard-ui.mjs`, next to `let activeMaintenanceInventory = …` (`:1407`), add:

```js
  // Holds the NEXT inventory response until released, so a check can order
  // "focus a row" before "the list re-renders" on every run instead of by luck.
  let holdNextInventory = null;
```

In the route mock's `GET /api/maintenance/v2/inventory` branch, first line:

```js
      if (holdNextInventory) { const gate = holdNextInventory; holdNextInventory = null; await gate; }
```

Replace the MNT-UX-007 lead-in (`:2397-2409`) with:

```js
    const requestsBefore = maintenanceInventoryRequests.length;
    let releaseInventory;
    holdNextInventory = new Promise((resolve) => { releaseInventory = resolve; });
    await page.click('#mnt-clear-all');
    await page.waitForFunction(() => document.querySelectorAll('#mnt-chips .mnt-chip').length === 0);
    check('MNT-UX-007a: the results list is marked busy while its query is in flight',
      await page.getAttribute('#mnt-results', 'aria-busy') === 'true',
      `aria-busy read ${JSON.stringify(await page.getAttribute('#mnt-results', 'aria-busy'))}`);
    releaseInventory();
    await page.waitForFunction(() => document.getElementById('mnt-results')?.getAttribute('aria-busy') === 'false');
    // The gate holds only the NEXT request; if Clear all ever issues two, the
    // unheld one could render first and make this check meaningless.
    check('MNT-UX-007b: Clear all issues exactly one inventory query',
      maintenanceInventoryRequests.length === requestsBefore + 1,
      `inventory requests grew by ${maintenanceInventoryRequests.length - requestsBefore}`);
    check('MNT-UX-002: Clear all removes every active facet at once',
      (await page.evaluate(() => location.hash)).indexOf('facet.') < 0,
      'Clear all left a facet value in the URL');

    // ── Roving tab stop + keyboard navigation over the results list ──
    await page.locator('#mnt-results [data-mnt-plc]').first().focus();
    const rovingBefore = await page.$$eval('#mnt-results [data-mnt-plc]',
      (rows) => rows.map((row) => row.tabIndex));
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#mnt-results [data-mnt-plc]')];
      return rows.length > 1 && document.activeElement === rows[1];
    });
    const rovingAfter = await page.$$eval('#mnt-results [data-mnt-plc]',
      (rows) => rows.map((row) => row.tabIndex));
```

Keep the existing `check('MNT-UX-007: …')` call after it unchanged.

- [ ] **Step 2: Run it to verify it fails**

Run: `env XDG_STATE_HOME="$S/state" node tests/ui/dashboard-ui.mjs` (with `S=$(mktemp -d "$PWD/../ak-ui.XXXXXX")`)
Expected: FAIL on MNT-UX-007a (`aria-busy read null`), and the run then times out in the `aria-busy === 'false'` wait — the product has no busy marker on `#mnt-results`. Record the output.

- [ ] **Step 3: Implement the busy marker**

In `src/lib/dashboard/client/maintenance-inventory.mjs`, beside `mntRunInventoryQuery`:

```js
  function mntResultsBusy(value){
    var results=document.getElementById("mnt-results");
    if(results)results.setAttribute("aria-busy",value?"true":"false");
  }
```

Call `mntResultsBusy(true)` where the query sets `mntInventoryBusy=true`, and `mntResultsBusy(false)` wherever it sets `mntInventoryBusy=false` (success branch, error branch, and the `INVENTORY_GENERATION_MISMATCH` branch just before it re-queries — the re-query sets it back to `true`). Call it AFTER `renderMntInventory()` in each branch, in case that render replaces `#mnt-results` itself; if it does replace the element, set the attribute from inside the render instead, from `mntInventoryBusy`. This is also the right accessibility signal: assistive technology does not announce a list that is about to be replaced.

- [ ] **Step 4: Run it repeatedly**

Run: `for i in $(seq 1 10); do env XDG_STATE_HOME="$S/state" node tests/ui/dashboard-ui.mjs >/dev/null 2>&1 || echo "FAIL run $i"; done; rm -rf "$S"`
Expected: no `FAIL` lines. Also `node --test tests/kit/maintenance-*.test.mjs` for any client unit test touching `mntRunInventoryQuery`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard/client/maintenance-inventory.mjs tests/ui/dashboard-ui.mjs
git commit -m "fix(maintenance): mark the results list busy while an inventory query runs"
```

### Task 3.4: Branch exit — two clean runs and the docs gate

- [ ] **Step 1: Two full runs in a row with nothing else running** (the program plan's exit criterion):

```bash
FP=/Users/cphillipson/Development/active/ai/agentic-kit/.superpowers/sdd/2026-09-26-remediation-program/briefs/fingerprint.sh
S=$(mktemp -d "$PWD/../ak-exit.XXXXXX"); $FP "$PWD" > "$S/fp0.txt"
for i in 1 2; do node scripts/run-tests.mjs unit && node scripts/run-tests.mjs ui; echo "run $i exit=$?"; $FP "$PWD" > "$S/fp$i.txt"; done
diff "$S/fp0.txt" "$S/fp1.txt"; diff "$S/fp1.txt" "$S/fp2.txt"; rm -rf "$S"
```

Expected: both runs `exit=0`, the runner prints no failing paths and no leftovers, both diffs empty (or only explained concurrent-writer lines, with the file content shown).

- [ ] **Step 2: Rest of the gate set** from the brief (tsc, eslint, complexity, markdownlint, build-check, doc-citations, ga-surface-guard, Node 22 run).

- [ ] **Step 3: Docs gate (six classes)** — ADR: none changed (see decisions); DDD: none (`docs/ddd/machine-footprint.md` mentions hermeticity only for product code — re-read to confirm); supplemental: `AGENTS.md` Testing (Tasks 1.2, 2.4); audit: the three Open-items bullets (Tasks 1.3, 2.6, 3.1) plus "Other spawn tests still inherit the developer's `XDG_*` variables" (Task 2.1) marked fixed; research: none; user-facing: none (no CLI behaviour changed). Commit any remaining audit-record edits as `docs(audit): record Branch 2 hermeticity fixes`.

---

## Decisions this plan makes provisionally (flagged for the maintainer)

1. **Concurrent writers on a developer machine.** The tripwire lists the Claude Code statusline tee files and the repo's `.swarm`/`.agentic-qe`/`.claude-flow` hook churn (except ak's own `llm-config.json` and `.claude-flow/config.json`) as "concurrent writers" that do not fail a local run; CI and `AK_TRIPWIRE_STRICT=1` fail on them. Alternative: strict everywhere (reliable only with no Claude Code session open during `pnpm test`).
2. **`pnpm test` itself runs through the tripwire** (not a separate `test:guarded` script), so every contributor and CI get it.
3. **The runner also watches ak's guidance files in other tools' homes** (`~/.claude/CLAUDE.md`, the Codex `AGENTS.md`, the OpenCode `AGENTS.md`), beyond the program plan's list.
4. **Host-readiness focus: product fix** (the `close` handler no longer pulls focus from an element outside the dialog) plus condition waits in the test; alternative: test-only waits.
5. **`tests/ui/maintenance-guidance.mjs` joins `test:ui`** with `maintenance-focus.mjs` (it passes today and is equally outside the suite).
6. **No new ADR.** Test tooling is documented in `AGENTS.md` and the audit record; alternative: a short ADR for the tripwire policy (what is watched, concurrent-writer rule, CI strictness).
7. **Program-plan item 5 is reframed** from "`mktemp` template" (no test uses `mktemp`) to "the suite runs in its own templated temp root and fails on leftovers".
