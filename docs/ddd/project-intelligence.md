# Project Intelligence Domain

This document describes the domain implemented by [ADR-0024](../adr/0024-project-intelligence-telemetry.md),
`src/lib/dashboard/intel-history.mjs`, `src/lib/project-census.mjs`, and
`src/lib/live/intelligence-watch.mjs`.

> **2026-08-07 amendment:** project discovery moved to the shared census
> ([ADR-0027](../adr/0027-shared-project-census.md)). "Every ruflo-initialized project" below now
> reads "every project with memory or intelligence state, whichever host created it" — see
> [Project discovery](#project-discovery).
>
> **2026-08-05 amendment:** extended from one project's telemetry, implicit and bound to the
> dashboard server's own launching working directory, to a machine-wide catalog of every
> project on this machine, a machine-wide aggregate that is always shown, and an
> explicitly selected, explicitly labeled detail project (defaulting to most-recently-active). See
> [ADR-0024](../adr/0024-project-intelligence-telemetry.md)'s update note for the full amendment
> record, including why the `/api/status` payload shape is a clean break rather than a preserved
> fallback.

## Purpose

Project intelligence surfaces trend data about ruflo/agentic-qe's own project-level learning
subsystem — the neural pattern store, its lifetime learned-pattern counter, the reasoning graph's
structural growth, and a machine-health sample ring — inside the dashboard's Overview →
**Intelligence** view (`#overview/intelligence`). It is a read-only projection over files those
tools already write under `.claude-flow/`, selected from census projects carrying any supported
learning-state marker rather than from one implicit location. The view always shows a
machine-wide aggregate folded across every discovered project, plus per-project detail for exactly
one explicitly selected, explicitly labeled project — defaulting to whichever discovered project
was most recently seen by the census, never the dashboard server's own launching working directory. It owns no
session, actor, or activity identity; it grades no per-field evidence confidence; and it cannot
steer, retrain, or mutate the learning subsystem it reads.

The shared terms in [Ubiquitous language](ubiquitous-language.md) are normative.

## Why this is a separate context, not Observability

[Observability](observability.md) exists to grade evidence about concurrent, cross-host **session**
execution: an `ObservedSession` aggregate keyed by `(host, sessionId)`, a canonical event envelope
with per-field confidence (`observed`/`correlated`/`inferred`/`assumed`/`planned`), a lifecycle
state machine, and a protected transcript-content plane. None of that applies here:

- Every value in this domain is a scalar count, a timestamp, or a flat historical array read from
  a discovered project's own `.claude-flow/` state — whether one selected project's detail or the
  machine-wide rollup folded across every discovered project — the same local trust boundary
  `ak status` already reads directly. There is no other host's evidence to normalize through an
  anti-corruption adapter, because there is only ever one shape: the supported local learning-state schemas.
- Learning series do not carry session or actor identity and have no capability-coverage matrix,
  actor lens, or court membership. The discovery/picker projection separately retains host-origin
  and learning-scope metadata; these are selection qualifiers, not live execution evidence.
- There is no lifecycle (`queued → running → completed`); sources are either a live inventory
  (the pattern store), a monotonic lifetime counter, an append-only sample history (the graph), or
  a capped, deduplicated ring (machine health).
- The panel is a permanent secondary view under **Overview**, never a mode of **Observability**'s
  mutually exclusive Live/History scope (see [ADR-0005](../adr/0005-dashboard-in-page-routing-reveal.md)).

The current project source is `projectCensus()` and its `learning` scope. The earlier
registry/workspace-store discovery experiment is not an active secondary discovery path.
Observability's `WorkspaceSnapshotStore` remains metadata-only and is not a source of resolvable
project roots for this catalog.

The implementation reuses only source-agnostic transport plumbing that Dashboard delivery already
shares across contexts — `JsonlTailer`, `sseChannel`, `reserveClientSlot`/`clientGone`, and
`transcriptSseFrame` — never Observability's canonical normalizer, `ObservedSession` aggregate, or
replay/snapshot cursor. `GET /api/live/intelligence` shares the `/api/live/*` path prefix with
Observability's endpoints by transport convention only; it is not covered by
[OBSERVABILITY.md](../OBSERVABILITY.md)'s evidence, privacy, or capability-coverage contract, and it
needs no `--live-source` registration because its sources are always a discovered project's own,
never a remote or unregistered one.

## Project discovery

Intelligence does not discover projects. It consumes the **learning scope** of the shared project
census ([ADR-0027](../adr/0027-shared-project-census.md), `src/lib/project-census.mjs`), which is
the same census the System area measures directories from and the same identity Observability keys
sessions by. Consumers share identity helpers but deliberately retain different populations and granularities.

The learning scope is every project still on disk that carries **learning state** — a
`.claude-flow`, `.agentic-qe` or `.swarm` directory — regardless of which host created it.

Two properties of that definition are deliberate and both were once wrong:

- **Activation, not training.** The predicate this replaced required `.claude-flow/neural/`, which
  answers "has ruflo trained here". That excluded every project whose memory came from agentic-qe
  or swarm storage, and every project driven by Codex or OpenCode. On a real machine it reported 4
  projects where 17 had learning state. The markers above are exactly the ones the Storage context
  already treats as a project's learning stores, so the two contexts cannot disagree about what a
  learning store is.
- **One row per project identity, not per directory.** Sessions get recorded in a repository's
  sub-directories and in ephemeral `.claude/worktrees/agent-*` checkouts. The census lists those as
  the distinct directories they are — the System context measures bytes per directory — and the
  learning scope folds them onto the repository root via `resolveProjectIdentity()`. Without the
  fold, a picker keyed by identity silently loses every folded row.

A merged row is anchored on the path that actually carries the learning state (the repository root
in the ordinary case), because that is the path `readIntelHistory()` reads. It keeps `paths`, every
directory that contributed, and `learningState`, which markers were found — so a project reporting
zero patterns can say *why* it reports zero rather than being indistinguishable from a failed read.

`label` reuses `resolveProjectLabel`; the key a client echoes back as `?project=<key>` is
`resolveProjectIdentity(path).key`. Repository identity and launch origin remain separate.

The native select groups choices as Git repositories, Git worktrees, User-level learning, and
Other / unclassified, alphabetically within each group. Grouping uses `learningScope` and its
evidence; only exact configured user-state roots qualify as user-level. Known Desktop declarations
add Claude Desktop/Codex Desktop suffixes independently. `learningOrigins` is a union when census
rows fold to one identity. Sorting does not change selection keys or machine-wide totals. The
picker remains visible when the selected project has no history, so the user can choose another.

## Model

```text
projectsInScope(census, 'learning')
  -> ProjectRow[] { path, label, paths, learningState, hosts,
                   learningScope, learningOrigins, learningObservedAt }
     (existing learning-state roots, any host — ADR-0027)

.claude-flow/neural/patterns.json             -> PatternStoreEntry[]   { createdAt, type }
.claude-flow/neural/stats.json                -> GlobalLearningStats   { patternsLearned, trajectoriesRecorded,
                                                                          signalsProcessed, lastAdaptation }
.claude-flow/data/intelligence-snapshot.json  -> GraphSample[]         { timestamp, nodes, edges, pageRankSum }
.claude-flow/health-history.json              -> HealthSample[]        (capped ring, deduped, appended here)
.claude-flow/data/pending-insights.jsonl      -> change signal only (record contents never used as learning evidence)
.claude-flow/improvement.json                 -> ImprovementEval       (pre-existing; unchanged by this domain)

readIntelHistory(cwd)              -> { patternStore, graph, healthRing, globalStats }   (one project)
readMachineWideIntel(ProjectRow[]) -> { totals, perProject }                             (every project, folds readIntelHistory)

resolveSelectedProject(ProjectRow[], ?project=<key>) -> selected project
        (explicit key match, else census most-recently-seen order; shared by BOTH routes below)
        |
        +--> readMachineWideIntel(ProjectRow[])   -- always the full machine-wide rollup
        +--> readIntelHistory(selected.path)      -- detail for the selected project only
                |
                +--> collectData() (Dashboard delivery) --> GET /api/status?project=<key>             (poll, ~30s)
                |
                +--> per-project IntelligenceWatch pool --> GET /api/live/intelligence?project=<key>  (SSE push, debounced)
                        |
                        v
        Overview -> Intelligence (#overview/intelligence): machine-wide rollup (always visible) +
                    project picker + five sparklines/improvement verdict badge for the selection
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

### Machine-wide rollup

`readMachineWideIntel(projects)` folds `readIntelHistory()` across every project
`projectsInScope(census, 'learning')` returns into one `{ totals, perProject }` view. Exactly as at
single-project scope above, the lifetime counter and the current store size are never conflated —
now at machine scope too:

- `totals.patternsLearnedLifetime` sums every project's cumulative `globalStats.patternsLearned`.
- `totals.patternStoreEntries` sums every project's current `patternStore.length`.

`totals.mostActiveProject` is the label of whichever project has the highest positive
`globalStats.lastAdaptation` among projects that have one; it is `null` when no project has
adaptation data, matching `readGlobalStats`'s own `?? 0` "never adapted" default. A project whose
`readIntelHistory()` call turns up missing or malformed data degrades that project's `perProject`
row to nulls/zeros rather than aborting the whole scan — one bad project never hides every other
project's data. This is a plain on-demand scan with no aggregation-layer caching of its own;
caching the catalog and the rollup together is a Dashboard delivery concern (see
[Live delivery](#live-delivery) below).

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

Each `IntelligenceWatch` instance still polls its one project's three source files' `mtime` on an
interval (default 1,000 ms), corroborated by a change-only tail of that project's own
`pending-insights.jsonl` via the existing `JsonlTailer` — record contents are discarded by the watch callback; a record
arriving at all is the signal. Detected changes accumulate against a trailing-edge debounce
(default 2,500 ms, measured from the most recently detected change) so a burst of writes during an
active session collapses into one flush. A flush re-reads `readGlobalStats(cwd)` for that project;
if it differs from the watcher's own last-seen value, it appends a health snapshot (independent of,
and in addition to, `intel-history.mjs`'s own on-disk dedup) and then calls `readIntelHistory(cwd)`
and forwards the combined result to every `GET /api/live/intelligence` client currently subscribed
to that project.

What changed with machine-wide, selectable scope is the *lifecycle*, not the per-project polling
above: a single server-wide watcher tied to the dashboard's launching working directory is replaced
by a small pool keyed by resolved project path — at most one `IntelligenceWatch` per project
actually being watched by at least one client. A project's watcher is created lazily on that
project's first SSE subscriber (however many other projects already have their own watcher
running) and is stopped and removed from the pool the moment its last subscriber for that project
disconnects. An unwatched project's watcher therefore never runs indefinitely, and two clients
watching two different projects never cross-talk, because each pool entry owns its own subscriber
set and its own broadcast closure.

`GET /api/status` and `GET /api/live/intelligence` accept the identical optional `?project=<key>`
query parameter and resolve it through the same shared `resolveSelectedProject(projects, rawParam)`
helper — an explicit key match if present and valid, else the first entry in
`projectsInScope(census, 'learning')`'s most-recently-seen-first order — so the two routes can never
disagree about what an absent or unresolvable key defaults to. `GET /api/live/intelligence`
answers `503` if discovery finds zero projects with learning state on this machine at all, rather
than picking anything. The machine-wide project catalog and the `readMachineWideIntel()` rollup
themselves are shared, TTL-cached (~60s) state — one scan per dashboard instance per window, reused
by every poll and every new connection within it, rather than re-walking the machine per request.

The route otherwise follows Dashboard delivery's existing SSE discipline exactly:
reservation-before-await client-cap tracking (default cap 32, clamped to 256, shared across all
projects), the forwarding-cleanup idiom for a close that races connection setup, and
`sseChannel`'s bounded per-client queue (default 256 frames, clamped to 4,096) with heartbeat.
`/api/status` remains a fully sufficient fallback for a client that has not opened, or does not
support, the stream — both paths resolve the same selected project and return the identical
`readIntelHistory(cwd)` shape for its detail fields.

## Invariants

1. Pattern-store size and the patterns-learned counter are computed, labeled, and rendered
   independently; neither substitutes for the other — at single-project scope
   (`patternStore.length` vs. `globalStats.patternsLearned`) and at machine scope
   (`totals.patternStoreEntries` vs. `totals.patternsLearnedLifetime`) alike.
2. Every reader degrades to an honest empty/`null` result on a missing, unreadable, or
   wrong-shaped source file rather than throwing or fabricating a value; individual malformed
   entries are skipped rather than corrupting a bucket. One project's missing or malformed data
   degrades only that project's row in a machine-wide scan; it never aborts the whole scan.
3. `readGlobalStats` and `status.mjs`'s CLI `learning` row read the same file through the same
   helper and default logic, so the two cannot silently drift apart.
4. The health-history ring is capped and deduplicated; unchanged repeated snapshots do not grow it.
5. `JsonlTailer` parses complete pending-insight records, but this watcher ignores their contents.
   Only "a record arrived" triggers a bounded reread of the owned learning-state files.
6. Learning series introduce no session/actor lifecycle or per-field confidence grading.
   Picker scope and Desktop-origin metadata do not establish activity or inference-provider facts.
7. `GET /api/live/intelligence` requires no `--live-source` registration; its sources are always a
   discovered project's own `.claude-flow/` state, never a remote or unregistered source.
8. `/api/status` and `GET /api/live/intelligence` resolve `?project=<key>` identically and return
   the same `readIntelHistory(selected.path)` shape for their detail fields, so client rendering
   has one code path regardless of delivery route or which project is selected.
9. A project appears in the learning catalog when it is on disk and carries `.claude-flow`,
   `.agentic-qe`, or `.swarm`. Neural training is not required; an existing bare marker qualifies.
10. Selection defaults to the first learning-scope project, ordered by census `lastSeenMs`; it is
    never implicitly the dashboard server's own launching working directory. There is no unlabeled
    "this project" default anywhere in this domain's delivery contract.
11. `machineWide`/`totals` are always computed across every discovered project, independent of
    which project is currently selected for detail; switching the selection never changes the
    machine-wide figures.
12. A project's `IntelligenceWatch` exists in the delivery pool only while at least one client is
    subscribed to it; that project's last disconnect stops and removes it.
13. The shared census supplies selection candidates; learning totals come from the selected
    state readers. The workspace snapshot store is not a project-discovery source.

## References

- [ADR-0024](../adr/0024-project-intelligence-telemetry.md)
- [Observability](observability.md) — the bounded context this domain is deliberately distinct from
- [Context map](context-map.md)
- [Dashboard guide](../DASHBOARD.md)
