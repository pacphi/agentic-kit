# ADR-0005 — Dashboard surfaces routing via in-page reveal

- **Status:** Implemented
- **Date:** 2026-07-23
- **Updated:** 2026-08-25
- **Updated:** 2026-09-03 — ADR-0044 accepts a future, narrowly allowlisted Maintenance action
  boundary under System; the implemented dashboard remains read-only until that control plane
  ships.
- **Update note:** Reconciled the implemented five-area shell introduced by ADR-0025 and ADR-0026.
  ADR-0032 adds Models as a secondary Usage destination and a compact Overview summary while
  preserving read-only, network-silent ordinary Dashboard reads. Model identifiers use a fail-closed
  keyed Dashboard projection, and the semantic table has a labelled focusable scroll region plus
  field-evidence disclosures. ADR-0032 release proof remains pending.
- **Deciders:** agentic-kit maintainers

> **GA amendment:** the implemented dashboard remains read-only. ADR-0044 accepts a future,
> narrowly scoped exception for receipt-aware Maintenance actions; it does not relax ordinary
> dashboard routes. References below to compatibility configuration names and projections describe
> the implementation at adoption time only; [ADR-0020](0020-ga-stable-surfaces.md) defines the
> canonical GA surface.

## Context

At the time of this decision, `ak dashboard` was a single-page, poll-every-5s,
**read-only diagnostic**: a verdict band, a `#cards`
grid grouped by subsystem, a `#history` strip — all fed by shelling `ak status --json`
(`src/lib/dashboard-server.mjs`). It is health/status oriented.

> **Current implementation note (2026-08-25):** the read-only and loopback boundaries remain. The
> page now has five primary areas—About, Overview, Usage, Observability, and System—and one fixed,
> left-aligned
> secondary rail. It also has user-configurable status polling, lazy Usage reads, and an SSE-driven
> Observability view. Page, styles, browser client, Observability, and request/session security live
> under `src/lib/dashboard/`; `dashboard-server.mjs` is the HTTP composition root.

**2026-08-25 information-architecture amendment:** About supplies the component directory and
System supplies machine-footprint views under ADR-0026 and ADR-0025. Overview absorbs the former
health-oriented
peer tabs as **Summary**, **Hosts & Routing**, **Providers**, **Runtime**, and **Intelligence**.
Usage owns **Scorecard**, **Limits**, **Findings**, **Sessions**, and **Transcript**. Observability
owns **Live** and **History**. System and About retain the secondary destinations documented by
their governing ADRs. The secondary row remains in one stable location across all five areas.
Canonical hashes are rooted at `#about`, `#overview`, `#usage`, `#observability`, and `#system`.
Every destination has a visible heading and description. Primary
and secondary tab lists use roving focus: Left/Right activates the adjacent tab with wrapping, and
Home/End activates the first/last tab.

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
- Preserves five stable primary choices while keeping Overview's status domains one keyboard
  action away in the shared secondary rail.
- Provides durable, hierarchical deep-link vocabulary without adding routes, servers, or a second
  navigation component per area.
- Minimal server change — the dashboard already shells `ak status --json`, so the health card flows for free;
  only the rich matrix needs a new data key + render function.
- Read-only is preserved (the matrix visualizes; tuning stays in `ak x provider pick` / `kit.json`).
- The published mockup is the visual contract for the matrix section.

## References

- `src/lib/dashboard-server.mjs` (`renderPage`, `#cards`, `#history`/`renderHistory`, `PREF`, `shellOutStatus`)
- `src/lib/dashboard/page.mjs` and `src/lib/dashboard/client.mjs` (five-area shell, shared secondary
  rail, canonical hashes, headings, and keyboard semantics)
- [Dashboard user guide](../DASHBOARD.md)
- [ADR-0044](0044-receipt-aware-maintenance-control-plane.md) (accepted future Maintenance action
  boundary)
- Mockup: ak dashboard — Routing panel; ADR-0001, ADR-0003
