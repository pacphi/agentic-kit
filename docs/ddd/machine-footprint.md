# Machine Footprint Domain

This document specifies the domain decided by
[ADR-0025](../adr/0025-machine-footprint-metrics.md) and implemented in `src/lib/footprint/`.
Its terms are merged into [Ubiquitous language](ubiquitous-language.md) and the context is on the
[context map](context-map.md).

## Purpose

Machine footprint answers **what this toolchain costs the machine itself**: how many bytes the
managed install occupies and where; how much CPU and RAM live host processes and daemons are
consuming right now; how retained data (transcripts, ledgers, logs, learning stores, caches)
breaks down by category, host, project, and session; and what is actually deployed — the
deduplicated inventory of skills, agents, commands, plugins, and MCP servers across hosts, plus
every known project's size in lines of code and disk.

It is a read-only measurement domain over local state the kit already has trust-boundary access
to. It renders in the dashboard's **System** primary area and through a CLI twin (`ak system`),
and it mutates nothing — including the reclaimable-space candidates it computes, which are
advisory rows with rationale, never delete actions.

**Footprint** is the name of this context, not of a user-facing surface: every surface a user
touches — the tab, the command, the route — is called *System*.

The shared terms in [Ubiquitous language](ubiquitous-language.md) are normative; the
[terms table](#ubiquitous-language-additions) below restates this context's contributions to it.

## Why this is a separate context

Each neighboring context owns a different kind of fact about overlapping raw material, and the
boundaries are what keep all four honest:

- **[Historical usage](context-map.md)** owns *spend* facts — tokens, API-equivalent cost, model
  identity — parsed from transcript **content**. Machine footprint reads transcript `stat`
  metadata, plus one declared field — the session's `cwd` — and never a message body
  ([the read surface](#the-read-surface)). A 400 MB session is a storage fact here and a token
  fact there; the two figures answer different questions and neither substitutes for the other.
- **[Observability](observability.md)** owns *activity* evidence — session lifecycle, actors,
  per-field confidence, a protected transcript plane. Machine footprint's runtime census reuses
  the same process survey as a *source*, but publishes resource rows (CPU%, RSS, uptime), not
  `ObservedSession` evidence; a process here is a consumer of memory, not an actor in a session
  graph.
- **[Project intelligence](project-intelligence.md)** owns *learning* trends from
  `.claude-flow/` state. Machine footprint measures those same directories only as bytes on
  disk. The shared piece is the *idea* of project discovery, not the implementation: this domain
  runs its own (`project-sources.mjs`) because Intelligence's catalog answers "which projects
  carry ruflo learning state" and collapses ~50 projects to 5 here. Either way a path is not
  evidence, and discovery supplies nothing this domain renders as a measurement — exactly the
  boundary ADR-0024 draws when it reuses Observability's workspace store.
- **[Integration management](integration-management.md)** owns what *should* be deployed
  (bindings, projections, ownership). Machine footprint reports what *is* on disk and how big it
  is; catalog counts here are observed inventory, never desired state.

Because every source is the local filesystem and the current-user process table — the same trust
boundary `ak status` and the runtime survey already cross — no anti-corruption adapter guards
this domain's reads. What *is* guarded is content, and the guarantee is narrower and more precise
than "the collectors never open a file": see [The read surface](#the-read-surface) for the
enumerated list of what is opened, what is taken out of it, and why every one of those reads is
still a metadata read.

## The read surface

Invariant 1 is an enumeration, not a slogan. Every read this domain performs is listed here; a
read not on this list is a defect, and adding one is an amendment to this document and to
[ADR-0025 §7](../adr/0025-machine-footprint-metrics.md#7-a-deliberate-path-visibility-exception-and-an-enumerated-read-surface).

| Read | Collector | What is taken | What is never taken |
|------|-----------|---------------|---------------------|
| Directory entries and `lstat` | `walk.mjs`, every collector | name, kind, size, mtime, block count | anything inside a file |
| `.git/config` | `projects.mjs` | the origin remote URL | every other config key |
| `.git/worktrees/<name>/gitdir` | `storage-reclaim-detectors.mjs` (re-exported from `storage.mjs`) | one filesystem path, bounded to 4 KB | — |
| A transcript's **head** | `project-sources.mjs` | the session's `cwd` **field** | every message, prompt, tool call, tool result and model output in the file |
| OpenCode's session store | `project-sources.mjs` | the `directory` column, read-only | every other column, and every message row |
| A project's own manifests | `stack-detect.mjs` | dependency **keys** (and, for `path:`/`workspace:` entries, enough of the value to reject them) | manifest values, scripts, and anything executable |
| A project's own source files | `stack-detect.mjs` | the count of `\n` bytes, and whether byte 0 of the first chunk region is NUL | the text — each 64 KB chunk is counted and immediately overwritten |

Three of those rows are new since the first draft of this document, and they are the reason this
section exists rather than a one-line invariant.

**A transcript's `cwd` is a path, not content.** Project discovery opens each Claude and Codex
transcript, reads at most its first 256 KB, JSON-parses at most its leading 40 non-blank lines,
and takes exactly one field: `record.cwd` (Claude) or `record.payload.cwd` on the `session_meta` /
`turn_context` records that open a rollout (Codex). The parsed records are discarded at the end of
the loop; nothing but the path string survives the function. This is the same read
`native-transcript-discovery.mjs` already performs for Observability at the same trust boundary,
and it is what makes discovery honest: the alternative is guessing the path from the directory
name, which [Project accounting](#project-accounting) shows is wrong four times out of five.

The head bound is a correctness statement as much as a cost one. A session's `cwd` is declared in
its opening records or nowhere, so reading further would cost the whole corpus (~2,700 files here)
to learn nothing — and it would put the collector's read window over message bodies for no gain.

**A manifest's dependency keys are names, not code.** Stack detection reads `package.json`,
`Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`, `mix.exs`, `Gemfile`,
`pubspec.yaml` and their siblings to at most 3 directories deep, at most 64 of them, at most
512 KB each, and extracts dependency **keys**. Nothing is evaluated, executed, resolved or
fetched: `mix.exs` and `build.gradle` are Elixir and Groovy *source*, and they are scanned with
regexes, never run. The depth bound is not cosmetic — a scan of this machine found 1,884
`Cargo.toml` files, nearly all of them inside Cargo's registry cache, and a deeper search would
report a dependency's dependencies as the project's own.

**Counting lines requires reading bytes, and the ADR always required counting lines.** LOC was
sanctioned from the first draft (`§4`: "a zero-dependency extension-bucketed line count by the
kit's own bounded walker"). What was left implicit is that a line count is a byte scan: the
counter streams the file through one fixed 64 KB buffer, increments on `0x0a`, bails out on a NUL
byte in the first chunk (binary), and never retains, concatenates, decodes or emits the text. The
figure that leaves the function is an integer.

The boundary that still holds, stated positively: **no message body, prompt, tool call, tool
result, model output, or manifest value enters this domain, in any tier, on any path.** Every
figure the System area renders is either a `stat` result, a count, or a path.

Two neighbouring boundaries are untouched by the above. The `cwd` read is *discovery*
(invariant 9) and supplies a candidate path, never a measurement. And nothing here reads a
transcript for what Historical usage reads it for — tokens, cost and model identity stay in that
context, parsed from the message bodies this one does not open.

## Model

```text
Sources (all local; see "The read surface" for exactly what is read)
  install roots (managed-tools detection)        process table (runtime survey + pcpu/rss)
  transcript roots (~/.claude, ~/.codex, opencode store)
  consumer registry (~50 curated third-party cache roots — consumers.mjs)
  known files (ledgers, tee logs, caches, indexes)
  project sources (own cross-host discovery)     host catalog surfaces (agents/skills/commands/MCP)
        |
        v
Collectors (bounded walkers; two tiers — src/lib/footprint/)
  walk.mjs            the one bounded walker + the Measurement vocabulary every collector shares
  project-sources.mjs cross-host project discovery (everSeen / onDisk)
  stack-registry.mjs  + stack-detect.mjs — languages (lines) vs frameworks/SDKs/tools (presence)
  cheap tier:   runtime.mjs census + known-file stats + carry-forward of last deep scan (TTL 60s)
  deep tier:    install.mjs + storage.mjs + catalog.mjs + projects.mjs + consumers.mjs
                                                          (explicit, single-flight)
  snapshot.mjs  persists the deep sections; index.mjs is the two-tier collector façade
        |
        v
FootprintSnapshot  { asOf, completeness, install, runtime, storage, catalog, projects, consumers }
  install:   HostInstallation[]   { tool, version, installMethod, root, bytes, nativeAddons[] }
  runtime:   RuntimeCensus        { processes[], daemons[], totals }        (ephemeral, never
                                                                             persisted)
  storage:   StorageBreakdown     { nodes: category → host → project → session, growth, topN,
                                    reclaimables[], reclaimSummary: { tiers[], combined: null } }
  catalog:   CatalogInventory     { skills[], agents[], commands[], plugins[], mcpServers[],
                                    each with per-host presence }
  projects:  ProjectFootprint[]   { path, label, remote?: {host, slug, webUrl}, stack: {languages,
                                    stack, unrecognized}, treeBytes, gitBytes, nodeModulesBytes,
                                    lastActivity }
             + counts { everSeen, onDisk, gitRepos, unresolved }
  consumers: ConsumerRanking      { rows[] (root | breakdown | residual), top[], groups[],
                                    totals, absent[], unmeasured[], includeProjectTrees }
        |
        v
Delivery
  GET /api/system            → cheap tier + persisted snapshot (token auth, loopback, no egress)
  GET /api/system?refresh=deep → start-or-attach the single-flight deep scan
  ak system [--deep] [--json]  → the same collector, CLI-rendered
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

A measurement additionally carries `partial`. A total whose inputs included an unreadable or
capped subtree is a **lower bound**, not a total: unknown inputs never contribute a zero, they set
`partial` on the sum. Every surface renders a partial figure as "≥ N" — a partial total presented
as a total would be the honest-degradation contract broken at the last mile.

### Install footprint

One `HostInstallation` per managed tool (ruflo, agent-browser, agentic-qe, Claude Code, Codex, OpenCode,
agentic-kit itself, the brain KB), carrying the version and install method the kit's existing
detection already knows (npm/mise/brew/self-managed), the resolved root path, tree bytes from
the deep walk, and a native-addon inventory — including the *duplicate-builds* view (the same
native module compiled into multiple trees), which is sprawl the user cannot see today.

An `ObservedRuntimeInstallation` represents a dependency-owned executor the kit can inspect but
does not manage; Vibium names Agentic QE as its update owner. Agent-browser is instead a managed
Ruflo executor whose package and config ownership are receipt-backed under ADR-0043. Each browser
row carries CLI presence plus a `BrowserPayloadReadiness` derived from the cache filesystem;
Vibium is ready only when browser and driver payloads share a revision. No readiness check runs
the executor, launches a browser, or downloads a payload.

Shared caches (npx envs, Playwright, Puppeteer, agent-browser, and Vibium browser binaries) are
install-adjacent nodes with their own rows, not smeared into a tool's tree. The machine's
free-space figure is the section's denominator, so "the install is X GB" always has a "of Y
free" next to it.

Two of those roots were measured at the wrong place, and the corrections are recorded here
because both changed a headline figure rather than a detail.

**The brain is measured whole, not at its KB.** `install.mjs`'s `brainRoot()` resolves the
installer's own `…/ruvnet-brain/kb` layout upward to the cache root and measures that. Measuring
`kbDir()` alone under-reported this machine's brain by 85%: 1.9 GB of active KB inside a 13.2 GB
cache root. The remainder is not one thing, so it is not one number — the row carries components
(`BRAIN_COMPONENTS`) that break the root into the active KB, the superseded `kb.bak-*` copies the
installer leaves behind on every update (5 of them, ~11 GB together on this machine), the
embedding models (~234 MB), and a remainder row so the parts add up to the whole. A user watching
a figure move from 1.9 GB to 13.2 GB is owed that breakdown, and the `kb.bak-*` copies are the
answer: nothing reads them, and they are the largest single reclaimable on this machine.

The upward resolution is deliberately conservative. Both path segments must match, because
`RUVNET_BRAIN_KB` can relocate the KB anywhere: a KB at `/mnt/data/kb` would make the parent a
directory the brain does not own, and billing a shared volume to the brain is a worse error than
under-reporting it. An unrecognized layout stays measured at the KB dir.

**Playwright has three platform locations and they are one cache.** Only the XDG and Windows
paths were probed, so on macOS — where `playwright install` writes to
`~/Library/Caches/ms-playwright` — a machine holding 1.86 GB of browser builds reported a
*measured zero*: honest about the XDG path that genuinely does not exist, wrong about the
question the row asks. All three are now probed and collapse into a single row. Two can be real
at once (a cache migrated between layouts leaves both; on macOS `~/.cache` is sometimes a symlink
into `~/Library/Caches`), so candidates are realpath-collapsed before summing and an aliased
target is measured once. When none exists, the platform-canonical path is the one named, so the
measured zero still says where it looked.

### Runtime census

A point-in-time table of live host processes — reusing the existing current-user, argv-minimized
survey and extending its `ps` read with `pcpu`/`rss` — plus the daemon census (count, and the
oldest daemon's age against the 12h TTL). The census is
**ephemeral**: computed per request, never persisted into the snapshot file, because a process
table is a moment, not a fact worth retaining, and persisting it would create a stale-liveness
trap. `snapshot.mjs` enforces this structurally — it serializes only the deep-tier keys (`install`,
`storage`, `catalog`, `projects`, `consumers`), so a census handed to it is dropped rather than
written.

Two figures this census once carried are deliberately gone. A **launch-budget** field could never
be populated: ruflo exposes no local state to read it from, so it was a permanent "unavailable"
rather than an honest degradation, and a permanently unknowable quantity is removed rather than
rendered (see [ADR-0023](../adr/0023-fail-closed-operations-and-explicit-degradation.md) §9). A
**child/MCP-server process count** is still computed by the survey — it is what makes the per-host
rows correct — but is no longer republished: as a rendered figure it was a bare number with no
denominator, no history, and no action attached to it.

The census is also the one deep-tier neighbour that refreshes on the dashboard's ordinary poll
clock while its view is open. It measures liveness, so a figure loaded once when the tab was first
opened is the one kind of staleness this area cannot tolerate — but only the cheap tier polls; the
filesystem walk stays behind an explicit rescan.

On **Windows** the census is real, not unsupported. `src/lib/live/win-process-survey.ps1` — a plain
text script invoked the way the POSIX path already invokes `ps` and `lsof`, with no npm dependency
and no compiled artifact — returns a guaranteed census (host, pid, ppid, start time, CPU, working
set) from `Get-CimInstance Win32_Process`, and command lines only for processes `GetOwner` proves
belong to the current user. The bound project comes from a **best-effort** P/Invoke read of the
process's own `CurrentDirectory` (`NtQueryInformationProcess` → PEB →
`RTL_USER_PROCESS_PARAMETERS`). When that probe fails — antivirus block, execution policy,
insufficient rights, WOW64 bitness mismatch — every other field still returns and the project
column degrades to an explicit "not attributable on Windows" carrying the reason. A row is never
dropped for being unattributable: a process we can measure but not attribute still consumes RAM,
and hiding it would understate the totals this whole area is denominated in. An empty census on
Windows is treated as a broken survey, never as an idle machine.

One field is honestly absent everywhere: the daemon **budget** state. `ruflo daemon budget` is a
CLI with no local file this collector can read, so budget reports `unknown` with that reason
rather than a figure inferred from absence of evidence.

### Storage breakdown

A tree of `StorageNode`s: category (transcripts / ledgers-and-logs / learning stores / kit
caches) → host → project → session leaf, each with bytes and file count. Derived views over the
same walk: trailing-30d growth per host (from mtime + size — no content reads), top-N largest
sessions and files, and advisory `ReclaimableCandidate` rows (stale npx envs, transcripts beyond
a stated age, superseded cache snapshots, regenerable package caches, redundant browser
revisions, extra runtime versions, orphaned worktrees), each carrying its rationale and its path.
Candidates are information, not actions — this context has no delete verb.

**Learning stores are reported on their own, not mixed into the shared charts.** On a real
machine they are ~99% of retained bytes, so a donut that includes them renders as a solid ring
and a per-host bar chart flattens every other series to a sliver — the chart stops being a
measurement and becomes a picture of one category. They get a single-figure card; the donut and
the per-host split cover the remaining three categories and **state the exclusion on the panel**.
This is presentation only: the collector measures all four categories and `ak system --json`
emits all four, unchanged. The per-host split likewise shows only real hosts (claude, codex,
opencode) and names the remaining bytes — ak's own state — in a footnote with its figure, so the
bars still account for the whole of the donut beside them rather than silently disagreeing with it.

Two honest limits belong with the numbers. **Growth is approximate and says so**: a file
contributes its whole size on its mtime day, which is exact for append-only transcripts and
over-counts rewritten SQLite ledgers, so the figure carries its own `basis` string. And **Codex
transcripts carry no project attribution**: rollout paths are dated, not project-scoped, and the
project name lives inside the file, which this domain may not open. Those nodes are marked
`attribution: 'none'` and render as "unattributable" — never blank, never zero.

### Largest consumers

The storage tree answers "where are *the kit's* bytes"; it does not answer "what is eating this
disk", and for a while the panel pretended it did. The Summary strip's ranking was assembled in
the browser from whatever the install and storage sections happened to carry, which made it wrong
in the one way a size ranking must never be wrong: it named the npx cache (6.64 GB) this
machine's largest consumer while `~/.npm/_cacache` — three and a half times larger — was not
scanned at all. The real order on this machine begins `~/.ollama` 141.31 GB, `~/.lmstudio`
48.78 GB, `~/.cache/huggingface` 35.92 GB, `~/.npm/_cacache` 22.26 GB, mise installs 16.30 GB,
Docker 15.47 GB, rustup 14.62 GB, the pnpm store 13.40 GB, the brain 13.18 GB. The npx cache is
eleventh.

`consumers.mjs` therefore owns the ranking as a first-class view over a **curated registry** of
~50 third-party cache roots — Ollama, LM Studio, Hugging Face, the npm/pnpm/yarn/bun caches,
rustup and Cargo, Go's module cache, uv and pip, Maven and Gradle, Playwright and Puppeteer,
mise, Homebrew, Docker — grouped by *ecosystem*, because the actionable question is which
toolchain is costing the disk: four Node package caches at 5 GB each is a Node answer, not four
unrelated rows. Third-party cache conventions live in that module rather than in `paths.mjs`,
which owns the kit's and its hosts' own locations and should stay auditable as such.

A size ranking is trivially made dishonest, so three accounting rules are structural:

- **Containment.** Roots nest — `~/.npm` contains `_cacache` and `_npx`; `~/.cache` contains
  `huggingface`, `ruvnet-brain`, `puppeteer`, `pnpm` and `uv`; `~/.local/share` contains `mise`,
  `pnpm`, `claude` and `opencode`; mise's installs tree contains the Node install that contains
  the npm global root the install section already walks. Bytes are counted **once**, at the
  outermost row (`kind: 'root'`); every enclosed row is a `kind: 'breakdown'` that explains its
  parent instead of competing with it. Containment is *derived* from resolved paths, not
  hand-declared, so a registry edit cannot silently start double-counting. Only roots are ranked
  and only roots are summed. Without this rule the list is self-similar and the total is fiction.
- **Residuals.** A parent with breakdowns also gets a synthesized `<parent>:other` row — parent
  minus its direct children — so a breakdown always adds up. This is what makes the brain row
  legible: 13.18 GB, of which 1.9 GB is the active KB and ~11 GB is superseded `kb.bak-*` copies.
  Merging the two figures and reporting only the KB are both ways of being wrong about the same
  11 GB. An unknown input makes the residual unknown, never a difference taken against a
  fabricated zero, and a negative residual reports itself rather than rendering as a plausible
  small number.
- **Project trees are opt-in.** One repository on a working machine can outweigh every shared
  cache combined (175 GB here), and a bar chart containing it is a bar chart of one repository.
  `includeProjectTrees` defaults to false and the exclusion is **stated in the payload**
  (`consumers.projectTrees.reason`), never silent — an omitted category the reader cannot see is
  the same failure as an unknown rendered as zero.

Absent roots are not consumers: a cache root that does not exist is reported in `absent` with its
path — "we looked, it is not here" — and kept out of both the ranking and the group totals rather
than ranked as a zero-byte consumer. Unreadable roots are reported in `unmeasured` with their
errno and make the affected group total `partial`; they are never a zero.

Two roots need a basis other than apparent size, and say so. Docker Desktop's VM image is a
sparse file whose apparent size here is ~4 TB against ~15 GB actually written, so it is measured
in **allocated blocks** and carries both figures plus a `basis` string; an apparent-size reading
would put a number larger than the disk at the top of the ranking. And figures the install or
projects scan already measured for the same path are **adopted** rather than re-walked, which is
why a row can name its `measuredBy`.

This is deep-tier work by construction — a 22 GB content-addressable cache is ~10⁵ files — and it
carries its own raised walk caps (`CONSUMER_WALK_LIMITS`: depth 24, 2,000,000 entries) because
the walker's defaults were sized for install trees and transcript roots. Measured: rustup
exhausted the default entry cap at 9.4 of its 14.62 GB, and pnpm's content store, LM Studio and
`~/.claude` all bottomed out on depth 16. A ranking whose deepest trees are systematically floors
does not merely under-report them, it **mis-orders** the answer. Raised, not removed: a root that
exhausts even these still reports `≥`.

### Reclaimable safety tiers

Safety is a field, not a tone of voice. Every `ReclaimableCandidate` carries `safety`:

- **`regenerable`** — the owning tool refetches it on demand. The npm content cache, the Homebrew
  download cache, the brain's superseded `kb.bak-*` copies, stale npx envs.
- **`review`** — plausible but **not** safe to state as removable. Aged transcripts (a transcript
  is the only copy of the session it records, and Historical usage is denominated in them); extra
  runtime versions (mise has eight Node entries on this machine and some are the aliases a live
  toolchain resolves through); a browser revision that may still be pinned by an installed
  package. A review row is a pointer at something to look at.

Each row also carries `bytesMeaning`: `candidate` (the bytes the row is actually about) or
`installed` (what is on disk at that path, offered as context on a review row that has no
defensible candidate subset). `keeps` names what was excluded from the figure because it is in
use, and `cleanupHint` names the CLI that already owns removal — documentation, not a command
this module runs.

**The tiers never sum into one headline number.** `summarizeReclaimables` totals each tier
separately and sets `combined: null`, permanently. A combined "you could free N" that mixed a
regenerable cache with a runtime tree that may be live would produce the one number a reader
would act on and the one number this domain cannot stand behind. Two further rules keep even the
per-tier totals honest: only `bytesMeaning: 'candidate'` rows are summable, and a tier whose own
rows describe overlapping paths (an aged transcript can also sit under a project that no longer
exists) reports its total as unknown-with-reason rather than counting the same bytes twice — the
row count still stands, and every row still carries its own measured figure.

Reclaimables are their own area rather than a card under a measurement. Everything else in this
context reports what **is**; this is the only surface that suggests what a user might **do**, and
that difference is worth a tab of its own — buried under a byte chart it read as another statistic.
It still has no delete verb and may never gain one.

The rows render as one scrollable table ordered regenerable-first, not as two stacked blocks of
paragraph-bearing cards. The tier pill survives that change because it is what distinguishes the
two promises at a glance, and only the regenerable pill carries bytes: on a row that may be in
use, a figure in the pill would read as "this much is yours to take back", which is a claim the
measurement does not support. A review row's bytes stay in the size column, marked as context.

The surfaces honour the split structurally: the `review` tier is rendered without a leading total
at all, and its bytes ride each row as context, so the block cannot be read as "N GB available
here". A row from a snapshot predating the `safety` field lands in `review` — the tier that
promises less — never in the one that reads as free space.

### Catalog inventory

Deduplicated `CatalogItem`s across hosts — skills, agents, commands, plugins, MCP servers —
keyed by normalized name, each with a per-host presence matrix (which hosts carry it, from which
surface it was observed). Counting is by manifest/directory-entry **names** on the host catalog
surfaces Integration management already projects into; item file contents are not parsed beyond
what naming requires. Scope is **user plus the launching repository plus every observed project
still on disk**. The launching root is included explicitly because a fresh repository has no
transcript yet; a skill defined in any observed repository is as deployed as one in `~/.claude`,
and the question this inventory answers is what the machine carries. Deduplication by `(kind,
name)` means a name defined in five projects is still one row, so the inventory grows with distinct
names rather than with project count.

The presence matrix carries two independent multi-select filters — by kind and by host — with every
option selected at first paint, so the default remains the whole inventory. The host filter matches
**any** selected host rather than all of them: "carried by codex" is the question a reader is
asking, and intersecting would answer a different one. A filtered view states how much it is
hiding, and each row carries its own kind, because a filtered list must never leave a name
unexplained. The config-surface row (managed CLAUDE.md/AGENTS.md block count, settings
file sizes) lives here because it answers the same "what is deployed" question.

### Project accounting

**The Projects table lists repositories, not directories.** A row is rendered only when it has a
remote and a host has recorded a session in it. Without that rule the table listed ephemeral
`.claude/worktrees/agent-*` checkouts, sub-folders a session happened to run in, and home
directories, each beside its own parent repository as though it were a peer with its own
multi-gigabyte figure. The session test excludes an empty host list, never a missing one — a
snapshot predating that field cannot answer the question, and reading absent as zero would blank
the table. Excluded directories are counted and characterised beneath the table.

**Two numbers, not one.** `discoverProjectSources()` publishes `everSeen` and `onDisk`, and they
are different questions:

- **`everSeen`** — every distinct project any host has ever recorded a session in, *including*
  the ones since deleted or moved. The deletions are the point, so they are never dropped.
- **`onDisk`** — the subset that still resolves to a directory, i.e. the only projects a byte or
  line measurement can be taken of at all. Only these become table rows; the vanished ones
  survive in `everSeen`, not as unmeasurable rows.

On this machine: **50 ever seen, 25 still on disk, 21 of those git repositories.** The gap is the
figure, not an error.

This domain deliberately does **not** reuse `discoverRuvfloProjects()`. That function answers a
different question — "which projects carry ruflo learning state" — by requiring a
`.claude-flow/neural/` directory and by reading only the 150 most-recently-modified transcripts
per host. Both narrowings are correct there and wrong here: on this machine they collapse ~50
projects to 5. The Intelligence panel keeps that meaning; System has its own source with its own
stated method.

**De-duplication is by resolved real path.** One project touched by Claude, Codex and OpenCode is
one project; a project reached through a symlink is the same project as the one reached directly.
Each sighting's `cwd` is `realpath`-resolved before it keys the map, falling back to
`path.resolve` when the target cannot be resolved — a deleted project has no real path and must
still be counted. A row therefore carries the set of hosts that saw it, its session count across
all of them, and its most recent sighting.

**Claude's transcript-directory encoding is lossy, and this domain refuses to fake a decode.**
`~/.claude/projects/<encoded>/` encodes the project path by replacing `/`, `.` **and a literal
`-`** all with `-`, so `-Users-me-ai-agentic-kit` reads equally as `/Users/me/ai/agentic/kit` and
`/Users/me/ai/agentic-kit`. There is no safe pure-string decode. Measured on this machine's
corpus: naive `-`→`/` substitution resolves **8 of 52** directories — wrong for 85% of them.
`decodeClaudeProjectDir` therefore walks the candidate segments against the real filesystem and
returns a path only when the filesystem confirms it, under its own `lstat` budget; even that
verified walk can name only 18 of the 52 from the directory name alone.

Which is why the encoded name is a **fallback, not the source**. The path comes from the
transcript's declared `cwd` (2,538 of 2,585 Claude transcripts here carry one; all 175 Codex
rollouts do; OpenCode's store carries an absolute `directory` per session). The decoder is
consulted only for a project directory where *no* transcript declares a `cwd` — one such group on
this machine. When neither route resolves, the group is counted as **`unresolved`** and
contributes no row: it is never given a fabricated path, and its existence makes `everSeen` a
**lower bound** rather than a total (`complete: false`). Every project row carries `origins`
saying which route named it (`cwd` or `encoded-dir`), so a fallback-derived path can never be
mistaken for a declared one.

Codex is left out of the fallback entirely: its rollout directories are dated, not
project-scoped, so there is nothing to decode.

### Project footprint

One `ProjectFootprint` per **on-disk** project: working-tree bytes, `.git` bytes, `node_modules`
bytes (kept separate precisely because it dominates and distorts), last activity, and a detected
stack. LOC figures are labeled approximate wherever they render; this domain forbids presenting
them as authoritative.

**Lines belong to languages; frameworks are presence only.** `stack-detect.mjs` returns
`languages` with a line count, because a file extension is what a line belongs to — and `stack`
entries (frameworks, SDKs, tools) with **no `lines` field at all**. React does not own lines, the
`.tsx` files do, and stacking both on one proportional bar would count the same bytes twice.
Nothing downstream can make that mistake by accident because the number simply is not in the
payload. `stack-registry.mjs` is the versioned data behind both, and every detection carries its
`registryVersion` and its `via` (which manifest or signature named it).

**The unrecognized tail is the point.** An extension the registry does not map is never counted
as lines — most unmapped extensions on a real machine are binaries and data — so it is tallied
*by name* instead, as is every declared dependency that matched no registry entry. That converts
the usual silent "Other" slice into a to-do list a release can close. The tail admits only what
belongs in it: an extension the registry has already ruled out as non-source (`.png`, `.sqlite`)
is a stated exclusion counted separately, and a key that is not shaped like an extension at all
(`.2026-08-06`, from a rotated log) collapses into a named bucket rather than minting a thousand
single-file "extensions". `STACK_EXCLUSIONS` ships attached to the figure, so no surface can
render a line count without being able to state what it left out.

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

**A deep scan never runs on its own.** Opening the System area issues a plain `GET /api/system`;
only the Rescan control adds `?refresh=deep`. A deep scan costs tens of seconds of I/O on a large
corpus, and making the act of *looking* cost that is a worse trade than a stale figure that states
how stale it is. Staleness is therefore surfaced rather than pre-empted: every deep-tier figure
renders with its snapshot's `asOf`, and past `SNAPSHOT_STALE_AFTER_MS` (7 days) the freshness
label turns amber and reads "stale, rescan". The client polls only while a user-started scan is
running, and stops when it finishes.

One deliberate divergence from Observability's delivery: absolute paths are **part of this
payload**. `publicLivePayload`'s leaf-only rule exists to keep incidental provenance out of
session payloads; here the path is the answer ("where are the bytes"), and the same token-gated
loopback delivery protects it. Message content remains structurally absent from the payload: the
collectors never take it out of a file ([the read surface](#the-read-surface)), so delivery has
nothing to leak.

The CLI twin (`ak system`) renders the same collector output, `--json` emitting the collector's
payload verbatim, following the one-collector-two-surfaces precedent of the usage scorecard.
`ak system --deep` is the terminal spelling of the Rescan control and writes the same snapshot.

## Invariants

1. **Metadata only, ever — and the reads are enumerated, not asserted.** The complete list is
   [The read surface](#the-read-surface); it is normative, and a read not on it is a defect.
   Collectors read directory entries and `stat` results; `.git/config`'s remote URL;
   `.git/worktrees/<name>/gitdir` (bounded to 4 KB, validated as an absolute path) for the
   orphaned-worktree candidate, which no `stat` can identify; a transcript head's `cwd` **field**
   and OpenCode's session `directory` column, for project discovery; a project manifest's
   dependency **keys**; and a source file's bytes streamed through a fixed buffer to count
   newlines. Every one of those yields a path, a name, or an integer. **No message body, prompt,
   tool call, tool result, model output, or manifest value enters this domain, in any tier, on
   any path**, and nothing read is retained past the function that read it.
2. **Unknown is never zero.** An unmeasured or failed measurement renders as unknown with a
   reason; a measured zero renders as zero. A total built over an unknown or capped input is
   `partial` and renders as a lower bound. No fabricated figures.
3. **Freshness is part of the value.** Every deep-tier figure carries the snapshot `asOf` it came
   from; carried-forward data is never presented as current. A deep scan runs only when a user
   asks for one — opening the area never triggers it — and staleness past the stated threshold is
   surfaced as a nudge, not silently repaired.
4. **This context mutates nothing.** No delete, prune, or cleanup verb exists here; reclaimable
   candidates are advisory rows with rationale, each carrying a `safety` tier and a
   `bytesMeaning`. (The snapshot file it owns is the sole write.)
5. **The runtime census is ephemeral.** It is computed per request and never persisted; a stale
   process table is never replayed as liveness.
6. **Bounded walkers.** Symlinks are never followed; depth and entry caps apply; one unreadable
   subtree degrades that node to unknown without discarding siblings or aborting the scan.
7. **Single-flight deep scans.** Concurrent refresh requests attach to the in-flight scan; two
   scans never race each other or double-write the snapshot.
8. **No spend, no activity, no learning facts.** Tokens/cost stay in Historical usage; session
   lifecycle/evidence stays in Observability; learning counters stay in Project intelligence.
   Cross-links, not duplication.
9. **Discovery supplies paths, not measurements.** The project catalog contributes candidate
   locations only; everything rendered is measured by this domain's own collectors. A path that
   cannot be resolved is reported as `unresolved` and never fabricated, which makes `everSeen` a
   lower bound rather than a guess.
10. **Catalog counts are observed inventory.** They state what is on disk per host surface,
    never desired state, and never upgrade Integration management's ownership facts.
11. **LOC is approximate and says so.** Extension-bucketed line counts with stated exclusions;
    no rendering presents them as authoritative. Lines belong to **languages** only: frameworks,
    SDKs and tools are detected by presence and carry no line count in the payload at all, so no
    surface can double-count the same bytes under a framework's name.
12. **Same delivery protections as the rest of the dashboard.** Loopback, token auth, GET-only,
    zero egress; the absolute-path exception is deliberate, documented, and content-free.
13. **Every platform reports what it can, and names what it cannot.** No section is switched off
    for a platform. Where a per-platform probe fails, that field alone degrades with its reason
    and the row keeps every other measurement; a row is never dropped for being unattributable.
14. **Sizes are counted once, and every exclusion is stated.** In the largest-consumers ranking
    nested roots are counted at the outermost row only; enclosed rows are breakdowns that explain
    their parent rather than competing with it; a residual row makes every breakdown add up to
    its parent; absent roots are listed as absent rather than ranked as zero-byte consumers; and
    a category excluded by default — project working trees — states its exclusion in the payload.
15. **Reclaimable tiers are never summed together.** `regenerable` and `review` are separate
    promises with separate totals; `combined` is `null` by design. Only `bytesMeaning:
    'candidate'` rows are summable, and a tier whose rows describe overlapping paths reports
    unknown-with-reason rather than counting the same bytes twice.

## Ubiquitous language additions

These terms are merged into [Ubiquitous language](ubiquitous-language.md); that glossary is
normative and this table restates it for readers of this document.

| Term | Meaning |
|------|---------|
| Footprint | The machine-resource cost of the toolchain: install bytes, runtime CPU/RSS, retained-data bytes, deployed inventory. The context's name; the surface is **System** |
| FootprintSnapshot | The persisted result of a deep scan: `asOf`, completeness, and the deep-tier section models (install, storage, catalog, projects, consumers) |
| Measurement | A value plus provenance: measured (with `asOf`), carried forward, or unknown-with-reason — unknown is never zero |
| Partial measurement | A measured value known to be a lower bound because a contributing subtree was unreadable or capped; rendered as "≥ N" |
| HostInstallation | One managed tool's install facts: version, install method, root, tree bytes, native addons |
| ObservedRuntimeInstallation | A dependency-owned executor's observed CLI and payload facts, with `managed: false` and an explicit upstream update owner |
| BrowserPayloadReadiness | Filesystem-derived browser payload status, revision, cache path, and reason; it never launches or installs the runtime |
| RuntimeCensus | The ephemeral point-in-time table of live host processes, daemons, and machine denominators |
| StorageNode | One node in the category → host → project → session breakdown: bytes + file count |
| ReclaimableCandidate | An advisory row naming reclaimable space, its path, and its rationale — never an action |
| Safety tier | A candidate's `regenerable` (the owning tool refetches it) or `review` (plausible, not safe to call removable). The two are totalled separately and never combined |
| Bytes meaning | Whether a candidate's bytes are the `candidate` subset it is about, or the `installed` size at that path offered as context on a review row |
| Consumer root | A ranked top-level storage root. Nested rows are `breakdown`s of it, plus a synthesized residual, so bytes are counted once |
| Ever seen / on disk | `everSeen` is every project any host ever recorded a session in, deletions included; `onDisk` is the measurable subset. Different questions, never one number |
| Unresolved project | A transcript directory whose project path neither a declared `cwd` nor a filesystem-verified decode can name. Reported as such, never given a fabricated path; it makes `everSeen` a lower bound |
| Stack detection | Per-project `languages` (which carry lines) and `stack` — frameworks, SDKs, tools — which carry presence only, plus the unrecognized tail of extensions and dependency names the registry could not name |
| CatalogItem | A deduplicated deployed artifact (skill, agent, command, plugin, MCP server) with a per-host presence matrix; Codex project `.agents/skills` stays attributable separately from user/plugin surfaces |
| ProjectFootprint | One project's size facts: approximate LOC by language, tree/`.git`/`node_modules` bytes, last activity, and an optional git-remote web link ("local only" when absent) |
| Deep scan | The explicit, user-triggered, single-flight full measurement pass that produces a FootprintSnapshot |
| Cheap tier | The per-request census + known-file stats + snapshot carry-forward served on every read |

## References

- [ADR-0025](../adr/0025-machine-footprint-metrics.md) — the decision record this domain implements
- [Context map](context-map.md) — where this context sits
- [Historical usage / Observability / Project intelligence](context-map.md) — the neighboring
  contexts this domain is deliberately distinct from
- [Dashboard guide](../DASHBOARD.md)
- `src/lib/footprint/` — the collectors: `walk.mjs` (the bounded walker and the `Measurement`
  vocabulary), `install.mjs`, `storage.mjs`, `runtime.mjs`, `catalog.mjs`, `projects.mjs`,
  `consumers.mjs` (the ranked largest-consumers view), `project-sources.mjs` (cross-host project
  discovery), `stack-registry.mjs` + `stack-detect.mjs` (languages, frameworks and the
  unrecognized tail), `snapshot.mjs`, `index.mjs`
- `src/commands/system.mjs` — the CLI twin; `src/lib/live/win-process-survey.ps1` — the Windows
  process survey
