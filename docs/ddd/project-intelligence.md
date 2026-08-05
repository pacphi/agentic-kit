# Project Intelligence Domain

This document describes the domain implemented by [ADR-0024](../adr/0024-project-intelligence-telemetry.md),
`src/lib/dashboard/intel-history.mjs`, and `src/lib/live/intelligence-watch.mjs`.

## Purpose

Project intelligence surfaces trend data about ruflo/agentic-qe's own project-level learning
subsystem — the neural pattern store, its lifetime learned-pattern counter, the reasoning graph's
structural growth, and a machine-health sample ring — inside the dashboard's Overview →
**Intelligence** view (`#overview/intelligence`). It is a read-only projection over files those
tools already write under `.claude-flow/`. It owns no session, actor, or activity identity; it
grades no per-field evidence confidence; and it cannot steer, retrain, or mutate the learning
subsystem it reads.

The shared terms in [Ubiquitous language](ubiquitous-language.md) are normative.

## Why this is a separate context, not Observability

[Observability](observability.md) exists to grade evidence about concurrent, cross-host **session**
execution: an `ObservedSession` aggregate keyed by `(host, sessionId)`, a canonical event envelope
with per-field confidence (`observed`/`correlated`/`inferred`/`assumed`/`planned`), a lifecycle
state machine, and a protected transcript-content plane. None of that applies here:

- Every value in this domain is a scalar count, a timestamp, or a flat historical array read from
  this project's own `.claude-flow/` state — the same local trust boundary `ak status` already
  reads directly. There is no other host's evidence to normalize through an anti-corruption
  adapter, because there is only ever one shape: ak's own.
- There is no session, actor, host, provider, or model identity anywhere in this domain's data, and
  therefore no capability-coverage matrix, no actor lens, and no court membership.
- There is no lifecycle (`queued → running → completed`); sources are either a live inventory
  (the pattern store), a monotonic lifetime counter, an append-only sample history (the graph), or
  a capped, deduplicated ring (machine health).
- The panel is a permanent secondary view under **Overview**, never a mode of **Observability**'s
  mutually exclusive Live/History scope (see [ADR-0005](../adr/0005-dashboard-in-page-routing-reveal.md)).

The implementation reuses only source-agnostic transport plumbing that Dashboard delivery already
shares across contexts — `JsonlTailer`, `sseChannel`, `reserveClientSlot`/`clientGone`, and
`transcriptSseFrame` — never Observability's canonical normalizer, `ObservedSession` aggregate, or
replay/snapshot cursor. `GET /api/live/intelligence` shares the `/api/live/*` path prefix with
Observability's endpoints by transport convention only; it is not covered by
[OBSERVABILITY.md](../OBSERVABILITY.md)'s evidence, privacy, or capability-coverage contract, and it
needs no `--live-source` registration because its four sources are always this project's own.

## Model

```text
.claude-flow/neural/patterns.json             -> PatternStoreEntry[]   { createdAt, type }
.claude-flow/neural/stats.json                -> GlobalLearningStats   { patternsLearned, trajectoriesRecorded,
                                                                          signalsProcessed, lastAdaptation }
.claude-flow/data/intelligence-snapshot.json  -> GraphSample[]         { timestamp, nodes, edges, pageRankSum }
.claude-flow/health-history.json              -> HealthSample[]        (capped ring, deduped, appended here)
.claude-flow/data/pending-insights.jsonl      -> change signal only (line contents never read)
.claude-flow/improvement.json                 -> ImprovementEval       (pre-existing; unchanged by this domain)

readIntelHistory(cwd) -> { patternStore, graph, healthRing, globalStats }
        |
        +--> collectData() (Dashboard delivery) --> GET /api/status         (poll, ~30s)
        |
        +--> IntelligenceWatch --> broadcastIntel --> GET /api/live/intelligence  (SSE push, debounced)
                |
                v
        Overview -> Intelligence (#overview/intelligence): five sparklines + improvement verdict badge
```

### Pattern-store size vs. patterns-learned counter

These are the domain's two central, easily-confused facts and must never be conflated:

- **Pattern-store size** (`patternStore.length`, bucketed by day from `createdAt`) counts entries
  currently present in `.claude-flow/neural/patterns.json` — the store's live inventory right now.
