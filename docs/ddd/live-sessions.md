# Live Sessions Domain Design

This document specifies the domain model behind
[ADR-0012](../adr/0012-live-sessions-observability.md). It follows SPARC's specification,
architecture, refinement, and completion stages; implementation pseudocode appears at the relevant
boundaries.

The shared [ubiquitous language](ubiquitous-language.md) and
[context map](context-map.md) are normative. Terms defined below refine the Live Sessions context
without redefining shared integration concepts.

## Ubiquitous language

| Term | Meaning |
|------|---------|
| Session | One host thread or orchestrated run whose live state is observed |
| Project | Sanitized repository identity grouping sessions across hosts and time |
| Session key | Host-qualified identity (`host:sessionId`) preventing cross-host collisions |
| Root session | Top-level host thread or orchestrated run used as one navigation unit |
| Child session | Independently addressable agent/worker thread with an observed parent |
| Orphan session | Thread whose declared parent is not currently retained; temporarily navigable |
| Navigation root | Session presented in the project session list; normally a root or orphan |
| Entity | A session, agent, tool, skill, plugin, MCP server, gate, or other observed capability |
| Actor | An entity that initiates or owns an activity |
| Activity | A bounded operation performed by an actor |
| Display identity | Evidence-graded human label and role; never the source ID alone |
| Current work | The latest open, allowlisted operation summary for an entity |
| Evidence | A source record supporting a domain fact |
| Field provenance | Evidence and confidence attached to one fact, not the whole record |
| Confidence | `observed`, `correlated`, `inferred`, `assumed`, or `planned` |
| Read-model projection | The current query/UI state derived from canonical events |
| Topology | Nodes and typed relationships visible for a session |
| Execution canvas | Spatial view of agents, owned tools, and causal flow for one session |
| Evidence rail | Selected-session transcript synchronized with canvas selection |
| Follow Live | Playhead follows the newest retained event and advances on append |
| Review | Deterministic reconstruction of one session at a selected evidence time |
| Playhead | Current playback offset within retained session evidence |
| Cursor | Monotonic ingest position used for delivery and replay |
| Adapter health | Freshness and failure state of one evidence source |
| Quiescent | No recent activity, but no authoritative completion was observed |
| Terminal | Completed, failed, cancelled, or expired according to lifecycle rules |

“Live” describes the freshness of local observation, not distributed consensus. A planned workflow
step is not an active agent. A correlated edge is not an observed spawn.

## Bounded contexts

### Evidence acquisition

Owns source discovery, append-aware reading, schema-specific parsing, and source checkpoints. Its
language is transcripts, ledgers, registries, hooks, offsets, rotation, and freshness. It does not
decide graph layout or emit browser DTOs.

Source adapters are anti-corruption layers for:

- Claude session and delegated-agent artifacts;
- Codex rollouts and state-ledger spawn edges;
- ruflo swarm, agent, hook, and daemon state;
- agentic-qe tasks, workers, evaluations, gates, and court verdicts;
- explicit skill, plugin, MCP, and tool lifecycle records.

### Live session domain

Owns canonical events, identity correlation, lifecycle transitions, evidence confidence, aggregates,
and invariants. Host-specific record shapes do not cross this boundary.

### Read-model projection and replay

Owns materialized session graphs, bounded retention, cursor replay, snapshots, and idempotent
reduction. It is optimized for current state, not historical cost analytics.

### Dashboard delivery

Owns HTTP/SSE representation, connection lifecycle, filters, stable SVG presentation, the
synchronized evidence rail, and textual equivalents. It cannot manufacture domain facts.

### Historical usage

The existing usage index remains a separate context. It owns transcript detail, token/cost
aggregation, and historical classification. Its session identifier can link contexts, but its
aggregate is not the live event store.

## Context relationships

```text
Claude ─┐
Codex ──┤
ruflo ──┤  source adapters / anti-corruption layer
AQE ────┤
ak ─────┘
          ↓
canonical event normalizer
          ↓
LiveSession aggregate → read-model projection/replay → snapshot + SSE → dashboard
          │
          └── session-id link ──→ historical usage context
```

