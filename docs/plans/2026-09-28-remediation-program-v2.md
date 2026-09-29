# Remediation Program v2

> **For agentic workers:** this is a program plan. Execute it with superpowers:subagent-driven-development. Each branch gets its own code-level plan (superpowers:writing-plans), saved in `docs/plans/` and written against `main` as it stands when the branch starts.

## Status

Active, not yet started. The §1 decision batch is awaiting the maintainer's answers. D-2's first
release (`4.0.0-alpha.60`, carrying #263's breaking changes) is being cut ahead of branch V1, per
D-2 option A.

**Goal:** Finish everything left over from [remediation program v1](2026-09-26-remediation-program.md) in seven branches. The maintainer's attention goes into one decision sitting up front and a short list of named interrupts. v1 took about 28 attended hours; v2 aims for under 4 (§4 adds it up).

**Written against:** `main@e957737b`. v1 status: #258, #259, #260, #261 and #263 merged on 2026-09-28. npm still ships `4.0.0-alpha.59`, so #259–#263 are unreleased, and #263 changes the CLI in breaking ways. The only worktrees are the main checkout and this one, and no stash exists.

**Sources:** the scope reconciliation, keyed by its row ids in [Appendix A](#appendix-a-the-reconciliations-189-rows); the SDD ledger, cited as `L:NNN`; [the 6b plan](../archive/2026-09-28-superpowers-plan-branch-6b-one-refresh-flag.md), whose section "Deferred to Branch 6c" holds the dashboard task text; [the Branch 9 plan](../archive/2026-09-28-superpowers-plan-branch-9-follow-ups.md), which holds Tasks 5–14, the deferred items and N-1 to N-5; the N-5 list; the final reviews of 6b and Branch 9; and [the docs taxonomy plan](../archive/2026-09-28-plan-docs-taxonomy-and-archive.md). The reconciliation, the ledger, the N-5 list and the reviews are git-ignored files in the main checkout under `.superpowers/sdd/2026-09-26-remediation-program/` (`reports/program-scope-reconciliation.md`, `progress.md`, `reports/n5-253-deferred-minors.md`, `reports/b6b-final-review.md`, `reports/b6b-final-rereview.md`, `reports/b9-final-review.md`).

**How v2 saves attended time:**

- You answer every open question in one sitting (§1).
- Standing authority is renewed (D-1), so pushes, PRs, merges and cleanup no longer interrupt you.
- Windows CI gets faster first (V1), so every later PR waits about 3 minutes on Windows instead of 8–15.
- Related work shares a branch, and branches with disjoint files run side by side.
- The only interrupts left are named in §4.

---

## 1. Decision batch (one sitting, about 45 minutes)

Each decision lists its options and marks one as recommended. Reply with the D-number and a letter. D-1 and D-2 need an explicit answer before anything is pushed, merged or released. From D-3 on, silence on a decision means you take the recommendation.

### D-1 Standing authority for v2

M-9 and M-10 applied to v1 only.

- **A. Recommended.** Renew both for v2. The controller pushes branches and opens PRs. It squash-merges only when every CI job is green, Windows included, and the final review has nothing left to fix. It verifies that the squash tree equals the branch tip, then removes the merged branch and worktree. It can also comment on and close this repository's own issues, with evidence. This covers V2's PRs, which replaces the taxonomy plan's "the maintainer opens and merges PRs" line. **Why:** this is the biggest source of v1's interrupts, and the merge gate stays exactly as strict as before.
- **B.** The controller pushes and opens PRs. You merge.
- **C.** Every action needs your go-ahead.

### D-2 Releases

Your global `ak` is the published copy (alpha.59). The one-off actions in §2 need the new CLI.

- **A. Recommended.** Approve three releases now:
  - `4.0.0-alpha.60` before V1 starts. Its notes carry #263's "Breaking changes" section.
  - alpha.61 after V3 merges, which completes the dashboard vocabulary.
  - one release at v2's close.

  For each, the controller commits the release, pushes the tag, watches `release.yml`, runs `npm i -g @pacphi/agentic-kit@<version>` and checks `ak --version`. **Why:** the breaking CLI ships alone, the way M-3 released 6a alone, and you need it installed for §2.
- **B.** Release alpha.60 together with V1. V1 changes only CI and tests, so the contents are the same, but the release waits longer.
- **C.** Hold every release until V3, so the CLI and dashboard vocabularies ship together.

### D-3 When the docs taxonomy runs (and one interpretation)

The taxonomy plan must run while no open branch or PR touches the files it moves, and those are nearly all top-level docs.

- **A. Recommended.** Run it at a quiet point after V1 merges and before any Wave 2 branch is cut. **Why:**
  - every v2 branch then edits the final file names;
  - its layout guard keeps v2's own plans in `docs/plans/`;
  - its PR B, which touches only `docs/archive/`, can run alongside Wave 2 instead of adding a serial step at the end.
- **B.** Run it at v2's end, where a quiet point comes naturally. Both of its PRs then run one after the other.
- **C.** Leave it out of v2.

In the same answer, confirm the taxonomy plan's open interpretation: `CLAUDE.md`, `AGENTS.md` and `SKILL.md` keep their capitals, because the tools read those exact names. **Recommended: yes.**

### D-4 The two-store memory warning (N4)

`status/sections/project-memory.mjs` warns permanently, with no fix, whenever two project memory stores exist. The stores stay separate by Ruflo's design (ruvnet/ruflo#2786). Item 6's shared acknowledgment store was dropped (B9-OQ1).

- **A.** Build the per-machine acknowledgment as the Branch 9 plan designed it: a new state file, a new `ak status` option and dashboard wiring. Effort M.
- **B. Recommended.** The row becomes info once a `memory-routes` live check has observed routing for the installed Ruflo version. It warns again after a Ruflo upgrade, or when that check fails. Effort S. **Why:** the row already names that check, so it ties to an action the user can take. It adds no new CLI surface and reuses 6a's evidence store.
- **C.** Leave the warning as it is.

### D-5 #239's items marked "not yet scoped"

The four items are execution identity, terminal-outcome recording, cancellation semantics, and the matrix of upgraded installs with positive and negative outcomes.

- **A. Recommended.** Move them to v5. #239 is the v5-readiness tracker. V7 posts one comment there that maps what v1 and v2 closed and names these four as v5 scope. **Why:** each needs scoping against Agentic QE and Ruflo first, and none is a defect today.
- **B.** Scope them in v2, as a research branch (M) that you review.
- **C.** Split them into four new issues now.

### D-6 `aqe init` is not idempotent (B5-15)

A full `aqe init` rewrites `.claude/settings.json`, leaving a `.backup`, and rewrites two docs. `ak setup` runs `aqe init --auto` in the user's project: `aqeInitArguments` in `src/lib/aqe-guidance.mjs` builds the arguments, and `src/commands/setup.mjs` calls it. So every re-run of `ak setup` does this.

- **A. Recommended.** Report it upstream to agentic-qe. V4 drafts the issue to the upstream issue standard, and you approve the exact text. **Why:** people who use both tools hit this through ak, and the fix belongs upstream.
- **B.** Drop it.

### D-7 The stray AQE store ak cannot see (B5-9)

`.superpowers/sdd/2026-09-26-remediation-program/reports/.agentic-qe` is still on disk. It was created 2026-09-27 20:31 and written 2026-09-28 06:46. The stray scan skips dot folders below the project root.

- **A. Recommended.** V4 teaches the scan to walk dot folders below the root, except `.git` and tool homes. After V4 merges, you merge this store at the end of a session with `ak x aqe-store`: preview, `VACUUM INTO` backup, then archive, the same path that merged the other nine strays (receipt `~/.local/state/agentic-kit/aqe-store-merge/2026-09-28T05-12-26-792Z/receipt.json`). **Why:** it uses the tested path with a backup, and it proves the scan fix on real data.
- **B.** Archive it by hand now.
- **C.** Leave it.

### D-8 Dependabot #251

The PR bumps `@types/node` 26.4.1 → 26.6.2, `eslint` 10.10.0 → 10.11.0 and `markdownlint-cli2` 0.23.2 → 0.23.3. It changes only the lockfile, and every check was green on 2026-09-28 against an older `main`.

- **A. Recommended.** Comment `@dependabot rebase`, then merge on all-green before V1 starts. **Why:** these are dev tools every branch uses, and landing them first means no branch meets them mid-flight.
- **B.** Close it and let the next group PR pick up the versions.
- **C.** Fold the bumps into V1.

### D-9 Two local branches with unmerged work (HK-6)

- `docs/dashboard-taxonomy-delivery-metrics` has 1 commit (2026-09-25): ADR-0056 (delivery outcome metrics) and ADR-0057 (dashboard taxonomy and role lenses), plus an `explainer.html` rework.
- `codex/v5-experience-research` has 2 commits (2026-09-25): 30 files under `docs/research/v5/`.

Both branches are also on origin.

- **A. Recommended.** Keep both untouched for v5, and keep ADR numbers 0056 and 0057 reserved (the next free number is 0064). **Why:** both are v5 material (B7-D3 moved the role lenses to v5), and origin already holds them, so nothing is at risk. When v5 picks them up, they move by the taxonomy's rules: into `docs/proposals/` or the archive, never `docs/research/`.
- **B.** Land both now as proposals in one docs PR. That PR collides with the taxonomy's move of `explainer.html`.
- **C.** Delete the local copies and keep the ones on origin.

### D-10 … D-15 The decision gate (DG-1 … DG-6)

| D | Item | A | B | C | Recommended, and why |
|---|---|---|---|---|---|
| D-10 | Environment Auditor (DG-1): designed, nothing built | Defer until after v2; keep the design | Build it as v2's last branch (L, needs your design review) | Drop it | **A.** v2 finishes remediation. The auditor is a new product, and its baseline sits on a remote branch the program excluded (HK-7) |
| D-11 | ADR-0059, encryption at rest for Ruflo data (DG-2): not written | Defer; make it the first item after v2 | Write it in v2 as a Proposed ADR, docs only, alongside Wave 2 (about 30 minutes of your review) | Drop it | **A.** It needs your design time, and no v2 branch changes the memory stores |
| D-12 | Route Intelligence #109 (DG-3) | Defer; keep the issue open | Close it as not planned | Plan it after v2 | **A.** Not remediation; nothing in v2 depends on it |
| D-13 | Companion tools #115, #116, #117, #167 (DG-4) | Defer; keep all four open | Close all four as not planned | Start with #116 after v2, since the other three build on its install-method classifier | **A.** Not remediation; revisit at v5 planning |
| D-14 | OpenCode routing research #95 (DG-5) | Defer | Close it | Research it in v2 | **A.** Not remediation |
| D-15 | ADR-0048's human-evaluation gates (DG-6): usability study, screen-reader sign-off, cross-platform check | Move them to v5 and say so in ADR-0048's status line, which V3 edits anyway | Run them after V3 merges (several hours of your time) | Drop them and mark ADR-0048 Implemented on automated evidence | **A.** v5 reimagines this UI (B7-D3), and V3 already changes the controls the study would cover |

### D-16 and D-17 Two small leftovers

| D | Item | A | B | Recommended, and why |
|---|---|---|---|---|
| D-16 | B0-16: Ruflo checks its target tables before `quick_check`, so a corrupt store without AgentDB tables reads as "table missing" | Accept it; no action | Add it to the next approved rUv upstream round | **A.** Low impact, and no user has reported it |
| D-17 | B0-4: the AQE coverage-gap analysis over the changed files | Drop it | Run it once, in V7 | **A.** Every branch already passes the 70/70/70 coverage gate |

### D-18 and D-19 The live session view (#256)

Two of #256's three questions are yours to answer; they need no machine evidence. V3 carries out the answers. The third question, a plain-folder bind observed on a real machine, is V3's own work.

| D | Item | A | B | Recommended, and why |
|---|---|---|---|---|
| D-18 | A transcript that re-enters the live window after a restart is read from its start | Document it: the live view shows the file's content from its start again. V3 first confirms that the re-read changes no total; if it does, B applies | Resume from a remembered offset per file | **A.** A stored offset per file is new state to keep correct, and it earns its cost only if the re-read changes a number |
| D-19 | The structured live-events input has fixture evidence only, because nothing produces such a file | Label it experimental in the docs and keep the fixtures | Build a real producer | **A.** No host writes the format today; building a producer is new scope, not remediation |

### Already resolved (no decision needed)

| Item | Evidence |
|---|---|
| PR #258 (registry records) | Merged as `a77bfdee` |
| #253's leftovers | Probe repository deleted: `gh api repos/pacphi/upstream-watch-probe-20260928` returns 404. Main ruleset `24138491` "main: pull requests, no force push or deletion" is `active` |
| N-5's list of minors | Recovered to `reports/n5-253-deferred-minors.md`: 15 items, all still present on `main` |
| Stashes and `../agentic-kit-wt-213` | `git stash list` is empty; `git worktree list` shows only the main checkout and this worktree |
| The real AQE stray-store merge (nine strays) | Ran: receipt `…/aqe-store-merge/2026-09-28T05-12-26-792Z/receipt.json`, status `merged` |
| Scratch folders beside the repository; the 37 `ak-host-dry-*` temp folders | None left (`ak-*` under `/Users/cphillipson/Development/active/ai/` has no matches; `ak-host-dry-*` in `$TMPDIR` counts 0) |
| N-4 (CI job time limit) | #261 (`0fa5e489`): `timeout-minutes: 30` on every job in `ci`, `devcontainers`, `nightly`, `pages` and `release`; the upstream watch keeps 15 and 20 |
| The RuvNet Brain uninstall step | Obsolete (M-2) |
| Branch 9 item 6 (hook-contract acknowledgment) | Dropped (B9-OQ1) |
| ADR-0060's open questions | Decided (B7-D1 … B7-D3, `L:417`) |
| The upstream-watch hold (M-5) | Lifted for N-5's 15 minors only |

---

## 2. Maintainer one-offs (your machine, about 45 minutes)

In order. Steps 1–4 come after alpha.60 is published and installed (D-2).

1. **Install check.** `ak --version` prints `4.0.0-alpha.60`.
2. **AQE pin (B5-8).** From the main checkout, run `ak sync`, then `ak status`, and confirm the AQE pin row has converged. Today `.claude/settings.local.json` has no `AQE_PROJECT_ROOT`, and the ownership keys in `kit.json` (`opencode`, `codex`, `agentBrowser`, `rufloComponents`) have no `aqePin`. If sync does not plan the pin, it is a product bug, and V4 adds a task for it.
3. **Footprint snapshot (B1-3).** Run `ak system --refresh=machine`. Today `~/.config/agentic-kit/footprint-snapshot.json` is still schema 7, last written 2026-09-27 06:18. This takes a few minutes.
4. **Four leftover logs** that the ledger cites (`L:370`, `L:400`). Remove one path per command, after `ls` confirms it:

   ```bash
   rm /tmp/b6b-task7-unit-run.log
   rm /tmp/b6b-task7-unit-run2.log
   rm /tmp/red-evidence.txt
   rm /tmp/run-tests-unit-out.txt
   ```

   Six other logs have no record in the ledger, so whether to remove them is your call: `/tmp/ak6a-unit-run.log`, `/tmp/unit-run-final.log`, `/tmp/unit-run-node22-final.log`, `/tmp/unit-run-node22.log`, `/tmp/unit-run1.log` and `/tmp/unit-run22.log`.
5. **Whenever it happens (#254):** if the dashboard's session badge sticks on "CONNECTING", capture a browser network trace: DevTools → Network, the event-stream request, while it is stuck. Attach it to #254. Without a trace the stall cannot be diagnosed; the server opens the stream in about 1.6 ms.
6. **After V4 merges:** merge the stray store (D-7), at the end of a session.
7. **After V5 hands over its list:** remove the temp backlog by hand from its reviewed literal-path list. Today `$TMPDIR` holds 34,010 `ak-*` entries, including three legacy `ak-suite-*` roots.

---

## 3. Branches

Seven branches. V2 has two PRs, so there are eight PRs in total. Effort is given as size, agent hours (implementer plus reviews, at v1's pace of about 30 minutes a task and about 2 hours to finish each branch), and your attended time.

| Branch | Effort | Agent | Attended | Starts after |
|---|---|---|---|---|
| V1 `ci/windows-test-speed` | S | 3–4 h | 5 min | Wave 0 |
| V2 `docs/taxonomy-reorg` (PR A) and `docs/archive-link-repair` (PR B) | L + M | 6–8 h + 4–5 h | 30 min | Tasks 1–2 alongside V1; Task 3 onward after V1 merges (D-3 A) |
| V3 `feat/dashboard-refresh` | L | 10 h | 15 min | V2 PR A |
| V4 `fix/follow-ups-v2` | L | 14 h | 20 min | V2 PR A |
| V5 `test/runner-hygiene` | M | 8 h | 0 (then §2 step 7) | V2 PR A (and V1, which also edits `scripts/run-tests.mjs`) |
| V6 `fix/usage-accuracy` | L | 15 h | 10 min | V2 PR A; its UI commits after V3 |
| V7 `chore/v2-close-out` | S | 3 h | 15 min | everything else merged |

**Why these merges:**

- V4 takes every small product, CLI, and upstream item. This follows the maintainer's own precedent of folding N-1 to N-5 into one follow-ups PR, and its three task groups touch disjoint files.
- V5 stays separate from V1 because V1 must land fast, while V5 starts with research. They edit the same `scripts/run-tests.mjs`, so V5 goes second.
- The label guard waits for V7 because it rewrites comments in about 40 files that the other branches edit.
- usage-accuracy stays one branch, as M-7 decided.

### V1 `ci/windows-test-speed`: Windows legs back under 5 minutes

**Scope ([#262](https://github.com/pacphi/agentic-kit/issues/262)).** Run the issue's experiments in order, measure each on a Windows leg, and keep what pays:

1. Build the 3.14.4 fixture schema once per file (a `before` hook, then `copyFileSync` per store), and wrap each `buildStore` insert batch in `BEGIN`/`COMMIT`. This changes tests only.
2. Split `tests/kit/aqe-store-merge.test.mjs` into 3–4 files by concern, or give independent tests `concurrency`.
3. Add a Windows-only step that excludes `$env:RUNNER_TEMP` and `$env:GITHUB_WORKSPACE` from Defender.
4. Collect coverage on one leg only (ubuntu, Node 24), keeping the 70/70/70 threshold there. This edits `scripts/run-tests.mjs` and `ci.yml`, and states the change in `MAINTAINER.md`'s CI notes.

**Constraints:**

- The assertions stay unchanged apart from moving between files.
- Windows-specific cases (the EBUSY rename) still run on Windows.
- The real-state tripwire stays clean.
- The 30-minute job limit is not raised.

**Merge rule:** three consecutive PR runs with every Windows leg under 5 minutes. V7 posts the 10-run before/after table on #262 and closes it.

**Closes:** #262.

### V2 `docs/taxonomy-reorg` and `docs/archive-link-repair`: the docs taxonomy

**Scope:** [the taxonomy plan](../archive/2026-09-28-plan-docs-taxonomy-and-archive.md) as written, with its Proposed status lifted by D-3.

- PR A covers Tasks 1–9. Tasks 1–2 are tools only, so they can overlap V1. Task 3 regenerates the move map, and it starts only after the plan's "When to run" check prints nothing.
- PR B covers Tasks 10–12, cut from `main` after PR A merges and run alongside Wave 2.

**How v2's own plans relate to it:**

1. This plan stays in `docs/plans/` while v2 runs. PR A's relocation tool rewrites its links to moved files.
2. v1's finished plans (the program plan, the 6b and Branch 9 plans, and the others under `docs/superpowers/plans/`) go to `docs/archive/`. Their unfinished text lives on in V3, V4 and V5 by reference.
3. The decision log, `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md`, moves to `docs/plans/` under the same name. v2 is the active program, so the plan's "still open" case applies, and tests and `src/` files cite this log. Each v2 branch appends its "Implementation status" entry there. The new SDD folder `.superpowers/sdd/2026-09-28-remediation-program-v2/plan-path` points at this plan.
4. Every branch plan in v2 goes to `docs/plans/YYYY-MM-DD-<branch>.md`. Design and research notes go to `docs/plans/YYYY-MM-DD-<topic>-design.md`, including V5's temp-folder analysis, which the Branch 9 plan put under `docs/research/`. None ever goes to `docs/research/` or `docs/superpowers/`.
5. V7 archives this plan, the branch plans and the decision log with `scripts/docs-relocate.mjs`.
6. The two branches kept for v5 (D-9) move by the same rules when v5 picks them up.

If D-3 is B, PR A runs at V7's point, after every other branch has merged. v1's plans, v2's plans and the decision log then go straight to the archive, as that plan describes for a finished program.

### V3 `feat/dashboard-refresh`: one Refresh control and read-only GETs

**Scope:** 6c-1 to 6c-5, exactly as the 6b plan's section "Deferred to Branch 6c" writes them (its rulings, file map, pre-flight and review focus included). Every file:line there dates from `31a1a39b`, so re-verify each against `main` first. Added to that text:

- **Guard scope (ruling).** 6c-4 extends `tests/kit/refresh-vocabulary-guard.test.mjs` with the dashboard's retired control names. Its history exclusions also gain `docs/plans/`, because in-flight plans, this one included, name retired spellings on purpose. The exclusion list then matches the layout that PR A left (`docs/adr/`, `docs/archive/`, `docs/plans/`, `docs/proposals/`).
- **The dashboard noun (6b declined-to-judge).** 6c-4 retires the noun still left in `README.md` and `docs/DASHBOARD.md`, and the string at `src/lib/dashboard/client/maintenance-discovery.mjs:173`.
- **Client fixes in the files 6c-2 edits:**
  - the Claude Code badge reads "Unknown" when Configuration was not assessed (B0-22);
  - the Codex header icon may lack contrast (B0-23): measure it against WCAG's 3:1 minimum for non-text elements and fix it only if it fails;
  - `mntSyncHash`/`mntApplyHashState` re-derive their state from `location.hash` (B6a-12). Fix this if 6c-2 touches that code; otherwise open a small issue.
- **B6a-9.** 6c-5 records in ADR-0063 that two dashboard tabs share one server process's module state. If 6c-1's tests build the `ruflo-components` path, they also cover its cwd case; if not, drop that part by ruling.
- **D-15.** ADR-0048's status line records where its human-evaluation gates went.
- **The live view (#256).** Carry out D-18 and D-19 in the live-view docs (and the offset change if D-18 is B). Observe a plain-folder (non-Git) bind once on a real machine, and fix what the observation shows.
- **The "CONNECTING" stall (#254), only if §2 step 5 has produced a trace by the time V3 starts:** diagnose from the trace and fix it here, since the fix touches the same dashboard client code. Otherwise V3 leaves #254 alone.
- **Pre-PR.** Re-check the `codex app-server` read-only flags against the newest Codex.

**Closes:** B6b-3, B6b-8, B6b-13 and B6b-19 (their dashboard halves), B6b-18, B6a-9, B6a-12, B0-22, B0-23 and #256 (plus #254 if a trace arrived).

### V4 `fix/follow-ups-v2`: every small product, CLI and upstream item

One unit commit per line, test-first. The source text is the Branch 9 plan wherever a line names its task. Items are cited as A.1 … C.6.

**A. CLI `--json` honesty** (`bin/`, `src/commands/`)

1. Usage errors raised inside `usage`, `models`, `host`, `audit`, `heal` and the `ak x …` subcommands print one JSON object under `--json`, and `ak telemetry` does the same for a bad option (6b parked item 2, B6b-22). The same commit fixes two pre-existing gaps: `ak models <unknown verb> --json` exits 0, and plain `ak status` ignores a stray positional.
2. Every `ak host … --dry-run --json` path answers with one JSON object: `pick` refusals, `off` and `reset-routes` (6b parked item 3, m-4).
3. `selfDrift`'s two offline edge cases get a separate "tried at" stamp, so an offline machine retries once per TTL window. ADR-0063's "Known limitations" is updated (6b parked item 1, B6b-21).
4. A test pins that an injected `refreshStages` plus `service` builds no collector (the Minor from 6b's re-review).

**B. Status, memory, setup and Discovery correctness** (`src/lib/`, `src/commands/status/`)

1. A relative `XDG_*` value is ignored (Branch 9 Task 6; B6a-6, B2-6).
2. Re-record seams for `x/daemon-gc.mjs` and `setup.mjs` (Task 8), plus the one for `x/host.mjs` `pick` (deferred 13a) (B6a-3).
3. `rufloMemoryLocation` names both reasons when the root and the folder are both unsuitable (deferred item 11). `inside()` stops treating equality as "inside", so a `TMPDIR` set to a tool folder is read correctly (B9-12, B0-15).
4. N4, as D-4 decides (B9-3).
5. The stray scan walks dot folders below the root (B5-9, D-7). The real `~/.agentic-qe` home store is listed (B5-11). The `codex-mcp` hint stops suggesting AQE's broken Codex platform setup (agentic-qe#757) (B5-10).
6. `ruflo-components`: the applied-but-unverified row stops repeating the restart instruction (B0-21). The rows reading "partial — missing: Codex hooks" get a fix line once ruvnet/ruflo#3419 answers; if it is still unanswered at the pre-PR check, this part waits (LQ-2).
7. Ruflo daemon settings: F6, ak's `.claude-flow/config.json` hides YAML daemon keys (B3-9); F7, a versions-only sync writes daemon settings the dry run never shows (B3-10).
8. `pause()` writes a history summary, so a restart while paused shows "paused" (B9-2, Branch 9 Task 1's parked item).
9. An abort stops the whole process tree through `killGroup` (B0-13). Windows CI is the proof.
10. About nine persisted or serialized file-ID comparisons stop using `Number` (LQ-3).
11. deja-vu says "skipped", not "passed", after a skipped check, and the checks that create a temp folder get coverage for it (B9-16).
12. Reproduce with real Ruflo whether the setup probe leaves an unused `agentdb-memory.db` under a redirected memory root. Fix it if it reproduces; otherwise drop it by ruling (B0-14).
13. Only if §2 step 2 shows sync did not plan the AQE pin: fix sync's `aqe-pin` step.

**C. Upstream and the watch** (registry, `scripts/upstream-watch/`, workflows, docs)

1. N-1 (#574 → #240): run the busy-rule test as the Branch 9 plan's section "Added scope" describes. The same temporary CI job also runs `tests/live/ruflo-memory-routing.test.mjs` on Linux and Windows in a disposable home (B3-6). Remove the job before merge. If the rule goes, close #240 with the evidence (B4-4, B9-18).
2. N-2 in `docs/HOST-SUPPORT.md`: mark agentic-qe #528 and #532 adopted at 3.14.4, reword the #535 link to name only what still fails, and re-check lines :122 (ruflo#2356) and :130 (ruflo#420) (B4-10).
3. N-3: add the `trace-ort.mjs` hook to the nightly macOS live step, and keep its log as an artifact. **Interrupt:** you approve the exact text before the controller posts the log on ruvnet/ruflo#2885 (B9-15).
4. N-5: M7, M8 and minors 1–12, as `reports/n5-253-deferred-minors.md` §2 lists them. M10 is declined, because that doc matches the code. The registry's `openai/codex#15451` adjustment drops its stale "Re-probe … on Codex upgrades" sentence (B5-17). The rest of the watch stays as you left it (B4-11).
5. Draft the agentic-qe issue about `aqe init` (D-6 A). **Interrupt:** you approve the exact text. Draft the B0-16 report only if D-16 is B.
6. Pre-PR check against the newest releases inside the support window: Ruflo's `security secrets --path` and Codex's read-only `app-server` flags (#263 never recorded this check, B6b-25), plus AQE 3.14.x.

**Closes:** B0-13, B0-14, B0-15, B0-21, B2-6, B3-6, B3-9, B3-10, B4-4, B4-10, B4-11, B5-9 (the scan), B5-10, B5-11, B5-17, B6a-3, B6a-6, B6b-21, B6b-22, B6b-25, B9-2, B9-3, B9-12, B9-15, B9-16, B9-18, LQ-2, LQ-3, N-1, N-2, N-3, N-5 and 6b parked items 1–3 with m-4.

### V5 `test/runner-hygiene`: suites that clean up after themselves

**Scope:**

- Branch 9 Tasks 5, 7 and 10–13 as written, under their rulings B9-R1 … B9-R8. Before starting, merge `main` after V1 (both branches edit `scripts/run-tests.mjs`). Task 10's analysis goes to `docs/plans/` (see V2, point 4).
- LQ-1: `scripts/run-tests.mjs` stops stripping the developer's `AQE_EMBEDDER_*` and similar tool variables. This runs after Task 12, in the same file.
- LQ-4: `launchChrome` stops spreading `process.env`.
- Task 7 re-checks Ruflo's proven-config paths against the newest Ruflo in the support window.
- The controller switches the task-brief template to `node scripts/run-tests.mjs focus` once Task 12 lands (B9-20).

**Hand-off:** Task 13's reviewed literal-path list becomes §2 step 7.

**Closes:** B6a-7, B9-11, B9-13, B9-14, B9-20, LQ-1 and LQ-4.

### V6 `fix/usage-accuracy`: session surface first, then the capture backlog

**Scope:** v1 Branches 7 and 8 as the v1 plan's "Restructure" and "Wave 4" sections define them. No code-level plan exists yet, so the branch starts by writing one into `docs/plans/`.

1. Branch 7 items 1–5: the vocabulary module, one usage-cache schema bump (`SCHEMA_VERSION` 25 → 26, once), Codex `thread_source`, the counting rules, and runtime census symmetry.
2. Decisions B7-D1 … B7-D3:
   - "Cloud session" appears only when at least one such session was recorded.
   - Discover and record the real third-party provider of Claude sessions (Amazon Bedrock, Google Vertex, OpenRouter or another host) from environment, settings and model-id evidence; unknown stays unknown, and the provider shows in the detail view.
   - ADR-0060 records that the role lenses are deferred to v5.

   - Views that report project discovery or usage origins say that Cowork sessions are not covered yet (ADR-0060 §5; the first half of #257). The Cowork source itself comes after v2.

   ADR-0060 then becomes Accepted (B1-5).
3. Decision 12 (B1-4): exclusion becomes per turn. Imported turns never count; later real turns in the 6 affected rollouts count as Codex usage in the ChatGPT desktop app and give their folder a genuine Desktop origin.
4. Token-bearing Codex records with zero responses (1 file, 176,326 tokens on the reference machine) are either counted or their shape is stated precisely (UA-5).
5. Branch 8: O-7, X-7, X-8, C-6, C-8, C-9, C-11, O-6 and O-9 to O-12, one commit each, each starting with a reproduction on real data (counts only). Also the statusLine classifier reads managed settings, and a shell wrapper around the footer helper is classed `custom` (UA-4).
6. **After V3 merges** (merge `main` first), the UI commits:
   - item 6, one label per value across Usage, System → Projects, Maintenance and Intelligence;
   - B1-6, the count of imported copies in the Intelligence census line, the System → Projects summary line and the `ak system` text.

**Closes:** B1-4, B1-5, B1-6, UA-1, UA-3, UA-4 and UA-5.

### V7 `chore/v2-close-out`

1. Branch 9 Task 9 plus 13b: the comment-label guard over the whole tree. It needs no allowlist now that 6b has merged (B6a-5).
2. Re-run the Appendix A check: every row marked for a v2 branch must be closed, or moved to a named issue.
3. Add v2's summary entry to the decision log, run the docs alignment check, and archive the plans (V2, point 5).
4. Issues: post the #239 comment (D-5), close #262 with its 10-run table, and confirm #240's state. Close #254 as not reproducible if no trace arrived during v2, inviting a reopen with a trace. Update #257 to say its disclosure half shipped in V6.
5. Update the auto-memory, record v2's attended-time total in the ledger, and cut the final release (D-2).

### After v2 (not in this program)

Two of the issues punted from v1 are new capability, not remediation. They start once v2's definition of done is met:

1. **#255, the worker early-warning monitor** (#239 P0-3). It needs a design track first: brainstorm, spec, ADR, then a test-first build against recorded worker transcripts. The thresholds are costly to get wrong, so they get their own design pass.
2. **#257, Cowork as a discovery source** (the second half). Research where Cowork keeps its session records on each platform and which fields identify the project folder, reading only enumerated values and counts, then add it as an optional source. V6 ships the "not covered" disclosure in the meantime.

---

## 4. Execution

| Wave | Starts | Work | Runs in parallel | Your time |
|---|---|---|---|---|
| 0 | now | Decisions (§1); alpha.60 (D-2); #251 (D-8); §2 steps 1–4; the controller adds B0-24's evidence to #256; read-only planners for V3–V6 | planners | ≈ 1.5 h |
| 1 | after Wave 0 | V1; V2 PR A Tasks 1–2 (tools only) | both | ≈ 5 min |
| 1b | after V1 merges | V2 PR A Tasks 3–9 (the moves) → merge; no other PR open | — | ≈ 30 min |
| 2 | after PR A merges | V3, V4, V5, V6 (all but its UI commits), V2 PR B | all five | ≈ 45 min |
| 3 | after V3 merges | alpha.61; V6's UI commits → V6 merges | V4 and V5 if still open | ≈ 10 min |
| 4 | after every other branch merges | V7; the final release; §2 steps 6–7 | — | ≈ 45 min |

**Named interrupts (the only times you are asked mid-flight):**

- the exact text of the ruvnet/ruflo#2885 log post (V4 item C.3);
- the agentic-qe `aqe init` issue (V4 item C.5);
- a product bug from §2 step 2, if one turns up;
- any finding that would change a ruling in this plan.

**Shared files in Wave 2.** The second branch to merge merges `main` first.

| File | Branches | Note |
|---|---|---|
| `docs/adr/0063-…` | V3 (6c-5), V4 (item A.3) | V4 adds one "Known limitations" item only |
| `docs/adr/README.md` | V3, V6 | status rows only |
| user guides (`upgrading`, `troubleshooting`, `dashboard`, `maintenance`) | V3, V4 (item B.4) | different sections |
| `src/lib/dashboard/client/*` | V3, then V6's UI commits | V6 waits for V3 |
| `scripts/run-tests.mjs` | V1, then V5 | V5 starts after V1 |
| `.github/workflows/ci.yml` | V1, V4 (item C.1's temporary job) | removed before V4 merges |
| registry JSON, `nightly.yml`, `scripts/upstream-watch/*` | V4 only | — |
| the decision log | every branch | append-only entries |

---

## 5. Standing rules (carried from v1)

- **SDD.** For each task: an implementer works test-first and shows RED, then GREEN. A task review follows, then fix rounds (at most 5), then a scoped re-review. For each branch: the full gate set with the real-state tripwire, a final whole-branch review, one fix dispatch, a scoped re-review, the docs gate, then the PR. Rulings are recorded as "what — why — cost if wrong" in the v2 ledger (`.superpowers/sdd/2026-09-28-remediation-program-v2/progress.md`). Never message a running workflow agent; start a fresh one instead. A message relayed mid-task never authorizes a push, merge or post.
- **Merging and cleanup (D-1).**
  - Squash-merge only when every CI job is green, Windows included, and the final review has nothing left to fix. Then verify that the squash tree equals the branch tip's tree.
  - Fast-forward local `main` before cutting each worktree from it.
  - Remove the worktree, then the local branch, then the remote branch: one removal per command, each checked first, with literal absolute paths.
  - Never use `rm -Rf` on a path directly under `~` or `/`. Remove only this program's own junk; anything holding unmerged work is listed for you.
- **No `pnpm` in worktrees** (their `node_modules` is a symlink). Use `node --test`, `node scripts/run-tests.mjs`, `npx --no-install eslint|tsc|markdownlint-cli2` scoped to changed files, and `lychee`.
- **Tests never write real state.**
  - Use `sandboxHome()`/`spawnEnv()`. An `XDG_*` redirect also sets `APPDATA`/`LOCALAPPDATA`, and the tripwire stays clean.
  - A disposable environment unsets every `XDG_*` variable and uses `mktemp -d` with a template.
  - Unset `FORCE_COLOR`, relative `XDG_STATE_HOME` and `AQE_EMBEDDER_*` leaks before a gate.
- **No legacy (R17).** A retired spelling gets the generic parser error. The old → new mapping appears only in the PR body and the release notes.
- **Upstream posts** need your approval of the exact text. They follow the upstream issue standard: the problem, system info, a reproduction, proposed fixes and the impact on upstream's users, in a friendly tone. Before each PR, re-check assumed behavior against the newest releases inside the support window, and ground every rUv claim in installed code or a RuvNet Brain source path.
- **Issue titles** follow `AGENTS.md`'s "Issue Titles" section (Conventional Commits types).
- **Docs.** User-facing docs describe the current state only; history lives in ADRs and the decision log. An ADR a branch changes gets an `Updated` line. Comments cite ADRs, PRs or decision-log sections, never ledger task labels. Commits are conventional, carry no trailer, and stage files by name. Never commit `.harness/`, `.swarm/`, `.claude-flow/` or `.agentic-qe/`.

## 6. Definition of done

1. V1–V7 and V2's PR B are merged, each with the full gate and tripwire, a clean final review, and green CI including Windows.
2. No row in Appendix A or Appendix B still points at a v2 branch. Each is DONE with a PR, DECLINED or SUPERSEDED with a citation, a named open issue, or an answered decision.
3. The Windows legs' median is under 5 minutes over 10 runs, and #262 is closed with the table.
4. §2 is done:
   - the AQE pin has converged in `ak status`;
   - the footprint snapshot has the current schema;
   - the stray store is handled as D-7 decides;
   - the temp backlog is removed.
5. The releases approved in D-2 are published, and the global `ak` matches the latest one.
6. The upstream watch is live and quiet: N-5 is merged, #240 is closed or its evidence is posted, and the scheduled run has nothing waiting on us. The first real dispatch is recorded when a release fires one; today `events.ndjson` on `upstream-watch-ledger` holds 0 `fired` records.
7. Locally, only `main` and the two v5 branches (D-9) remain, with no v2 worktree or scratch folder left behind.
8. The plans and the decision log are archived per the taxonomy, the auto-memory is current, and the ledger records v2's attended time.

---

## Appendix A: the reconciliation's 189 rows

Each of the 189 row ids appears exactly once; a script checked the ids against the reconciliation. "V-n" means a v2 branch above, "D-n" a decision in §1, and "§2" a one-off.

**Totals:** 88 DONE, 49 for v2 branches, 12 decisions, 8 on named issues, 2 one-offs in §2, 11 DECLINED, 9 SUPERSEDED, 6 definition-of-done rows carried into §6, and 4 split rows (B5-9, B6b-13, B6b-19, B6b-24). **None is unaccounted.**

| Rows | Disposition | Evidence or home |
|---|---|---|
| B0-1, B0-2, B0-3, B0-6, B0-11, B0-12 | DONE | #241 (`476717b6`) |
| B0-5 | DONE | `links (external)` in `.github/workflows/nightly.yml`; `links (internal)` in `ci.yml` |
| B0-7 | DONE | #252 (`31a1a39b`), 6a Task 11 (about a 96 % cut) |
| B0-8 | DONE | Check ran in #241; the About render test moved to B9-11 (V5) |
| B0-9 | DECLINED | Ruling `L:35` (normal dashboard operation); the `readLimits` part is B6b-15 |
| B0-10 | DONE | `locators.json` has 0 matches for `/Users/someone` (re-checked 2026-09-28) |
| B0-4 | D-17 | — |
| B0-13, B0-14, B0-15, B0-21 | V4 | Items B.9, B.12, B.3, B.6 |
| B0-16 | D-16 | — |
| B0-17 | DECLINED | Documented trade-off (`ak sync --help`, ADR-0033 §9) |
| B0-18 | DONE | #263 (`e957737b`): `docs/TROUBLESHOOTING.md:94` now reads "Windows Limits data appears after `ak sync`" |
| B0-19 | DONE | Windows CI green on #241 through #263 |
| B0-20 | SUPERSEDED | #241's squash dropped them; briefs forbid trailer-like lines |
| B0-22, B0-23 | V3 | Client fixes |
| B0-24 | issue #256 → V3 | The controller adds the evidence in Wave 0; V3 closes #256 (D-18, D-19) |
| B0-25 | D-5 | — |
| B1-1, B1-2 | DONE | #244 (`5f5ca175`) |
| B1-3 | §2 step 3 | Snapshot still schema 7 |
| B1-4, B1-5, B1-6 | V6 | Items 3, 2 and 6 |
| B2-1, B2-2, B2-3, B2-4 | DONE | #245 (`a0b75494`); strict Windows tripwire on #252 |
| B2-5 | DONE | #263: `tests/kit/verify-command.test.mjs` is gone, and its stricter replacements showed 0 flakes in 20 runs (`L:380`) |
| B2-6 | V4 | Item B.1 |
| B3-1, B3-2, B3-11, B3-12, B3-13 | DONE | #247 (`26460999`) |
| B3-3, B3-4, B3-5 | DONE | Evidence on ruvnet/ruflo#3196; filed ruvnet/ruflo#3509 and #3508. All three are in the registry (`src/lib/hook-audit/agentic-dependency-constraints.json`) |
| B3-7, B3-8 | DONE | Re-checks recorded (`reports/b3-plan.md`; `L:195`) |
| B3-6, B3-9, B3-10 | V4 | Items C.1, B.7 |
| B4-1, B4-2 | SUPERSEDED | Decisions 14 and 15: #249 (`88e26999`), #253 (`82d1211b`); #243 closed |
| B4-3, B4-5 | DONE | #246 (`fca6b2bc`; the reconciliation's `29f93dfc` is a branch commit) |
| B4-4, B4-10 (docs part), B4-11 | V4 | Items C.1, C.2, C.4. B4-10's registry part is DONE in #258 (`a77bfdee`) |
| B4-6 | SUPERSEDED | #617 was handled by hand in #250, and dispatch was redesigned in #253. The first live dispatch is tracked in DoD 6 |
| B4-7, B4-8 | DONE | Replies posted (`L:56`, `L:117-118`) |
| B4-9 | DONE | #249 (`88e26999`) |
| B4-12 | DONE | #250 (`3929cdd5`) |
| B5-1, B5-2, B5-14, B5-16 | DONE | #250 (`3929cdd5`) |
| B5-3 | issue agentic-qe#655 | Kept on conformance evidence; #755–#758 watched |
| B5-4 | DONE | #248 (`1c3c4d35`) |
| B5-5 | issue agentic-qe#753 | AQE repairs the chain |
| B5-6 | DONE | Filed agentic-qe#754; wording in #250 |
| B5-7 | DONE | Receipt `2026-09-28T05-12-26-792Z/receipt.json` (verified present) |
| B5-8 | §2 step 2 | Pin still absent (verified) |
| B5-9 | V4 and D-7 | Item B.5 (the scan) + D-7 (the store) |
| B5-10, B5-11, B5-17 | V4 | Items B.5, C.4 |
| B5-12 | DONE | Folded into the agentic-qe#735 comment |
| B5-13 | DECLINED | Ruling `L:188` |
| B5-15 | D-6 | — |
| B5-18 | DONE | vibium uninstalled with approval (`L:176`, `L:180`) |
| B5-19 | DONE | Registry lists agentic-qe#561 and #755–#759 (grep) |
| B5-20 | DONE | 21 posts read back (`L:215-239`) |
| B5-21 | DECLINED | Maintainer decision `L:213` |
| B6a-1, B6a-13 | DONE | #252 (`31a1a39b`), released in alpha.59 |
| B6a-2, B6a-4, B6a-8 | DONE | #263: ADR-0063 `:102`; the `guarded` probe around `refreshPlanHosts` in `sync.mjs`; ADR-0063 "Known limitations" item 1 |
| B6a-3, B6a-6 | V4 | Items B.2, B.1 |
| B6a-5 | V7 | Item 1 (6b removed its own labels in #263) |
| B6a-7 | V5 | Task 7 |
| B6a-9, B6a-12 | V3 | — |
| B6a-10, B6a-11 | DECLINED | `L:313`, `L:323` |
| B6b-1, B6b-2, B6b-4, B6b-5, B6b-6, B6b-7, B6b-9, B6b-10, B6b-11, B6b-15, B6b-16, B6b-17, B6b-20, B6b-23, B6b-26 | DONE | #263 (`e957737b`): `src/lib/refresh.mjs`, `src/lib/live-checks.mjs`, `x/host-connection.mjs`, `reset-routes`, `--show-text`, `sync/plan-versions.mjs`, `configErrorRecovery`, `tests/kit/host-dry-run.test.mjs`, `quota.mjs` `host-not-found`, ADR index rows 0053–0063 |
| B6b-3, B6b-8, B6b-18 | V3 | 6c-1 … 6c-3 |
| B6b-13, B6b-19 | DONE (CLI half) and V3 (dashboard half) | #263 Tasks 13–14; 6c-4, 6c-5 |
| B6b-12 | SUPERSEDED | False premise (R11) |
| B6b-14 | SUPERSEDED | R17 |
| B6b-21, B6b-22, B6b-25 | V4 | Items A.3, A.1, C.6 |
| B6b-24 | DONE (PR body) and D-2 (release notes) | #263's body |
| UA-1, UA-3, UA-4, UA-5 | V6 | — |
| UA-2 | issue #257: disclosure in V6; the source after v2 | See "After v2" |
| B9-1, B9-4, B9-8, B9-17 | DONE | #259 (`172f2307`): orchestrator restore, "Partial data" card, round-trip prune, `docs/SETUP.md:126` and the `docs/UPGRADING.md` section of 2026-09-28 |
| B9-2, B9-3, B9-12, B9-15, B9-16, B9-18 | V4 | Items B.8, B.4, B.3, C.3, B.11, C.1 |
| B9-5 | issue #254: evidence-gated (§2 step 5) | V3 fixes it if a trace arrives; V7 closes it otherwise |
| B9-6 | issue #255: after v2 | See "After v2" |
| B9-7 | DECLINED | B9-OQ1 |
| B9-9 | DECLINED | B9-R12 |
| B9-10 | issue #256 → V3 | D-18, D-19 and one real-machine observation |
| B9-11, B9-13, B9-14, B9-20 | V5 | B9-14 then goes to §2 step 7 |
| B9-19 | DONE | #261 (`0fa5e489`) |
| LQ-1, LQ-4 | V5 | — |
| LQ-2, LQ-3 | V4 | Items B.6, B.10 |
| HK-1 | DONE | `git ls-remote --heads origin feat/managed-ruflo-components` is empty |
| HK-2, HK-3 | DONE | `git worktree list` and `git stash list` |
| HK-4 | DONE | Dependabot #231 closed |
| HK-5, HK-7 | DECLINED | Stay documented or excluded (v1 plan; `H1:159-160`) |
| HK-6 | D-9 | — |
| HK-8, HK-9 | DONE | No `ak-*` folder beside the repository (`L:513`, re-checked) |
| HK-10 | SUPERSEDED | M-2 |
| HK-11 | issue stuinfla/ruvnet-brain#335 | — |
| HK-12 | DONE | alpha.58 (`f3106a8c`), alpha.59 (`b84b5a7e`) |
| HK-13 | DONE | #258 (`a77bfdee`) |
| HK-14 | DONE | Probe repository returns 404; ruleset `24138491` active |
| HK-15 | D-8 | — |
| DG-1, DG-2, DG-3, DG-4, DG-5, DG-6 | D-10 … D-15 | — |
| AU-1, AU-2, AU-3, AU-4, AU-5, AU-6, AU-7, AU-8 | DONE | #240 exists; agentic-qe#734 (retired in #258), stuinfla/ruvnet-brain#330 and #331, ruvnet/ruflo#3446 and agentic-qe#735 are in the registry; the #574 note is issuecomment-5863219357 (`L:229`); stages 4–5 shipped in #241 |
| AU-9 | DECLINED | Paid qe-court live test stays manual |
| AU-10 | SUPERSEDED | Decision 15 |
| HO-1 | SUPERSEDED | #253 merged; the hold lifted for N-5 only |
| DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-6 | v2 DoD | 1, 2, 6, 8, 7, and §5 with DoD 1 |

## Appendix B: items added since the reconciliation

57 items: #262, the taxonomy plan, N-1 to N-5, the 15 N-5 minors, 6b's four parked items and its re-review Minor, 6b's 14 declined-to-judge items, Branch 9's parked `pause()` item and its 13 declined-to-judge items, the EPIPE fix, and one conditional item. **None is unaccounted.**

| Item | Disposition | Evidence or home |
|---|---|---|
| #262, Windows CI slowdown | V1 | — |
| The docs taxonomy plan | V2 | D-3 |
| N-1, N-2, N-3, N-5 | V4 | Items C.1 to C.4 |
| N-4 | DONE | #261 (`0fa5e489`) |
| N-5 minors M7, M8 and 1–12 (14 items) | V4 | C4; each is listed in `reports/n5-253-deferred-minors.md` §2 and was present on `main` |
| N-5 minor M10 | DECLINED | #253's final review: "None needed"; the doc matches the code |
| 6b parked items 1, 2, 3 and m-4 | V4 | Items A.3, A.1, A.2 |
| 6b re-review Minor (no test pins the injected path) | V4 | Item A.4 |
| 6b declined-to-judge: `ak models` exits 0 on an unknown verb; stray positional on plain `ak status` | V4 | Item A.1 |
| 6b declined-to-judge: the dashboard noun left in README and DASHBOARD | V3 | 6c-4 |
| 6b declined-to-judge: the newest in-window re-check | V4 | Item C.6 (B6b-25) |
| 6b declined-to-judge: Windows behavior | DONE | #263's Windows CI legs green |
| 6b declined-to-judge: the other 9 (parallel named proofs, live summary on system and maintain, the live-check label, no ticker for fast stages, concurrent CLI and dashboard scans, `--refresh=local` undocumented, maintenance writes under `--refresh`, the not-scanned step text, `check-connection --dry-run`'s local checks) | DECLINED | The reviewer found each by design, specified by the plan, or pre-existing and harmless |
| Branch 9 Task 1's parked `pause()` summary | V4 | Item B.8 (same as B9-2) |
| Branch 9 declined-to-judge: Tasks 5–14 and N-1 to N-5 | V4, V5 | Mapped above |
| Branch 9 declined-to-judge: Windows behavior (EBUSY, junctions) | DONE | #259's Windows CI legs green |
| Branch 9 declined-to-judge: 6b's uncommitted `DASHBOARD.md` hunks | SUPERSEDED | #263 merged |
| Branch 9 declined-to-judge: census numbers not re-run | V6 | Item 4 re-measures |
| Branch 9 declined-to-judge: the other 9 (history read per `coverage()`, non-canonical copies kept, trailing newline, `sudo` uid, `env` key position, commented TOML line, CRLF fixtures, `UPGRADING.md` date order, copies of a released file) | DECLINED | The reviewer found each safe by design or out of scope |
| EPIPE in `runWithInput` (seen on #261's CI) | DONE | #260 (`ad0170d9`) |
| AQE pin not planned by sync (conditional) | V4 | Item B.13, only if §2 step 2 shows it |
