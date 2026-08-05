# ADR-0024 — Project intelligence: live learning telemetry from ruflo/agentic-qe's own state

- **Status:** Implemented
- **Date:** 2026-08-05
- **Updated:** 2026-08-05
- **Update note:** Extended Intelligence from one project's telemetry, implicitly tied to the
  dashboard server's own launching cwd, to a machine-wide catalog of every ruflo-initialized
  project plus an explicitly selected, explicitly labeled detail project (defaulting to
  most-recently-active). This is a deliberate clean-break redesign of `/api/status`'s `intel`
  payload shape, made because the project is still on the pre-release `4.0.0-alpha` line with no
  external compatibility guarantee — not a shape preserved for, or falling back to, the prior
  single-project form.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0005](0005-dashboard-in-page-routing-reveal.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0012](0012-observability.md)

**2026-08-05 machine-wide discovery amendment:** `src/lib/dashboard/project-discovery.mjs` adds
`discoverRuvfloProjects()`, unioning three sources into one deduplicated, most-recently-active-first
catalog of every project on this machine ruflo has genuinely initialized — a `.claude-flow/neural/`
subdirectory present, not merely a bare `.claude-flow/`. Source 1 reuses `registryWorkspaces()` from
`daemons.mjs` verbatim (imported, not reimplemented; given a bare `export` so it could be imported
at all — the one change made outside this new module) to walk
`~/.claude-flow/{ai-jobs.json,workspace-leases.json,repo-supervisors.json}`. Source 2
cross-references Observability's own `WorkspaceSnapshotStore`
(`~/.config/agentic-kit/observability-workspaces.json`, [ADR-0012](0012-observability.md)) for any
record carrying a resolvable absolute path. That store's own privacy sanitizers reject one on
write and on read — `repositoryLabel` rejects any path separator, `directoryLabel` rejects anything
absolute-looking — so source 2 is structurally empty by that store's own design, not a gap; the
defensive per-record check nonetheless stays in place rather than being removed, so it starts
contributing automatically if that schema ever grows a real path field. This cross-reference is
discovery-only: it never supplies evidence, confidence, or any value this domain renders, only a
candidate project path, preserving the reasoning in
["Why this is a separate context, not Observability"](../ddd/project-intelligence.md#why-this-is-a-separate-context-not-observability).
`intel-history.mjs` adds `readMachineWideIntel(projects)`, folding `readIntelHistory()` across
every discovered project into one `{ totals, perProject }` rollup. At machine scope, exactly as at
single-project scope, the lifetime patterns-learned counter and the pattern-store's current size
remain two distinct, never-conflated sums: `totals.patternsLearnedLifetime` sums each project's
cumulative `globalStats.patternsLearned`; `totals.patternStoreEntries` sums each project's current
`patternStore.length`. A project whose read turns up missing or malformed data degrades that
project's row to nulls/zeros rather than aborting the whole machine-wide scan.

**2026-08-05 discovery correction — real transcript content is source 3, and is the source that
actually matters in practice:** `daemons.mjs`'s own header comment assumes ruflo 3.28+ reliably
writes the central `~/.claude-flow/{ai-jobs,workspace-leases,repo-supervisors}.json` registry
files source 1 depends on. Verified against a real, actively-used development machine (ruflo
3.34.0): none of those three files exist, even though that machine has multiple real,
ruflo-initialized projects with populated `.claude-flow/neural/` trees, including a per-project
`.claude-flow/daemon.pid`/`daemon-state.json` proving a daemon genuinely ran there — so source 1
returned an empty set, and with source 2 structurally empty by design (above),
`discoverRuvfloProjects()` returned `[]` on a machine where the feature had real, correct data to
find. Source 3 fixes this: it reads real absolute `cwd` values directly out of Claude and Codex
transcript content under `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`, via
the exact `discoverJsonl()`/`bootstrapRecords()` functions `live-sessions-service.mjs` already
trusts for Observability — flat `record.cwd` for Claude, `record.payload.cwd` for Codex's
`session_meta`/`turn_context` records. Unlike source 2's persisted, privacy-sanitized registry,
raw transcripts are not sanitized and do carry a resolvable path — legitimately readable at this
trust boundary since it is the same user, same machine, and same files Observability itself
already parses. Bounded to the 150 most-recently-modified transcripts per host (`discoverJsonl`'s
own recency sort) so cost stays flat regardless of how many sessions a project has accumulated;
overlap with sources 1/2 dedups for free through the existing resolved-path merge. Verified on the
same real machine: `discoverRuvfloProjects()` now returns all 4 real ruflo-initialized projects in
under a second.

**2026-08-05 selectable delivery amendment:** This is a deliberate clean-break redesign of
`/api/status`'s `intel` payload, not a shape preserved for, or falling back to, the prior
single-project form — warranted because the project is still on the pre-release `4.0.0-alpha` line
with no external compatibility guarantee yet. The former flat top-level `health`/`globalStats`/
`patternStore`/`graph` fields are replaced by one nested `intel` object: `{ selectedProjectKey,
selectedProjectLabel, projects, health, globalStats, patternStore, graph, machineWide }`.
`projects` is the full machine-wide catalog (`{ key, label, path, source }` rows,
most-recently-active first); `machineWide` is always the full `readMachineWideIntel()` rollup,
independent of selection. Both `GET /api/status` and `GET /api/live/intelligence` accept the same
optional `?project=<key>` query parameter — `<key>` is the opaque `project:<16-hex>` form
`resolveProjectIdentity(path).key` emits, deliberately not `stableProjectKey`, which reduces its
input to a bare directory-name label before hashing and would collapse two same-named-but-different
projects onto one selection key — and resolve it through the identical shared
`resolveSelectedProject(projects, rawParam)` helper, so the two routes can never disagree about
what an absent or unresolvable key defaults to: `discoverRuvfloProjects()`'s own
most-recently-active-first sort, never the server's launching cwd. `GET /api/live/intelligence`
answers `503` if machine-wide discovery finds zero ruflo-initialized projects at all, rather than
picking anything. The prior server-wide singleton `IntelligenceWatch` is replaced by a small pool
keyed by resolved project path: a project's watcher is created lazily on its first SSE subscriber
and stopped and forgotten the moment its last subscriber for that project disconnects, so two
clients watching different projects never cross-talk and an unwatched project's watcher never runs
unbounded. **"This project" as an implicit, unlabeled, cwd-bound default no longer exists anywhere
in this contract** — the detail strip is always an explicitly selected, explicitly labeled project,
defaulting to whichever discovered project was most recently active.

## Context

Overview's **Intelligence** destination (`#overview/intelligence`, added by
[ADR-0005](0005-dashboard-in-page-routing-reveal.md)'s 2026-08-04 information-architecture
amendment) has always advertised "memory, learned patterns, quality feedback, and improvement
signals." Until now its "learning over time" strip rendered only two sparklines:

