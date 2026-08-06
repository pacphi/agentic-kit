# ADR-0025 — Machine footprint: infrastructure metrics for install, runtime, storage, and catalog

- **Status:** Implemented
- **Date:** 2026-08-06
- **Updated:** 2026-08-06 — accepted and implemented; the open points below are resolved decisions
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0005](0005-dashboard-in-page-routing-reveal.md),
  [ADR-0007](0007-maintainer-admin-local-telemetry.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0012](0012-observability.md),
  [ADR-0014](0014-dashboard-auth-and-remediation.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0024](0024-project-intelligence-telemetry.md)

## Context

The dashboard currently answers three families of questions, each owned by its own context:

- **Overview** — is the kit healthy and configured (subsystem status, hosts, routing, providers,
  Intelligence's learning trends per [ADR-0024](0024-project-intelligence-telemetry.md))?
- **Usage** — what did sessions cost in tokens and API-equivalent dollars
  ([ADR-0009](0009-usage-scorecard-local-transcript-analytics.md))?
- **Observability** — what are agents doing right now, and what did completed sessions do
  ([ADR-0012](0012-observability.md))?

Nobody answers the fourth family: **what does this toolchain cost the machine itself.** Real
questions a user of this stack has today, none answerable without hand-rolled `du`/`ps`/`find`
archaeology:

- How big is the whole install — ruflo + agentic-qe + Claude Code + Codex + OpenCode + their
  native addons and caches — and which tool owns how much of it?
- How much disk do six months of transcripts hold, broken down by host, by project, by session?
  Which single sessions are the giants?
- How much of the disk is host ledgers and logs (Codex's `state_N.sqlite` thread ledgers, the
  statusline tee files, OpenCode's store) as opposed to transcripts proper?
- How much RAM and CPU are three concurrent host processes plus background daemons consuming
  right now?
- How many distinct skills, agents, and slash commands are actually deployed across hosts — and
  which hosts have which?
- How many projects has this machine touched, and per project: how many lines of code, how much
  disk (working tree, `.git`, `node_modules`)?

Everything needed is already locally readable at trust boundaries the kit already crosses:

- the install trees it manages and their install methods
  ([MANAGED-TOOLS.md](../MANAGED-TOOLS.md); npm/mise/brew awareness already exists for drift
  reporting);
- the current-user, argv-minimized process survey Observability already runs
  (`src/lib/live/process-sessions.mjs`, hardened under
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md));
- the transcript roots Historical usage and Observability already walk
  (`~/.claude/projects`, `~/.codex/sessions`, OpenCode's store);
- the catalog surfaces Integration management already projects into (`.claude/agents`,
  `.claude/commands`, skills listings, OpenCode's converted agents, MCP registrations);
- the project catalog machine-wide discovery already assembles
  ([ADR-0024](0024-project-intelligence-telemetry.md)'s transcript-cwd source).

The gap is a **domain and a UX**, not access.

This record was written as a proposal and is retained in that voice; the decision has since been
accepted and shipped. Where the draft left a choice open, the [resolved
decisions](#resolved-decisions) section states what was decided and why.

## Decision

### 1. A new bounded context: Machine footprint

Machine footprint is its own bounded context — see
[Machine footprint](../ddd/machine-footprint.md) for the model, boundaries, and invariants. It is
deliberately **not** part of:

- **Historical usage** — no tokens, no cost, no model identity here; a byte of transcript on disk
  is a storage fact, not a spend fact;
- **Observability** — no session lifecycle, no evidence confidence, no transcript content; this
  domain reads `stat` metadata and manifest names, never message bodies;
- **Project intelligence** — no learning counters; the shared piece is only project *discovery*,
  reused as a candidate-path source exactly as ADR-0024 reuses Observability's workspace store.

### 2. A fourth primary area: System

The dashboard gains a fourth primary area — **System** — alongside Overview, Usage, and
Observability. This deliberately amends the "three stable primary areas" layout decision
([ADR-0005](0005-dashboard-in-page-routing-reveal.md) and `page.mjs`'s own header comment).
Machine-scoped resource facts are a peer question family, not a subsection of configuration
health; folding them under Overview would bury a whole domain under a tab whose contract is
"readiness and attention," and Overview's secondary rail is already five views deep.

Information architecture ([ADR-0026](0026-about-component-directory.md) later added **About**
left of Overview; the System area itself is unaffected):

```text
[ Overview | Usage | Observability | System ]

System secondary rail:
  [ Summary | Storage | Runtime | Catalog | Projects ]        [ as of 2h ago · ⟳ rescan ]

Summary   KPI band: install size · data size · live processes (combined RSS) · projects ·
          skills/agents/commands counts · machine free-space denominator.
          "Largest consumers" strip (top-N across all categories). Freshness label.
Storage   Breakdown tree: category → host → project → session. Transcripts vs ledgers/logs vs
          learning stores vs kit caches. Trailing-30d growth sparkline per host. Top-N largest
          sessions/files. Advisory reclaimable candidates.
Runtime   Live process table (host, pid, CPU%, RSS, uptime, bound project) + combined totals.
          Daemon census (count, age vs TTL, budget state). Child/MCP server process count.
Catalog   Deduplicated skills / agents / commands / plugins / MCP servers, each with a per-host
          presence matrix (which hosts carry it).
Projects  Table: project (name links to its git remote's web page when one exists — derived
          from .git/config, "local only" otherwise), lines of code (by language), working-tree
          bytes, .git bytes, node_modules bytes, last activity.
```

The window/refresh control sits in the secondary-actions slot, the same pattern as Usage's
day-window chips and Observability's history-window chips.

### 3. Tiered, honest collection

Two tiers, because the metrics differ by orders of magnitude in cost:

- **Cheap tier** (served on every `GET /api/system`, TTL-cached ~60s like the project-snapshot
  cache): the process census, sizes of individually known files (ledgers, caches, index files),
  install-tree sizes carried forward from the last deep scan, and the persisted deep snapshot's
  contents with their `asOf`.
- **Deep tier** (explicit, user-triggered): the full storage walk, per-project LOC counting, and
  cross-host catalog deduplication. Single-flight — concurrent requests attach to the in-flight
  scan. The result is persisted to `~/.config/agentic-kit/footprint-snapshot.json` so the panel
  paints instantly on every later open, labeled with when it was measured.

The honest-measurement contract of
[ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md) applies verbatim: a section
that has never been deep-scanned renders "not measured yet," never `0`; a measured zero is a real
zero; a subtree that fails to stat degrades that node to unknown without discarding its siblings.

### 4. Initial metric taxonomy (non-exhaustive by design)

Metrics marked ✚ are additions beyond the requesting examples; the taxonomy is expected to grow.

| Section | Metric | Source |
|---------|--------|--------|
| Install | Per managed tool (ruflo, agentic-qe, claude, codex, opencode, ak, brain KB): version, install method, root path, tree bytes | managed-tools detection + walk |
| Install | Native-addon inventory and duplicate builds across trees (better-sqlite3, hnswlib, onnxruntime) ✚ | walk |
| Install | Shared caches: npx cache envs, brain KB, browser binaries ✚ | known roots |
| Install | Total install bytes + machine free-space denominator ✚ | walk + `statfs` |
| Runtime | Per live host process: pid, host, CPU%, RSS, uptime, bound project | existing runtime survey + `ps -o pcpu,rss` |
| Runtime | Daemon census: count, age vs 12h TTL, budget state ✚ | existing daemon registry |
| Runtime | Child / MCP-server process count ✚ | survey process tree |
| Storage | Transcript bytes + file counts: host → project → session | transcript-root walk |
| Storage | Host ledgers/logs: Codex `state_N.sqlite`, statusline tee, runtime-debug log, OpenCode store | known paths |
| Storage | Learning/memory stores: per-project `.claude-flow`, `.agentic-qe`, agentdb/HNSW/RVF files ✚ | project catalog + walk |
| Storage | ak's own caches: usage-index.json, observability-workspaces.json, footprint snapshot itself ✚ | known paths |
| Storage | Top-N largest sessions / files ✚ | walk |
| Storage | Trailing-30d growth per host (from mtime + size) ✚ | walk metadata |
| Storage | Advisory reclaimable candidates (stale npx envs, old transcripts, orphaned worktrees) ✚ | walk + heuristics |
| Catalog | Unique skills / agents / commands across hosts, per-host presence matrix | host catalog surfaces |
| Catalog | Plugins and registered MCP servers ✚ | settings surfaces |
| Catalog | Config surface: managed CLAUDE.md/AGENTS.md block count, settings file sizes ✚ | managed-blocks registry |
| Projects | Project count; per project: LOC by language, working-tree bytes, `.git` bytes ✚, `node_modules` bytes ✚, last activity | project catalog + walk |
| Projects | Git remote web link per project (origin URL → GitHub/GitLab/etc. page; "local only" when absent) ✚ | `.git/config` remote parse — the admin collector's `parseRepoSlug` shapes, reused |

LOC counting is a zero-dependency extension-bucketed line count by the kit's own bounded walker
(no `cloc`/`tokei` dependency), excluding `node_modules`, vendored trees, and binary extensions —
stated as approximate, which is what the question needs.

### 5. Delivery

- `GET /api/system` — cheap tier + last persisted deep snapshot; same loopback bind, token auth
  ([ADR-0014](0014-dashboard-auth-and-remediation.md)), and zero egress
  ([ADR-0007](0007-maintainer-admin-local-telemetry.md)'s offline side of the line) as every
  other dashboard route.
- `GET /api/system?refresh=deep` — starts or attaches to the single-flight deep scan. The
  dashboard server is deliberately GET-only; a refresh is a re-*measurement* of local state, not
  a mutation of user data, so it stays within that contract.
- `ak system [--deep] [--json]` — CLI parity sharing the same collector, following the
  usage-scorecard precedent of one collector behind both surfaces.

### 6. Read-only; reclaimables are advisory

v1 computes reclaimable-space *candidates* and renders them with their rationale; it deletes
nothing. Cleanup remains CLI-owned where it already lives (`ak x daemon-gc`, npx cache tooling).
A future `ak system clean` would be its own decision with its own safety contract.

### 7. A deliberate path-visibility exception

Observability's `publicLivePayload` reduces absolute paths to leaf names because its payloads
describe *sessions* and a path is incidental provenance. In this domain the paths **are the
subject matter** — a storage breakdown that hides where the bytes live answers nothing. The
System payload therefore carries absolute paths, protected by the same token-gated loopback
delivery as everything else. File *contents* are never read: `stat` metadata, directory names,
catalog manifest names, and one narrow config read — `.git/config`'s remote URL, so a project
can link to its hosted repository page. Rendering that link stays inside the zero-egress
contract: the kit never fetches it; navigation is the user clicking a link in their own browser.

## Consequences

### Positive

- The "what is this costing my machine" question family gets a real answer, from data the kit
  already has trust-boundary access to — no new privileges, no egress.
- Sprawl becomes visible and actionable: duplicate native builds, giant sessions, stale caches,
  and per-project bloat all surface with their locations.
- The four-family dashboard (health / spend / activity / footprint) completes a coherent mental
  model, each family in its own context with clean boundaries.

### Negative

- A fourth primary area is a permanent navigation-surface expansion and an explicit amendment of
  ADR-0005's three-area layout.
- Deep scans on large corpora (multi-GB transcript trees, many projects) take real time and I/O;
  the tiered model contains but does not eliminate that cost.
- A persisted snapshot is a new on-disk artifact with its own staleness to manage honestly.

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Deep scan runs long on huge corpora and reads as a hang | Single-flight with progress state surfaced in the panel; bounded walkers with entry caps; persisted snapshot means the panel is never blank while a scan runs |
| Stale snapshot presented as current | Every deep-tier figure carries `asOf`; the freshness label and rescan control are part of the Summary view's contract, not an afterthought |
| LOC figures treated as precise | Labeled approximate, extension-bucketed; the DDD doc forbids presenting them as authoritative |
| Walker follows a symlink cycle or escapes a root | Symlinks never followed; depth and entry caps; one bad subtree degrades to unknown for that node only |
| Scope creep into cleanup/mutation | v1 invariant: this context mutates nothing; reclaimables are advisory rows with rationale |
| Boundary erosion into Usage/Observability | DDD invariants forbid tokens/cost, session evidence, and content reads; cross-links replace duplication |

## Resolved decisions

The draft left four points open. All four are decided; this section is the record.

1. **Naming — the tab and the CLI are both "System" (`ak system`).** One word for one area is
   what a user can guess and what documentation can state without a translation table; a name the
   UI and the terminal disagree about is a support burden with no upside. **Footprint** survives
   only as the *domain* name inside the DDD documents ([Machine footprint](../ddd/machine-footprint.md))
   and the module directory (`src/lib/footprint/`), where it names a bounded context rather than a
   user-facing surface. The command is `src/commands/system.mjs`; no user-facing string says
   "footprint".
2. **Projects stays its own sub-view — five sub-views, not four.** LOC, git-remote identity, and
   `node_modules` bloat answer "what have I built here", not "where are my bytes"; merging them
   into Storage would put two different questions behind one heading and force the Storage tree to
   grow a column vocabulary it does not otherwise need.
3. **Deep scans re-run on an explicit click only, with a visible staleness nudge past ~7 days.**
   Auto-scanning on open would make simply *looking* at the tab cost tens of seconds of I/O on a
   large corpus — the surprise cost is worse than a stale figure that says how stale it is. The
   snapshot's `asOf` is always rendered, and beyond `SNAPSHOT_STALE_AFTER_MS` (7 days) the
   freshness label turns amber and reads "stale, rescan". Opening the System tab issues a plain
   `GET /api/system`; only the Rescan control adds `?refresh=deep`.
4. **Windows ships a guaranteed census plus a best-effort true `cwd`, degrading honestly, with no
   dependency added.** The draft's "unsupported on win32" answer would have blanked the whole
   Runtime view on a supported platform. Instead `src/lib/live/win-process-survey.ps1` — a plain text
   script invoked the same way the POSIX path already invokes `ps` and `lsof`, no npm package and
   no compiled artifact — provides two layers:
   - a **guaranteed** census (host, pid, ppid, start time, CPU, working set) from
     `Get-CimInstance Win32_Process`, plus current-user-only command lines proven via `GetOwner`;
   - a **best-effort** true per-process working directory via inline `Add-Type` P/Invoke
     (`NtQueryInformationProcess` → PEB → `RTL_USER_PROCESS_PARAMETERS` → `CurrentDirectory`).

   If the P/Invoke path fails for any reason — antivirus block, execution policy, insufficient
   rights, WOW64 bitness mismatch — every other field still returns and the Project column
   degrades to an explicit "not attributable on Windows" carrying the failure reason. An empty
   census is treated as a broken survey, not an idle machine. This is genuinely verified rather
   than asserted: `windows-latest` is already in the CI matrix (`.github/workflows/ci.yml`), so
   the Windows path runs on every push alongside Linux and macOS.

## Follow-ups on acceptance

All complete:

- The context is on the [context map](../ddd/context-map.md) (context description, ASCII map, and
  relationships table) and its terms are merged into
  [ubiquitous language](../ddd/ubiquitous-language.md).
- This ADR is in the [ADR index](README.md) and the theme narrative.

## References

- [Machine footprint domain](../ddd/machine-footprint.md) — the domain model and invariants
- [Design mock-up](../assets/system-tab-mock.html) — a self-contained, both-theme HTML mock of
  the System area with illustrative data: per-metric chart forms (odometer KPIs, radial disk
  gauge, donut, stacked bars, small-multiple growth areas, radar, presence matrix, composed
  project bars), each card annotated with its form choice and rationale
- [Dashboard guide](../DASHBOARD.md)
- [Managed tools](../MANAGED-TOOLS.md)
- `src/lib/footprint/` — the collectors: `walk.mjs` (the bounded walker and the `Measurement`
  vocabulary), `install.mjs`, `storage.mjs`, `runtime.mjs`, `catalog.mjs`, `projects.mjs`,
  `snapshot.mjs` (the persisted deep-tier snapshot), `index.mjs` (the two-tier collector)
- `src/commands/system.mjs` (the CLI twin)
- `src/lib/live/win-process-survey.ps1` (the Windows stand-in for `ps` + `lsof`)
- `src/lib/live/process-sessions.mjs` (the runtime survey this reuses)
- `src/lib/dashboard/project-discovery.mjs` (the project catalog this reuses)
