# Maintenance overhaul migration plan

- **Plan status:** Proposed
- **Governing decision:** [ADR-0048](../../adr/0048-inventory-led-maintenance-resource-management.md)

The migration preserves the implemented safety engine while replacing its findings-first product
model. Each slice must leave the current production contract truthful and usable. No slice gains
write, network, privilege, path, or adapter authority from being part of this plan.

## Current baseline

The current system is implemented and internally consistent with its living plans:

- ADR-0025 owns Machine Footprint and Catalog v4 measurement.
- ADR-0032 owns read-only model lifecycle intelligence and explicitly has no model Apply.
- ADR-0044 owns findings, source-bound plans, one-use capabilities, writes, verification, receipts,
  undo, CLI-only recovery, and the current dashboard groups.
- ADR-0045 owns physical artifact and consumer-binding identity plus explicit provider scans.
- ADR-0046 owns scan-local reuse and worker-thread dashboard responsiveness.
- ADR-0047 is Accepted with the Projects observation-forest pilot implemented; later forest phases
  and journal-backed incremental mode are not implemented.

The proposed product differs deliberately. Current source still contains `needsReview` and
`unsupportedOrBlocked` summary buckets, generic evidence-first guidance, multiple-action CLI plan
arguments, no dashboard recovery endpoint, latest-only Maintenance scan storage, and no Managed
model removal. Those are migration targets, not undocumented drift.

## Source touchpoints

| Existing area | Current responsibility | Planned treatment |
|---|---|---|
| `src/lib/footprint/catalog*.mjs` | Catalog v4 measurement and source adapters | Preserve as upstream evidence; add a versioned management anti-corruption projection |
| `src/lib/maintenance/model.mjs` | Finding states and summary buckets | Introduce placement-led schema; retire old UI buckets after compatibility period |
| `src/lib/maintenance/read-model.mjs` | Findings/receipts dashboard projection | Split Inventory, Guidance, Discovery, and Activity queries |
| `src/lib/maintenance/provider-*.mjs` | Provider facts and executable findings | Preserve exact contracts; map only eligible placements into Guidance |
| `src/lib/maintenance/coordinator.mjs` | Plan/apply/verify/undo | Enforce one write action; preserve safety sequence |
| `src/lib/maintenance/recovery-coordinator.mjs` | Audit and reconciliation combined | Split read-only interruption audit from individual reconciliation |
| `src/lib/maintenance/scan-store.mjs` | Latest complete provider report | Add versioned source coverage/history without weakening last-good publication |
| `src/lib/footprint/observation-forest.mjs` | Projects forest pilot | Extend through ADR-0047 seams; add ADR-0048 checkpoint orchestration |
| `src/lib/model-inventory/*` | Read-only model inventory and plans | Add Maintenance projection and one exact removal provider only after conformance |
| `src/lib/dashboard/maintenance-api.mjs` | Four Maintenance route shapes | Version and expand exact allowlist for queries, discovery, audit, and reconciliation |
| `src/lib/dashboard/client/system-maintenance*.mjs` | Findings-first UI | Replace with routed workspace modules; keep compatibility route until migration gate |
| `src/lib/dashboard/styles/maintenance.mjs` | Current Maintenance presentation | Replace with responsive workspace styles and tokens |
| `tests/kit/maintenance-*` | Current domain/API/provider/recovery contracts | Retain as regression floor; add v2 fixtures and migration assertions |
| `tests/ui/dashboard-ui.mjs` | Current end-to-end dashboard | Add task journeys before removing old selectors |

Names for new source modules are implementation choices. The table assigns ownership and prevents
parallel competing models; it does not require one file layout.

## Phase 0 — Accept the plan and prototype the mental model

Deliverables:

- ADR-0048 and this design package reviewed and moved from Proposed to Accepted;
- realistic static fixtures for Lightpanda, shared skills, duplicates, WSL, package managers,
  credentials, models, incomplete scans, and interrupted receipts;
- clickable desktop and narrow-screen prototypes for Inventory, Guidance, Discovery, and Activity;
- task-based usability and accessibility evaluation against the acceptance criteria; and
- approved v2 schema and privacy projection.

Gate: no production implementation begins until the prototype meets the critical task metrics and
all product terms have one agreed meaning.

## Phase 1 — Versioned read-only management projection

Build the domain model and projection over existing evidence without changing the dashboard route
or any mutation path:

- logical resource, placement, artifact, and consumer identities;
- administrative scope and environment;
- evidence scorecards;
- version and provenance assertions;
- dependencies and conflict sets;
- model, provider-configuration, credential-readiness, cache, and storage resources; and
- sanitized deterministic query/paging envelope.

Use production collector output to generate fixtures. Keep Catalog v4 and model snapshots as
upstream sources rather than copying their parsers into Maintenance.

Gate: schema, privacy, golden, property, and large-inventory tests pass on all launch OS families.
The current UI and actions remain unchanged.

## Phase 2 — Discovery sources and resumable scans

Add user `kit.json` discovery intent, add-source preview, automatic-source toggles, exact and
recursive exclusions, coverage projections, source history, pause/resume/stop, and owner-private
checkpoints over the observation forest.

Complete ADR-0047's required forest seams before checkpointing a collector. Do not journal a
parallel walker. Validate scan epochs and invalidate only proven affected partitions.

