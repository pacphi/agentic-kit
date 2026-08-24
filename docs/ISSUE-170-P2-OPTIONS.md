# Issue #170 — P2 options and decisions

This document is the decision surface for the work deliberately left outside the
urgent P0/P1 compatibility repair. It is intentionally implementation-free: the
answers below determine whether a future change belongs in the usage-index
contract, the dashboard contract, or only in diagnostics.

Issue: [#170](https://github.com/pacphi/agentic-kit/issues/170)

## Current boundary

P0/P1 restore Codex prompt/response accounting across the legacy
`event_msg.payload.type` vocabulary and the newer `item_completed` envelope,
invalidate stale derived records, expose parser-yield health, and clarify
first-billed-day versus multi-day activity.

P2 must not silently expand the existing contract. In particular, the current
usage parser does not expose Codex tool events as `rec.tools`; treating every
`CommandExecution`, `FileChange`, or extension event as an existing tool metric
would create a new claim rather than preserve one.

### Cross-host telemetry principle

Consistency should mean one semantic contract with honest capability states, not
identical raw fields for every host. Claude and OpenCode already provide the
shared `rec.tools` contract: counts of observed tool invocations keyed by tool
name. Codex currently has no equivalent normalized tool count because its
rollout item families do not map one-to-one to that contract. A Codex-only
`commands`, `fileChanges`, or `mcpCalls` field would therefore be a host
extension, not consistent telemetry.

The recommended direction is to define a host-neutral telemetry taxonomy and a
capability matrix first. Each host maps only evidence it actually observes;
unsupported or unavailable categories remain explicitly unknown. Raw wire
vocabulary and host-specific counters may remain under a namespaced extension,
but must not be promoted into shared scorecard metrics without cross-host
semantics and parity tests.

## Decision 1 — Codex tool-event fidelity

### Option A — Preserve the shared contract and defer Codex-only fields (recommended)

Continue to ignore Codex tool-event bodies for the historical Transcript view,
while counting only normalized prompts and responses. Add a documented
diagnostic count of unknown/ignored item types so schema drift is visible without
pretending that command activity is equivalent to a tool invocation. Do not add
Codex-only activity counters until the same semantic categories and capability
states are defined for Claude and OpenCode.

Trade-off: the Codex transcript remains less detailed than Claude's, but the
scorecard stays semantically stable and the change is small, auditable, and
forward-tolerant. This is the best immediate recommendation for consistent
reporting.

### Option B — Add cross-host activity counts after taxonomy design

Define shared optional categories such as `toolCalls`, `commandExecutions`,
`fileChanges`, `mcpCalls`, and `collaboration`, then map Claude, Codex, and
OpenCode evidence into them. A host may report `unsupported` or `unknown`; zero
must mean the host observed the category and counted none. Codex's raw item
types can remain in a namespaced extension for diagnostics.

Trade-off: useful for workload analysis and consistent across hosts, but it
requires a stable taxonomy, per-host mapping, deduplication rules, and an
explicit statement that it is activity—not cost, tool-call parity, or a count
of human actions. This is the recommended eventual destination, not a Codex-
only patch.

### Option C — Add detailed Codex tool turns

Render command, file-change, extension, and collaboration items in the
Transcript view with a normalized turn schema.

Trade-off: highest fidelity, highest privacy and payload risk. It requires a
host-neutral event schema, content redaction, truncation, ordering, nested-agent
semantics, UI treatment, and a larger compatibility surface. The normalized
event schema must be shared even when a host cannot populate every event kind.

### Clarifying question

Do maintainers want cross-host activity for operational insight, or is the
priority only accurate prompt/response/session accounting? If activity is
required, should the first shared categories be tool invocations, command
execution, file changes, MCP calls, or collaboration? Unless maintainers want
to fund the cross-host taxonomy and mappings, choose Option A.

## Decision 2 — Schema-drift diagnostics

### Option A — Keep a common diagnostics envelope inside `sourceHealth` (recommended)

Expose bounded, host-neutral counters such as `unitsSeen`, `unitsParsed`,
`unitsWithUsage`, `unitsWithPrompts`, `unitsWithResponses`, `prompts`, and
`responses`, plus `warnings` and `unknownKinds`. Preserve the existing
source-health status vocabulary and make the dashboard explain the warning in
plain language. Codex-specific details (`files`, raw envelope counts, and item
type histograms) may remain under a namespaced extension until Claude and
OpenCode have equivalent evidence.

### Option B — Add a separate parser-diagnostics endpoint

Keep `/api/usage` compact and expose detailed parser observations through a
diagnostic route or command.

Trade-off: cleaner normal payloads, but failures become harder to discover and
the dashboard can again look healthy while the diagnostic surface contains the
important evidence. If selected, the same common envelope must be available to
all host readers, not only Codex.

### Option C — Persist a diagnostic report beside the cache

Write an aggregate-only report next to `usage-index.json`, with no transcript
content.

Trade-off: useful for support bundles and independent verification, but creates
another cache lifecycle and permission boundary.

### Recommendation

Use Option A for normal operation, with a shared envelope and host extensions
clearly separated. Consider Option C later if maintainers need a portable,
content-free support artifact.

## Decision 3 — Multi-day session semantics

The existing `byDay.sessions` meaning should remain “sessions whose first billed
tokens landed on this day” so the historical invariant remains intact.

### Option A — Add `sessionsActive` by token-bearing day (recommended)

Count a retained session once for every day represented by one of its usage
rows. Label the existing count “started” and the new count “active.”

Trade-off: precise for metered activity, but it does not claim that a session
was continuously open for the entire calendar day.

### Option B — Add wall-clock overlap counts

Count a session on every day intersected by its `[start,end]` span.

Trade-off: matches “session was open,” but can overstate meaningful work and
would need to be clearly separated from engaged time.

### Option C — Replace the existing count

Make `byDay.sessions` mean active sessions and remove first-day attribution.

Trade-off: simpler for a daily reader, but breaks the current totals invariant
and silently changes existing consumers. Reject unless the scorecard enters a
versioned API redesign.

### Recommendation

Choose Option A and retain the old field. If wall-clock visibility is desired,
add it later as a separately named metric rather than changing the meaning of an
existing field.

## Decision 4 — Telemetry consistency and capability states

Before implementing any new activity telemetry, record an ADR amendment with:

1. The host-neutral category names and their precise evidence semantics.
2. A Claude/Codex/OpenCode capability matrix with `supported`, `unsupported`,
   and `unavailable` distinguished from a measured zero.
3. The canonical `rec`/aggregate fields and the namespaced host extensions.
4. Deduplication rules for hosts whose transcript and database representations
   expose the same event through more than one path.

The P0/P1 Codex diagnostics are a compatibility bridge and should not be
treated as the final telemetry taxonomy. They make the current schema failure
observable; a later cross-host contract can wrap or rename those fields through
an explicit versioned migration.

## P2 implementation, testing, and documentation gate

After the decisions above, a P2 implementation should be split into disjoint
units:

1. Define the normalized schema and provenance rules in an ADR amendment.
2. Add a cross-host capability matrix and synthetic fixtures for equivalent
   Claude, Codex, and OpenCode activity, plus mixed-format files, unknown future
   types, malformed lines, and nested/collaboration items.
3. Add aggregate invariants proving that activity counters do not change token,
   cost, prompt, response, or session totals, and that unsupported is not
   serialized as measured zero.
4. Add dashboard contract tests and privacy tests for any newly surfaced text.
5. Update `docs/TRANSCRIPTS.md` and `docs/USAGE-SCORECARD-METRICS.md` with the
   chosen vocabulary and explicit exclusions.
6. Run the full repository check plus content-free comparisons against real
   Claude, Codex, and OpenCode samples before opening the implementation PR.

No P2 behavior should be implemented until the clarifying answers are recorded
in the follow-up ADR update.
