# Upstream watch followups

## Status at archival

Implemented and independently reviewed on `fix/upstream-watch-followups` at
`b75c1e3fec4f645700f0f6d18220956867b7e5d0`. All eight local gates passed at that
source: unit/legacy tests, browser UI, typecheck, lint, complexity, Markdown,
build, and offline links. Controller workflow commits `aebe2ae6` and `b75c1e3f`
complete items 11/12; their shell and jq behavior was independently exercised.
Green `develop@84307574` was subsequently merged at `ff1eff27` without conflicts.
Final-head PR CI and merge remain pending at capture; no real dispatch or
notification was performed for this lane.

M7 distinguishes deterministic validation failures from transient retries.
M8 bounds eligible fired-PR polling to seven days after the latest firing,
retaining the ledger; a later PR requires manual reconciliation. All twelve
minors have a fix, regression proof of existing behavior, or explicit no-change
disposition. M10 remains declined. Current behavior is documented in
[Upstream watch](../upstream-watch.md).

## Execution and acceptance

Scope: M7, M8, and the twelve numbered deferred minors in the recovered PR #253 report. M10 is declined because the numeric PR field matches emitted records. This lane owns watcher scripts, focused tests, one Codex registry entry, and current watcher documentation. The integration owner owns workflow edits.

1. Add focused failing tests for deterministic retry failures, bounded dispatch polling, ledger errors, and the numbered edge cases. Keep synthetic fetch, dispatch, and git boundaries.
2. Implement the smallest watcher changes that make those tests pass. Check already-correct behavior and record no-change findings without empty commits.
3. Commit independently verifiable items separately. Run focused Node tests and static checks without a full suite, dispatch call, or GitHub write.
4. Put item 11/12 workflow hunks, commands, per-item dispositions, and residual limits in the ignored C4 report. Stop for independent review.

Acceptance: deterministic errors do not sleep; transient errors retry at most twice; fired PR polling stops after seven days or when registry state is ineligible; invalid ledger registry exits nonzero; notices retain their body and maximum length semantics; all twelve minors are either fixed, proved already handled, or handed off as exact workflow hunks.
