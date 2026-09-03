# ADR-0025 — Machine footprint: infrastructure metrics for install, runtime, storage, and catalog

- **Status:** Implemented
- **Date:** 2026-08-06
- **Updated:** 2026-08-06 — accepted and implemented; the open points below are resolved decisions
- **Updated:** 2026-08-07 — §7 replaced by an enumerated read surface (the collectors now read a
  transcript head's `cwd` field and project manifests' dependency keys); §6 gains reclaimable
  safety tiers; §8 and §9 added for the widened scan surface, the corrected brain/Playwright
  figures, and project accounting
- **Updated:** 2026-09-02 — Agentic Kit now manages the receipt-owned agent-browser executor while
  Install observes AQE-owned Vibium and both payloads; daemon cleanup gains an opt-in,
  identity-proven Ruflo MCP orphan path; Catalog covers the launching repository plus observed
  on-disk projects and attributes Codex `.agents/skills` separately
- **Updated:** 2026-09-03 — CatalogInventory v2 preserves plugin marketplace/version relationships,
  separates user/project/plugin occurrences, hashes bounded capability entrypoints, reports
  project pressure and source-probe drift, and feeds a read-only skill maintenance preview.
- **Updated:** 2026-09-03 — the Catalog leads with the host profile and a five-record cross-host
  viewport, then gives Project skill pressure a full-width row; pressure groups one disclosure per
  relevant project, keeps the launching project first, omits measured-zero project rows, and moves
  per-host source evidence plus one deduplicated plan command behind progressive disclosure.
- **Updated:** 2026-09-03 — ADR-0044 implements Maintenance as a separate control plane under the
  System shell. Machine Footprint collectors, Catalog, pressure, and System measurement routes
  remain read-only.
- **Updated:** 2026-09-03 — a session cwd that aliases a host user root no longer creates a
  project occurrence: one host/kind/path cannot be both user and project scope, while a shared
  user root carried by different hosts remains explicit cross-host evidence. The FootprintSnapshot
  schema advances to v3 so cached v2 scope aliases cannot be replayed.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0005](0005-dashboard-in-page-routing-reveal.md),
  [ADR-0007](0007-maintainer-admin-local-telemetry.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0012](0012-observability.md),
  [ADR-0014](0014-dashboard-auth-and-remediation.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0024](0024-project-intelligence-telemetry.md),
  [ADR-0044](0044-receipt-aware-maintenance-control-plane.md)

> **2026-09-03 amendment.** Catalog identity is no longer only `(kind, normalized name)`: a
> standalone skill and a plugin-contributed skill with the same logical name are distinct catalog
> identities joined by explicit exact-name and exact-entrypoint-digest relationships. Full
> `plugin@marketplace` identity, installed version, enabled state, scope, and evidence authority are
> retained per host occurrence. The deep snapshot schema advances to v2 so old flattened identities
> cannot render as current. Machine Footprint and its System measurement views remain read-only;
> `ak x skills plan` classifies and previews, while [Maintenance](../ddd/maintenance.md) owns
> mutation and receipts.
> The pressure view is summary-first: it counts projects with local skills and projects carrying
> same-name or matching-entrypoint relationships, then groups host evidence beneath one native
> disclosure per project. Inventory completeness and model-context inclusion are separate facts;
> hosts do not currently report the latter, so that caveat appears once rather than as a repeated
> `complete · context unknown` row label. The all-kind detail remains in the Catalog matrix.
> Project discovery may observe a user home as a session cwd, but discovery alone cannot change a
> capability's scope. Catalog rejects any project candidate whose host, kind, and resolved surface
> path equal an already declared user surface. This removes false home-directory pressure without
> requiring Git and preserves legitimate non-repository project-local skills.
> ADR-0044 implements the Maintenance control-plane contract; its placement under System
> does not add mutation to this context's collectors or routes.

<!-- amendment boundary -->

