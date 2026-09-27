# Branch 5: AQE store integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One AQE store per project, whatever folder a command, hook or MCP server starts in; the existing stray AQE stores merged into it safely and then archived; `ak x verify` checking providers from the project root without writing; every plain npx spelling of AQE's server recognized; the AQE solver heal that installs nothing removed; no failure evidence recorded for an unmanaged AQE embedding backend; "embedder verified" instead of claims about pattern search (agentic-qe#754); agentic-qe#574 named as the busy rule's driver; constraints #628, #654 and #655 sunset after their conformance runs.

**Architecture:** Four slices in the worktree `../agentic-kit-b5`, each by a fresh implementer, one unit commit per behavior change, test first. AQE facts come from the installed 3.14.4 source (`AQE/` = `$(npm root -g)/agentic-qe`). Store-touching behavior is proven only in disposable environments; the only real-machine step for implementers is a read-only preview on copies. The real merge of the nine stray stores is the controller's pass with the released build.

**Spec:** [program plan, Branch 5](2026-09-26-remediation-program.md#branch-5-fixaqe-store-integrity); [audit record](../../audits/2026-09-26-issues-237-238-239-verification-and-decisions.md) Addendum 3 items 2, 3, 5, 6, decisions 3, 7, 10 (13 landed in #248, so its open decision is dropped); the SDD ledger's investigations `inv-aqe-audit-chain` (agentic-qe#753) and `inv-aqe-rvf-flag-vector-space` (agentic-qe#754); `briefs/common.md`.

## Maintainer decisions (2026-09-27)

- **B5-D1 pin scope: A.** Pin `AQE_PROJECT_ROOT` and an absolute `AQE_MEMORY_PATH` in `.claude/settings.local.json` `env`, `.mcp.json` `mcpServers.agentic-qe.env` (recognized transports only) and the project `.codex/config.toml` `[mcp_servers.agentic-qe.env]`, where AQE's own relative value is replaced under a receipt. The user-level `~/.codex/config.toml` registration is never pinned. Reason: `AQE/dist/learning/embedder-identity-store.js` `getMemoryDbPath()` uses `AQE_MEMORY_PATH` or `<cwd>/.agentic-qe/memory.db` and creates the folder; it never reads `AQE_PROJECT_ROOT` (only `dist/kernel/project-root.js` `findProjectRoot()` does).
- **B5-D2 merge entry: A.** Its own command, `ak x aqe-store merge` (dry run by default, `--yes` applies, `--json`); `ak x aqe-store status` previews. The stray-stores status row is a hand fix (`repair: 'manual'`) naming the command. Not a sync step.
- **B5-D3 live writer: A, no force.** Holders found by open file (macOS `lsof -Fpcn`, Linux `/proc/*/fd` with lsof fallback), checked before backup, before the real import and before archive; refuse and list each holder (PID and command). Windows: run only when the process census finds no Claude Code, Codex or OpenCode session for the project, and treat a failed folder rename (EBUSY/EPERM) as a holder for that stray. No `--force`.
- **B5-D4 archive: whole folder to ak state, keep.** Move each whole stray `.agentic-qe` folder to `<state>/agentic-kit/aqe-store-merge/<ISO>/archive/<slug>/.agentic-qe`, beside a `VACUUM INTO` backup of the root and a `receipt.json`. Audit-trail (`witness_chain`) rows are not imported (they stay in the archive with their `witness-keys/`). Kept until the user deletes it; TROUBLESHOOTING gives restore steps. Nothing ak writes may lie inside any `.agentic-qe` folder (`AQE/dist/kernel/unified-memory.js` restores any `memory*.db` over 1 MB it finds there when `memory.db` is missing).

## Global Constraints

- Never `pnpm` in the worktree; use `node --test`, `npx tsc -p tsconfig.json`, `npx eslint`, `npx markdownlint-cli2`, `node scripts/build-check.mjs`. Full runs go through `node scripts/run-tests.mjs unit|ui`.
- Commits: conventional, one unit each, failing run shown before the passing run; no `Co-Authored-By` or trailer-like last line; stage by name; never commit `.agentic-qe/`, `.swarm/`, `.claude-flow/`, `.harness/`.
- Deletion rule (`briefs/common.md`): implementers delete nothing and report scratch paths literally. Product code moves a stray folder only through the merge command after its checks.
- Real AQE stores are never opened by tests or implementers, not even read-only (opening a WAL database touches `-shm`). A preview first copies `memory.db`, `-wal`, `-shm` with `cp -p` into scratch.
- Disposable AQE runs: `env -i PATH="$PATH" TERM=dumb HOME="$T/home" TMPDIR="$T/tmp" AQE_PROJECT_ROOT="$T/proj" <cmd>` with `T=$(mktemp -d "$SCRATCH/ak-b5.XXXXXX")` (`env -i` also strips the maintainer's `AQE_*` exports); assert every created path lies in `$T`.
- Every registry edit bumps `lastVerifiedAt` and keeps each constraint's `nextRetestAt` on or after it; run `node --test tests/kit/upstream-watch-registry.test.mjs tests/kit/hook-upstream.test.mjs` before committing.
- An ADR a task changes gets Status, an `Updated` date and a one-line note in that task's docs commit. User-facing docs describe the current state only.
- Never push, open or comment on PRs or issues, or post upstream; upstream drafts go to the report only.

## Review Focus

- Another AQE process writing while the merge runs (agentic-qe#753): the merge refuses and lists holders; no force (Tasks 6.1, 6.2).
- A backup AQE restores by itself: every ak backup/archive lies outside every `.agentic-qe` (Task 6.2).
- A command started in a subfolder after the pin: no `<subfolder>/.agentic-qe`, with the endpoint embedder configured (Tasks 0.1, 4.1).
- A copied `.claude/settings.local.json` in another checkout: an absolute pin aimed at another root is flagged (Task 4.1).
- `ak x verify providers` from a subfolder: no new `.agentic-qe` there; results from the root (Task 5.1).

## Scope checked against the code (2026-09-27, agentic-qe 3.14.4, `main` 1c3c4d35)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Pin and list strays | Listing exists (`src/lib/project-memory.mjs:128-205`, `src/commands/status/sections/project-memory.mjs:80-81`); root pin alone incomplete | `AQE/dist/learning/embedder-identity-store.js:26-30,52-57`; `real-embeddings.js:12`; `project-root.js:43-44,59-62`; AQE init writes relative `AQE_MEMORY_PATH` (`init/settings-merge.js:142`, `platform-config-generator.js:147,188`), present in `.claude/settings.json:318`, `.codex/config.toml:10,18` |
| 2 | Merge, then archive | Feasible with `aqe brain export --db … --format jsonl` (read-only) and `aqe brain import --db … -i … [--dry-run]` (one transaction); import never initializes the kernel; 3.14.4 matches `qe_patterns` on the natural key (#748/#749) though agentic-qe#736 is open; imported `witness_chain` rows are appended unlinked; `kv_store` not exported | `AQE/dist/cli/brain-commands.js:27-45`, `integrations/ruvector/brain-shared.js:49,234-236,307-325,402-417`, `cli/handlers/brain-handler.js:120-147`; 9 real strays: `docker/`, `claude/`, `.claude/`, `.agentic-qe/.agentic-qe/`, `docs/`, `docs/archive/`, `docs/assets/`, `docs/research/v5/`, `claude/skills/ruflo-token-audit/scripts/` |
| 3 | Verify providers from root | `src/commands/x/verify.mjs` uses `process.cwd()` at :295, :300, :348-356, :364, :372, :379, :385-386; `aqe health` initializes `.agentic-qe` in its cwd | `AQE_MEMORY_BACKEND=memory` (`unified-memory.js:140-143`) to be checked in Task 5.1 |
| 4 | npx spellings | `src/lib/aqe-embedding-transport.mjs:11,29` accepts only `npx -y agentic-qe@latest mcp`; tests at `tests/kit/aqe-embedding-transport.test.mjs:38-40` assert false for plain spellings | audit item 5, choice A |
| 5 | Remove `healAqeSolver` (agentic-qe#617) | still wired: `src/lib/heal.mjs:180-196`, `src/commands/sync.mjs:342`, `src/commands/setup.mjs:365`; tests `tests/kit/heal-natives.test.mjs:596-640` | |
| 6 | Unmanaged backend evidence | `verifyAqe` records `onEvidence('aqe-embedding', …)` unconditionally (`verify.mjs:311`); `--live` gates it (`:605`) | |
| 7 | #754 wording | pass wording overclaims: `status/sections/aqe.mjs:34`, `src/lib/aqe-embedding-lifecycle.mjs:100`, `docs/AQE-EMBEDDINGS.md:49-58` | registry #754 `kitImpact` |
| 8 | #574 as busy-rule driver | ADR-0055:13, `src/lib/aqe-readiness.mjs:29-33`, `tests/kit/aqe-verification.test.mjs:12-13` name #719, which 3.14.4 carries while #574 is open | |
| 9 | Sunsets #628, #654, #655 | closed upstream; #628 has `tests/live/aqe-external-provider-transport.test.mjs` (inherits `process.env` at :306); #654/#655 have no conformance test; removal also empties `constraintIds` and updates `tests/kit/hook-upstream.test.mjs:66-72`, `tests/kit/hook-read-model.test.mjs:178-185`, `src/lib/hook-presentation.mjs:78-83` | `--codex-guidance` in 3.14.4 (`AQE/dist/cli/commands/platform.js:190`) |

## File structure

| File | Responsibility | Slice |
|---|---|---|
| `src/lib/aqe-embedding-transport.mjs` | npx spellings | A |
| `src/lib/heal.mjs`, `src/commands/sync.mjs`, `src/commands/setup.mjs` | solver heal removed | A |
| `src/commands/x/verify.mjs` | evidence gate; wording; providers from the root | A, B |
| `src/commands/status/sections/aqe.mjs`, `src/lib/aqe-embedding-lifecycle.mjs` | "embedder verified" | A |
| `src/lib/aqe-readiness.mjs` | #574 comment | A |
| `src/lib/aqe-project-pin.mjs` (new) | receipted absolute pin (both keys) in the three project files; mirrors `reconcileMemoryPin` (`src/lib/claude-env-projection.mjs:59-85`) | B |
| `src/commands/status/sections/memory-pin.mjs` | pin row (missing, foreign root) | B |
| `src/lib/aqe-store-holders.mjs` (new) | processes holding a store's files | C |
| `src/lib/aqe-store-merge.mjs` (new) | preview, writer check, backup, scratch rehearsal, apply, verify, archive, receipt | C |
| `src/commands/x/aqe-store.mjs` (new), `bin/agentic-kit.mjs` | `ak x aqe-store status\|merge [--dry-run] [--yes] [--json]` | C |
| `src/commands/status/sections/project-memory.mjs`, `src/lib/project-memory.mjs`, `src/lib/paths.mjs` (`aqeStoreMergeDir`) | stray row names the merge | C |
| `src/lib/hook-audit/agentic-dependency-constraints.json`, `src/lib/hook-presentation.mjs` | watch entries, sunsets | A, D |
| `tests/live/aqe-stop-hook-conformance.test.mjs`, `tests/live/aqe-codex-guidance-conformance.test.mjs` (new, opt-in) | #654 / #655 proofs | D |

---

## Slice 0: evidence before code (no commit; results to the slice report)

### Task 0.1: where a subfolder run creates a store, and what each pin closes

- [ ] Disposable project `$T/proj`: `git init`, `package.json`, `aqe init --auto`; subfolder `$T/proj/sub`. For each case record which `.agentic-qe` folders exist (`find "$T" -name .agentic-qe`) and whether `sub/.agentic-qe/memory.db` holds only `kv_store` (sqlite3 on a `cp -p` copy):
  - (a) no pin, `AQE_EMBEDDER_ENDPOINT=http://127.0.0.1:11434`, relative `AQE_MEMORY_PATH=.agentic-qe/memory.db`: `cd sub && aqe learning import -i pattern.json --json`, then `aqe health`;
  - (b) as (a) plus absolute `AQE_PROJECT_ROOT=$T/proj` only;
  - (c) as (b) plus absolute `AQE_MEMORY_PATH=$T/proj/.agentic-qe/memory.db`;
  - (d) as (a) without the endpoint.
- [ ] Expected from source: (a) creates and adopts `sub/.agentic-qe`; (b) creates a kv-only `sub/.agentic-qe/memory.db` but does not adopt it; (c) creates nothing in `sub`. Report actuals verbatim.
- [ ] Same with the hook shim: `node .claude/hooks/aqe-hook.cjs post-command --command x --json`, cwd `sub`, `CLAUDE_PROJECT_DIR=$T/proj` (`src/templates/aqe-lifecycle/aqe-hook.cjs:113-125`).

### Task 0.2: does 3.14.4 merge a store sharing patterns without pruning?

- [ ] Two disposable stores via `aqe init --auto`; add one learned pattern and one captured experience to the second. On copies: `aqe brain export --db B/memory.db --format jsonl -o exp`; `aqe brain import --db A/memory.db -i exp --dry-run`; then for real. Record imported/skipped/conflicts, counts (`qe_patterns`, `captured_experiences`, `witness_chain`), `PRAGMA integrity_check`, `PRAGMA foreign_key_check`.
- [ ] `aqe audit verify --chain audit --format json` on A before and after, with and without `DELETE FROM witness_chain` on B's copy first.
- [ ] Capture `sqlite3 A/memory.db .schema` to `tests/fixtures/aqe-store/schema-3.14.4.sql` (committed with Task 6.2).

### Task 0.3: who holds the real stores (read-only)

- [ ] `lsof -Fpcn -- <memory.db, -wal, -shm>` for the root and the 9 strays; PIDs and commands only.

---

## Slice A: independent fixes

### Task A.1: `fix(aqe): recognize every plain npx spelling of AQE's server`

**Files:** `src/lib/aqe-embedding-transport.mjs:9-30`; test `tests/kit/aqe-embedding-transport.test.mjs`.

- [ ] Failing test: flip :38-40 and add rows. Accepted: `npx agentic-qe mcp`, `npx -y agentic-qe mcp`, `npx --yes agentic-qe mcp`, `npx agentic-qe@latest mcp`, `npx -y agentic-qe@3.14.4 mcp`, `npx --yes agentic-qe@3.15.0-rc.1 mcp`, `npx.cmd --yes agentic-qe mcp`. Rejected: `npx -y agentic-qe@^3.14 mcp`, `npx -y agentic-qe@3 mcp`, `npx -y agentic-qe@next mcp`, `npx -y -y agentic-qe mcp`, `npx -y agentic-qe mcp --verbose`, `npx --package agentic-qe aqe mcp`, `npx -y @scope/agentic-qe mcp`.
- [ ] Run `node --test tests/kit/aqe-embedding-transport.test.mjs tests/kit/aqe-embedding-toml.test.mjs tests/kit/aqe-embedding-projection.test.mjs tests/kit/opencode-aqe-embedding.test.mjs`; show the failure.
- [ ] Implement: package `^agentic-qe(?:@(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?$`; args are an optional single `-y`/`--yes`, the package, `mcp`, nothing else. Update the header comment.
- [ ] Pass; commit.

### Task A.2: `refactor(heal): remove the AQE solver heal that never installs anything`

**Files:** `src/lib/heal.mjs:180-196`, `src/commands/sync.mjs:342`, `src/commands/setup.mjs:365`; tests `tests/kit/heal-natives.test.mjs:596-640`.

- [ ] Failing test: `heal.healAqeSolver` is `undefined`; the sync plan's `security` step lists no `aqe solver`; setup's machine-security output has no `aqe solver` line.
- [ ] Fail, implement, pass.
- [ ] Registry: agentic-qe#617 and #620 to `adopted` with a dated history note naming the removal proof (the tests above).
- [ ] Docs in the same commit: ADR-0023 `Updated` (solver fallback note is historical), `docs/UPGRADING.md`.
- [ ] Commit.

### Task A.3: `fix(verify): do not record failures of an unmanaged AQE backend`

**Files:** `src/commands/x/verify.mjs:293-316,603-606`; test `tests/kit/verify-command.test.mjs`.

- [ ] Failing test: with `cfg.aqeEmbedding = { mode: 'unmanaged' }` and a failing stubbed probe, no `aqe-embedding` evidence is recorded (via the `onEvidence` seam) and the result is still printed; with `mode: 'endpoint'` it records.
- [ ] One exported predicate `aqeEmbeddingManaged(cfg)` used at :311 and :605.
- [ ] Pass; commit.

### Task A.4: `fix(aqe): say the embedder is verified, not that pattern search works`

**Files:** `src/commands/status/sections/aqe.mjs:30-35`, `src/commands/x/verify.mjs:288`, `src/lib/aqe-embedding-lifecycle.mjs:100`; tests `tests/kit/aqe-embedding-conflict-row.test.mjs`, `tests/kit/status-aqe-drift.test.mjs`, `tests/kit/aqe-embedding-lifecycle.test.mjs`.

- [ ] Failing test: a passed row reads `embedder verified <age> (<source>); AQE pattern index binding unverified (agentic-qe#754); corpus compatibility unverified`; no `src/` surface says "pattern search working" or "semantic search ready"; the lifecycle detail reads `embedder verified (384 dimensions); AQE pattern index binding and existing corpus compatibility remain separate`.
- [ ] Fail, implement, pass.
- [ ] Docs: `docs/AQE-EMBEDDINGS.md:49-58` (a pass proves the embedder, not AQE's index; link agentic-qe#754); ADR-0055 `Updated`.
- [ ] Registry: #754 `kitImpact.files` gets the three source files.
- [ ] Commit.

### Task A.5: `docs(aqe): name agentic-qe#574 as the busy rule's removal condition`

**Files:** `docs/adr/0055-aqe-embedding-lifecycle.md:13`, `src/lib/aqe-readiness.mjs:9,29-33`, `tests/kit/aqe-verification.test.mjs:12-13`.

- [ ] Replace the #719 condition with: a released agentic-qe fixes agentic-qe#574 and that release is the kit floor; agentic-qe#719 (in 3.14.4) is a partial fix and does not remove it. No behavior change: show `node --test tests/kit/aqe-verification.test.mjs tests/kit/aqe-readiness.test.mjs` passing before and after; confirm `classifyAqeStartup` has no version gate 3.14.4 trips; correct the `<= 3.14.3` comment.
- [ ] Commit with an ADR-0055 `Updated` line.

---

## Slice B: the pin and verify from the root

### Task 4.1: `fix(aqe): pin AQE to the project root`

**Files:** create `src/lib/aqe-project-pin.mjs`; modify `src/commands/sync.mjs` (step beside the AQE embedding projection), `src/commands/setup.mjs`, `src/commands/status/sections/memory-pin.mjs`, `src/commands/status/sections/project-memory.mjs:80-81`; tests `tests/kit/aqe-project-pin.test.mjs` (new), `tests/kit/project-memory-status.test.mjs`.

**Interfaces:** `desiredAqePin(root)` → `{ AQE_PROJECT_ROOT: realpath(root), AQE_MEMORY_PATH: <realpath(root)>/.agentic-qe/memory.db }`. `reconcileAqePin(cfg, cwd, { dryRun })` → `{ ok, changed, findings }`, planned through `planOwnedEnv`/`applyOwnedEnv` (`src/lib/owned-env-projection.mjs:65,138`), receipt suffix `.agentic-kit-aqe-pin.json`, targets per B5-D1. Only inside `repoRoot(cwd)` and only when `projectAqeDir(root)` exists.

- [ ] Failing tests (temporary project): all three targets gain the absolute values with receipts, second run no change; AQE's own relative `AQE_MEMORY_PATH` in the project Codex env is replaced under the receipt (B5-D1); any other different value is a preserved conflict reported as a hand fix naming the file (decision 13's rule); a pin naming another root warns in the `memory-pin` row ("re-run ak sync in this checkout"); outside a repository or without `.agentic-qe` nothing is written; `ak uninstall` restores the receipted before-state; Windows paths via `path.win32`.
- [ ] Fail, implement, pass.
- [ ] Disposable proof: Task 0.1 cases (a)–(c) with the pin written by `node bin/agentic-kit.mjs sync` in the disposable project (`HOME`/`XDG_*` in `$T`); assert no `sub/.agentic-qe`.
- [ ] Commit.

### Task 5.1: `fix(verify): run provider checks from the project root without writing`

**Files:** `src/commands/x/verify.mjs:293-316,345-420` (export `verifyProviders({ cwd, runner })`; `root = repoRoot(cwd)`); test `tests/kit/verify-command.test.mjs`.

- [ ] Failing tests: from `<tmp-project>/sub`, `aqeRouterFile(root)` is read and a matching root file shows no drift; every stubbed `aqe`/`ruflo` call carries `cwd: root` and `env.AQE_PROJECT_ROOT === root`; no `sub/.agentic-qe` afterwards; outside a repository the project checks are skipped and say so; `verifyAqe`'s `scanRvf` and corpus path use `root`.
- [ ] If Task 0.1 shows `aqe health` still prints its billing section with `AQE_MEMORY_BACKEND=memory`, run it that way and assert no `root/.agentic-qe/memory.db*` changes size or mtime; otherwise keep the root and say "writes AQE's own health state to the project store".
- [ ] Fail, implement, pass; commit.

---

## Slice C: the merge

### Task 6.1: `feat(aqe): find the processes holding an AQE store`

**Files:** create `src/lib/aqe-store-holders.mjs` (reuse parsing from `src/lib/live/process-sessions.mjs:283-330`); test `tests/kit/aqe-store-holders.test.mjs`.

**Interface:** `storeHolders(files, { platform, runner, procRoot })` → `{ holders: [{ pid, command }], method: 'lsof'|'proc'|'census', complete }`. macOS lsof; Linux `/proc/*/fd` then lsof; Windows the host-session census for the project (B5-D3), `complete: false` for file-level certainty. The caller's own PID is excluded.

- [ ] Failing tests: lsof fixture parsing; fake `/proc`; a real holder (a child process holding a connection) is reported; `complete: false` when lsof is missing; an `npm exec agentic-qe mcp` command line counts (file-based, not name-based; `src/templates/aqe-lifecycle/aqe-hook.cjs:152-166`).
- [ ] Commit.

### Task 6.2: `feat(aqe): merge stray AQE stores into the project store, then archive them`

**Files:** create `src/lib/aqe-store-merge.mjs`, `src/commands/x/aqe-store.mjs`; modify `bin/agentic-kit.mjs`, `src/lib/paths.mjs` (`aqeStoreMergeDir` = `<state>/agentic-kit/aqe-store-merge`); tests `tests/kit/aqe-store-merge.test.mjs`, `tests/fixtures/aqe-store/schema-3.14.4.sql`.

Sequence (each phase unit-tested with a `runner` seam for `aqe`):

1. **Preview (read-only).** `findStrayMemoryStores(root)` kind `aqe`; folders without `memory.db` skipped and reported; root and strays copied with `-wal`/`-shm` into `aqeStoreMergeDir()/<ISO>/scratch`; per stray: patterns, captured experiences, patterns already in root by `(name, qe_domain, pattern_type)`, expected root counts; AQE version; holders. `--dry-run` (default) stops here.
2. **Writer check.** Refuse while any holder exists for root or any stray, or detection is incomplete where the platform allows completeness (B5-D3); list holders; tell the user to close Claude Code, Codex and OpenCode sessions in this project. No force.
3. **Backup.** `VACUUM INTO` the root into `aqeStoreMergeDir()/<ISO>/backup/root-memory.db` (as `src/lib/memory-probe-cleanup.mjs:59`); assert outside every `.agentic-qe`.
4. **Rehearse on scratch.** Per stray copy: `DELETE FROM witness_chain` (B5-D4); prune duplicate patterns only if Task 0.2 showed 3.14.4 still aborts (guarded, named for agentic-qe#736); `aqe brain export --db <copy> --format jsonl -o <exp>`; `aqe brain import --db <scratch-root> -i <exp> --dry-run`, then for real. Verify counts equal the preview's expectation, `PRAGMA integrity_check` = ok, `PRAGMA foreign_key_check` empty. AQE runs with cwd and `AQE_PROJECT_ROOT` = the scratch folder.
5. **Apply.** Re-check holders; same imports with `--db <root>/.agentic-qe/memory.db`; verify counts equal the rehearsal's and both PRAGMAs clean. On any mismatch stop, leave the strays, print the backup path and the restore command; never overwrite the live root automatically.
6. **Archive.** Re-check holders; `fs.renameSync` each whole stray folder to `aqeStoreMergeDir()/<ISO>/archive/<slug>/.agentic-qe`; on `EXDEV` copy, verify file list and sizes, then remove the source; on Windows a failed rename (EBUSY/EPERM) leaves that stray and reports it.
7. **Receipt.** `aqeStoreMergeDir()/<ISO>/receipt.json`: AQE version, holder method, before/after counts, backup, archived paths, pruned pattern and witness row counts per stray.

- [ ] Failing tests (fixture stores from the captured schema; fake `aqe` runner applying the jsonl): dry run writes nothing outside scratch; a holder aborts before backup and is listed; a holder appearing between rehearsal and apply aborts before the real import; a count mismatch aborts before archive and leaves the strays; backup and archive lie outside `.agentic-qe`; a second run finds no strays and writes no receipt; a stray without `memory.db` is skipped and reported; nested `.agentic-qe/.agentic-qe` archives correctly; a Windows rename failure leaves that stray.
- [ ] CLI: `status` prints the preview; `merge` defaults to dry run; `--yes` applies; `--json` gives one object; `--help` with Examples.
- [ ] Commit.

### Task 6.3: disposable proof and real-machine preview (no commit)

- [ ] Disposable, real AQE 3.14.4: root via `aqe init --auto`, two strays from Task 0.1 case (a), a learned pattern and an experience in each; `node bin/agentic-kit.mjs x aqe-store merge --dry-run`, then `--yes`; record counts, `aqe audit verify --chain audit` before/after (no new break from the merge), archive layout; start a holder (`aqe-mcp` with cwd in the root) and show the refusal.
- [ ] Real machine, read-only: `node bin/agentic-kit.mjs x aqe-store status --json` from the worktree against this repository; report the 9 strays, expected counts, current holders. Never `--yes` on real data.

---

## Slice D: constraint sunsets, registry, docs

Per constraint one commit `chore(upstream): sunset <constraint id> after its conformance run`: remove it from `constraints[]`, set the watch entry's `constraintIds: []` and `status: "adopted"` with a history note naming the run, bump `lastVerifiedAt`, update the tests that name the id.

### Task 9.1: agentic-qe#628

- [ ] Guard first (test-first): `tests/live/aqe-external-provider-transport.test.mjs` refuses to run when any `*_API_KEY` is present; run it under `env -i PATH HOME=$T/home TMPDIR=$T/tmp` with no keys.
- [ ] If the explicit fallback needs a real provider, stop and report instead of sunsetting.
- [ ] On pass: remove `agentic-qe-3.13-external-provider-contract`; update `docs/HOST-ADAPTER-FREEZE-CHECKLIST.md` and ADR-0029's cited status.

### Task 9.2: agentic-qe#654

- [ ] New opt-in `tests/live/aqe-stop-hook-conformance.test.mjs` (`AK_AQE_CONFORMANCE=1`): in a disposable project `aqe init --auto` (3.14.4) produces hook commands without `npx`/`npm exec` and timeouts in seconds (none ≥ 1000); the Stop hook exits 0 within budget offline (`npm_config_offline=true`, PATH without `npx`).
- [ ] Remove `agentic-qe-3.14.0-stop-hook-generator`; `upstreamConstraintIdFor` (`src/lib/hook-presentation.mjs:78-83`) returns `null` for those codes; the migration proposal for 3.14.0-generated artifacts is unchanged (pin in `tests/kit/hook-read-model.test.mjs`); update `tests/kit/hook-upstream.test.mjs:66-70`.

### Task 9.3: agentic-qe#655

- [ ] New opt-in `tests/live/aqe-codex-guidance-conformance.test.mjs`: for `full`, `compact`, `none`, `aqe init --auto --with-codex --codex-guidance <m>` twice is byte-identical, preserves user text outside AQE's sentinel, and `aqe platform verify --codex-guidance <m>` passes (`AQE/dist/cli/commands/platform.js:283-303`).
- [ ] Remove `agentic-qe-3.14.0-codex-guidance-policy`; update `tests/kit/hook-upstream.test.mjs:71-72`.

### Task 10: `chore(upstream): record Branch 5 evidence for agentic-qe#735, #736, #753, #754`

- [ ] #735 `kitImpact.files` += `src/lib/aqe-project-pin.mjs`, `adjustment` names both pinned keys; #736 a `reviewed` note with Task 0.2's 3.14.4 result; #753 `kitImpact.files` += `aqe-store-holders.mjs`, `aqe-store-merge.mjs`.
- [ ] Drafts only (report): comment on #736 with the 3.14.4 evidence; comment on #735 describing `embedder-identity-store.js`.

### Task 11: `docs(aqe): one AQE store per project; record Branch 5 decisions`

- [ ] New ADR-0062 "AQE project store integrity" (Proposed → Accepted): pin, merge sequence, live-writer rule, archive semantics. Note: the program plan's Branch 6a must take ADR-0063 (0061 is the RuvNet Brain reclaim ADR).
- [ ] Replace "ak never moves, merges or deletes them" wording: ADR-0016 (`Updated`), ADR-0055 (`Updated`), `docs/ddd/ubiquitous-language.md`, `docs/TROUBLESHOOTING.md` (with restore-from-archive steps), `docs/UPGRADING.md` (new pin keys, `ak x aqe-store`), `docs/HOST-SUPPORT.md`, `ak x aqe-store --help`, the `src/lib/project-memory.mjs:128-140` comment.
- [ ] Audit record: decisions B5-D1…D4 in decision format with commits; "Remediation program Branch 5" implementation-status block; resolve the open items on AQE's relative `AQE_MEMORY_PATH` and on `ak x verify aqe` recording unmanaged failures.

---

## Gate (after every slice)

- [ ] `briefs/common.md` gate set: `env XDG_STATE_HOME="$S/state" node scripts/run-tests.mjs unit` (Node 26 and `mise exec node@22.22.3`), tsc, eslint (+ complexity 50), markdownlint, build-check, `run-tests.mjs ui`, doc guards, `npm pack --dry-run | grep -E 'aqe-project-pin|aqe-store-(holders|merge)|x/aqe-store'`.
- [ ] Tripwire output verbatim; the repository's `.agentic-qe` and the 9 stray folders unchanged (`ls -la` and sizes before/after); any difference explained with evidence (the maintainer's own AQE hooks can write).
- [ ] Before the PR: `node scripts/upstream-watch.mjs report`; re-check the AQE behavior above on the newest agentic-qe; Windows CI on the pushed branch; fresh adversarial review.

## Conflicts with Branch 4b (PR #249)

| File | 4b | 5 | Resolution |
|---|---|---|---|
| `src/lib/hook-audit/agentic-dependency-constraints.json` | `watchPolicy.ledger.authors` | AQE entries, 3 constraints removed, `lastVerifiedAt` | separate hunks; take the later date |
| `docs/schemas/agentic-dependency-constraints.schema.json`, `src/lib/hook-audit/upstream-watch.mjs` | `ledger.authors` | none | revalidate after rebase |
| `tests/kit/upstream-watch-registry.test.mjs` | appends tests | may append | textual conflict at the end |
| audit record | decision 14, Branch 4 open items | B5 decisions, open items | order decision 14 before B5-D1…D4 |
| ADR-0041 header | new `Updated` | only if sunsets change §7 | keep both |

Rebase onto `main` after #249 merges, before Slice D.
