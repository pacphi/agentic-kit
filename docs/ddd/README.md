# Domain Design

These documents define agentic-kit's shared language, domain boundaries, and invariants. They
describe the current system unless a section is explicitly marked as future work.

## Documents

| Document | Purpose |
|----------|---------|
| [Ubiquitous language](ubiquitous-language.md) | Canonical meanings used across code, CLI, ADRs, and documentation |
| [Context map](context-map.md) | Bounded contexts, ownership, and relationships |
| [Integration management](integration-management.md) | Hosts, inference providers, bindings, capabilities, lifecycle, facts, and ownership |
| [Routing and orchestration](routing-and-orchestration.md) | Activities, routes, leadership, escalation, projections, and canonical `ak run` execution |
| [Model lifecycle intelligence](model-lifecycle-intelligence.md) | Model identities, evidence dimensions, catalogue snapshots, lifecycle diff, and read-only impact plans |
| [Hook configuration assurance](hook-configuration-assurance.md) | Host-neutral lifecycle source discovery, behavior identity, coverage, diagnostics, and remediation authority |
| [Context budget intelligence](context-budget-intelligence.md) | Effective ceilings, pressure evidence, managed startup footprints, policy, and sanitized delivery |
| [Prompt telemetry](prompt-telemetry.md) | Privacy-bounded prompt fingerprints, controlled semantic facets, recurring-cluster naming, and presentation rules |
| [Observability](observability.md) | Evidence acquisition, observed-session aggregates, replay, and dashboard delivery |
| [Project intelligence](project-intelligence.md) | Pattern store, learning counters, reasoning-graph size, and live delivery for Overview's Intelligence view |

## Relationship to other documentation

- Domain documents define stable terms, boundaries, state, and invariants.
- [Architecture decision records](../adr/README.md) explain why consequential decisions were made.
- User guides such as [Providers and hosts](../PROVIDERS.md) explain how to operate the CLI.
- Source and tests enforce the model. When documentation and behavior disagree, treat that as drift
  to resolve rather than silently redefining a term.

## Change rule

A change that introduces or changes a domain concept should:

1. name its owning bounded context;
2. use or extend the ubiquitous language;
3. preserve the context's invariants, or add an ADR explaining the change;
4. add executable coverage for new invariants; and
5. update operational documentation when user-visible behavior changes.

An Accepted ADR may define a target contract before its implementation exists. Such a domain
document must label planned commands, collectors, or read models explicitly and must not present
them as shipped behavior.

The GA model keeps host enablement under `integrations.hosts`, integration ownership under
`integrations`, and activity intent under top-level `routing`. These persisted locations do not
change the canonical distinction between a host and an inference provider.
