# Main watcher reconciliation

## Scope and acceptance

Combine develop PR observation and blind reporting with main #280 dispatch pacing.
Preserve pending eligibility, the strict seven day observation window, two recorded
firings per thread, three day cooldown, three fixes per run, and 15 second spacing.
Then restrict trigger retries to documented HTTP 500/503, sanitize token-bearing
error metadata, preserve deferred work in bounded previews and blind results, and
align the living guide and workflow summaries. Use focused synthetic regression
tests before behavior changes and scoped static checks.

## Ownership and policy receipt

The controller assigned sole writing ownership of watcher source, workflow, tests,
and guide in `fix/main-watch-reconciliation`, and authorized the prepared two-parent
merge commit followed by three conventional unit commits. Shared manifests,
lockfiles, V6 fixtures, develop/main integration, archive index changes, publication,
and final full gates remain controller-owned. This plan is ready for the controller
to archive with its index update in the completing pull request.

## Limits

No real trigger, provider turn, external mutation, full suite, UI tests, pnpm,
installed CLI changes, user data writes, or delegated workers. Inject fetch,
execution, and sleeps. Retry evidence does not establish exactly-once execution or
absence of server-side sessions. Deferred work remains eligible for later checks;
repeated earlier failures can starve it.

## Units

1. Reconcile and commit both parent contracts; establish focused baseline.
2. Test and fix bounded retry and sanitized error diagnostics.
3. Test and fix preview cap, deferred blind result, and later-run discoverability.
4. Clarify guide, workflow preview/record summaries, and evidence limits.

Record command evidence and limitations in the ignored worker implementation report.