> **2026-08-07 amendment.** Four changes, each recorded where it belongs:
> project discovery moved to the shared census ([ADR-0027](0027-shared-project-census.md));
> Storage reports learning stores on their own card and its per-host split covers real hosts only,
> naming the excluded figures rather than dropping them ([ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md) §10);
> the Runtime census dropped its launch-budget and child-process fields, the first because no code
> path could ever populate it ([ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md) §9);
> and the Catalog now covers project scope across every project on disk, not just the launching repo.
> The Projects table dropped its forge sub-line, its presence-only stack chips and its
> tree/.git/node_modules breakdown from the RENDERING — all three are still measured and still ship
> on `ak system --json` — and now lists only repositories with a remote that a host has recorded a
> session in, counting the excluded directories beneath it.
>
> The area also grew from five sub-views to seven: **Advisory** and **Sessions** split out of
> Storage. Advisory earns its own tab because it is the only part of System that suggests an
> action while every other part reports what is; that distinction was invisible while it sat as a
> card under a byte chart. Neither split changes a measurement, and Advisory still has no delete
> verb (§6 stands).

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
  ([ADR-0024](0024-project-intelligence-telemetry.md)'s transcript-cwd source);
- the third-party cache roots any developer machine accumulates — model weights, package caches,
  toolchain installs — which are plain directories under `$HOME` and need naming, not access
  (§8).

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
  domain reads `stat` metadata, paths, and declared names, never message bodies (§7 enumerates
  every read);
- **Project intelligence** — no learning counters; the shared piece is project *discovery* as a
  candidate-path source, on the same boundary ADR-0024 draws when it reuses Observability's
  workspace store, though this domain runs its own discovery (§9).

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

Summary   KPI band: install size · data size · live processes (combined RSS) · projects
          ("N ever · M on disk") · skills/agents/commands counts · machine free-space
          denominator. "Largest consumers" strip (top-20 roots, ranked or grouped by
          ecosystem, project trees opt-in). Freshness label.
Storage   Breakdown tree: category → host → project → session. Transcripts vs ledgers/logs vs
          learning stores vs kit caches. Trailing-30d growth sparkline per host. Top-N largest
          sessions/files. Advisory reclaimable candidates in two safety tiers, never one total.
Runtime   Live process table (host, pid, CPU%, RSS, uptime, bound project) + combined totals.
          Daemon census (count, age vs TTL).
Catalog   Deduplicated skills / agents / commands / plugins / MCP servers, each with a per-host
          presence matrix (which hosts carry it).
Projects  Table: project (name links to its git remote's web page when one exists — derived
          from .git/config, "local only" otherwise), lines of code (by language), detected
          frameworks/SDKs/tools (presence only), working-tree bytes, .git bytes,
          node_modules bytes, last activity. Rows are the on-disk subset; ever-seen is a count.
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
| Install | Per managed tool (ruflo, agent-browser, agentic-qe, claude, codex, opencode, ak, brain KB): version, install method, root path, tree bytes | managed-tools detection + walk |
| Install | Observed dependency-owned browser executors (Vibium): CLI presence, update owner, payload readiness, revision, cache root and bytes ✚ | PATH detection + filesystem-only cache inspection |
| Install | Native-addon inventory and duplicate builds across trees (better-sqlite3, hnswlib, onnxruntime) ✚ | walk |
| Install | Shared caches: npx cache envs, brain KB, Playwright/Puppeteer/agent-browser/Vibium browser binaries ✚ | known roots |
| Install | Total install bytes + machine free-space denominator ✚ | walk + `statfs` |
| Runtime | Per live host process: pid, host, CPU%, RSS, uptime, bound project | existing runtime survey + `ps -o pcpu,rss` |
| Runtime | Daemon census: count, age vs 12h TTL ✚ | existing daemon registry |
| Runtime | Child / MCP-server process count ✚ | survey process tree |
| Storage | Transcript bytes + file counts: host → project → session | transcript-root walk |
| Storage | Host ledgers/logs: Codex `state_N.sqlite`, statusline tee, runtime-debug log, OpenCode store | known paths |
| Storage | Learning/memory stores: per-project `.claude-flow`, `.agentic-qe`, agentdb/HNSW/RVF files ✚ | project catalog + walk |
| Storage | ak's own caches: usage-index.json, observability-workspaces.json, footprint snapshot itself ✚ | known paths |
| Storage | Top-N largest sessions / files ✚ | walk |
| Storage | Trailing-30d growth per host (from mtime + size) ✚ | walk metadata |
| Storage | Advisory reclaimable candidates (stale npx envs, aged transcripts, superseded cache snapshots, regenerable package caches, redundant browser revisions, extra runtime versions, orphaned worktrees), each with a `safety` tier ✚ | walk + heuristics |
| Storage | Ranked largest consumers across ~50 curated third-party cache roots, grouped by ecosystem, with containment/residual accounting ✚ | consumer registry + walk |
| Catalog | Unique skills / agents / commands across hosts, per-host presence matrix, including project `.claude/skills` and Codex `.agents/skills` | host catalog surfaces |
| Catalog | Plugins and registered MCP servers ✚ | settings surfaces |
| Catalog | Config surface: managed CLAUDE.md/AGENTS.md block count, settings file sizes ✚ | managed-blocks registry |
| Projects | Projects **ever seen** across hosts and the **on-disk** subset ✚; per on-disk project: LOC by language, detected frameworks/SDKs/tools by presence ✚, the unrecognized extension/dependency tail ✚, working-tree bytes, `.git` bytes ✚, `node_modules` bytes ✚, last activity | own cross-host discovery + walk |
| Projects | Git remote web link per project (origin URL → GitHub/GitLab/etc. page; "local only" when absent) ✚ | `.git/config` remote parse — the admin collector's `parseRepoSlug` shapes, reused |

LOC counting is a zero-dependency extension-bucketed line count by the kit's own bounded walker
(no `cloc`/`tokei` dependency), excluding `node_modules`, vendored trees, and binary extensions —
stated as approximate, which is what the question needs. **Lines belong to languages only.**
Frameworks, SDKs and tools are detected by presence and carry no line count in the payload at
all: React does not own lines, the `.tsx` files do, and putting both on one proportional bar
would count the same bytes twice. What the registry cannot name is published as an
**unrecognized tail** — extensions by name, dependency keys by name — which turns the usual
silent "Other" slice into a to-do list a release can close.

### 5. Delivery

- `GET /api/system` — cheap tier + last persisted deep snapshot; same loopback bind, token auth
  ([ADR-0014](0014-dashboard-auth-and-remediation.md)), and zero egress
  ([ADR-0007](0007-maintainer-admin-local-telemetry.md)'s offline side of the line) as every
  other dashboard route.
- `GET /api/system?refresh=deep` — starts or attaches to the single-flight deep scan. The
  dashboard server is deliberately GET-only; a refresh is a re-*measurement* of local state, not
  a mutation of user data, so it stays within that contract. `&trees=1|0` sets whether that scan
  walks project working trees; it is a **measurement** parameter, not a view filter, because
  trees that were never walked cannot be un-hidden client-side.
- `ak system [--deep] [--json]` — CLI parity sharing the same collector, following the
  usage-scorecard precedent of one collector behind both surfaces.

### 6. Read-only; reclaimables are advisory, in two safety tiers

v1 computes reclaimable-space *candidates* and renders them with their rationale; it deletes
nothing. Cleanup remains CLI-owned where it already lives (`ak x daemon-gc`, npx cache tooling).
A future `ak system clean` would be its own decision with its own safety contract.

Ruflo MCP transport cleanup remains outside the System read surface. `ak x daemon-gc` may report
transport count and orphan candidates, but it sends no signal unless both `--mcp` and `--kill`
are explicit. Eligibility requires the exact Ruflo MCP command shape, the current user, and PPID
one. Immediately before `SIGTERM`, the command, owner, and PPID are read again; any identity drift
preserves the process. Age, process count, and a different workspace are observations, never kill
criteria, because concurrent host sessions are legitimate.

Advisory is not enough on its own, because "advisory" is a tone of voice and users act on
numbers. Safety is therefore a **field**. Every candidate carries `safety`:

- **`regenerable`** — the owning tool refetches it on demand: the npm content cache, the Homebrew
  download cache, the brain's superseded `kb.bak-*` copies, stale npx envs.
- **`review`** — plausible but not safe to *state* as removable: aged transcripts (a transcript is
  the only copy of the session it records, and Historical usage is denominated in them), extra
  runtime versions (mise holds eight Node entries on this machine and some are aliases a live
  toolchain resolves through), a browser revision that may still be pinned by an installed
  package.

**The two tiers are totalled separately and never added.** `combined` is `null` by design: a
single "you could free N" that mixed a regenerable cache with a possibly-live runtime tree would
be the one number a reader would act on and the one number this domain cannot stand behind. Two
supporting rules keep the per-tier totals honest — only rows whose `bytesMeaning` is `candidate`
are summable (an `installed` figure is context on a review row, not a claim about removable
space), and a tier whose rows describe overlapping paths reports its total as
unknown-with-reason rather than counting the same bytes twice. The `review` block is rendered
without a leading total at all, so it cannot read as available space.

### 7. A deliberate path-visibility exception, and an enumerated read surface

Observability's `publicLivePayload` reduces absolute paths to leaf names because its payloads
describe *sessions* and a path is incidental provenance. In this domain the paths **are the
subject matter** — a storage breakdown that hides where the bytes live answers nothing. The
System payload therefore carries absolute paths, protected by the same token-gated loopback
delivery as everything else.

The content boundary is stated as an **enumeration**, not as "file contents are never read" —
that phrasing was true of the first collectors and became false the moment project discovery
needed a real path and the Projects table needed a language breakdown. What is read, and what is
taken from it:

| Read | What is taken | What is never taken |
|------|---------------|---------------------|
| Directory entries, `lstat` | name, kind, size, mtime, blocks | anything inside a file |
| `.git/config` | the origin remote URL | every other key |
| `.git/worktrees/<name>/gitdir` | one path, bounded to 4 KB | — |
| A transcript's head (≤256 KB, ≤40 parsed lines) | the session's `cwd` **field** | every message, prompt, tool call, tool result and model output |
| OpenCode's session store (read-only) | the `directory` column | every other column and every message row |
| A project's own manifests (≤3 deep, ≤64 files, ≤512 KB each) | dependency **keys** | values, scripts, anything executable — nothing is evaluated or resolved |
| A project's own source files | the count of `\n` bytes | the text: each 64 KB chunk is counted and overwritten |

Each of those yields a path, a name, or an integer. **No message body, prompt, tool call, tool
result, model output, or manifest value enters this domain, in any tier, on any path.**

Three of the rows are justifications rather than mere disclosures. The transcript `cwd` read is
the *only* honest way to know which project a session belonged to — the alternative is decoding
Claude's transcript-directory name, which is a lossy encoding that a naive decode gets wrong for
85% of directories on a real corpus (§9). It is also the same read
`native-transcript-discovery.mjs` already performs for Observability at the same trust boundary,
and it is *discovery*, which supplies a candidate path and never a measurement. The manifest read
is the same class of datum as `.git/config`'s remote: a bounded read of a declaration file, for
names. And the source-file read is what "count lines of code" always meant — §4 sanctioned an
extension-bucketed line count from the first draft, and a line count is a byte scan; what is new
here is saying so.

Rendering the git-remote link stays inside the zero-egress contract: the kit never fetches it;
navigation is the user clicking a link in their own browser.

[Machine footprint § The read surface](../ddd/machine-footprint.md#the-read-surface) holds the
normative list; a read not on it is a defect, and adding one amends both documents.

### 8. The scan surface is wider than the kit's own trees, and three figures were wrong

The first implementation answered "where are *the kit's* bytes" and presented it as "what is
eating this disk". Those are different questions, and the gap was not a rounding error. Measured
on the authoring machine, the top consumers were **entirely invisible** to the panel:
`~/.ollama` 141.31 GB, `~/.lmstudio` 48.78 GB, `~/.cache/huggingface` 35.92 GB, `~/.npm/_cacache`
22.26 GB, mise installs 16.30 GB, Docker 15.47 GB, rustup 14.62 GB, the pnpm store 13.40 GB, the
brain 13.18 GB. The panel reported the npx cache at 6.64 GB as the machine's number one; it is
number eleven.

The Summary strip's ranking is therefore its own collector over a curated registry of ~50
third-party cache roots grouped by ecosystem, not a client-side sort over whatever other sections
happened to walk. A ranking whose breadth is an accident of what other sections needed is a
ranking that reads as an answer and is not one. Because these roots nest — `~/.npm` ⊃ `_cacache`
and `_npx`; `~/.cache` ⊃ huggingface, ruvnet-brain, puppeteer, pnpm, uv; `~/.local/share` ⊃ mise,
pnpm, claude, opencode; mise installs ⊃ node ⊃ the npm global root the Install section already
walks — the accounting rules are structural rather than editorial: **containment** (bytes counted
once, at the outermost row; enclosed rows are breakdowns, excluded from the ranking and the group
totals), **residuals** (a synthesized "everything else" row so a breakdown always sums to its
parent), and **project trees opt-in** (one repository here is 175 GB and would flatten the chart,
so `includeProjectTrees` defaults off and the exclusion is stated in the payload, never silent).
Absent roots are reported as absent, not ranked at zero; Docker's sparse VM image is measured in
allocated blocks because its apparent size (~4 TB) is larger than the disk.

Two individual figures were wrong at the source, and both changed a headline:

- **The brain was measured at its KB, not at its install root.** `kbDir()` alone under-reported
  it by 85%: 1.9 GB of active KB inside a 13.18 GB cache root. The remainder is chiefly five
  dated `kb.bak-*` copies the installer leaves behind on every update — ~11 GB that nothing
  reads, and the single largest reclaimable on this machine — plus ~234 MB of embedding models.
  The root is now measured whole *and* broken into components with a remainder row, because a
  user watching a figure move from 1.9 GB to 13.18 GB is owed the reason. The upward resolution
  is conservative: both `…/ruvnet-brain/kb` segments must match, so a relocated
  `RUVNET_BRAIN_KB` cannot bill a shared volume to the brain.
- **Playwright's macOS location was not probed.** `playwright install` writes to
  `~/Library/Caches/ms-playwright` on macOS; only the XDG and Windows paths were checked, so a
  mac holding 1.86 GB of browser builds reported a *measured zero* — honest about the XDG path
  that genuinely does not exist, wrong about the question the row asks. All three locations are
  now probed, realpath-collapsed (two can be real at once), and summed into one row.

Browser executors are visible without conflating their owners. Agentic Kit manages Ruflo's current
agent-browser compatibility package under ADR-0043; Agentic QE still owns Vibium. The install rows
therefore name Agentic Kit and Agentic QE respectively, while the cache rows keep payload ownership
separate from package ownership. Readiness is derived only from local layout: agent-browser needs a
recognized executable and Vibium needs browser and driver payloads for the same revision. System
never launches either tool, downloads a browser, or treats CLI presence as payload readiness. Both
are deliberately excluded from doctor because that command also cleans stale daemon sidecars.

The consumer walk carries raised caps of its own (depth 24, 2,000,000 entries) because the
walker's defaults were sized for install trees: rustup exhausted the default entry cap at 9.4 of
its 14.62 GB, and the pnpm store, LM Studio and `~/.claude` all bottomed out at depth 16. A
ranking whose deepest trees are systematically floors does not merely under-report them, it
**mis-orders** the answer. The caps are raised, not removed — a root that exhausts even these
still reports `≥`.

### 9. Projects are counted twice, on purpose, and never given a fabricated path

The Projects section publishes **`everSeen`** (every distinct project any host ever recorded a
session in, deletions included — the deletions are the point) and **`onDisk`** (the subset that
still resolves to a directory, the only projects a byte or line measurement can be taken of).
Here: 50 ever seen, 25 on disk, 21 of those git repositories. Only on-disk projects become table
rows; the vanished ones survive in `everSeen` rather than as unmeasurable rows.

Discovery is this domain's own (`project-sources.mjs`), not `discoverRuvfloProjects()`. That
function answers "which projects carry ruflo learning state" by requiring `.claude-flow/neural/`
and reading only the 150 newest transcripts per host; both narrowings are right there and wrong
here — on this machine they collapse ~50 projects to 5. Sightings are de-duplicated by
**resolved real path**, so one project touched by Claude, Codex and OpenCode is one project and a
symlinked route is not a second one; a deleted path that cannot be resolved falls back to
`path.resolve` so it is still counted.

**Claude's transcript-directory encoding is lossy and is not safely decodable.**
`~/.claude/projects/<encoded>/` maps `/`, `.` and a literal `-` all to `-`, so
`-Users-me-ai-agentic-kit` reads equally as `/Users/me/ai/agentic/kit` and
`/Users/me/ai/agentic-kit`. Measured on this corpus, naive `-`→`/` substitution resolves **8 of
52** directories — wrong for 85% of them. The path therefore comes from the transcript's declared
`cwd` (2,538 of 2,585 Claude transcripts here, all 175 Codex rollouts, and OpenCode's per-session
`directory` column). The encoded name is consulted only as a fallback for a directory where no
transcript declares a `cwd`, and even then only through a decoder that walks candidate segments
against the real filesystem and returns a path only when the filesystem confirms it — which can
name just 18 of the 52 on its own. When neither route resolves, the group is reported as
**`unresolved`**, contributes no row, and makes `everSeen` an explicit lower bound
(`complete: false`). It is never given a guessed path. Every row carries `origins` naming which
route produced it, so a fallback-derived path can never be read as a declared one.

## Consequences

### Positive

- The "what is this costing my machine" question family gets a real answer, from data the kit
  already has trust-boundary access to — no new privileges, no egress.
- Sprawl becomes visible and actionable: duplicate native builds, giant sessions, stale caches,
  and per-project bloat all surface with their locations.
- The consumer ranking answers the question a user actually asks — "what is eating this disk" —
  rather than the narrower one the kit could answer without leaving its own trees. On the
  authoring machine that moved nine roots totalling >320 GB from invisible to ranked, and
  demoted the previously-reported number one to eleventh (§8).
- The four-family dashboard (health / spend / activity / footprint) completes a coherent mental
  model, each family in its own context with clean boundaries.

### Negative

- A fourth primary area is a permanent navigation-surface expansion and an explicit amendment of
  ADR-0005's three-area layout.
- Deep scans on large corpora (multi-GB transcript trees, many projects) take real time and I/O;
  the tiered model contains but does not eliminate that cost, and widening the scan surface to
  ~50 third-party cache roots (§8) widened that cost with it — tens of seconds on this machine.
- A curated registry of third-party cache locations is a maintenance surface: a tool that moves
  its cache goes unmeasured until the registry learns the new path. It fails visibly (the row
  reads absent with the path it looked at) rather than silently, which is the trade taken.
- A persisted snapshot is a new on-disk artifact with its own staleness to manage honestly.

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Deep scan runs long on huge corpora and reads as a hang | Single-flight with progress state surfaced in the panel; bounded walkers with entry caps; persisted snapshot means the panel is never blank while a scan runs |
| Stale snapshot presented as current | Every deep-tier figure carries `asOf`; the freshness label and rescan control are part of the Summary view's contract, not an afterthought |
| LOC figures treated as precise | Labeled approximate, extension-bucketed; the DDD doc forbids presenting them as authoritative |
| Walker follows a symlink cycle or escapes a root | Symlinks never followed; depth and entry caps; one bad subtree degrades to unknown for that node only |
| Scope creep into cleanup/mutation | v1 invariant: this context mutates nothing; reclaimables are advisory rows with rationale and a safety tier, and the tiers are never summed into one actionable number |
| Boundary erosion into Usage/Observability | DDD invariants forbid tokens/cost and session evidence; the read surface is enumerated (§7) and admits paths, names and counts only, never message content; cross-links replace duplication |
| A ranking that reads as an answer and is not one | Breadth is a curated registry, not an accident of what other sections walked; containment/residual accounting so nested roots cannot double-count; raised walk caps because a floored deep tree mis-*orders* the list; excluded categories stated in the payload |
| A size figure measured at the wrong root | Both known cases (brain KB vs cache root, Playwright's macOS location) are recorded in §8 with what they cost; new roots carry a component breakdown with a remainder row so a corrected figure arrives with its explanation |

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
  `consumers.mjs` (the ranked largest-consumers view and its containment/residual accounting),
  `project-sources.mjs` (cross-host project discovery: ever-seen vs on-disk),
  `stack-registry.mjs` + `stack-detect.mjs` (languages carry lines; frameworks/SDKs/tools are
  presence-only; the unrecognized tail), `snapshot.mjs` (the persisted deep-tier snapshot),
  `index.mjs` (the two-tier collector)
- `src/commands/system.mjs` (the CLI twin)
- `src/lib/live/win-process-survey.ps1` (the Windows stand-in for `ps` + `lsof`)
- `src/lib/live/process-sessions.mjs` (the runtime survey this reuses)
- `src/lib/dashboard/project-discovery.mjs` (the project catalog this reuses)
