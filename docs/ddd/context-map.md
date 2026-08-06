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
                  Observability                                  Historical Usage
                    |         |                                           |
                    |         +----> Workspace Snapshot Cache             |
                    |                       |                              |
                    +-----------------------+----> Dashboard Delivery <----+
                                                          ^
Project State (.claude-flow/*) ----> Project Intelligence-+
Local filesystem + process table ---> Machine Footprint --+
Curated editorial content ----------> Component Directory-+

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

### Observability

Owns canonical live events, session identity, lifecycle, topology, evidence confidence, and live
aggregates. It consumes canonical evidence and publishes read-model projections.

See [Observability](observability.md).

### Historical usage

Owns transcript indexing, session history, token and cost aggregation, classification, and usage
findings. It may share a host-qualified session identity with Observability, but its aggregate and
cache are separate from the live event store.

### Workspace snapshot cache

Owns the bounded, owner-only last safe `SessionWorkspace` value per host-qualified session. It is
an advisory read-model cache, not the append-only Evidence Archive and not a source of liveness.
Restoration supplies inert History context using the original capture time; it cannot query a
current checkout and present that state as historical.

### Project intelligence

Owns read-only trend projections over ruflo/agentic-qe's own project-level learning state: the
neural pattern store, its lifetime learned-pattern counter, reasoning-graph size samples, and the
machine-health sample ring. It reads `.claude-flow/*` files directly — there is only ever one
shape, ak's own, so no anti-corruption adapter is required — and is independent of Evidence
Acquisition and Observability's canonical event model. It carries no session, actor, host,
provider, or lifecycle identity and grades no per-field evidence confidence.

See [Project intelligence](project-intelligence.md).

### Machine footprint

Owns read-only measurement of what the toolchain costs this machine: install bytes and install
method per managed tool, the ephemeral runtime census of host processes and daemons, the retained
data breakdown (category → host → project → session) with growth and advisory reclaimable
candidates, the deduplicated cross-host catalog inventory, and per-project approximate lines of
code and disk. Its sources are the local filesystem and the current-user process table — the same
trust boundary `ak status` and the runtime survey already cross — so no anti-corruption adapter is
required. It is structurally metadata-only: collectors read directory entries, `stat` results,
manifest names, and `.git/config`'s remote URL, so transcript, prompt, and tool-payload content
cannot enter the model. It owns no spend, activity, or learning facts, and it mutates nothing
beyond its own snapshot file.

See [Machine footprint](machine-footprint.md).

### Component directory

Owns the curated editorial identity of every component agentic-kit installs or configures: a
tagline, one plain-language paragraph, outbound source/package/docs links, an icon spec, a
category, and a stable curated order. That content is authored, checked in, and versioned with the
release — never generated, fetched, or derived at runtime. It performs no detection of its own: the
installed/version/configured chips are joined at render time from facts existing collectors already
produce, and a failed join degrades chips to unknown while the editorial content still renders in
full. It renders no numbers beyond version strings; health, cost, activity, and measurement belong
to their own contexts.

See [Component directory](component-directory.md).

### Dashboard delivery

Owns protected HTTP/SSE delivery, browser DTOs, filters, presentation, and interaction state. It
may combine read models from Observability, Historical Usage, Project Intelligence, Machine
Footprint, Component Directory, routing, and integration facts. It cannot manufacture or strengthen
domain facts.

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
| Evidence acquisition | Observability | Versioned canonical events |
| Evidence acquisition | Historical usage | Normalized transcript and provider evidence |
| Observability | Dashboard delivery | Read-model snapshots, deltas, and selected evidence |
| Observability | Workspace snapshot cache | Last safe metadata-only session workspace capture |
| Workspace snapshot cache | Dashboard delivery | Inert last-recorded History context after restart |
| Historical usage | Dashboard delivery | Historical aggregates and findings |
| Project state (`.claude-flow/*`) | Project intelligence | Direct local file reads; no anti-corruption adapter needed |
| Project intelligence | Dashboard delivery | Read-model projection, delivered by poll (`/api/status`) and SSE push (`/api/live/intelligence`) |
| Local filesystem and process table | Machine footprint | Direct metadata-only reads; no anti-corruption adapter needed |
| Project discovery | Machine footprint | Candidate paths only; every rendered figure is measured by this context's own collectors |
| Machine footprint | Dashboard delivery | Two-tier measurement read model over `GET /api/system`, and the same collector behind `ak system` |
| Integration management | Component directory | Registry consumed only as a parity gate; no editorial content flows either way |
| Detection facts (`/api/status`, managed-tools) | Component directory | Read-only join at render; a failed join degrades chips to unknown, never hides cards |
| Component directory | Dashboard delivery | Versioned editorial entries imported by the page; no endpoint, no probe, no cache |

## Boundary rules

- Native configuration and evidence schemas never become the canonical model by accident.
- User intent does not establish observed reality.
- A host observation does not establish inference-provider identity.
- Dashboard presentation cannot upgrade provenance.
- Historical usage and live topology share identifiers, not aggregate ownership.
- Network egress occurs only in commands and contexts whose contract explicitly permits it.
- Project intelligence reads local project state directly; it never enters Evidence Acquisition's
  anti-corruption layer or Observability's canonical event model, and it establishes no session,
  actor, host, provider, or lifecycle identity.
- Machine footprint measures metadata only. It never opens transcript, prompt, or tool-payload
  content, never publishes spend, session, or learning facts, and never renders an unmeasured
  value as zero.
- Component directory authors identity, it does not observe it. Editorial prose never asserts
  runtime state; installed, version, and configured render exclusively as chips fed by detection
  facts borrowed from existing collectors.
