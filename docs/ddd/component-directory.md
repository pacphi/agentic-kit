# Component Directory Domain

> **Draft for review.** This document specifies the domain proposed by
> [ADR-0026](../adr/0026-about-component-directory.md). Nothing described here is implemented
> yet; module paths named below are the intended homes, not existing files. On acceptance, the
> new terms merge into [Ubiquitous language](ubiquitous-language.md) and the context joins the
> [context map](context-map.md).

## Purpose

Component directory answers a new user's first question — **"what did agentic-kit put on my
machine, and why is each thing worth having?"** — inside the dashboard's proposed **About**
primary area, placed first in the tab order. It owns the curated editorial identity of every
component the kit installs or configures: a plain-language tagline, one friendly paragraph of
value proposition, outbound links to the source (GitHub), package (npm), and public docs, an
icon, a category, and a deliberate reading order. It joins that editorial content, at render
time, with detection facts the dashboard already has — installed or not, version, install
method — and never collects anything of its own.

The shared terms in [Ubiquitous language](ubiquitous-language.md) are normative; the
[terms table](#ubiquitous-language-additions) below is this draft's proposed addition to it.

## Why this is a separate context

The neighboring contexts each own a different kind of fact about the same components; this one
owns the only kind none of them can: **editorial identity**.

- **[Integration management](integration-management.md)** owns capability registries, bindings,
  and ownership — what a component *can do* and what ak *manages about it*. It has no voice: no
  value proposition, no links for a human, no reading order. The directory borrows its registry
  as a parity gate (every managed tool must have an entry) and borrows nothing else.
- **Overview / status** owns health verdicts. The directory renders a version chip from the
  same detection facts, but a card is an introduction, not a verdict — About never says
  "degraded," it says what the thing is for and where to read more.
- **[Machine footprint](machine-footprint.md)** ([ADR-0025](../adr/0025-machine-footprint-metrics.md))
  owns measured cost. The directory renders no numbers beyond version strings — bytes, counts,
  and processes belong there.
- **Documentation** (`docs/*.md`) explains ak to maintainers in reference register. The
  directory is the new-user register, structured as data (per-component entries) so
  completeness is testable, which prose cannot be.

The editorial/detection split is the load-bearing boundary: editorial content is **authored,
versioned, and reviewed** with the release; detection facts are **observed at render**. A card
can therefore never claim runtime state in prose — the chip says `installed v3.34.0` because
detection said so, while the paragraph would read identically on a machine where the tool is
absent (with the chip honestly reading `not installed — ak setup adds it`).

## Model

```text
src/lib/dashboard/about-directory.mjs (intended home; pure data + tiny accessors)

DirectoryEntry {
  id,                    // stable key; the managed-tools registry key where one exists
  category,              // 'hosts' | 'engine-memory' | 'quality' | 'safety' | 'knowledge'
                         //   | 'kit' | 'configured'
  name, tagline,         // tagline: plain-language, ≤ 10 words
  paragraph,             // one paragraph, ~50 words, new-user register (see contract below)
  links: [ { kind: 'github'|'npm'|'docs', label, url } ],   // https only
  icon: { kind: 'official'|'monogram', ref },  // official = the already-shipped host marks
  detectionKey?          // join key into existing status/managed-tools facts; absent for
                         //   configured surfaces, which join on their subsystem row instead
}

directoryEntries() -> DirectoryEntry[]        (curated order: hosts → engine & memory →
                                               quality → safety → knowledge → kit → configured)

        + joined at render with existing facts (no new collection):
/api/status rows + managed-tools detection -> { installed, version, installMethod }

        |
        v
About primary area (leftmost tab): hero orientation strip + category sections of cards
  Card = icon tile · name + state chip · tagline · paragraph · link pills
```

### The editorial register contract

The paragraph and tagline are covered by an explicit writing contract, enforced in review (and
lintable where mechanical):

1. **One paragraph, ~50 words, no more.** A card is an introduction, not documentation — the
   Docs link is where depth lives.
2. **Plain language.** Every term of art is either avoided or explained in the sentence using
   it. "Agent swarms" renders as "teams of specialist agents"; "MCP" as "the plug-in protocol
   agents use to reach tools."
3. **Value stated as what it does for the user**, in active voice — never marketing
   superlatives, never claims about quality ("best," "blazing") that detection can't back.
4. **No runtime claims in prose.** "Installed," "running," "healthy" are chip words, fed by
   detection; prose describes purpose, which is true whether or not the tool is present.
5. **Friendly ≠ cute.** Warmth comes from clarity and usefulness; no exclamation marks doing
   the work of substance.

### Iconography

Official marks are used only where the dashboard already ships them as official — the three
host SVGs Observability renders on session rows — and are reused byte-identically so a
component looks the same everywhere. Every other component gets a **monogram tile**: its
initial(s) on a rounded tile in its category hue. A monogram is an honest "no official mark"
statement, not a stand-in logo; if an upstream later publishes a usable mark, swapping it in is
a one-entry change. All icons are inline (SVG or styled text) — the page stays self-contained
under the dashboard's CSP.

### Configured surfaces

Non-package things ak sets up — MCP registrations, managed guidance blocks
(CLAUDE.md/AGENTS.md), statuslines, the dual-host routing policy and Claude↔Codex bridge, the
background daemon, permission allowlists — are directory entries too, in the `configured`
category. Their chip reads `configured` (joined from the relevant status subsystem row), their
paragraph explains what was configured and why it helps, and each names the command that
manages it (`ak host`, `ak sync`, `ak x mcp pick`) so "yours to change" is actionable, not a
platitude.

## Delivery

No new endpoint. The directory module is imported by the page/client the same way `groups.mjs`
already is, and the state chips join client-side against the `/api/status` payload the
dashboard polls anyway. A status fetch that fails degrades every chip to `state unknown` while
the editorial content — which needs no network and no facts — renders in full: the page's
purpose survives its join's absence ([ADR-0023](../adr/0023-fail-closed-operations-and-explicit-degradation.md)
honesty, applied to a page whose primary content is static).

