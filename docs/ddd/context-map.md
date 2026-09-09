# Context Map

Agentic-kit is a zero-runtime-dependency CLI with several bounded contexts. The boundaries below
identify who owns each decision and where translation is required.

```text
Configuration Intent
        |
        +----> Integration Management ----> Native Configuration Surfaces
        |                 |       |
        |                 |       +----> Managed Companion Surfaces
        |                 +----> Hook Configuration Assurance
        |                 +----> Supervised Hook Execution ----> Hook Runtime Receipts
        |                 +----> Routing and Orchestration
        |
Native Evidence ----> Evidence Acquisition ----> Canonical Evidence
                                                   |
                         +-------------------------+----------------------+
                         |                         |                      |
                         v                         v                      v
                  Observability        Model Lifecycle Intelligence  Historical Usage
                    |         |                    |               \      |
                    |         +----> Workspace     +------> Context Budget Intelligence
                    |                Snapshot Cache                       |
                    +-----------------------+----> Dashboard Delivery <----+
                                                          ^
                                      Hook Configuration Assurance -------+
                                      Hook Runtime Receipts --------------+
                                                          ^
Project State (.claude-flow/*) ----> Project Intelligence-+
Local filesystem + process table ---> Machine Footprint --+
                                           |               |
Integration Management -------------------+----> Maintenance
                                                           |
                                                           +----> Dashboard Delivery
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
projection lifecycle, companion lifecycle specialization, config migration, and value-precise
ownership. Native JSON, TOML, environment, CLI, and companion surfaces are downstream
representations. A managed companion consumes enabled-host identity but gains no host, provider,
routing, observability, or curated-memory authority.

See [Integration management](integration-management.md).

### Maintenance

The Focus browser amendment approved on 2026-09-08 is a Dashboard interaction over the existing
management projection; its automated coverage does not close the separate human and platform
acceptance gates. Scope/repository/type/family browsing
and context-preserving relationship links add no measurement, provenance, or action authority.
See the [current Maintenance guide](../MAINTENANCE.md).

Maintenance is the human-guided control plane for upgrades, stale/unsupported resource cleanup,
lifecycle remediation, verification, guarded undo, recovery, and receipts. It does not own the
facts it manages and cannot promote disk presence, age, digest equality, or a read-only plan into
mutation authority.

Issue #198 delivered the read-only Catalog and preview seam. ADR-0044 implements the control-plane
architecture as a secondary destination under System. Machine Footprint collectors, Catalog,
Advisory, and other System measurement routes remain non-mutating. See [Maintenance](maintenance.md).

ADR-0045 separates one physical artifact from its host ConsumerBindings. Machine Footprint owns
those observations; Maintenance consumes the active bindings as blast-radius evidence.

ADR-0048 adds the **Maintenance Resource Management projection**: a versioned, privacy-projected
`ManagementInventory` built over several upstream contexts without gaining any of their authority —

- **Machine Footprint** — Catalog v4 items, install/storage/runtime sections, and explicit provider
  scan reports, at exact placement grain;
- **Project Census** — candidate project identities and observed paths, joined with Maintenance's
  own Discovery source configuration to decide scan inclusion, which the census itself does not own;
- **Integration Management** — provider bindings, credential-readiness presence facts, and desired
  host state, never a credential value;
- **Model Lifecycle Intelligence** — the model-inventory snapshot, consumed as `model`-kind
  placements without duplicating that context's own diff/lifecycle ownership;
- **Hook Configuration Assurance** — the sanitized hook read model, joined as `hook`-kind
  placements with no new healing authority; and
- **Configuration Intent** — `kit.json`'s `maintenance.discovery` key, the one piece of Discovery
  source configuration that is genuinely user intent rather than observed evidence.

Discovery's resumable scans are a journal-backed orchestration seam **over** ADR-0047's streaming
observation forest (`src/lib/footprint/observation-forest.mjs`), not a second walker or a
persistent per-file index: a scan partitions a source root into bounded units, executes each
through the shared forest, and writes an owner-private, integrity-sealed checkpoint after every
partition or work slice. Maintenance also owns explicit provider scans and their persisted reports;
dashboard polling reads the report and cannot silently become provider discovery.

### Hook configuration assurance

Owns host-neutral read-only discovery of lifecycle sources; normalized occurrences and
material behavior identity; coverage gaps; diagnostics; and remediation authority
proposals. It consumes host identity, project scope and validated external adapter
manifests. Discovery never executes hook/plugin code. Exact-profile healing uses its separate explicit
mutation port; ordinary discovery owns no host trust, consent, grant, installation or routing
authority.

It may contribute the static half of a sanitized Hook read model. It does not own supervised
execution receipts and cannot reinterpret an absent runtime stream as zero failures.

See [Hook configuration assurance](hook-configuration-assurance.md).

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

Current cache schema v20 records bounded parse-time project evidence and explicit Desktop origin.
The additive `projectGroups` projection retains every admitted session and its traceable membership.
The visible Usage Score **Projects** ranking instead uses `gitProjects`: only existing, non-user
Git parents with verified association qualify, and worktree costs roll into their real parent.
It shows the top ten by API-equivalent cost; user-level, missing-parent and unclassified sessions
remain in overall totals. These are different populations, not competing whole-machine totals.
No historical Git association is reconstructed from a current repository name or shared remote.

Prompt Telemetry is a Historical Usage subdomain. It owns privacy-bounded prompt fingerprints,
controlled semantic facets, recurring-cluster evidence and deterministic presentation names. It
does not own prompt text, coaching, model enrichment or mutable labels.

See [Prompt telemetry](prompt-telemetry.md) and
[ADR-0039](../adr/0039-prompts-intelligence.md).

### Context budget intelligence

Owns compatible context-window evidence resolution, conservative startup/dynamic policy, context
pressure decisions, and bounded context read models. It consumes runtime session evidence from
Historical Usage and capacity candidates from Model Lifecycle Intelligence. It does not parse
transcripts, publish model catalogues, execute hooks, mutate routes, or treat byte counts as
observed tokens.

See [Context budget intelligence](context-budget-intelligence.md) and
[ADR-0042](../adr/0042-capability-aware-context-budget-intelligence.md).

### Model lifecycle intelligence

Owns the normalized inventory of configured, effective, observed, discoverable, entitled,
policy-allowed, routable, and lifecycle model facts; sanitized same-scope snapshots; trustworthy
diffs; lifecycle and compatibility edges; and read-only consumer impact plans. It consumes
Configuration Intent, integration descriptors, source-adapted native catalogues, and structured
observed facts from Historical Usage and Observability. It does not own transcripts, route
mutation, model quality, or downstream router policy.

See [Model lifecycle intelligence](model-lifecycle-intelligence.md). The context and exact-head
release proof are recorded by implemented ADR-0032.

### Workspace snapshot cache

Owns the bounded, owner-only last safe `SessionWorkspace` value per host-qualified session. It is
an advisory read-model cache, not the proposed (unimplemented) append-only Evidence Archive or a
source of liveness.
Restoration supplies inert History context using the original capture time; it cannot query a
current checkout and present that state as historical.

### Project intelligence

Owns read-only trend projections over ruflo/agentic-qe's own project-level learning state: the
neural pattern store, its lifetime learned-pattern counter, reasoning-graph size samples, and the
machine-health sample ring. It uses bounded readers for the supported `.claude-flow/*` shapes, independently of
Observability's canonical event model, and may append its own deduplicated health-history ring.
It carries no session, actor or lifecycle identity and grades no per-field evidence confidence. Learning-scope and
Desktop-origin qualifiers belong to the picker projection, not its time-series evidence.

See [Project intelligence](project-intelligence.md).

### Machine footprint

Owns read-only measurement of what the toolchain costs this machine: install bytes and install
method per managed tool, the ephemeral runtime census of host processes and daemons, the retained
data breakdown (category → host → project → session) with growth and advisory reclaimable
candidates, the deduplicated cross-host catalog inventory, and per-project approximate lines of
code and disk. Its sources are the local filesystem and the current-user process table — the same
trust boundary `ak status` and the runtime survey already cross — so no anti-corruption adapter is
required. Its enumerated metadata surface includes directory/stat data, bounded manifest fields and
resource descriptions, transient source bytes for LOC, Git metadata, and opening transcript
identity/origin declarations. Message bodies, prompts and tool payloads do not enter the read model. It owns no spend, activity, or learning facts, and it mutates nothing
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

Dashboard Delivery owns ADR-0044's narrowly allowlisted Maintenance POST boundary and accessible
confirmation/progress/receipt interaction. Maintenance, not the browser, owns policy, fixed
operations, verification, and receipts. Other routes retain their explicitly documented method allowlists. Maintenance v2 exposes
read-only interruption audits and separately confirmed reconciliation; neither replays a provider
action, and neither follows from ordinary polling.

### Maintainer administration

Owns deliberately-egressing repository, release, package, CI, and security telemetry. Its network
and credential policy is distinct from the offline-first dashboard and integration config loader.

## Relationships and translation

| Upstream | Downstream | Relationship |
|----------|------------|--------------|
| Configuration intent | Integration management | Desired state; detection and verification remain independent |
| Integration management | Native surfaces | Configuration projections with ownership receipts |
| Integration management | Managed companion surfaces | Opt-in package and explicit per-host projections; plugin/data ownership stays separate |
| Integration management | Routing and orchestration | Capability-qualified host and binding facts |
| Integration management | Hook configuration assurance | Host identity and validated external adapter data; admission, consent, grants and execution stay upstream |
| Project census | Hook configuration assurance | Explicit project roots for bounded source discovery; no project trust is inferred |
| Native hook configuration | Hook configuration assurance | Host-specific anti-corruption providers produce normalized sources, occurrences, diagnostics and gaps |
| Historical usage | Context budget intelligence | Bounded per-session first/last/peak token and runtime-window evidence; transcript ownership stays upstream |
| Model lifecycle intelligence | Context budget intelligence | Capacity candidates with provenance; catalogue maximum is not active-session pressure |
| Context budget intelligence | Routing and orchestration | Read-only budget decision for each materialized route attempt; launch authority stays downstream |
| Context budget intelligence | Dashboard delivery | Sanitized bounded coverage, pressure, policy and attention read model |
| Hook configuration assurance | Dashboard delivery | Lazy sanitized static sources, occurrences, diagnostics, coverage and proposals; runtime remains a separate receipt-backed field |
| Integration management / supervised adapter runner | Dashboard delivery | Bounded typed hook receipts for executions agentic-kit actually supervised; no native-host outcome inference |
| Native evidence | Evidence acquisition | Source-specific anti-corruption adapters |
| Evidence acquisition | Observability | Versioned canonical events |
| Evidence acquisition | Historical usage | Normalized transcript and provider evidence |
| Configuration intent | Model lifecycle intelligence | Canonical route, escalation, binding, and projection references |
| Integration management | Model lifecycle intelligence | Capability and catalogue descriptors plus bounded host/provider facts |
| Evidence acquisition | Model lifecycle intelligence | Source-adapted catalogue, policy, lifecycle, and runtime evidence |
| Historical usage | Model lifecycle intelligence | Structured observed host/provider/model facts; transcript ownership stays upstream |
| Observability | Model lifecycle intelligence | Structured recent execution identity; live-event ownership stays upstream |
| Model lifecycle intelligence | Routing and orchestration | Read-only lifecycle diagnostics, mechanical candidate/invalidation feed, and copyable canonical route actions; no quality/economics claim |
| Model lifecycle intelligence | Dashboard delivery | Sanitized cache-only inventory, changes, consumers, and plan read models |
| Observability | Dashboard delivery | Read-model snapshots, deltas, and selected evidence |
| Observability | Workspace snapshot cache | Last safe metadata-only session workspace capture |
| Workspace snapshot cache | Dashboard delivery | Inert last-recorded History context after restart |
| Historical usage | Dashboard delivery | Historical aggregates and findings |
| Project state (`.claude-flow/*`) | Project intelligence | Direct local file reads; no anti-corruption adapter needed |
| Project intelligence | Dashboard delivery | Read-model projection, delivered by poll (`/api/status`) and SSE push (`/api/live/intelligence`) |
| Local filesystem and process table | Machine footprint | Direct metadata-only reads; no anti-corruption adapter needed |
| Project census | Machine footprint | Candidate paths only, at directory granularity; every rendered figure is measured by this context's own collectors |
| Project census | Project intelligence | The `learning` scope, folded onto project identity — the project list and the selectable key |
| Project identity helpers | Historical usage | Parse-time Git association and explicit Desktop origin; schema-v20 evidence drives the existing-parent Git ranking without changing overall usage totals |
| Machine footprint | Dashboard delivery | Two-tier measurement read model over `GET /api/system`, and the same collector behind `ak system` |
| Machine footprint | Maintenance | Observed inventory, pressure, freshness, and advisory facts only; no ownership or mutation authority crosses the boundary |
| Integration management | Maintenance | Provider capabilities, native lifecycle facts, desired state, and exact ownership receipts |
| Project census | Maintenance | Candidate project identities and paths only; Maintenance's own Discovery configuration decides scan inclusion |
| Model lifecycle intelligence | Maintenance | The model-inventory snapshot only; lifecycle diffs, sources, and bindings stay owned upstream |
| Hook configuration assurance | Maintenance | The sanitized hook read model only; healing authority and remediation proposals stay owned upstream |
| Configuration intent | Maintenance | `kit.json`'s `maintenance.discovery` user intent for automatic sources, exact projects, collection roots, and exclusions |
| Maintenance | Native configuration and lifecycle surfaces | Fixed provider operations with preflight, verification, current-state inspection, and explicit unsupported results; no generic shell or delete adapter |
| Maintenance | Dashboard delivery | A privacy-projected management inventory, guidance, discovery, and activity read models; source-bound plans, one-use action capability exchange, progress, receipts, and guarded undo; interruption-audit reads are the only recovery evidence exposed in the browser |
| Integration management | Component directory | Registry consumed only as a parity gate; no editorial content flows either way |
| Detection facts (`/api/status`, managed-tools) | Component directory | Read-only join at render; a failed join degrades chips to unknown, never hides cards |
| Component directory | Dashboard delivery | Versioned editorial entries imported by the page; no endpoint, no probe, no cache |

### Project census (shared kernel)

`src/lib/project-census.mjs` is the one enumeration of this machine's projects
([ADR-0027](../adr/0027-shared-project-census.md)). It is a **shared kernel**, not a context: it
provides session-derived candidates plus named scopes and learning-identity folding. Each
consumer applies its own population rules and takes its own measurements. Maintenance additionally
accepts user-configured Discovery roots. `resolveProjectIdentity` preserves existing learning/live
keys; `footprint/project-identity.mjs` supplies stricter current Git association evidence for
additive grouping. Neither display grouping nor a basename changes an action or session ID.

The kernel deliberately serves **two granularities**. Machine footprint consumes directories,
because directories are what have bytes and lines in them. Project intelligence consumes projects,
folded onto identity, because a project is what a user selects. Collapsing those would either
destroy the System area's per-directory figures or break the Intelligence picker; both were
observed before the split was made explicit.

## Boundary rules

- Native configuration and evidence schemas never become the canonical model by accident.
- User intent does not establish observed reality.
- A host observation does not establish inference-provider identity.
- Dashboard presentation cannot upgrade provenance.
- Model lifecycle inventory cannot turn discovery into entitlement, compatibility into quality, or
  a read-only plan into route mutation.
- Snapshot comparison requires stable scope and sufficient source completeness; degraded evidence
  never creates removal.
- Historical usage and live topology share identifiers, not aggregate ownership.
- Context pressure requires a token-compatible numerator and denominator. Unknown capacity, bytes,
  stale evidence and external self-assertions never become a percentage or a zero.
- Network egress occurs only in commands and contexts whose contract explicitly permits it.
- Every project count is rendered with the scope that produced it; two contexts may report
  different totals, but neither may report an unexplained one.
- Project intelligence reads local project state directly; it never enters Evidence Acquisition's
  anti-corruption layer or Observability's canonical event model, and it establishes no session,
  actor or lifecycle identity. Picker host-origin qualifiers do not establish live execution.
- Machine footprint retains only the metadata enumerated in its read-surface contract. Bounded
  transcript-head parsing extracts identity/origin fields, never message bodies; spend, activity
  and learning counters remain in their owning contexts. Unmeasured values never become zero.
- Maintenance cannot derive authority from a Machine Footprint observation. It acts only through a
  capability-advertising provider, a current source-bound plan, explicit confirmation, live
  preflight, verification, and a durable receipt. Unsupported operations stay report-only.
- The Maintenance Resource Management projection reads Project Census, Model Lifecycle
  Intelligence, and Hook Configuration Assurance evidence without acquiring any of their ownership:
  it cannot decide scan inclusion for the census, diff or source a model for Model Lifecycle
  Intelligence, or gain healing authority from a hook occurrence.
- Dashboard placement does not merge contexts: System measurement routes remain read-only, and
  only the exact ADR-0044 Maintenance routes are non-GET exceptions.
- Component directory authors identity, it does not observe it. Editorial prose never asserts
  runtime state; installed, version, and configured render exclusively as chips fed by detection
  facts borrowed from existing collectors.
- Managed companion surfaces stay downstream of Integration management. Their ability to read host
  history or inject recalled context does not make them hosts, evidence owners, or policy
  authorities; consent, content-free observation, and ownership-safe teardown remain upstream.
- Hook assurance discovery is read-only. It never imports an OpenCode plugin, executes a hook,
  fetches a remote adapter by default, changes trust, or treats a diagnostic as write authority.
  The separate healing port requires an exact action, plan, profile, preimage and explicit apply.
- A static hook occurrence is not a runtime outcome. A supervised receipt does not prove native
  Claude, Codex or OpenCode lifecycle behavior, and an absent receipt stream is `not-recorded`.
