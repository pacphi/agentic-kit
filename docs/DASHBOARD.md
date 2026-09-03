# Dashboard

`ak dashboard` opens a local diagnostic workspace. It binds to loopback and requires the
per-session dashboard token for every API route. Ordinary views are observation-only;
**System > Maintenance** is the sole receipt-aware action surface.

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
| Usage | Prompts | `#usage/prompts` | What you actually type | Prompt repetition, tap habits, provenance, recurring patterns, re-asks, and host interplay from prompt fingerprints |
| Usage | Context | `#usage/context` | Context budget | Runtime-observed input/window pressure, evidence coverage, policy bands, and capped attention rows |
| Usage | Hooks | `#usage/hooks` | Hook assurance | Read-only hook configuration diagnostics, ownership actions, and separately reported bounded runtime receipts |
| Usage | Models | `#usage/models` | Model lifecycle | Host inventory, lifecycle changes, consumers, swap impact, and evidence sources |
| Usage | Sessions | `#usage/sessions` | Session usage | Retained sessions grouped by project, category, duration, tokens, and cost |
| Observability | Live | `#observability/live` | Observability · Live | Projects and roots with current presence or fresh meaningful activity |
| Observability | History | `#observability/history` | Observability · History | Retained roots that are not currently Live |
| System | Summary | `#system/summary` | Summary | Install size, retained data, live resource use, deployed inventory, and the machine's largest storage consumers in one glance |
| System | Advisory | `#system/advisory` | Advisory | What could be reclaimed, in two safety tiers reported separately and never added — the only System area that suggests an action, and it still has no delete control |
| System | Sessions | `#system/sessions` | Sessions | The largest individual session files, the project each belongs to, and its share of that host's retained bytes |
| System | Storage | `#system/storage` | Storage | Where the retained bytes are, by category and host — learning stores counted separately because they dwarf everything else — plus per-series growth |
| System | Runtime | `#system/runtime` | Runtime | Live host processes, their CPU and memory, background daemons, and machine denominators — refreshed on the header's poll clock while open |
| System | Catalog | `#system/catalog` | Catalog | Summary-first project skill pressure with per-project host disclosure; standalone and plugin-qualified skills, agents, commands, plugins and MCP servers across user/project/plugin scope; provider/version and entrypoint-digest evidence; per-host matrix with kind/host/source filters |
| System | Projects | `#system/projects` | Projects | Every repository with a remote that a host has recorded a session in — its approximate lines of code, language mix, total disk size and last activity. Worktrees, sub-folders and remote-less repositories are counted below the table, not listed |
| System | Maintenance | `#system/maintenance` | Maintenance | Evidence-backed upgrade and cleanup findings, one-finding action previews, explicit confirmation, receipts, and guarded undo |

About is one scrolling page, so its hashes scroll to a section rather than swapping panels; `#about`
alone opens the page at the top.

Opening a session uses `#usage/<session-id>`. **Transcript** is not a navigable Usage tab: it appears
only as a non-interactive current-view indicator while a selected session's locally retained,
server-masked evidence is open. A bare `#usage/transcript` returns to Sessions. These hashes select
state inside the one page; they do not create separate servers or weaken the dashboard token
boundary.

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

The engine group includes the currently active Ruflo browser executor. Its chip
comes from the same read-only status facts as the terminal: compatible package,
verified native executable, trusted MCP config, and local browser payload remain
separate from Vibium's Agentic-QE-owned cache visibility in System.

System's capability catalog counts both user/plugin surfaces and the project
surfaces discovered by the host census. In particular, Codex project skills in
`.agents/skills` are distinct evidence from user `~/.codex/skills` and enabled
plugin caches; their presence matrix keeps the source visible after deduplication. Full
`plugin@marketplace` and version/state evidence stays attached to plugin contributions, and a
standalone skill with the same logical name remains a distinct identity joined by an explicit
name/digest relationship.

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
- **Providers** presents inference-provider bindings and their configuration provenance. A
  registered provider is eligible configuration, not evidence that a request selected or used it.
  Direct Ruflo agents must explicitly select OpenRouter or Ollama together with a provider-native
  model, and the Ruflo/MCP process must inherit the required credential environment. Served-provider
  and served-model claims come from **Usage → Scorecard** evidence instead.
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

Usage loads lazily when first opened. Scorecard, Limits, Findings, Prompts, Context, Hooks, Models,
Sessions, and Transcript share the same secondary rail; the 7/14/30-day filters remain aligned to
its right.

### Scorecard

