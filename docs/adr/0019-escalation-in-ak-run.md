# ADR-0019 — Bounded per-worker escalation in `ak run`

- **Status:** Accepted
- **Date:** 2026-07-29
- **Deciders:** agentic-kit maintainers

## Context

The #76 closure punch list requires that ordered, bounded cross-host escalation reach
the canonical `ak run` path — or be explicitly retired with an approved migration
decision. The legacy behavior lives only in the deprecated `ak dual` wrapper (ADR-0004):
on a non-zero pipeline exit and an explicit `--escalate` flag, the *entire* pipeline
re-runs once with `escalatePolicy(policy)` — every activity bumped to its ladder's first
non-self rung. That shape has three faults the canonical runner should not inherit:

1. **Whole-pipeline retry for a single worker's failure.** A failing `coder` re-ran the
   successful `architect` too — spend and wall-clock doubled for no benefit.
2. **No attempt evidence.** The escalated run presented as a fresh run; the first
   attempt's failure left no trace in the result contract.
3. **No consent boundary.** A permission-refused or uncertain worker would be retried
   like any other failure.

## Decision

Escalation moves into the runner as **bounded per-worker ladder attempts**, opt-in per
invocation via `ak run --escalate`:

1. **The ladder travels with the worker.** `materializeRunPlan` attaches the resolved
   route's `escalate` array to each worker. Self-equal rungs are dropped at
   materialization (re-running the identical host+model changes nothing — the legacy L4
   rule), and every rung must be a routable host or materialization fails exactly the
   way an unroutable primary route does.
2. **Ordered and bounded.** A worker whose result is escalatable advances **one rung at
   a time**, in ladder order, and stops when a rung succeeds or the ladder exhausts.
   There is no unbounded retry: the ladder's length is the bound, and per-worker
   `--timeout` applies per attempt.
3. **Escalatable means *cleanly failed*.** `failed` and `timed_out` may advance.
   Never advanced: `blocked`/`cancelled` (dependency state, not a worker failure),
   `permission_required` (a consent boundary — escalating around it would violate the
   supervised-host contract that the OpenCode permission-abort implements), and
   `orphaned` (execution state uncertain; a retry risks a double run).
4. **The trail is evidence, not noise.** The final result carries `attempts[]` — each
   attempt's host, model, status, exitCategory, durationMs, and (on failure) bounded
   reason — but ONLY when more than one attempt ran. A single attempt is
   indistinguishable from escalation being off, and emitting a trail there would
   fabricate an event that did not happen. The final result's host/model are the rung
   that actually executed (observed truth), a succeeded-after-escalation unblocks
   dependents normally, and `attempts` is schema-validated like every other result
   field.
5. **Explicit opt-in, same as legacy.** Escalation doubles attempted work by design;
   it stays behind `--escalate` rather than becoming the default posture.

This satisfies the punch list's "ordered, bounded cross-host escalation into the
canonical path, tested with an OpenCode-qualified route": an
`implementation:opencode` route with a claude ladder rung escalates through the real
OpenCode adapter (`permission_required` from its consent boundary excluded by rule 3).

The legacy `escalatePolicy` + `dual --escalate` stay untouched inside the deprecated
wrapper until #83 removes the wrapper; nothing here changes their behavior.

## Consequences

- A failing worker no longer re-runs successful siblings — escalation cost is scoped to
  the failure.
- `ak run --json` results now carry `attempts[]` on escalated workers; consumers see
  where a worker started and where it landed, and the consent/uncertainty exclusions
  are visible in what is *absent*.
- The rung must have an execution adapter to advance: a ladder naming a host with no
  adapter records `cli_unavailable` for that rung and continues to the next.
- The deprecated wrapper's whole-pipeline semantics and the canonical per-worker
  semantics differ *deliberately*; the migration note in UPGRADING.md names that as an
  intended improvement, not a drift.

## Alternatives considered

- **Port dual's whole-pipeline retry.** Rejected for the three faults above: it wastes
  successful work, hides the first attempt, and ignores consent boundaries.
- **Always-on escalation.** Rejected: doubling attempted spend must remain a
  per-invocation choice, exactly as it was in the legacy wrapper.
- **Retire escalation entirely** (the punch list's alternative). Rejected: the ladder
  data already exists in the routing policy and the per-worker shape is strictly
  better than retiring a capability users have.

## References

- `src/lib/execution/runner.mjs` (`executeWorkerWithEscalation`, escalatable rules),
  `src/lib/execution/schema.mjs` (`attempts` validation),
  `src/lib/routing.mjs` (`materializeRunPlan` ladder attach),
  `src/commands/run.mjs` (`--escalate`).
- ADR-0004 (legacy escalation semantics), ADR-0018 (canonical execution contract),
  #76 punch list item 1, #83 (deprecated-wrapper removal that consumes this migration).
- Tests: `tests/kit/execution-runner.test.mjs` (engine, boundaries, trail, schema),
  `tests/kit/run-command.test.mjs` (materialization, CLI flow), plus the live
  OpenCode-qualified smoke recorded on #76.
