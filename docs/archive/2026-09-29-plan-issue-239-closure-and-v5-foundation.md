# Issue #239 closure and the v5 foundation

> **For agentic workers:** this is a program plan. Execute it with
> superpowers:subagent-driven-development after the maintainer answers §4 and confirms the plan at
> the re-evaluation point (§1). Write each workstream's code-level plan with
> superpowers:writing-plans against `main` as it stands when the workstream starts.

## Status

**Blocked** on two things: the final `develop` → `main` PR of the
[remediation program v2](2026-09-28-plan-remediation-program-v2.md), which a separate Codex session is
executing, and the maintainer's answers to the decisions in §4. Nothing here starts before both. It also **depends on the
[execution evidence plan](2026-09-29-plan-execution-evidence-and-upgrade-acceptance.md) completing** (its §5 gate):
that plan holds the four items v2 deferred (identity, outcome recording, cancellation, the upgraded-install
matrix) and the monitor (#255), and this plan's release-level proof cannot start before it is met.
Written 2026-09-29 against `origin/develop@bb2e7efe` and `origin/main@b982eff9`. Every condition this
plan depends on was probed read-only first; §3 records what held, what did not, and what is still
unverified, and the plan was corrected where a probe refuted it.

**Goal:** close #239 against its own criteria, close every open issue in #240–#271, archive the
program's plans, and reach a state where v5 starts from a clean foundation.

**Reading key.** Each item carries an owner tag:

- **[AK]** agentic-kit controls the whole path.
- **[UP]** waits on an upstream maintainer; ak can only mitigate at its own boundary.
- **[MAINT]** needs the maintainer's decision or hands (real machine, approval, publication).
- **[MIX]** an ak part and an upstream part; both are named.

**Decision this plan changes.** v2 decision D-5 moved four #239 items to "v5 scope". D-20 (answered
2026-09-29) exports them to the execution evidence plan instead of leaving them for v5; this plan waits on
it.

## 1. Watch and re-evaluate

**Trigger.** A PR with base `main` and head `develop` exists, or v2's Status says V7 is done.

```bash
git fetch origin
git log --oneline origin/main..origin/develop
gh pr list --repo pacphi/agentic-kit --base main --head develop --json number,state,statusCheckRollup
gh issue list --repo pacphi/agentic-kit --state open --json number,title
node scripts/upstream-watch.mjs report --json     # read-only; note lastRun (null on 2026-09-29)
```

**At the trigger:** re-read v2's Status, Appendix A/B and DoD §6 and drop or rewrite any workstream v2
delivered; re-run the pending sentry tests in §8; re-list issues filed after 2026-09-29; re-check ADR
status lines (0048, 0060, 0062, 0063); refresh the upstream rows in §2.2 from the watch report.

## 2. Ownership: what ak controls and what waits on upstream

### 2.1 Issues in #239 and #240–#271

| Issue | State 2026-09-29 | Owner | What closes it |
| --- | --- | --- | --- |
| #239 | Open tracker | [MIX] | The execution evidence plan (E1–E4), then W5–W9 here and the closure rule in §6; several rows depend on AQE and Ruflo (§2.2) |
| #240 | Open; code already retired the temporary rule | [AK] closure, [UP] cleanup | D-25, then close |
| #254 | Open; needs a browser trace | [MAINT] evidence | D-26 |
| #255 | Open; monitor design | [AK] | E3 in the execution evidence plan |
| #256 | Open; three live-view questions | [AK] plus [MAINT] real-machine step | V3 delivers D-18/D-19; one bind observation |
| #257 | Open; Cowork source | [AK] on an undocumented format | D-29 |
| #262 | Open; #267 merged | [AK] | ten consecutive fast runs (§3, P12) |
| #271 | Open; not in v2 | [MIX] | ak parts in W7; root cause is Brain #335 [UP] |

### 2.2 Upstream-blocked register

State fetched from GitHub and npm on 2026-09-29. "ak meanwhile" is what ak does at its own boundary.

