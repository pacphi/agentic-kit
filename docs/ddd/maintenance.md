# Maintenance domain

Maintenance is the resource-management control plane defined by
[ADR-0044](../adr/0044-receipt-aware-maintenance-control-plane.md) and
[ADR-0048](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0048-inventory-led-maintenance-resource-management.md). ADR-0048 is Accepted and
implemented; it is not yet marked Implemented in its own record because the human-evaluation and
cross-platform acceptance gates its migration plan requires have not run (see that ADR's
"Implementation status"). ADR-0044's transaction engine remains the runtime safety floor underneath
both records.

Its promise is:

> Show me the verified agent-related resources on this environment, where each exact placement came
> from when that can be established, what consumes it, what has changed, and only the actions or
> decisions that Agentic Kit can ground.

It is not a generic cleaner, installer, vulnerability scanner, package manager, or root
administration console. It does not infer deletion authority from a name, age, cache location,
digest match, or missing usage observation.

## Boundary

**System measures; Maintenance manages; Maintenance's transaction engine acts.**

[Machine Footprint](https://github.com/pacphi/agentic-kit/blob/main/docs/ddd/machine-footprint.md) owns the read-only inventory, project pressure, source
relationships, freshness, and advisory candidates. Maintenance's management projection consumes
those facts without turning an observation into ownership. Catalog is no longer a separate
dashboard destination: `#system/catalog` redirects into Maintenance's Inventory route, which
presents Catalog v4 evidence at placement grain alongside installs, models, and provider
configuration. Catalog, Advisory, and the Footprint collectors still do not mutate the machine.

[Integration Management](https://github.com/pacphi/agentic-kit/blob/main/docs/ddd/integration-management.md) owns host lifecycle capability, desired state,
and agentic-kit ownership receipts. Maintenance asks which exact provider operation exists; it does
not manufacture a missing lifecycle verb. [Model Lifecycle Intelligence](model-lifecycle-intelligence.md)
keeps owning model facts, sources, and lifecycle diffs — Maintenance consumes the exact placement,
consumer, and storage evidence and adds exactly one Managed removal operation.
[Hook configuration assurance](https://github.com/pacphi/agentic-kit/blob/main/docs/ddd/hook-configuration-assurance.md) keeps owning hook occurrences and
behavior identity — Maintenance joins its sanitized read model into `hook`-kind placements without
gaining healing authority.

Dashboard Delivery owns the authenticated loopback boundary and accessible interactions.
Maintenance owns the application service used by both the CLI and **System > Maintenance**.
Placement under System is navigation, not domain ownership.

## Aggregates

### ManagementInventory

`ManagementInventory` (schema `maintenance-management-inventory/v2`, `src/lib/maintenance/
management/model.mjs`) is an immutable, privacy-projected snapshot: `environments`,
`sourceCoverage`, `resources`, `placements`, `artifacts`, `consumerBindings`,
`provenanceAssertions`, `versionObservations`, `dependencyEdges`, `conflictSets`, and
`guidanceEntries`, each keyed by an opaque, installation-scoped id (`opaqueId()`, an HMAC-SHA256
over a bounded identity tuple — never a raw path or reversible encoding). `assertManagementInventory`
structurally validates every collection, including that no field anywhere in the inventory carries
a local path. It is rebuildable evidence, not canonical configuration, and never grants mutation
authority; its `inventoryId` binds paging so one result set cannot mix snapshot generations.
`buildManagementInventory` (`management/projection.mjs`) builds it from Catalog v4, the footprint
install/storage/runtime sections, the model-inventory snapshot, the hook read model, provider
detections, and Discovery's own project/coverage facts — it never touches the filesystem itself.

### DiscoveryConfiguration

User intent for automatic sources, exact projects, bounded collection roots, and exact/recursive
exclusions, held in `kit.json`'s `maintenance.discovery` key (`src/lib/config.mjs`,
`src/lib/maintenance/discovery/configuration.mjs`). A separate owner-private store
(`management/preferences.mjs`) retains view/shell/retention preferences, and another
(`discovery/checkpoint.mjs`, `discovery/coverage.mjs`, `discovery/history.mjs`) retains scan
checkpoints, last-good coverage snapshots, and bounded scan history. No import/export surface
exists for discovery configuration in v1.

### MaintenanceTransaction

ADR-0044's implemented plan/apply/verify/receipt/undo contract, narrowed to exactly one write
action per plan across the planner, coordinator, service, dashboard API, and CLI
(`src/lib/maintenance/{planner,coordinator,service}.mjs`, error code `ONE_ACTION_PER_PLAN`, refused
before any provider call, lock, or journal write). See "Transaction rules" below for the parts of
ADR-0044's contract that are unchanged.

### RecommendationDispositionLedger

An owner-private, integrity-sealed, append-only ledger (`management/dispositions.mjs`) recording
`acknowledged`, `snoozed`, or `ignored-exact-candidate` against an exact Guidance identity. It never
removes a resource from Inventory; it only suppresses a matching Guidance entry until an
invalidation premise changes (expiry, candidate change, installed-version change, dependency
change, source-fingerprint drift, or security-severity increase — `DISPOSITION_INVALIDATIONS`).

### InterruptionAudit

A read-only comparison of one transaction receipt's recorded preimage or verified postimage against
current provider evidence (`src/lib/maintenance/interruption-audit.mjs`). Read acquisition may
batch across receipts; conclusions stay receipt-scoped and ephemeral until a separate, individually
confirmed reconciliation write records one outcome.

## Identity model

Every identity in the management projection is opaque and installation-keyed
(`management/identity.mjs`'s `idFactory` and per-kind constructors over `model.mjs`'s `opaqueId`).
Equal display names never establish equal identity: kind, host namespace, producer, source
selector, project, and a bounded, independently verified definition digest participate only where
verified.

- **EnvironmentIdentity** (`management/environments.mjs`) — one macOS, Linux, Windows, or WSL
  environment. Each WSL distribution is a separate Linux environment with an explicit
  `parentEnvironmentId` edge to its Windows host; nothing crosses that edge automatically.
- **ManagedResource** — the logical thing a person recognizes, in one of the v1 kinds: `skill`,
  `mcp-registration`, `plugin`, `hook`, `instruction-context-file`, `agent`, `command-prompt`,
  `host-adapter`, `executable`, `runtime`, `model`, `provider-configuration`, `cache`,
  `credential-readiness`, or `related-storage`.
- **ResourcePlacement** — the exact selectable and actionable row: `placementId`, `resourceId`,
  `environmentId`, `administrativeScope` (`system`, `machine`, `user`, or `project` — `across` is a
  query lens and is never stored), location breadcrumb, artifact and consumer-binding ids,
  conditions, and evidence scorecard. `exactLocatorRef` is owner-private and structurally rejected
  from ever entering the inventory (`assertPlacement`).
- **PhysicalArtifact** — a measured carrier: `file`, `config-selector`, `directory-tree`,
  `package-record`, `executable`, `runtime-installation`, `cache-object`, `model-revision`, or
  `storage-root`. One physical artifact used by several hosts appears once with several bindings.
- **ConsumerBinding** — a typed edge from a placement or artifact to a `host`, `adapter`, `project`,
  `route`, `provider`, `model-runtime`, or `tool` consumer, carrying discovery mechanism and
  enabled state.

### Repository and session-origin presentation

`management/projection-projects.mjs` enriches existing opaque project identities after registry
and fallback identities are assigned. Verified common Git directory/backlink evidence can relate
worktree choices to a repository without changing placement IDs or action targets. Equal names or
remotes do not establish that relationship. Public fields retain only the keyed repository ID,
bounded label, evidence class and observation time; raw roots and common-directory paths remain
private. Discovery's existing repository-key relationships retain their own provenance.

Session origin is an independent overlapping project facet. Exact Claude/Codex Desktop declarations
supply memberships; all other observations remain unclassified. Selecting either or both Desktop
origins filters distinct placements in matching projects once. Focus node counts remain installation
counts, and session-origin counts are copied once per project rather than summed per installed
resource. Encoded-directory recovery is labelled a recovered-project sighting, not a verified
session. Native language icons wrap inline without dropping additional detected languages.

## Evidence and version policy

Every primary claim is a field-local `EvidenceAssertion` (`management/evidence.mjs`) graded
`verified`, `provider-declared`, or `inferred` — there is no aggregate numeric confidence. Only
`verified` evidence supplies a primary label or an action premise; `provider-declared` renders with
its named authority; `inferred` is confined to technical details; a field with no assertion is
omitted rather than defaulted. `scorecardFor` reports the strongest grade recorded per evidence
field (identity, placement, provenance, installed/effective version, consumers, dependencies,
candidate source, compatibility, recommendation authority, impact, remedy) — never a field nobody
observed.

Version axes stay independent (`VERSION_AXES`: installed, effective, candidate, compatible
candidate, recommended candidate, producer, source revision, cache generation, content digest, pin,
channel). The compatibility-based Updates-available path requires verified installed version and verified
compatibility plus a source-bound candidate (`guidance.mjs`'s `computeUpdateEntries`). A separate
host-reported candidate path requires verified candidate-source evidence and explicitly states
that compatibility has not been verified; `Recommended`
additionally requires a verified `recommendationAuthority`. Stable channels are default; prerelease
and nightly candidates require existing enrollment or explicit enablement (`channelAllowed`).

Resource names and Guidance outcomes reject `Unknown`, `Unsupported`, `Needs attention`,
generic `Review` or `Fix`, `Repair all`, and `Clean all` (`model.mjs`'s `PROHIBITED_LABELS`).
Evidence-specific missing-association and unclassified-origin explanations are separate from
resource disposition labels; they do not create an action or a failure state.

## Dependencies and conflicts

`DependencyEdge` kinds (`management/dependencies.mjs`) include `requires-executable`,
`requires-runtime`, `requires-provider`, `requires-credential`, `loads`, `configures`, `projects`,
`consumes`, `stores-in`, `resolves-through`, `windows-hosts-wsl`, and `submodule-of`. Traversal
(`traverseDependencies`, `dependencyGraphList`) is cycle-safe by a bounded visited-node count; a
cycle is rendered, never expanded into a recursive action.

`ConflictSet` classification (`management/conflicts.mjs`, `classifyConflicts`) covers
`duplicate-placement`, `shadowed-override`, `same-name-different-definition`,
`equivalent-transport-registration`, `version-requirement-divergence`,
`dependency-resolution-collision`, and `shared-artifact`. Every classification carries what the
evidence `proves` and what it `doesNotProve` (`CONFLICT_EXPLANATIONS`); none grants ownership or
deletion authority. A shared artifact used by several hosts is explicitly classified apart from a
duplicate.

## Guidance admission

`admitGuidance` (`management/guidance.mjs`) is the only place a verified condition becomes a
`GuidanceEntry`, in exactly one of five lanes:

| Lane | Label | Grounding required |
|------|-------|---------------------|
| `apply` | Can apply here | A `providerCapabilityId` from a registered provider, and the placement is not under an active mutation block |
| `steps` | Steps available | A `procedureId` for a signed, compatible recipe |
| `decision` | Decisions to make | At least one bounded `choices[]` entry, each independently grounded or carrying a reason |
| `update` | Updates available | A verified host-reported candidate with an explicit compatibility limitation, or verified installed version/compatibility with a source-bound `candidateId`; `Recommended` additionally requires a verified recommendation authority |
| `recovery` | Recovery to finish | A `receiptId` for an unresolved transaction |

A verified condition with no grounded operation, procedure, decision, or candidate is never
admitted. Its placement stays visible in Inventory with `guidanceLane: null`, and its inspector's
`whatCanIAccomplish` answer is `NO_ACTION_REQUESTED_DETAIL`: "No action is requested. Agentic Kit
does not have a verified operation, procedure, or bounded decision to offer for this condition in
the current environment." It never contributes a navigation badge or an action-priority sort
position (`INVENTORY_GROUP_ORDER` places `evidence-only` and `healthy` after the five Guidance
lanes as sort groups, not a severity ladder).

The resource inspector (`inspectorFor`) answers nine questions for one placement, never including a
local path: `whatIsThis`, `whereIsIt`, `whereDidItComeFrom`, `whatVersionIsHere`, `whoUsesIt`,
`whatChangedOrConflicts`, `whatCanIAccomplish`, `whatProvesThis`, and `whatHappenedBefore`.

## Dispositions

`Acknowledged` records that a person saw a condition without hiding the resource. `Snoozed` removes
one Guidance entry until a stated expiry. `IgnoredExactCandidate` suppresses only the same candidate
identity. Every disposition is explained before confirmation and remains visible in Activity.
Invalidation (a rescan may resurface a snoozed item) fires on expiry, candidate change,
installed-version change, dependency change, source-fingerprint drift, or security-severity
increase — never silently.

## Discovery: sources, scans, and checkpoints

Curated automatic sources (`claude-user`, `codex-user`, `opencode-user`, `hermes-user`, `projects`,
`runtimes`, `package-managers`, `ollama`, `providers`) work without configuration. Users may add an
`exact-project` or a bounded `collection-root` source and toggle automatic sources; `previewSource`
(`discovery/preview.mjs`) reports projects found, applied exclusions, depth, symlinks, and estimated
work before `saveSource` commits anything. Network shares, removable media, cloud placeholders, and
host/WSL boundary crossing are excluded by default (`BOUNDARY_KINDS`).

A scan (`discovery/orchestrator.mjs`) progresses through `SCAN_STATES` (`configured`, `queued`,
`scanning`, `checkpointed`, `paused`, `complete`, `published`, `stopped`, `failed`) along the
transitions `SCAN_TRANSITIONS` declares; reaching a work-slice boundary yields `checkpointed`, never
a terminal state, and resumes from a bounded, integrity-sealed `ScanCheckpoint`
(`discovery/checkpoint.mjs`, schema `maintenance-scan-checkpoint/v1`, capped at 256 KiB — partition
ids and cursors only, never a per-file index). A hard `SAFETY_CEILING` (depth, entries, file size,
memory, output, process time, or response size) stops a scan and names the ceiling
(`LIMITING_REASONS` includes `safety-ceiling` alongside `work-slice`, `paused-by-user`,
`stopped-by-user`, `permission-denied`, `source-changed`, and `io-failure`). Source drift
invalidates only the smallest proven partition and retries within a bounded policy before reporting
`source-changed`.

The last complete `SourceCoverage` snapshot (`discovery/coverage.mjs`) remains authoritative while a
new run is scanning, paused, stopped, or failed; a partial source can never support the claims
`INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS` names (absence, complete totals, uniqueness, complete
conflicts, complete reverse dependencies, reclaimable totals, or a completeness-dependent action —
enforced by `sourceComplete`, applied to every affected placement as the `source-scan-incomplete`
condition). Retention defaults to 10 summaries per source per environment and 90 days, with a 7-day checkpoint
floor (`SCAN_HISTORY_RETENTION`); `discovery/history.mjs`'s `clearHistory` cannot remove an
unresolved, verification-required, or otherwise protected summary.

Discovery is orchestration over ADR-0047's streaming observation forest
(`src/lib/footprint/observation-forest.mjs`'s `observeWalkForest`), partitioned into bounded,
resumable units (`discovery/partitions.mjs`) — not a competing walker or a persisted per-file index.

## Interruption audit and reconciliation

An interrupted transaction offers **Audit interruption**, not a generic Verify again
(`src/lib/maintenance/interruption-audit.mjs`). The audit discloses the receipt, last durable
phase, exact provider and version, checks, and network/probe policy, then compares current provider
evidence only against the recorded preimage or verified postimage. It never acquires the mutation
lock, writes a receipt, or calls a provider's apply/undo/verify. Read-only audits may batch across
receipts (`auditInterruptions`) and remain ephemeral.

A conclusive result is `no-action-started`, `matches-recorded-before-state`,
`matches-verified-after-state`, `differs-from-both-recorded-states`,
`matching-inspection-provider-not-present`, `receipt-integrity-check-failed`, or
`affected-catalog-refresh-did-not-complete` (`AUDIT_RESULTS`). Recording one is a separate,
individually confirmed write — `record-no-change`, `record-completed`, or `record-restored`
(`RECONCILE_OUTCOMES`) — through `recovery-coordinator.mjs`'s `reconcileMaintenanceReceipt`, which
re-runs the audit under the mutation lock before sealing the outcome. `recoverMaintenanceReceipt`
remains as a compatibility wrapper over the same module.

An unresolved receipt's mutation block (`coordinator.mjs`'s `mutationBlocks`, scoped by
`correlation.mjs`'s `mutationBlocksForGuidance`) covers its own placement, environment, and verified
dependents, not unrelated environments. Receipt-integrity failure remains a broader fail-closed
block, unchanged from ADR-0044.

## Policy

| Safety class | Meaning |
|--------------|---------|
| <code>safe-automatic</code> | Exact authority and verification support an executable proposal; human confirmation remains required |
| <code>approval-required</code> | An exact action exists, but impact or preservation risk needs judgment |
| <code>upstream-required</code> | No safe local operation exists; explain the upstream workflow and offer no apply control |
| <code>never-automatic</code> | Authority or recovery is structurally insufficient; preserve the resource |

A transaction cannot mix safety classes. Eligibility never permits background execution.

Rollback is independent:

- <code>reversible</code> restores a recorded preimage and verifies it;
- <code>compensating</code> performs a new provider operation toward the prior state; and
- <code>irreversible</code> has no safe automated recovery.

External lifecycle calls are not described as atomic. The UI states rollback and restart behavior
before confirmation.

## Provider boundaries

| Family | Executable behavior | Preserved/report-only behavior |
|--------|---------------------|--------------------------------|
| Claude plugins | Disable with native enable as undo; update; remove while keeping plugin data | Update needs one exact host-reported candidate. Prune has no exact target set. Update/remove are irreversible. Restart is required. |
| Codex plugins | Remove an exact removal finding | Per-plugin update/disable and ambiguous candidates remain report-only. Restart is required. |
| Codex MCP | Remove an exact user-scope registration | Project-scope findings remain report-only. No Claude or OpenCode MCP remover is registered. Registration never proves health or authorization. |
| Claude MCP | None | No provider is registered; findings remain report-only. |
| OpenCode plugins/MCP | None | Explicit unsupported providers explain the missing safe native adapter. |
| Owned skills | A conditionally composed adapter supports archive/prune; its projected finding offers archive only | The stock CLI/dashboard has no production receipt/root resolver and therefore does not register this adapter. When explicitly composed, modified, partial, symlinked, special-file, ambiguous, unreadable, unreceipted, user-owned, and plugin-cache trees are preserved. |
| Owned npx storage | Clean one exact stale environment named by the Footprint collector and bounded owned procedure | Historical transcripts, idle-only guesses, third-party caches, and incomplete candidates are not executable. |
| Ruflo MCP orphan | Terminate a same-user, PPID-1, exact transport after a live identity recheck | No generic process kill. Unknown UID and Windows remain report-only. |
| Git project patch | Apply one exact, previewed file replacement inside a configured project root (`src/lib/maintenance/providers/git-project-patch.mjs`) | Unrelated dirty files are permitted; affected-path, index, worktree, submodule, or symlink drift refuses. Never stashes, commits, branches, pushes, or merges. Reversible through a guarded restore. |
| Ollama model removal | Remove one provider-owned local model per action over bounded loopback reads and the native `ollama rm` verb (`src/lib/maintenance/providers/ollama-model-remove.mjs`) | Active download, generation, or unsafe loaded use refuses removal. No elevation. Irreversible; redownload disclosed. Model download, pull, update, migration, and channel change remain Guided. |

The default registry always installs Claude plugin, Codex plugin, Codex MCP, and Ruflo orphan
providers. It conditionally adds owned npx storage, owned skills, the Git project-patch provider
(when a project root is supplied). The Ollama model-removal provider is registered by default
unless explicitly disabled; its detection and action preconditions, including loopback reachability,
decide whether a removal can be offered. Registration itself proves none of those preconditions.

## Transaction rules

Before any effect, the coordinator validates the unexpired plan and digest, resolves live provider
implementations, replans, checks current source state, and completes all preflights. It refuses
client commands/paths, traversal, globs, symlink escape, special files, targets outside exact
roots, and — since ADR-0048 — more than one finding or action per plan
(`ONE_ACTION_PER_PLAN`, refused before any provider call, lock, or journal write).

Mutation is serial. The private integrity-sealed lock records machine, numeric UID, PID, creation
time, and nonce. A stale lock is reclaimed only on the same machine and current numeric UID when
its recorded PID is provably absent and a second check under an exclusive reclaim marker agrees.

Providers use fixed operations, verify their postconditions, and then refresh the full deep
System/Footprint snapshot. Failure stops dependent and not-yet-started work. Compensation runs in
reverse order only when declared. Undo requires a committed receipt, the same provider/version, a
rollback-capable action, an exact current postimage, and verified restoration.

## Surfaces

The Maintenance panel renders four destinations:

1. **Inventory** — implemented Focus browser (2026-09-08; focused verification passed): four
   Across scopes roots, then scope → repository (Projects only) → type → family → exact
   installation. Breadcrumbs and multiselect filters skip already chosen levels. Details below
   the current list expose evidence-backed relationships; related selections preserve filters
   and label outside-filter context. Include worktrees controls project-choice visibility, with
   no Project type control. The underlying `runInventoryQuery` remains an opaque-cursor, indexed
   query over exact placements; presentation does not grant action authority.
2. **Guidance** — the five admitted lanes, rendered procedures, and the Audit interruption dialog.
3. **Discovery** — automatic sources, exact projects, collection roots, exclusions, scan progress,
   and history.
4. **Activity** — interruption audits, receipts and undo, dispositions, recipe changes, and scan
   history.

Catalog is no longer a separate destination; `#system/catalog` redirects into Inventory.

The approved Focus relationship contract separates plugin inclusion, installer receipts, consumer
bindings, dependencies, host-specific configuration precedence, and canonical family identity.
None can be inferred from display-name equality or physical containment alone. Optional management
capabilities stay in exact installation details, separate from Guidance admission. Source-bound
integration and human/cross-platform evidence remain required before completion claims.

The dashboard's v2 HTTP allowlist (`src/lib/dashboard/maintenance-security.mjs`'s
`MAINTENANCE_V2_ROUTES`) is exact:

    GET  /api/maintenance/v2/inventory
    GET  /api/maintenance/v2/placements/{placementId}
    POST /api/maintenance/v2/placements/reveal
    GET  /api/maintenance/v2/guidance
    GET  /api/maintenance/v2/procedures/{guidanceId}
    POST /api/maintenance/v2/procedures/checklist
    GET  /api/maintenance/v2/discovery
    POST /api/maintenance/v2/discovery/preview
    POST /api/maintenance/v2/discovery/sources
    POST /api/maintenance/v2/discovery/sources/remove
    POST /api/maintenance/v2/discovery/automatic
    POST /api/maintenance/v2/discovery/exclusions
    POST /api/maintenance/v2/discovery/exclusions/remove
    GET  /api/maintenance/v2/scans
    POST /api/maintenance/v2/scans
    GET  /api/maintenance/v2/activity
    GET  /api/maintenance/v2/receipts/{receiptId}
    POST /api/maintenance/v2/receipts/export
    POST /api/maintenance/v2/dispositions
    POST /api/maintenance/v2/audit
    POST /api/maintenance/v2/reconcile/preview
    POST /api/maintenance/v2/reconcile
    POST /api/maintenance/v2/plans
    POST /api/maintenance/v2/apply
    POST /api/maintenance/v2/undo
    POST /api/maintenance/v2/recipes/refresh
    POST /api/maintenance/v2/recipes/accept
    POST /api/maintenance/v2/recipes/withdraw
    GET  /api/maintenance/v2/preferences
    POST /api/maintenance/v2/preferences

Every route keeps ADR-0014's loopback/session/origin/schema/64 KiB-body protections; POST routes
also require the same-origin header token, and apply/reconcile capabilities are verb-bound and
one-use. ADR-0044's v1 routes (`GET /api/maintenance`, `POST /api/maintenance/{plans,apply,undo}`)
remain as a documented compatibility surface.

The CLI (`src/commands/maintain.mjs`) exposes:

    ak maintain scan [--deep] [--refresh-inventory] [--json]
    ak maintain inventory [--scope S] [--view V] [--facet name=value ...]
    ak maintain show --placement ID [--reveal] [--json]
    ak maintain guidance [--lane LANE] [--json]
    ak maintain procedure --guidance ID [--shell SHELL] [--json]
    ak maintain discovery [--json]
    ak maintain sources add|remove|enable|disable|exclude|unexclude [options]
    ak maintain scans [start|pause|resume|stop] [options]
    ak maintain activity [--json]
    ak maintain receipt --receipt ID [--export [--include-local-paths --acknowledge-warning]] [--json]
    ak maintain audit --receipts ID,... [--json]
    ak maintain reconcile --receipt ID --outcome OUTCOME --yes [--json]
    ak maintain disposition --guidance ID --kind KIND [--until ISO] --yes [--json]
    ak maintain plan [--findings ID,...] [--safety-class CLASS] [--project PATH] [--executable] [--json]
    ak maintain plan --placement ID [--guidance ID] --executable [--json]
    ak maintain apply --plan ID --digest SHA256 --actions ID --yes [--json]
    ak maintain undo --receipt ID --yes [--json]
    ak maintain recover --receipt ID [--json]
    ak maintain recipes list|refresh|accept|withdraw [options]
    ak maintain preferences [--set key=value ...] [--json]

`--reveal` and `discovery` are the only human-output paths that may show an exact local path, and
only for the owner running the CLI. `--actions` accepts exactly one id; more than one exits with
`ONE_ACTION_PER_PLAN`. Human output never prints a prohibited label.

## Invariants and non-claims

The fourteen invariants below describe the implemented management contract and its enforcement
points. The broader acceptance gates remain tracked separately in
[Maintenance acceptance](https://github.com/pacphi/agentic-kit/blob/main/docs/MAINTENANCE-ACCEPTANCE.md):

1. Every actionable row identifies one exact placement — `planner.mjs`/`coordinator.mjs`'s
   `ONE_ACTION_PER_PLAN` refusal before any provider call, lock, or journal write.
2. A logical resource, placement, artifact, and consumer binding never collapse into one identity —
   `management/identity.mjs`'s distinct `resourceIdentity`/`placementIdentity`/`artifactIdentity`/
   `bindingIdentity` material tuples, checked structurally by `model.mjs`'s
   `assertManagementInventory`.
3. Administrative scope, provenance, producer, consumer, and blast radius remain orthogonal —
   `management/projection.mjs` keeps `provenanceAssertions`, `consumerBindings`, and
   `dependencyEdges` as separate collections rather than folding them into the placement row.
4. Missing evidence omits a claim; it never creates a user-facing Unknown resource state —
   `management/evidence.mjs`'s `scorecardFor` omits an unobserved field, and `model.mjs`'s
   `isProhibitedLabel`/`assertLabelAllowed` reject `Unknown`/`Unsupported` as labels.
5. Inferred evidence never supplies a primary label or an action premise —
   `management/guidance.mjs`'s per-lane `LANE_GROUNDING` requires named, verified fields, and
   `evidence.mjs`'s `assertion` rejects an ungraded claim.
6. Conflict classification never grants ownership or deletion authority —
   `management/conflicts.mjs`'s `classifyConflicts` attaches `proves`/`doesNotProve` from
   `CONFLICT_EXPLANATIONS` to every classification.
7. A candidate is not compatible or recommended without separate evidence —
   `guidance.mjs`'s `computeUpdateEntries` requires verified `installedVersion` and `compatibility`
   before considering a compatible candidate, and verified `recommendationAuthority` before
   `Recommended`. The separate host-reported update path explicitly discloses unverified
   compatibility and does not turn availability into an executable update.
8. No write action spans more than one exact provider operation and placement — the same
   `ONE_ACTION_PER_PLAN` contract as (1), also enforced at the dashboard API and CLI boundaries.
9. Read batching never merges evidence, receipts, scopes, or conclusions —
   `interruption-audit.mjs`'s `auditInterruptions` returns one receipt-scoped result per receipt in
   a batched read.
10. Partial scans never support negative or complete-population claims — `model.mjs`'s
    `INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS` and `sourceComplete`, applied by `projection.mjs` as the
    `source-scan-incomplete` condition.
11. A work-slice limit pauses progress; it does not abandon a valid scan — `discovery/
    orchestrator.mjs`'s `scanning` → `checkpointed` → `scanning` transition in `SCAN_TRANSITIONS`.
12. An interruption audit never retries, replays, undoes, compensates, or mutates the resource —
    `interruption-audit.mjs` never acquires the mutation lock or calls a provider's apply/undo.
13. Credential values and private configuration never enter the management projection —
    `model.mjs`'s `CREDENTIAL_MECHANISMS` names a mechanism only, and `projection.mjs`'s
    `mapProviders` reads only presence/reachability facts, never a credential value.
14. External adapters cannot self-authorize visibility, recommendation, or mutation capabilities —
    holds by construction as shipped: the `host-adapter` resource kind is populated only from
    Machine Footprint's install detection of the built-in host CLIs, and no fact from ADR-0029's
    admission manifest reaches the projection yet (see ADR-0029's 2026-09-05 update).

Non-claims, extending ADR-0044's:

- Installed does not mean enabled, effective, or loaded into model context.
- Registration does not mean configured, reachable, healthy, authenticated, or authorized.
- A source timestamp or unchanged cheap probe does not prove nested content unchanged.
- Equal full-definition digests prove only equality of the bounded observed files; they do not
  prove host selection, ownership, usage, intent, or safe deletion.
- Age or absence from observed usage does not prove stale, orphaned, or unused.
- A verified condition with no grounded remedy is calm Inventory evidence, not a problem to solve.
- A candidate is not a recommendation, and a recommendation is not a Managed update authorization.
- A partial scan's found resources are individually verified but never a complete population,
  absence proof, or total.
- An interruption audit's result is evidence for a human decision, not a completed reconciliation.
- Catalog and Advisory remain read-only even though Maintenance shares the System shell and now
  presents Catalog's evidence at placement grain.
- Unsupported host operations remain visible limitations, never fabricated buttons.
- A receipt records and reconciles non-atomic provider effects; it does not make them atomic.
