# Dashboard

`ak dashboard` opens an observation-only local diagnostic workspace. It binds to loopback, requires
the per-session dashboard token for every API route, and does not mutate configuration, agents, or
repositories.

```bash
ak dashboard

# Do not open a browser automatically.
ak dashboard --no-open
```

The dashboard has exactly three stable primary areas: **Overview**, **Usage**, and
**Observability**. The row directly below them is one fixed, left-aligned secondary navigation rail.
Its position does not move when the primary area changes; only the choices inside it change.

## Navigation and deep links

| Primary area | Secondary view | Canonical hash | Heading | What it answers |
|--------------|----------------|----------------|---------|-----------------|
| Overview | Summary | `#overview/summary` | System overview | Overall readiness, configuration health, and items needing attention |
| Overview | Hosts & Routing | `#overview/hosts` | Hosts & routing | Enabled execution hosts, activity assignments, primary-host policy, and escalation paths |
| Overview | Providers | `#overview/providers` | Inference providers | Provider bindings, availability, provenance, and configuration health |
| Overview | Runtime | `#overview/runtime` | Runtime health | Local services, MCP connections, processes, and operational readiness |
| Overview | Intelligence | `#overview/intelligence` | Intelligence & learning | Memory, learned patterns, quality feedback, and improvement signals |
| Usage | Scorecard | `#usage/score` | Usage scorecard | Token consumption, API-equivalent cost, efficiency, and trends |
| Usage | Limits | `#usage/limits` | Provider limits | Current provider windows, reset timing, and available capacity |
| Usage | Findings | `#usage/findings` | Usage findings | Actionable anomalies, efficiency opportunities, and evidence-backed recommendations |
| Usage | Sessions | `#usage/sessions` | Session usage | Retained sessions grouped by project, category, duration, tokens, and cost |
| Usage | Transcript | `#usage/transcript` | Transcript detail | The selected session's locally retained, server-masked evidence |
| Observability | Live | `#observability/live` | Observability · Live | Projects and roots with current presence or fresh meaningful activity |
| Observability | History | `#observability/history` | Observability · History | Retained roots that are not currently Live |

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

## Overview

Overview keeps status and routing in one health-first area:

- **Summary** presents the overall verdict, attention items, and subsystem map.
- **Hosts & Routing** presents execution-host health, the primary-host policy, per-activity routes,
  escalation paths, and routed host models. A configured route is assignment intent, not evidence
  of which inference provider served a particular session.
- **Providers** presents inference-provider bindings and their configuration provenance.
- **Runtime** presents operational services, processes, and MCP readiness.
- **Intelligence** presents memory, learning, and quality-improvement signals.

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

## Local state and security

Theme, polling preference, the selected primary/Overview view, and the Session Stream collapse choice
are stored in browser-local storage. Canonical hashes make views linkable without putting the
dashboard token in the path or query string.

The launch token initially arrives in the URL fragment and is then stored locally for authenticated
API requests. The dashboard remains localhost-only and offline-first. Usage and Observability may
show sensitive local project or transcript information; use them only where that local information
may be viewed.
