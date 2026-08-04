# Observability Domain Design

This document specifies the domain model behind
[ADR-0012](../adr/0012-observability.md). It follows SPARC's specification,
architecture, refinement, and completion stages; implementation pseudocode appears at the relevant
boundaries.

The shared [ubiquitous language](ubiquitous-language.md) and
[context map](context-map.md) are normative. Terms defined below refine the Observability context
without redefining shared integration concepts.

## Ubiquitous language

| Term | Meaning |
|------|---------|
| Session | One host thread or orchestrated run whose live state is observed |
| Project | Sanitized repository identity grouping sessions across hosts and time |
| Session workspace | Temporal, privacy-bounded checkout context owned by one observed session |
| Working tree at capture | Tracked checkout counts versus `HEAD`; context, never agent attribution |
| Session key | Host-qualified identity (`host:sessionId`) preventing cross-host collisions |
| Root session | Top-level host thread or orchestrated run used as one navigation unit |
| Child session | Independently addressable agent/worker thread with an observed parent |
| Orphan session | Thread whose declared parent is not currently retained; temporarily navigable |
| Navigation root | Session presented in the project session list; normally a root or orphan |
| Entity | A session, agent, tool, skill, plugin, MCP server, gate, or other observed capability |
| Actor | An entity that initiates or owns an activity |
| Activity | A bounded operation performed by an actor |
| Presence lease | Observed proof that a host controller process exists; never proof of work |
| Meaningful activity | Semantic input, output, operation, or evaluation evidence attributable to an actor |
| In-flight flow | A started and unfinished operation/relationship eligible for moving edge treatment |
| Actor lens | Selectable view of an embedded actor inside its parent session; not a fabricated child session |
| Capability coverage | Per-session declaration of which evidence dimensions the source can support |
| Court membership | Agentic-QE leader/seat relationship; orthogonal to native session parentage |
| Display identity | Evidence-graded human label and role; never the source ID alone |
| Current work | The latest open, allowlisted operation summary for an entity |
| Evidence | A source record supporting a domain fact |
| Field provenance | Evidence and confidence attached to one fact, not the whole record |
| Confidence | `observed`, `correlated`, `inferred`, `assumed`, or `planned` |
| Read-model projection | The current query/UI state derived from canonical events |
| Topology | Nodes and typed relationships visible for a session |
| Execution canvas | Spatial view of agents, owned tools, and causal flow for one session |
| Evidence rail | Selected-session transcript synchronized with canvas selection |
| Primary area | One stable dashboard domain workspace: Overview, Usage, or Observability |
| Secondary navigation rail | One fixed-position tab row whose choices belong to the active primary area |
| Live scope | Navigation roots with current presence or fresh meaningful activity |
| History scope | Retained navigation roots that do not satisfy the Live predicate |
| Scope predicate | One canonical classifier assigning every retained root to exactly one scope |
| Follow Live | Playhead follows the newest retained event and advances on append |
| Review | Deterministic reconstruction of one session at a selected evidence time |
| Review-time state | Past state at the playhead; never current presence or work |
| Playhead | Current playback offset within retained session evidence |
| Cursor | Monotonic ingest position used for delivery and replay |
| Adapter health | Freshness and failure state of one evidence source |
| Quiescent | No recent activity, but no authoritative completion was observed |
| Terminal | Completed, failed, or cancelled according to explicit lifecycle evidence |

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

### Observability domain

Owns canonical events, identity correlation, lifecycle transitions, evidence confidence, aggregates,
and invariants. Host-specific record shapes do not cross this boundary.

### Read-model projection and replay

Owns materialized session graphs, bounded retention, cursor replay, snapshots, and idempotent
reduction. It is optimized for current state, not historical cost analytics.

### Dashboard delivery

Owns HTTP/SSE representation, connection lifecycle, filters, stable SVG presentation, the
synchronized evidence rail, shared dashboard navigation, canonical hashes, local presentation
preferences, and textual equivalents. It cannot manufacture domain facts or collapse distinct host,
provider, provenance, and model facts into one identity.

### Historical usage

The existing usage index remains a separate context. It owns transcript detail, token/cost
aggregation, and historical classification. Its session identifier can link contexts, but its
aggregate is not the live event store.