Scorecard reads top to bottom as one argument: what the window cost, how you spent it, and what that
says about the way you work. Every figure is derived from locally retained transcripts, so every
dollar is API-equivalent list price and never plan billing.

**Two hero rows.** The first carries sessions, api-equivalent cost, tokens, engaged time, and cache
read. Each tile pairs its figure with a change against the previous window of the same length and a
per-day sparkline, so the number and its direction arrive together. The change is read
directionally, not just arithmetically — a falling cost is good, a rising cache share is good, and a
token count is neither — and the cache delta is stated in percentage points, because a percent of a
percent would be read as something else. A day that billed no tokens has no share to plot, so the
sparkline breaks there rather than carrying the previous value forward. **The engaged-time tile
trends on a different set of days than its neighbours, and says so in its own tooltip:** its trend
covers the days you worked, while every other trend covers the days that billed tokens. The second
row answers unit economics — sessions per active day with its current streak, autonomy (responses
per prompt you typed, and those same prompts per engaged hour), cost per session, and cost per
engaged hour. Session counts, the rhythm histograms and the punchcard all **include delegated
subagent sessions**, which the harness dispatches rather than you; the how-you-run panel carries the
main/subagent split, and autonomy is the exception — its denominator is main-thread prompts only. Cost per session is a median over *priced* sessions only; a session with no token
evidence at all is structurally zero rather than cheap, and folding it in would drag the median
toward zero for a reason that is not about spend. A real figure under a cent renders `<$0.01`, never
`$0.00`.

**Rhythm & responsiveness** puts two histograms side by side, session length and response latency,
each with its percentile markers laid over the bars. A percentile that lands in the open-ended
top bucket renders with a `≥` prefix — the bucket has no upper edge, so the honest claim is a floor
rather than a point. A window holding no samples reads `not measured` instead of a row of zero bars.
**Response latency is the gap between a prompt and the response that answered it. It is not
time-to-first-token**, which no local transcript records.

**How you run** answers permission posture, who drove, and who served. Posture is a closed
four-value vocabulary — guarded, auto-edit, plan, unrestricted — mapped from each host's own
evidence; a raw value the taxonomy has not been taught yields **not-recorded**, which is a
first-class row rendered in the de-emphasis ink rather than a display fallback, because spend with
no posture evidence must never read as a posture. The delegation donut splits main-thread from
subagent work, and its two halves are honest in different ways: Claude writes delegated work to its
own nested transcript, so that cost is discovered, priced, and included, while a Codex subagent
rollout reads `$0.00` by ledger design — its tokens replay the parent's and are stripped as a
double-count, so the sessions stay visible and auditable at zero rather than billing the parent
twice. The panel does not rank window cost by inference provider: a transcript host is not a vendor,
and only Codex transcripts record who served the tokens, so that identity is reported per session on
the Sessions detail strip — beside the provenance backing it — rather than as a window axis.

**Tool mix** ranks tool invocations, top eight with the tail folded into a dimmed `Other` row rather
than dropped. Names are the host's own — Codex's `CommandExecution` is not renamed to `Bash` —
because the vocabularies are host-specific and a renamed row would assert a correspondence no
evidence supports. **Model mix over time** stacks per-day cost by coarse model family, the top
families coloured and the rest folded into a de-emphasised band.

**Reliability** reports turns that never landed: exceptions per thousand responses, aborted turns,
and a per-day exceptions sparkline that names the worst single day. Aborted turns are **codex-only
evidence** — no other host records an interrupt — so the count appears only when the window holds a
codex session, and otherwise reads `—` rather than a zero that would look measured.

`ak usage score` prints the same scorecard figures in a terminal, offline, including the rhythm
pair, the posture and served-by tables, and the reliability lines.

### Limits

Limits renders each vendor-reported window as a utilization meter. Every meter that can place one
also carries a **pace tick** — the mark a steady burn would be sitting on right now, computed from
the window's own length and reset time, so fill past the tick means ahead of pace. Nothing is
fetched to draw it. When the arithmetic falls outside the window — a snapshot older than the window
it describes, or a browser clock that disagrees with the vendor's — the tick is omitted rather than
pinned to either end, because a mark at 0% or 100% would state a position the data cannot support.
The legend appears only when at least one row actually carries a tick.

### Prompts

