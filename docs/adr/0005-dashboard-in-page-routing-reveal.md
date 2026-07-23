# ADR-0005 — Dashboard surfaces routing via in-page reveal

- **Status:** Accepted
- **Date:** 2026-07-23
- **Deciders:** agentic-kit maintainers

## Context

`ak dashboard` today is a single-page, poll-every-5s, **read-only diagnostic**: a verdict band, a `#cards`
grid grouped by subsystem, a `#history` strip — all fed by shelling `ak status --json`
(`src/lib/dashboard-server.mjs`). It is health/status oriented.

The routing policy warrants a richer view than a flat status card (a vendor-coded activity→host/model matrix
with provenance badges and escalation ladders). The question is how to add it without breaking the existing
health-first mental model. Options considered: a new tab/route (restructures the shell), a separate page
(breaks the "local diagnostic panel" single-page idiom), or an in-page reveal.

## Decision

Surface routing via **in-page reveal**, not a new page or tab:

1. `routing` appears as a normal **health card** in the `#cards` grid (emitted by `status.mjs` as `routing`
   rows; add `"routing"` to the dashboard's `PREF` ordering). This is where health/drift shows, consistent
   with every other subsystem.
2. The card header carries a **"View routing matrix →"** affordance that smooth-scrolls
   (`scrollIntoView`, reduced-motion aware) to a dedicated **Routing matrix section** — a bespoke strip
   modeled on the existing `#history` strip, rendered only when `data.routing` is present (sourced from
   `loadKitConfig().providers.dualRouting` in `collectData`).
3. Single-host projects have no `routing` data → **zero change** to their dashboard.

## Consequences

- Preserves the single-page, health-first idiom; routing is an enhancement reached by an intuitive in-page
  link, not a replacement.
- Minimal server change — the dashboard already shells `ak status --json`, so the health card flows for free;
  only the rich matrix needs a new data key + render function.
- Read-only is preserved (the matrix visualizes; tuning stays in `ak x provider pick` / `kit.json`).
- The published mockup is the visual contract for the matrix section.

## References

- `src/lib/dashboard-server.mjs` (`renderPage`, `#cards`, `#history`/`renderHistory`, `PREF`, `shellOutStatus`)
- Mockup: ak dashboard — Routing panel; ADR-0001, ADR-0003