## Context relationships

```text
Claude ─┐
Codex ──┤
OpenCode┤
ruflo ──┤  source adapters / anti-corruption layer
AQE ────┤
ak ─────┘
          ↓
canonical event normalizer
          ↓
ObservedSession aggregate → read-model projection/replay → snapshot + SSE → dashboard
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

Codex ledger reads retain the thread's source creation, update, and recency timestamps. Collector
observation time records when the dashboard saw the row; it is never substituted for thread
freshness. A runtime process can attach presence to a retained session only when that session was
updated during the current process generation. Otherwise it remains a separate synthetic presence
session until stronger identity evidence arrives.

## Aggregates and entities

### `ObservedSession` aggregate root

Identity is `(host, sessionId)`, with an optional cross-host `runId`. It owns:

- lifecycle status, an independent presence lease, and last meaningful-activity time;
- actor identities and typed relationships;
- active and terminal activities;
- evidence references and confidence;
- adapter freshness relevant to this session;
- safe aggregate usage/duration counters when explicitly reported;
- its latest safe `SessionWorkspace` snapshot and the capture evidence supporting it.

Presence and activity are independent axes. A runtime heartbeat may update `presence` and the
session freshness cursor, but cannot replace the last semantic actor action, change a quiet actor
to working, or animate a structural edge. An operation becomes in-flight only from an explicit
started phase that has not reached a terminal phase.

The scope predicate is total and exclusive: every retained navigation root is either Live or
History, never both. Observation time cannot promote History into Live. An expired unfinished
operation retains its unknown outcome but clears current activity and current-operation identity.

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
  sessionCount, liveCount, historicalCount,
  liveChildCount, historicalChildCount, presentCount, workingCount, completedCount,
  hosts, providers
}
```

It is reduced from sanitized session project labels. Navigation roots are classified once by the
canonical scope predicate. Live orders current roots by current evidence; History orders retained
roots by last meaningful source time. There is no cross-scope ordering. Project and child counts
are computed per scope, so a live-only project cannot appear as an empty History project and an
empty Live scope remains empty. A project ID is opaque and safe for DOM/routing; it never contains
the raw working directory.

`hosts` counts execution hosts independently. `providers` counts evidence-backed inference
providers and uses an explicit `unknown` bucket when no provider evidence exists; it never
substitutes the session host.

`presentCount` and `workingCount` are separate. `liveCount` is their navigation-oriented union, not
a synonym for working. This makes a quiet but present controller visible without overstating work.
Collector observation time and retained `status: running` are not scope evidence. Only a valid
presence lease, fresh meaningful activity, or a genuinely in-flight operation can classify a root
as Live.

Project identity means the owning repository, not the current branch or linked-worktree directory.
For a live local worktree, the `.git` ownership pointer resolves the repository. Known nested
worktree layouts provide a privacy-safe fallback for retained paths that no longer exist. Raw
working directories and Git metadata paths do not cross the boundary. A separate temporal
`SessionWorkspace` may carry sanitized repository-relative context; it does not change project
identity.

### `SessionWorkspace` value object

`SessionWorkspace` belongs to `ObservedSession`, not `Project`, because two sessions in one project
may use different linked worktrees or capture the same checkout at different times:

```text
SessionWorkspace {
  opaqueKey,
  repositoryLabel,
  directoryLabel,
  branchLabel, branchState,
  changes { additions, deletions, files, binaryFiles, basis, completeness },
  capturedAt, source, confidence
}
```

Acquisition computes tracked counts against `HEAD` with Git invoked directly, no shell, a bounded
timeout/buffer, disabled terminal prompting, and optional locks disabled. Untracked contents and
binary line counts are excluded. A missing repository, unborn `HEAD`, timeout, or failed Git read
produces absent evidence—not fabricated zeroes.

The value object never contains an absolute working directory, filename, patch, raw Git output,
prompt, command, tool input, or tool result. Branch and relative-directory labels are bounded,
control-stripped, path-checked, and secret-masked at the event and persistence boundaries. Its
numeric delta is titled **Working tree at capture** because multiple live sessions can share a
checkout; it is never represented as “changes made by this agent.”

