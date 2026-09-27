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
| Watched upstream thread | Upstream issue or pull request in the upstream registry's watch list: what done means, the ak adjustment it unblocks, a lifecycle status from watching to retired, and dated history |
| Upstream watch ledger | The pinned, locked "Upstream watch" issue (pacphi/agentic-kit#243); each event is one `UPSTREAM-WATCH <id> <event> <date>` line, only the routine's and our logins' comments count, and an exact line the routine recorded is never acted on twice |
| Confirmed release | A published version whose tag contains the merged pull request or commit that fixed a watched thread (or the recorded first fixed version); only a confirmed release is dispatched |
| Reviewed thread | A watch entry with a dated `reviewed` history line: its comments up to that day were read and need no reply |
| Upstream dispatch | Draft pull request on `upstream/<id>` that makes a released thread's adjustment and passes its dependency's removal proof; the watcher never merges it |

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
| Managed by ak | Host management state: `kit.json` enables the host, so `ak` wires it and routes work to it; a management fact, never a health verdict |
| Found, not managed | Host management state: the executable is on `PATH` but `ak` does not manage the host; still health-checked, with problems reported as information |
| Not installed | Host management state: the executable is not on `PATH` and `ak` does not manage the host |
| Participating host | Managed host that `ak`'s per-activity routing policy may target (dual-host routes, projected AQE agent routes, `ak run`); the AQE provider chain, qe-court configuration and Ruflo's own dual-mode skills are separate axes |
| Authenticated | A host login or credential mechanism is known to be usable |
| Configured | Required provider or projection configuration is present |
| Reachable | A bounded probe successfully contacted its target |
| Routable host | Host whose capabilities permit assignment of development activities |
| Primary host | Routable host selected to lead defaults and determine missing-host severity |
| Evidence | Observation supporting a fact |
| Provenance | Strength and origin of a fact: `observed`, `configured`, `inferred`, or `unknown` |
| Unknown | The available evidence cannot establish a value; it does not mean false, zero, free, absent, or unreachable |
| Live-check evidence | The last result of a live check (`passed`, `failed`, or `inconclusive`), with a bounded reason, its source (`sync`, `verify`, `status-live`), time, and an inputs key; status shows it with its age, marks it stale after a TTL, and marks it invalidated when the inputs key differs. Reading it never probes |
| Quick live checks | The bounded, no-cost subset of `ak x verify` that `ak status --live` runs in parallel: AQE embedding request, Codex MCP handshake, provider wiring, security packages, deja-vu structure, temp-dir memory round trip; a timeout is `inconclusive` |
| Memory route observation | What `ak x verify memory` reports after its CLI proof, in its throwaway project only: whether a key written through Ruflo's CLI is readable through MCP and the reverse, where each landed, and the MCP backend seen. A split is a warning and an unusable interface is "not observed"; it never fails the suite, is not part of the quick live checks, and says nothing about an existing corpus |
| Observed routing pair | An exact `@claude-flow/cli` release and platform on which the memory route observation was recorded. Only for such a pair does status say which Ruflo interface reads which project-memory store; a neighbouring, prerelease or build-tagged version, or another platform, stays unverified |
| Canonical memory store | `<root>/.swarm` for the root every ak memory launch contract pins (the repository root, else the folder, unless that is an unsuitable memory folder): `memory.db` and, with the native bridge, `agentdb-memory.db`. Status reports it from any subfolder, with each file's size, live WAL, largest namespace and how much of it is set to expire |
| Unsuitable memory folder | A folder that never holds a Ruflo store: the filesystem root, the home folder itself, a temporary root (not the folders below it, even when the temporary root lies inside a tool's folder, as Windows' `%TEMP%` does), or anything inside a tool's own folder (`~/.codex`, `~/.claude`, `~/.config`, `~/.local`, `~/.cache`, `~/Library/Application Support`, `%APPDATA%`, `~/.claude-flow`, `~/.ruflo`, and their environment overrides) |
| User-level memory store | `~/.claude-flow/memory`: the one store Codex's Ruflo launcher uses when it starts in an unsuitable memory folder, pinned through `CLAUDE_FLOW_MEMORY_PATH` and `CLAUDE_FLOW_DB_PATH`. Named after Ruflo's user-level state folder; Ruflo itself defines no user-level memory store. Status reports it and lists `~/.swarm` and `~/.codex/.chatgpt-projects/*/.swarm` as strays |
| Stray memory store | A memory file this project's hosts do not read, traced to its owner: a Ruflo store under `.swarm/` other than the canonical pair and `.swarm/backups/`, or in a subfolder's `.swarm/`; `./agentdb.db`, `./agentdb.rvf` or `./ruvector.db`; or a `.agentic-qe/` below the project root. Status reports it for information only; ak never moves, merges or deletes it |
| Memory root pin | A minimal `claude-flow.config.json` with `memory.persistPath: ".swarm"` that ak writes before registering a provider in a project with no Ruflo JSON configuration, so Ruflo's settings writer cannot create one from defaults that move memory to `./data/memory` (ruvnet/ruflo#3193). ak never writes it over an existing file and restores it if Ruflo changes it |
| Managed daemon settings | What ak sets so a project's Ruflo daemon runs backup and distillation: flat keys in `.claude-flow/config.json` gated by Ruflo version and platform, and `claudeFlow.daemon.autoStart: true` unless `kit.json` `rufloDaemon.autoStart` is false. Each change has a receipt in `kit.json` `rufloDaemon.receipts` that `ak uninstall` uses to restore |
| Memory maintenance age | How long ago Ruflo last backed up and distilled `memory.db`, read from the daemon's `.claude-flow/metrics/{backup,consolidation}.json` and the newest `.swarm/backups/memory-*.db`. Both are Ruflo daemon workers that ak monitors and never runs; neither covers `agentdb-memory.db`. A backup older than 48 hours warns only when no daemon runs for the project |
| Ownership receipt | Exact record of a value written by `ak`, permitting narrow undo only while that value is unchanged |
| Install-edit receipt | An ownership receipt for a change ak makes inside another tool's install (today only the natives heal's better-sqlite3 lines in a bundled `package.json`): file, field, original value, ak's value and time, written before the edit. *Applied* while the file holds ak's value, *superseded* once an upgrade or reinstall replaced it. Status and About show applied edits; `ak uninstall` restores only applied ones |
| Drift | Current state differs from the last value written or expected by `ak` |
| Repair contract | Who performs a status row's fix: `sync` (an `ak sync` step does it, so sync plans it) or `manual` (a human must; sync never plans it). A row without a fix has none |
| Unresolved repair | A fix `ak sync` planned that did not take: its row is still present after the apply phase, or no sync step performs it. Sync reports it and exits 1. A subsystem left out with `--skip` is "skipped by request", never unresolved |
| Companion data | User-owned index, notes, privacy state, imports, and source transcripts; invoking a managed companion does not transfer ownership to `ak` |
| ObservationSpec | A bounded virtual-walk declaration: lexical root, contract version, budgets, pruning, accepted metadata, reducer, and one scan timestamp |
| Observation forest | A scan-local lexical trie that routes each physical filesystem event to independent compatible ObservationSpecs without retaining a cross-scan file index |

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

