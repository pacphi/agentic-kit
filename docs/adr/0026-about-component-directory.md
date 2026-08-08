# ADR-0026 — About: a component directory that explains everything ak installs

- **Status:** Implemented
- **Date:** 2026-08-06
- **Updated:** 2026-08-06 — accepted and implemented; the open points below are resolved decisions
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0005](0005-dashboard-in-page-routing-reveal.md),
  [ADR-0007](0007-maintainer-admin-local-telemetry.md),
  [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0025](0025-machine-footprint-metrics.md)

## Context

agentic-kit installs and configures a lot on a user's behalf: three frontier-agent CLIs, an
orchestration engine, a memory layer, a quality fleet, security scanners, an offline knowledge
base, MCP registrations, guidance blocks, statuslines, a routing policy, background daemons.
Every existing dashboard area assumes the user already knows what these things *are*:

- **Overview** grades their health, **Usage** their spend, **Observability** their activity, and
  **System** ([ADR-0025](0025-machine-footprint-metrics.md)) their machine cost — all operational
  views of components the user is presumed to recognize.
- The only place that *introduces* the components is prose documentation
  ([MANAGED-TOOLS.md](../MANAGED-TOOLS.md), [SETUP.md](../SETUP.md)) — maintainer-register
  reference material, not a new user's first five minutes.

A new user's first honest question is prior to all of that: **"what did this thing just put on
my machine, and why should I be glad it's there?"** Nothing answers it today. The result is a
trust gap exactly where trust matters most — at first contact, right after `ak setup` printed a
long list of installs.

