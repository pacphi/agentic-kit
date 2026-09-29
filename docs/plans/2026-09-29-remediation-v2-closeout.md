# Remediation v2 closeout execution

## Status and authority

Active under the confirmed [develop execution plan](2026-09-28-remediation-v2-develop-execution.md).
Base: `develop@88ce597f`, incorporating reviewed V1–V6 and the main watcher reconciliation.
All 13 develop CI checks passed. Source scope remains the 189 Appendix A and 57 Appendix B
entries in [the program](2026-09-28-remediation-program-v2.md). New release, installation,
real-store merge, deletion, personal-memory writes and future #239 work remain outside this
implementation authority. The final develop → main PR stays open for human review.

## Units and ownership

1. **Comment-label guard:** a sole writer in this closeout worktree implements a parser-based
   guard and removes transient planning labels from comments/test titles without changing
   behavior. Scope: tracked JavaScript in src, scripts, bin and tests; no allowlist. Preserve
   durable audit IDs and literal strings/regex/templates. Use RED/GREEN boundary fixtures.
2. **Scope and evidence documentation:** a separate task worktree prepares dated public
   receipts for every original scope ID, source-bound Windows and AQE evidence, and all
   recorded rulings. It preserves failed observations, limits and explicit deferrals. It
   submits exact shared-index/program-status handoffs and private issue drafts to the controller.
   No source/test edits or publication. This unit can run alongside the guard because their
   paths are disjoint; final citation checks follow their integration.
3. **Controller integration:** review each unit, combine their accepted commits, apply shared
   index/status handoffs, relocate the V3 paused-time report without losing its historical body,
   and reconcile current issue conditions. Keep the parent program/execution plans active while
   human approval and operational gates remain. Preserve all worktrees and branches.
4. **Final gates and delivery:** full guarded unit/legacy and browser suites, types, lint,
   complexity, Markdown, build, offline links and independent branch review. Open the closeout
   PR into develop, squash only after required CI/review, verify tree equality and develop CI,
   then open the final main PR for the human. Recheck main before that final PR.

## Evidence and limits

The fixed Windows ten-before/ten-after cohort is historical, with all outcomes retained.
A separate three-consecutive-PR Windows timing rule remains pending: the current latest three
include a 358-second leg. Refresh that gate after closeout PR CI; do not manufacture green runs.
AQE #655/#753 proofs are narrow released-artifact observations; #778 settings churn still occurred
in the release tested before its source fix. No issue closure or installed-state inference follows
from upstream closed status alone. Exact current evidence and unresolved gates belong in the final
receipt and PR. No real routine trigger or paid provider run is required for this closeout.