| Thread | State | ak meanwhile | Done when |
| --- | --- | --- | --- |
| agentic-qe#574 (live-lock create ladder) | Closed 2026-09-29 by PR #782 (`22aa3b9a`); **in no release** (not in 3.14.3/4/5) | Rule already retired on develop against 3.14.4 | A release contains #782; ak re-runs conformance on it |
| agentic-qe#719 (`LockHeld`) | Merged; first in 3.14.4 (ancestry-verified) | Minimum for store merge is 3.14.4 | Done |
| agentic-qe#707 (cancel aborts in-flight work) | **Open** | Treat `cancelled` as "requested"; check own child process for "stopped" | A release where cancel stops the executor |
| agentic-qe #782/#784/#788 | On `main` only, unreleased | None | Next AQE release |
| stuinfla/ruvnet-brain#335, #331 (forge-update reclaim) | Open, no fix; 4.3.35 unverified | ak-side TTL, retry flag, clearer state (W7) | A Brain release whose update path can reclaim or bypass `kb.bak-*` |
| ruvnet/ruflo#3196 (CLI/MCP split) and agentic-kit #213 | Open, no fixed minimum | Route proof via `ak x verify memory` | A Ruflo release with one routing contract |
| ruflo#3508 (read-only route peek), #3509, #3449, #3446 | Open | Existing mitigations | Upstream fix and release |
| ruflo#2885 (macOS mutex crash) | Open; reproduces on 3.48.0 | Trace posted 2026-09-29 | Upstream fix |
| Ruflo task ledger integrity (no issue exists) | Not filed | Treat `task_*` as untrusted (P1) | D-32 |
| Claude Desktop / Cowork storage | Undocumented | Disclosure only (V6) | D-29 |

## 3. Sentry test ledger

"Sentry test" here means: probe each condition read-only and record the result before the plan commits
to it. Probes ran on a pristine extract of `origin/develop@bb2e7efe`, with sandboxed homes and no `XDG_*`.
No real state was written; two live statusline files changed during the run and belong to this session.

