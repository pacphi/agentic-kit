# Ubiquitous Language

This glossary is normative for agentic-kit code, CLI help, ADRs, tests, and documentation. A
bounded-context document may refine a term but should link back here rather than assign a
contradictory meaning.

## Integration language

| Term | Meaning |
|------|---------|
| Host | CLI or runtime that drives an agent session, such as Claude Code, Codex, or OpenCode |
| Inference provider | Service or local runtime that performs model inference, such as Anthropic, OpenAI, OpenRouter, or Ollama |
| Model | Provider-addressable inference target used for an execution |
| Provider binding | Persisted intent connecting one host to one inference provider through a transport and configuration projection |
| Transport | Protocol used by a binding, such as native, OpenAI-compatible, or Anthropic-compatible |
| Integration adapter | Built-in descriptor and behavior for one host, provider, configuration projection, or observability source |
| Configuration projection | Native configuration surface derived from canonical intent, such as Claude JSON, Codex TOML, or an AQE router file |
| Observability source | Bounded evidence channel that may establish specific facts |
| Source adapter | Anti-corruption layer that translates native evidence into canonical facts or events |
| Capability | Explicit behavior supported by an adapter; identity alone never implies it |
| Integration intent | Desired, persisted host and binding configuration |
| Integration facts | Immutable normalized observations about hosts, providers, and bindings |
| Managed companion | Opt-in tool that projects a bounded service into enabled hosts without becoming a host, provider, binding, routing target, or memory authority |
| Companion intent | Persisted enablement, selected-host, and per-host service/injection choice for a managed companion |
| Companion fact | Content-free observation of companion package ownership, target wiring, plugin/trust state, schema compatibility, and data health |
| Companion projection | Exact host-native wiring by which a companion exposes MCP or consented automatic events to one enabled host |
| Auto-recall | Explicitly consented injection of untrusted historical context at a named host event; not a uniform session-start capability |
| Hook source | One host-native settings, TOML, JSON, plugin or adapter-manifest origin inspected without executing its contents |
| Hook occurrence | One physical event/matcher/handler definition retained with its source pointer and digest |
| Hook behavior | Material execution identity used to link only genuinely equivalent occurrences |
| Schema profile | Exact host-version rules plus evidence and verification date; unknown versions fall back to syntax-only validation |
| Coverage statement | `complete`, `partial`, or `unsupported` audit reach plus concrete gaps; it is not a health or trust verdict |
| Remediation proposal | Read-only action description classified as automatic-eligible, approval-required, prohibited, or upstream-required |
| Upstream constraint | Versioned dependency issue, affected range, bounded local strategy, verification date, and objective sunset condition |

## Context budget language

| Term | Meaning |
|------|---------|
| Context envelope | Host/model/session-or-attempt scope within which compatible capacity and contribution facts are evaluated |
| Advertised maximum | Provider or catalogue capacity claim; not automatically an active-session denominator |
| Host nominal window | Context allocation selected by the active host/model profile |
| Runtime-effective window | Session/turn context ceiling reported by the host; preferred active denominator when compatible |
| Context contribution | One measured or estimated input to occupancy, retaining its native unit and method |
| Startup share | First token-bearing gross input divided by the compatible effective context window |
| Context pressure | Gross input tokens divided by a compatible effective window, stored in basis points |
| Context evidence coverage | Counts of eligible, measured and missing sessions plus source health; not a quality score |
| Reserve breach | Current input has consumed more than the policy's non-reserved share of the effective ceiling |
| Rematerialization | Rebuilding a prompt/context envelope for a different host/model or after compaction |
| Hook runtime receipt | Bounded supervised-execution evidence recording host, verb, effective timeout, duration, byte counts, truncation, exit code and typed outcome; it contains no authority to repair a definition |
| Hook outcome | One of `success`, `nonzero-exit`, `signal-exit`, `spawn-failed`, `timed-out`, or `integrity-rejected`; distinct from a static hook diagnostic |
| Hook read model | Sanitized join of static assurance aggregates and available typed runtime receipts; it excludes commands, paths, output and diagnostic prose |
| Managed guidance footprint | Exact UTF-8 bytes selected from agentic-kit-owned managed sentinel blocks for one host guidance target |
| Conservative token estimate | `ceil(bytes / 3)` planning estimate attached to a byte measurement; never observed tokenizer usage |
| Context audit | Read-only, privacy-safe CLI projection of managed guidance state/bytes, bounded skill metadata, MCP registration-table bytes, schema availability and effective-window evidence |
| MCP registration config bytes | UTF-8 bytes of serialized MCP registration tables only; excludes unrelated host preferences and does not measure tool schemas |

