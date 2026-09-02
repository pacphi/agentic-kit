# ADR-0039 — Deterministic Prompts telemetry on main

- **Status:** Accepted
- **Date:** 2026-08-30
- **Updated:** 2026-09-02
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0038](0038-consistent-cross-host-session-metrics.md)
- **Full capability snapshot:** `archive/prompts-capability-main-2026-09-01` at
  `91e892f523f307ecb29271cb0e370b538115a2c0`

## Context

ADR-0009 established local transcript analytics. ADR-0038 made the session metrics
consistent across hosts. The Prompts work added a third view: what the operator
actually typed, separated from tool output, adapter templates, agent-to-agent
messages, and control records that can all appear as user-role turns.

The original ADR bundled two different capabilities:

1. deterministic, privacy-preserving telemetry derived from prompt fingerprints;
2. a coaching product built on top of those aggregates: recommendations, drafts,
   dismissal state, masked prompt samples, saved labels, and opt-in model inference.

Before subtracting the second capability from main, the complete implementation was
preserved on the archive branch named above. Git history shows that snapshot contains
the dashboard Coaching panel, its mutation and masked-sample endpoints, the outcome
ledger, the label store, and model enrichment. Main keeps only the first capability.

This amendment records that boundary. The archive is a preserved reference, not a
second supported runtime line.

## Decision

### 1. Main retains deterministic prompt evidence

The scan path may retain only the prompt fingerprint contract: a normalized-text hash,
token count, bounded token-hash sketch, provenance tag, and optional question/persona
shape flags. It does not persist prompt text.

The aggregate may derive:

- typed-prompt and provenance counts;
- per-host tap, question, persona, and length distributions;
- trailing-history personal baselines;
- exact repeats, near-duplicate recurring clusters, and re-asks;
- deterministic seed or shape-characterized cluster labels;
- the existing evidence-backed Prompts findings detectors.

The dashboard keeps the Prompts tab for those read-only metrics. The CLI keeps
`ak usage prompts`, its supported windows, `--json`, and the explicit `--deep`
terminal pass. The deep pass rereads local transcripts only on request, masks its
output, writes nothing, and does not place prompt text in the index or dashboard API.

### 2. Main excludes the coaching and layer-3 product

The following belong solely to the preserved archive snapshot and are not supported on
main:

- Coaching cards, recommendations, drafts, dismiss/undo state, and adoption tracking;
- the outcome ledger and the dashboard write endpoints that mutate it;
- saved or hand-curated cluster labels and model-enriched labels;
- model invocation, enrichment prompts, fabrication gates, and synthesized cards;
- the dashboard's Coaching table, filters, details, prompt-text posture control, and
  masked prompt-sample endpoint;
- coaching-only cluster projection fields such as derived `kind` and
  `sampleSessionIds`;
- CLI flags `--enrich`, `--draft`, and `--dismiss`.

Those options now fail as unknown rather than silently doing nothing. The dashboard
remains observation-only and has no Prompts mutation route.

### 3. Privacy boundaries are structural

The default index and `/api/usage` projection contain no prompt text. The dashboard
does not serve prompt samples, read a label store, or read/write a coaching ledger.
The only prompt-text path retained on main is the local, explicit `--deep` CLI pass.

Removing `sampleSessionIds` also prevents the recurring-cluster projection from
becoming a session-membership link surface. Aggregate rows retain counts, spans, host
names, hashes, and deterministic labels needed to explain the metrics.

### 4. The archive branch is immutable provenance

`archive/prompts-capability-main-2026-09-01` remains pinned at
`91e892f523f307ecb29271cb0e370b538115a2c0`. It is the exact full-capability
reference for the removed implementation and its tests. Main documentation links to
that snapshot instead of describing the archived behavior as current.

Future work must not merge or rebase that archive branch onto main. Reintroducing any
archived capability requires a new ADR and an explicit privacy, mutation, and
maintenance decision.

## Consequences

### Positive

- The mainline Prompts feature is deterministic, local, read-only, and explainable.
- No model is invoked and no prompt-derived label or coaching state is written.
- Dashboard behavior matches its observation-only product contract.
- The full historical implementation remains recoverable without carrying its runtime
  and maintenance surface on main.

### Costs

- Main no longer recommends a response to a repeated pattern or drafts configuration
  text.
- The dashboard cannot reveal even masked prompt samples; exact wording is available
  only through the explicit local deep pass.
- Archived designs and screenshots describe a capability that is intentionally absent
  from main and must be read as historical evidence.

## Validation contract

Tests pin the boundary at three levels:

- the served Prompts page contains deterministic panels and no Coaching/posture
  containers;
- the CLI JSON payload contains deterministic telemetry and no coaching/enrichment
  projections;
- retired CLI flags are rejected.

The existing parser, aggregate, clustering, detector, CLI, dashboard, privacy, and
cross-platform suites continue to validate the retained telemetry.

## References

- [Usage scorecard metrics](../USAGE-SCORECARD-METRICS.md) §2a, §2b, §20–§22
- [Dashboard guide](../DASHBOARD.md) — Prompts
- [Archived documents index](../archive/README.md)
- `src/lib/usage-parsers.mjs`, `src/lib/usage-provenance.mjs`
- `src/lib/usage-aggregate.mjs`, `src/lib/usage-insights.mjs`
- `src/lib/usage-prompt-patterns.mjs`, `src/lib/usage-prompt-vocabulary.mjs`
- `src/commands/usage.mjs`, `src/commands/usage/deep-pass.mjs`
- `src/lib/dashboard-server.mjs`, `src/lib/dashboard/client/usage.mjs`,
  `src/lib/dashboard/client/usage-prompts.mjs`, `src/lib/dashboard/page.mjs`
