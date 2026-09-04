# Maintenance resource-management domain model

- **Design status:** Proposed
- **Governing decision:** [ADR-0048](../../adr/0048-inventory-led-maintenance-resource-management.md)

This model separates what exists from what may be changed. It replaces the current finding as the
primary UI object with a verified management projection while retaining the implemented transaction
engine as the only write boundary.

## Context boundaries

```text
Configuration Intent -----------+
Project Census -----------------+
Machine Footprint --------------+--> Resource Management Projection
Model Lifecycle Intelligence ---+             |
Hook Assurance -----------------+             +--> InventoryQuery
Integration Management ---------+             +--> GuidanceQuery
Provider probes ----------------+             +--> DiscoveryQuery
                                                +--> ActivityQuery
                                                         |
                              verified provider authority |
                                                         v
                                               Maintenance Transaction
                                        preflight -> apply -> verify
                                                   -> receipt
                                                         |
                                                         v
                                          Interruption Audit/Reconciliation
```

- **Machine Footprint** owns filesystem, process, storage, catalog, and project measurements.
- **Project Census** owns candidate project identities and observed paths, not scan inclusion.
- **Integration Management** owns desired host/provider state, lifecycle capabilities, and
  ownership receipts.
- **Model Lifecycle Intelligence** owns model identities, sources, bindings, and lifecycle facts.
- **Hook Assurance** owns hook-specific occurrences, behavior identity, and static diagnostics.
- **Maintenance Resource Management** owns normalized placement identity, the management query
  projection, Guidance admission, dispositions, action planning, transactions, and receipts.
- **Dashboard Delivery** owns protected transport and interaction, never evidence strength or
  mutation policy.

## Aggregates

### ManagementInventory

`ManagementInventory` is an immutable, privacy-projected snapshot over verified resources:

```text
ManagementInventory
  schemaVersion
  inventoryId
  capturedAt
  environments[]
  sourceCoverage[]
  resources[]
  placements[]
  artifacts[]
  consumerBindings[]
  provenanceAssertions[]
  versionObservations[]
  dependencyEdges[]
  conflictSets[]
  guidanceEntries[]
```

It is rebuildable evidence, not canonical configuration. It never grants mutation authority. Its
opaque `inventoryId` binds paging and filters so one result set cannot mix snapshot generations.

### DiscoveryConfiguration

`DiscoveryConfiguration` is user intent for automatic sources, exact projects, bounded collection
roots, exact exclusions, and recursive exclusions. It lives in user configuration for v1. A
separate owner-private store retains scan checkpoints, display preferences, last view, retention,
and preferred shells.

### MaintenanceTransaction

`MaintenanceTransaction` retains the implemented short-lived plan, one-use action capability,
provider operation, verification, receipt, guarded undo, and fail-closed recovery contracts. ADR-0048
narrows it to one write action per transaction across both CLI and UI.

### RecommendationDispositionLedger

The ledger records `Acknowledged`, `Snoozed`, or `IgnoredExactCandidate` against an exact guidance
identity and its invalidation inputs. It does not remove the resource from Inventory.

### InterruptionAudit

An `InterruptionAudit` is a read-only comparison of one transaction receipt's journal evidence and
current provider evidence. Read acquisition may batch across receipts, but conclusions stay
receipt-scoped and ephemeral until separately reconciled.

## Identity model

### EnvironmentIdentity

```text
EnvironmentIdentity
  environmentId       opaque, installation-keyed
  kind                macos | linux | windows | wsl
  osFamily
  osVersionFamily?
  architecture?
  parentEnvironmentId?  Windows host for WSL only
  displayLabel
```

Each WSL distribution is a separate Linux environment. Its Windows relationship is an explicit
edge; neither paths nor commands cross that edge automatically.

### ManagedResource

The logical resource that a person recognizes:

```text
ManagedResource
  resourceId          opaque and stable within the installation
  kind
  displayName
  namespace?
  publisher?
  placements[]
```

Kinds in v1 are `skill`, `mcp-registration`, `plugin`, `hook`, `instruction-context-file`, `agent`,
`command-prompt`, `host-adapter`, `executable`, `runtime`, `model`, `provider-configuration`,
`cache`, `credential-readiness`, and `related-storage`.

