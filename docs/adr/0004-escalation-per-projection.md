# ADR-0004 — Escalation is per-projection, availability stated per path

- **Status:** Accepted
- **Date:** 2026-07-23
- **Deciders:** agentic-kit maintainers

## Context

The routing policy supports an optional per-activity **escalation ladder** (`escalate: [{host,model}, …]`) —
"if the primary rung fails repeatedly, try the next." rUv already ships the mechanism in
`agentic-qe/src/routing/escalation/auto-escalation-tracker.ts` (escalate after N consecutive failures,
de-escalate after M successes; configurable `tierOrder`) and the 3-tier `QEModelRoutingAdapter`.

But the three projections (ADR-0001) do **not** all support escalation equally: the raw
`DualModeOrchestrator` fails a worker on a non-zero exit and does **not** retry up a ladder. Presenting
escalation as universally available would be dishonest.

## Decision

Escalation lives in the policy but its **availability is stated per projection path**:

- **aqe projection** — honored **natively** by the shipped `auto-escalation-tracker` / `QEModelRoutingAdapter`.
- **`ak dual run` wrapper** — ak implements **retry-with-next-rung** on a worker's non-zero exit (wrapper
  logic ak owns, added in Slice 3).
- **raw `claude-flow-codex dual run`** — **no escalation** (materialize-only users). Stated plainly in docs
  and `--help`, never implied.

Escalation ladders **prefer cross-vendor rungs** (e.g. `codex → claude·opus`): failing over to a *different*
vendor both improves the odds of recovery and preserves the qe-court vendor-diversity property
(reuse `qeCourt.vendorOf` to keep ladders diverse).

## Consequences

- Honest capability boundaries — no hidden magic; each surface's behavior is documented.
- Cross-vendor ladders double as diversity insurance.
- The `ak dual run` wrapper carries retry/escalation state; the raw path stays a thin pass-through.
- Escalation config validated the same way as primary routes (constructible provider, enabled host).

## References

- `agentic-qe/src/routing/escalation/auto-escalation-tracker.ts`;
  `ruflo/v3/plugins/agentic-qe/src/bridges/QEModelRoutingAdapter.ts`
- `@claude-flow/codex/dist/dual-mode/orchestrator.js` (non-zero exit = failure, no retry)
- `src/lib/qeCourt.mjs` `vendorOf`; ADR-0001