Gate: reference-oracle equality, last-good preservation, bounded checkpoint size, stable-source
eventual completion, changing-source termination, cancellation responsiveness, and cross-platform
benchmarks pass. Update ADR-0047's implementation-status note for the exact phases delivered.

## Phase 3 — Inventory workspace

Ship Inventory behind an internal feature flag or versioned route:

- scope lens and curated views;
- multiselect facets, chips, counts, search, sort, and paging;
- logical groups and exact placement rows;
- desktop inspector and narrow-screen detail route;
- location breadcrumbs and protected exact-path reveal;
- complete healthy inventory and inventory-only evidence; and
- URL and remembered preference contracts.

Catalog remains reachable during this slice. Cross-view parity tests prove that every Catalog v4
artifact represented by the v2 management schema appears exactly once at the correct grain.

Gate: usability, keyboard, assistive-technology, 320-pixel, forced-colors, paging-generation, and
5,000/50,000-placement performance tests pass.

## Phase 4 — Guidance and dispositions

Derive the five Guidance lanes from verified placement evidence. Add signed/versioned procedures,
source/compatibility separation, outcome-first panels, contextual decisions, package-manager and
shell rendering, persistent checklists, acknowledge, snooze, ignore-exact-candidate, invalidation,
and Activity projections.

Do not migrate a current suggested action merely because it has imperative copy. It enters
Guidance only when ADR-0048's admission premises are satisfied.

Gate: zero remedy-free Guidance entries, zero generic warning labels, correct disposition
resurfacing, secret/path redaction, and every sentinel journey pass.

## Phase 5 — Existing Managed action migration

Map each ADR-0044 provider to one exact placement operation without broadening it. Enforce one write
action in plans and CLI/API requests. Add the Git-aware project-patch provider only after its own
preimage, dirty-worktree, validation, restore, and receipt contract passes.

Existing action and recovery receipts remain readable. Old plan capabilities expire naturally and
cannot execute through v2 routes.

Gate: all existing provider conformance and security tests remain green, one-action contracts are
proven at CLI and API boundaries, and old multi-action mutation requests fail before effect.

## Phase 6 — Interruption audit and reconciliation

Split current recovery into:

1. a disclosed read-only audit that may batch acquisition and exports ephemeral results; and
2. an individually confirmed receipt reconciliation write.

Add exact dashboard routes under the existing loopback/session/origin/schema/body-size protections.
Scope unresolved mutation blocks to the affected placement, environment, and dependents; preserve
the broader integrity-failure block.

Gate: interruption at every durable phase, provider drift, mixed state, integrity failure, catalog
refresh failure, idempotence, export redaction, scoped blocking, and zero action replay pass.

## Phase 7 — Exact provider-owned model removal

Add the first model-removal provider only for a provider/version tuple that proves every eligibility
premise. Keep model pull, update, migration, and channel changes Guided.

Model Lifecycle Intelligence continues to own model facts; Maintenance consumes the exact placement,
consumer, active-use, digest/revision, and storage evidence. Physical reclaimed bytes are never
inferred from logical size when blobs are shared.

Gate: one-model targeting, active-use refusal, shared-blob accounting, complete consumer preview,
provider-native removal, verified absence, interruption audit, redaction, and redownload disclosure
pass on supported platforms.

## Phase 8 — Catalog transition and retirement

After Inventory and Guidance meet parity and task gates:

- redirect old Catalog navigation and stable links to equivalent Maintenance URLs;
- remove Catalog as a visible destination while retaining Machine Footprint measurement ownership;
- remove old findings-first summary buckets and generic guidance copy;
- migrate or preserve terminal receipts and dispositions;
- update CLI help and JSON schema versions with explicit compatibility behavior;
- remove feature flags and dead UI modules; and
- update ADR-0048 to Implemented and ADR-0044 to Superseded for the replaced surface contract.

Gate: no orphan links, no duplicate routes, no missing current-provider action, no stale ADR claim,
and the full release suite passes from a clean machine on macOS, Linux, Windows, and WSL.

## Compatibility and rollback

- Read-only schema evolution uses explicit versions; an old snapshot is rejected rather than
  reinterpreted.
- A partial or failed scan cannot replace the last complete v1 or v2 snapshot.
- During dual-read migration, mismatches are diagnostics and block retirement; they do not merge
  incompatible rows.
- Existing receipts retain their provider version and presentation compatibility.
- Existing writes remain on the current coordinator until their provider completes v2 conformance.
- Rolling back a UI slice restores the old route without rewriting user resources or receipts.
- Discovery configuration migration is previewed and reversible until the v2 source successfully
  completes its first scan.

## Documentation synchronization

Every phase updates, in the same change:

- ADR-0048 status and implementation note;
- any affected implemented ADR named in its header;
- the corresponding detailed design document;
- current DDD/context-map and ubiquitous-language text only for behavior actually shipped;
- CLI/API schema documentation; and
- acceptance evidence linked to exact source state.

The Proposed package may describe the target. Current DDD documents must continue to describe
current behavior until each target slice is implemented.

## Release evidence

Each phase receipt binds:

- clean commit or immutable snapshot identity, including tracked and untracked changes;
- schema and fixture versions;
- focused, regression, security, accessibility, and cross-platform commands/results;
- source-bound benchmark baseline and candidate;
- privacy/redaction review;
- ADR claim-to-source verification; and
- unresolved limitations.

No documentation status is promoted solely because code was written. The acceptance gate must
prove the behavior that the status claims.
