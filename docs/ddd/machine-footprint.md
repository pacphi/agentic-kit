# Machine Footprint Domain

> **Draft for review.** This document specifies the domain proposed by
> [ADR-0025](../adr/0025-machine-footprint-metrics.md). Nothing described here is implemented
> yet; module paths named below are the intended homes, not existing files. On acceptance, the
> new terms merge into [Ubiquitous language](ubiquitous-language.md) and the context joins the
> [context map](context-map.md).

## Purpose

Machine footprint answers **what this toolchain costs the machine itself**: how many bytes the
managed install occupies and where; how much CPU and RAM live host processes and daemons are
consuming right now; how retained data (transcripts, ledgers, logs, learning stores, caches)
breaks down by category, host, project, and session; and what is actually deployed — the
deduplicated inventory of skills, agents, commands, plugins, and MCP servers across hosts, plus
every known project's size in lines of code and disk.

It is a read-only measurement domain over local state the kit already has trust-boundary access
to. It renders in the dashboard's proposed **System** primary area and through a CLI twin
(`ak footprint`), and it mutates nothing — including the reclaimable-space candidates it
computes, which are advisory rows with rationale, never delete actions.

The shared terms in [Ubiquitous language](ubiquitous-language.md) are normative; the
[terms table](#ubiquitous-language-additions) below is this draft's proposed addition to it.

## Why this is a separate context

Each neighboring context owns a different kind of fact about overlapping raw material, and the
boundaries are what keep all four honest:

- **[Historical usage](context-map.md)** owns *spend* facts — tokens, API-equivalent cost, model
  identity — parsed from transcript **content**. Machine footprint reads transcript **metadata**
  (`stat` size, mtime, path) and never opens a message body. A 400 MB session is a storage fact
  here and a token fact there; the two figures answer different questions and neither substitutes
  for the other.
- **[Observability](observability.md)** owns *activity* evidence — session lifecycle, actors,
  per-field confidence, a protected transcript plane. Machine footprint's runtime census reuses
  the same process survey as a *source*, but publishes resource rows (CPU%, RSS, uptime), not
  `ObservedSession` evidence; a process here is a consumer of memory, not an actor in a session
  graph.
- **[Project intelligence](project-intelligence.md)** owns *learning* trends from
  `.claude-flow/` state. Machine footprint measures those same directories only as bytes on
  disk. The shared piece is project *discovery* — the candidate-path catalog — reused exactly as
  ADR-0024 reuses Observability's workspace store: a path is not evidence, and discovery supplies
  nothing this domain renders as a measurement.
- **[Integration management](integration-management.md)** owns what *should* be deployed
  (bindings, projections, ownership). Machine footprint reports what *is* on disk and how big it
  is; catalog counts here are observed inventory, never desired state.

Because every source is the local filesystem and the current-user process table — the same trust
boundary `ak status` and the runtime survey already cross — no anti-corruption adapter guards
this domain's reads. What *is* guarded is content: this domain's collectors are structurally
metadata-only (they read directory entries, `stat` results, and manifest *names*), so transcript
text, prompt content, and tool payloads cannot enter the model at all.

## Model

```text
Sources (all local, all metadata-only)
  install roots (managed-tools detection)        process table (runtime survey + pcpu/rss)
  transcript roots (~/.claude, ~/.codex, opencode store)
  known files (ledgers, tee logs, caches, indexes)
  project catalog (discovery reuse)              host catalog surfaces (agents/skills/commands/MCP)
        |
        v
Collectors (bounded walkers; two tiers)
  cheap tier: process census + known-file stats + carry-forward of last deep scan   (TTL ~60s)
  deep tier:  full storage walk + LOC count + catalog dedup                        (explicit,
                                                                                    single-flight)
        |
        v
FootprintSnapshot  { asOf, completeness, install, runtime, storage, catalog, projects }
  install:   HostInstallation[]   { tool, version, installMethod, root, bytes, nativeAddons[] }
  runtime:   RuntimeCensus        { processes[], daemons[], totals }        (ephemeral, never
                                                                             persisted)
  storage:   StorageBreakdown     { nodes: category → host → project → session, growth, topN,
                                    reclaimables[] }
  catalog:   CatalogInventory     { skills[], agents[], commands[], plugins[], mcpServers[],
                                    each with per-host presence }
  projects:  ProjectFootprint[]   { path, label, remote?: {host, slug, webUrl}, loc: {language:
                                    lines}, treeBytes, gitBytes, nodeModulesBytes, lastActivity }
        |
        v
Delivery
  GET /api/system            → cheap tier + persisted snapshot (token auth, loopback, no egress)
  GET /api/system?refresh=deep → start-or-attach the single-flight deep scan
  ak footprint [--deep] [--json] → the same collector, CLI-rendered
        |
        v
  System primary area: Summary | Storage | Runtime | Catalog | Projects
```

### Measurement semantics

Every figure in this domain is a `Measurement` — a value plus how it was obtained:

- **measured** — a real walk/stat/count produced it, stamped with the snapshot's `asOf`;
- **carried forward** — from the persisted snapshot, presented with that snapshot's `asOf`,
  never as current;
- **unknown** — never measured, or the measurement failed for that node; rendered as
  "not measured yet" / "unavailable," **never as `0`**.

A measured zero is a real zero and renders as one. This is the same zero-vs-unknown discipline
the dashboard's `metric()` helper and [ADR-0023](../adr/0023-fail-closed-operations-and-explicit-degradation.md)
already enforce elsewhere.

### Install footprint

One `HostInstallation` per managed tool (ruflo, agentic-qe, Claude Code, Codex, OpenCode,
agentic-kit itself, the brain KB), carrying the version and install method the kit's existing
detection already knows (npm/mise/brew/self-managed), the resolved root path, tree bytes from
the deep walk, and a native-addon inventory — including the *duplicate-builds* view (the same
native module compiled into multiple trees), which is sprawl the user cannot see today. Shared
caches (npx envs, browser binaries) are install-adjacent nodes with their own rows, not smeared
into a tool's tree. The machine's free-space figure is the section's denominator, so "the
install is X GB" always has a "of Y free" next to it.

### Runtime census

A point-in-time table of live host processes — reusing the existing current-user, argv-minimized
survey and extending its `ps` read with `pcpu`/`rss` — plus the daemon census (count, age
against the 12h TTL, budget state) and a child/MCP-server process count. The census is
**ephemeral**: computed per request, never persisted into the snapshot file, because a process
table is a moment, not a fact worth retaining, and persisting it would create a stale-liveness
trap. On Windows the census degrades to an honest "unsupported," matching the survey it reuses;
every other section still works.

### Storage breakdown

A tree of `StorageNode`s: category (transcripts / ledgers-and-logs / learning stores / kit
caches) → host → project → session leaf, each with bytes and file count. Derived views over the
same walk: trailing-30d growth per host (from mtime + size — no content reads), top-N largest
sessions and files, and advisory `ReclaimableCandidate` rows (stale npx envs, transcripts beyond
a stated age, orphaned worktrees), each carrying its rationale and its path. Candidates are
information, not actions — this context has no delete verb.

### Catalog inventory

Deduplicated `CatalogItem`s across hosts — skills, agents, commands, plugins, MCP servers —
keyed by normalized name, each with a per-host presence matrix (which hosts carry it, from which
surface it was observed). Counting is by manifest/directory-entry **names** on the host catalog
surfaces Integration management already projects into; item file contents are not parsed beyond
what naming requires. The config-surface row (managed CLAUDE.md/AGENTS.md block count, settings
file sizes) lives here because it answers the same "what is deployed" question.

### Project footprint

One `ProjectFootprint` per project in the shared discovery catalog: approximate lines of code
bucketed by language (the kit's own extension-bucketed walker — explicitly approximate, excluded
trees stated: `node_modules`, vendored, binary extensions), working-tree bytes, `.git` bytes,
`node_modules` bytes (kept separate precisely because it dominates and distorts), and last
activity. LOC figures are labeled approximate wherever they render; this domain forbids
presenting them as authoritative.

A project additionally carries an optional `remote` — host, slug, and derived web URL — parsed
from `.git/config`'s origin remote through the same URL-shape handling the admin collector's
`parseRepoSlug` already proves (git+https / ssh / scp / bare). In the Projects table the project
name renders as a link to that page, with the raw remote in the tooltip; a recognized host
(GitHub, GitLab, Bitbucket, or a self-hosted URL that is already web-shaped) yields a link, an
unrecognized remote shape renders the remote name unlinked, and a project with no remote renders
an explicit "local only" — absence stated, never guessed. The link is user-initiated browser
navigation; the kit itself never fetches the remote.

## Delivery

`GET /api/system` follows Dashboard delivery's existing contract: loopback bind, per-session
token auth ([ADR-0014](../adr/0014-dashboard-auth-and-remediation.md)), `no-store`, zero egress.
The response is the cheap tier computed fresh (TTL ~60s, shared-cache pattern like the
project-snapshot cache) merged with the persisted deep snapshot and its `asOf`.
`?refresh=deep` starts the deep scan or attaches to the one in flight (single-flight, like the
usage index's coalesced builds); progress is surfaced so a long scan reads as working, not hung.
The server stays GET-only: a rescan re-measures local state and writes only this domain's own
snapshot file — it mutates no user data.

One deliberate divergence from Observability's delivery: absolute paths are **part of this
payload**. `publicLivePayload`'s leaf-only rule exists to keep incidental provenance out of
session payloads; here the path is the answer ("where are the bytes"), and the same token-gated
loopback delivery protects it. Transcript/message content remains structurally absent — the
collectors never read it, so delivery cannot leak it.

The CLI twin (`ak footprint`) renders the same collector output, `--json` emitting the snapshot
shape verbatim, following the one-collector-two-surfaces precedent of the usage scorecard.

## Invariants

1. **Metadata only, ever.** Collectors read directory entries, `stat` results, manifest names,
   and `.git/config`'s remote URL. No transcript, prompt, message, or tool-payload content
   enters this domain, in any tier, on any path.
2. **Unknown is never zero.** An unmeasured or failed measurement renders as unknown with a
   reason; a measured zero renders as zero. No fabricated figures.
3. **Freshness is part of the value.** Every deep-tier figure carries the snapshot `asOf` it came
   from; carried-forward data is never presented as current.
4. **This context mutates nothing.** No delete, prune, or cleanup verb exists here; reclaimable
   candidates are advisory rows with rationale. (The snapshot file it owns is the sole write.)
5. **The runtime census is ephemeral.** It is computed per request and never persisted; a stale
   process table is never replayed as liveness.
6. **Bounded walkers.** Symlinks are never followed; depth and entry caps apply; one unreadable
   subtree degrades that node to unknown without discarding siblings or aborting the scan.
7. **Single-flight deep scans.** Concurrent refresh requests attach to the in-flight scan; two
   scans never race each other or double-write the snapshot.
8. **No spend, no activity, no learning facts.** Tokens/cost stay in Historical usage; session
   lifecycle/evidence stays in Observability; learning counters stay in Project intelligence.
   Cross-links, not duplication.
9. **Discovery supplies paths, not measurements.** The shared project catalog contributes
   candidate locations only; everything rendered is measured by this domain's own collectors.
10. **Catalog counts are observed inventory.** They state what is on disk per host surface,
    never desired state, and never upgrade Integration management's ownership facts.
11. **LOC is approximate and says so.** Extension-bucketed line counts with stated exclusions;
    no rendering presents them as authoritative.
12. **Same delivery protections as the rest of the dashboard.** Loopback, token auth, GET-only,
    zero egress; the absolute-path exception is deliberate, documented, and content-free.

## Ubiquitous language additions

| Term | Meaning |
|------|---------|
| Footprint | The machine-resource cost of the toolchain: install bytes, runtime CPU/RSS, retained-data bytes, deployed inventory |
| FootprintSnapshot | The persisted result of a deep scan: `asOf`, completeness, and the four section models |
| Measurement | A value plus provenance: measured (with `asOf`), carried forward, or unknown-with-reason — unknown is never zero |
| HostInstallation | One managed tool's install facts: version, install method, root, tree bytes, native addons |
| RuntimeCensus | The ephemeral point-in-time table of live host processes, daemons, and totals |
| StorageNode | One node in the category → host → project → session breakdown: bytes + file count |
| ReclaimableCandidate | An advisory row naming reclaimable space, its path, and its rationale — never an action |
| CatalogItem | A deduplicated deployed artifact (skill, agent, command, plugin, MCP server) with a per-host presence matrix |
| ProjectFootprint | One project's size facts: approximate LOC by language, tree/`.git`/`node_modules` bytes, last activity, and an optional git-remote web link ("local only" when absent) |
| Deep scan | The explicit, single-flight full measurement pass that produces a FootprintSnapshot |
| Cheap tier | The per-request census + known-file stats + snapshot carry-forward served on every read |

## References

- [ADR-0025](../adr/0025-machine-footprint-metrics.md) — the decision record this draft
  accompanies
- [Context map](context-map.md) — joined on acceptance
- [Historical usage / Observability / Project intelligence](context-map.md) — the neighboring
  contexts this domain is deliberately distinct from
- [Dashboard guide](../DASHBOARD.md)
