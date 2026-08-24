# ADR-0012 — Evidence-graded session observability

- **Status:** Implemented
- **Date:** 2026-07-27
- **Updated:** 2026-08-24
- **GA surface:** Canonical naming and retired vocabulary follow
  [ADR-0020](0020-ga-stable-surfaces.md).
- **Update note:** Renamed the dashboard surface from Live to Observability and made Live and
  History mutually exclusive navigation scopes. Historical and reviewed evidence is visually
  inert: no green current-work cues, breathing presence halo, or moving flow. Reconciled the
  interaction contract so presence is distinct from meaningful
  work and in-flight flow; layout is collision-aware and directly manipulable; help is available
  in context; Claude sidechains use actor lenses; and provider/API differences are disclosed through
  capability coverage rather than hidden behind inconsistent host-specific UI. Claude runtime-only
  sessions now resolve configured/inferred provider identity without treating the host as provider
  evidence or downgrading stronger transcript evidence. Internal model placeholders are suppressed
  from activity callouts in favor of useful freshness context. Codex ledger history retains its
  source timestamps, runtime presence binds only within the current process generation, and the
  navigator separates Live-only from History-only results. Compatibility-source references remain
  amended by [ADR-0020](0020-ga-stable-surfaces.md). Session rows and Selection details now defer
  repository identity to the selected project heading, omit `repo root`, and use a branch glyph
  with the branch name; meaningful non-root directories remain available when recorded. Playback
  is contextual and docked inside the execution-map card so it cannot obscure map evidence.
  Live and History use the dashboard's shared secondary segmented-tab treatment beneath the
  Observability tab, including arrow-key navigation and an explicit selected state.
  Session Stream may be collapsed without disconnecting its live subscription; the choice is
  stored locally and a compact, keyboard-accessible restore rail remains visible across responsive
  layouts.
  Historical and active-session Review playback exposes 0.5× through 10× speeds.
  ADR-0023 restricts runtime discovery to the current UID and reads argv only for selected current-user
  host/Node candidates, before the existing path-redacted event boundary.

**2026-08-24 pagination amendment:** History now supports bounded opaque-token pagination with
explicit totals, coverage, and incomplete-scan disclosure while preserving the legacy no-query
snapshot shape.

- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0005](0005-dashboard-in-page-routing-reveal.md),
  [ADR-0007](0007-maintainer-admin-local-telemetry.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md)

> **GA amendment:** the local, read-only observability contract remains. References below to the
> retired compatibility execution source describe the evidence model at adoption time only.

**2026-08-03 runtime identity amendment:** transcript and ledger evidence remains the topology
source, while an asynchronous two-second local process survey supplies observed liveness leases
for top-level Claude Code, Codex, and OpenCode controllers on macOS and Linux. Nested host CLIs
remain workers of their nearest controller. A runtime lease requires a canonical Git repository;
three consecutive successful surveys without the controller quiesce it. Retained transcript
evidence may use a privacy-safe repository-label fallback when its former path no longer exists.
Unresolved internal evidence is retained for later reconciliation but is never presented as an
`unknown` workspace. Public project keys hash the canonical repository root when proven and never
expose the path.

**2026-08-03 interaction and capability amendment:** a runtime heartbeat proves that a process is
present; it does not prove that an actor is working. Animated flow requires an explicitly started,
unfinished operation or relationship signal. Claude sidechain actors are nested under their real
parent as selectable actor lenses because current Claude evidence does not establish independently
addressable child sessions. Codex ledger threads remain real child sessions. OpenCode currently
contributes controller presence only. Agentic-QE court membership is a separate orchestration axis:
when structured AQE evidence reports it, a Claude-hosted court may contain Codex members and vice
versa. OpenCode is not presented as a court member until Agentic-QE reports that routing capability.

**2026-08-03 history-boundary amendment:** collector observation time must not become displayed
session freshness. Codex ledger rows retain their source thread timestamps. A runtime process may
attach presence to a retained session only when that session was updated during the current process
generation; otherwise it remains a separate presence-only session until stronger identity evidence
arrives. The default navigator is Live-only. History is an explicit mode and never appears in Live
project or session counts.

**2026-08-03 Observability naming and scope amendment:** **Observability** is a top-level dashboard
area with two mutually exclusive navigation scopes: canonical `#observability/live` and
`#observability/history`. **Live** contains roots with current process presence or fresh meaningful
work; **History** contains the retained complement. A project appears only when it has a root in
the selected scope, and all visible counts are scope-local. History is distinct from **Review**:
History chooses retained sessions, while Review reconstructs one selected session at a playhead.
Neither History nor Review may present green current-work status, presence breathing, or moving
flow. Explicit historical failures may remain static red; all other retained state is neutral.

