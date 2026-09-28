# Branch 9 Implementation Plan — `fix/follow-ups`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Drafted by a read-only planning pass against the `fix/follow-ups` worktree (`../agentic-kit-b9`) at `b84b5a7e` (main, v4.0.0-alpha.59). Every premise below was checked in that code; file:line references are to `b84b5a7e` unless a task says otherwise. Branch 6b (`../agentic-kit-6b`) was read at its tip `b35bc107` to learn which files it owns.

**Goal:** Close the Branch 9 follow-ups that do not touch Branch 6b's files — a failed Discovery source that stays failed after a restart, an accurate Codex parsing advisory, pruning of provably redundant settings safety copies, a rendered About test, the 6a leftovers, and a test runner that cleans up after itself only after a complete run — while 6b is built in parallel.

**Architecture:** Thirteen small, independent unit commits plus one report-only task. Item 12 (test temp folders) is research first (Task 10), then a builtin-only owner record and a proven-abandoned collector in `scripts/run-tests.mjs` (Task 11), then a guarded focused-run mode with the exit proof (Task 12), then a reviewed literal-path list for the maintainer with no deletion code (Task 13). Every item that needs a 6b-owned file waits in **Deferred until 6b merges**.

**Tech Stack:** Node 22/26 ESM, `node:test`, the builtin-only runner and tripwire in `scripts/`, the sandbox helpers (`tests/kit/helpers/home-sandbox.mjs`, `tests/kit/helpers/temp-dir.mjs`).

**Spec:** Branch 9's section of the program plan **as it stands in the 6b worktree** (`../agentic-kit-6b/docs/superpowers/plans/2026-09-26-remediation-program.md:218-240`, items 1–13; main's copy lacks items 12 and 13, and the file is in 6b's diff, so this branch never edits it) · maintainer decisions **M-8** (trim Branch 9, run it in parallel, avoid 6b's files), **M-4** (6a leftovers become item 13), **M-10** (the controller does all branch/worktree/stash cleanup) and the ruling at ledger line 420 (ADR-0063 sentence → 6b Task 14; `refreshPlanHosts` try/catch → 6b Task 11; `driftReport`/`selfDrift` restamp → 6b) in `.superpowers/sdd/2026-09-26-remediation-program/progress.md` (main checkout) · the audit record `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md` (findings M1b, N4, N5; Decision 4; Addendum 3 Item 7; Implementation status) · the binding brief `.superpowers/sdd/2026-09-26-remediation-program/briefs/common.md` (main checkout).

**Scope (M-8).** In: items 1 (M1b), 2 (N4), 3 (N5), 6, 7, 9, 10, 11, 12, 13 (minus the two sub-items moved to 6b). Out, becoming GitHub issues: item 4 (L4b), item 5 (F1), item 8 (live observations). Items 2, 6, 10 and 11 and parts of 13 are planned but **Deferred until 6b merges** (section below), because each needs a 6b-owned file. **Housekeeping:** this plan deletes no branch, worktree or stash (M-10: the controller does that).

---

## Global Constraints