| # | Condition the plan relied on | Probe | Result | Verdict |
| --- | --- | --- | --- | --- |
| P1 | AQE and Ruflo expose task identity, progress, cancel, persistence | Read installed AQE 3.14.4 and Ruflo 3.48.0 `dist/` plus read-only MCP calls | AQE: identity, coarse states, `cancellationResultPending`, late-result discard exist; **no per-task progress**; timeouts unenforced by the queen; missing handler leaves the task `running` forever; results in memory. Ruflo: free-string status, `task_cancel` overwrites `completed`, `task_complete` accepts an empty result, `hooks_worker-dispatch` returns `success:true` while doing nothing. | PARTIAL for AQE, REFUTED for Ruflo as evidence |
| P2 | ak can poll AQE task state from outside | Inference from P1 (results live in the server process) | ak cannot read another process's in-memory task map; a stdio MCP server is per-session | **UNVERIFIED, high risk**: spike before E3 relies on it |
| P3 | ak's runner can represent every #239 outcome | Fake adapter through `executeWorker`, 300 ms deadline | Represented: never-start (launch), slow-valid, failed child, empty result, deadline, cancel refused (`orphaned`), missing handler. **Absent**: stall/no-progress status, cancel-requested vs stopped, late-completion record, live lock, I/O category | REFUTED in part |
| P4 | Hung `prepare` is cleaned up | Code reading (`runner.mjs:109,138`) | No cancel or cleanup when `state` is null | Not executed; run before E2 |
| P5 | Progress deadline exists | Read `runner.mjs:40-66` | One wall-clock budget per attempt; none per phase progress | REFUTED |
| P6 | Alerts and outcome history have a home | Search `src/` | No dashboard alert store; `ak run` persists nothing; exit code is 1 for any non-success | REFUTED: E3 must add a store |
| P7 | `spawnEnv()` unsets `XDG_*` | Read `home-sandbox.mjs:82-98` | It sets them to sandbox paths | Premise corrected |
| P8 | Upgraded-install fixtures exist | Read three tests | One preserved-custom-MCP fixture; no foreign-bin or disabled-but-installed fixture | REFUTED |
| P9 | `ak sync` twice converges | Two sandboxed dry-runs | Identical plans, exit 0, no ak state written | VERIFIED as stability only (real PATH visible) |
| P10 | Stopped-service detection and a pre-install executable inventory exist | Search `src/` | Neither found; only an `installMethod` fact and a daemon status row | UNVERIFIABLE, treat as missing |
| P11 | #271 needs no new persisted state for a TTL | Sandbox test | Hold stamps `at`; `ttlHours` is computed in `drift()`; the one call site needs it plumbed; failing test written | VERIFIED |
| P12 | #262 is ready to close | `gh run` over 34 CI runs since #267 | Windows legs median **3.6 min** (11.6 before), p90 4.4, 2 of 83 successful legs over 5 min; but eight runs had a failed Windows leg, and the newest unbroken streak is **7**, not 10 | **NOT yet**; count to ten |
| P13 | #240's temporary rule is gone | Search plus ADR headers | `FsyncFailed` now returns `failed` (`aqe-readiness.mjs:30`); ADR-0062 records 3.14.4 macOS/Linux conformance; registry entry still `watching` | VERIFIED; registry not updated |
| P14 | Windows live-lock conformance runs in CI | Read workflows | No workflow runs either live test on Windows; nightly is ubuntu and macOS only | REFUTED; evidence is an external comment on agentic-qe#574 |
| P15 | Provider identity is available per invocation | Search `providerProvenance` | claude and codex adapters always record `unknown`; only OpenCode records `observed`; nothing persisted per run | REFUTED |
| P16 | Cowork records are discoverable | Official docs and a names-and-counts listing | Docs give no path or folder ID; storage is reverse-engineered; the Desktop directory was already renamed once; file contents not read | HIGH stability risk |
| P17 | The stale `obtainBundle()` comment (`heal.mjs:336`) can be checked in ak | Grep | It describes upstream code | UNVERIFIABLE here |

## 4. Decisions for the maintainer

Numbering continues v2's D-19. Each has at least three options and one **Recommended**. Sources are in
§10; quotes were returned by the fetch tool's summarizer, so re-verify any quote before it is
published outside this repository. Where evidence is weak, the decision says so.

### D-20 Where the four deferred #239 items live