This record was written as a proposal and is retained in that voice; the decision has since been
accepted and shipped. Where the draft left a choice open, the [resolved
decisions](#resolved-decisions) section states what was decided and why.

## Decision

### 1. A new leftmost primary area: About

The dashboard gains a fifth primary area — **About** — placed **left of Overview**, first in
the tab order. This amends [ADR-0005](0005-dashboard-in-page-routing-reveal.md)'s layout a
second time (after ADR-0025's fourth area). Leftmost placement is deliberate: About is the
reading-order entry point for someone who doesn't yet know what the other tabs are about.
**Overview remains the default landing view** — About is discoverable first position, not a
gate returning users must click past.

```text
[ About | Overview | Usage | Observability | System ]

About (no secondary rail — one scrolling page with category anchors):
  Hero      One friendly sentence of orientation + component count + a five-word map of how
            the pieces relate (hosts ⟷ engine ⟷ memory/quality/security, kit around all).
  Hosts     The agent CLIs the user already recognizes — Claude Code, Codex, OpenCode.
  Engine &  ruflo (orchestration, cross-session memory, learning), agentdb (the memory
  memory    layer, version-pinned to ruflo).
  Quality   agentic-qe — test generation, coverage, quality gates.
  Safety    @claude-flow/aidefence + @claude-flow/security — prompt-injection defense and
            scanning.
  Knowledge RuvNet Brain — the offline KB that grounds answers about this stack.
  The kit   agentic-kit itself — the caretaker that installs, heals, and explains the rest.
  Configured for you   Non-package surfaces: MCP registrations, guidance blocks,
            statuslines, dual-host routing & bridge, background daemon, permission
            allowlists — each with "configured by setup/sync · yours to change".
```

Quality, Safety, and Knowledge are three separate categories in the data and one section on the
page — three one-card categories read as one cluster rather than three sparse sections. The page
therefore carries five anchors (`hosts`, `engine`, `quality`, `kit`, `configured`) over seven
categories.

### 2. A new bounded context: Component directory

Curated editorial content joined with live detection facts — see
[Component directory](../ddd/component-directory.md). The split is the decision:

- **Editorial** (this context owns): per-component tagline, one friendly paragraph of value
  proposition, outbound links (GitHub / npm / docs), icon spec, category, and curated order.
  Checked into the repo as a directory module, versioned with the release — never generated at
  runtime, never fetched.
- **Detection** (borrowed, read-only): installed/not-installed, version, install method —
  the facts `/api/status` and the managed-tools machinery already produce. About performs
  **no probing of its own and adds no endpoint**; the page renders the directory module joined
  client-side with the existing status payload.

### 3. Completeness is a gate, not a hope

Every tool in the managed-tools registry must have a directory entry — enforced by a parity
test, so a newly managed tool cannot ship without its About card. The reverse also holds: a
directory entry for something ak does not install or configure is a lie and fails the same
gate.

### 4. Card anatomy and the new-user register

Each card: an icon tile; the component name with an honest state chip (`installed v3.34.0` ·
`not installed — ak setup adds it` · `configured`); a bold plain-language tagline; **one**
paragraph (~50 words) of value proposition written to a reader who has never heard of the
tool; and a row of link pills (GitHub / npm / Docs). Editorial register is a contract, not a
style hope: friendly, concrete, jargon-free — every term of art either avoided or explained in
the sentence that uses it ("agent swarms" → "teams of specialist agents"). No marketing
superlatives; the value prop states what the thing *does for the user*.

### 5. Iconography: official marks where they exist, honest monograms elsewhere

The three hosts reuse the exact official SVG marks the dashboard already ships for
Observability's session rows. Components without an official mark get a **monogram tile**
(letterform on a category-hued rounded tile) — deliberately not a fabricated logo. All icons
are inline SVG/CSS (the dashboard is self-contained; no remote images), and the same icon for
a component everywhere it appears.

### 6. Links are outbound and user-initiated; the kit stays offline

Every link is a plain `https` anchor the user clicks in their own browser — GitHub repo, npm
package page, public docs. The kit fetches nothing ([ADR-0007](0007-maintainer-admin-local-telemetry.md)'s
offline side), link URLs live in the versioned directory module, and the nightly external link
check covers them like every other doc link.

## Consequences

### Positive

- The first-five-minutes trust gap closes: every installed thing explains itself, in one
  place, in plain language, with the receipts (source, package, docs) one click away.
- The parity gate turns "docs drift from reality" into a test failure instead of a review hope.
- Zero new collection surface: no endpoint, no probe, no cache — editorial content plus a join
  with facts the dashboard already has.

### Negative

- A fifth primary tab; the tab bar is reaching its comfortable ceiling, and any sixth area
  should trigger a navigation rethink rather than another amendment.
- Curated copy is a maintenance duty: component descriptions, links, and value props must be
  kept truthful as upstreams evolve (the parity gate catches presence, not prose accuracy).
- Editorial tone is subjective; the register contract reduces but cannot eliminate review churn.

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Copy claims something is installed when it isn't | Editorial/detection split is structural: state chips render only detection facts; copy is forbidden (by DDD invariant and review checklist) from asserting runtime state |
| A new managed tool ships without an About card | Registry↔directory parity test fails the build |
| Links rot | Nightly external link check already covers `docs/**`; the directory module's URLs join that sweep |
| Brand misrepresentation via invented logos | Official marks only where already shipped as official; everything else is an explicit monogram tile |
| The page drifts into a second status/metrics view | DDD invariant: no numbers beyond version strings — health belongs to Overview, cost to Usage, footprint to System |

## Resolved decisions

The draft left three points open. All three are decided; this section is the record.

1. **First run shows a dismissible nudge on Overview; it never hijacks the landing view.**
   Overview stays the default on every open, including the first. A one-time "new here? start
   with About" nudge sits on Overview and is dismissed for good (`ak-dash-about-nudge` in
   browser-local storage). Redirecting the first open would make the landing view depend on
   invisible browser state — two users, or one user on two machines, would see different first
   screens with no way to tell why — and it would put a page between an operator and the health
   verdict they opened the dashboard to read.
2. **`ak about` ships in v1.** The directory is data with no I/O of its own, and the state chips
   join the same `ak status` collection the dashboard uses, so the terminal twin costs one
   renderer (`src/commands/about.mjs`) and keeps the one-collector-two-surfaces symmetry the
   usage scorecard and `ak system` already follow. It also answers the question in the place the
   question is usually asked — right after `ak setup` finishes printing.
3. **Six separate "Configured for you" cards, not one card with a list.** Each configured
   surface — MCP registrations, guidance blocks, statuslines, dual-host routing and bridge, the
   background daemon, permission allowlists — has its own state chip and its own managing
   command. Collapsing them into one card would force a single chip to summarize six independent
   health facts, which is exactly the kind of averaging the honest-degradation contract forbids,
   and would hide the `manage:` line that makes "yours to change" actionable.

## Follow-ups on acceptance

All complete:

- The context is on the [context map](../ddd/context-map.md) and its terms are merged into
  [ubiquitous language](../ddd/ubiquitous-language.md); this ADR is in the [index](README.md)
  and the theme narrative.
- The registry↔directory parity test ships in `tests/kit/about-directory.test.mjs`, checked in
  both directions against the managed-tools registry, the heal/detection paths, and
  [MANAGED-TOOLS.md](../MANAGED-TOOLS.md).

## References

- [Component directory domain](../ddd/component-directory.md) — the domain model and invariants
- [Design mock-up](../assets/about-tab-mock.html) — self-contained both-theme HTML mock with
  the full card grid, category sections, per-section design rationale, and an annotated card
  anatomy
- [Managed tools](../MANAGED-TOOLS.md) — the registry this directory must stay in parity with
- [Dashboard guide](../DASHBOARD.md)
- `src/lib/dashboard/about-directory.mjs` — the directory module (pure data plus accessors)
- `src/commands/about.mjs` — the CLI twin
- `tests/kit/about-directory.test.mjs` — the parity gate and the register-contract checks
