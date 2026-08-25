# Dashboard

`ak dashboard` opens an observation-only local diagnostic workspace. It binds to loopback, requires
the per-session dashboard token for every API route, and does not mutate configuration, agents, or
repositories.

```bash
ak dashboard

# Do not open a browser automatically.
ak dashboard --no-open
```

The dashboard has five primary areas, in this order: **About**, **Overview**, **Usage**,
**Observability**, and **System**. The row directly below them is one fixed, left-aligned secondary
navigation rail. Its position does not move when the primary area changes; only the choices inside
it change — About is the one area with no views to choose between, so its rail carries jump links
to the sections of its single page instead.

About is leftmost because it is the reading-order entry point for someone who does not yet know
what the other tabs mean. **Overview remains the landing view on every open, including the first.**
A first visit shows a dismissible "new here?" nudge on Overview pointing at About; dismissing it is
permanent.

## Navigation and deep links

| Primary area | Secondary view | Canonical hash | Heading | What it answers |
|--------------|----------------|----------------|---------|-----------------|
| About | (whole page) | `#about` | Meet your toolkit | What agentic-kit installs and configures, what each piece is for, and where to read more |
| About | Hosts | `#about/hosts` | Hosts | The coding agents themselves: Claude Code, Codex, OpenCode |
| About | Engine & memory | `#about/engine` | Engine & memory | ruflo and agentdb — orchestration, cross-session memory, learning |
| About | Quality · Safety · Knowledge | `#about/quality` | Quality · Safety · Knowledge | agentic-qe, the prompt-injection defense, and the offline knowledge base |
| About | The kit | `#about/kit` | The kit | agentic-kit itself — what installs, heals, and explains the rest |
| About | Configured for you | `#about/configured` | Configured for you | Non-package surfaces ak set up on your behalf, each with the command that manages it |
| Overview | Summary | `#overview/summary` | System overview | Overall readiness, configuration health, and items needing attention |
| Overview | Hosts & Routing | `#overview/hosts` | Hosts & routing | Enabled execution hosts, activity assignments, primary-host policy, and escalation paths |
| Overview | Providers | `#overview/providers` | Inference providers | Provider bindings, availability, provenance, and configuration health |
| Overview | Runtime | `#overview/runtime` | Runtime health | Local services, MCP connections, processes, and operational readiness |
| Overview | Intelligence | `#overview/intelligence` | Intelligence & learning | Machine-wide learning rollup across every project with memory or intelligence state, plus near-live detail for one explicitly selected project |
| Usage | Scorecard | `#usage/score` | Usage scorecard | Token consumption, API-equivalent cost, efficiency, and trends |
| Usage | Limits | `#usage/limits` | Provider limits | Current provider windows, reset timing, and available capacity |
| Usage | Findings | `#usage/findings` | Usage findings | Actionable anomalies, efficiency opportunities, and evidence-backed recommendations |
| Usage | Sessions | `#usage/sessions` | Session usage | Retained sessions grouped by project, category, duration, tokens, and cost |
| Usage | Models | `#usage/models` | Model lifecycle | Host inventory, lifecycle changes, consumers, swap impact, and evidence sources |
| Usage | Transcript | `#usage/transcript` | Transcript detail | The selected session's locally retained, server-masked evidence |
| Observability | Live | `#observability/live` | Observability · Live | Projects and roots with current presence or fresh meaningful activity |
| Observability | History | `#observability/history` | Observability · History | Retained roots that are not currently Live |
| System | Summary | `#system/summary` | Summary | Install size, retained data, live resource use, deployed inventory, and the machine's largest storage consumers in one glance |
| System | Advisory | `#system/advisory` | Advisory | What could be reclaimed, in two safety tiers reported separately and never added — the only System area that suggests an action, and it still has no delete control |
| System | Sessions | `#system/sessions` | Sessions | The largest individual session files, the project each belongs to, and its share of that host's retained bytes |
| System | Storage | `#system/storage` | Storage | Where the retained bytes are, by category and host — learning stores counted separately because they dwarf everything else — plus per-series growth |
| System | Runtime | `#system/runtime` | Runtime | Live host processes, their CPU and memory, background daemons, and machine denominators — refreshed on the header's poll clock while open |
| System | Catalog | `#system/catalog` | Catalog | Every deduplicated skill, agent, command, plugin and MCP server across user scope and all projects on disk, with a per-host presence matrix and kind/host filters |
| System | Projects | `#system/projects` | Projects | Every repository with a remote that a host has recorded a session in — its approximate lines of code, language mix, total disk size and last activity. Worktrees, sub-folders and remote-less repositories are counted below the table, not listed |