**Answered 2026-09-29: export to a separate plan, and make this plan depend on it.** The maintainer chose
this over the options below. The four items (execution identity, terminal-outcome recording, cancellation
semantics, the upgraded-install and outcome matrix) and the monitor (#255) now live in the
[execution evidence plan](2026-09-29-plan-execution-evidence-and-upgrade-acceptance.md) as E1–E4, and this plan
starts its release-level proof only when that plan's §5 gate is met.

Options offered: **A** build them here as W1–W4 (recommended; work that misses its Definition of Done
"cannot be released" [S36]); **B** keep v2's D-5 and close #239 with them open; **C** build only identity
and outcome recording now. The chosen split keeps A's outcome while giving the execution-truthfulness track
its own decisions and gate.

### D-21 to D-23 Monitor scope, cancellation and fencing, fault-mode testing

Moved to the [execution evidence plan](2026-09-29-plan-execution-evidence-and-upgrade-acceptance.md) §3.
D-21 (monitor scope) was answered A on 2026-09-29; D-22 and D-23 are open there.

### D-24 Hold policy for #271 (Brain refresh)

- **A. Recommended.** Time-to-live expiry moves a hold to a half-open state and runs one bounded re-check
  of whether the blocking condition (an oversized `kb.bak-*` snapshot, `BRAIN_RECLAIM_STUCK`) still
  holds; success clears it, failure restarts the wait; add a force-retry flag that skips the wait but
  still runs the check. **Why:** this is the circuit-breaker half-open shape [S8]; P11 shows the TTL
  needs no new state, and the re-check can read the same snapshot condition `heal.mjs` already computes.
  Limit automatic retries to operations marked safely repeatable [S9], [S10].
- **B.** TTL expiry only. **Why not:** retries blindly whether or not the condition cleared.
- **C.** Force-retry flag only. **Why not:** that is today's failure: it never self-clears.

*Limit:* upstream reclaim runs only inside `--apply`, so ak cannot reclaim disk itself; the root cause
stays with Brain #335 [UP]. The AWS guidance on capped backoff and jitter could not be fetched, so no cap
or jitter value is source-backed here. The Idempotency-Key document is an IETF draft, not a standard.

### D-25 What "fixed upstream" means for #240

Issue #240's exit criterion names a release containing #719 "or equivalent". #719 shipped in 3.14.4; the
extra-attempt cleanup (#782) is unreleased; 3.14.5 is current.

- **A. Recommended.** Close #240 on #719 in 3.14.4 plus ak's macOS/Linux conformance re-run (ADR-0062),
  mark the registry entry done, and open no new tracker for #782. **Why:** the exit criteria are met as
  written (P13); #782 only removes noise, and #574 says the noise is not blocking.
- **B.** Keep #240 open until a release contains #782, and re-run conformance on it. **Why not:** holds a
  finished mitigation hostage to a cosmetic upstream change.
- **C.** Close #240 and raise the AQE minimum to 3.14.5 (adds the witness-chain fix). **Why not:**
  widens the support floor for an unrelated fix; decide it under its own issue.

*Note:* native Windows conformance is separate (D-27).

### D-26 The "CONNECTING" stall (#254)

- **A. Recommended.** Ship diagnostics so the next occurrence reports itself: client `readyState`, timing
  and `error` events [S12]; a server keep-alive comment about every 15 seconds and a `retry:` field
  [S11]; `X-Accel-Buffering: no` for proxies [S13]. Keep #254 open with a review date; close as not
  reproducible after 30 days without a report. **Why:** the spec names dropped connections behind legacy
  proxies [S11], and this collects evidence without needing a trace.
- **B.** Close now as not reproducible, inviting a reopen with a trace (v2's V7 default). **Why not:**
  the stall probably recurs silently.
- **C.** Keep open indefinitely awaiting a trace. **Why not:** collects nothing.

*Weakness:* no source shows proxy buffering causes this symptom, and the server opens the stream in
about 1.6 ms, which points away from server slowness. It is a hypothesis.

### D-27 Native Windows conformance for AQE live locks

Neither live test runs on Windows in any workflow (P14). The only Windows evidence is an outside
commenter's report on agentic-qe#574.

- **A.** Accept and disclose, citing that external report. **Why not:** unverified by us.
- **B. Recommended.** Add a dispatch-only `windows-latest` job (Windows Server 2025, 4 vCPU, 16 GB [S34])
  that installs AQE 3.14.4 or later, sets `AK_AQE_PACKAGE_ROOT` and `AK_AQE_LOCK_LIVE=1`, and runs the
  conformance test; run it once, then decide whether to keep it nightly. **Why:** it converts an
  unverified claim into a receipt at low cost.
- **C.** Ask the AQE maintainer to run Windows conformance. **Why not alone:** puts an ak claim on
  upstream's schedule.

*Unverified:* the `win32-x64-msvc` native package installing on the runner, and whether `pnpm test`
globs `tests/live/`. A dispatched run consumes CI minutes and needs your go-ahead.

### D-28 Provider identity (W5)

Every source found is self-reported by the client or configuration: Claude Code's `model` and
`request_id` [S31], Codex's `model_provider` in configuration [S32], and OpenTelemetry's
`gen_ai.provider.name` "as identified by the client or server instrumentation" [S33]. None is a signed
attestation (P15).

- **A. Recommended.** Record two fields per invocation, **declared provider** (configuration) and
  **observed response model**, using ADR-0060's existing `unknown`, `inferred`, `observed` labels, and
  never the word "attested". Populate them for claude and codex adapters where the host emits them.
  **Why:** honest about what can be known, and it satisfies "configured routes alone do not prove
  independent vendors".
- **B.** A local recording proxy between host and provider. **Why not:** alters auth flows, adds a
  failure point, and still trusts the endpoint's own claims.
- **C.** Leave provenance as-is and disclose. **Why not:** leaves the #239 P1 row open.

*Unverified:* the Codex rollout schema documentation and OpenCode's session storage and telemetry.

### D-29 Cowork discovery (#257)

Cowork's local storage is undocumented. Anthropic says only that "Cowork stores conversation history on
users' computers" [S29]. The Desktop session directory was renamed once with no migration [S30]. P16
found session files but not whether they name the project folder.

- **A. Recommended, gated.** First a spike that reads one enumerated field set (names and counts only)
  to confirm a project-folder field exists. If it does: an optional, labelled experimental adapter with
  a drift guard that reports sessions skipped and why. If it does not: choose B. **Why:** ADR-0060 §5
  already commits to an optional source, and honest coverage reporting absorbs format drift.
- **B.** Keep the disclosure only and close #257 as blocked on a documented Anthropic interface.
  **Why:** avoids depending on a format the vendor can change.
- **C.** Use Anthropic's documented OpenTelemetry export instead of file scraping. **Why not:** it
  requires enterprise configuration, and the docs list file paths accessed rather than a project folder.

### D-30 Branch model after v2

- **A. Recommended.** Return to `main` with short-lived feature branches, cutting a release branch only
  when a release needs hardening. **Why:** DORA lists "three or fewer active branches" and daily merges
  to trunk [S16]; trunk-based practice resists "other long-lived development branches" [S15]; Fowler
  notes integration frequency has "a remarkably powerful effect" [S14]; v2's own big-bang merge is the
  cost these describe.
- **B.** Keep `develop` as a standing integration branch. **Why not:** it is the existing structure but
  invites the divergence [S14] warns about.
- **C.** Keep `develop` only for release-candidate windows. **Why:** a release branch cut from trunk
  [S15], deleted afterwards, is the same idea as A's escape hatch.

**Answered 2026-09-29: A.**

*Weakness:* DORA's research is general and dated (2016–2017); a solo-maintained CLI is not its subject.
Deleting `develop` after the merge needs your explicit go-ahead.

### D-31 When the plans may be archived

You asked that each plan be "satisfied entirely" before it moves. Some closing rows are hands-on and
gated (publish and install a release, merge the stray store, clear the temp backlog).

- **A. Recommended.** Archive each plan the moment every one of its rows is satisfied or dispositioned to
  a named open issue, in this order: CI plans, v1 plan, decision log, v2 plans, this plan last. A gated
  operation keeps its plan in `docs/plans/`; it is never handed off to be forgotten. **Why:** a
  superseded record is kept, marked, not deleted [S35]; a plan short of its Definition of Done is not
  done [S36]; and it preserves your "entirely" rule.
- **B.** Archive all at once after the final `develop` → `main` merge, stating remaining operations in each
  Status. **Why not:** contradicts "satisfied entirely".
- **C.** Archive the finished plans now (CI plans, v1) and leave the rest. **Why not:** Codex is editing
  files these plans cite; moving them now would collide (see §7).

**Answered 2026-09-29: A.**

### D-32 Ruflo defects found in P1

Four Ruflo behaviours have no upstream issue: free-form task status; `task_cancel` overwriting a
completed task and a later `task_complete` flipping it back; `task_complete` accepting an empty result;
`hooks_worker-dispatch` returning `success:true` while no work runs. They were read from source only.

- **A. Recommended.** Reproduce each in a disposable directory first, then file four separate issues
  following the upstream issue standard (problem, system info, reproduction, proposed fixes, impact),
  in a friendly tone, each awaiting your approval of the exact text. **Why:** separate defects get
  separate fixes; reproduction turns a source reading into evidence.
- **B.** One umbrella issue. **Why not:** hard to close and easy to leave half-fixed.
- **C.** Do not file; treat Ruflo's ledger as untrusted permanently. **Why not:** leaves #239's
  "success without valid results" row dependent on an unfixed upstream.

### D-33 Closing #262

P12: median 3.6 min against 11.6 before; the newest unbroken streak is 7 fast, fully green runs.

- **A. Recommended.** Wait for ten consecutive fully green, all-legs-under-five runs (the CI plan's Task 4
  wording), then post the before/after table and close. **Why:** it is the stated criterion; the streak
  should reach ten as v2's remaining PRs run.
- **B.** Close now on the median. **Why not:** eight recent runs had failing Windows legs, so the median
  over successes flatters the result.
- **C.** Keep open for a week of soak. **Why not:** adds delay beyond the criterion.

## 5. Workstreams

Each has one writing owner, exact path claims, and a code-level plan written at its start. Effort is
S/M/L. Every workstream ends with a docs alignment pass and a Status update here. W1–W4 became E1–E4 in the
[execution evidence plan](2026-09-29-plan-execution-evidence-and-upgrade-acceptance.md); the numbers below keep
their original labels.

| W | Deliverable | Owner | Depends on | Effort |
| --- | --- | --- | --- | --- |
| W0 | Plan disposition (§7) | [AK] + [MAINT] | v2 done; D-31 answered A | S |
| — | Gate: the execution evidence plan (E1–E4) is complete | [AK] | its §5 | see that plan |
| W5 | Provider provenance (ADR-0060 acceptance) | [AK] | D-28 | M |
| W6 | Acceptance receipts and release-level proof | [MAINT] gates | all, release approval | S |
| W7 | #271 fixes; #240 closure; registry update | [AK] | D-24, D-25 | S |
| W8 | #262, #254, #256 closures and diagnostics | [AK]/[MAINT] | D-26, D-33 | S |
| W9 | Cowork spike and adapter (#257) | [AK] | D-29 | M |

**W5.** Per D-28; accept ADR-0060 with the delivered subset stated.

**W6.** The acceptance map (§6) run at the release gate; after the human-approved release and install,
upgrade the affected installation, restart, verify host, provider, memory, embedding and task paths and
the rendered dashboard, run `ak sync` twice, and compare upstream incorporation before considering any
old local patch.

**W7.** #271 items 1–3 test-first from the P11 sketch, plumbing `ttlHours` to `status/sections/ruvnet-brain.mjs:84`;
mark #240 done in `agentic-dependency-constraints.json`; close #240 under D-25.

**W8.** #262 per D-33; #254 per D-26; #256 as v2's V3 delivers, plus one real-machine plain-folder bind.

**W9.** Per D-29.

## 6. #239 acceptance map and closure rule

E1–E4 are in the [execution evidence plan](2026-09-29-plan-execution-evidence-and-upgrade-acceptance.md).

| #239 item | Owner | Closed by |
| --- | --- | --- |
| P0 validate before launch | [AK] | E3 |
| P0 identity, progress, outcome, persistence recorded separately | [AK] | E1, E2 |
| P0 early-warning monitor, alerts, exit codes | [AK] | E3 |
| P0 cancel requested vs stopped, fencing, capped retries | [MIX] | E1, E2; executor stop depends on AQE #707 |
| P0 detect success without results, leaks | [MIX] | E3 at ak's boundary; Ruflo gaps need D-32 |
| P0 preserve live owners and config | [AK] | Shipped; E4 proves on upgrades; AQE #782 release for cleanup |
| P0 memory route proof | [MIX] | Shipped (`ak x verify memory`); Ruflo #3196 for one contract |
| P1 shared predicates, sync scope, host states, causes | [AK] | Shipped; E4 proves convergence |
| P1 stopped services, executable ownership | [AK] | E4 |
| P1 host vs provider identity | [AK] | W5 (declared and observed, never attested) |
| P2 observability | [AK] | Shipped; Cowork source W9 |
| Upgrade gate: owner, commit, first version | [AK] | Shipped (registry) |
| Upgrade gate: clean and upgraded matrix, outcome matrix | [AK] | E2, E4 |
| Upgrade gate: upgrade, restart, verify, sync twice | [MAINT] | W6 |
| Redacted alerts, opt-in telemetry | [AK] | E3, verified in W6 |

**Closure rule.** A row is closed when it has a merged change and a test or receipt, or when ak mitigates
at its own boundary and a named upstream issue records the remaining limitation. Post the closing comment
with this map and the limitations, and close #239 only after you accept each limitation. Rows tagged
[UP] can delay closure; say so rather than claim completion.

## 7. Disposition of the existing plans (W0)

Six files are in `docs/plans/` on `develop` (five on `main`, plus the develop execution plan), and this
plan and the execution evidence plan make eight. Each is archived only when satisfied entirely (D-31 A): its Status is updated to
the final state, then `node scripts/docs-relocate.mjs --map <file.tsv>` renames and moves it into the flat
`docs/archive/`, rewriting every link, and one row per file is added to `docs/archive/README.md`
(`| [name](name) | \`original path\` | what it was | why it's historical |`). The layout guard
(`tests/kit/docs-layout.test.mjs`) fails on a missing row, a non-flat path, or a bad name.

| Plan | Archive name (proposed) | Satisfied when | State now |
| --- | --- | --- | --- |
| `2026-09-28-ci-windows-test-speed.md` | `2026-09-28-plan-ci-windows-test-speed.md` | Task 4: ten consecutive runs, table posted, #262 closed | Tasks 1–3 merged (#267); streak is 7 (P12). 3 unchecked boxes |
| `2026-09-28-ci-windows-test-speed-design.md` | `2026-09-28-design-ci-windows-test-speed.md` | Same as the plan above | Implemented; proof open |
| `2026-09-26-remediation-program.md` | `2026-09-26-plan-remediation-program.md` | Every row reconciled in v2's Appendix A (v2 DoD 2) | Superseded by v2; 14 unchecked boxes to reconcile |
| `2026-09-26-issues-237-238-239-verification-and-decisions.md` | `2026-09-26-audit-issues-237-238-239-verification-and-decisions.md` | v2's V7 appends its summary entry | Active log; last entry pending |
| `2026-09-28-remediation-program-v2.md` | `2026-09-28-plan-remediation-program-v2.md` | v2 DoD §6 items 1–8 | Open; V4 final gates, V6, V7 and the operational gates remain |
| `2026-09-28-remediation-v2-develop-execution.md` (on `develop`) | `2026-09-28-plan-remediation-v2-develop-execution.md` | All 18 unchecked boxes done or dispositioned | 18 unchecked |
| execution evidence plan | `2026-09-29-plan-execution-evidence-and-upgrade-acceptance.md` | Its §5 gate met | Blocked |
| this plan | `2026-09-29-plan-issue-239-closure-and-v5-foundation.md` | §5 done and §6 closure accepted | Blocked; depends on the row above |

**Sequence.** CI plan and design first (as soon as #262 closes); then the v1 plan after its 14 boxes are
each reconciled to a v2 row or a named issue; then the decision log and the v2 plans together, after v2
DoD §6 is met; the execution evidence plan when its gate is met; this plan last. Do not run W0 while the Codex session is editing files these plans cite:
`docs-relocate` rewrites links across the tree and would collide with v2's V7 edits.

**Per-file procedure.** Edit the Status to `Done, archived <date>` naming the PR and evidence, and move
any still-open item to a named issue (never leave it only in prose); write the map file; run
`node scripts/docs-relocate.mjs --map <map> --dry-run` and review the rewrites; run it for real; add the
index row; run `pnpm run lint:md`, `node --test tests/kit/docs-layout.test.mjs` and the link check.

## 8. Sentry tests still pending (need your go-ahead or a write)

The tests for P2, P4 and adapter output events moved to the execution evidence plan §4.

| Test | Why it is not yet run |
| --- | --- |
| Reproduce the four Ruflo defects in a disposable directory (D-32) | Needs writes to a throwaway `.claude-flow` |
| Windows live-lock conformance job (D-27) | Consumes CI minutes |
| Read one Cowork session file's key names (D-29) | Deliberately not read; needs your approval |
| Whether Brain 4.3.35 changed the forge-update path (#271) | Not verified from the compare view |

## 9. Authority, risks

- Approval covers isolated implementation, unit commits and PRs. It does not cover releases, global
  installation, real-store operations, upstream submissions, paid runs, or deleting worktrees or
  branches; each keeps its own gate, and upstream text is approved exactly as sent.
- The three risks that matter most: P2 (no external view of AQE tasks), Cowork format drift, and
  alerts on agent workloads with no prior art for thresholds (D-21).
- Sources here are secondary in places (Akka for the φ detector; summarized fetches). The AWS retry
  article and the original φ paper could not be read.

## 10. Sources

All fetched 2026-09-29 through the fetch tool. Quotes are as returned; verify before external use.

- [S8] Fowler, Circuit Breaker, 2014-03-06. `martinfowler.com/bliki/CircuitBreaker.html`. "Asked to call in
  the half-open state results in a trial call."
- [S9] Stripe, Idempotent requests. `docs.stripe.com/api/idempotent_requests`. "saving the resulting status
  code and body of the first request made for any given idempotency key."
- [S10] IETF draft-ietf-httpapi-idempotency-key-header-07 (2025-10-15). A draft, not a standard.
- [S11] WHATWG HTML, Server-sent events. `html.spec.whatwg.org/multipage/server-sent-events.html`. "Authors
  can include a comment line … every 15 seconds or so."; "Legacy proxy servers are known to … drop HTTP
  connections after a short timeout."
- [S12] MDN, EventSource (2025-03-13). "Fired when a connection to an event source failed to open."
- [S13] nginx, ngx_http_proxy_module. "X-Accel-Buffering" response header enables or disables buffering.
- [S14] Fowler, "Patterns for Managing Source Code Branches", 2020-05-28. "How often we do integration has a
  remarkably powerful effect on how a team operates."
- [S15] trunkbaseddevelopment.com. "resist any pressure to create other long-lived development branches."
- [S16] DORA, Trunk-based development. `dora.dev/capabilities/trunk-based-development/`. "Have three or
  fewer active branches in the application's code repository."
- [S29] Anthropic, "Use Claude Cowork on Team and Enterprise plans".
  `support.claude.com/en/articles/13455879`. "For local sessions, Cowork stores conversation history on
  users' computers."
- [S30] anthropics/claude-code#29373 (2026-02-27). "The update changed the session storage directory from
  `local-agent-mode-sessions` to `claude-code-sessions`."
- [S31] Claude Code, Monitoring. `code.claude.com/docs/en/monitoring-usage`. `api_request` carries `model` and
  `request_id`.
- [S32] OpenAI Codex, advanced configuration. OTel export tracks runs; `model_provider` is user-configurable.
- [S33] OpenTelemetry GenAI semantic conventions. `gen_ai.provider.name`: "The Generative AI provider as
  identified by the client or server instrumentation." Stability: Development.
- [S34] GitHub Docs, hosted runners reference. `windows-latest` is Windows Server 2025, 4 vCPU, 16 GB.
- [S35] Nygard, "Documenting Architecture Decisions", 2011-11-15. "If a decision is reversed, we will keep
  the old one around, but mark it as superseded."
- [S36] Schwaber and Sutherland, The 2020 Scrum Guide. "Work cannot be considered part of an Increment unless
  it meets the Definition of Done."

Sources for D-21 to D-23 are in the execution evidence plan §6. Not fetched, therefore not cited: the AWS
Builders' Library retry article, the Kubernetes CrashLoopBackOff page, and the Codex rollout schema
documentation.