Evidence acquisition is upstream of the live domain. Read-model projection/replay consumes
canonical domain events. Dashboard delivery consumes projection DTOs. Historical usage shares
identifiers only.

Discovery is newest-first. Before following append-only changes, acquisition reads a bounded
metadata prefix and Codex ledger state so stable identity is available on first paint. Bootstrap
records establish discovery and identity; they do not fabricate current liveness for an old
session.

## Aggregates and entities

### `LiveSession` aggregate root

Identity is `(host, sessionId)`, with an optional cross-host `runId`. It owns:

- lifecycle status and last-observed time;
- actor identities and typed relationships;
- active and terminal activities;
- evidence references and confidence;
- adapter freshness relevant to this session;
- safe aggregate usage/duration counters when explicitly reported.

The public `sessionKey` is host-qualified. The raw native ID remains available for provider lookup,
but UI state, project membership, selection, and playback use `sessionKey`.

Only the aggregate may:

- attach or replace evidence for a node or edge;
- transition lifecycle state;
- choose the displayed confidence from competing evidence;
- expire quiescent activities;
- emit topology-changing domain events.

### `Project` catalog entry

`Project` is the primary navigation projection, not a new source of truth:

```text
Project {
  id, label, updatedAt,
  sessionKeys[],
  sessionCount, childSessionCount, liveCount, completedCount,
  hosts, providers
}
```

It is reduced from sanitized session project labels. `sessionKeys` and `sessionCount` contain
navigation roots only; `childSessionCount` reports descendant threads without presenting them as
peer work. Sessions are ordered live first and then by most recent evidence. A project ID is opaque
and safe for DOM/routing; it never contains the raw working directory.

`hosts` counts execution hosts independently. `providers` counts evidence-backed inference
providers and uses an explicit `unknown` bucket when no provider evidence exists; it never
substitutes the session host.

Project identity means the owning repository, not the current branch or linked-worktree directory.
For a live local worktree, the `.git` ownership pointer resolves the repository. Known nested
worktree layouts provide a privacy-safe fallback for retained paths that no longer exist. Only the
sanitized repository label crosses the event boundary; raw working directories and Git metadata
paths do not.

### Session hierarchy projection

The full snapshot retains every session aggregate because child threads can own distinct tools,
transcripts, and playback evidence. Serialization derives:

```text
SessionHierarchy {
  parentSessionKey, rootSessionKey,
  hierarchyState: root | child | orphan | cycle,
  navigationRoot
}
```

Parent and root keys are host-qualified. A later event with authoritative `parentSessionId`
backfills an aggregate discovered earlier; metadata-only reconciliation does not replace its last
meaningful activity time with the ledger scan time. A declared parent that is not retained leaves
the thread as an `orphan` navigation root so evidence stays reachable. Parent cycles resolve to one
deterministic navigation root and never recurse indefinitely. Selecting a root exposes descendant
threads as a nested Miller-style tier; selecting a child changes the map/transcript context without
promoting that child into the project root count.

### `Entity` and `Actor`

An entity has a stable source-scoped ID, kind, display name, role, host/surface, provider/model
where known, and lifecycle. Display names are labels, never identity keys. `Actor` is the role an
entity takes when it owns or initiates an activity; tools, skills, plugins, MCP servers, and gates
remain first-class entities even when they are invocation targets.

Actor kinds are open to additive extension, with an initial vocabulary:

`session`, `agent`, `subagent`, `tool`, `skill`, `plugin`, `mcp`, and `gate`.

Identity resolution prefers, in order:

1. a source-provided role or capability name;
2. an allowlisted tool, skill, plugin, MCP, or gate name;
3. a stable host-provided display label;
4. a kind plus shortened opaque identity, visibly marked generic or inferred.

The reducer never assigns a specialist role from timing, graph position, or a generic `subagent`
kind. Current work comes from a supported operation/activity field and carries its own evidence
confidence.

### `Relationship`

A relationship joins two actor/session identities and has a type:

- `contains`;
- `spawned`;
- `delegated-to`;
- `invoked`;
- `evaluated-by`;
- `gated-by`;
- `reported-by`;
- `planned-before`.