About is one scrolling page, so its hashes scroll to a section rather than swapping panels; `#about`
alone opens the page at the top.

Opening a transcript replaces `transcript` with the URL-encoded session ID:
`#usage/<session-id>`. These hashes select state inside the one page; they do not create separate
servers or weaken the dashboard token boundary.

### Keyboard behavior

The primary row and every secondary row are ARIA tab lists with one selected tab in the keyboard
order.

- `Left Arrow` and `Right Arrow` select and focus the previous or next tab, wrapping at the ends.
- `Home` selects and focuses the first tab in that row.
- `End` selects and focuses the last tab in that row.
- `Tab` moves into or out of the active row normally.
- `Enter` or `Space` activates ordinary buttons such as expanders, chevrons, and map controls.

Every view supplies its own heading and short description beneath the shared navigation. Badges on
Overview child views remain scoped to those views, while Summary aggregates the items that need
attention.

## About

About introduces every component agentic-kit installs or configures, for a reader who has not met
any of them. It opens with one orientation sentence and a short map of how the pieces relate, then
one card per component grouped into sections: hosts, engine and memory, quality/safety/knowledge,
the kit itself, and the surfaces ak configured for you.

Each card carries an icon, the component name with a state chip, a plain-language tagline, one
short paragraph explaining what the thing does for you, and a row of link pills — source (GitHub),
package (npm), and public docs. Configured surfaces use the same card shape but swap the link pills
for the command that manages them, because "where do I change this" is their equivalent of "where
do I read more".

Two rules make the page trustworthy:

- **The prose is authored; the chip is measured.** Every paragraph reads the same on a machine
  where the component is absent. Whether something is installed, at what version, or configured
  comes only from the same detection Overview reports — never from the copy.
- **Absent evidence reads as unknown, not as good news.** If the status fetch fails, every chip
  reads `state unknown` and every card still renders. A surface whose verdict `ak status` does not
  publish — currently the permission allowlist — reads `state unknown` permanently rather than
  claiming to be configured.

Links are ordinary anchors you click in your own browser. The dashboard never fetches them.

`ak about` prints the same directory in a terminal; `ak about --category configured` narrows it,
and `ak about --json` emits the entries with their detected state.

## Overview

Overview keeps status and routing in one health-first area:

- **Summary** presents the overall verdict, attention items, and subsystem map.
- **Hosts & Routing** presents execution-host health, the primary-host policy, per-activity routes,
  escalation paths, and routed host models. A configured route is assignment intent, not evidence
  of which inference provider served a particular session.
- **Providers** presents inference-provider bindings and their configuration provenance.
- **Runtime** presents operational services, processes, and MCP readiness.
- **Intelligence** presents memory, learning, and quality-improvement signals machine-wide: an
  always-visible rollup folded across every project on this machine where memory or intelligence has
  been activated — a `.claude-flow`, `.agentic-qe` or `.swarm` directory, whichever host created it
  — plus detail
  for one explicitly selected, explicitly labeled project — the neural pattern store's current
  size, its separate lifetime patterns-learned counter, and reasoning-graph growth. Project
  selection defaults to whichever discovered project was most recently active; there is no implicit
  current-working-directory default. The route-learner's improvement delta remains scoped to the
  dashboard's own launching project and is not part of project selection. Detail data reads files
  ruflo/agentic-qe already write under `.claude-flow/` and updates near-live over a per-project SSE
  stream while the view is open, falling back to the general status poll otherwise. See
  [Project intelligence](ddd/project-intelligence.md) and
  [ADR-0024](adr/0024-project-intelligence-telemetry.md) for the full model and the two learning
  metrics' load-bearing distinction, and [ADR-0027](adr/0027-shared-project-census.md) for project
  discovery.

### Why project counts differ between tabs

Every area derives its project list from one census, so a project means the same thing everywhere —
a session run in `myrepo/backend` belongs to `myrepo`, not to a project called `backend`, and an
agent worktree is not a peer of the repository it was cut from.

The totals still differ, because the tabs ask different questions:

| Tab | Counts | Over |
|---|---|---|
| Overview → Intelligence | projects with learning state | all time |
| Observability → History | projects with retained sessions | the selected history window |
| Usage → Scorecard | projects with recorded usage | the selected day window |
| System → Projects | **directories** ever seen, and the subset still on disk | all time |

Two of those differences are structural rather than temporal. System counts **directories**, because
only a directory has bytes and lines to measure; the other tabs count **projects**. And a windowed
count is smaller than a lifetime one by exactly the projects you have not touched lately — a shorter
window, not a missing project.

