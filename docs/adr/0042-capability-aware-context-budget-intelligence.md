# ADR-0042 — Capability-aware context budget intelligence

- **Status:** Accepted; implementation in progress
- **Date:** 2026-09-02
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0008](0008-guidance-target-scope-split.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0017](0017-opencode-host.md),
  [ADR-0018](0018-generalized-host-worker-execution.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0029](0029-host-adapter-extension-point.md),
  [ADR-0032](0032-model-lifecycle-intelligence.md),
  [ADR-0038](0038-consistent-cross-host-session-metrics.md),
  [ADR-0041](0041-host-neutral-hook-configuration-assurance.md)
- **DDD:** [Context budget intelligence](../ddd/context-budget-intelligence.md)

## Context

A fresh Codex session on the reference machine reported 25,985 tokens in a 258,400-token effective
window before useful work had begun: 10.06%. The same startup emitted a host warning that every
skill description had been removed and another 80 skills could not be included. Agentic-kit-owned
Claude guidance alone measured about 29.6 KB before project instructions, hooks, skill metadata,
MCP schemas, memory injection, or conversation content.

The nominal capacity was easy to misstate. The active Codex cache described a 1.05M-class model,
an 872,000-token host maximum, a 272,000-token host allocation and a 95% effective allocation;
the session recorded 258,400 usable tokens. Claude selectors may expose a 1M variant, OpenCode
catalogues expose provider limits, and external adapters such as Hermes may expose no trusted
window fact. These are different claims. A published maximum cannot be used as the denominator of
an active session whose host supplied a smaller window.

The existing usage implementation also had an evidence gap. It retained Codex
`model_context_window` but discarded `last_token_usage`, making the Context chip unreachable on
real Codex records. Claude and OpenCode retained a numerator but no denominator. A dashboard ratio
over those asymmetric records would therefore have fabricated coverage.

Hook configuration adds a related but distinct startup/runtime cost. Static hook assurance can
identify declared Stop hooks and ownership, but it cannot prove execution outcomes. Historical
Agentic-QE health records do prove Stop-stage `npx ETIMEDOUT` failures, while its generated runner
falls back to `npx` in the hot hook path and writes millisecond-style values into Claude timeout
fields interpreted as seconds. Those canonical defects belong upstream; generated copies and
plugin caches remain non-repairable.

## Decision

### 1. Context Budget Intelligence is a bounded context

Context Budget Intelligence owns the vocabulary, policy and evidence resolution for context
capacity and pressure. Historical Usage remains the owner of transcript acquisition. Model
Lifecycle Intelligence remains the owner of catalogue and model-capacity facts. Hook Configuration
Assurance remains the owner of static hook declarations and remediation authority. Dashboard
Delivery joins their read models but does not acquire or reinterpret evidence.

The aggregate root is a `ContextEnvelope` for one host/model/session or route attempt. Its facts
retain value, native unit, source, scope, capture time, provenance and health. Byte counts are not
tokens. A conservative byte estimate is labelled `estimated-tokens` and never promoted to an
observed measurement.

### 2. The smallest fresh trusted guard is the effective ceiling

Evidence is considered in this order:

1. exact runtime observation;
2. exact active host configuration/cache;
3. first-party provider catalogue;
4. admitted adapter declaration;
5. explicitly configured conservative fallback;
6. unknown.

Among fresh facts applicable to the same route, the lowest trusted guard wins. A larger published
maximum remains displayable as capacity evidence but cannot override a smaller runtime-effective
window. Stale, incompatible, malformed and self-asserted external facts do not manufacture a
ceiling. No universal 128K or 1M fallback is assumed.

### 3. Policy is conservative and explicit

The default policy reserves 25% of the effective ceiling for output, reasoning, tools and safety
headroom. Static startup pressure targets at most 5%, warns above 7%, and is critical above 10%.
Dynamic pressure warns at 60%, requests compaction/rematerialization at 70%, and requests handoff or
stop at 75%. Exact boundary behavior is tested. These are agentic-kit operating thresholds, not
vendor limits.

If an unattended route has no proven ceiling, its budget decision is `unknown`; it is never shown
as 0% used. Cached-token billing discounts do not reduce context occupancy.

### 4. Session evidence is bounded and paired

Each parsed session records the first, last and peak gross input-token observation, a sample count,
and bounded pressure buckets. Codex uses `last_token_usage.input_tokens` directly and does not add
`cached_input_tokens` again. Claude and OpenCode gross input includes fresh input, cache read and
cache write. A pressure sample exists only when numerator and denominator are compatible evidence
for that session. Drops are retained as negative growth; they are not automatically labelled
compaction.

Persisted usage schema changes force a reparse. The legacy `ctxWindow` and `ctxLastTokens` fields
may remain temporarily for compatibility, but the normalized evidence is authoritative.

### 5. Context and Hooks are sibling Usage views

The dashboard adds **Usage → Context** and **Usage → Hooks**.

- Context reports first/last/peak input, effective-window evidence, pressure, policy bands,
  coverage and capped attention rows. It never serves prompt text, tool payloads, commands or raw
  paths.
- Hooks reports static configuration assurance separately from typed runtime outcomes. A configured
  Stop risk is not a failed Stop run; an absent outcome stream is `not-recorded`, never zero
  failures. Raw commands, stdout/stderr, hook context and secrets never reach the browser.

Context rides the already-lazy Usage payload. Hook assurance uses a separate lazy, TTL-cached,
single-flight, read-only endpoint and does not execute hooks or scan all projects implicitly.

### 6. Reduce owned startup projections; notify foreign owners

Agentic-kit-owned guidance is selected by enabled host/configuration, not merely by executable
presence. Always-on blocks contain operative invariants and on-demand pointers rather than tool
catalogues and tutorials. Deterministic byte and conservative token-estimate budgets guard Claude,
Codex, OpenCode and external/Hermes fallback projections.

Agentic-kit never edits versioned plugin caches, generated Ruflo/Agentic-QE/Brain files, or native
host skill enumeration. Evidence-bound upstream reports name the owner, affected versions,
reproduction, bounded workaround and removal proof. Existing upstream issues are updated rather
than duplicated.

### 7. External adapters degrade honestly

Contract-v1 external adapters, including Hermes fixtures, have no trusted custom context
descriptor or durable hook-outcome stream. Their context and Stop outcome state is therefore
`unsupported` or `not-recorded` until a consent/hash-bound contract extension is accepted. An
adapter cannot self-upgrade trust through its execution output.

## Consequences

- The dashboard can explain why a 1M-capable model is operating with a 258.4K session ceiling.
- Startup regressions become measurable per target and host without confusing bytes and tokens.
- Missing host evidence remains visible as coverage debt rather than a reassuring zero.
- Stop failures can be diagnosed and assigned without turning generated artifacts into repair
  authority.
- Usage cache schema upgrades require a one-time local reparse.
- Exact prompt materialization preflight remains a later execution integration until every route
  can supply a compatible envelope; the pure policy and evidence contracts land first.

## Acceptance criteria

- Real Codex token-count fixtures produce both input and window evidence without cached-input
  double counting.
- The 258,400 runtime-effective fact beats 872,000 and 1,050,000 maximum facts.
- Threshold, unknown, stale, over-window and negative-growth cases are tested.
- Context and Hooks payloads are bounded, private, accessible and explicit about source health.
- Stop diagnostics link to exact source ownership; generated/cache sources are never automatic.
- Managed guidance fits tested per-host budgets and preserves authority/safety invariants.
- Claude, Codex, OpenCode and external/Hermes unknown-state fixtures pass focused conformance tests.

