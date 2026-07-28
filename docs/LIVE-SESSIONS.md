# Live Sessions

The **Live** tab in `ak dashboard` is a read-only execution workspace for local
Claude and Codex activity. It pairs an interactive agent/tool canvas with the
selected session's streaming transcript. It is not a chat client or control
plane: it cannot send messages, cancel work, or reroute agents.

```bash
ak dashboard

# Optional structured telemetry; repeat the option for multiple files.
ak dashboard \
  --live-source 'ruflo=.claude-flow/live-events.jsonl' \
  --live-source 'aqe=.agentic-qe/live-events.jsonl' \
  --live-source 'dual-run=.claude-flow/dual-run-events.jsonl'
```

Open `#live`, for example `http://127.0.0.1:7431/#live` — once the dashboard's
per-session token is already in the browser (auto-opened, or pasted once at
the token gate; ADR-0014), this deep link works on its own. Collection starts
lazily when the snapshot or event endpoint is first requested. Leaving the Live
tab closes that browser's event stream. After the last snapshot/SSE client
leaves, collectors stop after 30 seconds by default and restart on the next
request. Stopping the dashboard closes the live service and all clients.

## Reading the operations console

- Claude and Codex sessions discovered newest-first from their local JSONL
  stores and bootstrapped from bounded, metadata-only records.
- Project-first session cards with a provider glyph and text, model when
  reported, lifecycle, freshness, and a concise operational summary.
- Session, agent, sub-agent, tool, skill, plugin, MCP, and gate entities when a
  supported source record identifies them.
- Authoritative Codex parent/child edges from the Codex state ledger.
- Human-readable identity and current work: resolved agent or capability name,
  host/model, lifecycle, elapsed time, latest safe operation summary, and
  evidence confidence.
- Typed relationships whose accessible titles use verbs such as **spawned**,
  **delegated**, **invoked**, **returned**, **evaluated**, and **gated**.
- A semantic execution canvas with stable agent anchors and bounded tool,
  skill, plugin, MCP, and gate satellites attached to their owners.
- Animated active edges that make delegation, invocation, and return flow
  visible without turning every event into an equal-rank box.
- A persistent selected-session transcript rail containing rich, server-masked
  conversation, plaintext reasoning, tool inputs/results/errors, commands,
  patches, MCP/web activity, and subagent messages as the sources report them.
- Shared selection: choosing an agent filters the rail; choosing a tool opens
  its detail; transcript evidence remains tied to its actor.
- Keyboard-selectable nodes, host/completed filters, reduced-motion support,
  actor-specific geometry, and a **Pause live** control.
- Sanitized adapter health showing status and aggregate file/event/error counts.

The overview answers which project/provider is involved, whether the evidence
is current, who is active, and what operation is happening now. Selecting a
node highlights adjacent relationships, focuses its work, and synchronizes the
transcript. Search filters the current stream. Auto-follow yields when the
reader scrolls away and reports unread activity until following resumes. The
transcript is newest-first: fresh evidence appears at the top and older entries
flow downward. Follow anchors to the top; playback remains chronologically
ordered internally.

Projects are the durable top-level grouping. Select a project first, then one
of its provider-qualified root sessions; currently active sessions appear
before recent completed sessions. Selecting a root reveals its agent/worker
threads as an indented hierarchy. Those child threads remain selectable for
their own map, transcript, and playback, but do not inflate the project's
top-level session count. The project row reports nested workers separately.
Claude and Codex sessions with the same native ID remain distinct.

Linked Git worktrees roll up to their owning repository. A branch-named
worktree is session context, not a separate project, and its filesystem path is
never sent to the browser.

Hierarchy may arrive after a thread is first discovered. The dashboard
reconciles later Codex ledger parentage into the existing session instead of
showing a second peer row. If a declared parent is not currently retained, the
thread remains visible as an orphan root until the parent appears; malformed
cycles are bounded and cannot lock the browser.

Bare `unknown` is not used as user-facing copy. Missing facts are described
honestly, such as **Model not reported**, **Waiting for lifecycle evidence**,
**Active; completion unobserved**, or **Task details unavailable**.

Session state is phrased as evidence a person can act on:

- **Working now** means fresh observed execution is still arriving and is the
  only state that continuously pulses.
- **Waiting for activity** means a previously running session is quiet inside
  the quiescence window.
- **No recent activity** means that quiet period crossed the expiry threshold;
  it does not assert failure or completion.
- **Blocked**, **Failed**, **Cancelled**, and **Completed** require explicit
  source evidence.