- **Patterns-learned counter** (`globalStats.patternsLearned`) is a cumulative total persisted in
  `.claude-flow/neural/stats.json` — patterns learned over the store's whole lifetime, including
  ones since pruned, compacted, or replaced.

The store can be pruned while the counter keeps climbing; that divergence is expected, not a bug.
This repository's own `.claude-flow/` state demonstrates it directly: 28 pattern-store entries
against a 1,337 lifetime counter. No reader, computation, or rendered label treats one as a
substitute display for the other.

### Reasoning graph size

`graph` is a point-in-time series of the reasoning/knowledge graph's structural size
(`nodes`, `edges`, `pageRankSum`) sampled into `.claude-flow/data/intelligence-snapshot.json` by
existing ruflo/agentic-qe tooling. It is a structural-growth series, independent of both pattern
metrics above and of the machine-health ring below.

### Machine-health ring

`healthRing` is the existing capped (500-entry), field-level-deduplicated sample ring in
`.claude-flow/health-history.json`. Its reader and writer (`readHealthRing` /
`appendHealthSnapshot`) moved into this domain from `dashboard-server.mjs` with unchanged behavior;
this document is now their domain home. A repeated snapshot whose fields are identical to the last
stored sample except `ts` is a no-op — polling unchanged stats does not grow the ring.

### Improvement delta

`improvement.json` (the route-learner's held-out-accuracy evaluation: curve, cold/warm accuracy,
`deltaPP`, significance) predates this domain and is unchanged by it. It continues to be read
verbatim by `collectData()` and rendered as the existing Δpp sparkline and verdict badge.

## Live delivery

`IntelligenceWatch` polls the three source files' `mtime` on an interval (default 1,000 ms),
corroborated by a change-only tail of `pending-insights.jsonl` via the existing `JsonlTailer` —
line *contents* are never read; a record arriving at all is the signal. Detected changes accumulate
against a trailing-edge debounce (default 2,500 ms, measured from the most recently detected
change) so a burst of writes during an active session collapses into one flush. A flush re-reads
`readGlobalStats(cwd)`; if it differs from the watcher's own last-seen value, it appends a health
snapshot (independent of, and in addition to, `intel-history.mjs`'s own on-disk dedup) and then
calls `readIntelHistory(cwd)` and forwards the combined result to every connected
`GET /api/live/intelligence` client.

The route follows Dashboard delivery's existing SSE discipline exactly: reservation-before-await
client-cap tracking (default cap 32, clamped to 256), the forwarding-cleanup idiom for a close that
races connection setup, and `sseChannel`'s bounded per-client queue (default 256 frames, clamped to
4,096) with heartbeat. `/api/status` remains a fully sufficient fallback for a client that has not
opened, or does not support, the stream — both paths return the identical `readIntelHistory(cwd)`
shape.

## Invariants

1. Pattern-store size and the patterns-learned counter are computed, labeled, and rendered
   independently; neither substitutes for the other.
2. Every reader degrades to an honest empty/`null` result on a missing, unreadable, or
   wrong-shaped source file rather than throwing or fabricating a value; individual malformed
   entries are skipped rather than corrupting a bucket.
3. `readGlobalStats` and `status.mjs`'s CLI `learning` row read the same file through the same
   helper and default logic, so the two cannot silently drift apart.
4. The health-history ring is capped and deduplicated; unchanged repeated snapshots do not grow it.
5. `pending-insights.jsonl` line contents are never read or trusted as data — only "a record
   arrived" is a signal.
6. This domain introduces no session, actor, host, provider, model, or lifecycle identity, and no
   per-field evidence-confidence grading.
7. `GET /api/live/intelligence` requires no `--live-source` registration; its sources are always
   this project's own `.claude-flow/` state.
8. `/api/status` and `GET /api/live/intelligence` return the same `readIntelHistory(cwd)` shape, so
   client rendering has one code path regardless of delivery route.

## References

- [ADR-0024](../adr/0024-project-intelligence-telemetry.md)
- [Observability](observability.md) — the bounded context this domain is deliberately distinct from
- [Context map](context-map.md)
- [Dashboard guide](../DASHBOARD.md)