It carries evidence and confidence independently of its endpoints. The same endpoints can have
multiple relationship types.

Project, provider, model, role, lifecycle, and hierarchy each retain their own provenance. A host
may suggest a provider, but that assumption cannot be displayed as an observed provider fact.

### `Activity`

An activity represents a bounded invocation or evaluation. It has source-scoped identity, actor,
action, target, timestamps, status, optional safe counters, and evidence. Repeated updates mutate
the aggregate state through idempotent events; they do not create duplicate visible activities.

### `Source` value object

Contains adapter name, opaque or hashed artifact reference, source event identity, observation time,
and confidence. It cannot contain prompt text, response text, tool arguments, raw paths, or secrets.

### `AdapterHealth` aggregate

Kept separate because a source can fail without invalidating every live session. It owns adapter
state (`starting`, `healthy`, `stale`, `degraded`, `failed`, `stopped`), last success, safe error
category, checkpoint age, and retry state.

## Canonical domain event

```js
{
  schemaVersion: 1,
  eventId: "ak:1842",
  ingestSeq: 1842,
  observedAt: "2026-07-27T18:42:01.125Z",
  sourceTimestamp: "2026-07-27T18:42:00.991Z",
  sessionId: "source-session-id",
  parentSessionId: null,
  runId: null,
  traceId: null,
  spanId: null,
  parentSpanId: null,
  host: "codex",
  surface: "ruflo",
  project: "agentic-kit",
  actor: {
    id: "source-scoped-id",
    kind: "subagent",
    label: "test runner",
    role: "tester",
    provider: "openai",
    model: "gpt-5.6-sol"
  },
  action: "agent.spawned",
  target: { id: "child-id", kind: "subagent" },
  status: "running",
  source: {
    adapter: "codex-state",
    artifact: "opaque-ref",
    confidence: "observed"
  },
  attributes: {
    durationMs: null,
    tokenUsage: null,
    toolCategory: null
  }
}
```

The envelope is inspired by OpenTelemetry's GenAI conventions but versioned by ak
([GenAI conventions][otel-genai]). `sourceTimestamp` may be null. `ingestSeq` is delivery order,
not a Lamport clock and not proof of causality.

Initial actions include:

- `session.started`, `session.updated`, `session.quiescent`, `session.completed`;
- `actor.discovered`, `agent.spawned`, `agent.delegated`, `agent.completed`;
- `activity.started`, `activity.updated`, `activity.completed`, `activity.failed`;
- `quality.evaluation.started`, `quality.verdict.recorded`;
- `topology.planned`;
- `adapter.health.changed`;
- `projection.reset`.

Actions are bounded strings rather than a closed enumeration. Actor kinds, host, surface, status,
confidence, and field lengths are closed or bounded at normalization.

## Lifecycle rules

```text
queued → running → completed
             ├──→ failed
             └──→ cancelled

projection lifecycle: active → quiescent → expired
```

- Authoritative terminal evidence wins over later inferred liveness.
- `completed`, `failed`, and `cancelled` are terminal unless a source explicitly establishes a new
  activity identity.
- Silence can produce `quiescent` and later `expired`, never an inferred `completed`.
- Child-before-parent creates a placeholder parent that is hydrated later.
- A planned actor never becomes running without observed, correlated, or explicitly inferred
  evidence.
- Conflicting source status remains inspectable. The projection chooses a display state by evidence
  strength, then observation time, without deleting the conflict.

## Domain invariants

1. Every event has a supported schema version, stable event ID, and source adapter.
2. Event application is idempotent by event ID.
3. Source ordering is preserved; cross-source causality is never inferred from wall-clock time.
4. Every visible node and edge derives from an event carrying `source`.
5. Confidence cannot be upgraded without stronger evidence.
6. Planned topology is visibly distinct and cannot count as active work.
7. Raw prompt, response, tool arguments, file contents, secrets, and unrestricted paths never cross
   the graph-plane normalizer.
