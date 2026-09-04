# Maintenance overhaul living design package

- **Design status:** Proposed
- **Date:** 2026-09-04
- **Governing decision:** [ADR-0048](../../adr/0048-inventory-led-maintenance-resource-management.md)
- **Current production decision:** [ADR-0044](../../adr/0044-receipt-aware-maintenance-control-plane.md)

This package turns Maintenance into the place where a user can inventory and confidently manage
the agent-related footprint across system, machine, user, and project/repository scopes. It is a
plan, not a claim about shipped behavior. ADR-0044 and the current code remain authoritative until
ADR-0048 is accepted and each implementation gate is proven.

## Package map

| Document | Owns |
|---|---|
| [Domain model](domain-model.md) | Identities, aggregates, evidence, dependencies, conflicts, recommendations, dispositions, receipts |
| [Experience specification](experience-specification.md) | Navigation, views, filtering, rows, inspector, responsive behavior, accessibility |
| [Discovery and scan policy](discovery-and-scan-policy.md) | Sources, exclusions, previews, truthful coverage, resumable work, retention |
| [Provider and action policy](provider-and-action-policy.md) | Managed/Guided boundary, package managers, caches, Git patches, models, recipes, recovery audit |
| [Migration plan](migration-plan.md) | Gated transition from Catalog and findings-first Maintenance |
| [Acceptance criteria](acceptance-criteria.md) | Requirement IDs, sentinel journeys, quality and release gates |

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
│   ├── Scope: System | Machine | User | Projects | Across scopes
│   ├── Curated views and multiselect facets
│   ├── Logical resource groups
│   ├── Exact placement rows
│   └── Resource inspector
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

1. The inventory includes healthy verified resources and initially opens across all scopes.
2. The actionable row is one exact placement grouped under one logical resource.
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