- **Last active** identifies retained historical evidence when no trustworthy
  completion outcome was recorded.

Color and motion are redundant cues: green motion means current work, amber
means waiting/stale/queued, red means blocked/failed, and completed history
recedes. Reduced-motion mode keeps the labels and colors while removing pulse
and flow animation.

Selecting a session explicitly opens only that session's content stream. The
previous stream closes; other transcripts are not prefetched. Large thinking,
arguments, results, and patches are collapsed for readability and carry
visible truncation metadata when bounded.

### Live and review modes

An active session opens in **Live** mode and follows new topology and transcript
evidence. **Review session** loads its bounded retained history and reconstructs
both panes at one playhead. The review bar supports play, pause, seek, and
0.5×–2× playback. **Resume live** returns an active session to its current
stream; completed sessions remain review-only.

Review is event reconstruction, not a screen recording. The server returns
chronological, masked evidence and the browser rebuilds the execution map and
transcript at each event boundary. The
`GET /api/live/playback/:host/:id?at=<elapsed-ms>` endpoint supports
deterministic server-side seeking and reports its retained range, truncation,
and any history gap.

### Navigating the graph

- Drag empty canvas space to pan. Use a wheel or trackpad scroll gesture to zoom
  around the pointer.
- Drag a node to move and pin it without changing the observed topology.
- Use the visible **Zoom in**, **Zoom out**, **Fit all**, **Focus**, and
  **Reset layout** controls when pointer gestures are unavailable or imprecise.
- Select a session to show its work map. Completed high-cardinality resource
  calls are summarized automatically.
- Keyboard users can traverse selectable nodes, synchronize transcript detail,
  and operate every viewport control. Reduced-motion mode removes decorative
  transitions without removing status or topology.

Live updates preserve the user's viewport, node positions, and selection during
the active page. A new off-screen event does not forcibly
recenter the canvas. **Fit** changes the camera to include the current map,
**Focus** centers the selected actor, and **Reset layout** discards manual node
positions and restores the deterministic automatic layout.
**Pause live** freezes visual application while collection continues.

The graph displays at most 80 nodes for one selected session. Completed resource
nodes are collapsed first. The server retains at most 100 sessions and 1,000
nodes per session by default, tails at most 256 files, and retains 2,000 events
for resume. These are implementation bounds, not claims about the number of
agents the underlying tools can run. Explicit `--live-source` files receive
tailer slots first; Claude and Codex automatic discovery divide the remaining
capacity.

## Evidence and limitations

| Source | Current coverage | Confidence |
|--------|------------------|------------|
| Claude transcript | Session lifecycle, assistant/tool activity, and explicit sidechain markers supported by the adapter | Observed or correlated according to the record |
| Codex rollout | Session, response/tool lifecycle, model, and explicit rollout metadata | Observed |
| Codex state ledger | Parent-to-child spawn edges | Observed |
| Ruflo / agentic-qe | Conservative adapter for an explicitly supplied structured JSONL source | Observed as reported by that source |
| Dual run | Planned steps from explicit `dual-run.plan` JSONL records | Planned |

The default dashboard automatically discovers only Claude and Codex transcript
files and reads the Codex state ledger. It does **not** search arbitrary ruflo,
agentic-qe, plugin, skill, or dual-run stores. Register a structured source
explicitly with repeatable `--live-source 'surface=path'`, where `surface` is
exactly `ruflo`, `aqe`, or `dual-run`.

Relative paths resolve from the directory where `ak dashboard` starts; absolute
paths remain absolute. The parser rejects an unsupported/missing surface or an
empty path, but registration does not prove that the file exists, is a regular
file, is inside the current project, or is produced by the named subsystem.
Unreadable/malformed sources degrade their adapter rather than crashing the
dashboard. Only register a local file you trust the dashboard process to read.
The structured adapter still constructs allowlisted events, so arbitrary JSON
fields do not pass through to the browser.

The diagram is a bounded current-state projection, not a durable audit log.
Silence changes a session's projection lifecycle to quiescent after 30 seconds
and expired after five minutes; it does not claim successful completion.
Source timestamps are preserved, but the event cursor records ingestion order
and does not establish causality across clocks.

Names and work summaries are evidence-graded. A source-provided role or tool
name is preferred. When the source exposes only a generic kind, the UI says
that the identity is generic or inferred; it does not invent a specialist
name. “Running” means that supported lifecycle evidence is open and fresh, not
that the dashboard has inspected an agent's private reasoning.