8. Unknown source fields are dropped rather than forwarded.
9. Terminal activities do not return to running under the same identity.
10. Adapter failure does not stop unrelated adapters or erase their projections.
11. Replay and snapshot followed by deltas converge on the same projection.
12. Resource retention is bounded by count, age, and client-idle policy.
13. Transcript access remains a separate, selected-session, explicit content-plane request.
14. A display role or current-work summary cannot be stronger than its supporting evidence.
15. Viewport position, selection, expansion, and node pins are client presentation state, never
    domain evidence.
16. Working directories are reduced to sanitized project labels before entering the canonical
    boundary; raw paths never enter projection DTOs.
17. Bootstrap discovery cannot mark an old session running without fresh lifecycle evidence.
18. Transcript bodies are available only through the protected content plane or historical
    context; they never enter graph snapshots, deltas, or replay.
19. Content streams are keyed by host and session ID, server-masked, bounded, ephemeral, and
    destroyed after the last subscriber.

## Ports and source adapters

### Inbound ports

```js
JsonlTailer.reconcile()
JsonlTailer.close()

createLiveEvent(candidate)
reduceLiveEvent(projection, event, bounds)
```

Each source adapter owns checkpoint serialization and validates file containment before opening an
artifact. Filesystem watch notifications trigger reconciliation; they are not treated as complete
event delivery.

### Outbound ports

```js
LiveSessionsService.snapshot()
LiveSessionsService.replay(cursor)
LiveSessionsService.subscribe(listener)
LiveSessionsService.close()
```

Implementations remain in-memory for current state with bounded replay. Durable restart recovery
comes from source checkpoints and reconciliation, not from treating the browser stream as storage.

### Delivery adapters

```text
GET /api/live
  → validate local request
  → return projection snapshot + cursor + adapter health

GET /api/live/events
  → validate local request
  → resume after Last-Event-ID when retained
  → otherwise emit reset
  → send named deltas + heartbeat comments
  → release subscription on disconnect

GET /api/live/transcripts/:host/:id/events
  → validate local request, host, id, realpath containment, and regular file
  → capture bounded masked history for only the selected session
  → tail complete records through the content DTO
  → resume from the content-plane cursor or emit a bounded gap/reset
  → release its tailer and replay buffer after disconnect

GET /api/live/playback/:host/:id
  → validate the same selected-session boundary
  → reconstruct bounded ordered topology and content evidence
  → return start/end/duration, event markers, transcript items, gap/truncation, and cursor
```

SSE supplies standard event IDs and reconnection for this one-way flow
([WHATWG Server-Sent Events][sse]).

## Reduction pseudocode

```text
on source candidate:
  parse with source schema
  construct allowlisted canonical event
  reject unsupported version/action/status
  assign ingest sequence and stable delivery id
  apply idempotently to LiveSession or AdapterHealth
  append accepted event to bounded replay log
  publish projection delta

on topology event:
  resolve source-scoped endpoint identities
  create placeholders for missing endpoints
  attach source confidence to the node and edge
  select display confidence without deleting conflicts
  emit node/edge add or update delta

on reconnect(cursor):
  if cursor retained:
    replay events strictly after cursor
  else:
    instruct client to reset and fetch snapshot

on dashboard close:
  close every SSE response
  stop collector timer and tailers
```

## Presentation model

The UI receives only projection DTOs:

- `sessions`: identity, sanitized project label, host/provider/model, status, freshness, safe
  counters, and field provenance;
- `nodes`: identity, session, kind, label, role, host/model, status, last action, confidence, and
  safe metadata;
- `edges`: source, target, relationship type, human verb, confidence, and status;
- `health`: sanitized adapter status and aggregate counters;
- `cursor` and `schemaVersion`.

The renderer separates domain projection from presentation state. A world transform `{x, y, k}`
controls the viewport, while a position cache and optional pin offset are keyed by entity identity.
Status-only updates cannot trigger global layout or reset the world transform. Agents are stable
anchors; bounded current/recent tool operations occupy deterministic satellite positions around
their owner. Animated particles distinguish dispatch, invocation, return, and message flow.

The presentation grammar treats an agent as an iconic hex/ring anchor, not a workflow card.
Observed current work is a nearby transient bubble, and tool activity is a small tethered
satellite that recedes after completion. The canvas owns the docked timeline and fills the usable
viewport beside the persistent evidence rail. Project/session navigation and source diagnostics
remain compact overlays so telemetry chrome cannot displace the work itself.

