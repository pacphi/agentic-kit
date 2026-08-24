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

## Decision 1 — Codex tool-event fidelity

### Option A — Keep the current prompt/response contract (recommended)

Continue to ignore Codex tool-event bodies for the historical Transcript view,
while counting only normalized prompts and responses. Add a documented
diagnostic count of unknown/ignored item types so schema drift is visible without
pretending that command activity is equivalent to a tool invocation.

Trade-off: the Codex transcript remains less detailed than Claude's, but the
scorecard stays semantically stable and the change is small, auditable, and
forward-tolerant.

### Option B — Add aggregate Codex activity counts

Expose separate counters such as `commands`, `fileChanges`, `mcpCalls`, and
`extensions` on Codex session and aggregate records.

Trade-off: useful for workload analysis, but each counter needs a stable mapping,
deduplication rules, and an explicit statement that it is activity—not cost,
tool-call parity, or a count of human actions.

### Option C — Add detailed Codex tool turns

Render command, file-change, extension, and collaboration items in the
Transcript view with a normalized turn schema.

Trade-off: highest fidelity, highest privacy and payload risk. It requires
content redaction, truncation, ordering, nested-agent semantics, UI treatment,
and a larger compatibility surface.

### Clarifying question

Do maintainers want Codex tool activity for operational insight, or is the
priority only accurate prompt/response/session accounting? Unless detailed
activity is a product requirement, choose Option A.

## Decision 2 — Schema-drift diagnostics

### Option A — Keep diagnostics inside `sourceHealth` (recommended)

Expose bounded counters for files scanned, records parsed, response-bearing
records, token-bearing records, and unknown envelope/item types. Preserve the
existing source-health status vocabulary and make the dashboard explain the
warning in plain language.

### Option B — Add a separate parser-diagnostics endpoint

Keep `/api/usage` compact and expose detailed parser observations through a
diagnostic route or command.

Trade-off: cleaner normal payloads, but failures become harder to discover and
the dashboard can again look healthy while the diagnostic surface contains the
important evidence.

### Option C — Persist a diagnostic report beside the cache

Write an aggregate-only report next to `usage-index.json`, with no transcript
content.

Trade-off: useful for support bundles and independent verification, but creates
another cache lifecycle and permission boundary.

### Recommendation

Use Option A for normal operation. Consider Option C later if maintainers need a
portable, content-free support artifact.

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

## P2 implementation, testing, and documentation gate

After the decisions above, a P2 implementation should be split into disjoint
units:

1. Define the normalized schema and provenance rules in an ADR amendment.
2. Add synthetic fixtures for each supported item family, mixed-format files,
   unknown future types, malformed lines, and nested/collaboration items.
3. Add aggregate invariants proving that activity counters do not change token,
   cost, prompt, response, or session totals.
4. Add dashboard contract tests and privacy tests for any newly surfaced text.
5. Update `docs/TRANSCRIPTS.md` and `docs/USAGE-SCORECARD-METRICS.md` with the
   chosen vocabulary and explicit exclusions.
6. Run the full repository check plus a content-free comparison against real
   rollouts before opening the implementation PR.

No P2 behavior should be implemented until the clarifying answers are recorded
in the follow-up ADR update.