Each count carries the sentence explaining what it counted; on Intelligence it is behind
**how these projects were counted**, next to the rollup.

## Usage

Usage loads lazily when first opened. Scorecard, Limits, Findings, Sessions, Models, and Transcript share the
same secondary rail; the 7/14/30-day filters remain aligned to its right.

### Reading a session row

Projects begin collapsed. Expand a project to reveal its session rows. Each row deliberately keeps
identity axes separate:

- the compact host badge states only the execution host: Claude Code, Codex, or OpenCode;
- the leading chevron expands an independent detail strip without opening the transcript;
- the detail strip reports execution host, inference provider, provider provenance, model or models,
  classification basis, token details, tools, and flags;
- clicking the rest of the row opens the locally retained masked transcript.

Host, inference provider, provenance, and model are independent facts. The dashboard never derives a
provider from a host name or model string. Codex `session_meta.model_provider` and equivalent
`turn_context` evidence are reported as **observed**. Native Claude transcript history does not name
the serving provider, so a historical row may honestly show **Not recorded**. That is missing
evidence, not a claim that Claude Code was served by Anthropic or by any provider inferred from its
model.

Usage transcript masking happens on the server. Redaction is marked, there is no reveal or export
control, and the original masked value never reaches the browser. See
[ADR-0009](adr/0009-usage-scorecard-local-transcript-analytics.md) for the full evidence and pricing
contract.

### Models

Models is a cache-only lifecycle evidence view backed by `/api/models`. It never performs discovery
or invokes a model; `ak models refresh` owns collection. The first panels answer two different
questions: **Observed in this window** aggregates actual retained transcript evidence for the same
7/14/30-day selector used by Usage, while **Your routes** names configured primary and fallback
models and joins their actual last-use timestamp when one exists in that window. GPT, Claude,
OpenCode, or local models therefore do not disappear merely because they are not pinned to a route.
The collapsed catalogue separately answers what is installed or discoverable; catalogue presence
does not claim use.

The view fetches a compact, windowed summary first, then a 50-row relevant inventory page. Search
and facet-counted filters for host, model provider, relevance, lifecycle, and evidence request fresh
bounded pages; controls with fewer than two meaningful choices are suppressed. **Load 50 more**
appends the next page. Every meaningful column header is a keyboard-operable sort button
that toggles ascending and descending order, exposes `aria-sort`, and leaves unknown values last.
Later pages carry the privacy-projected snapshot id; if refresh replaces the snapshot, the browser
reloads page one instead of mixing two inventories. A failed later page preserves the rows already
shown and leaves a focused retry control.

The inventory region is height-bounded and scrolls internally in both axes. Change history is also a
bounded, internally scrollable table; it names the exact model, provider, host, plain-language change,
evidence status, and detection time instead of exposing an opaque identity join. The route-consumer
panel remains bounded beside it. These lifecycle panels are structurally owned by Usage → Models and
are never rendered in Scorecard, Limits, Findings, Sessions, or Transcript.
Its header stays sticky. The region is labelled and keyboard-focusable, with a caption, column
scopes, `aria-busy` loading state, result and load
announcements, visible focus, and an explicit load control in addition to lazy fetching.

Source-proven public catalogue records show readable names and trusted source links while private
deployments remain keyed pseudonyms. OpenCode rows need an exact Models.dev join from explicit
online refresh; selector syntax or verbose metadata alone never makes a row public. Host, serving
provider, publisher, model selector, catalogue source, and entitlement remain independent. Each
state and lifecycle value expands to its source,
class, capture time, freshness, completeness, scope, or a field-specific explanation of missing
evidence. Model-specific foreground/background pairs meet WCAG AA in both themes, and the same table
remains operable at narrow widths.

The Overview Model lifecycle summary links to `#usage/models`. The view has no mutation control.
It points to the read-only `ak models plan` command, which can emit a copyable canonical
`ak host pick` action but cannot execute it. See [Model lifecycle intelligence](MODELS.md).

The Scorecard view also shows a host-neutral **telemetry coverage** panel for Claude, Codex
transcript evidence, and OpenCode. It reports parsed units and observed prompt/response totals, plus
capability states (`supported`, `unsupported`, or `unavailable`). A readable source with no observed
activity is a measured zero; an absent, degraded, or old API response is disclosed as unavailable or
not reported rather than rendered as zero. The Codex transcript card does not merge the separate
`codexLedger` corrective source into its coverage counts.

## Observability

Observability separates navigation scope from playback state:

- **Live** and **History** are mutually exclusive secondary views.
- **Follow Live** and **Review** describe how one selected session is presented.
- switching between Live and History clears incompatible project/session selection.

