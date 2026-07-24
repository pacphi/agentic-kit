# Architecture Decision Records

Lightweight [MADR](https://adr.github.io/madr/)-style records for **agentic-kit** (`ak`) design
decisions. These are ak's own ADRs — distinct from the ruflo / agentic-qe ADRs that `.claude/helpers/`
tooling references.

Format: `NNNN-kebab-title.md`, monotonically numbered. Each record states **Context → Decision →
Consequences**, and cites the grounded source it rests on where relevant.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-one-routing-policy-many-projections.md) | One dual-host routing policy, many projections | Accepted |
| [0002](0002-activity-vocabulary-defaults-from-ruv-templates.md) | Activity vocabulary & defaults seeded from rUv's shipped templates | Accepted |
| [0003](0003-auto-seed-dual-host-provenance.md) | Auto-seed on dual-host, subscription-only, per-route provenance | Accepted |
| [0004](0004-escalation-per-projection.md) | Escalation is per-projection, availability stated per path | Accepted |
| [0005](0005-dashboard-in-page-routing-reveal.md) | Dashboard surfaces routing via in-page reveal | Accepted |
| [0006](0006-primary-host-and-ambidextrous-mirroring.md) | Primary host & ambidextrous mirroring (which host leads) | Accepted |

Theme: these records define **dual-host LLM routing and leadership** — how `ak` lets ruflo route each
development activity (architecture, implementation, testing, review, …) to the right host (Claude or
Codex) and model, which host **leads** (0006), seeded on detection, tunable by the user, and surfaced
across `setup`/`sync`/`status`/`dashboard`. See also `docs/PROVIDERS.md`.