**2026-08-04 workspace-context amendment:** every supported top-level Claude Code, Codex, or
OpenCode runtime session may carry the same `SessionWorkspace` value object. It contains only an
opaque workspace key, sanitized repository and repository-relative directory labels, a bounded
secret-masked branch or detached revision, numeric tracked working-tree counts versus `HEAD`,
capture time, source, and confidence. It is checkout context, never per-agent authorship. The last
safe snapshot per host-qualified session is persisted owner-only for History; History must not
inspect the current checkout and mislabel that state as historical. Absolute paths, filenames,
patches, untracked contents, and raw Git output never cross the event boundary or enter the store.

## Context

Before this decision, `ak dashboard` reported configuration health and historical usage but could
not show work as it happened. Claude, Codex, ruflo, agentic-qe, skills, plugins, MCP tools, and
delegated agents can all
participate in one development task. Their evidence is distributed across append-only transcripts,
Codex's state ledger, local daemon registries, workflow metadata, and quality hooks.

The existing implementation is deliberately local and observation-only: it cannot steer agents or
mutate repositories. `dashboard-server.mjs` binds to
loopback and protects requests with Host, Origin, and Fetch Metadata checks. `usage-index.mjs`
incrementally indexes completed and changing transcripts for historical analytics.
`codex-state.mjs` exposes authoritative `thread_spawn_edges`; `daemons.mjs` discovers local ruflo
state; and `routing.mjs` knows the planned dual-run topology. These are useful sources, but they do
not share a live event model. Re-running the historical usage scan on a shorter interval would mix
two workloads and would still not establish causal topology.