Its workspace contains the project/session browser, the **Agent activity** execution map, and the
selected **Session stream**. Use the stream header's chevron to collapse or expand that rail. Collapse
hides the stream body but does not close the selected transcript connection or stop ingestion; it
widens Agent activity on desktop. The choice is stored locally and restored on the next dashboard
visit. The compact rail keeps the chevron available. On narrower screens the stream moves below the
browser and map; when collapsed it becomes a compact full-width restore bar instead of consuming a
full transcript-height row.

The chevron is a real button. Its `aria-expanded`, accessible label, and tooltip describe the next
action, and activating it with Enter or Space announces whether the stream was collapsed or expanded.
This control is presentation-only; **Pause stream** separately controls visual application of live
updates.

See [Observability](OBSERVABILITY.md) for the map legend, workspace facts, host capability coverage,
History/Review semantics, privacy limits, and troubleshooting.

## System

System answers what this toolchain costs the machine itself — a different question from health
(Overview), spend (Usage), or activity (Observability). Its seven views are Summary, Advisory,
Sessions, Storage, Runtime, Catalog, and Projects. Projects stays separate from Storage on purpose:
lines of code and a git remote answer "what have I built here", not "where are my bytes".

### Two tiers, and why nothing scans on open

Opening System costs almost nothing. The cheap tier — the live process census, individually known
file sizes, and the figures carried forward from the last deep scan — is served on every read and
cached briefly.

Everything else comes from a **deep scan**, which walks the install trees, the retained-data roots,
every host's catalog surfaces, and every known project. That is real I/O and takes tens of seconds
on a large machine, so it runs **only when you press Rescan** (or run `ak system --deep`). Opening
the tab never triggers it, and System does not poll: it fetches once, then again only while a scan
you started is still running.

The trade is stated rather than hidden. Deep-tier figures always render with when they were
measured, and once a snapshot passes seven days the freshness label turns amber and reads
`stale, rescan`. A scan writes one file — its own snapshot — and nothing else; the reclaimable-space
rows are advisory, with their rationale and their path, and there is no delete button anywhere in
this area.

### Largest consumers, and the project-trees toggle

The Summary strip ranks the biggest storage roots on the machine — not just the kit's own. On a
working machine the top of that list is usually local model weights, package caches and toolchain
installs, so the strip covers around fifty known cache roots (Ollama, LM Studio, Hugging Face,
npm/pnpm/yarn/bun, rustup and Cargo, Go, uv and pip, Maven and Gradle, Playwright and Puppeteer,
mise, Homebrew, Docker) alongside the kit's own. **Ranked** and **By ecosystem** re-shape the
same measurement; the ecosystem view is usually the more actionable one, because four Node caches
at 5 GB each is a Node answer, not four unrelated rows.

Nested roots are counted **once**, at the outermost row. `~/.npm/_cacache` sits inside `~/.npm`,
`~/.cache/huggingface` inside `~/.cache`, the npm global root inside mise's Node install — so a
row inside another row is shown as a *breakdown* of its parent and is left out of the ranking and
the totals. Every parent with breakdowns also gets an "everything else" row, so a breakdown always
adds up to its parent. Roots that do not exist on this machine are listed as absent rather than
ranked at 0 B, and roots that could not be read say so with their reason.

**Project trees** are excluded by default, and the chip that includes them is a *scan* control,
not a filter. One large repository can outweigh every shared cache combined, and a chart
containing it is a chart of one repository — so the ranking says, in the panel, that they were
left out. Turning the chip on starts a new deep scan that walks them (and turning it off starts
one that does not); it is disabled while a scan is running. `ak system --deep` scans without
project trees.

### Two reclaimable tiers, never one total

Reclaimable rows come in two tiers, rendered as two separate blocks because they are two
different promises:

- **regenerable** — the owning tool refetches it on demand (package caches, superseded knowledge-
  base copies, stale npx envs). This block states a total.
- **review** — plausible, but not safe to call removable: aged transcripts are the only copy of
  the sessions they record, an extra runtime version may be the one a live toolchain resolves
  through, a browser build may still be pinned. This block deliberately has **no total**. Its
  bytes appear per row as context, and some rows show what is installed at that path rather than
  a measured removable subset, labeled as such.

The two are never added together. A combined "you could free N" would be the one number you would
act on and the one number the measurement cannot stand behind. Where a tier's own rows overlap on
disk, its total reads unknown-with-reason instead of counting the same bytes twice. Nothing here
removes anything; where a CLI already owns the cleanup, the row names it.

### Reading the numbers honestly