Direct manipulation follows a slippy-map interaction contract:

- drag empty space to pan;
- wheel or trackpad scrolling zooms about the pointer within bounded scale;
- drag a node beyond a click threshold to move and pin it;
- visible controls zoom, fit, reset the camera, and reset the layout;
- fit changes only the viewport; reset layout discards manual layout offsets;
- stream updates preserve viewport, selection, and manually positioned nodes.

The execution canvas and transcript rail share one selection model. Selecting an agent focuses its
subtree and transcript; selecting a tool shows its safe summary; selecting evidence highlights and
centers its owner. The initial overview shows project, host, evidence-backed provider identity,
lifecycle, current work, and critical failures; metadata and evidence are details on demand
([Shneiderman][eyes-have-it]).

The right rail is persistent and subscribes only to the selected `{host, sessionId}`. It carries
the rich masked conversation, plaintext reasoning, tool inputs/results/errors, patches, MCP/web
activity, and subagent messages available from that host. It supports search, type/actor filtering,
collapsed large details, auto-follow, and unread state. It renders transcript text as text, never
markup, and labels masking as best effort.

Project selection precedes session selection. Session selection chooses Follow Live for active
work and Review for retained work. Both modes use the same event reducer and canvas/transcript
renderers. Review owns `{playhead, playing, speed}`; appends extend duration without moving a
reviewer's playhead. Seeking resets presentation state and reapplies ordered evidence through the
selected offset. Resume Live applies the retained tail and restores automatic following.

The graph has a textual inventory of recent events, nodes, and relationships with action and
confidence. Pause freezes visual application while the client queues at most 256 deltas; overflow
triggers snapshot reload. This implements a control for pausing auto-updating information
([WCAG 2.2][wcag]). SVG nodes are keyboard-selectable buttons with accessible names and distinct
actor-kind geometry ([Graphics ARIA][graphics-aria]).

## Failure modes

| Failure | Required behavior |
|---------|-------------------|
| Partial JSONL record | Retain bytes; parse only after newline terminator |
| Rotation or truncation | Detect size/inode change; reset offset and reconcile |
| Duplicate source event | Stable identity plus idempotent reduction |
| Child arrives first | Create placeholder; hydrate without moving unrelated nodes |
| Completion missing | Mark quiescent/expired, never completed |
| Clock skew | Preserve both times and ingest sequence |
| Adapter schema drift | Degrade that adapter; report safe category; continue others |
| Replay cursor evicted | Emit reset; client fetches snapshot |
| Slow/paused browser | Bound queue; coalesce status; reset on overflow |
| Event storm | Batch projection/client updates; collapse resource nodes |
| Secret in unknown field | Field never enters allowlisted event |
| Watch notification lost | Periodic stat/reconciliation discovers change |
| All clients leave | Release SSE listeners; stop collectors after bounded idle delay |
| Transcript path escape or replacement | Realpath containment and identity recheck |
| Transcript client falls behind | Bounded queue; emit gap/reset rather than an unbounded snapshot |
| Encrypted reasoning | Drop at parser/DTO boundary because plaintext is unavailable |

## TDD strategy

Tests are written against ports and fixtures before each adapter or lifecycle transition:

1. **Contract tests:** event schema, action vocabulary, privacy allowlist, confidence ordering.
2. **Tailer tests:** append, partial record, duplicate notification, rotation, truncation, checkpoint
   restart, and symlink/containment rejection.
3. **Source-adapter fixtures:** known Claude, Codex, ruflo, agentic-qe, skill, plugin,
   and MCP records; unknown fields and schema generations.
4. **Aggregate tests:** child-before-parent, conflict, terminal-state monotonicity, expiry, and
   idempotency.
5. **Projection tests:** snapshot-plus-replay equivalence, bounded retention, late parent
   reconciliation, root/child counts, orphan reachability, and cycle termination.
6. **HTTP/SSE tests:** request protections, heartbeat, named events, reconnect, reset, disconnect
   cleanup, and multi-client fan-out.
