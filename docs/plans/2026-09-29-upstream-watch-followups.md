# Upstream watch followups

Scope: M7, M8, and the twelve numbered deferred minors in the recovered PR #253 report. M10 is declined because the numeric PR field matches emitted records. This lane owns watcher scripts, focused tests, one Codex registry entry, and current watcher documentation. The integration owner owns workflow edits.

1. Add focused failing tests for deterministic retry failures, bounded dispatch polling, ledger errors, and the numbered edge cases. Keep synthetic fetch, dispatch, and git boundaries.
2. Implement the smallest watcher changes that make those tests pass. Check already-correct behavior and record no-change findings without empty commits.
3. Commit independently verifiable items separately. Run focused Node tests and static checks without a full suite, dispatch call, or GitHub write.
4. Put item 11/12 workflow hunks, commands, per-item dispositions, and residual limits in the ignored C4 report. Stop for independent review.

Acceptance: deterministic errors do not sleep; transient errors retry at most twice; fired PR polling stops after seven days or when registry state is ineligible; invalid ledger registry exits nonzero; notices retain their body and maximum length semantics; all twelve minors are either fixed, proved already handled, or handed off as exact workflow hunks.