- **A section that has never been scanned says so.** It reads "not measured yet — press Rescan",
  never `0`. A zero here means a real, measured zero.
- **A total whose inputs were incomplete renders as `≥ N`.** If one subtree could not be read or a
  walk hit its cap, the sum is a floor, not a total, and is labeled that way.
- **A failed measurement names its reason.** An unreadable directory degrades that node alone; its
  siblings and the rest of the scan are unaffected.
- **Lines of code are approximate and say so**, counted by extension with `node_modules`, vendored
  trees, and binary files excluded. Only *languages* carry lines. Frameworks, SDKs and tools are
  shown as present or not — React does not own lines, the `.tsx` files do — and what the registry
  could not name is listed by name rather than swept into an "Other" slice.
- **Projects are counted twice, and the two numbers differ.** The KPI reads
  `N ever · M on disk`: *ever* is every project any host has ever recorded a session in, including
  ones you have since deleted or moved; *on disk* is the subset that still exists, and only those
  become rows in the Projects table — a deleted project has no bytes and no lines to measure.
  A large gap is a fact about your history, not an error.
- **A project whose path cannot be recovered is counted, not invented.** Claude stores transcripts
  in a directory name that encodes the project path lossily (`/`, `.` and `-` all become `-`), so
  it cannot simply be decoded back. The path is read from the session record instead; where no
  session recorded one and the encoded name cannot be confirmed against your filesystem, the
  project is reported as unresolved and the *ever seen* count is shown as a floor. You will never
  see a guessed path here.
- **Growth per day is approximate too** — a file counts its whole size on the day it was last
  written, which is exact for append-only transcripts and over-counts rewritten databases.
- **Some things cannot be attributed, and say that instead of guessing.** Codex transcripts are
  stored by date rather than by project, so those bytes render as unattributable.

### Platforms

All seven views work on macOS, Linux, and Windows. On Windows the process census (host, pid, CPU,
memory, uptime) is always available; the bound project is a best-effort read that can be blocked by
antivirus, execution policy, or permissions, in which case that one column reads
"not attributable on Windows" with the reason and every other figure in the row still renders.

One field is honestly missing everywhere: the ruflo daemon budget has no local source this
collector can read, so it reports unknown rather than a number inferred from nothing.

`ak system` prints the same collector output in a terminal, `ak system --deep` runs the scan, and
`ak system --json` emits the payload verbatim. See
[Machine footprint](ddd/machine-footprint.md) and
[ADR-0025](adr/0025-machine-footprint-metrics.md) for the full model and its invariants.

## Local state and security

Theme, polling preference, the selected primary/Overview/System view, whether the About nudge has
been dismissed, and the Session Stream collapse choice are stored in browser-local storage.
Canonical hashes make views linkable without putting the dashboard token in the path or query
string.

The launch token initially arrives in the URL fragment and is then stored locally for authenticated
API requests. The dashboard remains localhost-only and offline-first. Usage, Models, Observability, and
System may show sensitive local project, transcript, or filesystem-path information; use them only
where that local information may be viewed. System deliberately shows absolute paths — a storage
breakdown that hides where the bytes live answers nothing — behind the same token-gated loopback
delivery as every other route.

Models adds a second privacy boundary. The explicit local CLI can show exact model evidence, while
`/api/models` requires the already-existing private model scope key and returns
`privacy.projection: owner-visible-v2`. The loopback, token-gated operator view shows bounded exact
model names, selectors, and recorded providers; source-proven catalogue identity may additionally
show a publisher and allowlisted HTTPS links. Credentials, endpoints, scopes, digests, aliases,
binding/evidence/history identifiers, and arbitrary configuration remain keyed pseudonyms. Filtering
and sorting run only after that projection. Controlled built-in source metadata and diagnostic codes
remain named; unknown source metadata is pseudonymized. Missing key material returns a generic 503,
and opening the Dashboard never creates the key.

What System reads is a short, fixed list: directory entries and file `stat` results; your
`.git/config` origin remote (so a project can link to its repository page — the kit never fetches
it, you click it); a linked worktree's `gitdir` pointer; the `cwd` **field** recorded at the top
of a session transcript, and OpenCode's per-session `directory` column, so a session can be
attributed to the right project; your projects' manifest **dependency names**, which are neither
evaluated nor resolved; and your source files' bytes, streamed through a fixed buffer purely to
count newlines. Each of those yields a path, a name, or a number. **No message, prompt, tool call,
tool result, or model output is ever read** — those stay in Usage and Observability, which have
their own contracts for them. The full enumeration is
[Machine footprint § The read surface](ddd/machine-footprint.md#the-read-surface).