Prompts turns what you actually typed — never what the harness or a delegated agent produced —
into repetition and habit signal, host by host. Every figure derives from prompt
**fingerprints** (a hash, token/count evidence, provenance, and optional controlled intent/topic
codes recorded at scan time); no prompt text is stored in the index. A recurring cluster receives a
contextual name only when one controlled intent or topic has at least two supporting prompts, covers
at least 60% of the cluster, and is not tied. Otherwise it remains honestly unclassified. The
visible **Intent** column replaces the former binary `question`/`other` class; the legacy class stays
in compatibility JSON only. The **KPI strip** reads Typed prompts (share of every fingerprinted turn),
Questions, Supervision taps (against your own trailing-90d normal per host, where you have one),
Repeated share, and Headless share. Below it, **Who is typing** shows the provenance split behind
that Typed-prompts figure — most user-role turns are not typed by you at all — and **Host
interplay** reads the asymmetry between hosts in plain language (how much more often you tap one,
how much longer you write on the other, how much role scaffolding each gets retyped by hand). The
definitions and unequal-history warning are persistent copy, not hover-only help.

Below the KPIs, **Who is typing**, **Steering mix**, **Tap habits**, **Recurring patterns**,
**Re-asks**, and **Host interplay** explain the same deterministic evidence without serving prompt
text or mutable coaching state. An **All** chip, offered on this view alone, widens the window to the
full retained history; leaving Prompts drops it back to 30 days. Full formulas, thresholds, and
sources: [Usage scorecard metrics](USAGE-SCORECARD-METRICS.md) §2a, §2b, §20–§22.

### Context

Context answers how much of a runtime-observed window the retained sessions used. The policy strip
shows the canonical startup, dynamic and reserve bands. The summary reports exactly how many
sessions have a paired input/window pressure observation and how many lack a denominator. Claude,
Codex and OpenCode each keep their own card with evidence state, p90 peak pressure, paired-sample
count, p90 peak input and median observed window.

A percentage is rendered only when input and window were observed together for that session.
Claude and OpenCode commonly carry input-only evidence, so they may read **Partial evidence** while
Codex is observed. Missing evidence renders `unknown`; an unknown ARIA meter omits `aria-valuenow`
rather than announcing zero. The attention projection is capped to the top 20 sessions before
presentation. The browser renders one disclosure row per bounded project and keeps each sanitized
conversation label inside the expanded session table, then exposes explicit column headers, an opaque session reference, host, policy-derived
recommendation, pressure/input/window, and start date. The session reference links to that retained
local transcript. A recommendation means a policy threshold was crossed; it is not evidence that a
handoff or compaction occurred. Prompt bodies, tool payloads, commands and raw paths never enter the
projection.

Context rides the existing authenticated `/api/usage` aggregate and follows the selected Usage day
window. Its percentages use runtime-effective denominators where the transcript supplied them; a
published 1M maximum never overrides a smaller 258.4K session window. Full evidence and threshold
rules: [ADR-0042](adr/0042-capability-aware-context-budget-intelligence.md).
Run `ak audit context --host all` for the companion read-only startup report: managed guidance
bytes/state, bounded skill-metadata counts, MCP registration-table bytes, schema availability and
effective-window evidence. MCP configuration bytes do not include unrelated host preferences, and
tool schema bytes remain unknown when the host config does not expose them.

### Hooks

Hooks is a read-only assurance view. Opening it lazily requests authenticated, no-store
`/api/hooks?host=all`; the server shares one in-flight collection and a 30-second in-memory result.
It does not execute, edit, heal, enable or disable a hook. The summary removes raw commands, source
paths, hook output, detail and diagnostic prose. Each audited physical placement receives an opaque,
short-lived source reference. Only an explicit **Inspect source** action resolves that reference,
rechecks the bounded regular file and original digest, and returns its physical location plus a
server-masked selected JSON definition with format, host, lifecycle, source-kind, owner and selector
facts. A placement without a resolvable locator has no Inspect control. If a live reference expires,
the browser refreshes Hooks and retries once; digest drift refreshes the list but never substitutes
changed content silently. Invalid or missing selectors and formats that cannot be parsed safely
return an explicit location-only reason. The route accepts no client path, never imports a module or
launches an editor.

The view deliberately separates four questions:

- **What is configured** distinguishes physical entries, distinct normalized behaviors, repeated
  placements, inspected sources, and unreadable sources. Unreadable sources are not warning counts.
- **Hook definitions** is a semantic table grouped by normalized behavior. Its keyboard-focusable,
  internally scrollable viewport shows five collapsed definitions at a time and keeps the header
  visible. Expand a definition to inspect its host, lifecycle point, handler kind, timeout,
  placement, owner/authority, selection evidence and source reference.
- **Findings needing attention** groups the same normalized finding across hosts and lifecycle
  points. Importance is a sort/filter dimension, not the group identity. Expand a finding to see
  the affected definitions under explicit Lifecycle point, Host, Configured in, Evidence and
  Action headers. Stable codes remain secondary support text, and an action stays on the exact
  placement that proved it.