The desired view is a diagrammatic, continuously updating map of sessions, agents, and their
current work, paired with the selected session's live evidence. Albert informed the first
information architecture. Agent Flow subsequently demonstrated a stronger execution grammar:
stable agent anchors, concrete tool satellites, animated dispatch and return paths, and a
synchronized transcript rail driven by one normalized source stream ([Agent Flow][agent-flow]).
Source review also established important boundaries:
Albert's current graph is a fitted, fixed-viewBox SVG. It does not implement graph pan/zoom or
user-positioned nodes. Those interactions are an independent ak design, not an Albert-derived
feature. Albert is distributed under PolyForm Noncommercial 1.0.0, while ak is MIT licensed.
Therefore neither project's branding or assets are copied. The implementation is clean-room work
based on independently documented protocols, direct-manipulation conventions, and general
visualization principles. See [Albert's license][albert-license], the reviewed
[Albert graph source][albert-graph], and Agent Flow's [Apache-2.0 source][agent-flow-source].

Information visualization should provide an overview, zoom and filtering, then details on demand
([Shneiderman][eyes-have-it]). Dynamic graph research finds that stable placement can improve
visual search while warning that stability must be balanced against the user's task and
readability ([Di Giacomo et al.][stable-graphs],
[Archambault and Purchase][mental-map-review], [Beck et al.][dynamic-graphs]). A causal delegation
graph also fits hierarchical layout better than an unconstrained force simulation. Accessibility
requires a way to pause moving information and a non-visual equivalent
([WCAG 2.2][wcag], [WAI-ARIA Graphics][graphics-aria]).

## Decision

### 1. Add read-only Observability; do not add chat or a control plane

The dashboard has a top-level Observability view that depicts supported evidence:

- sessions and their Claude Code, Codex, or OpenCode host, with source capabilities disclosed;
- parent, delegated, and sub-agent relationships;
- ruflo orchestration and workflow steps;
- agentic-qe workers, evaluations, gates, and verdicts;
- skills, plugins, MCP servers, and tool activity when supported by evidence.

The view exposes metadata, lifecycle state, provenance, aggregate metrics, and an on-demand,
server-redacted transcript for the one selected local session. Interactive chat, cancellation,
steering, rerouting, and message submission are not part of this decision.

### 2. Introduce a canonical, versioned, OpenTelemetry-aligned event model

Every source adapter emits an allowlisted envelope containing:

- schema version, event ID, source timestamp, observation timestamp, and ingest sequence;
- session, parent-session, trace, span, and parent-span identifiers when known;
- host, surface, project, actor kind, role, provider, and model;
- optional schema-v2 `SessionWorkspace` capture with bounded labels, tracked counters, time, and evidence;
- action, target, lifecycle status, and safe aggregate attributes;
- source adapter and confidence: `observed`, `correlated`, `inferred`, or `planned`.

The vocabulary aligns where practical with OpenTelemetry's GenAI agent, model, tool, MCP, and
evaluation conventions, but ak owns its versioned boundary because those conventions are evolving
([OpenTelemetry GenAI][otel-genai], [semantic conventions][otel-semconv]).

Adapters preserve source ordering. The ingest sequence orders delivery, not causality. Clock skew
must never be converted into a fabricated global order. Static routing DAGs may appear only as
`planned` topology tied to a concrete run; seeing a tool name is not proof that an agent is running.

### 3. Separate collection, projection, transport, and rendering

The live feature is implemented as modules rather than growing `dashboard-server.mjs`:

1. Source adapters and append-aware tailers collect local evidence.
2. A normalizer validates and allowlists canonical events.
3. A reducer maintains bounded session aggregates and graph projections.
4. A bounded replay log feeds snapshots and live deltas.
5. The dashboard server mounts the endpoints and owns connection lifecycle.
6. A separate client view renders the execution canvas and synchronized evidence rail.

Historical usage indexing remains independent. Shared parsing primitives may be extracted only when
their contracts truly match; the live path does not make the historical index its event bus.

### 4. Use snapshot plus resumable Server-Sent Events

`GET /api/live` returns the materialized projection, adapter health, schema version, and latest
cursor. `GET /api/live/events` returns `text/event-stream` with named events, monotonic IDs,
heartbeat comments, bounded replay, and `Last-Event-ID` resume.

SSE is selected because the flow is one-way and read-only. The HTML standard supplies event IDs,
automatic reconnection, and named events without adding a runtime dependency
([WHATWG SSE][sse]). WebSockets are reserved for a future ADR if a bidirectional control plane is
ever justified ([RFC 6455][websocket]).

When a cursor is outside retention, the server emits a reset instruction and the client fetches a
fresh snapshot. Filesystem watches are hints, reinforced with stat polling and reconciliation.
Tailers retain byte offsets, accept only newline-terminated records, tolerate partial writes, and
reset safely after rotation or truncation.

### 5. Present one coordinated Observability workspace with distinct scopes

Observability answers five questions in order: which project and provider is this, is the session
healthy and current, which agent is doing what now, how did execution reach this point, and what
evidence supports that claim?

Project is the dominant session identity. A sanitized project label, provider badge with visible
text, model when reported, lifecycle, freshness, and a one-line operational summary appear before
the visualization. Host/provider, agent role, and evidence confidence are separate concepts.
Opaque IDs, raw adapter vocabulary, and technical source details remain subordinate.

Projects are the primary navigation aggregate. **Live** lists only projects containing a current
root; **History** lists only projects containing a retained non-live root. Counts include only the
selected scope. Sessions never mix across the boundary: Live orders current evidence by freshness,
while History orders retained evidence by its last meaningful source time. A session row uses
provider mark plus text, role/task when evidenced, model, freshness, duration, and lifecycle; UUIDs
remain technical detail.

The session browser is hierarchical. A root session or orchestrated run is one navigation unit;
provider worker threads do not become peer rows merely because they have independently addressable
transcripts. Selecting a root reveals its descendant agent threads as indented, connected rows,
which remain selectable for their own map, transcript, and playback. Project `sessionCount` counts
navigation roots, while `childSessionCount` reports nested threads separately.

Hierarchy is reconciled rather than fixed at first observation. Rollout evidence may discover a
thread before an authoritative ledger supplies its parent, so later parent evidence repairs the
projection. Session DTOs carry host-qualified parent and root keys, a hierarchy state (`root`,
`child`, `orphan`, or `cycle`), and whether the session is a navigation root. An unresolved orphan
remains navigable until its parent arrives. Corrupt cycles terminate deterministically rather than
hanging projection or navigation. Raw native IDs are never joined across hosts.

The selected session workspace defaults to a split of approximately two thirds execution canvas
and one third **Session Stream**. The stream body may be collapsed without disconnecting its live
subscription. The canvas expands, a compact restore rail remains, and the user's choice is stored
locally. At responsive breakpoints the stream stacks below the canvas; its collapsed restore rail
remains compact rather than consuming the expanded panel's height. Navigation scope and playback
state are orthogonal. A Live-scope session defaults to **Follow Live** and may enter **Review**
without becoming historical. A History-scope session opens retained evidence in Review. Review
uses the same canvas and transcript with play/pause, seeking, event markers, and speed control.
**Resume Live** exists only when the selected root still satisfies the Live predicate.

This is an immersive operations workspace rather than a dashboard panel containing another
node editor. The usable viewport is edge-to-edge below the global navigation; project/session
selection is one compact context bar, source diagnostics are disclosed only on demand, and the
timeline is docked inside the canvas. At 1440×900 the canvas, evidence rail, and timeline are all
visible without document scrolling.

The canvas renders agents as stable anchors and current or recent tools as smaller owned
satellites. Parent-child edges express containment or delegation and remain static unless the edge
itself carries explicit in-flight evidence. A slow breathing halo means process presence; a work
pulse means meaningful current activity; moving dashes mean one started, unfinished operation.
Animation carries meaning and stops under reduced motion or Pause. Selecting an agent focuses its
subtree and filters the rail; selecting a tool shows its bounded safe summary. Selecting evidence
in the rail highlights and centers its owner.

Agent anchors are compact iconic hex/ring glyphs with role, name, model, and state—not equal-rank
rectangular workflow cards. Current work appears beside the actor as an evidence-derived bubble;
tool calls appear as transient tethered chips with verb, target, status, and elapsed time. Finished
operations recede into the timeline instead of permanently crowding the world. A subtle depth field
supports spatial orientation; a prominent spreadsheet grid and nested panel borders do not.

The Session Stream subscription remains present and defaults to the selected session's live
transcript. Its body is collapsible through a chevron button whose `aria-expanded`, accessible
label, and title reflect the current state. Collapse does not pause ingestion or close the SSE
connection; **Pause** remains the separate control for motion and following. The stream
distinguishes human, Claude/Codex, thinking/summary, tool call, tool result, status, and error. It
supports search, role/type filters, auto-follow, an unread indicator when the user scrolls away,
and collapsed thinking and tool detail. It is evidence, not chat.

Primary labels use a source-provided display name or role; secondary labels show entity kind and
host/model; the current-work line shows an allowlisted operation summary, lifecycle, and elapsed
time. Generic `subagent` is a kind, not an adequate display name. Bare `unknown` is not user-facing
copy. Missing evidence is described precisely, for example `Model not reported`,
`Waiting for lifecycle evidence`, `Active; completion unobserved`, `Task details unavailable`,
`Relationship inferred`, or `Source unavailable`.

User-facing state describes work rather than adapter fields. Fresh observed execution is
`Working now`; quiescent work is `Waiting for activity`; expired open work is
`No recent activity`; retained evidence without a completion signal is `Last active`.
`Blocked`, `Failed`, `Cancelled`, and `Completed` require explicit evidence. Continuous work pulse
is reserved for `Working now`; slow breathing is reserved for observed presence; moving flow is
reserved for an explicitly started, unfinished operation or relationship. Waiting/stale/queued use
static amber, and blocked/failed use static red. Green anywhere in the session browser or execution
map means current Live work. History and Review use neutral or amber playback styling even when an
old record said `running`; completed history is muted, and explicit historical failure may remain
static red. Text and geometry remain authoritative when color or motion is unavailable.

Users can drag the empty canvas to pan, zoom around the pointer by wheel/trackpad, and drag actors
or individual operation cards to temporary pinned positions. Visible controls provide zoom in,
zoom out, fit, reset, and separate camera/layout resets. View transforms follow the conventional
scale-and-translation
model documented by [D3 zoom][d3-zoom]. Live updates preserve viewport, selection, expansion, and
user pins; status-only updates cannot trigger layout. Topology changes use a seeded layered layout
with constrained collision relaxation, not continuous force motion. Fit/recenter is explicit, not
an automatic response to streaming data.

Relationship titles use human verbs—spawned, delegated, invoked, returned, evaluated, and
gated—rather than raw transport event names. The view batches visual changes on animation frames,
bounds retained tools/messages, and preserves graph position while evidence streams.

Automatic layout treats an actor, its work bubble, history summary, and owned operation cards as
one measured bundle. Tool lanes begin outside the actor bundle and reserve vertical footprint
before the next actor is placed. This prevents overlap caused by positioning labels and tools
independently. Manual pins remain session- and host-qualified so identically named Claude and Codex
entities cannot mutate each other's layout.

Every selectable component provides a concise hover/focus description and opens persistent detail
on click or keyboard activation. A consultable **Legend / Help** explains shapes, status, motion,
confidence, selection, pan/zoom, drag/pin, pause, and reset. The guidance line reports what the
current selection means and the next available action; it is also announced through a polite live
region. SVG is an interactive group, not one monolithic image.

### 5.1 Separate observation axes and disclose capability coverage

The additive event `signal` value object contains `kind`, `phase`, and an optional correlation ID.
Its kinds are `presence`, `activity`, `operation`, `relationship`, and `metadata`. A session
projection independently carries `presence` and `activity`; a heartbeat updates only presence and
must not overwrite the actor's last meaningful action, activity timestamp, or open operation.

Each session DTO also publishes a capability-coverage map for presence, activity, actors,
resources, hierarchy, transcript, playback, and provider identity. The dashboard uses one visual
grammar for every host, then disables or explains unavailable evidence instead of fabricating
parity. Current native coverage is:

| Source | Hierarchy representation | Detailed Live evidence |
|--------|--------------------------|------------------------|
| Codex | Ledger-backed child sessions, selectable independently | Rollout activity, tools, transcript, playback |
| Claude Code | Sidechain actors nested as selectable actor lenses under the parent session | Transcript activity, tools, parent transcript filtered by actor when attribution exists |
| OpenCode | Controller session only | Presence lease and runtime workspace snapshot; detailed activity, hierarchy, transcript, and playback unavailable |
| Agentic-QE | Court/workflow actors and relationships only when an explicit AQE source reports them | Evidence-graded structured events; Claude/Codex members may coexist in one reported court |

Native session hierarchy and Agentic-QE court membership are orthogonal. A Codex child thread can
participate in a Claude-led court without becoming a Claude child session. Conversely, the UI must
not infer court membership from host, provider, model, timing, or visual proximity. OpenCode court
membership is unavailable until Agentic-QE can configure and report OpenCode-routed court models.

Labels, status colors, actor-specific geometry, and edge verbs provide redundant meaning. The
textual inventory includes recent events, nodes, and relationships with action and confidence.
Users can pause live updates, navigate nodes and viewport controls by keyboard, honor
`prefers-reduced-motion`, filter by host and completion state, and inspect confidence and sanitized
adapter health.

### 6. Privacy and provenance are domain invariants

Adapters construct output objects field by field. They never copy a raw record and redact it later.
Unknown fields are dropped. Paths and source artifact identifiers are reduced or hashed before
leaving the server. Secrets are not logged in adapter errors.

Every node and edge retains its evidence source and confidence. Conflicting evidence is preserved
and surfaced; it is not silently reconciled. Missing or failed adapters degrade independently, and
the snapshot exposes their freshness and error category without leaking sensitive values.

Confidence is field-specific where provenance differs. Project, provider, model, role, status, and
relationship may independently be `observed`, `correlated`, `inferred`, `assumed`, or `planned`.
The UI must not promote a host-based assumption to an observed provider claim.

Collection bootstraps stable identity before following new appends. Sources are discovered
newest-first. Codex state and bounded metadata records hydrate project, provider, model, hierarchy,
and lifecycle; Claude records hydrate sanitized project and safe runtime metadata. The graph plane
never receives `cwd`, transcript paths, raw agent paths, prompt-derived titles, filenames, patches,
raw Git output, tool arguments, results, or message content. It may receive the closed
`SessionWorkspace` DTO: opaque key, sanitized repository/relative-directory label, secret-masked
branch or detached revision, tracked aggregate change counts, capture time, source, and confidence.
The separately selected content plane may receive redacted message text and allowlisted tool
summaries under §7.

Loopback binding and the dashboard's existing request validation apply to both endpoints. SSE
listeners and response resources are released when clients disconnect. After the last client, the
collector and tailers stop following a bounded idle delay (30 seconds by default); a new request
restarts them safely. Dashboard shutdown cancels the timer and closes all resources.

### 7. Use two isolated planes for topology and transcript content

`/api/live` and `/api/live/events` remain metadata-only. Transcript content uses a separate,
selected-session endpoint keyed by both host and session ID. Selecting a session is the explicit
opt-in: the browser does not prefetch other transcripts and closes the previous content stream.

The server resolves the selected session through its internal discovery registry, validates the
host and identifier, resolves the real file beneath the configured transcript root, rejects
symlink escapes and non-regular files, and rechecks containment after replacement. It captures a
bounded history, then tails complete appended records. Every output object is constructed
field-by-field and every emitted string is secret-masked at the final boundary. Responses are
`no-store`, same-origin, bounded by event/message/byte/client limits, and ephemeral after the last
subscriber leaves.

The content DTO distinguishes message, reasoning, tool call, tool result, patch/file change,
subagent activity, status, and error. It carries all locally available, safely renderable evidence:
human and assistant text, plaintext thinking/reasoning summaries, tool inputs and commands, tool
results and errors, patches, MCP/web activity, and subagent messages. Every string is server-masked
and bounded, with truncation disclosed. Encrypted reasoning is never emitted because plaintext is
not available. Large thinking, arguments, results, and patches are collapsed by default for
readability, not withheld.

Content never enters the graph projection, its snapshot, the metadata replay ring, logs,
telemetry, exports, or persistence. Redaction is best effort rather than a guarantee, which the UI
states plainly. The rail cannot send messages, steer agents, replay tools, reveal masked values,
or mutate session state.

### 8. Playback reconstructs evidence; it does not record the screen

Playback is a bounded chronological evidence stream for one `{host, sessionId}`. It combines the
session's normalized topology events with its masked content entries, retains source and ingest
timestamps, and exposes a duration plus ordered event markers. Seeking reduces events from the
session baseline to the selected position, producing the same canvas/transcript state that
uninterrupted application would have produced.

Review is deterministic for the retained evidence window. It does not infer missing events,
fabricate intermediate agent states, execute tools, or store video. For an active session, arriving
events extend the review range without moving the reader's playhead; **Resume Live** applies the
tail and returns to following. Playback history, queues, and snapshots remain bounded and disclose
gaps or truncation.

### 9. Amend bounded playback with a durable local evidence archive

The bounded replay ring remains the transport buffer for SSE resume, but it is not the historical
source of truth. Cradle-to-grave review requires a separate local evidence archive and session
catalog. This amendment supersedes the earlier implication that all transcript content must remain
ephemeral.

Supported source artifacts are catalogued by `{host, sessionId, sourceEpoch}` whether or not they
are actively tailed. The catalog stores only sanitized identity, provider/model metadata,
first/latest activity, lifecycle, completeness, schema and masking versions, and stable hashes of
source identity. It never exposes raw transcript paths.

Each session has an append-only, segmented canonical timeline. Events are constructed field by
field, masked before persistence, and retain source timestamp, source ordinal, ingest sequence,
actor/call/span identity, provenance, and explicit gap or rotation markers. Raw source records,
unknown fields, encrypted reasoning, unmasked tool arguments, and raw filesystem paths are never
copied into the archive. Metadata and selected-session content remain separate public API planes.

Acquisition persists source offsets and identity checkpoints atomically. Replacement or truncation
opens a new source epoch rather than rewriting history. Projection checkpoints periodically capture
the graph reducer state without unbounded transcript bodies. Seeking loads the nearest checkpoint
at or before the requested time and reduces the following canonical events. At an equal archive
high-water mark, live and replay projections must be identical.

The archive is durable but not unbounded. It enforces owner-only permissions, disk quotas,
configurable age/size retention, pinning, explicit per-session/project purge, and eviction
tombstones. Bounds apply to open tailers, file descriptors, memory caches, SSE queues, segment size,
and concurrent readers—not silently to historical duration. The UI reports `complete`,
`source-active`, `prefix-missing`, `gap`, `evicted`, or `source-deleted` precisely.

Schema generations are handled through registered upcasters. Unknown records degrade adapter
health and produce safe quarantine counters; they are not persisted as raw content. Projection
checkpoints are disposable caches and may be rebuilt from immutable canonical segments.

Migration is incremental: dual-write new canonical events, verify source/archive parity and privacy
canaries, backfill existing supported artifacts oldest-first with resumable checkpoints, switch
playback reads to the archive, then retire bounded whole-file playback. Evidence already deleted
before backfill remains an explicit unrecoverable gap.

## Consequences

### Positive

- Users can understand concurrent cross-host work without reading interleaved transcripts.
- Project/provider identity and an operational summary make the default view useful before
  topology inspection.
- A synchronized canvas and evidence rail preserve structural and verbatim context together.
- A canonical event boundary prevents host-specific schemas from leaking into the UI.
- Provenance makes authoritative, correlated, inferred, and planned topology distinguishable.
- Snapshot plus SSE provides inexpensive live delivery and deterministic recovery.
- One event grammar powers live following and historical review.
- Modularization makes adapters, reducers, transport, and rendering independently testable.
- The implementation remains zero-runtime-dependency, loopback-only, and consistent with ak's
  theme and existing security boundary.

### Negative

- Host transcript schemas and ruflo/agentic-qe artifacts can drift independently.
- Some Claude relationships may initially be inferred while Codex ledger edges are authoritative.
- Reconciliation, replay, and lifecycle expiry introduce more state than historical polling.
- SVG accessibility and stable dynamic layout require a parallel textual representation and
  deliberate performance budgets.
- A synchronized transcript rail and causal tool layout add parsing and rendering complexity.
- Direct manipulation adds gesture arbitration, viewport persistence, and drag-versus-click
  behavior that require focused interaction tests.
- A clean-room implementation cannot reuse Albert's implementation assets or shortcuts.

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| False topology | Preserve confidence and source; never promote correlation to observation |
| Transcript or hook drift | Versioned adapters, captured fixtures, unknown-field tolerance |
| Prompt or secret leakage | Allowlisted DTOs and negative privacy tests |
| Rotation, truncation, partial JSONL | Offset-aware tailer plus periodic reconciliation |
| Event duplication or reconnect gaps | Stable event IDs, reducer idempotency, bounded replay/reset |
| Worker threads appear as duplicate sessions | Reconcile late parentage; count roots and nested threads separately |
| Parent missing or cyclic | Keep an orphan navigable; choose a deterministic cycle root; never loop indefinitely |
| Playback differs from live state | Use the same ordered events and reducer for both modes |
| New live events move a reviewer | Extend the range without advancing the review playhead |
| Clock skew | Keep source time and ingest sequence; avoid invented cross-source ordering |
| High-cardinality tools | Collapse, filter, expire, and enforce measured renderer budgets |
| Streaming steals context | Preserve viewport, selection, expansion, and pins; recenter only on request |
| Generic or misleading labels | Prefer source semantics; expose uncertainty; never invent specialist roles |
| Project or model remains absent | Newest-first discovery and bounded metadata bootstrap before tailing |
| Transcript content leaks into topology telemetry | Separate content plane, DTO, replay, and final masking gate |
| Symlink, rotation, or huge-file attack | Realpath containment, identity recheck, and byte/record limits |
| Slow transcript client | Bounded queue, gap/reset signal, ephemeral replay and cleanup |
| Redaction misses sensitive prose | Visible warning, server masking, collapsed detail, local-only transport |
| Tools overwhelm topology | Bound recent satellites and summarize older operations on their owner |
| Gesture ambiguity | Pointer capture, a drag threshold, visible controls, and keyboard equivalents |
| Adapter outage | Independent health state; other adapters continue |
| Local endpoint abuse | Existing loopback, Host, Origin, and Fetch Metadata protections |

## Delivery and acceptance

The implementation proceeds in seven independently testable milestones:

1. **Identity bootstrap:** newest-first discovery, Codex ledger hydration, bounded Claude/Codex
   metadata reads, and field-level provenance.
2. **Operational shell:** project/provider session cards, honest missing-data copy, summaries,
   and filters.
3. **Execution workspace:** agent/tool canvas, causal animation, direct manipulation, and shared
   selection.
4. **Live evidence rail:** isolated selected-session stream, redaction, search, auto-follow,
   unread state, and cross-highlighting.
5. **Project catalog and review:** project-first grouping, session history, deterministic
   play/pause/seek/speed, event markers, and live handoff.
6. **Ecosystem enrichment:** ruflo, dual-run, agentic-qe, skill, plugin, MCP, and tool adapters.
7. **Hardening and scale:** privacy, schema drift, reconnect, accessibility, load, aggregation,
   and stable direct manipulation.

Acceptance requires:

- an appended supported event is represented within two seconds under normal local load;
- retained transcript history for a selected local session appears within two seconds under
  normal local load, before a new append is required;
- authoritative parent-child edges appear when their source provides them;
- inferred and planned state is visibly distinct from observed state;
- graph snapshot and SSE payloads contain no prompt, response, tool argument, file content, or
  secret;
- the selected transcript stream contains rich masked, bounded DTOs and never encrypted reasoning;
- reconnect is duplicate-safe and either replays or explicitly resets;
- partial writes, rotation, child-before-parent, missing completion, and clock skew do not crash;
- pausing stops visual movement while ingestion continues;
- presence, meaningful work, and in-flight flow remain independently testable and visually
  distinct; heartbeats never activate all structural edges;
- pan, pointer-centred zoom, node drag/pin, fit, and reset work without losing live updates;
- automatic actor bundles do not intersect owned operation cards at the reference viewport, and
  actors and operation cards are independently draggable and pinnable;
- hover/focus help, click/keyboard detail, and the consultable legend explain each visible unit;
- streaming preserves viewport, selection, and manually positioned nodes;
- visible labels identify the semantic actor/capability and current safe operation when evidence
  supplies them, and visibly grade weaker identity;
- no bare `unknown`, raw UUID, raw action token, or generic kind is a primary label when safe
  semantic evidence exists;
- graph and transcript selection are synchronized in both directions;
- auto-follow stops when the reader scrolls away and reports unread entries;
- default topology contains agent anchors and bounded owned tool satellites;
- projects contain their sessions without collapsing same-ID sessions from different hosts;
- project session counts include navigation roots only; nested worker threads remain selectable;
- every retained root belongs to exactly one navigation scope; Live never falls back to History,
  History never includes a current root, and projects/counts include only the selected scope;
- an empty Live scope renders zero projects and zero sessions;
- History and Review emit no green current-work status, breathing presence, moving flow, or live
  follow/unread affordance; past running state uses historical copy and static styling;
- rollout-first, ledger-later evidence reparents a thread without duplicating or hiding it;
- replay at a timestamp is deterministic and does not mutate or execute source activity;
- an active review extends without stealing the playhead and can explicitly resume live;
- a 1440×900 reference fixture with one coordinator, three subagents, tools, messages, and
  completion fits all actors legibly while also showing current work, populated transcript,
  provider/project/session identity, and the docked timeline without page scrolling;
- active sessions require an unexpired observed presence lease or fresh meaningful activity in an
  active lifecycle; discovery-only, retained `running`, timestamp-less, unknown, quiescent, and
  expired sessions never claim to be live;
- disconnecting clients releases SSE listeners and the bounded idle stop releases collectors;
- historical usage and dashboard behavior remain compatible;
- unit, integration, privacy, accessibility, and synthetic load tests pass with `pnpm run check`.

## Implementation limitations

Acceptance does not imply automatic knowledge of every upstream store:

- normal `ak dashboard` auto-discovers Claude/Codex transcripts and observes top-level Claude Code,
  Codex, and OpenCode controller liveness; OpenCode transcript topology remains unavailable until a
  native adapter is added, and OpenCode is not a qe-court member until Agentic-QE supports and
  reports such routing; ruflo and agentic-qe require explicit, repeatable
  `--live-source 'surface=path'` registration;
- plugin, skill, MCP, and gate nodes appear only when a supported transcript or structured record
  emits them; there is no independent registry adapter for those surfaces;
- cardinality and UI behavior have regression coverage, but no formal measured frame-time budget
  has been recorded. The 80-node visible bound is therefore a defensive limit, not a measured
  rendering-capacity claim.

## Rejected alternatives

- **Poll the historical usage index faster:** wrong workload and no causal event semantics.
- **WebSockets first:** unnecessary bidirectional complexity for a read-only view.
- **Put transcript bodies in the graph stream:** creates accidental disclosure through snapshots,
  replay, logging, and broad subscriptions.
- **Reuse the historical whole-file reader as a live poller:** repeatedly parses large files and
  cannot provide bounded reconnect semantics.
- **A single global force layout:** causes drift and obscures causal hierarchy.
- **A fitted but non-interactive SVG:** makes dense graphs hard to inspect and prevents users from
  maintaining their own spatial context.
- **Label every delegated node “subagent”:** reports a storage kind, not who or what is working.
- **Copy Albert's console or styling:** incompatible licensing risk and inconsistent ak theme.
- **Show only authoritative relationships:** safer but hides useful evidence; graded provenance
  communicates uncertainty without discarding it.
- **Infer all topology from timestamps:** clock skew and concurrency make the result misleading.

[albert-license]: https://github.com/Sdraugel/albert/blob/96db73d06f64300bb4869fffede4541a9d0eb6e7/LICENSE.md
[albert-graph]: https://github.com/Sdraugel/albert/blob/96db73d06f64300bb4869fffede4541a9d0eb6e7/console/public/app.js#L1977-L2234
[agent-flow]: https://github.com/patoles/agent-flow
[agent-flow-source]: https://github.com/patoles/agent-flow/tree/84cd2fb8c704cefe52e6dd41a375c4069442e206
[d3-zoom]: https://d3js.org/d3-zoom
[dynamic-graphs]: https://doi.org/10.1111/cgf.12791
[eyes-have-it]: https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf
[graphics-aria]: https://www.w3.org/TR/graphics-aria-1.0/
[mental-map-review]: https://doi.org/10.1016/j.ijhcs.2013.08.004
[otel-genai]: https://github.com/open-telemetry/semantic-conventions-genai
[otel-semconv]: https://opentelemetry.io/docs/specs/semconv/
[sse]: https://html.spec.whatwg.org/multipage/server-sent-events.html
[stable-graphs]: https://doi.org/10.1177/1473871620972339
[wcag]: https://www.w3.org/TR/WCAG22/
[websocket]: https://datatracker.ietf.org/doc/html/rfc6455