- **patterns learned**, sourced from `.claude-flow/health-history.json` — a ring `dashboard-server.mjs`
  itself appended to, and only while a dashboard happened to be running to observe
  `.claude-flow/neural/stats.json`. On a machine (or CI checkout) where the dashboard had never
  polled long enough to accumulate a ring, this file simply did not exist and the panel showed
  `no data`;
- **improvement Δpp**, sourced from the route-learner's existing `.claude-flow/improvement.json`
  (unchanged by this decision).

Meanwhile ruflo and agentic-qe were already writing two richer, always-present sources that the
dashboard never read: `.claude-flow/neural/patterns.json` (the neural pattern store — a live JSON
array of pattern entries, each carrying `createdAt`/`type`) and
`.claude-flow/data/intelligence-snapshot.json` (point-in-time samples of the reasoning/knowledge
graph's size: `nodes`, `edges`, `pageRankSum`). `src/commands/status.mjs`'s CLI `learning` row
already reads `.claude-flow/neural/stats.json` for the same lifetime `patternsLearned` counter the
health ring's samples happened to carry — but the *store's own current inventory* (how many
patterns are on disk right now, which shrinks under pruning/compaction even as the lifetime
counter only ever climbs) had no reader at all. The panel's "no data" state was therefore
avoidable, not fundamental: real trend data already existed on disk.

Separately, every value on this panel only ever refreshed on the dashboard's general ~30s
`/api/status` poll (the same cadence used for unrelated subsystem-health cards), so a user
actively watching learning happen — a pattern being stored, the graph growing — waited up to that
long to see it.

This telemetry is a different kind of fact than anything [ADR-0012](0012-observability.md)/
[Observability](../ddd/observability.md) models. It carries no session, actor, host, provider, or
model identity; no lifecycle (`queued → running → completed`); no per-field evidence confidence
(`observed`/`correlated`/`inferred`/`assumed`/`planned`); and no transcript content requiring
redaction. It is four scalar/array-shaped reads over this project's own `.claude-flow/` state —
the same local trust boundary `ak status` already reads directly, with no host-specific
anti-corruption adapter needed because there is only ever one shape, ak's own. The panel that
surfaces it also lives under **Overview**, not under **Observability**'s Live/History scope. The
implementation deliberately did not construct an `ObservedSession`, did not flow through the
canonical event normalizer, and did not extend the replay/snapshot cursor — it reuses only
source-agnostic transport plumbing (`JsonlTailer`, `sseChannel`, `reserveClientSlot`/`clientGone`,
`transcriptSseFrame`) that Dashboard delivery already shares across contexts.

## Decision

### 1. A new bounded context: Project intelligence

Project intelligence is its own bounded context (see the updated
[context map](../ddd/context-map.md) and [Project intelligence](../ddd/project-intelligence.md)),
not an Observability extension and not folded into ADR-0005's navigation-shell amendments. Its
model, invariants, and the reasoning for keeping it separate from `ObservedSession` are specified
in that document; this ADR records the decision and its consequences.

### 2. One read-only history module composes four existing sources

`src/lib/dashboard/intel-history.mjs` adds:

- `readNeuralPatternStoreHistory(cwd)` — every entry currently on disk in
  `.claude-flow/neural/patterns.json`, as `{ createdAt, type }`;
- `readGraphHistory(cwd)` — every sample in `.claude-flow/data/intelligence-snapshot.json`, as
  `{ timestamp, nodes, edges, pageRankSum }`;
- `readGlobalStats(cwd)` — the current cumulative counters in `.claude-flow/neural/stats.json`
  (`patternsLearned`, `trajectoriesRecorded`, `signalsProcessed`, `lastAdaptation`), reading via the
  same `readJson` helper and `?? 0` defaulting `status.mjs`'s `learning` row already uses, so the two
  call sites cannot drift apart;
- `readHealthRing(cwd)` and `appendHealthSnapshot(cwd, snapshot)` — moved (not duplicated) from
  `dashboard-server.mjs`, unchanged behavior, now capped at 500 samples with field-level dedup
  (a repeated poll of unchanged stats writes nothing);
- `readIntelHistory(cwd)` — the combinator `collectData()` and the SSE route both call, returning
  `{ patternStore, graph, healthRing, globalStats }`.

The **patterns-learned counter** (`globalStats.patternsLearned`, a lifetime total) and the
**pattern-store size** (`patternStore.length`, entries actually present right now) are
independent metrics that may legitimately diverge as the store is pruned or compacted. This
project's own repository demonstrates the divergence today: 28 live pattern-store entries against
a 1,337 lifetime counter. Every reader, doc comment, and rendered label keeps the two separate;
none averages, sums, or substitutes one for the other.

### 3. Push updates over a new SSE route, additive to the existing poll

`src/lib/live/intelligence-watch.mjs` adds `IntelligenceWatch`, which polls the three source files'
`mtime` every second (default), corroborated by a change-only tail of
`.claude-flow/data/pending-insights.jsonl` (via the existing `JsonlTailer`, whose line *contents*
are never read — a record arriving at all is the signal), and flushes a debounced
(2.5s trailing-edge, measured from the most recent detected change) `onUpdate(readIntelHistory(cwd))`
call. `dashboard-server.mjs` exposes this as `GET /api/live/intelligence`: one `event: init` frame
with the current `readIntelHistory(cwd)` on connect, then an `event: update` frame per flush,
fanned out to every connected client. It reuses Dashboard delivery's proven SSE discipline —
reservation-before-await client-cap tracking, the forwarding-cleanup idiom, `sseChannel` backpressure
and heartbeat — but sends `transcriptSseFrame` payloads, not `sseFrame`'s session-privacy-redacted
ones, because this payload was never session or transcript content in need of that redaction
pipeline.

`GET /api/live/intelligence` shares Dashboard delivery's transport primitives with, but is not part
of, [Observability](../ddd/observability.md)'s `/api/live`, `/api/live/events`,
`/api/live/transcripts/:host/:id/events`, and `/api/live/playback/:host/:id` family documented in
[OBSERVABILITY.md](../OBSERVABILITY.md); it is not covered by that document's evidence, privacy, or
capability-coverage contract, and unlike Observability's ruflo/agentic-qe sources, it requires no
`--live-source` registration — the four files it reads are always this project's own.

### 4. `/api/status` keeps working as the fallback path

The SSE route is additive. `collectData()`'s existing return gains `globalStats`, `patternStore`,
and `graph` alongside the unchanged `health` field (still `intel.healthRing`); a client without
`EventSource` support, or one that has not yet opened the stream, still gets the full picture on the
next poll. The `/api/status` error-fallback payload was extended with the same three keys
(`globalStats: null, patternStore: [], graph: null`) so its shape never diverges from the success
path.

## Consequences

### Positive

- The Intelligence panel shows real trend data — pattern-store growth and reasoning-graph growth —
  sourced from files that already existed, at zero new collection cost and no new write path beyond
  the existing, now-relocated `appendHealthSnapshot`.
- Users watching active learning see updates within the debounce window (≤ ~3.5s) instead of waiting
  out the general status poll.
- The lifetime-counter-vs-store-size divergence is now visible and labeled instead of silently
  absent or conflated.
- A genuinely different domain got its own bounded context instead of stretching
  `ObservedSession`'s Session/Actor/Activity model, or ADR-0005's navigation-shell decision, to cover
  facts neither was designed to grade.

### Negative

- A second `/api/live/*`-prefixed SSE endpoint and client-cap surface to operate, alongside
  `/api/live/events` and `/api/live/transcripts/...`.
- `mtime`-based polling can in principle miss two rewrites that land on the same filesystem-reported
  millisecond; the `pending-insights.jsonl` tail is a second, independent trigger but not a formal
  guarantee.
- No per-field confidence grading exists for this data, unlike Observability's evidence model —
  accepted because every source is this project's own local file, not another host's evidence
  requiring provenance.

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Pattern-store size and the lifetime counter get conflated in a future edit or display | Documented domain invariant, shared header comment across both modules, and separate rendered figures with distinct captions |
| Debounce coalesces a burst into a stale window | Trailing-edge debounce measured from the most recently detected change, not a fixed interval |
| A reader is called on this project's own untrusted-shaped JSON (a partially written file, a schema drift) | Malformed or non-array data degrades to `[]`/`null`, matching `readJsonSafe`'s existing null-on-absent convention; individual malformed entries are skipped rather than throwing |
| New SSE route reintroduces a client-cap race | Reuses the same `reserveClientSlot`/forwarding-cleanup idiom already hardened for `/api/live/events` |
| Readers drift from `status.mjs`'s CLI `learning` row over time | `readGlobalStats` calls the same `readJson` helper and `?? 0` default `status.mjs` uses, not a hand-copied reimplementation |

## References

- `src/lib/dashboard/intel-history.mjs` (`readIntelHistory`, `readMachineWideIntel`),
  `tests/kit/intel-history.test.mjs`
- `src/lib/dashboard/project-discovery.mjs` (`discoverRuvfloProjects`),
  `tests/kit/project-discovery.test.mjs`
- `src/lib/live/intelligence-watch.mjs`, `tests/kit/intelligence-watch.test.mjs`
- `src/lib/dashboard-server.mjs` (`collectData`, `buildProjectSnapshotCache`,
  `resolveSelectedProject`, `GET /api/live/intelligence`'s `intelPool`)
- `src/lib/dashboard/client.mjs`, `src/lib/dashboard/page.mjs` (Intelligence panel rendering,
  machine-wide rollup, project picker, SSE subscription)
- [Project intelligence domain](../ddd/project-intelligence.md)
- [Dashboard guide](../DASHBOARD.md)