- **Observations, not actions** holds informational or unknown diagnostics that have neither a
  remediation proposal nor a verified action.
- **Runtime outcomes** is a separate table of bounded receipts. With no receipts it says outcomes
  are unknown and renders no zero-valued scorecard.

Evidence limits stay beside the affected measurement instead of repeating in a generic panel:
unreadable sources remain in configuration evidence, missing receipts remain in Runtime outcomes,
and a finding placement without an exact safe next step says so in its Action cell.

A finding receives a call to action only when the current healing plan contains an exact executable
action bound to the affected occurrence and plan digest, or when a verified published upstream issue
is joined explicitly. A generic `approval-required`, `upstream-required`, or `prohibited`
classification is explanation, not actionability.

A configured Stop risk is not a failed Stop execution. Conversely, an absent receipt is not a
successful execution or zero failures. Native Claude, Codex and OpenCode hooks do not currently feed
the bounded supervised-adapter receipt stream, so runtime is normally unknown. See
[ADR-0041](adr/0041-host-neutral-hook-configuration-assurance.md) for the audit, receipt and
ownership contracts.

### Reading a session row

Projects begin collapsed. Expand a project to reveal its session rows. Each row deliberately keeps
identity axes separate:

- the compact host badge states only the execution host: Claude Code, Codex, or OpenCode;
- the leading chevron expands an independent detail strip without opening the transcript;
- the detail strip reports execution host, inference provider, provider provenance, model or models,
  permission posture, rhythm, classification basis, token details, tools, and flags;
- clicking the rest of the row opens the locally retained masked transcript.

The row also carries chips for what that one session measured: its engaged length, its median
response latency, a **posture badge**, and a **context-fill chip**. Both of the last two are
evidence-gated. The posture badge appears only when the transcript recorded a posture this taxonomy
maps, and its tooltip carries the host's own spelling of that value where the transcript recorded
one, because the mapping is a judgment call and a reader checking it needs the evidence it was made
from. The `ctx N%` chip
appears only when **both** halves were observed — the last turn's context tokens and that model's
window. Codex records a window; Claude Code and OpenCode do not, and the dashboard carries no
published-window table to fall back on, so the chip is omitted rather than divided by a guessed
denominator that would render as a fabricated percentage.

Host, inference provider, provenance, and model are independent facts. The dashboard never derives a
provider from a host name or model string. Codex `session_meta.model_provider` and equivalent
`turn_context` evidence are reported as **observed**. Native Claude transcript history does not name
the serving provider, so a historical row may honestly show **Not recorded**. That is missing
evidence, not a claim that Claude Code was served by Anthropic or by any provider inferred from its
model.

This distinction also applies to Ruflo's project-scoped `agents.providers` registry. Ruflo 3.38.8+
can execute an explicitly spawned `--provider openrouter --model z-ai/glm-5.2` agent through
OpenRouter, but registration by `ak host pick --provider openrouter:z-ai/glm-5.2` does not retarget
every direct agent. `RUFLO_PROVIDER=openrouter` is a process-wide override; explicit per-agent
provider and model selection is the reproducible path. Restart a long-lived Ruflo/MCP process after
adding `OPENROUTER_API_KEY`, because it inherits environment variables only when it starts.

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

Claude refresh also reads a dated first-party record bundled with Agentic Kit from Anthropic's
public model overview and deprecation tables. It can establish published model identity,
specifications, lifecycle, and pricing without an API key. It cannot establish access for a Claude
Code plan, Anthropic API account, Bedrock/Vertex deployment, or OpenRouter route. Upgrade Agentic Kit
to receive a newer public record, then run `ak models refresh --host claude`.

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
evidence. The discovery column is labelled **Catalogued**; details separately state account access,
local routability, and the next step. To establish routability, configure the exact host/provider/
model path, authenticate the serving provider, complete one successful invocation, and refresh.
Model-specific foreground/background pairs meet WCAG AA in both themes, and the same table
remains operable at narrow widths.

The Overview Model lifecycle summary links to `#usage/models`. The view has no mutation control.
It points to the read-only `ak models plan` command, which can emit a copyable canonical
`ak host pick` action but cannot execute it. See [Model lifecycle intelligence](MODELS.md).

The lifecycle payload is separate from the Usage session/transcript and Observability live/history
payloads. Public catalogue enrichment cannot rename, re-price, add, or remove a retained session or
transcript model record.

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
(Overview), spend (Usage), or activity (Observability). Seven measurement views cover Summary,
Advisory, Sessions, Storage, Runtime, Catalog, and Projects. Maintenance is an eighth navigation
destination and a separate control-plane context. Projects stays separate from Storage on purpose:
lines of code and a git remote answer "what have I built here", not "where are my bytes".