7. **Privacy tests:** canary secrets and encrypted reasoning must be absent from every serialized
   plane; transcript bodies and tool details must be absent from graph output and masked in the
   selected content stream.
8. **UI tests:** stable coordinates, pointer-centred zoom, pan, drag-versus-click, pin persistence,
   camera/layout reset, stream-stable viewport and selection, coordinated graph/transcript,
   pause/resume, search, auto-follow/unread,
   reduced motion, keyboard navigation, textual equivalence, filters, and dark/light themes.
9. **Load tests:** synthetic concurrent sessions and high-cardinality tools establish aggregation
   and frame-time budgets.

Existing dashboard tests remain regression gates. New modules are tested directly instead of only
through the generated HTML monolith.

## Phased implementation

### Evidence Archive bounded context

Durable playback is owned by a separate local bounded context between acquisition and the live
projections. Its aggregates are:

- `SessionRecord`: sanitized project/session identity, lifecycle, completeness, and retention;
- `SourceEpoch`: one stable source identity and monotonic record/byte sequence;
- `TimelineSegment`: sealed canonical events plus checksum, time range, and schema/mask versions;
- `ProjectionCheckpoint`: disposable reducer state at a canonical timeline cursor;
- `RetentionPolicy`: quota, age, pin, purge, and eviction rules.

The context enforces append-only stable event identity, monotonic source ordinals within an epoch,
explicit gaps, terminal lifecycle monotonicity, selected-session content isolation, and
replay/live equivalence at the same high-water mark. `LiveReplayStream` remains only the bounded SSE
resume cache. Historical duration is bounded by an explicit retention policy rather than accidental
process memory limits.

### Milestone 1: Identity bootstrap

- Discover sources newest-first and read bounded metadata before following appends.
- Hydrate safe project/model/agent/hierarchy facts from Codex state.
- Preserve field-level provenance and prevent bootstrap from fabricating liveness.

### Milestone 2: Operational shell

- Lead with project and host identity, evidence-backed provider/model identity, lifecycle,
  freshness, and a safe summary.
- Replace bare unknowns with evidence-specific missing-data language.
- Provide a project-first browser with live-first, host-qualified sessions and a
  selected-session execution canvas.

### Milestone 3: Execution workspace

- Coordinate agent anchors, owned tool satellites, causal animation, and selection.
- Bound high-cardinality operations and summarize older work on its owner.
- Preserve pan, zoom, drag, pins, filters, pause, and streaming state.

### Milestone 4: Live evidence rail

- Add a protected selected-session transcript stream with bounded history and replay.
- Add search, auto-follow/unread state, collapsed detail, and graph cross-highlighting.
- Keep all transcript content outside graph snapshots, deltas, and replay.

### Milestone 5: Ecosystem enrichment

- Add ruflo swarm/agent/hook/daemon source adapters.
- Add agentic-qe task/evaluation/verdict source adapters.
- Add explicit skill, plugin, MCP, and tool activity source adapters.

### Milestone 6: Hardening and scale

- Complete adversarial tailer, schema-drift, privacy, HTTP, and reconnect tests.
- Complete keyboard, reduced-motion, pause, and textual-equivalence audits.
- Verify idle resource cleanup and independent adapter degradation.
- Measure layout/frame budgets with synthetic load.
- Add collapse, filters, history limits, and topology stabilization.
- Document source coverage, confidence semantics, and unsupported evidence.
- Pass `pnpm run check`.

### Milestone 7: Durable cradle-to-grave review

- Add the persistent sanitized session catalog and append-only canonical timeline segments.
- Persist source checkpoints and rotation epochs; backfill supported artifacts oldest-first.
- Add projection checkpoints and archive-backed range/seek readers.
- Keep live review pinned while the archive grows, then hand off to live without loss or duplicates.
- Add quota, pin, purge, completeness, integrity recovery, schema upcasting, and privacy controls.
- Prove restart/seek equivalence and disclose every prefix gap, eviction, and unsupported record.

## Acceptance criteria

