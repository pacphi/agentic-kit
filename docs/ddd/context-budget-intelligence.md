# Context budget intelligence

Context Budget Intelligence answers one question: **how much compatible context capacity is proven,
what is occupying it, and what action does policy recommend?** It does not own transcript parsing,
model catalogues, hook configuration, routing mutation or dashboard transport.

## Model

The aggregate root is `ContextEnvelope`, identified by host, model/route, session or attempt, and an
evidence epoch. It contains:

- `ContextWindowFact` — advertised maximum, host maximum/nominal, runtime effective window,
  auto-compact threshold or output maximum, each with provenance and health;
- `ContextContribution` — instructions, managed guidance, skill catalogue, MCP schemas, hook
  injection, memory, conversation, tool results, handoff and output reserve in their native unit;
- `EffectiveContextCeiling` — the smallest applicable fresh trusted guard;
- `ContextBudgetPolicy` — startup, dynamic and reserve thresholds;
- `BudgetDecision` — pressure, band, recommended action and evidence state.

Byte measurements remain bytes. `estimateTokensFromBytes` creates a labelled conservative estimate;
it does not create observed token evidence.

## Invariants

1. Runtime-effective evidence cannot be replaced by a larger catalogue maximum.
2. Every ratio pairs token-compatible numerator and denominator evidence.
3. Unknown, stale, unsupported and unavailable are distinct from measured zero.
4. Cached billing discounts do not reduce context occupancy.
5. External adapter output cannot promote its own trust or capacity authority.
6. Lists, histograms and attention rows are capped; no prompt text, output, tool payload, raw hook
   command or secret enters the read model.
7. A route escalation is a new envelope. Context must be rematerialized for the new host/model
   before launch rather than copied from the failed rung.

## Evidence flow

```text
Model Lifecycle facts ─┐
Historical Usage ──────┼─> Context evidence resolver ─> Budget decision ─> Dashboard read model
Owned startup audit ───┘

Hook Configuration Assurance ─> separate Hooks read model ────────────────> Dashboard
```

Historical Usage supplies bounded first/last/peak session evidence. Model Lifecycle Intelligence
supplies capacity candidates without claiming active-session pressure. The owned startup audit
supplies bytes and labelled estimates for managed instructions. Hook assurance is deliberately a
sibling: a slow or failed Stop hook affects reliability and may inject context, but its execution
outcome is not a context-window fact.

The implemented projection is intentionally smaller than the conceptual aggregate:

- `context-budget.mjs` owns the canonical thresholds and conservative ceiling resolver;
- usage cache schema v17 introduced bounded, paired per-session context evidence; current schema
  v18 reparses the same evidence while adding controlled Prompt telemetry facets;
- `usage-context.mjs` owns the privacy-preserving Historical Usage projection;
- `blocks.mjs` owns exact managed-guidance byte accounting and conservative estimates;
- the supervised adapter runner owns typed runtime hook receipts;
- `hook-read-model.mjs` joins static hook assurance and typed receipts without exposing their raw
  content.

The Context projection is present in the Usage aggregate. Its capped attention rows carry a
deterministic opaque session reference, an opaque normalized project key, and sanitized local
project/conversation labels, then render one client-side outer disclosure per project without
changing the top-20 cap. A canonical upstream project key wins; fallback identity applies NFKC,
whitespace normalization and case folding before hashing. Conversation identity remains in each
expanded session row. The reference opens the existing authenticated local
transcript reader. Policy recommendations name the threshold-derived next step; they do not claim a
handoff or compaction event occurred. Dashboard Delivery renders the projection directly
and exposes the sanitized Hook read model through a lazy, authenticated, 30-second cached,
single-flight endpoint. That route does not create native runtime evidence: durable native-host
outcome acquisition remains outside the implemented boundary.

## Policy vocabulary

| Term | Meaning |
|------|---------|
| Advertised maximum | A provider/catalogue capacity claim; not automatically the active denominator |
| Host nominal window | The host-selected allocation for a model/profile |
| Runtime-effective window | The session/turn window the host actually reports; preferred active denominator |
| Startup share | First token-bearing input divided by compatible effective window |
| Reserve breach | Current input has consumed more than the non-reserved 75% of the ceiling |
| Context evidence coverage | Counted eligible/measured/missing sessions, never an inferred success rate |
| Context pressure | Gross input tokens divided by compatible effective window, stored in basis points |
| Rematerialization | Rebuilding the prompt/envelope for a new host/model or after compaction |
| Managed guidance footprint | Exact UTF-8 bytes in agentic-kit-owned selected sentinel blocks for one target |
| Conservative token estimate | `ceil(bytes / 3)` planning estimate; never a tokenizer observation |
| Hook runtime receipt | Bounded supervised-execution evidence with host, verb, outcome, duration, timeout, byte counts and truncation |

## Ownership boundaries

- Historical Usage owns transcript source health and parsing.
- Model Lifecycle Intelligence owns catalogue/cache facts and their provenance.
- Hook Configuration Assurance owns declared hooks, ownership and remediation authority.
- Integration Management owns admitted external adapter contracts and consent hashes.
- Routing and Orchestration may consume a budget decision but owns the launch decision.
- Dashboard Delivery sanitizes and renders read models; it never executes a hook or mutates a route.

Static hook diagnostics remain Hook Configuration Assurance facts. Runtime receipts originate at
the supervised adapter execution boundary. Joining them for display does not let either evidence
class prove the other.

For contract-v1 external/Hermes adapters, context capability and durable Stop outcomes are unknown
unless another trusted source establishes them. Extending that contract changes the hash-bound
consent surface and follows ADR-0029/ADR-0031 rather than being accepted from arbitrary worker JSON.
