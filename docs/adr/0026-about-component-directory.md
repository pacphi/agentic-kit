# ADR-0026 — About: a component directory that explains everything ak installs

- **Status:** Proposed (draft for review — no implementation exists yet)
- **Date:** 2026-08-06
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
  the proposed **System** ([ADR-0025](0025-machine-footprint-metrics.md)) their machine cost —
  all operational views of components the user is presumed to recognize.
- The only place that *introduces* the components is prose documentation
  ([MANAGED-TOOLS.md](../MANAGED-TOOLS.md), [SETUP.md](../SETUP.md)) — maintainer-register
  reference material, not a new user's first five minutes.

A new user's first honest question is prior to all of that: **"what did this thing just put on
my machine, and why should I be glad it's there?"** Nothing answers it today. The result is a
trust gap exactly where trust matters most — at first contact, right after `ak setup` printed a
long list of installs.

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

## Open points for review

1. **First-run behavior** — Overview stays the default; should the very first dashboard open
   (no prior localStorage) land on About once, or show a dismissible "new here? start with
   About" nudge instead?
2. **CLI twin** — `ak about` printing the same directory (with state chips) is cheap and
   symmetric with the usage/footprint precedent; worth having in v1?
3. **Configured-surfaces depth** — one card per surface as proposed, or one "Configured for
   you" card with an expandable list?

## Follow-ups on acceptance

- Add the context to the [context map](../ddd/context-map.md) and merge terms into
  [ubiquitous language](../ddd/ubiquitous-language.md); add this ADR to the
  [index](README.md) and theme narrative.
- Wire the registry↔directory parity test alongside the managed-tools tests.

## References

- [Component directory domain](../ddd/component-directory.md) (drafted alongside this ADR)
- [Design mock-up](../assets/about-tab-mock.html) — self-contained both-theme HTML mock with
  the full card grid, category sections, per-section design rationale, and an annotated card
  anatomy
- [Managed tools](../MANAGED-TOOLS.md) — the registry this directory must stay in parity with
- [Dashboard guide](../DASHBOARD.md)
