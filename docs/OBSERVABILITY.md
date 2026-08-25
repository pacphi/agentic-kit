# Observability

The **Observability** tab in `ak dashboard` is an observation-only execution workspace for local
Claude Code, Codex, and OpenCode activity. It cannot steer or mutate an agent or repository. It
does retain a small owner-only file of sanitized workspace snapshots so the last recorded branch
and tracked change counts remain available in History. It pairs an interactive agent/tool
canvas with the selected session's evidence when that host supplies it. It is
not a chat client or control plane: it cannot send messages, cancel work, or
reroute agents.

```bash
ak dashboard

# Optional structured telemetry; repeat the option for multiple files.
ak dashboard \
  --live-source 'ruflo=.claude-flow/live-events.jsonl' \
  --live-source 'aqe=.agentic-qe/live-events.jsonl'
```

> [!NOTE]
> `--live-source` is opt-in, not required. Without it, supported Claude and Codex
> transcript evidence is auto-discovered and top-level Claude Code, Codex, and
> OpenCode process presence is observed. What you don't get: ruflo and agentic-qe activity, which are never
> auto-discovered and only appear once you register their event file
> explicitly (see [Evidence and limitations](#evidence-and-limitations)).

Open `#observability/live` or `#observability/history`, for example
`http://127.0.0.1:7431/#observability/live` — once the dashboard's per-session token is already in
the browser (auto-opened, or pasted once at the token gate; ADR-0014), these deep links work on
their own. The Observability choices occupy the same fixed, left-aligned secondary rail used by
Overview and Usage; see the [Dashboard guide](DASHBOARD.md). Collection starts
lazily when the snapshot or event endpoint is first requested. Leaving the Observability
tab closes that browser's event stream. After the last snapshot/SSE client
leaves, collectors stop after 30 seconds by default and restart on the next
request. Stopping the dashboard closes the live service and all clients.

Model lifecycle is a separate read model under **Usage → Models**. It may consume bounded model ids
already derived by the historical usage index, but it never consumes live transcript content
or changes Observability state. Catalogue collection remains explicit through `ak models refresh`;
see [Model lifecycle intelligence](MODELS.md).

## Read Observability in 30 seconds

Observability has two navigation modes:

- **Live** is the default. It shows only projects with a root session that has an unexpired process
  presence lease or fresh meaningful activity. If none qualify, it shows **0 projects**.
- **History** shows only projects with at least one retained non-live root session. It never carries
  a current selection, live status, or motion across from Live.

Switching modes clears the incompatible project/session selection and chooses only inside the new
scope. Project, session, and worker counts always describe visible rows in that scope.

The three columns answer three different questions:

1. **Projects and sessions:** where is work happening, on which execution host, and is it working,
   merely present, quiet, completed, or unsupported?
2. **Agent activity:** who owns the work, which operation is in flight, and how are actors related?
3. **Session Stream:** what transcript or review evidence supports the selected session and actor?

Start by choosing a project, then a session. Select any actor or operation for persistent detail.
Hover or focus it for a short description. Open **Legend / Help** whenever a shape or animation is
unclear. Drag empty space to pan; drag an actor or operation card to pin it; double-click that item
to restore its automatic position. **Reset layout** restores every item in the selected session.

### What each unit represents

| Unit | Meaning | What to do with it |
|------|---------|--------------------|
| Project row | Sanitized repository grouping sessions across hosts | Select it to enter its session history |
| Root session row | One top-level Claude Code, Codex, or OpenCode controller/thread | Select it to load its map and supported evidence |
| Working tree at capture | Branch, meaningful non-root relative directory, and tracked `+ / −` lines versus `HEAD` at the recorded time; the project heading supplies repository identity | Select the session for capture time, source, confidence, and completeness; never read it as agent attribution |
| Indented child session | Real independently addressable thread, currently evidenced by the Codex ledger | Select it for its own map, transcript, and playback |
| Indented worker view | Claude sidechain actor contained by the parent session, not a fabricated session | Select it to focus that actor in the parent map/evidence |
| Large ring/hex anchor | Session coordinator, agent, subagent, or quality gate | Select for detail; drag to pin; double-click to unpin |
| Work bubble | Actor's most recent meaningful allowlisted activity | Read it as evidence, not a prompt or hidden reasoning trace |
| Operation card | Tool, skill, plugin, or MCP operation owned by an actor | Select for safe metadata; drag independently when crowded |
| Solid relationship | Static containment, delegation, or planned/observed topology | Hover/focus to inspect its evidence; no movement means no flow claim |
| Moving dashed relationship | Explicitly started, unfinished operation or relationship | Follow it to see where live activity is flowing now |
| Presence halo | The controller process was observed recently | Slow breathing means present; it does not mean working |
| Status dot/pulse | Meaningful current work or explicit outcome | Use its text label; color and motion are redundant cues |
| Earlier operations chip | Count of completed operation cards collapsed for readability | Review the transcript/timeline for earlier detail |
| Session Stream rail | Masked transcript or deterministic review for the selected session | Search, follow, filter by selected actor, enter Review, or collapse the rail to give Agent activity more room |

The **Live / History** filter is a hard boundary. A mixed project can appear in both modes, but each
appearance counts and reveals only roots from that mode. A live-only project never appears as an
empty History project. Historical rows never fill an empty Live mode.

### Motion has one meaning at a time

- A **slow breathing halo** means the process is present.
- A **work pulse** means meaningful current activity is evidenced.
- A **moving dashed line** means that specific operation is started and unfinished.
- A **solid line** is structural. It never starts moving merely because one endpoint is working.
- **History and Review are inert.** They show no green current-work dot, pulse, breathing presence
  halo, moving dash, flow particle, live-follow control, or unread-live alert. Completed history is
  neutral; an explicit historical failure may remain static red.
- **Pause** stops stream application plus CSS/SVG movement. Reduced-motion mode removes
  nonessential animation while preserving labels, status, and topology.

## Reading the operations console

- Claude and Codex sessions discovered newest-first from their local JSONL
  stores and bootstrapped from bounded, metadata-only records.
- Project-first session cards with a host glyph and name, independently
  evidenced inference provider/model when reported, lifecycle, freshness, and
  a concise workspace summary. The Claude Code, Codex, and OpenCode glyph identifies the execution
  host; adjacent text remains authoritative and the glyph never substitutes for inference-provider
  evidence. Provider identity is graded (ADR-0021):
  observed from Codex artifacts (`model_provider`), configured/inferred from
  Claude Code's documented selection surface (Bedrock, Vertex, Foundry,
  `ANTHROPIC_BASE_URL` gateways such as OpenRouter) as soon as a transcript or
  runtime lease supplies the session working directory, and "Provider not
  established" only when no evidence of any grade exists.
- A compact **working tree at capture** line: a non-root repository-relative directory when it
  adds context, a branch icon and branch or detached-revision name, and tracked `+ / −` line
  counts when Git reports them. The selected project heading already owns the repository name,
  so session rows do not repeat it or display the unhelpful `repo root` label.
  These counts describe the shared checkout versus `HEAD`, not changes authored by that session.
  Untracked content and binary line counts are excluded. Missing Git evidence is omitted rather
  than displayed as zero.
- Session, agent, sub-agent, tool, skill, plugin, MCP, and gate entities when a
  supported source record identifies them.
- Authoritative Codex parent/child edges from the Codex state ledger.
- Human-readable identity and current work: resolved agent or capability name,
  host, provider/model, lifecycle, elapsed time, latest safe operation summary,
  and evidence confidence. Internal sentinel models such as `<synthetic>` are
  replaced by freshness context; containment is described as **Worker linked**.
- Typed relationships whose accessible titles use verbs such as **spawned**,
  **delegated**, **invoked**, **returned**, **evaluated**, and **gated**.
- A semantic execution canvas with stable agent anchors and bounded tool,
  skill, plugin, MCP, and gate satellites attached to their owners.
- Animated edges only for explicitly started, unfinished flow; presence and endpoint work never
  animate every structural relationship.
- A connected, collapsible selected-session transcript rail containing rich, server-masked
  conversation, plaintext reasoning, tool inputs/results/errors, commands,
  patches, MCP/web activity, and subagent messages as the sources report them.
- Shared selection: choosing an agent filters the rail; choosing a tool opens
  its detail; transcript evidence remains tied to its actor.
- Keyboard-selectable nodes, reduced-motion support, actor-specific geometry, a consultable
  **Legend / Help**, evidence-aware tooltips, and a **Pause live** control.
- Sanitized adapter health showing status and aggregate file/event/error counts.

The overview answers which project and host are involved, which inference
provider is evidenced, whether the evidence is current, who is active, and
what operation is happening now. Selecting a
node highlights adjacent relationships, focuses its work, and synchronizes the
transcript. Search filters the current stream. Auto-follow yields when the
reader scrolls away and reports unread activity until following resumes. The
transcript is newest-first: fresh evidence appears at the top and older entries
flow downward. Follow anchors to the top; playback remains chronologically
ordered internally.

Projects are the durable top-level grouping. Select a project first, then one
of its host-qualified root sessions. Live and History are intentionally separate; historical rows
never fill an empty Live mode. Selecting a root reveals its agent/worker
evidence as an indented hierarchy. A Codex ledger child is a real independently
addressable session with its own supported map, transcript, and playback. A
Claude sidechain is a selectable **worker view** of an actor contained by the
parent; it does not claim a child session or content endpoint that Claude
evidence has not supplied. Neither inflates the project's top-level session
count. The project row reports real nested sessions separately.
Claude and Codex sessions with the same native ID remain distinct.

Linked Git worktrees roll up to their owning repository. A branch-named
worktree is session context, not a separate project, and its filesystem path is
never sent to the browser. Multiple sessions may point at the same checkout, so branch and diff
counts are context—not attribution. In Live, the line is the newest safe capture; in History it is
explicitly the last recorded snapshot. History never queries today's checkout and presents it as
past state.

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
- **Process active · quiet** means a runtime lease proves the controller exists, while no
  meaningful activity is currently evidenced; only its slow presence halo breathes.
- **Waiting for activity** means a previously running session is quiet inside
  the quiescence window.
- **No recent activity** means that quiet period crossed the expiry threshold;
  it does not assert failure or completion.
- **Blocked**, **Failed**, **Cancelled**, and **Completed** require explicit
  source evidence.
- **Last active** identifies retained historical evidence when no trustworthy
  completion outcome was recorded.

Color and motion are redundant cues: **green anywhere in the session browser or execution map means
current Live work**. Retained and reviewed activity never uses green, even if an old event was
recorded as `running`. Review uses neutral or amber styling and past-tense labels. Explicit failure
remains static red. Reduced-motion mode keeps labels and topology while removing pulse and flow.

Selecting a session explicitly opens only that session's content stream. The
previous stream closes; other transcripts are not prefetched. Large thinking,
arguments, results, and patches are collapsed for readability and carry
visible truncation metadata when bounded.

### Collapse or restore Session Stream

The chevron in the **Session Stream** header collapses or expands the evidence rail. Collapsing is
presentation-only: the selected transcript stream stays connected, new evidence continues to be
ingested, and **Agent activity** receives the released horizontal space. It is not the same as
**Pause stream**, which freezes visual application of Live deltas.

The collapse choice is stored locally and restored on later dashboard visits. In the collapsed
state, a compact rail remains visible so the chevron is always available to restore the stream. On
narrower screens the rail stacks below the project browser and Agent activity; when collapsed it
becomes a compact full-width restore bar instead of retaining transcript height.

The chevron is keyboard-operable with Enter or Space. Its accessible label, tooltip, and
`aria-expanded` state change with the action, and a polite status message announces whether Session
Stream was collapsed or expanded.

### History and Review are different

**History** is a navigation mode: it decides which retained sessions are available. **Review** is a
playback mode: it reconstructs one selected session at a playhead. A currently Live session may
enter Review without moving into History. Review never reactivates old presence, pulses old work,
or animates an old relationship as current traffic. Choose **Live** or **History** from the
secondary tab row directly beneath the main Observability tab; the Left/Right, Home, and End keys
also move between these two views when the tab row has focus. Their canonical hashes are
`#observability/live` and `#observability/history`.

### History loading, pagination, and coverage

History is loaded newest-first in bounded pages. The browser requests an initial page of up to
100 sessions, automatically asks for the next opaque continuation token as the list approaches
its sentinel, and keeps a visible **Load older sessions** fallback when automatic loading is not
available. The project browser uses the server's full project metadata, so a page containing only
the newest sessions does not make a project's total look smaller than it is.

The server keeps the history scan separate from the live tailer. It discovers eligible Claude and
Codex transcript files by file modification time, materializes a stable short-lived snapshot, and
then pages that snapshot. Each paginated response reports `pagination.total`, `hasMore`, and an
opaque `nextPageToken`; `coverage` reports the per-host candidate/returned file counts, the file
limit, the scan time, and whether discovery was complete. An incomplete scan is disclosed in the
History view rather than presented as an authoritative empty or complete result.

This was added compatibly. `GET /api/live/history` without `limit`, `pageToken`, or `projectKey`
continues to return the pre-pagination snapshot shape. Clients that understand pagination opt in
with those query parameters and receive the same snapshot fields plus additive `pagination` and
`coverage` fields. Continuation tokens are short-lived and scoped to their project/window snapshot;
an expired or malformed token returns `400` so a client can restart from the first page.

### Live and Review playback

An active session opens in **Live** mode and follows new topology and transcript
evidence. **Review session** loads its bounded retained history and reconstructs
both panes at one playhead. The review bar supports play, pause, seek, and
0.5×, 1×, 1.5×, 2×, 5×, and 10× playback. **Resume live** returns an active session to its current
stream; completed sessions remain review-only. The bar is reserved beneath the
execution map in History or Review, so it cannot cover nodes or map guidance.
During ordinary Live viewing it is hidden unless the selected active session
supports a concise **Review session** action.

Review is event reconstruction, not a screen recording. The server returns
chronological, masked evidence and the browser rebuilds the execution map and
transcript at each event boundary. The
`GET /api/live/playback/:host/:id?at=<elapsed-ms>` endpoint supports
deterministic server-side seeking and reports its retained range, truncation,
and any history gap.

### Navigating the graph

- Drag empty canvas space to pan. Use a wheel or trackpad scroll gesture to zoom
  around the pointer.
- Drag an actor or individual operation card to move and pin it without changing the observed
  topology. Its labels and connected edges move with it.
- Use the visible **Zoom in**, **Zoom out**, **Fit all**, **Focus**, and
  **Reset layout** controls when pointer gestures are unavailable or imprecise.
- Select a session to show its work map. Completed high-cardinality resource
  calls are summarized automatically.
- Hover or focus an actor/operation for a short description. Click, Enter, or Space opens
  persistent selection detail. **Legend / Help** explains every visual cue and gesture.
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
| OpenCode runtime | Top-level controller presence plus inspectable workspace context; detailed activity, hierarchy, transcript, and playback are not reported yet | Observed presence/workspace |
| Ruflo / agentic-qe | Conservative adapter for an explicitly supplied structured JSONL source; reported court leader/seat hosts remain independent | Observed as reported by that source |

Agentic-QE court membership and native session hierarchy are separate. When AQE evidence reports a
Claude-led court with a Codex seat, or the reverse, the map may show those cross-host actors within
the court without reparenting their native sessions. OpenCode is not shown as a court member because
Agentic-QE cannot currently configure OpenCode-routed court models. The dashboard will not infer a
seat from an OpenCode process heartbeat.

The default dashboard automatically discovers Claude and Codex transcript files, observes
supported controller processes, and reads the Codex state ledger. On macOS and Linux,
process discovery is selected by the real numeric UID running the dashboard. It first reads
only PID/parent/start/command columns, then requests full argv only for Node or known
host-controller candidates from that selection. Separate OS accounts are outside the
intended survey; people sharing one login, a service running under that account, and a
container sharing the host PID namespace remain inside the same numeric-UID boundary.
Do not run the dashboard with `sudo`. Windows runtime process discovery is unsupported,
and missing/restricted `ps`, `lsof`, or `/proc` degrades runtime presence without removing
retained transcript/history evidence. The argv lookup is a second process-table query; a PID
could theoretically be reused between selection and lookup, so current-UID selection is a
least-privilege reduction rather than a hard isolation boundary. It does **not** search arbitrary
ruflo, agentic-qe, plugin, or skill stores. Register a structured source
explicitly with repeatable `--live-source 'surface=path'`, where `surface` is
exactly `ruflo` or `aqe`.

Relative paths resolve from the directory where `ak dashboard` starts; absolute
paths remain absolute. The parser rejects an unsupported/missing surface or an
empty path, but registration does not prove that the file exists, is a regular
file, is inside the current project, or is produced by the named subsystem.
Unreadable/malformed sources degrade their adapter rather than crashing the
dashboard. Only register a local file you trust the dashboard process to read.
The structured adapter still constructs allowlisted events, so arbitrary JSON
fields do not pass through to the browser.

Historical persisted events from the pre-GA executor normalize to the read-only
`internal` surface so retained evidence is not mislabeled as native. No current
writer or `--live-source` parser accepts the retired label.

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
evidence. It parses source records into a bounded DTO, masks every emitted
string server-side, and never emits Codex `encrypted_content`. Secret masking
is best effort, not a guarantee; only run the dashboard where its local
transcripts may be viewed.

Transcript lookup validates both host and session ID, resolves the real file
beneath the configured host transcript root, rejects symlink escapes, and rechecks
containment after replacement. Content responses are `no-store`, same-origin,
bounded, and destroyed after their last subscriber.

Workspace context is a separate metadata-only snapshot. The collector may persist an opaque
workspace key, sanitized repository and repository-relative directory labels, a bounded and
secret-masked branch label, numeric tracked additions/deletions/file counts, capture time, source,
and confidence. It never persists an absolute working directory, filename, patch, prompt, command,
tool input, or tool result. The owner-only snapshot file is
`observability-workspaces.json` under agentic-kit's local config directory and is advisory: a write
failure degrades retention without stopping Live observation.

Run the dashboard only for users who may see local project and model names.
It binds to `127.0.0.1`, applies Host, Origin, and Fetch Metadata checks, and
does not support remote binding. Those checks stop a hostile *browser tab*;
they do nothing against another *local, non-browser process* that can reach
the port directly. That gap is closed by the per-session token (ADR-0014):
every `/api/*` route — including both SSE streams above — requires it, so a
process without the token gets a `401`, not transcript content.

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
| History says the scan is incomplete | The per-host discovery bound was reached; older files may not be represented, so widen the configured source or rerun after reducing the corpus |
| Live shows 0 projects | No retained root currently satisfies the Live predicate; switch to History for past sessions |
| History shows 0 projects | No retained non-live root exists; current work, if any, remains in Live |
| Green or moving content appears in History | This violates the Observability contract; refresh, then report it as a presentation defect if it remains |
| A History project opens with no sessions | This violates scope-local project filtering; refresh, then report it as a defect |
| Many identical host session rows | Refresh after the current snapshot reconciles ledger hierarchy; root sessions and nested worker threads are counted separately |
| Worker thread appears at top level | Its declared parent is not currently retained, so it remains navigable as an orphan rather than hiding evidence |
| Ruflo or AQE absent | Their stores are not auto-discovered; register each JSONL file with `--live-source` |
| Project name not reported | No supported metadata supplied a working directory; raw paths are never sent to the browser |
| Node disappeared | Server projection or client visibility bounds evicted/collapsed it |
| Connection interrupted | `EventSource` retries; a cursor miss or buffer overflow resets from a snapshot |
| `503 too many live telemetry clients` | The configured concurrent-client bound has been reached |
| `401` on any `/api/*` request | Missing or wrong per-session token; reopen the dashboard's launch URL, or paste the token printed at startup |
| Graph moved while streaming | Existing positions should remain stable; **Reset layout** discards manual positions |
| A line is solid, not moving | It is structural or completed; moving dashes require specific in-flight evidence |
| Session says “Process active · quiet” | The controller exists, but no meaningful work event is currently evidenced |
| OpenCode has no tools or transcript | Only runtime presence is available; the shared shell explains unsupported detail |
| Branch or `+ / −` counts are missing | Git was unavailable, the checkout had no usable `HEAD`, or that fact was never captured; the UI does not invent zero |
| Historical workspace looks old | History shows the last bounded snapshot recorded for that session, not the checkout's current state |
| Claude worker has no separate transcript row | It is an actor lens within the parent session, unlike a ledger-backed Codex child |
| qe-court does not show OpenCode seats | Agentic-QE cannot currently configure OpenCode-routed court models; Observability does not fabricate them |
| Transcript unavailable | The selected session cannot be resolved safely beneath its host root |
| Detail truncated | The source value exceeded a content bound; the UI reports the original/shown size |
| Task details unavailable | The topology source did not provide role/task metadata; inspect the selected transcript for available evidence |

Implementation and rationale are documented in
[ADR-0012](adr/0012-observability.md) and the
[domain design](ddd/observability.md).

## Design references

Host marks identify third-party execution hosts and remain subordinate to adjacent text. The
OpenAI/Codex row uses OpenAI's official monochrome Blossom geometry, and the OpenCode row uses the
official dark square “O” asset. Those marks remain property of their owners and are used only to
identify the directly related service. See the [OpenAI design guidelines](https://openai.com/brand/)
and [OpenCode brand assets](https://opencode.ai/brand).

The information architecture was independently informed by Albert and Agent
Flow. Agent Flow's stable agent anchors, owned tool cards, causal movement, and
synchronized transcript informed the execution grammar; agentic-kit's
project-first, cross-host identity and isolated content plane are its own
design. No Albert or Agent Flow branding or assets are copied. See the clean-room decision
in [ADR-0012](adr/0012-observability.md) and the
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
