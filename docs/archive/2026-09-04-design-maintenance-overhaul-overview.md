> Archived snapshot, 2026-09-08. Original status and evidence below are historical.
> Current guidance: [Maintenance](../MAINTENANCE.md), [acceptance and open gates](../MAINTENANCE-ACCEPTANCE.md),
> and [ADR-0048](../adr/0048-inventory-led-maintenance-resource-management.md).

# Maintenance overhaul living design package

- **Design status:** Accepted — Focus browser approved 2026-09-08; focused implementation verified; ADR-0048 human/cross-platform gates remain open
- **Date:** 2026-09-04
- **Governing decision:** [ADR-0048](../adr/0048-inventory-led-maintenance-resource-management.md)
- **Current production decision:** [ADR-0044](../adr/0044-receipt-aware-maintenance-control-plane.md)

This package turns Maintenance into the place where a user can inventory and confidently manage
the agent-related footprint across system, machine, user, and project/repository scopes. It is the
design of record for the baseline implementation and the Focus browser amendment approved on
2026-09-08. The amendment is implemented with [focused validation](2026-09-08-validation-maintenance-focus.md). ADR-0044 remains the runtime
safety floor and the v1 compatibility surface until ADR-0048's open gates pass.

## Implementation status

**Baseline delivered 2026-09-05; design amended 2026-09-08.** Every baseline phase below has a
source implementation with named automated tests;
ADR-0048's "Implementation status" section is the authoritative record and lists the exact test
files. The package text that follows specifies approved Focus behavior. Baseline test totals do
not verify this amendment; its [focused browser/API evidence](2026-09-08-validation-maintenance-focus.md) is recorded
separately, and the open gates below remain required. The approved
[Focus prototype](2026-09-08-design-maintenance-focus-mockups.md) is illustrative evidence of the design choice, not proof of
production behavior or adapter relationship coverage.

| Phase | What shipped |
|-------|--------------|
| 0 — Accept and prototype | ADR-0048 and this package are Accepted. Realistic fixtures live in `tests/fixtures/maintenance/` (Lightpanda, shared skill, WSL, incomplete source, models, interrupted receipt). The Focus prototype was reviewed and approved on 2026-09-08; the representative-user task study remains open. |
| 1 — Management projection | `src/lib/maintenance/management/` (model, identity, evidence, environments, projection, dependencies, conflicts, correlation). |
| 2 — Discovery and resumable scans | `src/lib/maintenance/discovery/` (configuration, preview, checkpoint, partitions, orchestrator, coverage, history) and the `maintenance.discovery` key in `src/lib/config.mjs`. |
| 3 — Inventory workspace | `src/lib/maintenance/management/query.mjs` and `src/lib/dashboard/client/maintenance-{workspace,inventory,inspector}.mjs` with the Maintenance panel in `src/lib/dashboard/page.mjs`. |
| 4 — Guidance and dispositions | `src/lib/maintenance/management/{guidance,dispositions,procedures,recipes,package-managers,preferences,activity}.mjs` and `src/lib/dashboard/client/maintenance-guidance.mjs`. |
| 5 — Managed action migration | One action per plan enforced in `src/lib/maintenance/{planner,coordinator,service}.mjs`, `src/lib/dashboard/maintenance-api.mjs`, and `src/commands/maintain.mjs`. |
| 6 — Interruption audit and reconciliation | `src/lib/maintenance/interruption-audit.mjs` (read-only) and `src/lib/maintenance/recovery-coordinator.mjs` (single-receipt reconcile, scoped mutation blocks). |
| 7 — Model removal and project patches | `src/lib/maintenance/providers/{ollama-model-remove,git-project-patch}.mjs`. `src/lib/maintenance/provider-registry.mjs` registers the Ollama provider by default (its loopback detection fails closed to no action when Ollama is unreachable) and the Git project patch provider only when a composition supplies project roots. |
| 8 — Catalog transition | `#system/catalog` redirects to Maintenance Inventory; the former Catalog cards fold into System Summary; `src/lib/dashboard/maintenance-security.mjs` holds the exact v2 route allowlist; `src/commands/maintain.mjs` carries the v2 verbs beside the retained v1 verbs. |

Open gates that automated tests on one machine cannot prove:

- **Task-based usability study** with representative users against the acceptance criteria's
  locate, shared-versus-duplicate, and candidate-versus-recommendation metrics.
- **Assistive-technology signoff**: VoiceOver with Safari and NVDA with Chrome or Edge.
- **Reference-machine benchmarks** for the 5,000 and 50,000-placement filter targets and the
  discovery scan targets on macOS, Linux, Windows, and WSL.