The projection merges snapshots by source confidence and capture time. A weaker metadata record
may fill a missing label but cannot erase stronger Git counts. The owner-only
`WorkspaceSnapshotStore` retains at most one last safe value per host-qualified session. On restart
it restores metadata-only History evidence using the original capture time. Restoration cannot
create presence, meaningful activity, green state, or animation, and it never re-queries the
current checkout to reconstruct past state.

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

Claude sidechain evidence does not currently establish a separate session aggregate or content
endpoint. It therefore creates a `contains` relationship and a nested actor lens under the real
parent session. Codex ledger children remain full `LiveSession` aggregates. Actor lenses may filter
the parent transcript but never acquire invented IDs, timestamps, transcripts, playback, or
completion state.

Agentic-QE court membership is another hierarchy projection, not native session parentage. A court
leader and seat may report different execution hosts inside one AQE session. This permits
Claude-led/Codex-seat and Codex-led/Claude-seat views when explicit structured evidence supplies the
relationship. OpenCode remains absent from court membership until Agentic-QE supports and reports
OpenCode court routing; runtime presence alone cannot imply a court seat.

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

Provider evidence is graded by where it came from (ADR-0021). Codex artifacts name their serving
provider (`model_provider` in rollout `session_meta` and the state ledger), so Codex claims are
**observed**. Claude transcripts never name one; the domain resolves it from the host's documented
configuration surface — Bedrock/Vertex/Foundry selection flags and `ANTHROPIC_BASE_URL` gateway
classification across settings layers — yielding a **configured** claim, or an **inferred** one for
the first-party default. Resolution occurs whenever canonical Claude evidence supplies a working
directory, including transcript discovery and runtime leases. An unrecognized gateway stays
`gateway` rather than a guessed vendor, and a claim's grade is never upgraded downstream.

### `Activity`

An activity represents a bounded invocation or evaluation. It has source-scoped identity, actor,
action, target, timestamps, status, optional safe counters, and evidence. Repeated updates mutate
the aggregate state through idempotent events; they do not create duplicate visible activities.

### `CapabilityCoverage` value object

Every serialized session declares evidence coverage for `presence`, `activity`, `actors`,
`resources`, `hierarchy`, `transcript`, `playback`, `providerIdentity`, `workspaceIdentity`,
`gitBranch`, and `gitChanges`. Values describe the
strongest supported evidence such as `observed`, `events`, `child-sessions`, `embedded-actors`,
`lifecycle`, `session`, `presence-only`, or `unavailable`. UI affordances derive from this object;
they do not hardcode host names as capability proxies.

The same component shell is used across Claude Code, Codex, and OpenCode. An unavailable value
disables the unsupported action and supplies a specific explanation. It never causes the renderer
to invent a child session, transcript, operation, provider, court seat, or animated edge.

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
  schemaVersion: 2,
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
  workspace: {
    key: "workspace:opaque-hash",
    repositoryLabel: "agentic-kit",
    directoryLabel: "repo root",
    branchLabel: "feature/observability",
    changes: { additions: 12, deletions: 3, files: 2, basis: "tracked-vs-head" },
    capturedAt: "2026-07-27T18:42:00.991Z",
    source: "git",
    confidence: "observed"
  },
  actor: {
    id: "source-scoped-id",
    kind: "subagent",
    label: "test runner",
    role: "tester",
    host: "codex",
    provider: "openai",
    model: "gpt-5.6-sol"
  },
  action: "agent.spawned",
  target: { id: "child-id", kind: "subagent" },
  status: "running",
  signal: {
    kind: "relationship",
    phase: "observed",
    correlationId: null
  },
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
  counters, independent presence/activity, capability coverage, and field provenance;
- `nodes`: identity, session, kind, label, role, host/model, status, last action, confidence, and
  safe metadata and actor execution host;
- `edges`: source, target, relationship type, human verb, confidence, and status;
- `health`: sanitized adapter status and aggregate counters;
- `cursor` and `schemaVersion`.

The dashboard shell has exactly three primary areas: `Overview`, `Usage`, and `Observability`. One
fixed, left-aligned secondary navigation rail remains in the same location while its contents change:

