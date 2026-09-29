# Remediation v2 ordered execution rulings

Capture: 2026-09-29. Documentation basis:
`b5a0a946ae0aca2e1d435c78b12a98bc587d1266`.
This record transcribes the controller's current execution log into readable
language, retaining source order, decisions, reasons and stated costs. It includes
17 `Ruling:` entries and the separately worded ADR coordination ruling, for 18
entries total. The earlier 13-entry rollup was incomplete. These execution rulings
operate within the [confirmed execution plan](../plans/2026-09-28-remediation-v2-develop-execution.md).
They do not create further release, data-operation or provider authority.

## Maintainer-approved decisions

The confirmed execution plan authorizes feature PRs into develop and conditional
squash integration after required CI and independent review. Final main approval
remains human-owned. D-3 through D-19 retain the plan's qualified dispositions;
D-5 moves execution identity, terminal outcomes, cancellation semantics and the
upgraded-install matrix to later v5 work. D-18 depends on unchanged totals and
D-19 labels structured live input experimental. D-9 preserves both v5 branches
and reserved ADR numbers. Personal Codex memory writes need a direct request.

The maintainer also approved bounded unknown raw-origin metadata for local detail
under ADR-0060, and exact sanitized AQE init and Ruflo upstream messages recorded
by the controller. Those specific approvals do not authorize new posts. No future
Issue #239 W1–W8 or D-20+ work is approved by this record. The controller rulings below
are implementation and coordination choices within those boundaries.

## Controller rulings in source order

1. **Split the V4 B1 prerequisite PR.** V4 B1 overlapped V6 OpenCode and footprint
   readers, so integrate it into develop before the remaining branches consume it.
   Freeze the original V4 branch until merge, then continue from updated develop.
   Remaining V4 scope is retained. Stated cost: one extra coordination PR.

2. **Stage the A3 ADR amendment for the controller.** Implement and test the retry
   stamp first. Apply its exact ADR-0063 amendment after V3 dashboard ADR work and
   include the aligned ADR in the same V4 feature PR. Correct the old statement:
   `record: false` still performs lookup without writing; `cacheOnly` skips both.
   Reason: serialized ADR ownership and accurate behavior. Cost was not stated.

3. **Run V6 Unit 20 before the remaining V4 merge.** Its quota/status-line classifier
   paths do not overlap V4; B1 is integrated and C6 flags are verified. Raw-origin
   policy still blocks dependent parser work. Stated cost if wrong: later quota
   overlap needs serialized reconciliation; schema, UI and provider boundaries stay.

4. **Integrate V6 Unit 2's agreed interface while raw-origin policy is pending.**
   Both policy choices use the same factory return shape. Pass the factory result
   through without inserting a policy filter or assuming approval; use synthetic
   disposable caches. Final policy, ADR and delivery remain gated. Stated cost:
   reshaping or schema staging may need revision before merge; no real cache or
   privacy policy is deployed by this intermediate decision.

5. **Add `declared-session-ids` without a schema bump.** Preserve the honest label
   on legacy `transcript-files` snapshots. V3 exclusively owns the maintenance API,
   so stage the API enum/test change for V6 consumer integration. Reason: avoid
   concurrent contract edits. Stated cost: a pending public API handoff.

6. **Pass explicit false for unchecked project trees.** Machine refresh must honor
   the current selection across tabs. Correct the old plan's undefined/sticky
   setting. Stated cost: a prior true selection is no longer inherited, intentionally.

7. **Retire the precise C1 busy exception on the approved native criterion.**
   The macOS/Linux AQE 3.14.4 live-owner criterion was independently satisfied.
   Remove only `FsyncFailed`-as-busy; ordinary `LockHeld` remains. Do not invent a
   global AQE floor from the older comment: only store merge has that feature floor.
   Stated compatibility cost: the older 3.14.3 error sequence fails closed. At this
   decision Windows Ruflo routing remained a separate failed gate; the later
   qualified Windows proof is in the [AQE/native receipt](2026-09-29-aqe-released-artifact-receipt.md).

8. **Exclude incomplete or corrupt mixed-file ownership as a whole.** Surface the
   coverage as incomplete, following the fix brief and ADR, to avoid false imported
   spend. Clean observed mixed files retain proved response/origin attribution.
   Stated cost: undercounting a proved prefix in damaged files; prefix salvage is
   not claimed. Investigate actual zero-response/token shapes separately.