## Session surface language (mostly proposed)

These terms are proposed by [ADR-0060](../adr/0060-session-surface-initiator-and-product-names.md).
Only **Imported session copy** is implemented so far, and only in usage and project discovery. For
the rest, the implemented contract is ADR-0050's **session origin** (`claude-desktop`,
`codex-desktop` or `unknown`), which an imported copy never supplies.

| Term | Meaning |
|------|---------|
| Session surface | The product surface that started a session, read from the host's own declared field (Claude `entrypoint`; Codex `originator` with `source`) and shown by its official name, such as Claude Code CLI, Claude Desktop, ChatGPT desktop app · Codex, or Codex CLI |
| Initiator | Who started a session: a person, automation (scripts, SDKs, non-interactive runs, CI), an agent (a subagent or reviewer spawned by another session), or an imported copy |
| Imported session copy | A session one tool copied from another, such as a Claude Code transcript the ChatGPT desktop app imported as a Codex thread; excluded from usage, origin and project counts and reported as a count |
| Raw surface value | The exact declared value a surface was derived from; always kept, and shown for any value the vocabulary does not recognize |
| Tool workspace | A folder a tool creates for its own work outside the user's projects, such as `~/.codex/.chatgpt-projects/…` or `~/Documents/Codex/…`; an explanation attribute, never a surface |
| Desktop application | Claude Desktop or the ChatGPT desktop app; an application that can start sessions, not a host |