Equal display names do not establish equal logical identity. Host namespace, producer identity,
source selector, bounded definition digest, and provider-specific identity participate only where
verified.

### ResourcePlacement

The exact selectable and actionable row:

```text
ResourcePlacement
  placementId         opaque; accepted by browser actions
  resourceId
  environmentId
  administrativeScope system | machine | user | project
  projectId?
  locationBreadcrumb
  exactLocatorRef      owner-private; never in filter URLs
  artifactIds[]
  consumerBindingIds[]
  condition
  evidenceScorecard
```

`Across scopes` is a query lens and never a stored scope. A project placement includes an exact
repository/worktree identity. A shared artifact may back more than one placement only when selectors
inside the carrier are independently addressable.

### PhysicalArtifact

A measured carrier such as a regular file, selector inside a configuration file, directory tree,
package-manager record, executable, runtime installation, cache lifecycle object, model revision,
or storage root. Artifact identity never proves ownership or safe deletion.

### ConsumerBinding

A typed edge from a placement or artifact to a host, adapter, project, route, provider, model
runtime, or tool. It records discovery mechanism, enabled state, effective scope, evidence, and
whether the consumer is affected by a proposed action.

One physical skill consumed by Claude and Codex is one artifact with two bindings—not two copies.

## Evidence model

### EvidenceAssertion

Every primary claim is field-local:

```text
EvidenceAssertion<T>
  subjectId
  field
  value
  grade              verified | provider-declared | inferred
  authority
  sourceRef
  capturedAt
  freshness
  completeness
  scope
```

- **Verified** may support primary labels and the exact premises of an action.
- **Provider-declared** is displayed with its named source and never silently upgraded.
- **Inferred** is confined to technical details.
- When no useful assertion exists, the field is omitted.

There is no aggregate numeric confidence that can launder a weak field through stronger unrelated
evidence.

### EvidenceScorecard

The scorecard reports the evidence available for identity, placement, provenance, installed
version, effective version, consumers, dependencies, candidate source, compatibility,
recommendation authority, impact, and remedy. Filters may ask for verified fields; actions state
which fields they require.

### SourceCoverage

```text
SourceCoverage
  sourceId
  environmentId
  state              complete | scanning | paused | stopped | failed
  visited
  estimated?
  completedPartitions
  pendingPartitions
  limitingReason?
  lastCompletedAt?
```

`limitingReason` is factual technical evidence, not a resource disposition. A source that reaches
a work slice is `paused` or `scanning`, not failed. A source that reaches a hard safety ceiling says
which ceiling ended collection.

## Version and provenance

### VersionSet

Version axes remain independent:

- `InstalledVersion`
- `EffectiveVersion`
- `CandidateVersion`
- `CompatibleCandidate`
- `RecommendedCandidate`
- `ProducerVersion`
- `SourceRevision`
- `CacheGeneration`
- `ContentDigest`
- `Pin`
- `Channel`

An Updates available entry requires a verified installed version, a source-bound candidate, and
verified compatibility. `Recommended` additionally requires a named recommendation authority.

### ProvenanceAssertion

Provenance may identify a built-in host installer, plugin marketplace, package manager, `npx
skills`-style installer, managed projection, provider-owned configuration, or manual placement.
Each link in the chain carries evidence. When the chain cannot be verified, provenance is omitted;
the placement remains visible.

Source compatibility and source identity are separate. A marketplace origin does not prove that a
candidate works with the installed host.

## Dependencies and conflicts

### DependencyEdge

```text
DependencyEdge
  edgeId
  fromPlacementId
  toResourceOrPlacementId
  kind
  requirement?
  environmentRelation?
  evidence
```

Kinds include `requires-executable`, `requires-runtime`, `requires-provider`, `requires-credential`,
`loads`, `configures`, `projects`, `consumes`, `stores-in`, `resolves-through`, and
`windows-hosts-wsl`. Reverse dependencies are derived from the same edges.

A Managed change to a shared dependency requires complete verified consumer enumeration within its
affected environments. Cycles are rendered and traversed with visited-node bounds; they do not
become recursive actions.

### ConflictSet

Conflict classification explains a relationship; it does not decide removal:

