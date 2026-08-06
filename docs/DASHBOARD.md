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
| Overview | Intelligence | `#overview/intelligence` | Intelligence & learning | Machine-wide learning rollup across every ruflo-initialized project, plus near-live detail for one explicitly selected project |
| Usage | Scorecard | `#usage/score` | Usage scorecard | Token consumption, API-equivalent cost, efficiency, and trends |
| Usage | Limits | `#usage/limits` | Provider limits | Current provider windows, reset timing, and available capacity |
| Usage | Findings | `#usage/findings` | Usage findings | Actionable anomalies, efficiency opportunities, and evidence-backed recommendations |
| Usage | Sessions | `#usage/sessions` | Session usage | Retained sessions grouped by project, category, duration, tokens, and cost |
| Usage | Transcript | `#usage/transcript` | Transcript detail | The selected session's locally retained, server-masked evidence |
| Observability | Live | `#observability/live` | Observability · Live | Projects and roots with current presence or fresh meaningful activity |
| Observability | History | `#observability/history` | Observability · History | Retained roots that are not currently Live |
| System | Summary | `#system/summary` | Summary | Install size, retained data, live resource use, and deployed inventory in one glance |
| System | Storage | `#system/storage` | Storage | Where the retained bytes are, by category, host, project, and session — plus growth and advisory reclaimables |
| System | Runtime | `#system/runtime` | Runtime | Live host processes, their CPU and memory, background daemons, and machine denominators |
| System | Catalog | `#system/catalog` | Catalog | Deduplicated skills, agents, commands, plugins, and MCP servers, with a per-host presence matrix |
| System | Projects | `#system/projects` | Projects | Every known project's approximate lines of code, working-tree, `.git`, and `node_modules` size |

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
  always-visible rollup folded across every ruflo-initialized project on this machine, plus detail
  for one explicitly selected, explicitly labeled project — the neural pattern store's current
  size, its separate lifetime patterns-learned counter, and reasoning-graph growth. Project
  selection defaults to whichever discovered project was most recently active; there is no implicit
  current-working-directory default. The route-learner's improvement delta remains scoped to the
  dashboard's own launching project and is not part of project selection. Detail data reads files
  ruflo/agentic-qe already write under `.claude-flow/` and updates near-live over a per-project SSE
  stream while the view is open, falling back to the general status poll otherwise. See
  [Project intelligence](ddd/project-intelligence.md) and
  [ADR-0024](adr/0024-project-intelligence-telemetry.md) for the full model, the project-discovery
  mechanism, and the two learning metrics' load-bearing distinction, now also at machine scope.

## Usage

Usage loads lazily when first opened. Scorecard, Limits, Findings, Sessions, and Transcript share the
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
(Overview), spend (Usage), or activity (Observability). Its five views are Summary, Storage,
Runtime, Catalog, and Projects. Projects stays separate from Storage on purpose: lines of code and
a git remote answer "what have I built here", not "where are my bytes".

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

### Reading the numbers honestly

- **A section that has never been scanned says so.** It reads "not measured yet — press Rescan",
  never `0`. A zero here means a real, measured zero.
- **A total whose inputs were incomplete renders as `≥ N`.** If one subtree could not be read or a
  walk hit its cap, the sum is a floor, not a total, and is labeled that way.
- **A failed measurement names its reason.** An unreadable directory degrades that node alone; its
  siblings and the rest of the scan are unaffected.
- **Lines of code are approximate and say so**, counted by extension with `node_modules`, vendored
  trees, and binary files excluded.
- **Growth per day is approximate too** — a file counts its whole size on the day it was last
  written, which is exact for append-only transcripts and over-counts rewritten databases.
- **Some things cannot be attributed, and say that instead of guessing.** Codex transcripts are
  stored by date rather than by project, so those bytes render as unattributable.

### Platforms

All five views work on macOS, Linux, and Windows. On Windows the process census (host, pid, CPU,
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
API requests. The dashboard remains localhost-only and offline-first. Usage, Observability, and
System may show sensitive local project, transcript, or filesystem-path information; use them only
where that local information may be viewed. System deliberately shows absolute paths — a storage
breakdown that hides where the bytes live answers nothing — behind the same token-gated loopback
delivery as every other route. It reads file *metadata* only, never file contents.