Cached input is cheaper billing evidence, not smaller context occupancy. Byte counts and conservative
token estimates never become observed token evidence. An absent or incompatible denominator is
`unknown`, never 0% pressure.

## State and evidence language

| Term | Meaning |
|------|---------|
| Present | An executable, file, endpoint, or other surface was detected |
| Enabled | Persisted user intent permits a host or integration to be used |
| Authenticated | A host login or credential mechanism is known to be usable |
| Configured | Required provider or projection configuration is present |
| Reachable | A bounded probe successfully contacted its target |
| Routable host | Host whose capabilities permit assignment of development activities |
| Primary host | Routable host selected to lead defaults and determine missing-host severity |
| Evidence | Observation supporting a fact |
| Provenance | Strength and origin of a fact: `observed`, `configured`, `inferred`, or `unknown` |
| Unknown | The available evidence cannot establish a value; it does not mean false, zero, free, absent, or unreachable |
| Ownership receipt | Exact record of a value written by `ak`, permitting narrow undo only while that value is unchanged |
| Drift | Current state differs from the last value written or expected by `ak` |
| Companion data | User-owned index, notes, privacy state, imports, and source transcripts; invoking a managed companion does not transfer ownership to `ak` |

Billing is a fact about a credentialed access path or observed execution, not an immutable vendor
identity. A vendor may support subscription-backed host login and metered API-key use. Local
billing means inference is performed by a local runtime; it does not follow merely from a zero or
missing price.

## Routing and observability language

| Term | Meaning |
|------|---------|
| Activity | Canonical category of development work, such as architecture, implementation, testing, or review |
| Route | Activity assignment to a host and model, optionally followed by escalation rungs |
| Routing policy | Persisted activity-to-route intent |
| Route provenance | Whether a route is a default, seeded by `ak`, or deliberately set by the user |
| Escalation rung | Alternate host and model tried after failure when escalation is requested |
| `ak run` | Canonical host-neutral execution of a materialized routing plan |
| Read-model projection | Derived query or UI state, distinct from a configuration projection |
| Transcript host | Host whose native artifact supplied a transcript |
| Inference identity | Provider and model supported by provider-specific or out-of-band evidence |

`Dual-host` describes two enabled peer hosts, not an execution command and not evidence that two
inference vendors served a workflow. Generalized execution belongs to `ak run`.

## Model lifecycle language

These terms define ADR-0032's implemented contract. ADR status remains Accepted while exact-head
release proof is pending.

| Term | Meaning |
|------|---------|
| Model identity | Host-, provider-, model-id-, and scope-qualified inference target, plus a digest when local bytes are mutable and evidenced |
| Model scope | Non-identifying account/profile/project/source boundary within which catalogue snapshots are comparable |
| Execution variant | Binding- or execution-level reasoning effort, service tier, modality, or similar setting; not a separate base model identity |
| Model binding | One consumer's configured reference and, when established, effective concrete model identity with provenance |
| Catalog source | Host/provider-native configuration, cache, protocol, or catalogue input with owner, transport, network policy, collection mode, schema/version, scope, freshness, completeness, and diagnostics |
| Catalog snapshot | Sanitized immutable inventory of source states, model records, bindings, scope, and diagnostics at one capture time |
| Baseline-eligible snapshot | Sufficiently complete same-scope snapshot permitted to replace the prior lifecycle comparison baseline |
| Model change | Evidence-backed difference between comparable snapshots; removal needs authoritative evidence or repeated complete absence |
| Lifecycle edge | Typed alias resolution, first-party migration, or same-family-newer relationship with provenance and scope |
| Compatibility edge | Typed mechanical swap relationship; it is not a quality or economic recommendation |
| Consumer impact | Read-only link from a lifecycle fact to affected routes, projections, Agentic QE/Ruflo consumers, or Route Intelligence evidence |
| Swap plan | Read-only impact report and copyable canonical route action; never an independent routing policy or apply operation |
| Route Intelligence feed | Mechanical candidates plus audit-preserving lifecycle invalidations; quality and economics claims are explicitly absent |
| Public catalogue identity | Human-readable model name, publisher, public selector, and trusted links retained only when bounded source evidence establishes that the identity is public |
| Private model reference | Deployment, gateway, local tag, observed-only id, or other model identity without public-catalogue proof; the Dashboard exposes only its keyed projection |
| Keyed model projection | Dashboard-only stable pseudonyms derived from the existing private scope key; distinct from exact explicit CLI evidence and source-proven public catalogue identity |

