# Remediation Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a program plan: each branch below gets its own code-level plan (superpowers:writing-plans) when it starts, written against the code as it then stands.

## Status

Superseded (2026-09-28) by [remediation program v2](2026-09-28-plan-remediation-program-v2.md), which
finishes everything this plan left open (Branch 0's final steps and the decision-gate backlog).
Most branches here did merge (#241, #244–#250, #252, #253, #258–#261, #263). Kept in `docs/plans/`
rather than archived because v2 and the decision log below still cite it by name; it archives
alongside v2's own plan once v2's docs-taxonomy branch runs (v2 §3, `V2`).

**Goal:** Finish the issues 237–239 remediation and close every other item found while doing it, in branches that each carry one related body of work.

**Architecture:** Nine branches in five waves. Every branch starts from `main` after its predecessors merge, is built test-first in its own worktree as unit commits, passes the full gate set and a fresh adversarial review, and reaches `main` through a pull request the maintainer merges. Decisions still open are asked at the start of the branch that needs them, in the audit record's decision format.

**Tech Stack:** Node 22+/26 ESM CLI (`bin/agentic-kit.mjs`), `node:test`, Playwright UI harness (`tests/ui`), GitHub CLI, npm registry, Ruflo 3.4x, Agentic QE 3.14.x.

**Spec:** [Issues 237–239 verification and decisions](2026-09-26-plan-issues-237-238-239-verification-and-decisions.md) (decisions 1–9, Addenda 1–3 and the implementation-status open items), [ADR-0060](../adr/0060-session-surface-initiator-and-product-names.md), and [the upstream watch](../upstream-watch.md).

## Global Constraints

- Commits carry no `Co-Authored-By` or other attribution trailer.
- Nothing is pushed, opened as a pull request, merged, posted upstream, or created as a cloud routine without the maintainer's explicit go-ahead for that action.
- Upstream publication follows the constraint registry's `issuePublication: explicit-user-approval-required`.
- Never run `pnpm` in a worktree whose `node_modules` is a symlink; use `node --test`, `npx eslint`, `npx tsc -p tsconfig.json`, `npx markdownlint-cli2` and `node scripts/build-check.mjs`.
- Disposable environments use `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME` (or `env -i`), a `mktemp -d <template>` inside the scratch area (macOS ignores `TMPDIR` without a template), and assert every created path lies inside it.
- Tests never write real user state: not the repository's `.claude`/`.swarm`, not `~/.config/agentic-kit`, not `~/.local/state/agentic-kit`, not any real memory store.
- Runtime assets live under `src/` and are proven shipped with `npm pack --dry-run`.
- User-facing docs describe the current state only; history lives in ADRs and audit records; every branch passes the six-class documentation gate (ADR, DDD, supplemental, audit, research, user-facing).
- An ADR a branch changes gets its status, an `Updated` date and a one-line note in the same branch.
- Ruflo support window: the newest six minors, never fewer than the minors released in the last 30 days (n-5, at least 30 days, rolling).
- Never message a running workflow or background agent; start a fresh one instead.

## Review Focus

- **A test that writes real user state.** Four incidents so far (statusline version, environment pins, maintenance state, a heal receipt). Every branch's full suite runs with the real-state tripwire from Branch 2 and must leave `~/.config/agentic-kit`, `~/.local/state/agentic-kit` and the repository's `.claude` byte-identical.
- **A dependency that moves during a branch.** Ruflo shipped 3.43–3.46 in four days. Before a branch's pull request, re-run the upstream watch report and re-check any behavior the branch assumes against the newest release inside the support window.
- **Windows.** No branch can run Windows locally. Each branch that touches paths, processes or shells needs CI on a pushed branch before merge.
- **Dashboard cost.** The 30-second poll must not start more processes or transfer more data than before a branch; the refresh branch adds an explicit assertion.
- **A decision recorded in one place and contradicted in another.** Each branch re-reads the ADRs it touches and the audit record's decisions before its last commit.

---

## Wave 0 — finish the current workstream

### Branch 0: `integration/237-238` → `main`

The branch holds Stages 1–5, ADR-0060 (Proposed), Addendum 3 and the upstream watch. It is not yet reviewed.

**Files:** no new code; review fixes land as unit commits on this branch.

- [ ] **Step 1: Run the gate set on the tip with the real state redirected**

```bash
cd ../agentic-kit-integration
S=$(mktemp -d "$PWD/../ak-gate.XXXXXX")
env XDG_STATE_HOME="$S/state" node --test --experimental-test-coverage --test-coverage-lines=70 --test-coverage-branches=70 --test-coverage-functions=70 "tests/kit/*.test.mjs"
for f in statusline-segments statusline-window-ledger statusline-brain health-history dashboard admin-model admin; do node "tests/$f.test.cjs"; done
npx tsc -p tsconfig.json && npx eslint . && npx eslint src bin --rule 'complexity: [2, 50]' && npx markdownlint-cli2 && node scripts/build-check.mjs
```

Expected: 0 failures; coverage above 70/70/70; eslint 0 errors.

- [ ] **Step 2: Adversarial review of the full diff `3505a29c..HEAD`.** One workflow: dimension reviewers (correctness, security, hermeticity, docs drift, Windows paths), each finding verified by an independent refuter; confirmed findings fixed as unit commits with a failing test first. Treat the lane reports' deliberately deferred suggestions as candidate findings: sync's plan filter using `repair !== 'manual'`; the second guidance writer in `reconcileOpencodeGuidance`; the About card's missing manual label; the unguarded `fs.rmSync(stampFile)` in `refreshHelpersBeforeInjection`; the untested `distillSkipReason`; `healNatives` treating the substring `FAILED` as failure and a segfault as inconclusive. Run the AQE coverage-gap analysis on the changed files and the external link check. Append results to the audit record's "Implementation status" section.

- [ ] **Step 3: Browser check against real data.** Open the dashboard served from this worktree and check: Live source health and the zero-operations note; host badges and About chips (including the Ruflo install-edit line); Discovery "Not installed"; the Limits empty states; the transfer size of `/api/system/summary` against `/api/system`. Run `node bin/agentic-kit.mjs sync --dry-run` from the worktree on the real machine to see whether rows other than natives now report `unresolved:`.

- [ ] **Step 4: Maintainer reviews the 39 screenshots** in `.ui-artifacts/` and runs **Re-measure machine** to repair the maintenance state a test overwrote; confirm `~/.local/state/agentic-kit/maintenance/management/locators.json` no longer contains `/Users/someone`.

- [ ] **Step 5: With the maintainer's go-ahead, push and open the pull request.** Wait for CI including Windows; fix failures as unit commits.

- [ ] **Step 6: After the maintainer merges.** Fast-forward `fix/audit-237-238-remediation` or delete it; comment on and close #237 and #238 with links (go-ahead required); update #239's checklist; reply on #213 (see Branch 5); remove lane worktrees and branches after checking each is contained in `main`.

---

## Wave 1 — independent foundations (parallel after Wave 0)

### Branch 1: `fix/imported-rollout-origins`

Small, high value: 23 project folders on the maintainer's machine show a Desktop origin only because the ChatGPT desktop app imported Claude Code transcripts (ADR-0060 context item 3). Usage already excludes imports (ADR-0052); project discovery does not.

**Files:**

- Modify: `src/lib/footprint/project-sources.mjs` (the sighting loop that calls `transcriptSessionOrigin`)
- Modify: `src/lib/usage-project-evidence.mjs` (`usageSessionOrigin`)
- Create or modify: a shared predicate beside `CODEX_IMPORT_TURN_PREFIX` in `src/lib/usage-parsers.mjs`, exported for both
- Test: `tests/kit/project-sources-imports.test.mjs`
- Docs: ADR-0052 (Updated: imports excluded from discovery), `docs/ddd/machine-footprint.md`, `docs/dashboard.md` origin facet note

**Interfaces:** Produces `isImportedCodexRollout(headLines: string[]): boolean`, true when any head line's `payload.turn_id` starts with `external-import-turn`.

- [ ] Write the failing test: a fixture rollout whose first `task_started` has `turn_id: "external-import-turn-1"` contributes no sighting and no origin; a native `codex_work_desktop` rollout still does; the scan reports `importedExcluded: 1`.
- [ ] Run it; expect a sighting to be recorded (FAIL).
- [ ] Implement the shared predicate and skip imported rollouts in both call sites, counting them.
- [ ] Run the focused tests and the full gate set; commit `fix(discovery): keep imported Codex copies out of project origins`.
- [ ] Docs commit: `docs(adr): record that discovery excludes imported copies (ADR-0052)`.

### Branch 2: `fix/test-hermeticity`

Stops tests from ever writing real user state again.

Scope (one unit commit each, test-first):

1. `test(guard): fail the suite when real user state changes` — a global setup/teardown fingerprint (paths, sizes, mtimes) of `~/.config/agentic-kit`, `~/.local/state/agentic-kit`, `%APPDATA%`/`%LOCALAPPDATA%` equivalents and the repository's `.claude`, compared after the run.
2. `fix(dashboard): refuse default maintenance and management services in injected test servers` — the hermeticity guard also fires when only a System collector is injected.
3. `test(env): stop spawn tests inheriting the developer's XDG_* variables` — shared sandbox helper used by every spawn test.
4. `test(opencode): stop six tests creating $XDG_STATE_HOME/opencode`.
5. `fix(test-helpers): create temporary folders from a template` — macOS `mktemp -d` ignores `TMPDIR`.
6. Investigate `tests/ui/maintenance-focus.mjs` "polyglot cards expose labelled language badges" (fails at `3505a29`); fix the product or the test with evidence, and add the file to `test:ui` if it belongs there.
7. `test(live): run the memory-routing live test in a disposable home` — it uses the real home folder today; keep the paid qe-court live test manual.

Exit: the full suite passes twice in a row with the fingerprint unchanged.

### Branch 3: `feat/ruflo-support-window`

Adopts the rolling support window and Ruflo 3.46.0's fixes; resolves the Ruflo items from the closed-upstream review.

**Open decisions to ask first:** Claude-side memory outside a project (Addendum 2 follow-up: route Claude's registration through the launcher, or not); a one-time clean-up of old `_setup/verify-*` rows in existing MCP stores; a throwaway `workflow_dispatch` job to test the ruvnet/ruflo#2885 mitigation on the macOS runner.

Scope (one unit commit each, test-first):

1. `feat(versions): support a rolling window of Ruflo minors (n-5, at least 30 days)` — window computed from remembered registry evidence (never a network call on a plain read); below the window `ak status` says unsupported and points to `ak sync`; policy recorded on the Ruflo dependency policy in the constraint registry; ADR-0041 §7 amended.
2. `feat(status): show whether Ruflo's backup and distillation are running` — reads Ruflo's own metrics and daemon state; shows last backup and last distillation ages.
3. `feat(ruflo-daemon): enable auto-start with Ruflo's supported daemon settings` — minimal managed `.claude-flow/config.json` with flat keys; `daemon.idleSecs: 0` only below 3.46.0 (ruvnet/ruflo#3194); macOS memory threshold until ruvnet/ruflo#2935 is fixed; never `ruflo config set` (ruvnet/ruflo#3449); proven in a disposable project that backup and distillation run.
4. `fix(security): stop reporting defend as non-functional when Ruflo ships the built-in engine` — status row, verify, footer alarm, About text; keep the aidefence heal with corrected detail; verify distinguishes a detection from the post-detection crash (RM9).
5. `refactor(statusline): remove the retired CVE-counter overlay` — keep `SEC_WRAP_STRIP` one release.
6. `docs(status): drop the stale "#2986 pending" note`.
7. Upstream dispatches confirmed against 3.46.x: governance reported as enforced on stdio (ruvnet/ruflo#3415, ADR-0058 Updated), init opt-out suppression removed (ruvnet/ruflo#3167), agent-browser doctor row (ruvnet/ruflo#3166), YAML config (ruvnet/ruflo#3193) — one commit per item, each with the registry's removal proof.
8. `docs(ci): correct the nightly note for ruvnet/ruflo#2885`.

Investigations (file upstream only with a reproduction and the maintainer's approval): MCP `memory_store` rejecting a custom database path; Ruflo's Codex backend command after OpenAI removed `codex mcp-server`; a read-only route/peek API for memory health (the Ruflo maintainer invited this issue on #213); memory-routing observations on Linux and Windows (today's evidence is macOS-only), run on CI runners with a disposable home.

### Branch 4: `feat/upstream-watch-live`

Mostly operations; the code shipped in Wave 0.

- [ ] With the go-ahead: create the pinned "Upstream watch" issue and the daily cloud routine from `docs/upstream-watch.md` (proposed 14:00 UTC); record their ids in the registry. *The ledger issue is pacphi/agentic-kit#243, recorded in the registry; the routine is created after Branch 4 reaches `main` (B4-G2).*
- [ ] Migrate pacphi/agentic-kit#240 and #213's upstream remainder into the registry; comment with the registry link; close #240 when ruvnet/ruflo and agentic-qe#574 status allows. *Migrated; the comments are drafted, not posted; #240 stays open on agentic-qe#574.*
- [x] Code (unit commits, test-first): confirm "candidate" releases by mapping merged pull requests' closing references; decide and implement the open questions (a separate AgentDB dependency policy; widening the guard to `docs/`; whether `lastVerifiedAt` waits for a conformance run).
- [ ] Rehearse one dispatch end to end on a real released item (agentic-qe#617) as a draft pull request. *Deferred until the routine exists.*

Replies owed now: #213 (answer the Ruflo maintainer's two comments and stuinfla's local-evidence comment: the two stores are deliberate for encryption at rest; the watch tracks published behavior only); ruvnet/ruflo#3153 (read the four third-party comments; reply only if they ask something of us). Stale threads with no upstream activity for 90+ days (openai/codex#16045, #16921, ruvnet/ruflo#952): for each, re-check whether ak still depends on it, then either ask for a status once or retire the entry.

---

## Wave 2 — stores and verification

### Branch 5: `fix/aqe-store-integrity`

After Branch 3 (both edit `src/lib/heal.mjs` and `src/commands/x/verify.mjs`).

Scope (one unit commit each, test-first):

1. `fix(aqe): pin AQE to the project root and list stray stores` — absolute `AQE_PROJECT_ROOT` in `.claude/settings.local.json` and the Codex launcher.
2. `feat(aqe): merge stray AQE stores into the project store, then archive them` — preview, back up, prune duplicate patterns in a scratch copy, `aqe brain export`/`import`, verify counts, `integrity_check` and `foreign_key_check`, move the stray to a dated backup folder.
3. `fix(verify): run provider checks from the project root without writing`.
4. `fix(aqe): recognize every plain npx spelling of AQE's server`.
5. `refactor(heal): remove the AQE solver heal that never installs anything` (agentic-qe#617).
6. `fix(verify): do not record failures of an unmanaged AQE backend`.
7. Constraint sunsets with their conformance runs: agentic-qe#628, #654, #655.

**Open decision to ask first:** an AQE embedding conflict-only row currently makes every `ak sync` exit 1 — mark such rows `manual`, or keep them sync-repairable.

Investigations: the AQE audit chain broken at entry 135 in the project store; `RUVECTOR_USE_RVF_PATTERN_STORE` having no effect; `VECTOR_SPACE_UNVERIFIED` in a fresh home.

---

## Wave 3 — one refresh vocabulary

### Branch 6a: `refactor/evidence-store`

After Branches 3 and 5.

1. `refactor(evidence): one evidence store for every remembered check` — one record shape and age rule for live checks, Ruflo component checks, host checks and scans; every check records (including `ak x aqe-embedding verify`, setup proofs and sync).
2. `perf(status): re-check only expired evidence; compute dashboard status in-process` — the dashboard stops spawning `ak status --json` per poll; an assertion pins the processes started per poll.
3. `fix(dashboard): stop writing Maintenance preferences on every poll tick`.
4. New ADR-0063 (Proposed → Accepted; ADR-0061 is the RuvNet Brain reclaim record and ADR-0062 is Branch 5's AQE project store integrity): the refresh vocabulary and evidence store; supersedes ADR-0048's two scan controls and amends ADR-0025 §5 and ADR-0055's live-check evidence.

### Branch 6b: `feat/one-refresh-flag`

After 6a.

1. `feat(refresh): one --refresh flag with live and machine strengths across status, system and maintain`.
2. `refactor(verify): fold ak x verify into ak status --refresh=live` (`--only <test>`; slow proofs only when named).
3. `feat(dashboard): one Refresh control with the CLI's three strengths; Reload re-reads the view`.
4. `feat(host): consent-gated connection check from the CLI`.
5. `refactor(cli): rename operations that are not refreshes` (`ak host reset-routes`, `ak usage prompts --show-text`).
6. `fix(security-check): scan the project folder and say so`.
7. `fix(sync): --skip versions also skips the online version lookup`.
8. `fix(dashboard): start scans with POST requests`.
9. `refactor(maintain): remove recipe refresh until a registry exists`.
10. CLI honesty: `ak sync --json` with an unknown option prints JSON; a configuration error under `--json` keeps its recovery text; `--skip` lines print once; `ak status --live --json` never prints non-JSON on stdout; `ak x host --dry-run` is honored; the bare `ak` hint counts rows without a fix; split `src/commands/sync.mjs` below the max-lines limit.
11. `docs: align help, README and dashboard docs with the refresh vocabulary`, including `docs/upgrading.md` for the renamed flags.

**Open decision to ask first:** `readLimits` starts `codex app-server` whatever the Codex host setting says — keep, or only when Codex is managed.

---

## Restructure (maintainer, 2026-09-28)

After about 28 attended hours, the maintainer cut the remaining program to three pull requests:

- **Branch 6b** absorbs 6c (the dashboard's single Refresh control).
- **Branches 7 and 8** become one branch, `fix/usage-accuracy`: the session-surface items first, then the capture backlog, on the same parsers.
- **Branch 9** is trimmed and runs in parallel with 6b in `../agentic-kit-b9`. Its items 4, 5 and 8 moved to issues #254, #256 and #255; Branch 7's optional item 7 (Cowork) moved to #257.

The controller now pushes, opens pull requests, squash-merges when CI is green and the final review is clean, and removes each merged branch and worktree. Merged means verified contained in main; anything holding unmerged work is listed for the maintainer. Local main is fast-forwarded before each branch starts.

## Wave 4 — session surface and usage accuracy (one branch: `fix/usage-accuracy`)

### Branch 7: `feat/session-surface` (merged into `fix/usage-accuracy`)

After Branch 1; its UI part after Branch 6b. Requires ADR-0060 accepted.

**Decided (maintainer, 2026-09-28, ADR-0060's open questions):**

- "Cloud session" stays in the shared label table but appears in a view only when at least one such session was recorded.
- For "on 3P", discover and record the actual third-party provider (Amazon Bedrock, Google Vertex, OpenRouter, any other host of Claude models) whenever the evidence allows, and show it in the detail view.
- ADR-0057's role lenses are deferred to v5: this branch builds only the shared vocabulary module that any later lens can read.

1. One vocabulary module (raw value → surface → initiator → label); remove the five copies of the origin enum.
2. Usage cache schema bump carrying surface, initiator and raw evidence.
3. Codex `thread_source` classified in full (`guardian_review` and `subagent` as agent; `chatgpt_handoff` as person; app features as automation); roll subagents and Auto-review under their parent.
4. Counting rules (Claude by `sessionId`, excluding `subagents/` and `bridge-session` files).
5. Runtime census symmetry: `Claude.app` and `ChatGPT.app` are desktop applications, not hosts; bundled CLIs attributed to their sessions.
6. UI: one label per value across Usage, System → Projects, Maintenance and Intelligence (`unknown` has one label; Intelligence's designation split by axis).
7. Moved to #257: Cowork transcripts as a discovery source.

### Branch 8: `fix/usage-capture-backlog` (merged into `fix/usage-accuracy`)

Runs after Branch 7's items, in the same branch (shared parsers).

One unit commit per item, each starting with a reproduction on real data (counts only): O-7 session-level `byProvider` last-wins; X-7 unpriced auto-review models (classification lands in Branch 7); X-8 unread Codex fields (effort, time to first token, compaction); C-6 Claude `cost-state` as a reconciliation signal; C-8 cross-file message-id dedup; C-9 local-timezone day bucketing frozen in the cache; C-11 unknown-record counter; O-6/O-9–O-12 OpenCode items; the statusLine classifier reading managed settings; a shell wrapper around the footer helper classed as `custom`.

---

## Wave 5 — follow-ups and housekeeping

### Branch 9: `fix/follow-ups`

1. M1b: a failed source's banner outlives its Discovery row after restart.
2. N4: the two-store memory warning gains an acknowledgment path (the stores stay separate by Ruflo's design, ruvnet/ruflo#2786).
3. N5: verify and correct the partial Codex parsing advisory.
4. Moved to #254: L4b, the browser network trace for the stuck "CONNECTING" stream.
5. Moved to #255: F1, the worker early-warning monitor from #239.
6. A per-machine acknowledgment for hook-contract changes.
7. Prune ak's per-write settings safety copies (undo uses receipts).
8. Moved to #256: the live-view observations (re-entering files, plain-folder bind, structured live-events).
9. The committed rendered test for the About install-edit line.
10. Complete the `docs/adr/README.md` index table past ADR-0052.
11. Status wording when both the repository root and the folder are unsuitable.
12. Test temp-folder cleanup: research first, then implement. On 2026-09-28 the shared temp folder held about 34,000 `ak-*` entries under 120 test prefixes (largest: `ak-usage`, `ak-adapter-conformance-cli`, `ak-quota`, `ak-live-service`), all dated 2026-09-25 to 2026-09-27 11:47. That is before the guarded runner (`scripts/run-tests.mjs`, #245) gave each run its own temp root, and none are newer. Three runner roots (`ak-suite-*`, 2026-09-27) survive from runs stopped before they finished: the runner removes its root only after a complete run, and nothing later collects an abandoned one. Focused `node --test <file>` runs, which every task brief uses, bypass the runner and still write to the shared temp folder. Requirement (maintainer, 2026-09-28): suites clean up after themselves, only after a complete run, never prematurely or naively. Analyse before building: which tests leak on failure paths; how concurrent gate runs in parallel worktrees share the temp folder; how a root is proven abandoned (its owning process is gone, not merely old); and Windows file locks. Then implement and prove: a later complete run collects abandoned runner roots without touching a live concurrent run; focused runs get the same per-run root and leftover report; and the pre-runner backlog gets a reviewed one-time clean-up, listed by literal path for the maintainer (deletion rule). Exit: a full run and a focused run each leave the shared temp folder unchanged, including after an interrupted run.
13. Branch 6a leftovers (maintainer, 2026-09-28; the `drift()` failed-fetch bug moved into Branch 6b instead):
    - (moved to 6b Task 14) fix ADR-0063's sentence that says `setup.mjs` was extended and then lists `ak setup` as unaffected;
    - test the evidence re-record sites in `x/daemon-gc.mjs`, `setup.mjs` and `x/host.mjs`;
    - (moved to 6b Task 11) guard `refreshPlanHosts` in `sync.mjs` with a try/catch that reports a failed probe;
    - replace ephemeral task and fix-round labels in test comments with durable references;
    - make `paths.mjs` and `knownFileSpecs()` ignore a relative `XDG_*` value, as the XDG Base Directory spec requires (a relative `XDG_STATE_HOME` makes `dashboard.test.cjs` fail every time);
    - teach the real-state tripwire's concurrent-writer list the live session's Ruflo files (`.claude-flow/`, `.claude/proven-config.json`, `.claude/.proven-config-version`).

Housekeeping (no branch; each with the maintainer's go-ahead): delete the merged remote `feat/managed-ruflo-components`; retire `../agentic-kit-wt-213` after a final diff against `main`; review and drop the three stashes; decide dependabot #231; the three unreceipted Ruflo install edits stay documented (reinstall restores them).

---

## Decision gate — backlog outside this workstream

These predate the workstream and need a go or no-go before any plan: the Environment Auditor (designed), ADR-0059 encryption at rest for Ruflo data, Route Intelligence (#109), the companion tools (#115, #116, #117, #167), the OpenCode routing research (#95), and ADR-0048's human-evaluation gates. Recommended order if approved: ADR-0059 (touches the memory stores this program settles), then the Environment Auditor, then the companions.

## Execution order at a glance

| Wave | Branches | Can run in parallel |
|---|---|---|
| 0 | 0 | — |
| 1 | 1, 2, 3, 4 | 1, 2 and 4 alongside 3 |
| 2 | 5 | — (after 3) |
| 3 | 6a, 6b (with 6c folded in) | — (after 3 and 5) |
| 4 | `fix/usage-accuracy` (7 + 8) | — (after 6b merges) |
| 5 | 9 (trimmed) | alongside 6b, from 2026-09-28 |

Each branch ends with: the full gate set with the real-state tripwire, an adversarial review, the documentation gate, CI including Windows on a pushed branch, and a pull request the controller squash-merges when CI is green and the final review is clean (see the Restructure section above).