- `duplicate-placement` — independently verified equivalent definitions in separate placements;
- `shadowed-override` — a narrower placement takes precedence over a broader one;
- `same-name-different-definition` — names match while verified definitions differ;
- `equivalent-transport-registration` — MCP registrations target the same verified transport;
- `version-requirement-divergence` — consumers require incompatible versions;
- `dependency-resolution-collision` — verified resolution selects a different dependency than a
  placement declares; and
- `shared-artifact` — several consumers intentionally use one artifact; explicitly not a duplicate.

Every UI filter and tooltip describes the evidence established and the conclusions it does not
establish.

## Conditions, Guidance, and actions

### PlacementCondition

Condition is descriptive and separate from urgency or actionability. Examples include healthy,
disabled, missing verified dependency, update candidate present, definitions differ, superseded
revision, recovery receipt open, or configured credential mechanism not checked.

No catch-all unhealthy state is required. A verified condition can exist without any Guidance.

### GuidanceEntry

```text
GuidanceEntry
  guidanceId
  placementId
  lane                 apply | steps | decision | update | recovery
  outcome
  verifiedPremises[]
  impact
  preserved[]
  choicesOrProcedure?
  providerCapabilityId?
  dispositionIdentity
```

Admission requires an exact placement, a verified condition, a bounded outcome, and at least one
grounded operation, procedure, candidate, containment choice, or receipt audit. Otherwise the
condition remains Inventory evidence with **No action is requested**.

### RemediationCapability

A capability describes one exact provider, version, resource kind, operation, environment, scope,
preflight, effect, verification, rollback, restart, privilege, and network contract. It is separate
from Guidance: a Guided procedure can exist without an executable capability.

### RecommendationDisposition

- `Acknowledged` records that the user saw a condition without hiding the resource.
- `Snoozed` removes one Guidance entry until a stated expiry.
- `IgnoredExactCandidate` suppresses only the same candidate identity.

Expiry, candidate change, installed-version change, dependency change, source-fingerprint drift,
or security-severity increase invalidates the matching disposition. A rescan may therefore
resurface a snoozed item when an invalidation premise changes.

## Recovery audit model

`InterruptionAudit` binds:

- receipt integrity and identity;
- last durable transaction phase;
- exact provider and provider version;
- recorded preimage and verified postimage;
- disclosed read-only checks and probe policy;
- observed current fingerprint;
- comparison result; and
- source-bound next steps, when available.

User-facing results are **No action started**, **Matches recorded before state**, **Matches verified
after state**, **Differs from both recorded states**, **Matching inspection provider is not
present**, **Receipt integrity check failed**, or **Affected catalog refresh did not complete**.

Recording a conclusive result is a separate single-receipt write. Audit never mutates the resource.

## Domain events

- `InventoryPublished`
- `DiscoverySourceConfigured`
- `DiscoverySourceStopped`
- `ScanProgressCheckpointed`
- `ScanCompleted`
- `GuidanceAdmitted`
- `DispositionRecorded`
- `DispositionInvalidated`
- `ActionPlanned`
- `ActionApplied`
- `ActionVerified`
- `InterruptionDetected`
- `InterruptionAudited`
- `ReceiptReconciled`
- `RecipeRefreshed`
- `RecipeAccepted`
- `RecipeWithdrawn`

Events are evidence and integration seams. They do not grant capabilities or execute follow-on
actions automatically.

## Invariants

1. Every actionable row identifies one exact placement.
2. A logical resource, placement, artifact, and consumer binding never collapse into one identity.
3. Administrative scope, provenance, producer, consumer, and blast radius remain orthogonal.
4. Missing evidence omits a claim; it never creates a user-facing Unknown resource state.
5. Inferred evidence never supplies a primary label or an action premise.
6. Conflict classification never grants ownership or deletion authority.
7. A candidate is not compatible or recommended without separate evidence.
8. No write action spans more than one exact provider operation and placement.
9. Read batching never merges evidence, receipts, scopes, or conclusions.
10. Partial scans never support negative or complete-population claims.
11. A work-slice limit pauses progress; it does not abandon a valid scan.
12. An interruption audit never retries, replays, undoes, compensates, or mutates the resource.
13. Credential values and private configuration never enter the management projection.
14. External adapters cannot self-authorize visibility, recommendation, or mutation capabilities.