- Supported appended evidence appears within two seconds under normal local load.
- Snapshot plus retained replay converges with uninterrupted streaming.
- The same event applied twice causes no duplicate node, edge, or activity.
- Observed, correlated, inferred, and planned topology are visibly distinguishable.
- A failed source is visible as degraded while other sources keep streaming.
- Rotation, truncation, partial writes, missing parents/completions, and clock skew do not crash.
- No excluded content appears in snapshot, SSE, logs, or adapter error responses.
- Pause and reduced-motion behavior work; all essential data is keyboard-accessible without SVG.
- Pan, bounded pointer-centred zoom, node drag/pin, fit, and reset have keyboard-accessible
  controls and do not interrupt ingestion.
- Streaming preserves the user's viewport, selection, and manually positioned nodes.
- The overview uses evidence-backed semantic labels and current-work summaries; a generic or
  inferred identity is visibly identified as such.
- Graph and transcript selection remain coordinated; auto-follow yields to manual reading.
- No client connection remains after disconnect; bounded idle or dashboard close releases
  collectors.
- Historical dashboard routes and usage results remain regression-compatible.
- Clean-room provenance is documented; no Albert or Agent Flow branding/assets are copied.

## Implementation conformance

The implemented vertical slice lives in `src/lib/live/`, `src/lib/dashboard/`, and the thin
`dashboard-server.mjs` composition root. Defaults are:

- 750 ms reconciliation interval;
- 256 tailed files; explicit sources take priority and Claude/Codex divide the remainder;
- 100 projected sessions and 1,000 nodes per session;
- 2,000 replay events;
- 30-second quiescence and five-minute expiry;
- 80 visible graph nodes and 256 paused browser updates;
- 32 SSE clients and 256 queued frames per slow client, with clamps of 256 clients and 4,096
  frames.
- 30-second collector idle-stop after the last client.

The server subscribes before taking the initial snapshot and reconciles buffered/replayed events,
closing the snapshot-to-subscribe race. A slow-client queue overflow discards queued frames and
sends a reset snapshot after drain.

The default command discovers Claude/Codex transcripts and reads Codex ledger edges. Ruflo and
agentic-qe source adapters require explicit, repeatable `--live-source 'surface=path'`
registration, where `surface` is `ruflo` or `aqe`. Explicit sources consume tailer
capacity before Claude/Codex discovery. Paths resolve against the startup working directory and are
not confined to the project, so registration is an operator authorization to read that file.
Independent plugin, skill, MCP, and gate registries are not implemented. This is an explicit source
coverage limitation; ADR-0012 is Accepted because the supported adapter contract does not claim
automatic upstream discovery.

## References

- [ADR-0012](../adr/0012-live-sessions-observability.md)
- [Albert license][albert-license]
- [Reviewed Albert graph source][albert-graph]
- [OpenTelemetry GenAI semantic conventions][otel-genai]
- [WHATWG Server-Sent Events][sse]
- [The Eyes Have It: overview, zoom/filter, details on demand][eyes-have-it]
- [D3 zoom direct-manipulation conventions][d3-zoom]
- [Dynamic Graph Drawing: A Survey][dynamic-graphs]
- [Stable visualization of connected components in dynamic graphs][stable-graphs]
- [Experimental review of mental-map preservation][mental-map-review]
- [WCAG 2.2][wcag]
- [WAI-ARIA Graphics Module][graphics-aria]

[albert-license]: https://github.com/Sdraugel/albert/blob/96db73d06f64300bb4869fffede4541a9d0eb6e7/LICENSE.md
[albert-graph]: https://github.com/Sdraugel/albert/blob/96db73d06f64300bb4869fffede4541a9d0eb6e7/console/public/app.js#L1977-L2234
[d3-zoom]: https://d3js.org/d3-zoom
[dynamic-graphs]: https://doi.org/10.1111/cgf.12791
[eyes-have-it]: https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf
[graphics-aria]: https://www.w3.org/TR/graphics-aria-1.0/
[mental-map-review]: https://doi.org/10.1016/j.ijhcs.2013.08.004
[otel-genai]: https://github.com/open-telemetry/semantic-conventions-genai
[sse]: https://html.spec.whatwg.org/multipage/server-sent-events.html
[stable-graphs]: https://doi.org/10.1177/1473871620972339
[wcag]: https://www.w3.org/TR/WCAG22/