Configured, effective, observed, discoverable, entitled, policy allowed, routable, lifecycle, and
recommended are separate model-state dimensions. `Unknown` in one dimension cannot be filled from
another. A first-party migration is a supported lifecycle edge, not proof of equivalence.

## Project intelligence language

| Term | Meaning |
|------|---------|
| Pattern store | The neural pattern store's current on-disk inventory (`.claude-flow/neural/patterns.json`); shrinks under pruning or compaction |
| Patterns-learned counter | A cumulative lifetime total (`.claude-flow/neural/stats.json`'s `patternsLearned`); only ever climbs |
| Reasoning graph sample | A point-in-time structural-size measurement (`nodes`, `edges`, `pageRankSum`) of the reasoning/knowledge graph |
| Health-history ring | The capped, deduplicated sample ring recording learning-stat snapshots over time |
| Project intelligence | Read-only trend telemetry over ruflo/agentic-qe's own local learning state, distinct from Observability evidence |
| Discovered project | A project on this machine ruflo has genuinely initialized (`.claude-flow/neural/` present); found by project discovery and eligible for Intelligence selection |
| Project discovery | The registry-plus-Observability-cross-reference scan (`discoverRuvfloProjects()`) that produces the machine-wide, deduplicated, most-recently-active-first catalog of discovered projects |
| Selected project | The one discovered project whose detail the Intelligence panel currently shows; defaults to the most-recently-active discovered project, never an implicit cwd default |
| Machine-wide rollup | The `{ totals, perProject }` aggregate (`readMachineWideIntel()`) folded across every discovered project; always shown regardless of which project is selected |
| Intelligence watcher pool | The per-discovered-project pool of `IntelligenceWatch` instances backing `GET /api/live/intelligence`; a project's watcher is created on its first SSE subscriber and torn down on its last disconnect |

Pattern-store size and the patterns-learned counter are never interchangeable displays of "how many
patterns exist" — the store can be pruned while the counter keeps climbing — at single-project
scope and at machine-wide-rollup scope alike. There is no unlabeled "this project" default in
Intelligence: the panel always shows an explicitly selected, explicitly labeled project alongside
the always-visible machine-wide rollup. See [Project intelligence](project-intelligence.md).

**Project census** — the one enumeration of this machine's projects, read from the session `cwd`
recorded in every Claude and Codex transcript plus the OpenCode session store. Every area derives
its project list from it; none discovers projects independently ([ADR-0027](../adr/0027-shared-project-census.md)).

**Scope** — the named filter an area applies to the census, and the reason two areas can report
different totals without either being wrong. `everSeen` (all, deletions included), `onDisk` (still
resolvable), `gitRepos` (under version control) and `learning` (carries learning state). A count is
never rendered without the sentence naming its scope.

**Learning state** — a `.claude-flow`, `.agentic-qe` or `.swarm` directory in a project: memory or
intelligence has been *activated* there, by any host. Distinct from having been *trained*, which is
what ruflo pattern counters measure and what the retired `.claude-flow/neural/` predicate required.

**Directory scope vs project scope** — `everSeen`/`onDisk`/`gitRepos` count directories, because
directories are what have bytes and lines in them. `learning` counts projects, folding a
repository's sub-directories and its ephemeral agent worktrees onto one identity, because a project
is what a user selects.

## Machine footprint language

| Term | Meaning |
|------|---------|
| Footprint | The machine-resource cost of the toolchain: install bytes, runtime CPU/RSS, retained-data bytes, deployed inventory. The bounded context's name; the user-facing surface is called **System** |
| FootprintSnapshot | The persisted result of a deep scan: `asOf`, completeness, and the five deep-tier section models (install, storage, catalog, projects, consumers) |
| Measurement | A value plus provenance: measured (with `asOf`), carried forward, or unknown-with-reason — unknown is never zero |
| Partial measurement | A measured value known to be a lower bound because a contributing subtree was unreadable or capped; rendered as "≥ N", never as a total |
| HostInstallation | One managed tool's install facts: version, install method, root, tree bytes, native addons |
| ObservedRuntimeInstallation | A dependency-owned executor's observed CLI and payload facts, with `managed: false` and an explicit upstream update owner |
| Managed browser executor | A receipt-owned, compatibility-pinned CLI consumed by Ruflo's browser MCP; not a host, provider, companion, plugin, or skill projection |
| BrowserPayloadReadiness | Filesystem-derived browser payload status, revision, cache path, and reason; it never launches or installs the runtime |
| RuntimeCensus | The ephemeral point-in-time table of live host processes, daemons, and machine denominators |
| StorageNode | One node in the category → host → project → session breakdown: bytes + file count |
| ReclaimableCandidate | An advisory row naming reclaimable space, its path, and its rationale — never an action |
| CatalogItem | A canonical standalone or plugin-qualified capability identity with per-host/source occurrences; logical-name and digest overlap are relationships, not identity |
| Catalog occurrence | One observed capability placement: host, source scope, project, artifact path, producer/version/state, entrypoint/full-definition evidence, optional Git state, and evidence authority |
| Project capability pressure | Per-project/per-host inventory of project, user, and enabled-plugin contributions plus exact-name/entrypoint overlap; never a claim about host context inclusion |
| Entrypoint digest | SHA-256 of one bounded regular capability entrypoint; equality proves only those bytes, not supporting files, ownership, safety, or context loading |
| Definition digest | SHA-256 over one complete bounded observed capability definition; equality proves those files match, not host selection, ownership, usage, intent, or removal safety |
| Skill maintenance preview | The implemented `ak x skills plan` content-derived classification and projected change set; read-only evidence for a human decision, not a MaintenancePlan or authorization to mutate |
| ProjectFootprint | One project's size facts: approximate LOC by language, tree/`.git`/`node_modules` bytes, last activity, and an optional git-remote web link ("local only" when absent) |
| Deep scan | The explicit, user-triggered, single-flight full measurement pass that produces a FootprintSnapshot |
| Cheap tier | The per-request census + known-file stats + snapshot carry-forward served on every read |

A measured zero is a real zero and renders as one; an unmeasured or failed figure renders as
unknown with its reason. Storage bytes and Usage tokens are different facts about the same
transcript and never substitute for each other. See [Machine footprint](machine-footprint.md).

## Maintenance language

These terms describe the implemented architecture in
[ADR-0044](../adr/0044-receipt-aware-maintenance-control-plane.md).

| Term | Meaning |
|------|---------|
| Maintenance | The human-guided control-plane bounded context for evidence-backed lifecycle recommendations and provider-owned, verified, receipted actions; exposed beneath System without becoming part of Machine Footprint |
| MaintenanceFinding | An evidence-backed resource condition with source, freshness, completeness, ownership, impact, and missing evidence; never itself an action |
| CapabilityRelationship | Typed project/shared evidence classified as an identical project copy, different definition, tracked project copy, or equivalent legacy transport; a relationship does not confer mutation authority |
| SuggestedAction | A finding's recommendation, ordered procedure, expected effect, preservation boundary, and automation-blocking reason; human guidance until a provider authorizes an executable action |
| MaintenanceAction | One exact ActionProvider operation with target, projected result, safety class, rollback class, restart requirement, and verification contract |
| MaintenancePlan | An immutable, short-lived selection of MaintenanceActions bound to exact source state, scope, safety class, expiry, and content-derived digest; evidence identity, not authorization |
| ActionProvider | A resource-owner-specific lifecycle port that advertises only proven operations and implements detect, findings/actionFor, preflight, apply, verify, current-state inspection, and guarded undo where supported |
| ActionCapability | Ephemeral one-use authorization bound to a dashboard session, current plan digest, selected action IDs, source fingerprint, scope, safety class, and expiry |
| TransactionReceipt | Private durable evidence binding intent, policy decision, exact inputs, before-state, fixed operation, result, verification, after-state, rollback, and compensation |
| Source fingerprint | A digest over the complete bounded evidence set a plan depends on; a mismatch or incomplete reacquisition expires the plan |
| Safety class | One of `safe-automatic`, `approval-required`, `upstream-required`, or `never-automatic`; an executable class still requires explicit human confirmation |
| Rollback class | Reversible, compensating, or irreversible; independent of action safety and disclosed before confirmation |
| Recovery-required receipt | Durable evidence that provider dispatch may have occurred but the exact outcome was not proven; it blocks later mutations until reconciled |
| Receipt reconciliation | Observation-only comparison of every receipt entry with its recorded preimage and verified postimage; never a replay, retry, undo, or compensation |
| Maintenance mutation lock | Private integrity-sealed serialization record; reclaimable only on the same machine and numeric UID when the recorded PID is provably dead and a second guarded check agrees |

A plan identifier is not an ActionCapability, and an ActionCapability is not a
TransactionReceipt. A successful native command without a verified postcondition is not a
successful Maintenance transaction. A receipt records non-atomic effects; it does not make them
atomic. See [Maintenance](maintenance.md).

## Component directory language

| Term | Meaning |
|------|---------|
| Component directory | The curated catalog of everything ak installs or configures, with editorial identity per entry |
| DirectoryEntry | One component's editorial identity: category, tagline, paragraph, links, icon, and a detection join key |
| Editorial content | Authored, versioned prose and links — the part of a card that is true regardless of machine state |
| Detection fact | An observed install/version/configured fact borrowed read-only from existing collectors, rendered only as chips |
| State chip | The card element that renders detection facts (`installed v…` / `not installed — ak setup adds it` / `configured` / `unknown`) |
| Monogram tile | The honest icon for a component with no official mark: initials on a category-hued tile |
| Register contract | The editorial writing rules (one ~50-word paragraph, plain language, active voice, no runtime claims, no superlatives) |
| Parity gate | The test asserting managed-tools registry ↔ directory completeness in both directions |
| Configured surface | A non-package thing ak sets up — MCP registrations, guidance blocks, statuslines, routing and shared tool access, the daemon, permission allowlists — carrying a managing command instead of package links |

Editorial content states purpose and reads true on a machine where the component is absent;
runtime state is a chip word, never a prose word. See
[Component directory](component-directory.md).

## Usage rules

- Say **host** for any session driver or activity-routing target the registry recognizes —
  Claude Code, Codex, and OpenCode are the built-in examples, not the exhaustive list — and for
  leadership.
- Say **inference provider** when referring to Anthropic, OpenAI, OpenRouter, Ollama, billing,
  provider credentials, or inference endpoints.
- Qualify **projection** as configuration projection or read-model projection when ambiguity is
  possible.
- Qualify **adapter** as integration adapter or source adapter when ambiguity is possible.
- Say **catalogue source** for model discovery evidence and **catalog snapshot** for the normalized,
  sanitized local record; neither is canonical routing policy.
- Keep **execution host**, **serving provider**, **publisher**, and **public model selector** separate;
  none can be inferred from another or from a human-readable model name.
- Say **public catalogue identity** only when a bounded source proves it. Say **private model
  reference** when public identity is absent or ambiguous; do not expose its exact value in the
  Dashboard.
- Say **compatible candidate** only when required mechanical facts are established. Reserve
  **cheaper equivalent** and **premium justified** for Route Intelligence evidence.
- Do not infer an inference provider from a transcript host alone.
- Do not call a managed companion a host, memory authority, or observability source. Name the exact
  companion projection or automatic event when injection behavior matters.
- Do not replace an unknown fact with a convenient default.
- Do not call a hook configured, selected, trusted, reachable, healthy, or authorized unless the
  evidence establishes that exact dimension. A coverage statement never upgrades those facts.
- Say **System** for the dashboard area and the command; say **Machine footprint** only for the
  bounded context and its module directory. No user-facing string says "footprint".
- Say **About** for the dashboard area and the command; say **Component directory** only for the
  bounded context.

## Persisted names

- `ak host` and `ak x host` manage execution hosts and routing; they do not redefine inference
  providers.
- `ak system [--deep] [--json]` renders the Machine footprint collector; `ak about [--category]
  [--json]` renders the Component directory. Both are read-only twins of a dashboard area.
- `ak models` is the read-only model inventory, refresh, diff, explain, and plan family. Route
  mutation remains `ak host pick`; there is no accepted `ak models apply`.
- `kit.json.integrations.hosts` records enabled hosts. Top-level `routing` records `version`,
  `primaryHost`, and per-activity `routes`; route entries use `provenance` and `escalation`.
- Derived exports in `hosts.mjs`, `providers.mjs`, and `routing.mjs` are views, not independent
  domain registries.