Say **session surface** for where a session came from; the Live event `surface` field (native, ruflo,
aqe, plugin, skill, internal) names which component emitted an event and is a different concept.
Never derive a surface from a folder, and never show "VS Code" for Codex `source="vscode"`.

## Model lifecycle language

These terms define ADR-0032's implemented contract; its record is marked Implemented.

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
| Private model reference | Deployment, gateway, local tag, or observed-only identity without public-catalogue proof; owner-visible-v2 may show its bounded exact name/selector behind the authenticated local boundary, without claiming public identity |
| Keyed model projection | Stable pseudonyms for sensitive model evidence/scope/relations derived from the private key; distinct from owner-visible exact names and selectors |

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
| Discovered project | A directory named by the shared census; Intelligence eligibility additionally requires an on-disk learning marker (`.claude-flow`, `.agentic-qe`, or `.swarm`) |
| Project discovery | Bounded transcript-head/OpenCode-directory census acquisition; each consumer applies its named scope, and learning choices fold identities in most-recently-seen order |
| Selected project | The learning-scope project whose detail Intelligence shows; defaults to the first census most-recently-seen entry, never an implicit cwd default |
| Machine-wide rollup | The `{ totals, perProject }` aggregate (`readMachineWideIntel()`) folded across every discovered project; always shown regardless of which project is selected |
| Intelligence watcher pool | The per-discovered-project pool of `IntelligenceWatch` instances backing `GET /api/live/intelligence`; a project's watcher is created on its first SSE subscriber and torn down on its last disconnect |

Pattern-store size and the patterns-learned counter are never interchangeable displays of "how many
patterns exist" — the store can be pruned while the counter keeps climbing — at single-project
scope and at machine-wide-rollup scope alike. There is no unlabeled "this project" default in
Intelligence: the panel always shows an explicitly selected, explicitly labeled project alongside
the always-visible machine-wide rollup. See [Project intelligence](project-intelligence.md).

**Project census** — the one enumeration of this machine's projects, read from the session `cwd`
recorded in every Claude and Codex transcript plus the OpenCode session store. Every area derives
its session-derived candidates from it; Maintenance also has explicitly configured Discovery roots ([ADR-0027](../adr/0027-shared-project-census.md)).

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
| FootprintSnapshot | The schema-v7 persisted result of a deep scan: `asOf`, completeness, and the five deep-tier section models (install, storage, catalog, projects, consumers) |
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
| PhysicalArtifact | One measured filesystem or configuration entry, counted once regardless of how many hosts discover it |
| ConsumerBinding | One host's evidence-qualified discovery edge to a PhysicalArtifact, including surface, scope, project, enablement, and mechanism |
| Catalog occurrence | One observed capability placement: host, source scope, project, artifact path, producer/version/state, entrypoint/full-definition evidence, optional Git state, and evidence authority |
| Project capability pressure | Per-project/per-host inventory of project, user, and enabled-plugin contributions plus exact-name/entrypoint overlap; never a claim about host context inclusion |
| Entrypoint digest | SHA-256 of one bounded regular capability entrypoint; equality proves only those bytes, not supporting files, ownership, safety, or context loading |
| Definition digest | SHA-256 over one complete bounded observed capability definition; equality proves those files match, not host selection, ownership, usage, intent, or removal safety |
| Skill maintenance preview | The implemented `ak x skills plan` content-derived classification and projected change set; read-only evidence for a human decision, not a MaintenancePlan or authorization to mutate |
| ProjectFootprint | One eligible hosted repository's measured size/LOC and HTTPS remote facts; separate discoveryProjects preserve missing or unmeasured directories without fabricating measurements |
| Deep scan | The explicit, user-triggered, single-flight full measurement pass that produces a FootprintSnapshot |
| Scan-local observation | Ephemeral evidence acquired once during one explicit scan and reused only when path, timestamp, completeness, and reader contract satisfy the receiving collector; never a cross-scan cache |
| Cheap tier | The per-request census + known-file stats + snapshot carry-forward served on every read |