9. **Add `sessionSurfaces` while preserving legacy semantics.** Retain
   `sessionOrigins`, `countBasis` and uncertain legacy precise mode. Assign narrow
   ownership for management query/focus navigation, intelligence history and
   footprint/projects DTOs. Reason: avoid a schema bump and false legacy origin
   inference. Stated cost: additive compatibility complexity, reviewed at integration.

10. **Exclude ignored scratch evidence from local whole-repository ESLint.**
    Preserve immutable measurement scripts when default lint discovery includes
    generated ignored probes. All tracked targets and clean-checkout CI lint remain.
    Stated cost: local scratch is not linted and is not shipped. This cannot hide
    tracked defects.

11. **Run independent V6 Unit 15 before Unit 12 completes.** Give its isolated branch
    exclusive usage-cost/OpenCode paths; Unit 12 excludes them. Integrate only after
    both reviews and a clean handoff, through the final V6 feature PR. Stated cost
    if wrong: delayed narrow integration handoff; concurrent writers remain forbidden.

12. **Accept one charge owner in a fixed Claude identity pool.** The pool spans twice
    the display days, capped at 730; eligibility requires both modification time and
    end time. Outside-pool duplicates cannot steal or augment a charge. Uncovered
    current data is excluded with coverage counts. Comparison-toggle invariance and
    unique-charge conservation were checked. The earlier per-cohort Claude policy
    was explicitly rejected and superseded. Stated cost: up to one preceding
    display-width of extra cold reads or cached-claim validation. This is neither
    a measured runtime benchmark nor a whole-corpus uniqueness guarantee.

13. **Keep the conventional OpenCode path for storage census.** Actual usage and
    project readers use `selectOpencodeSource`; the conventional default still
    supplies the directory used by footprint/storage inventory. Returning null on
    history ambiguity would break unrelated census callers. Stated cost: that
    conventional location is not selected-history authority. Verify actual history
    readers use the selector; no storage inventory redesign follows.

14. **Build Unit 17's pure storage detector independently.** Reserve only its two
    new paths in a separate worktree, using a caller-owned database or explicit
    legacy root. It cannot select sources or change the index. Full acceptance waits
    for Unit 16 and consumers. Reason: independent work without shared writers.
    Stated cost: an explicit interface handoff.

15. **Start main watcher reconciliation alongside V6 Windows fixes.** The paths are
    disjoint; integrate updated develop only after V6 merges and develop is green.
    Preserve both input sets, documented HTTP retry scope, token redaction, deferred
    preview and blind-backlog handling. Reason: avoid serial idle time. Stated cost
    if wrong: later integration rework, never concurrent writer paths.

16. **Limit trigger retries to documented HTTP 500/503.** Do not retry body transport
    errors or after an observed session URL. The routine API offers no idempotency
    guarantee, and bounded retry is not proof of no side effects. Stated cost if
    wrong: other transient 5xx responses wait for a later check. No real trigger
    was performed. The [watcher integration receipt](2026-09-29-remediation-v2-integration-evidence.md)
    binds the implemented source and CI.

17. **Record already-reviewed main ancestry after feature squash.** Permit a
    content-identical merge only when the reviewed feature contains the exact main
    input and the squash tree equals the reviewed tree. Reason: preserve ancestry
    without repeating the final main conflict. Stated cost if wrong: hiding an
    unincorporated main change. The controller checked ancestor, tree, parents and
    current-main preconditions; latest develop CI remained the dependency gate.

18. **Include shared test-helper comments in the whole-tree guard sweep.** The
    approved no-allowlist sweep permits comment-only label rewrites in helpers,
    resolving the narrower worker brief. No competing writer owns those paths.
    Runtime statements, exports and behavior must remain unchanged. Stated cost
    if wrong: an accidental helper behavior change; source-token comparison and
    focused checks must retain the code contract.

## Limits carried into closeout

The [integration receipt](2026-09-29-remediation-v2-integration-evidence.md) records
Node 22's upstream runner limitation and the test-local diagnostic mitigation.
Source fixes, released-artifact observations and installed behavior remain distinct.
The [Windows receipt](2026-09-29-windows-ci-evidence.md) retains a failing timing
gate snapshot; the [AQE receipt](2026-09-29-aqe-released-artifact-receipt.md) retains
untested platforms, unsigned fresh-chain limits and setup churn in 3.14.5.
No paid runs were performed. The memory loop remains OFF until main approval.
Attended time was not instrumented. Program and execution plans stay active while
final main review and operational gates remain.