```text
Overview      → Summary | Hosts & Routing | Providers | Runtime | Intelligence
Usage         → Scorecard | Limits | Findings | Sessions | Transcript
Observability → Live | History
```

Navigation state has canonical hierarchical hashes:

```text
#overview/{summary,hosts,providers,runtime,intelligence}
#usage/{score,limits,findings,sessions,transcript}
#usage/{sessionId}
#observability/{live,history}
```

Each destination owns a visible heading and concise description. The primary and secondary controls
are ARIA tab lists with roving focus: Left/Right selects and focuses the adjacent tab with wrapping,
Home selects the first tab, and End selects the last. This navigation state is dashboard
presentation, not Observability evidence, and changing a hash cannot strengthen or mutate a domain
fact.

Usage session rows preserve four independent identity axes. The compact badge names only the
execution host; an independently expandable strip names inference provider, provider provenance,
and reported models. Codex `model_provider` carried by `session_meta` or `turn_context` is observed
provider evidence. Native Claude transcript history has no equivalent serving-provider field, so
`Not recorded` is a valid value. Dashboard delivery never infers provider from the execution host or
model string.

The renderer separates domain projection from presentation state. A world transform `{x, y, k}`
controls the viewport, while a position cache and optional pin offset are keyed by entity identity.
Status-only updates cannot trigger global layout or reset the world transform. Agents are stable
anchors. Each actor, work bubble, history summary, and owned operation lane forms a measured bundle;
the next bundle begins after the first bundle's full vertical footprint. Tool cards occupy a lane
outside the actor/work-label bounds, so deterministic automatic placement cannot overlap them.
Only explicitly started, unfinished flow animates. Structural relationships are static; observed
presence breathes slowly; meaningful work pulses independently.

The presentation grammar treats an agent as an iconic hex/ring anchor, not a workflow card.
Observed current work is a nearby transient bubble, and tool activity is a small tethered
satellite that recedes after completion. The canvas owns the docked timeline and fills the usable
viewport beside the persistent evidence rail. Project/session navigation and source diagnostics
remain compact overlays so telemetry chrome cannot displace the work itself.

Direct manipulation follows a slippy-map interaction contract:

- drag empty space to pan;
- wheel or trackpad scrolling zooms about the pointer within bounded scale;
- drag an actor or individual operation card beyond a click threshold to move and pin it;
- visible controls zoom, fit, reset the camera, and reset the layout;
- fit changes only the viewport; reset layout discards manual layout offsets;
- stream updates preserve viewport, selection, and manually positioned nodes.

Positions and pins are keyed by `sessionKey|entityId`, not raw native ID. Hover and focus show an
ephemeral evidence-aware description. Click, Enter, or Space selects the component and opens
persistent detail. A **Legend / Help** dialog explains shapes, statuses, confidence, motion, and
interactions; a polite guidance region announces selection and next action. Pause stops CSS and SVG
movement as well as visual delta application, while `prefers-reduced-motion` removes nonessential
motion without hiding state.

The execution canvas and transcript rail share one selection model. Selecting an agent focuses its
subtree and transcript; selecting a tool shows its safe summary; selecting evidence highlights and
centers its owner. The initial overview shows project, host, evidence-backed provider identity,
lifecycle, current work, and critical failures; metadata and evidence are details on demand
([Shneiderman][eyes-have-it]).

The right Session Stream rail subscribes only to the selected `{host, sessionId}`. It carries
the rich masked conversation, plaintext reasoning, tool inputs/results/errors, patches, MCP/web
activity, and subagent messages available from that host. It supports search, type/actor filtering,
collapsed large details, auto-follow, and unread state. It renders transcript text as text, never
markup, and labels masking as best effort.

The rail's body is collapsible presentation state, locally persisted independently of session
evidence. Collapsing it does not close its selected-session subscription or stop ingestion; it gives
the execution canvas more horizontal room and leaves a compact restore rail with a real chevron
button. The button exposes `aria-expanded`, an action-specific label, and a polite state
announcement. At narrower breakpoints the rail stacks below the browser/canvas and its collapsed
form becomes a compact full-width restore bar. Leaving Observability still closes the connection;
collapsing the rail does not. Pause remains a separate state that freezes visual delta application.