- Commits carry no `Co-Authored-By` or any trailer-like final line. Conventional subjects; stage files by name (never `git add -A`/`.`); never commit `.harness/`, `.swarm/`, `.claude-flow/`, `.agentic-qe/`.
- Nothing is pushed, opened as a pull request, merged, posted upstream or created as a routine without the maintainer's go-ahead for that action (M-9 is the standing go-ahead to push this branch and open its PR; merging stays the maintainer's, squash by the controller under M-10).
- Never run `pnpm` here (`node_modules` is a symlink). Use `env -u FORCE_COLOR node --test <file>`, `npx tsc -p tsconfig.json`, `npx eslint`, `npx markdownlint-cli2`, `node scripts/build-check.mjs`, `node scripts/run-tests.mjs unit|ui|exec`.
- **Deletion rule (common brief):** agents never delete by hand. No `rm`, `find -delete`, `git clean` or `rmdir` with a variable, glob or command substitution. Scratch folders are created with `mktemp -d "<template>"` and listed by literal absolute path in the task report for the maintainer. Product and test code that removes its own folders follows the maintainer's rule: minimize recursive removal, absolute paths only, never a path directly under the home folder or the filesystem root.
- **No file overlap with 6b.** Before editing any file, check it against the **6b-owned files** table below. A task that finds it needs a listed file stops and reports to the controller.
- Tests never write real user state (`~/.config/agentic-kit`, `~/.local/state/agentic-kit`, `%APPDATA%`/`%LOCALAPPDATA%`, the repository's `.claude`/`.swarm`/`.agentic-qe`/`.claude-flow`/`.harness`, or `~/.claude`, `~/.codex`, the real `$TMPDIR` backlog). Use `sandboxHome()`/`spawnEnv()`; an in-process `XDG_*` redirect also sets `APPDATA`/`LOCALAPPDATA` (`tests/kit/spawn-env-guard.test.mjs`).
- Test-first: every task report shows the failing run, then the passing run. A test-only task shows a mutation that makes its new test fail, then the revert.
- Comments cite ADRs, audit-record sections, issue or PR numbers — never ledger task numbers or fix-round labels (Task 9 adds the guard).
- User-facing docs describe the current state only. An ADR this branch changes gets an `Updated: <date> — <one line>`. A required sentence in a 6b-owned doc goes to **Deferred**, never into the file.
- Grounding: every Ruflo/AQE/Brain claim cites installed code (file:line, version).
- **`AGENTS.md` injection trap:** Ruflo hooks can inject blocks into a worktree's `AGENTS.md`, and that drift fails lint. Before editing it and again before staging it (Tasks 11, 12), `git diff --quiet AGENTS.md` must succeed on the unedited file; if it does not, stop and report — never stage an injected hunk.

## 6b-owned files (do not edit in Branch 9)

Union of `git -C ../agentic-kit-6b diff --stat 31a1a39b..HEAD` (6b's own changes; `b84b5a7e..HEAD` wrongly shows `package.json` because 6b branched before the alpha.59 release) and every file 6b's plan still lists for Tasks 10–14 and the folded-in 6c-1…6c-5.

| Area | Files |
|---|---|
| CLI and commands | `bin/agentic-kit.mjs`; `.github/workflows/nightly.yml`; `src/commands/{status,sync,system,maintain,usage}.mjs`; `src/commands/sync/plan-versions.mjs`; `src/commands/usage/deep-pass.mjs`; `src/commands/status/sections/{aqe,live-checks,routing,ruvector,ruvnet-brain,self,versions,project-memory}.mjs`; `src/commands/x/{host,host-connection,verify}.mjs` |
| Libraries | `src/lib/{refresh,live-checks,live-check-evidence,output,providers,quota,routing,ruflo-memory-contract,ruflo-memory,ruvector,ruvnet-brain,text-safety,usage-aggregate,versions,config,harvest,mcp-tool-call,exec,host-connection-disclosure,dashboard-server}.mjs`; `src/lib/maintenance/service.mjs`; `src/lib/maintenance/management/{service,service-actions,service-context,service-discovery}.mjs`; `src/lib/hook-audit/agentic-dependency-constraints.json`; `claude/ruflo-reference-full.md` |
| Dashboard | `src/lib/dashboard/page.mjs`; `src/lib/dashboard/{maintenance-security,maintenance-api,host-health-api,refresh-api}.mjs`; `src/lib/dashboard/client/{intelligence,usage,poll,system-projects,maintenance-operation,maintenance-workspace,maintenance-inspector,maintenance-guidance,maintenance-discovery,host-readiness,boot,bootstrap,refresh-control}.mjs`; `src/lib/dashboard/styles/*` (`maintenance-discovery.mjs:173` carries "Refresh evidence", which 6c-4's guard retires) |
| Tests | `tests/kit/{agentdb-retirement,aqe-readiness,cli-help,deja-vu-teardown-verify,drift-freshness,host-cli-migration,host-connection-cli,live-check-evidence,live-checks,maintenance-cli,mcp-tool-call,output-progress,project-memory-status,provider-refresh-cli,quota-codex-presence,quota,refresh,ruflo-memory-location,status-command,status-live,status-repair-contract,sync-command,sync-dry-run-preview,sync-needs-your-action,sync-self-freshness,sync-skip-versions,system-command,usage-cli,usage-index,usage-limits-empty-state,verify-command,verify-memory-routes,version-lookup-record,cli-json-honesty,host-dry-run,status-hint,refresh-vocabulary-guard,maintenance-dashboard-v2-api,maintenance-management-procedures,dashboard-refresh-api,dashboard-status-cost,dashboard-get-is-read-only,maintenance-dashboard-api,maintenance-dashboard-security,dashboard-hermetic-defaults,host-health-api,maintenance-dashboard-client-labels,maintenance-presentation,system-summary}.test.mjs`; `tests/kit/helpers/dashboard-child-server.mjs` (Ruling B9-R16); `tests/live/ruflo-memory-routing.test.mjs`; `tests/dashboard.test.cjs`; `tests/ui/{dashboard-ui,host-readiness}.mjs` |
| Docs | `README.md`; `docs/{TROUBLESHOOTING,UPGRADING,AQE-EMBEDDINGS,PROVIDERS,DEJA-VU,SETUP,MODEL-PRICING-AUDIT,AUTHORING-HOST-ADAPTERS,DASHBOARD,MAINTENANCE,MAINTENANCE-ACCEPTANCE}.md`; `docs/ddd/{ubiquitous-language,maintenance,machine-footprint}.md`; `docs/adr/{0010,0023,0025,0044,0045,0048,0053,0055,0063}-*.md`; `docs/adr/README.md`; `docs/superpowers/plans/{2026-09-26-remediation-program,2026-09-28-branch-6b-one-refresh-flag}.md` |

Branch 9's own files are listed per task; the pre-flight table checks each against this list.

## Premise verification (done by the planner; tasks carry the evidence forward)

| Item | Premise | Verdict | Evidence at `b84b5a7e` |
|---|---|---|---|
| 1 (M1b) | A failed source's banner outlives its Discovery row after a restart | **True** | Banner = the persisted inventory's `sourceCoverage`, built from `orchestrator.coverage()` at the last refresh (`service-inventory.mjs:204-213`, filter `:175-189`) and bucketed by `partialSources` (`query.mjs:767-800`: failed → "limited"). Discovery = `mergedCoverage` (`service-discovery.mjs:341-375`) over `orchestrator.coverage()`. After a restart the orchestrator's in-memory `records` Map is empty, so `coverageForSource` (`orchestrator.mjs:488-495`) falls back to the last-good snapshot, which only ever holds `complete` rows (`coverage.mjs:88-95`), or to `not-scanned`. The failure survives only in scan history (`orchestrator.mjs:286,310` → `history.mjs:76-81`) |
| 2 (N4) | The two-store warning has no acknowledgment path | True | `status/sections/project-memory.mjs:209` pushes `row('memory','warn', twoStoreMessage(...))` whenever `memory.secondary`, with no fix; text in `ruflo-memory-contract.mjs:44-53`. **Deferred** (both files 6b-owned) |
| 3 (N5) | The partial Codex parsing advisory may be inaccurate | **Partly verified** | Mechanism `usage-index.mjs:301-320`: any file with `token_count` events and no parsed response raises `partial-response-yield`, turning the whole Codex source `degraded`/`parse-yield-partial`. Certain defect: the Context host card calls such a source **"Source unreadable"** (`context-host-card.mjs:62-70`) though it was read. The classification's accuracy needs real data: ADR-0052 (`:205-206`) records one rollout on the reference machine that carries `token_count`s but no agent message; `tests/kit/usage-index-v6.test.mjs:189-208` shows such a file is not counted as a session |
| 6 | No per-machine acknowledgment for hook-contract changes | True, but **conflicts with Decision 4** | `brain-hook-contract.mjs:29` (`REVIEWED`) + `ruvnet-brain-plugin.mjs:79-83` push the issue. Decision 4 chose B over C ("B plus a per-machine acknowledgment", audit `:247-281`, option C at `:275`), reaffirmed 2026-09-27; installed Brain 4.3.34 still declares `capacity-aware-parallel-work` `offBehavior: "run"` (`~/.claude/plugins/cache/ruvnet-brain/ruvnet-brain/4.3.34/hooks/hook-contracts.json:242-251`). **Deferred** + Open question OQ-1 |
| 7 | ak keeps a safety copy on every settings write and never prunes them; undo uses receipts | **True for three tags, false for one** | `owned-env-projection.mjs:216` copies before every write; `:224` prunes only when `keepBackups` is passed; only `aqe-project-pin.mjs:162` passes it (`keepBackups: 1`, documented in `UPGRADING.md:85` and ADR-0062:75). `claude-env-projection.mjs:22` (`ruflo-components`), `:80` (`memory-pin`) and `aqe-embedding-projection.mjs:144` (`aqe`) never prune. No code reads a `.ak-*-backup.*` file (undo restores from `nextReceipt.before`). This machine: 1 copy in `~/.claude`, 4 in the repository's `.claude` (3 `aqe`, 1 `ruflo-components`). Other writers make per-write copies with no receipt: `mcp.mjs:445` (16 `config.toml.ak-mcp-repair-*.bak` in `~/.codex`), `host-alignment.mjs:240`, `codex-context-config.mjs:67`, `opencode-core.mjs:90`, `codex-statusline.mjs:159` |
| 9 | No committed test renders the About install-edit line | True | `client/about.mjs:148-156` (`aboutEditLine`) renders the natives row; `tests/kit/about-install-edits.test.mjs` covers only the CLI; `tests/ui/dashboard-ui.mjs:2020` reads `.ab-manage` but seeds no pin row |
| 10 | The ADR index table stops at ADR-0052 | True | `docs/adr/README.md:64` is the last row; 0053–0063 are bullets/sections (`:372-419`); 0061 is not referenced at all. **Deferred** (6b Task 14 and 6c-5 edit the file) |
| 11 | With both the repository root and the folder unsuitable, status names the root's reason | True | `ruflo-memory.mjs:77-86` (`reason ??= why` keeps the first, the root's); rendered as "this folder is <reason>" at `project-memory.mjs:186` and `setup.mjs:763`. **Deferred** (both `ruflo-memory.mjs` and `project-memory.mjs` are 6b-owned) |
| 12 | The runner removes its root only after a complete run; nothing collects an abandoned root; focused `node --test` runs bypass it | True, **with a correction** | `scripts/run-tests.mjs:39-72` removes the root after its commands finish, pass or fail; three `ak-suite-*` roots from killed runs (2026-09-27 12:57, 13:53, 16:59) hold only `node-compile-cache`. **Correction:** the ledger's "none newer than the runner" is now false — 14 `ak-*` sandbox folders are newer (2026-09-27 22:45 → 2026-09-28 09:47: `ak-evidence-home` ×2, `ak-ruflo-components-evidence-location-home` ×2, `ak-refresh-home` ×3, `ak-refresh-proj` ×3, `ak-status-live-home` ×3, `ak-live-checks-home` ×1), so focused runs leak today. Total: 34,008 `ak-*` entries. **Also:** nothing stops the runner when `os.tmpdir()` is the home folder or `/` (its root would then sit directly under them) |
| 13a | The re-record sites in `x/daemon-gc.mjs`, `setup.mjs`, `x/host.mjs` are untested | True | `daemon-gc.mjs:57`, `setup.mjs:398,407`, `x/host.mjs:799,804` call the libraries directly with no seam (6a re-review, ledger line 325); `sync.mjs:237-238` has the `HOST_LIFECYCLE`/`DAEMON_LIFECYCLE` seams to mirror. `x/host.mjs` part **Deferred** |
| 13b | Test comments carry ephemeral task and fix-round labels | True | 43 files, 85 lines on main (pattern in Task 9); 6b's tip adds 3 files (`quota-codex-presence`, `quota`, `usage-limits-empty-state`) |
| 13c | `paths.mjs` and `knownFileSpecs()` accept a relative `XDG_*` | True | `paths.mjs:16,20` (a logical "or" takes any non-empty value), `:101-102` (`p.resolve` turns a relative value into a folder under the cwd), `:352-353`; `footprint/index.mjs:69`. A relative `XDG_STATE_HOME` fails `dashboard.test.cjs` every time (ledger line 332). Same pattern in `footprint/storage.mjs:122`, `consumers.mjs:170-171`, `storage-reclaim-detectors.mjs:26-27`, `install.mjs:583`, `host-readiness-local.mjs:202-203,292`, `live/process-sessions.mjs:34` (the writer of `runtime-debug.log`), `hook-audit/providers/opencode.mjs:93`, `usage-opencode.mjs:41`, `uninstall.mjs:104-106` |
| 13d | The tripwire's concurrent-writer list misses the live session's Ruflo files | True | `real-state-tripwire.mjs:37`'s `^\.claude-flow\/(?!config\.json$)` cannot match the root entry because `writerFor` strips the trailing slash (`:137-139`; compare `.swarm`'s pattern at `:35`, which also matches the bare folder). `.claude/proven-config.json` and `.claude/.proven-config-version` are not listed. Writer: Ruflo 3.47.0 `@claude-flow/cli/dist/src/config/proven-config-refresh.js:24,30,94`, called on every `ruflo` command from `dist/src/index.js:173-175` |
| 13 (moved) | ADR-0063 setup sentence; `refreshPlanHosts` try/catch | Moved to 6b | Ledger line 420 (6b Tasks 14 and 11) |
| 13 (ledger 385) | Deja-vu "passed" after skip; live-check temp-dir coverage | Deferred | Both live in 6b's `src/lib/live-checks.mjs` and `tests/kit/live-checks.test.mjs` |

## Rulings (decided here: what — why — cost if wrong)

- **B9-R1 — "Complete run" means the runner reached its end.** A run whose commands all ran, or that stopped at the first failing command and then reached the runner's own end, is complete: it removes its own root (as today) and then collects proven-abandoned siblings. A killed runner (SIGINT/SIGTERM/SIGKILL, crash) is interrupted: it removes nothing and collects nothing. — The program plan's own item 12 text describes today's removal after the commands finish, pass or fail, as "only after a complete run". — Cost if wrong: a failed run's leftover folders are gone before someone inspects them; their names are still printed (exit 4).
- **B9-R2 — Collection never changes a run's exit code.** The collector prints what it removed and what it kept (with the reason); only the run's own commands, the tripwire and its own leftovers decide the exit. — Cleanup of another run's folder is not this run's result. — Cost if wrong: a failed removal goes unnoticed except in the log.
- **B9-R3 — A root without a valid owner record is never touched.** That covers the three legacy `ak-suite-*` roots, any root the old runner (main, `../agentic-kit-6b`) creates concurrently, a root whose owner file is not yet written, and any root recorded on another host or by another user. They are listed, not removed. — Absence of proof is not proof. — Cost if wrong: legacy roots stay until the maintainer removes them (they are in Task 13's list).
- **B9-R4 — Refuse to run when `os.tmpdir()` is the home folder or the filesystem root.** Exit 2 with a message, like the existing "inside a git repository" refusal (`run-tests.mjs:43-49`). Every removal (own root, collected roots) goes through one predicate: absolute path; basename `^ak-suite-[A-Za-z0-9]{6}$`; parent equals the real path of `os.tmpdir()`; not a symbolic link; owned by the current user (POSIX); owner record present and valid (collected roots). — The maintainer's rule: recursive removal only on absolute paths, never directly under home or `/`. — Cost if wrong: someone with `TMPDIR=$HOME` must point it elsewhere.
- **B9-R5 — Task 10 chooses the abandonment proof; Task 11 implements it behind one interface.** Candidates: (A) POSIX process groups (`detached: true` per command, recorded pgid, signal forwarding, `process.kill(-pgid, 0)`), plus Windows `ParentProcessId` descent; (B) runner pid + start identity + an in-use check (POSIX `lsof -nP +D <root>`; Windows `ParentProcessId` descent); (C) a pid registry — every Node process of the run registers `<root>/.ak-suite-pids/<pid>` through `NODE_OPTIONS=--import=<scripts/run-root-register.mjs>`, and the proof is "every registered pid is dead or reused". The rule: (1) never report "abandoned" while any process started by that run is alive, on macOS, Linux and Windows (an orphan of a killed runner counts as alive); (2) no change to Ctrl-C or tool-kill semantics; (3) under about one second added to a complete run with nothing to collect. A platform where no candidate meets (1) keeps and lists, never collects. Task 12's exit proof is the executable form of criterion (1): after only the runner is killed, the idle orphan child (cwd = the repository, no open file in the root) must keep the root. The chosen candidate must pass that test on its platform; on a list-only platform the test asserts "kept: cannot prove" instead of "kept: a process of that run is alive". — The maintainer asked for a proof that the owning process is gone, not age. Tests that spawn `detached: true` children (`exec-kill-tree`, `process-tree`, `mcp-tool-call`) escape (A)'s groups, and (B)'s `lsof` cannot see an idle orphan whose cwd is the repository. — Cost if wrong: more roots are listed than collected.
- **B9-R6 — PID reuse is detected by start time.** The owner record stores `startedAt` (ms). A pid that is alive but whose process started more than 2 s after `startedAt` (`ps -o lstart= -p <pid>` on macOS, `/proc/<pid>/stat` field 22 with the boot time on Linux, PowerShell `(Get-Process -Id <pid>).StartTime` on Windows) is a different process. — One comparable number, no platform-specific format stored. — Cost if wrong: a reused pid keeps a dead run's root listed until the pid exits.
- **B9-R7 — Focused runs go through the runner.** `node scripts/run-tests.mjs focus <test files…>` = the guarded `--test <files>` with its own root, tripwire, leftover report and collection. A plain `node --test <file>` cannot be intercepted without a flag Node does not read by default (Task 10 confirms `--test-global-setup` and config files need explicit flags on Node 22.22 and 26). `AGENTS.md` names the guarded command; the controller switches the task-brief template (the common brief lives outside the repository). — Cost if wrong: someone who still types plain `node --test` leaks into the shared temp folder on a failure; Task 13's list shows the pattern.
- **B9-R8 — The pre-runner backlog gets no deletion code.** Task 13 produces a reviewed list of literal absolute paths in the main checkout's SDD reports folder, built by a scratch script whose source goes in the report. — Maintainer direction. — Cost if wrong: none; the maintainer removes by hand.
- **B9-R9 — M1b: both surfaces say "failed" (or "stopped") until the source is rescanned.** `coverageForSource` restores the latest terminal history summary when it is `failed`, or `stopped` at a limit (`limitingReason !== 'stopped-by-user'`: a confirmed user stop unenrolls the source, and a re-enrolled source starts `not-scanned`, as in-process); a later `published` summary restores nothing. After a restart the orchestrator reports exactly what it reported before the restart. — The failure is real evidence; the alternative (dropping the banner) was never decided and would hide it. — Cost if wrong: a failure stays visible after a restart until someone presses Retry scan or the next scan succeeds; a history summary pruned by retention falls back to the last-good row (the banner then clears at the next inventory refresh).
- **B9-R10 — N5: no usage-cache schema bump in this branch.** Task 3 uses only facts already in each cached session record and parse stats (for example `session.aborts`). If the evidence needs a new per-file fact, `SCHEMA_VERSION` 25 would move; that is a controller call, because the merged usage-accuracy branch (7+8) bumps it too. — Cost if wrong: the classification fix waits for that branch; Task 3 then ships the evidence and the wording only.
- **B9-R11 — Item 7 prunes only after a successful write, only copies proven redundant, and leaves `aqe-pin` as it is.** After `applyOwnedEnv` writes a file and its receipt, an older copy with this projection's tag is removed only when it carries nothing that the copy just made plus the receipt lack (definition in Task 4). `aqe-pin`'s keep-newest rule (ADR-0062 decision, documented in 6b-owned `UPGRADING.md:85`) is unchanged. A converged file is not touched, so copies already on disk stay until that projection next writes the file. — Deleting in a user's config needs proof; the moment ak makes a new copy is the moment it has the evidence. — Cost if wrong: a few small copies linger; the ones on this machine are listed for the maintainer.
- **B9-R12 — Item 7 leaves writers without receipts alone.** The 16 `config.toml.ak-mcp-repair-*.bak` copies (`mcp.mjs:445`), and the copies made by `host-alignment.mjs:240`, `codex-context-config.mjs:67`, `opencode-core.mjs:90` and `codex-statusline.mjs:159`, are the only record of what those writes removed or replaced; nothing about them is provably redundant. — Maintainer rule. — Cost if wrong: they keep accumulating; counts go to the maintainer.
- **B9-R13 — Item 7 never removes a copy that sits directly in the home folder or the filesystem root, a symbolic link, another user's file, or a name that is not exactly `<basename>.ak-<tag>-backup.<uuid v4>`.** — Maintainer rule plus defence in depth. — Cost if wrong: none.
- **B9-R14 — 13c covers every `src/` reader of `XDG_*` except the statusline template.** One helper in `paths.mjs` decides; every reader listed in the premise table uses it, so the writer of `runtime-debug.log` (`live/process-sessions.mjs:34`) and its reader (`knownFileSpecs()`) cannot disagree, and `ak uninstall` never acts on a folder relative to the cwd (`uninstall.mjs:104-106`). Excluded: `src/templates/statusline-footer.cjs` (the injected footer — changing its bytes re-injects it on every machine), `src/lib/adapters/manifest.mjs:28` (a list of variable names, not a path read), and comments/help text. The tripwire's `realStateRoots` still watches a raw relative value too; harmless, because the default bases are always watched. — The XDG Base Directory spec says a relative value is invalid and ignored. — Cost if wrong: about ten one-line edits beyond the two named files.
- **B9-R15 — 13a mirrors `sync.mjs`'s seams.** `x/daemon-gc.mjs` `run({ flags, deps })` takes `deps.daemonLifecycle` (`{ list, reap }`, like `DAEMON_LIFECYCLE`, `sync.mjs:238`); `setup.mjs` exports `installEnabledAbsentHosts(cfg, flags, lifecycle)` with `{ installState, install, collectFacts }` (like `HOST_LIFECYCLE`, `sync.mjs:237`). `x/host.mjs` waits for 6b. — Cost if wrong: none; the defaults are the current imports.
- **B9-R16 — 13b's guard allowlists 6b-owned files by exact path.** Patterns: `/\bTask \d+(?:\.\d+)?[a-z]?\b/`, `/\b[Ff]ix round \d/`, `/final-review fix/`, `/\bBranch \d+[a-z]?\b[^.\n]{0,20}\bTask\b/` in comments and test titles under `src/`, `scripts/`, `bin/`, `tests/`. Decision ids that the audit record cites (for example `B3-D2`, `B5-D1`) are allowed, as 6b's R18 ruling allows audit references. `src/lib/hook-audit/agentic-dependency-constraints.json` is excluded (dated history notes). `tests/kit/helpers/dashboard-child-server.mjs` is treated as 6b's (6c-1 may pass it new options). — Cost if wrong: if Branch 9 merges first, 6b's rebase fails the guard on its three new labelled files until 6b's Task 14 de-labels them (planned there already, ledger line 357).
- **B9-R17 — The About render test is a `vm` render of the shipped client source, not a Playwright test.** `tests/ui/dashboard-ui.mjs` is 6b-owned, and a new UI spec would need `scripts/run-tests.mjs`'s `SUITES.ui` list edited, which Tasks 11–12 also edit. — Cost if wrong: a CSS rule hiding `.ab-manage` would not be caught (the UI suite's About screenshot covers layout).
- **B9-R18 — Docs sentences owed to 6b-owned files are deferred with their exact text.** Each task records its doc change in non-6b homes (ADR-0052, ADR-0058, `docs/ddd/integration-management.md`, `docs/USAGE-SCORECARD-METRICS.md`, `AGENTS.md`, `docs/research/`, the audit record). — No file overlap. — Cost if wrong: a user-facing page is silent on a behaviour for the days between the two merges.

## File map (Branch 9)

| File | Responsibility after this branch | Tasks |
|---|---|---|
| `src/lib/maintenance/discovery/orchestrator.mjs` | `coverage()` restores a terminal failure from scan history | 1 |
| `src/lib/dashboard/context-host-card.mjs` | truthful empty-state label for a partly read source | 2 |
| `src/lib/usage-index.mjs` | `finalizeCodexHealth` classifies response gaps per evidence | 3 |
| `src/lib/owned-env-projection.mjs` | `redundantBackups`, pruning after a successful write | 4 |
| `src/lib/paths.mjs` | `xdgBase(name, fallback, { env, p })`, the one XDG reader | 6 |
| `scripts/real-state-tripwire.mjs` | concurrent-writer list | 7 |
| `src/commands/x/daemon-gc.mjs`, `src/commands/setup.mjs` | injectable lifecycle seams | 8 |
| `tests/kit/comment-label-guard.test.mjs` (new) | no ephemeral labels outside the allowlist | 9 |
| `docs/research/2026-09-28-test-temp-folder-cleanup.md` (new) | item 12 analysis and the chosen proof | 10 |
| `scripts/run-roots.mjs` (new, builtin-only) | owner record, removal predicate, abandonment proof, collector | 11, 12 |
| `scripts/run-tests.mjs` | owner record per run, refusal of unsafe temp bases, collection after a complete run, `focus` mode | 11, 12 |

---

## Tasks (Branch 9)

Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14. Hard dependencies: 2 before 3 (Task 3 may reuse Task 2's wording); 10 before 11, 12 and 13; 11 before 12 (same files); 13 after every task that runs focused tests (the census changes while the branch runs); 14 last. Run the full gate set (common brief) after Tasks 8, 12 and 14.

### Task 1: M1b — a failed source stays failed in Discovery after a restart

**Commit:** `fix(discovery): keep a failed source failed in Discovery after a restart`

**Files:**

- Modify: `src/lib/maintenance/discovery/orchestrator.mjs:486-499` (`coverageForSource`, `coverage`).
- Test: `tests/kit/maintenance-discovery-orchestrator.test.mjs` (append), `tests/kit/maintenance-management-service.test.mjs` (append after the M1 tests, `:959-1010`; not in 6b's diff or plan).
- Docs: `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md` gets its line in Task 14. Before committing, re-read ADR-0048's scan-state text (`:280-300`) and `docs/MAINTENANCE.md:346`; if a sentence now contradicts the code, add it to Deferred with exact text (both files are 6b-owned). Expected: none contradicted ("the last complete snapshot stays authoritative" still holds — the snapshot's content is unchanged; only the row's state reports the latest run).

**Interfaces:**

- Produces: `createScanOrchestrator(...).coverage()` — for a source with no live record, the latest history summary for `(environmentId, sourceId)` decides first: `failed`, or `stopped` with a `limitingReason` other than `stopped-by-user` → a coverage row with that `state`, `limitingReason`, `ceiling` and `visited`; anything else → today's last-good or `not-scanned` row.

- [ ] **Step 1: Write the failing tests.**

```js
// maintenance-discovery-orchestrator.test.mjs — uses the file's own control() and fixture()
test('M1b: a failed source reports failed after a restart, not not-scanned', async (t) => {
  const dir = fixture(t);
  const missing = path.join(dir, 'no-such-root');
  const first = control(missing, dir);
  await first.orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(first.orchestrator.coverage()[0].state, 'failed');
  const restarted = control(missing, dir); // same stores, fresh in-memory records
  const [row] = restarted.orchestrator.coverage();
  assert.equal(row.state, 'failed');
  assert.equal(row.limitingReason, 'io-failure');
});
test('M1b: a later successful scan wins over an earlier failure after a restart', async (t) => { /* fail, create the root, rescan to complete, restart → complete */ });
test('M1b: with no history the restart falls back to the last-good row (retention edge)', async (t) => { /* complete, clear history via historyStore.clearHistory(), restart → complete */ });
test('M1b: a user stop is not restored; a re-enrolled source starts not-scanned', async (t) => { /* record a stopped-by-user summary, restart → not-scanned (or last-good) */ });
```

In `maintenance-management-service.test.mjs`, `buildHarness(t, { discovery: { collectionRoots: [<a missing root>] } })` (the harness spreads `discovery` into `loadConfig`, `:139`): `rebuildAfterMeasurement()`; then a **second** `buildHarness` over the same `controlRoot` (the restart); assert `service.discovery().coverage` has that source with `state: 'failed'` and `service.inventory({}).partialSources.total === 1` — both surfaces agree. Also assert the Discovery row still carries its label (the client renders any `state`, `client/maintenance-discovery.mjs:167-169`).

- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/maintenance-discovery-orchestrator.test.mjs tests/kit/maintenance-management-service.test.mjs` — expect the restart assertions to FAIL with `not-scanned`.
- [ ] **Step 3: Implement.** In `coverage()`, read `historyStore?.list() ?? []` **once** and index the newest summary per `` `${environmentId}:${sourceId}` `` (by `completedAt`); pass the map to `coverageForSource`. In `coverageForSource`, after the live-record check: `if (summary && (summary.state === 'failed' || (summary.state === 'stopped' && summary.limitingReason !== 'stopped-by-user'))) return coverageFor({ ...toCoverageRecord(initRecord(source)), scanState: summary.state, visited: summary.visited ?? 0, limitingReason: summary.limitingReason ?? null, ceiling: summary.ceiling ?? null });` — `coverageFor` already nulls `lastCompletedAt` for non-complete rows, which is what the in-process row shows. Update the function's doc comment (cite audit finding M1b, not a task label).
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/maintenance-discovery-coverage.test.mjs tests/kit/maintenance-discovery-checkpoint.test.mjs`.
- [ ] **Step 5: Commit** (`git add src/lib/maintenance/discovery/orchestrator.mjs tests/kit/maintenance-discovery-orchestrator.test.mjs tests/kit/maintenance-management-service.test.mjs`).

**Acceptance:** after a restart, Discovery and the Inventory banner report the same failed source; a successful rescan clears both (the banner at the next inventory refresh, as today).

### Task 2: N5 (certain part) — a partly read Codex source is not "unreadable"

**Commit:** `fix(usage): say a Codex source was partly read, not unreadable`

**Files:**

- Modify: `src/lib/dashboard/context-host-card.mjs:62-70` (`emptyState`).
- Test: `tests/kit/dashboard-context-host-card.test.mjs` (append after `:89-95`).

**Behaviour:** `status === 'degraded'` with a `reason` that starts with `parse-yield-` → label **"Partial data"** (the Usage data-sources pill's own word for `degraded`, `client/usage.mjs:114`) and reason "`<Label>` session files were read, but some yielded no response ak could parse (`<reason>`), so an empty list here does not mean no sessions ran." Any other `degraded` reason keeps "Source unreadable".

- [ ] **Step 1: Write the failing test:** `contextHostCard('codex', EMPTY, { health: { status: 'degraded', reason: 'parse-yield-partial' } })` matches `/Partial data/` and `/were read/`, and does not match `/Source unreadable/`; the existing `schema` case (`:89-95`) is unchanged.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/dashboard-context-host-card.test.mjs`.
- [ ] **Step 3: Implement** inside `emptyState` (the renderer is injected into the browser bundle as text, so keep every helper inside the function, `:3-7`).
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/context-display-semantics.test.mjs`.
- [ ] **Step 5: Commit** (the two files by name).

### Task 3: N5 (evidence part) — verify, then correct, the partial Codex parsing advisory

**Commit (by outcome, Step 2):** A — `fix(usage): stop degrading Codex health for rollouts that end without a reply` · B — `docs(usage): state what the partial Codex parsing advisory counts`

**Files:**

- Scratch (not committed): `codex-yield-census.mjs` in the session scratchpad.
- Outcome A: modify `src/lib/usage-index.mjs:277-320` (`addCodexParseDiagnostics`, `recordCodexCandidate` passes `session`, `finalizeCodexHealth`); test `tests/kit/usage-index-v6.test.mjs` (after `:189-208`).
- Both outcomes: `docs/USAGE-SCORECARD-METRICS.md:136-142`; `docs/adr/0052-codex-usage-attribution.md` (`Updated` line; replace the "Not done" bullet at `:205-206` with the measured counts).

- [ ] **Step 1: Reproduce on real data, counts only.** Write a read-only scratch script that walks `~/.codex/sessions/**/rollout-*.jsonl` and calls the maintained parser directly — `parseCodex` (`src/lib/usage-parsers.mjs:1211`, pure: returns `{ session, turns, parseStats }`), with the same large-file reader the index uses (`usage-index.mjs:~460`). **Never call `buildIndex`** (it writes the usage cache) and never print a path, id, title, prompt or timestamp. For every file with `parseStats.tokenCountEvents > 0 && parseStats.responses === 0` (a "gap file"), count: total gap files; how many have `session.aborts > 0`; how many have tool items only (`Object.keys(session.tools).length > 0`); how many are imports (`session.imported`); whether the index keeps the record (apply the same test `processCandidate`/the aggregate applies) and, if it does not, the sum of `last_token_usage.total_tokens` that is therefore not counted; the rest as "unexplained". Also count all token-bearing files. Print one JSON object. Run it once (`env -u FORCE_COLOR node <scratchpad>/codex-yield-census.mjs`); paste the script and its output in the report. Ruflo is not involved; nothing is written.
- [ ] **Step 2: Choose the outcome by rule.**
  - **A** — every gap file is explained by a fact already in the cached session record (B9-R10: e.g. `aborts > 0`, a turn that ended without a reply) **and** its usage is counted: the gap is not a parse failure. `finalizeCodexHealth` degrades only for unexplained gaps; `diagnostics.warnings` keeps `partial-response-yield` when any gap exists, and `diagnostics` gains `explainedGapFiles` (computed at scan time from the cached `session`, no schema change).
  - **B** — any gap is unexplained, or a gap file's usage is not counted: the advisory is right in substance. Keep the classification; document what it counts (docs only). The parser follow-up (count that usage, or explain the shape) goes to the controller for the usage-accuracy branch with the census numbers.
- [ ] **Step 3 (A only): Write the failing test** in `usage-index-v6.test.mjs`: a rollout with `task_started`, one `token_count` and `turn_aborted` and no agent message, beside one normal rollout → `sourceHealth.codex.status === 'ok'`, `diagnostics.warnings` includes `partial-response-yield`, `diagnostics.explainedGapFiles === 1`; the existing unexplained fixture (`:189-208`) stays `degraded`/`parse-yield-partial`. Run `env -u FORCE_COLOR node --test tests/kit/usage-index-v6.test.mjs` — FAIL; implement; PASS; plus `env -u FORCE_COLOR node --test tests/kit/usage-index-opencode.test.mjs tests/kit/usage-index-claude-window.test.mjs`.
- [ ] **Step 4: Docs.** `USAGE-SCORECARD-METRICS.md:136-142` states what the warning and the degraded status mean after this task; ADR-0052 `Updated: <date> — measured the partial response yield on the reference machine (<counts>); <outcome>` and its "Not done" bullet carries the numbers. `docs/DASHBOARD.md:966` ("Partial historical records do not lower host health") stays true in both outcomes; confirm and say so in the report.
- [ ] **Step 5: Commit** (outcome A: `src/lib/usage-index.mjs`, the test, both docs; outcome B: the two docs).

**Acceptance:** the report carries the census JSON; the advisory's status and words match what the census proved.

### Task 4: Item 7 — remove safety copies a newer copy and the receipt make redundant

**Commit:** `fix(settings): remove ak's safety copies that a newer copy and the receipt make redundant`

**Files:**

- Modify: `src/lib/owned-env-projection.mjs` — `planOwnedEnv` (`:75-117`) also returns `editorFor`; `applyOwnedEnv` (`:198-227`) remembers the copy it just made and, after the receipt is written, calls `pruneRedundantBackups`; new exported `redundantBackups(plan, { newest, backupTag })` (pure decision) and a private `pruneRedundantBackups`. `keepBackups`/`pruneBackups` (`:176-192`) stay for `aqe-pin` (B9-R11).
- Test: `tests/kit/owned-env-backup-prune.test.mjs` (new).
- Docs: `docs/adr/0058-managed-ruflo-components.md` (`Updated` line and one sentence in §3, `:185-195`); `docs/ddd/integration-management.md:168-176` (one sentence: safety copies are not receipts and are pruned only when provably redundant). User-facing sentence → Deferred (B9-R18).

**The redundancy rule (write it into the function's doc comment).** Let `N` be the copy `applyOwnedEnv` just made of file `F` (never removed). Let `K` be the owned keys: the receipt's keys ∪ `plan.keys`. An older copy `B` of `F` with the same tag is removed only when **all** hold:

1. `B` is a regular file (`lstat`), not a symbolic link, named exactly `<basename(F)>.ak-<tag>-backup.<uuid v4>`, in `dirname(F)`, owned by the current user (POSIX `uid`), and `dirname(F)` is neither the home folder nor a filesystem root (B9-R13).
2. `B` and `N` both parse with the projection's own editor (`plan.editorFor`).
3. Rendering `B` and `N` with every key in `K` set absent gives byte-identical text (nothing of the user's differs).
4. For every key in `K`, `B`'s value is one of: `N`'s value, the receipt's `before`, the receipt's `after`, or absent where the receipt's `before` is absent. "The receipt" is `plan.nextReceipt`, the one this write just recorded. A write that deletes the receipt (a full release, `hasKeys` false) prunes nothing: no proof remains.

A copy that holds an intermediate ak value (neither the receipt's first `before` nor its current `after`) is kept by design — say so in the doc comment so a reviewer does not file the conservatism as a bug. Anything else — unparseable, a difference outside `K`, an unknown owned value, an unlink error (Windows `EBUSY`/`EPERM`) — keeps `B`. Removal is `fs.unlinkSync(<absolute path>)`, one file at a time, never recursive.

- [ ] **Step 1: Write the failing tests** in `sandboxHome('ak-backup-prune')` with a real `.claude/settings.local.json` and the real `reconcileMemoryPin`/`reconcileClaudeComponentEnv` (or `planOwnedEnv`/`applyOwnedEnv` with `jsonTopLevelEnvEditor`):

```js
test('after three writes with no user edits, only the newest copy remains', ...);
test('a copy holding a user key that a later user edit removed is kept', ...);
test('a copy whose owned value is neither in the newest copy nor the receipt is kept', ...);
test('a malformed copy, a symlink named like a copy, and another tag\'s copy are never touched', ...);
test('a converged reconcile and a dry run remove nothing', ...);
test('aqe-pin still keeps exactly its newest copy (keepBackups unchanged)', ...);
test('redundantBackups refuses when the file sits directly in the home folder', ...); // inject homedir = dirname(F)
```

Assert on directory listings before and after; assert the sandbox HOME is the only place touched (`snapshot`/`assertUnchanged` from `home-sandbox.mjs` around a second, converged run).

- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/owned-env-backup-prune.test.mjs` — expect three copies where one is expected.
- [ ] **Step 3: Implement** as specified. On Windows skip the `uid` check (`process.getuid` is undefined).
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/owned-env-projection.test.mjs tests/kit/aqe-project-pin.test.mjs tests/kit/project-isolation.test.mjs tests/kit/aqe-embedding-projection.test.mjs tests/kit/claude-env-projection.test.mjs tests/kit/ruflo-memory-root-pin.test.mjs`.
- [ ] **Step 5: Commit** (the source, the test, ADR-0058, the DDD file). Report: the copies on this machine that remain (`~/.claude`: 1; the repository's `.claude`: 4) and the out-of-scope counts (B9-R12), as information for the maintainer. Do not run a real `ak sync` to prune them.

### Task 5: Item 9 — render the About install-edit line

**Commit:** `test(about): render the Ruflo install-edit line on the About card`

**Files:**

- Test: `tests/kit/about-install-edit-render.test.mjs` (new). No source change expected.

**Behaviour:** load `src/lib/dashboard/client/about.mjs` as text into a `vm` context, as `tests/kit/about-agentdb-join.test.mjs:20-27` does (strip `import`/`export`; provide the real `RANK` and `esc` from `src/lib/dashboard/groups.mjs`, and stubs `sourceHostIcon = () => ''`, `aboutHostChip = () => null`). Build the natives rows with the **real** `installEditRows` (`src/commands/status/sections/natives.mjs:14-29`) from one applied Ruflo edit (`installEditStatus` in a `sandboxHome`, or a literal edit object with `state: 'applied'` and a `rufloRoot` that contains its file).

- [ ] **Step 1: Write the test:** `aboutCard({ id: 'ruflo', … }, { rows })` contains exactly one `<div class="ab-manage">` whose text starts with `ak applied Ruflo's native SQLite pin (ruvnet/ruflo#2219)` and is HTML-escaped; the card for `agentdb` does not carry it; with no natives edit row, no `ab-manage` edit line; a contract assertion that `aboutEditLine`'s pattern (read from the source) matches `RUFLO_PIN_NOTE` (`src/lib/install-edits.mjs:118`), so a wording change fails here instead of silently dropping the line.
- [ ] **Step 2: Prove it can fail.** Temporarily change `RUFLO_PIN_NOTE`'s first word; run `env -u FORCE_COLOR node --test tests/kit/about-install-edit-render.test.mjs` — FAIL; revert (`git diff --stat` shows only the new test); paste both runs.
- [ ] **Step 3: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/about-install-edits.test.mjs tests/kit/about-agentdb-join.test.mjs`.
- [ ] **Step 4: Commit** (the new test).

### Task 6: 13c — ignore a relative `XDG_*` value

**Commit:** `fix(paths): ignore a relative XDG_* value, as the XDG Base Directory spec requires`

**Files:**

- Modify: `src/lib/paths.mjs` — new `export function xdgBase(name, fallback, { env = process.env, p = path } = {})` returning `env[name]` only when it is non-empty and `p.isAbsolute(...)`, else `fallback`; use it in `configBase`/`stateBase` (`:14-21`), `toolInternalDirs` (`:101-102`, a relative value is dropped, never `p.resolve`d), `hostHealthInputPaths` (`:352-353`); export `stateBase` for the readers below.
- Modify (B9-R14): `src/lib/footprint/index.mjs:68-69` (`knownFileSpecs`, exported for the test), `src/lib/footprint/storage.mjs:122`, `src/lib/footprint/consumers.mjs:170-171`, `src/lib/footprint/storage-reclaim-detectors.mjs:26-27`, `src/lib/footprint/install.mjs:583`, `src/lib/host-readiness-local.mjs:202-203,292`, `src/lib/live/process-sessions.mjs:34`, `src/lib/hook-audit/providers/opencode.mjs:93`, `src/lib/usage-opencode.mjs:41` (keeps its `null` fallback), `src/commands/uninstall.mjs:104-106` (a relative value is dropped from the candidate bases).
- Test: `tests/kit/xdg-relative.test.mjs` (new).

- [ ] **Step 1: Write the failing tests.** (a) `xdgBase` unit cases with `path.posix` and `path.win32`: absolute kept, relative/empty/undefined → fallback. (b) A child process (`spawnEnv(home, { XDG_CONFIG_HOME: 'rel/cfg', XDG_STATE_HOME: 'rel/state', XDG_DATA_HOME: 'rel/data', XDG_CACHE_HOME: 'rel/cache' })`, cwd = a sandbox folder, POSIX only because Windows reads `APPDATA`) prints `configDir()`, `evidenceDir()`, `knownFileSpecs()` paths and `toolInternalDirs()`; every path is absolute, sits under `home`, and none contains `rel/`. (c) A source guard: no file under `src/` reads `XDG_` from an environment object except `src/lib/paths.mjs`, `src/templates/statusline-footer.cjs` and `src/lib/adapters/manifest.mjs` (text scan for `/\b(?:process\.)?env\.XDG_[A-Z_]+|env\[['"]XDG_/`, comments stripped).
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/xdg-relative.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/paths-global-root-evidence.test.mjs tests/kit/spawn-env-guard.test.mjs tests/kit/uninstall-command.test.mjs tests/kit/opencode-state-hermeticity.test.mjs`. Then the reproduction from ledger line 332 in a **disposable environment** (after this task a relative value is ignored, so without a disposable HOME the suite would fall back to the real `~/.local/state`): `T=$(mktemp -d "$PWD/../ak-b9-xdg.XXXXXX")`, then from the worktree `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME HOME="$T" XDG_STATE_HOME=rel-state node scripts/run-tests.mjs exec -- tests/dashboard.test.cjs` (the file is 6b-owned: run it, never edit it). Expect all three: 0 failures; no `<worktree>/rel-state` created (`ls -la <worktree literal path>/rel-state` reports it absent); the tripwire clean. Report `$T`'s literal path.
- [ ] **Step 5: Commit** (every file above by name).

### Task 7: 13d — the tripwire names the live Ruflo session's files

**Commit:** `test(tripwire): list the live Ruflo session's .claude-flow folder and proven-config files as concurrent writers`

**Files:**

- Modify: `scripts/real-state-tripwire.mjs:31-39` — `.claude-flow` pattern becomes `/^\.claude-flow(?:\/(?!config\.json$)|$)/`; add `{ kind: 'repo', pattern: /^\.claude\/(?:proven-config\.json|\.proven-config-version)$/, writer: "Ruflo's proven-config adoption on every ruflo command (@claude-flow/cli 3.47.0 dist/src/config/proven-config-refresh.js:24,30,94; dist/src/index.js:173-175)" }`.
- Test: `tests/kit/real-state-tripwire.test.mjs`.

- [ ] **Step 1: Write the failing tests:** `compareSnapshots` in developer mode with a snapshot pair where `.claude-flow/` goes from absent root to present, and where `.claude/proven-config.json` and `.claude/.proven-config-version` appear → all three are `concurrent`, none `failing`; in strict mode all three fail; `.claude-flow/config.json` still fails in developer mode (ak writes that file).
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/real-state-tripwire.test.mjs`.
- [ ] **Step 3: Implement.** Re-check the Ruflo path in the newest Ruflo inside the support window before the PR.
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/run-tests-runner.test.mjs tests/kit/home-sandbox-tripwire.test.mjs`.
- [ ] **Step 5: Commit** (both files).

### Task 8: 13a — prove `ak x daemon-gc` and `ak setup` re-record evidence after a repair

**Commit:** `test(evidence): prove ak x daemon-gc and ak setup re-record evidence after a repair`

**Files:**

- Modify: `src/commands/x/daemon-gc.mjs:35-58` — `run({ flags, deps = {} })`; `const { list, reap: reapFn } = { list: listDaemons, reap, ...deps.daemonLifecycle }` (B9-R15); behaviour unchanged.
- Modify: `src/commands/setup.mjs:384-408` — `export async function installEnabledAbsentHosts(cfg, flags, lifecycle = {})` with `const { installState, install, collectFacts } = { installState: hostInstallState, install: installHost, collectFacts: collectIntegrationFacts, ...lifecycle }`; `run_machine` (`:470-482`) passes `deps?.hostLifecycle` (add `deps` to its parameters).
- Test: `tests/kit/daemon-gc-rerecord.test.mjs`, `tests/kit/setup-host-rerecord.test.mjs` (new; `setup-command.test.mjs` stays untouched here).

- [ ] **Step 1: Write the failing tests.** daemon-gc: `list` spy returns one stale daemon, `reap` spy returns `[{ pid, killed: true }]`, `flags: { kill: true }` → `list` called twice, the second with `{ refresh: true, record: true, source: 'daemon-gc' }`; `killed: false` → called once; list-only run → once; nothing reaches `ps` (spies only). setup: `installState` returns `{ method: 'absent' }` then `{ method: 'npm', version: 'x' }`, `install` returns `{ ok: true, detail }`, `flags: { yes: true }`, a cfg enabling one host → `installState` second call `{ refresh: true, record: true, source: 'setup' }` and `collectFacts` called once with `{ cfg, refresh: true, record: true, source: 'setup' }`; `install` `{ ok: false }` → neither re-record call. Run in `sandboxHome()`; `ask` is bypassed by `yes`.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/daemon-gc-rerecord.test.mjs tests/kit/setup-host-rerecord.test.mjs` — FAIL (no seam: the real `ps`/installers would be reached, so the test asserts the seam exists first).
- [ ] **Step 3: Implement** the two seams only.
- [ ] **Step 4: Run to verify it passes;** mutation-check each re-record line (remove it → its test fails; revert); plus `env -u FORCE_COLOR node --test tests/kit/setup-command.test.mjs tests/kit/setup-host-flags.test.mjs tests/kit/sync-host-repair.test.mjs tests/kit/sync-daemon-repair.test.mjs`. Then the gate set (branch gate #1).
- [ ] **Step 5: Commit** (four files).

### Task 9: 13b — durable references instead of task and fix-round labels

**Commit:** `test(comments): replace task and fix-round labels with durable references`

**Files:**

- Create: `tests/kit/comment-label-guard.test.mjs` — scans `src/**`, `scripts/**`, `bin/**`, `tests/**` (`.mjs`, `.cjs`, `.js`) with B9-R16's patterns; skips `src/lib/hook-audit/agentic-dependency-constraints.json`; allowlist by exact path: `src/commands/x/verify.mjs`, `src/lib/dashboard-server.mjs`, `tests/dashboard.test.cjs`, `tests/kit/dashboard-status-cost.test.mjs`, `tests/kit/status-command.test.mjs`, `tests/kit/sync-command.test.mjs`, `tests/kit/usage-index.test.mjs`, `tests/kit/verify-command.test.mjs`, `tests/kit/helpers/dashboard-child-server.mjs`. An allowlisted path that does not exist is ignored (6b removes `x/verify.mjs` and `verify-command.test.mjs`, so the rebase must not fail on the allowlist itself). The failure lists `file:line`.
- Modify (every hit outside the allowlist, from the grep at `b84b5a7e`): `src/commands/status/sections/ruflo-components.mjs:4`, `src/lib/aqe-store-merge.mjs:30,42`, `src/lib/dashboard/client/usage-rhythm.mjs:6`, `src/lib/dashboard/session-security.mjs:38`, `src/lib/ruflo-components/snapshot.mjs:233`, `src/lib/usage-parsers.mjs:1006`; `tests/helpers/spawn-guard.mjs:4,44`; `tests/kit/helpers/home-sandbox.mjs:221`; `tests/kit/{ak-launcher-evidence,codex-mcp-convergence,daemon-sweep-evidence,daemons-status,dashboard-ruflo-components,dashboard-status-inprocess,dashboard-usage-telemetry,deja-vu-lifecycle,doc-citations,heal-natives,host-executable,host-setup-evidence,mcp-scopes,natives-runtime,paths-global-root-evidence,providers-status-section,ruflo-components-snapshot,ruflo-daemon-config,setup-command,status-version-drift-refresh,status-zero-spawn,sync-daemon-repair,sync-host-repair,trust-manifest,uninstall-command}.test.mjs`. Re-run the guard for the live list; do not edit an allowlisted file.

**How to rewrite:** say what the rule is, then cite where it is decided — the ADR (e.g. "ADR-0063 Ruling B"), the audit-record decision or section, or the pull request that shipped it (`#252`). If nothing durable states it, describe the behaviour plainly with no citation. Never change code, only comments and test-title text that is a label.

- [ ] **Step 1: Write the guard; run it to verify it fails** — `env -u FORCE_COLOR node --test tests/kit/comment-label-guard.test.mjs` lists every hit.
- [ ] **Step 2: Rewrite** until the list is empty. Also run the guard read-only against `../agentic-kit-6b` (copy it to the scratchpad and point its root there) and list in the report the files that would fail after a rebase (expected: `quota-codex-presence`, `quota`, `usage-limits-empty-state` unless 6b's Task 14 de-labels them).
- [ ] **Step 3: Run** the guard plus every modified test file (`env -u FORCE_COLOR node --test <each>`), `npx eslint` on the modified files, and `npx tsc -p tsconfig.json`.
- [ ] **Step 4: Commit** (the guard and every modified file by name).

### Task 10: Item 12 analysis — how temp folders leak and how a run root is proven abandoned

**Commit:** `docs(research): how test temp folders leak and how a run root is proven abandoned`

**Files:** Create `docs/research/2026-09-28-test-temp-folder-cleanup.md`. No code.

The document answers, each with evidence (file:line, commands run and their trimmed output, OS or Node documentation links):

1. **Who leaks on failure paths.** Static census of `tests/**`: every temp-folder creator (`mkdtemp`, `mkdtempSync`, `tempDir`, `sandboxHome`, `usePrivateTmpdir`, the `tools` helper in `home-sandbox.mjs:103-121`) classified as: cleanup registered before any assertion (safe); cleanup only on the success path; module-level creation with an `after()` that a killed process never runs; a path outside `os.tmpdir()` (hardcoded `/tmp`: `tests/kit/dashboard-live-source.test.mjs:7,13` — check whether they create anything); a spawned child given a temp base outside the run root. Trace each of the 14 post-runner leaks (premise table, item 12) to its test file and say why its cleanup did not run.
2. **Concurrent gate runs.** Sibling worktrees share `os.tmpdir()`; each run root is `mkdtemp`-unique; list the race windows (root created before its owner record; owner finishing while another run inspects it; the old runner in `../agentic-kit-6b` making roots with no owner) and how B9-R3 closes each.
3. **Proving a root abandoned.** Evaluate B9-R5's candidates A, B and C against its three criteria on macOS, Linux and Windows. Include one experiment in a sandbox (`T=$(mktemp -d "$SCRATCH/ak-b9-orphan.XXXXXX")`, `TMPDIR=$T/tmp`): start `node scripts/run-tests.mjs exec -- <script that sleeps 60 s>`, kill **only** the runner (`kill -KILL <runner pid>`), and show the child survives with its `TMPDIR` inside the root (`ps -o pid,ppid,pgid,command`); then stop the child by its literal pid. Measure each candidate's probe cost (`process.kill(pid, 0)`, `ps -o lstart=`, `/proc`, `lsof +D`, one PowerShell CIM query). Decide one candidate per platform; if none meets criterion (1) on a platform, that platform lists and never collects.
4. **Windows file locks.** A live process's cwd or open handle blocks removal (`EBUSY`/`EPERM`/`ENOTEMPTY`); `fs.rmSync` `maxRetries`/`retryDelay` semantics (Node docs); a partial recursive removal is possible on Windows, so the proof must come **before** removal and a removal error keeps the root and reports it.
5. **Focused runs.** Confirm B9-R7: which Node 22.22.3 and 26 flags or config files could inject setup into a plain `node --test`, and whether any is read by default. Measure `run-tests.mjs exec` overhead (tripwire snapshot) for one test file.
6. **The backlog.** The classification rule Task 13 uses (Task 13's section) and current counts by prefix.

End with **Decisions for Tasks 11–13**: the chosen candidate per platform with its proof argument, the owner-record fields, and any change to B9-R1…R8 (a change to a ruling is escalated to the controller before Task 11 starts).

- [ ] **Step 1:** Write the document; scratch folders listed by literal path in the report.
- [ ] **Step 2:** `npx markdownlint-cli2 docs/research/2026-09-28-test-temp-folder-cleanup.md` and `env -u FORCE_COLOR node --test tests/kit/doc-citations.test.mjs`.
- [ ] **Step 3: Commit** (the document).

### Task 11: Item 12 — owner records, a safe removal predicate, and collection after a complete run

**Commit:** `fix(test-runner): collect run roots whose owner is proven gone, after a complete run`

**Files:**

- Create: `scripts/run-roots.mjs` (builtin-only, like `real-state-tripwire.mjs`; must never import `src/`).
- Modify: `scripts/run-tests.mjs:39-72` (`runGuarded`), `:95-106` (`main`).
- Test: `tests/kit/run-roots.test.mjs` (new; unit tests with injected probes), `tests/kit/run-tests-runner.test.mjs` (spawned-runner cases).
- Docs: `AGENTS.md:284-302` (the runner paragraph: owner record, collection after a complete run, the refusals, B9-R3's listed roots).

**Interfaces (Produces — Task 12 and 13 rely on these names):**

```js
export const RUN_ROOT_NAME = /^ak-suite-[A-Za-z0-9]{6}$/;
export const OWNER_FILE = '.ak-suite-owner.json';
export const IGNORED_IN_ROOT = new Set(['node-compile-cache', OWNER_FILE]); // + '.ak-suite-pids' if Task 10 picks C
/** { schema: 1, pid, startedAt, hostname, uid: number|null, platform } (+ fields Task 10 adds) */
export function ownerRecord({ pid = process.pid, now = Date.now(), hostname = os.hostname(), uid, platform = process.platform } = {});
export function writeOwner(root, record);          // write <root>/.ak-suite-owner.json.tmp, then rename
export function readOwner(root);                    // → record | null (missing, invalid or wrong schema)
export function unsafeTempBase(tmpdir, homedir);    // → reason string | null (tmpdir is home or a filesystem root)
export function removableRunRoot(dir, { tmpdir, homedir, uid, requireOwner }); // → { ok: true } | { ok: false, reason }
export function proveAbandoned(root, owner, probes); // → { abandoned: boolean, reason: string }
export function collectAbandonedRoots({ tmpdir, selfRoot, homedir, uid, probes, log }); // → { removed: string[], kept: Array<{ path, reason }> }
export function defaultProbes(platform = process.platform); // the Task 10 choice: { alive(pid), startedAfter(pid, ms), ... }
```

Everything is synchronous (`spawnSync` for `ps`/`lsof`/PowerShell) so `runGuarded` stays synchronous. If Task 10 picks candidate A, `runGuarded` becomes async (spawn with `detached: true`, forward SIGINT/SIGTERM to the group) and `main` awaits it; the tests below are unchanged.

**`runGuarded` after this task:** (1) `unsafeTempBase(realpath(os.tmpdir()), homedir)` → log and return 2 before creating anything; (2) create the root, then `writeOwner` immediately; (3) run the commands as today; (4) leftovers ignore `IGNORED_IN_ROOT`; (5) remove the own root through `removableRunRoot(..., { requireOwner: false })`; (6) `collectAbandonedRoots` over the real path of the **parent** `os.tmpdir()` (not the child's), logging `removed abandoned run root <path>` and `kept run root <path>: <reason>`; (7) return the exit code as today (B9-R2).

- [ ] **Step 1: Write the failing tests.** `run-roots.test.mjs` (in a `tempDir`, probes injected, no real process table):

```js
test('a root whose owner is alive is kept', ...);
test('a root whose owner is dead and has no live users is removed', ...);
test('a dead owner with a live user of the run (per the chosen mechanism) is kept', ...);
test('an alive pid that started after the owner record is a different process (B9-R6)', ...);
test('no owner file, an invalid owner file, another hostname or another uid: kept and listed (B9-R3)', ...);
test('a symlink named ak-suite-XXXXXX and a name that does not match are never touched', ...);
test('the own root and a root outside tmpdir are never collected', ...);
test('unsafeTempBase: the home folder and a filesystem root are refused (POSIX and win32 flavours)', ...);
test('a removal error keeps the root and reports it (simulated EBUSY)', ...);
```

`run-tests-runner.test.mjs` (spawned runner, `spawnEnv(home)` so its temp base is `<home>/tmp`): `TMPDIR` = the sandbox home → exit 2 with the message and nothing created; a planted sibling `ak-suite-AAAAAA` with an owner record naming a dead pid (spawn and reap a short-lived node child to get one) and a `startedAt` taken before that child started (so a reused pid would still be caught by B9-R6's start-time rule, not by luck) is removed after a clean `exec` run, and a planted sibling with the runner test's own live pid is kept; the owner file never appears in the leftover list; the run's exit code is unchanged by collection.

- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/run-roots.test.mjs tests/kit/run-tests-runner.test.mjs`.
- [ ] **Step 3: Implement** (`scripts/run-roots.mjs`, then `runGuarded`, then `AGENTS.md`).
- [ ] **Step 4: Run to verify it passes,** plus `env -u FORCE_COLOR node --test tests/kit/real-state-tripwire.test.mjs tests/kit/temp-dir-helper.test.mjs`, and one real `node scripts/run-tests.mjs exec -- --test tests/kit/run-roots.test.mjs`: its log lists the three legacy roots as kept ("no owner record") and removes nothing else.
- [ ] **Step 5: Commit** (`scripts/run-roots.mjs`, `scripts/run-tests.mjs`, both tests, `AGENTS.md` after the injection check in Global Constraints; `git diff --cached AGENTS.md` shows only this task's paragraph).

### Task 12: Item 12 — focused runs, and the exit proof

**Commit:** `feat(test-runner): focused runs get their own run root, leftover report and collection`

**Files:**

- Modify: `scripts/run-tests.mjs` — `main`: `focus <files…>` → `runGuarded([['--test', ...files]])`, usage error without files; usage line names `unit|ui|exec|focus`.
- Test: `tests/kit/run-tests-runner.test.mjs` (focus cases + the exit proof).
- Docs: `AGENTS.md:268-272` ("One focused suite" becomes `node scripts/run-tests.mjs focus tests/kit/<file>.test.mjs`; one sentence that a plain `node --test` is unguarded, B9-R7).

- [ ] **Step 1: Write the failing tests.** (a) `focus` with a passing test file → exit 0; a test file that leaks a `mkdtempSync` folder → exit 4 naming it; no files → exit 2. (b) **Exit proof** (POSIX real processes; Windows per Task 10's choice or skipped with the reason): in a sandbox temp base, record its listing; start run 1 (`exec` a script that writes its pid to a file and sleeps); wait for the owner file and the child pid; kill **only** the runner → root remains; run 2 (a clean `focus` run) keeps it and says why ("a process of that run is alive", or on a list-only platform per B9-R5 "cannot prove"); kill the child by its recorded pid (and in `t.after`, whatever happens, kill it again, so the test never leaves an orphan); run 3 removes it; the temp base's listing equals the first listing. A concurrently live run (a fourth runner sleeping, started before run 3) keeps its root through run 3.
- [ ] **Step 2: Run to verify it fails.** `env -u FORCE_COLOR node --test tests/kit/run-tests-runner.test.mjs`.
- [ ] **Step 3: Implement** the `focus` mode and the docs.
- [ ] **Step 4: Run to verify it passes,** then `node scripts/run-tests.mjs focus tests/kit/run-roots.test.mjs` and the gate set (branch gate #2). From here on, focused runs in this branch use `node scripts/run-tests.mjs focus <file>`.
- [ ] **Step 5: Commit** (both files and `AGENTS.md`, after the injection check in Global Constraints; `git diff --cached AGENTS.md` shows only this task's lines).

**Acceptance (program plan exit):** a full run and a focused run each leave the shared temp folder unchanged, including after an interrupted run — shown by the exit-proof test and by one real `unit` run whose log names every root it removed or kept.

### Task 13: Item 12 — the backlog list (report only, no commit, no deletion code)

**Deliverables** (in the main checkout, `.superpowers/sdd/2026-09-26-remediation-program/reports/`): `b9-temp-backlog-paths.txt` (one literal absolute path per line, sectioned) and the task report with the scratch script's full source, the criteria, per-prefix counts and per-prefix test files.

**Run it last** (after Task 12 and after the controller's final focused runs), read-only:

- Candidates: direct children of the real path of `os.tmpdir()` as a plain shell sees it (`node -p "require('os').tmpdir()"`), basename starting `ak-`, owned by the current user, not a symbolic link.
- Excluded, and counted separately: `ak-suite-*` roots with a valid owner record (Task 11 handles them); `ak-sync-preview-npm-*` (6b product code); every path under the temp base that appears in **one** `lsof -nP -Fn` snapshot; anything modified in the last 24 hours (another worktree's run may still use it); any basename that no literal temp-folder prefix in `tests/**` explains (listed in an "unattributed" section for the maintainer's judgment, not in the removal list).
- Sections: **A** — last modified before the guarded runner landed (2026-09-27 12:01 local, commit `a0b75494`); **B** — after it (focused-run leaks); **C** — legacy `ak-suite-*` roots without an owner record.
- The report states the maintainer's own rule beside the list (absolute paths only; none is directly under the home folder or `/`), and that nothing was removed.
- A reviewer re-derives the per-section counts independently from the same criteria before the list is handed over.

### Task 14: Record Branch 9, align the docs, gate

**Commit:** `docs(audit): record Branch 9's follow-ups in the audit record`

**Files:** `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md` — in "Implementation status", one short entry each: M1b (fixed, B9-R9), N5 (the census and its outcome), item 7 (what is pruned and what is not), item 9, item 12 (owner records, collection, `focus`, the backlog list handed over), item 13 (a, b, c, d; what waits for 6b); mark M1b "still open" (`:1305`) and the "ADR index" and "Status wording" bullets as waiting for 6b.

- [ ] **Step 1:** Re-read ADR-0052, ADR-0058, `docs/ddd/integration-management.md`, `docs/USAGE-SCORECARD-METRICS.md`, `AGENTS.md` and the audit record against the code; list any sentence the branch contradicts; confirm every Deferred doc sentence has its exact text below.
- [ ] **Step 2:** Edit the audit record.
- [ ] **Step 3:** `env -u FORCE_COLOR node --test tests/kit/doc-citations.test.mjs tests/kit/ga-surface-guard.test.mjs tests/kit/comment-label-guard.test.mjs tests/kit/xdg-relative.test.mjs && npx markdownlint-cli2`, the internal link check CI runs, then the full gate set (branch gate #3) with the real-state tripwire; report the tripwire output and the runner's removed/kept lines verbatim.
- [ ] **Step 4: Commit.**

---

## Pre-flight: shared files and interfaces (Branch 9)

Every Branch 9 file was checked against the **6b-owned files** table: none appears there.

| Pair / task | Shared file or interface | Finding |
|---|---|---|
| 2 → 3 | `context-host-card.mjs` wording | Task 3 outcome B may cite Task 2's label; Task 3 does not edit the card |
| 10 → 11 → 12 | `scripts/run-roots.mjs`, `scripts/run-tests.mjs`, `run-tests-runner.test.mjs`, `AGENTS.md` | Sequential; Task 10's decisions fix `defaultProbes` and whether `runGuarded` turns async |
| 7 ↔ 11 | `scripts/real-state-tripwire.mjs` is imported by `run-tests.mjs` | Task 7 changes only `CONCURRENT_WRITERS`; no interface change |
| 6 ↔ 9 | `paths-global-root-evidence.test.mjs`, `uninstall-command.test.mjs` | Task 6 only runs them; Task 9 edits their label comments; order 6 → 9 |
| 8 ↔ 9 | `setup-command.test.mjs`, `sync-*-repair.test.mjs` | Task 8 only runs them (its tests are new files); Task 9 edits their comments |
| 4 | `owned-env-projection.mjs` `keepBackups` | Unchanged for `aqe-pin`; new prune path only after a write |
| 12 → 13 | the census | Task 13 runs after the branch's last focused runs |
| 9 ↔ 6b | allowlisted 6b files | The guard never forces an edit of a 6b file; removal of the allowlist is Deferred |
| 14 ↔ all | audit record | Written last, from the code |

| Task | Internal consistency check |
|---|---|
| 1 | History is read once per `coverage()`; a later `published` summary wins; the row shape equals the in-process failed row |
| 2 | Only `parse-yield-*` reasons change wording; the renderer stays self-contained |
| 3 | No `buildIndex`, no path or content printed; no schema bump (B9-R10) |
| 4 | Never removes the copy just made; the four conditions all hold; no recursive removal; converged and dry runs touch nothing |
| 5 | The contract assertion ties the renderer's pattern to `RUFLO_PIN_NOTE` |
| 6 | One helper; the template and the name list excluded (B9-R14); the relative reproduction creates nothing |
| 7 | Strict mode still fails on all three paths |
| 8 | Seams default to today's imports; no test reaches `ps` or an installer |
| 9 | Comments only; allowlist exact paths; the registry JSON excluded |
| 10 | A decision per platform, with its proof argument |
| 11 | Builtin-only; B9-R2, R3, R4 and R6 each have a test |
| 12 | The test never leaves an orphan; the listing is unchanged at the end |
| 13 | No deletion code; the list excludes anything a live run could use |

## Review Focus (Branch 9)

- **A live run's folder removed.** Sibling worktrees run gates and focused tests against the same `os.tmpdir()` all day (6b's agents do right now). Expect: a root is removed only when its owner record proves every process of that run gone; roots from the old runner are never touched. Pinned by Task 11's unit cases and Task 12's exit proof (the concurrently live fourth run).
- **Files removed from a user's configuration.** Task 4 unlinks files in `~/.claude`, `~/.codex` and project `.claude` folders. Expect: only copies the new copy plus the receipt make redundant, never on a dry run or a converged file, never a symlink, another user's file, or anything directly in the home folder. Pinned by Task 4's tests; no task runs a real `ak sync`.
- **Real state written by a test.** Task 3 reads `~/.codex/sessions` (read-only scratch script, never `buildIndex`); Task 6's reproduction runs a 6b-owned test from a scratch folder; every other test runs in a sandbox. Expect: the tripwire clean after each gate.
- **Windows.** Unlink of a copy an editor holds open, removal of a run root with an open handle, process identity through PowerShell, and `path.win32` in `xdgBase`. Expect: a failed removal keeps and reports. CI on the pushed branch (M-9) is the only Windows evidence; the implementer does not claim Windows behaviour from macOS runs.
- **Two branches meeting.** Whichever of 6b and Branch 9 merges second rebases: the Task 9 allowlist, the Deferred items, and 6b's three newly labelled test files are the known collision points. Expect: no conflict in any file (disjoint sets); the label guard may fail on 6b's new files until 6b's Task 14 runs.
- **A dependency that moves.** Before the PR, re-check Ruflo's `proven-config` paths (Task 7) and the Brain hook contract (OQ-1) against the newest releases inside the support window.

## Deferred until 6b merges

Each item starts from `main` after 6b's squash merge, re-verifies its file:line, and runs test-first like the tasks above. It can run as a short follow-up on this branch (rebased) or a small branch; the controller decides.

| Item | 6b-owned file(s) it needs | Overlap type | Plan when unblocked |
|---|---|---|---|
| 2 (N4 acknowledgment) | `status/sections/project-memory.mjs` (6b Task 13 edits `:5`), `ruflo-memory-contract.mjs` (6b changed `twoStoreMessage`), a CLI entry in `bin/agentic-kit.mjs` or a 6b-owned command, the dashboard row | Real logic overlap | One per-machine acknowledgment store shared with item 6 (`<state>/agentic-kit/acknowledgments.json`, integrity-sealed like the scan history): an entry is `{ id, scope, fingerprint, at }` with id `memory-two-stores`, scope the real project root, and fingerprint a sha256 of the facts that give the warning its meaning (which store files exist, the installed Ruflo version, whether `memoryRoutingObserved` holds). An acknowledged, unchanged state renders `info` ("acknowledged <date>: …"); any fingerprint change renders `warn` again. The CLI spelling follows 6b's vocabulary (decided in that plan, e.g. `ak status --acknowledge memory-two-stores`); the stores stay separate (ruvnet/ruflo#2786) |
| 6 (hook-contract acknowledgment) | `status/sections/ruvnet-brain.mjs` (6b changed), the CLI entry | Real logic overlap + OQ-1 | Only if OQ-1 says build: the same store, fingerprint = `brainHookDelta(hooks)`'s added/removed/changed keys (`brain-hook-contract.mjs:80-100`); ak's `REVIEWED` list never changes; any new hook change warns again |
| 10 (ADR index) | `docs/adr/README.md` (6b Task 14 and 6c-5 refresh rows) | Real doc overlap | **Recommended: fold into 6b Task 14** (the same precedent as the ADR-0063 sentence). Otherwise: extend the table from 0053 through the newest ADR, one row each (0053, 0054, 0055, 0058, 0060, 0061, 0062, 0063), status from each ADR's header, keeping the bullets/sections below |
| 11 (status wording) | `ruflo-memory.mjs` (6b Task 13 edits comments at `:8,20`; the logic is at `:77-86`), renderer `project-memory.mjs:186` | Comment-only overlap in `ruflo-memory.mjs`; the renderer needs no change | `rufloMemoryLocation` keeps both reasons and composes one phrase when both are unsuitable, so "this folder is <reason>" reads e.g. "inside ~/.codex, a tool's own folder, in a repository whose root is the home folder"; tests in a new file. The controller may pull this forward if a comment-only overlap is acceptable |
| 13a (`x/host.mjs`) | `src/commands/x/host.mjs` (6b Tasks 5, 6, 12; Task 12 restructures `pick` next to the re-record at `:797-804`) | Real logic overlap | Seam `installPickAbsentHosts(..., lifecycle)` like Task 8, test in a new file |
| 13b (labels in 6b files) | the Task 9 allowlist | Real | De-label the allowlisted files that still carry labels, then empty the allowlist |
| 13 (ledger 385) | `src/lib/live-checks.mjs`, `tests/kit/live-checks.test.mjs` | Real | Deja-vu's line after a skipped check says "skipped", never "passed"; temp-dir coverage for the checks that create one |
| Doc sentences | `docs/UPGRADING.md` (beside `:85`), `docs/SETUP.md` (the `.claude/settings.json` row, `:125`) | Real doc overlap | "ak removes an older safety copy of a settings file only when the copy it just made and its receipt already hold everything the older one held (see ADR-0058)." Plus any ADR-0048 or `MAINTENANCE.md` sentence Task 1 finds contradicted, and any `DASHBOARD.md` sentence Task 3 finds contradicted, with exact text in those tasks' reports |

## Ledger candidates not in this plan (the controller's call)

Queued "for Branch 9" in the ledger but not in the program plan's item list or M-8's scope; listed so they are not lost:

- `scripts/run-tests.mjs` strips developer `AQE_EMBEDDER_*` (and similar tool variables) from the suite env (ledger line 244). It shares `run-tests.mjs` with Tasks 11–12; if added, it runs after Task 12.
- `codex-mcp.mjs:90` hint should not say `aqe platform setup` (agentic-qe#757) (line 244).
- Three `ruflo-components` rows "partial — missing: Codex hooks" with no fix (lines 195, 244).
- List the real `~/.agentic-qe` home store (lines 215, 244).
- Serialized-identity inode sites still using Number (line 113: `fs-port:69/:139`, `store:205`, `engine:31`, `partitions:15/113`, `jsonl-tailer:85`, `transcript-streams:158`, `host-alignment:67`, `host-health-evidence:40`).
- Five stale doc-cited threads and `HOST-SUPPORT.md` risk lines (line 120).
- Branch 0 P6 observations (line 34).

## Added scope (maintainer, 2026-09-28)

These five items join this branch. Each task below verifies its premise first, then works test-first.

- **N-1 — Busy rule (#574 → #240). Now.**
  - Build the #240 reproduction in a disposable environment: `aqe init --minimal`, with npm prefix and `MISE_*` inside `$T`. Hold the store's RVF lock with a live process, then start AQE and record whether `FsyncFailed`/`0x0303` still follows the live-lock warning.
  - Run it on macOS locally, against agentic-qe 3.14.4.
  - Run it on Linux through a CI job on this branch's pushed PR (the controller holds standing push authority). A `workflow_dispatch` or a job step in `ci.yml` is fine, as long as it's removed or gated before merge.
  - Only if neither platform shows `FsyncFailed`: remove the temporary busy rule in `src/lib/aqe-readiness.mjs` (test-first), and update the registry entry `proffesor-for-testing/agentic-qe#574` (`adjustment`, `status`, and a dated history note) and ADR-0062 if it cites the rule. The controller closes #240 after merge, with the evidence.
  - Otherwise: keep the rule and post the evidence to #240. The text goes to the maintainer first only if it's an upstream post; #240 is our own issue.
- **N-2 — `docs/HOST-SUPPORT.md` (~:175-177). Now.**
  - Remove the risk links for agentic-qe #528 and #532, and mark both as adopted at 3.14.4.
  - Reword the #535 link to name only what still fails.
  - Verify each against agentic-qe 3.14.4 release notes and the registry before writing.
- **N-3 — ruflo#2885 trace hook. After 6b merges** (6b edits `nightly.yml`).
  - Add vidaunited's `trace-ort.mjs` hook to the nightly macOS live step, and capture its log as an artifact.
  - The post on ruflo#2885 is an upstream post: the controller shows the maintainer the exact text before posting.
- **N-4 — CI timeout. Now.**
  - Add `timeout-minutes` to the `test` job in `.github/workflows/ci.yml`, so a stuck runner fails instead of hanging.
  - Size the value from recent run durations (the Windows test jobs take about 9–11 min), with headroom.
- **N-5 — Upstream-watch minors deferred from PR #253 (M7, M8, M10, plus 12 smaller). After 6b merges** (6b edits the constraint registry).
  - The list comes from the maintainer or the session that owned #253. It's not on disk here.
  - Scope is exactly these minors. The rest of the upstream watch stays as the maintainer left it.

## Open questions for the maintainer

**OQ-1 — Item 6 (a per-machine acknowledgment for hook-contract changes).**

- **The situation.** ak keeps an exact list of reviewed RuvNet Brain hooks and warns when a Brain release changes them (Decision 4 of the 2026-09-26 audit).
- **The problem.** Item 6 asks for a per-machine acknowledgment. That is Decision 4's option C ("B plus a per-machine 'I reviewed this' acknowledgment bound to the exact hook fingerprint"), which you did not choose on 2026-09-26 (you chose B: hold 4.3.28, explain, ask upstream for `offBehavior: "silence"`) and reaffirmed on 2026-09-27. Brain 4.3.34, installed now, still declares `capacity-aware-parallel-work` with `offBehavior: "run"` (`hooks/hook-contracts.json:242-251`), so Decision 4's condition is not met.
- **What the user sees.** A permanent amber Brain row with no action they can take.
- **The choices.** (A) Build it after 6b merges, sharing N4's acknowledgment store: you record on this machine that you reviewed this exact hook set; the row becomes information until the hooks change again; ak's reviewed list never changes. (B) Drop item 6; the warning stays until upstream ships `silence`.
- **Recommendation: A**, because the program plan listed it as a follow-up after Decision 4, it answers the same "permanent warning with no action" problem N4 fixes, and the fingerprint makes any further change warn again. Nothing is built before 6b merges either way.

## Closing notes for the controller

- Switch the task-brief template's focused command to `node scripts/run-tests.mjs focus <file>` once Task 12 lands (the common brief lives outside the repository).
- Items 4 (L4b), 5 (F1) and 8 (live observations) become GitHub issues under M-8, with the maintainer's go-ahead to post.
- Recommend folding item 10 into 6b Task 14.
- Branch 9's scratch folders (Task 6's `ak-b9-xdg.*`, Task 10's `ak-b9-orphan.*`, gate folders) are reported by literal path for the maintainer; Task 13's list is separate and removes nothing.