Outbound links open the user's browser; the kit performs no egress. The directory's URLs are
swept by the same nightly external link check that covers `docs/**` — a rotted link is CI red,
not a permanent dead end.

## Invariants

1. **Editorial content is authored and versioned with the release** — checked in, reviewed,
   never generated or fetched at runtime.
2. **Detection facts come only from existing collectors.** The directory probes nothing, adds
   no endpoint, and a failed status join degrades chips to `unknown` without hiding cards.
3. **Prose never claims runtime state.** Installed/version/configured render exclusively as
   chips fed by detection; the paragraph reads true on any machine.
4. **Registry↔directory parity is a test.** Every managed tool has exactly one entry; no entry
   exists for something ak neither installs nor configures.
5. **Links are `https`, named-host, user-initiated**; the kit fetches none of them; all are
   covered by the nightly external link sweep.
6. **Official marks only where genuinely official and already shipped**; everything else is an
   explicit monogram tile. No fabricated brand assets, ever.
7. **No numbers beyond version strings.** Health, cost, counts, and activity belong to their
   own contexts; About introduces, it does not measure.
8. **The register contract governs every entry** (length, plain language, active voice, no
   superlatives, no runtime claims).
9. **Order is curated and stable** — hosts first, the kit's own card near the end, configured
   surfaces last — never derived from popularity, size, or health.
10. **One icon per component, everywhere.** The directory's icon spec is the single source for
    that component's mark across the dashboard.

## Ubiquitous language additions

| Term | Meaning |
|------|---------|
| Component directory | The curated catalog of everything ak installs or configures, with editorial identity per entry |
| DirectoryEntry | One component's editorial identity: category, tagline, paragraph, links, icon, and a detection join key |
| Editorial content | Authored, versioned prose and links — the part of a card that is true regardless of machine state |
| Detection fact | An observed install/version/configured fact borrowed read-only from existing collectors, rendered only as chips |
| State chip | The card element that renders detection facts (`installed v…` / `not installed — ak setup adds it` / `configured` / `unknown`) |
| Monogram tile | The honest icon for a component with no official mark: initials on a category-hued tile |
| Register contract | The editorial writing rules (one ~50-word paragraph, plain language, no runtime claims, no superlatives) |
| Parity gate | The test asserting managed-tools registry ↔ directory completeness in both directions |

## References

- [ADR-0026](../adr/0026-about-component-directory.md)
- [Integration management](integration-management.md) — the registry this stays in parity with
- [Machine footprint](machine-footprint.md) — the measurement context this deliberately isn't
- [Context map](context-map.md) — joined on acceptance
- [Dashboard guide](../DASHBOARD.md)