Project selection precedes session selection. Navigation scope and playback state are separate
state machines: `Live | History` chooses eligible roots, while `Follow Live | Review` chooses how
one selected root is presented. Switching scopes clears incompatible selection and chooses only
within the destination scope. Review owns `{playhead, playing, speed}`; appends extend duration
without moving a reviewer's playhead. Seeking resets presentation state and reapplies ordered
evidence through the selected offset. Resume Live is available only when the selected root still
satisfies the Live predicate.

Green is current-state vocabulary, never a historical outcome color. History and Review suppress
presence breathing, work pulse, flow particles, moving dashes, live following, and unread updates.
Completed history is neutral; an explicit historical failure may remain static red. A playback
event that was running is described as in progress at that playhead, not `Working now`.

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
   reduced motion, keyboard navigation, textual equivalence, filters, dark/light themes, measured
   actor/tool non-intersection, independent actor/tool drag, legend/tooltips, and truthful flow.
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
- Presence, meaningful activity, and in-flight flow are independent; a heartbeat never overwrites
  semantic activity or animates structural relationships.
- Every retained root belongs to exactly one scope; scope-local project/session/worker counts match
  visible rows, and empty Live renders zero projects rather than recent History.
- History and Review contain no green current-work cues, breathing presence, moving flow, live
  follow state, or unread-live announcements.
- Pan, bounded pointer-centred zoom, node drag/pin, fit, and reset have keyboard-accessible
  controls and do not interrupt ingestion.
- Automatic actor bundles and operation cards do not intersect at the reference viewport; both are
  independently draggable and pinnable.
- Hover/focus descriptions, persistent selection detail, and Legend / Help explain every unit and
  the available next interaction.
- Exactly three primary areas share one fixed, left-aligned secondary rail; canonical hashes,
  headings, descriptions, roving Left/Right focus, and Home/End behavior match each destination.
- Collapsing Session Stream preserves its connection and local choice, expands Agent activity,
  leaves a keyboard-accessible restore rail, and remains compact when the layout stacks.
- Usage session rows present host, provider, provider provenance, and model as independent facts;
  Codex `model_provider` is observed and absent Claude provider evidence reads `Not recorded`.
- Streaming preserves the user's viewport, selection, and manually positioned nodes.
- The overview uses evidence-backed semantic labels and current-work summaries; a generic or
  inferred identity is visibly identified as such.
- Graph and transcript selection remain coordinated; auto-follow yields to manual reading.
- No client connection remains after disconnect; bounded idle or dashboard close releases
  collectors.
- The canonical dashboard routes are `#observability/live` and `#observability/history`;
  Historical Usage remains a separate bounded
  context and its results remain regression-compatible.
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

The implemented dashboard shell exposes three primary areas and one shared secondary rail. It emits
the canonical Overview, Usage, and Observability hashes above, gives every view a heading and
description, and implements Left/Right/Home/End tab semantics. Observability's locally persisted
Session Stream chevron changes layout without changing subscription ownership. Usage session rows
show a host-only badge and reveal provider/provenance/model facts in their own detail strip.

The default command discovers Claude/Codex transcripts, observes Claude/Codex/OpenCode controller
presence and inspectable workspace context, and reads Codex ledger edges. Claude sidechains are
embedded actor lenses; Codex ledger children are independent sessions. OpenCode detailed activity,
transcript, playback, hierarchy, and Agentic-QE
court membership remain unavailable until their respective sources report those capabilities.
Ruflo and
agentic-qe source adapters require explicit, repeatable `--live-source 'surface=path'`
registration, where `surface` is `ruflo` or `aqe`. Explicit sources consume tailer
capacity before Claude/Codex discovery. Paths resolve against the startup working directory and are
not confined to the project, so registration is an operator authorization to read that file.
Independent plugin, skill, MCP, and gate registries are not implemented. This is an explicit source
coverage limitation; ADR-0012 is Implemented because the supported adapter contract does not claim
automatic upstream discovery.

## References

- [ADR-0012](../adr/0012-observability.md)
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