- **Clean-machine Windows and WSL live integration** of the discovery orchestrator and the Ollama
  and Git-project-patch providers.

Until those gates pass, ADR-0044 stays current for the v1 compatibility routes and verbs.

## Package map

| Document | Owns |
|---|---|
| [Domain model](2026-09-04-design-maintenance-overhaul-domain-model.md) | Identities, aggregates, evidence, dependencies, conflicts, recommendations, dispositions, receipts |
| [Experience specification](2026-09-04-design-maintenance-overhaul-experience-specification.md) | Navigation, views, filtering, rows, inspector, responsive behavior, accessibility |
| [Discovery and scan policy](2026-09-04-design-maintenance-overhaul-discovery-and-scan-policy.md) | Sources, exclusions, previews, truthful coverage, resumable work, retention |
| [Provider and action policy](2026-09-04-design-maintenance-overhaul-provider-and-action-policy.md) | Managed/Guided boundary, package managers, caches, Git patches, models, recipes, recovery audit |
| [Migration plan](2026-09-04-design-maintenance-overhaul-migration-plan.md) | Gated transition from Catalog and findings-first Maintenance |
| [Acceptance criteria](2026-09-04-design-maintenance-overhaul-acceptance-criteria.md) | Requirement IDs, sentinel journeys, quality and release gates |

The ADR owns the decision. These documents elaborate its contracts and may not broaden mutation,
network, privilege, privacy, or adapter authority beyond it.

## Product promise

> Show me the verified agent-related resources on this environment, where each exact placement
> came from when that can be established, what consumes it, what has changed, and only the actions
> or decisions that Agentic Kit can ground.

Maintenance is not a generic cleaner, installer, vulnerability scanner, package manager, or root
administration console.

## Visible workspace

```text
Maintenance
├── Inventory
│   ├── Focus browser: four scope roots → one level at a time
│   ├── Projects → repository; other scopes → resource type
│   ├── Resource type → family → exact installation
│   ├── Breadcrumbs, curated views, filters that skip chosen levels
│   └── Exact inspector: evidence-backed relationships; optional actions
├── Guidance
│   ├── Can apply here
│   ├── Steps available
│   ├── Decisions to make
│   ├── Updates available
│   └── Recovery to finish
├── Discovery
│   ├── Automatic sources
│   ├── Exact projects and collection roots
│   ├── Exclusions and previews
│   └── Scan coverage and resumable progress
└── Activity
    ├── Interruption audits
    ├── Change receipts and undo
    ├── Deferrals
    ├── Recipe changes
    └── Scan history
```

## Settled principles

1. The inventory includes healthy verified resources; Across scopes opens four scope roots.
2. Focus navigation reveals one level at a time; only an exact installation can be an action target.
3. Administrative scope, source/provenance, physical carrier, and consumers are orthogonal.
4. Primary labels and actions require verified evidence for every premise they use.
5. User-facing `Unknown`, `Unsupported`, `Needs attention`, and generic `Review` labels are absent.
6. Remedy-free observations remain calm Inventory evidence and do not become user research work.
7. Candidate, compatibility, recommendation, pin, and channel are independent version facts.
8. Existing narrowly proven Managed providers remain; general package execution is out of scope.
9. No destructive or write batching exists in either UI or CLI; read work may batch.
10. Large scans are resumable and completion-oriented. A work budget cannot silently convert a
    valid source into a permanently incomplete one.
11. Interruption audit observes first; receipt reconciliation is a separate one-at-a-time write.
12. Cross-platform support is capability-driven and must never imply host or provider parity.
13. Filters skip already chosen hierarchy levels; breadcrumbs preserve orientation and backtracking.
14. Relationship navigation preserves filters and labels outside-filter selections. Recorded
    producer, binding, dependency, or precedence evidence is required for each relationship.
15. Include worktrees controls project-choice visibility; there is no Project type control, and
    presentation preferences cannot change measured identity or action authority.

## Evidence used to shape the plan

The initial quality discovery found a strong transaction engine and a weak user mental model. Its
prototype targets remain part of the acceptance suite: users must locate a dangling Lightpanda MCP
registration, distinguish shared artifacts from duplicates, distinguish candidates from named
recommendations, identify the exact action target, and avoid every incorrect destructive
confirmation.

UX evidence supports the calm Guidance admission rule: Carbon advises against status indicators
when no user action is necessary, GOV.UK reserves warning text for important consequences, and W3C
requires controls and icons to carry names that communicate purpose rather than visual form.

## Document maintenance

Every implementation slice updates ADR-0048's status note, the affected current ADRs, and this
package in the same change. If code and this plan diverge, the discrepancy is a release blocker;
the plan must be reconciled rather than left as historical aspiration.