A measured zero is a real zero and renders as one; an unmeasured or failed figure renders as
unknown with its reason. Storage bytes and Usage tokens are different facts about the same
transcript and never substitute for each other. See [Machine footprint](machine-footprint.md).

## Maintenance language

The Focus browser is implemented; representative-user, assistive-technology and reference-platform
acceptance gates remain separate from its automated regression coverage.
**Focus browser** means one visible hierarchy level with breadcrumbs: scope → project choice (repository-grouped where proven) for
Projects → type → canonical family → exact installation. **Related installation** is an
evidence-backed navigation target that preserves the originating filters and labels outside-filter
context; it is not a recommendation or mutation capability. **Optional action** is an exact
management capability whose availability alone does not admit it to Guidance.

These terms describe [ADR-0044](../adr/0044-receipt-aware-maintenance-control-plane.md)'s
implemented transaction engine and [ADR-0048](../adr/0048-inventory-led-maintenance-resource-management.md)'s
implemented resource-management projection, guidance admission, discovery, and interruption-audit
contracts. `MaintenanceFinding` and `MaintenancePlan` (marked below) are engine-level terms the
transaction layer still uses internally; the user-facing product now speaks in `ResourcePlacement`
and `GuidanceEntry` instead.

| Term | Meaning |
|------|---------|
| Maintenance | The human-guided control-plane bounded context for evidence-backed lifecycle recommendations and provider-owned, verified, receipted actions; exposed beneath System without becoming part of Machine Footprint |
| MaintenanceFinding | *(engine-level)* An evidence-backed resource condition with source, freshness, completeness, ownership, impact, and missing evidence; never itself an action |
| CapabilityRelationship | Typed project/shared evidence classified as an identical project copy, different definition, tracked project copy, or equivalent legacy transport; a relationship does not confer mutation authority |
| SuggestedAction | A finding's recommendation, ordered procedure, expected effect, preservation boundary, and automation-blocking reason; human guidance until a provider authorizes an executable action |
| MaintenanceAction | One exact ActionProvider operation with target, projected result, safety class, rollback class, restart requirement, and verification contract |
| MaintenancePlan | *(engine-level)* An immutable, short-lived selection of MaintenanceActions bound to exact source state, scope, safety class, expiry, and content-derived digest; evidence identity, not authorization. Since ADR-0048, a plan holds exactly one action |
| ActionProvider | A resource-owner-specific lifecycle port that advertises only proven operations and implements detect, findings/actionFor, preflight, apply, verify, current-state inspection, and guarded undo where supported |
| ActionCapability | Ephemeral one-use authorization bound to a dashboard session, current plan digest, selected action IDs, source fingerprint, scope, safety class, and expiry |
| TransactionReceipt | Private durable evidence binding intent, policy decision, exact inputs, before-state, fixed operation, result, verification, after-state, rollback, and compensation |
| Source fingerprint | A digest over the complete bounded evidence set a plan depends on; a mismatch or incomplete reacquisition expires the plan |
| Maintenance scan report | Private persisted result of one explicit provider scan, including capture time, coverage, completeness, source fingerprint, and provider-evidence fingerprint |
| Safety class | One of `safe-automatic`, `approval-required`, `upstream-required`, or `never-automatic`; an executable class still requires explicit human confirmation |
| Rollback class | Reversible, compensating, or irreversible; independent of action safety and disclosed before confirmation |
| Recovery-required receipt | Durable evidence that provider dispatch may have occurred but the exact outcome was not proven; it blocks later mutations until reconciled |
| Receipt reconciliation | One individually confirmed write recording `record-no-change`, `record-completed`, or `record-restored` against exactly one receipt, after its interruption audit re-runs under the mutation lock; never a replay, retry, or blind compensation |
| Maintenance mutation lock | Private integrity-sealed serialization record; reclaimable only on the same machine and numeric UID when the recorded PID is provably dead and a second guarded check agrees |
| ManagedResource | ADR-0048's logical resource a person recognizes, grouping its placements without collapsing their scope, carrier, provenance, version, consumers, or actions |
| ResourcePlacement | ADR-0048's exact selectable and actionable row: one resource, one environment, one administrative scope, one location breadcrumb; the browser-facing action target (`placementId`) |
| PhysicalArtifact | One measured carrier — file, configuration selector, directory tree, package record, executable, runtime installation, cache object, model revision, or storage root — counted once regardless of how many hosts discover it |
| ConsumerBinding | One typed edge from a placement or artifact to a host, adapter, project, route, provider, model-runtime, or tool consumer, carrying discovery mechanism and enabled state |
| EvidenceAssertion | One field-local claim graded `verified`, `provider-declared`, or `inferred`, with a named authority, source reference, capture time, freshness, and completeness; there is no aggregate confidence score |
| EvidenceScorecard | The strongest grade recorded per evidence field for one subject; a field nobody observed is omitted, never defaulted to a weaker grade |
| SourceCoverage | One Discovery source's scan state, visited/estimated counts, completed/pending partitions, and factual limiting reason; never a resource disposition |
| Not installed (Discovery source) | A curated host source whose root does not exist on this machine (`present:false`, Discovery-only); never scanned, never counted in SourceCoverage, and not a failure |
| GuidanceEntry | One admitted, bounded outcome in exactly one of five lanes (Can apply here, Steps available, Decisions to make, Updates available, Recovery to finish), grounded by a provider capability, procedure, choice, candidate, or receipt audit |
| RecommendationDisposition | Acknowledged, Snoozed, or Ignored exact candidate, recorded against one exact Guidance identity; invalidated by a stated premise change (expiry, candidate change, installed-version change, dependency change, source-fingerprint drift, or security-severity increase), never permanent |
| InterruptionAudit | A read-only comparison of one receipt's recorded preimage or verified postimage with current provider evidence; may batch across receipts; never retries, replays, undoes, or mutates the resource |
| ScanCheckpoint | A bounded (≤ 256 KiB), integrity-sealed, resumable continuation record for one Discovery scan partition or work slice; never a per-file index |
| Work-slice budget | Bounds one scan's continuous run before yielding and checkpointing; pauses progress, and never abandons a valid scan |
| Safety ceiling | A hard scan limit (depth, entries, file size, memory, output, process time, or response size) that stops a scan and names which ceiling ended it, distinct from a work-slice pause |
| ProcedureRecipe | A signed, versioned, typed description of one guided operation for one exact OS/package-manager/shell/privilege/verification combination; renders as copyable text and is never executed by the procedure panel |
| Managed | A verified, previewable operation a registered ActionProvider can execute end to end through the transaction engine |
| Guided | A rendered, copyable procedure the user runs themselves; Agentic Kit never executes it |
| Inventory evidence only | A verified placement condition with no grounded remedy or bounded decision; stays visible in Inventory and never enters Guidance, a navigation badge, or the action-priority sort |
| Across scopes | The comparison query lens spanning System, Machine, User, and Projects; never a stored placement scope |

A plan identifier is not an ActionCapability, and an ActionCapability is not a
TransactionReceipt. A successful native command without a verified postcondition is not a
successful Maintenance transaction. A receipt records non-atomic effects; it does not make them
atomic. A GuidanceEntry is not a MaintenanceAction: it names what is grounded, while the transaction
engine still owns preflight, apply, verify, and receipt. See [Maintenance](maintenance.md).

## Component directory language

| Term | Meaning |
|------|---------|
| Component directory | The curated catalog of everything ak installs or configures, with editorial identity per entry |
| DirectoryEntry | One component's editorial identity: category, tagline, paragraph, links, icon, and a detection join key |
| Editorial content | Authored, versioned prose and links — the part of a card that is true regardless of machine state |
| Detection fact | An observed install/version/configured fact borrowed read-only from existing collectors, rendered only as chips |
| State chip | The card element that renders detection facts (`installed v…` / `not installed — ak setup adds it` / `configured` / `unknown`); host cards use the host management words (`Managed by ak` / `Found, not managed` / `Not installed`) |
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
  reference** when public identity is absent or ambiguous; owner-visible exact display does not
  establish public identity, while sensitive relations/scope still require keyed projection.
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
