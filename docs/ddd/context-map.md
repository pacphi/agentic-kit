# Context Map

Agentic-kit is a zero-runtime-dependency CLI with several bounded contexts. The boundaries below
identify who owns each decision and where translation is required.

```text
Configuration Intent
        |
        +----> Integration Management ----> Native Configuration Surfaces
        |                 |
        |                 +----> Routing and Orchestration
        |
Native Evidence ----> Evidence Acquisition ----> Canonical Evidence
                                                   |
                         +-------------------------+----------------------+
                         |                                                |
                         v                                                v
                  Live Sessions                                  Historical Usage
                         |                                                |
                         +-----------------> Dashboard Delivery <---------+

Maintainer Administration is a separate, deliberately-egressing context.
```

## Bounded contexts

### Configuration intent

Owns the user's persisted desired state in `kit.json`, including enabled hosts, primary-host
choice, routing policy, provider fallback configuration, and versioned integration bindings. It
does not prove that an executable, credential, or endpoint is usable.

### Integration management

Owns the registries, capabilities, binding validation, normalized integration facts, managed
projection lifecycle, config migration, and value-precise ownership. Native JSON, TOML, environment,
and CLI surfaces are downstream representations.

See [Integration management](integration-management.md).

### Routing and orchestration

Owns activities, routes, defaults, route provenance, primary-host mirroring, escalation, worker
materialization, and execution of Claude/Codex collaboration pipelines. It consumes routable-host
capabilities and configuration intent. It does not decide inference-provider identity.

See [Routing and orchestration](routing-and-orchestration.md).

### Evidence acquisition

Owns discovery, parsing, checkpoints, and translation of host- or provider-native evidence.
Source adapters form an anti-corruption layer: native transcript, quota, catalog, runtime, and
metadata shapes do not cross into the domain unchanged.

### Live Sessions

Owns canonical live events, session identity, lifecycle, topology, evidence confidence, and live
aggregates. It consumes canonical evidence and publishes read-model projections.

See [Live Sessions](live-sessions.md).

### Historical usage

Owns transcript indexing, session history, token and cost aggregation, classification, and usage
findings. It may share a host-qualified session identity with Live Sessions, but its aggregate and
cache are separate from the live event store.

### Dashboard delivery

Owns protected HTTP/SSE delivery, browser DTOs, filters, presentation, and interaction state. It
may combine read models from Live Sessions, Historical Usage, routing, and integration facts. It
cannot manufacture or strengthen domain facts.

### Maintainer administration

Owns deliberately-egressing repository, release, package, CI, and security telemetry. Its network
and credential policy is distinct from the offline-first dashboard and integration config loader.

## Relationships and translation

| Upstream | Downstream | Relationship |
|----------|------------|--------------|
| Configuration intent | Integration management | Desired state; detection and verification remain independent |
| Integration management | Native surfaces | Configuration projections with ownership receipts |
| Integration management | Routing and orchestration | Capability-qualified host and binding facts |
| Native evidence | Evidence acquisition | Source-specific anti-corruption adapters |
| Evidence acquisition | Live Sessions | Versioned canonical events |
| Evidence acquisition | Historical usage | Normalized transcript and provider evidence |
| Live Sessions | Dashboard delivery | Read-model snapshots, deltas, and selected evidence |
| Historical usage | Dashboard delivery | Historical aggregates and findings |

## Boundary rules

- Native configuration and evidence schemas never become the canonical model by accident.
- User intent does not establish observed reality.
- A host observation does not establish inference-provider identity.
- Dashboard presentation cannot upgrade provenance.
- Historical usage and live topology share identifiers, not aggregate ownership.
- Network egress occurs only in commands and contexts whose contract explicitly permits it.