### Two tiers, and why nothing scans on open

Opening System costs almost nothing. The cheap tier — the live process census, individually known
file sizes, and the figures carried forward from the last deep scan — is served on every read and
cached briefly.

Everything else comes from a **deep scan**, which walks the install trees, the retained-data roots,
every host's catalog surfaces, and every known project. That is real I/O and takes tens of seconds
on a large machine, so it runs **only when you press Rescan** (or run `ak system --deep`). Opening
the tab never triggers it. Measurement views fetch once, then again only while a scan you started
is running. Maintenance refreshes its own read model on the header poll clock while open; that poll
does not execute an action.

The trade is stated rather than hidden. Deep-tier figures always render with when they were
measured, and once a snapshot passes seven days the freshness label turns amber and reads
`stale, rescan`. Catalog snapshots also retain bounded stat-only source probes; if a watched plugin,
surface, or entrypoint changes first, the label immediately reads `catalog changed, rescan`.
An unchanged probe is not full content validation, and says so in the JSON evidence.
A scan writes one file — its own snapshot — and nothing else; the reclaimable-space
rows are advisory, with their rationale and their path. Catalog and Advisory have no action
controls; provider-backed actions live only in Maintenance.

### Catalog evidence and project pressure

Catalog starts with a project-by-host pressure table. Project, user, and enabled-plugin
contributions are separate columns; exact skill-name and bounded entrypoint-body overlaps are
separate evidence. The table always says that context inclusion and cutoff are host-owned and
unknown. Filesystem presence must not be read as “loaded into this session.”

The presence matrix can be filtered independently by kind, host, and source scope. Rows name their
provider/version and body variants where known. Plugin inventory prefers the hosts' native list
commands and labels manifest/config/cache fallback as partial; installed-disabled plugins stay in
inventory without contributing enabled capabilities.

Catalog remains read-only. `ak x skills plan --project <path>` emits the corresponding
receipt-aware classification, git state, affected paths, projected result, and stable plan ID; it
writes nothing. That preview is evidence for the separate
[Maintenance capability](ddd/maintenance.md), not an executable plan or authorization.

### Maintenance actions and receipts

Maintenance groups findings into **Updates ready**, **Safe cleanup**, **Needs review**,
**Unsupported or blocked**, and **Recent changes / Undo**. Each row explains the resource owner,
evidence health, impact, restart requirement, rollback class, and missing authority. A missing
button means the current service did not advertise an executable provider action; the browser does
not derive capabilities from labels.

Selecting one finding requests a fresh five-minute server-derived plan. The confirmation sheet
shows the exact operation and consequences. Confirming consumes a session- and plan-bound one-use
capability before provider work begins. The browser sends opaque IDs only—never a command, path,
provider implementation, or action definition. There are no checkboxes, mixed-safety batches, or
“Clean all”.

After an operation, the provider verifies its postcondition and Maintenance refreshes the full deep
System/Footprint snapshot. The result sheet links the durable receipt and offers Undo only when the
committed action declared rollback and current state still matches its recorded postimage. External
provider effects are not presented as atomic.

An interrupted or uncertain outcome appears as recovery-required and blocks later Maintenance
mutations. The dashboard preserves and displays that evidence but has no recovery endpoint. Use:

```bash
ak maintain recover --receipt RECEIPT_ID --yes
```

Recovery inspects current state and reconciles the receipt. It never retries, reapplies, undoes, or
compensates an uncertain operation. See the [Maintenance runbook](MAINTENANCE.md) for the provider
matrix, CLI workflow, ownership rules, and fail-closed recovery limits.

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

All seven Machine Footprint views work on macOS, Linux, and Windows. On Windows the process census (host, pid, CPU,
memory, uptime) is always available; the bound project is a best-effort read that can be blocked by
antivirus, execution policy, or permissions, in which case that one column reads
"not attributable on Windows" with the reason and every other figure in the row still renders.

Maintenance itself remains available on Windows, but the Ruflo MCP orphan action requires a
numeric POSIX UID and therefore stays report-only there. Every other provider is advertised only
when its native operation and evidence are available on the current machine.

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
API requests. The dashboard remains localhost-only and offline-first. Maintenance POST requests
add same-origin fetch metadata, exact JSON schemas, a 64 KiB body limit, and one-use action
capabilities; every other route retains default non-GET rejection. Usage, Models, Observability, and
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
