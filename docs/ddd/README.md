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
| [Live Sessions](live-sessions.md) | Evidence acquisition, live-session aggregates, replay, and dashboard delivery |

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

The GA model keeps host enablement under `integrations.hosts`, integration ownership under
`integrations`, and activity intent under top-level `routing`. These persisted locations do not
change the canonical distinction between a host and an inference provider.