## Privacy

The topology plane is constructed from an allowlist and contains no transcript
bodies. The separately selected content plane intentionally carries rich local
evidence. It parses provider records into a bounded DTO, masks every emitted
string server-side, and never emits Codex `encrypted_content`. Secret masking
is best effort, not a guarantee; only run the dashboard where its local
transcripts may be viewed.

Transcript lookup validates both host and session ID, resolves the real file
beneath the configured provider root, rejects symlink escapes, and rechecks
containment after replacement. Content responses are `no-store`, same-origin,
bounded, and destroyed after their last subscriber.

Run the dashboard only for users who may see local project and model names.
It binds to `127.0.0.1`, applies Host, Origin, and Fetch Metadata checks, and
does not support remote binding.

## Streaming and recovery

The browser obtains a snapshot from `GET /api/live` and subscribes to
`GET /api/live/events`. The latter is a Server-Sent Events stream with:

- named `init`, `delta`, and `reset` events;
- event IDs and `Last-Event-ID` replay;
- a 15-second heartbeat by default;
- subscription-before-snapshot initialization to close the startup race;
- a default maximum of 32 clients, clamped to 256;
- a per-client server queue of 256 frames, clamped to 4,096.

If replay history is no longer retained, initialization carries `reset: true`
and a current snapshot. If a slow client's server queue overflows, queued
frames are discarded and replaced with a reset snapshot after the socket
drains. While the UI is paused it buffers 256 updates; overflow causes a
snapshot reload on resume.

The browser's native `EventSource` reconnects automatically. A stale indicator
means no telemetry has arrived for 30 seconds; it does not necessarily mean the
connection failed.

The selected transcript uses
`GET /api/live/transcripts/:host/:id/events`, a separate SSE stream with bounded
history/replay and a per-client queue. A stale or cross-session cursor produces
a bounded reset; a slow client receives an explicit gap instead of an
unbounded content snapshot.

## Troubleshooting

| Symptom | Explanation |
|---------|-------------|
| No sessions | No supported metadata was found within the bounded newest-first discovery set |
| Many identical provider session rows | Refresh after the current snapshot reconciles ledger hierarchy; root sessions and nested worker threads are counted separately |
| Worker thread appears at top level | Its declared parent is not currently retained, so it remains navigable as an orphan rather than hiding evidence |
| Ruflo or AQE absent | Their stores are not auto-discovered; register each JSONL file with `--live-source` |
| Project name not reported | No supported metadata supplied a working directory; raw paths are never sent to the browser |
| Node disappeared | Server projection or client visibility bounds evicted/collapsed it |
| Connection interrupted | `EventSource` retries; a cursor miss or buffer overflow resets from a snapshot |
| `503 too many live telemetry clients` | The configured concurrent-client bound has been reached |
| Graph moved while streaming | Existing positions should remain stable; **Reset layout** discards manual positions |
| Transcript unavailable | The selected session cannot be resolved safely beneath its host root |
| Detail truncated | The source value exceeded a content bound; the UI reports the original/shown size |
| Task details unavailable | The topology source did not provide role/task metadata; inspect the selected transcript for available evidence |

Implementation and rationale are documented in
[ADR-0012](adr/0012-live-sessions-observability.md) and the
[domain design](ddd/live-sessions.md).

## Design references

The information architecture was independently informed by Albert and Agent
Flow. Agent Flow's stable agent anchors, owned tool cards, causal movement, and
synchronized transcript informed the execution grammar; agentic-kit's
project-first, cross-host identity and isolated content plane are its own
design. No project branding or assets are copied. See the clean-room decision
in [ADR-0012](adr/0012-live-sessions-observability.md) and the
[Agent Flow source](https://github.com/patoles/agent-flow).

The interaction model follows the established “overview first, zoom and
filter, then details on demand” guidance for network visualizations
([Shneiderman][eyes-have-it]) and direct-manipulation viewport conventions
documented by [D3 zoom][d3-zoom]. Stable incremental placement is intentional:
dynamic-graph research finds that unnecessary movement makes visual search
harder, while also cautioning that stability must serve the user's task
([Di Giacomo et al.][stable-graphs],
[Archambault and Purchase][mental-map-review]).

[d3-zoom]: https://d3js.org/d3-zoom
[eyes-have-it]: https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf
[mental-map-review]: https://doi.org/10.1016/j.ijhcs.2013.08.004
[stable-graphs]: https://doi.org/10.1177/1473871620972339
