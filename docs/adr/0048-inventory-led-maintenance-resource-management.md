# ADR-0048 — Inventory-led Maintenance resource management

- **Status:** Proposed
- **Date:** 2026-09-04
- **Updated:** 2026-09-04 — records the completed Maintenance overhaul decision interview and
  defines the proposed inventory, guidance, discovery, activity, recovery-audit, and action
  contracts; no implementation is claimed
- **Deciders:** agentic-kit maintainers
- **Planned successor to:** [ADR-0044](0044-receipt-aware-maintenance-control-plane.md) for the
  findings-first product and surface contracts; ADR-0044 remains authoritative until this decision
  is accepted and implemented
- **Amends when implemented:** [ADR-0025](0025-machine-footprint-metrics.md),
  [ADR-0029](0029-host-adapter-extension-point.md),
  [ADR-0032](0032-model-lifecycle-intelligence.md),
  [ADR-0041](0041-host-neutral-hook-configuration-assurance.md),
  [ADR-0045](0045-artifact-consumer-bindings-and-explicit-maintenance-scans.md),
  [ADR-0046](0046-scan-local-observation-reuse-and-nonblocking-deep-scans.md), and
  [ADR-0047](0047-streaming-observation-forest.md)
- **Detailed design:** [Maintenance overhaul package](../design/maintenance-overhaul/README.md)

## Status of the governed system

ADR-0044 is Implemented as of 2026-09-03. Its findings-first Maintenance screen, provider
registry, source-bound plans, one-use capabilities, verification, receipts, undo, and CLI-only
receipt recovery describe the current product. ADR-0032 is Implemented as of 2026-08-25 and keeps
model lifecycle operations read-only. ADR-0046 is Implemented, while ADR-0047 is Accepted with only
its Projects observation-forest pilot implemented.

This ADR proposes a successor product and the migration to it. Until the relevant implementation
slice is proven and this record is updated, the existing ADRs and code remain authoritative.

## Context

The current Maintenance experience begins with findings. It generally omits healthy resources,
groups work by internal actionability buckets, separates Catalog from remediation, and makes users
join scope, physical placement, provider coverage, consumer bindings, versions, and receipts across
several surfaces. This is safe but difficult to navigate and cannot answer the first management
question: what agent-related resources exist here, where are they installed, where did they come
from, who consumes them, and what can I confidently do about them?

The requested product is an inventory-led resource management workspace. It must cover system,
machine, user, and project/repository placements; preserve one actionable row per exact placement;
group related placements under a logical resource; explain dependencies and conflicts; and admit
only grounded actions or bounded decisions into Guidance.

The change cannot turn discovery into mutation authority. A resource's presence, name, apparent
installer, age, version, digest, missing executable, or duplicate-looking definition does not prove
ownership, compatibility, obsolescence, safe removal, or permission to act. The existing narrow
transaction engine remains the safety floor.

## Decision

### 1. Make Maintenance the resource-management workspace

Catalog is folded into Maintenance as a presentation and query concern. Machine Footprint keeps
ownership of read-only measurement; Maintenance owns the management projection and controlled
actions. The visible third-level destinations are:

1. **Inventory** — every verified resource placement, healthy resources included;
2. **Guidance** — only bounded actions, procedures, updates, decisions, and recovery work;
3. **Discovery** — automatic and user-configured sources, exclusions, coverage, and scans; and
4. **Activity** — interruption audits, receipts, deferrals, recipe changes, and scan history.

Inventory opens across all scopes, sorts Guidance-admitted resources first, and remembers the
user's last view. Curated views ship before saved views, but the query model and opaque URL state
must support saved views later without redesign.

### 2. Keep administrative scope, source, and consumers independent

The first scope lens is **System**, **Machine**, **User**, **Projects**, or **Across scopes**:

- **System** is operating-system or all-user state that normally requires OS administration.
- **Machine** is host-wide state owned by the current user and shared across that user's projects.
- **User** is one user's host configuration, capability, cache, credential mechanism, or tool state.
- **Projects** is one exact repository/worktree placement or a bounded collection of them.
- **Across scopes** is a comparison lens, not another placement.

Producer scope, configuration scope, effective consumer scope, provenance, and blast radius remain
separate fields. WSL distributions are separate Linux environments linked to the Windows host by
explicit consumer or dependency edges. Nothing executes or crosses filesystems implicitly.

### 3. Use placement rows grouped by logical resources

The management projection separates:

- `ManagedResource` — the logical thing a person recognizes;
- `ResourcePlacement` — the exact installed or configured row and action target;
- `PhysicalArtifact` — a file, configuration selector, package, runtime, cache object, model blob,
  or other measured carrier;
- `ConsumerBinding` — a host, adapter, project, runtime, or provider that consumes a placement;
- `ProvenanceAssertion` — one evidence-bearing origin claim;
- `VersionObservation` — one installed, effective, candidate, compatible, recommended, pinned,
  channel, revision, or digest fact;
- `DependencyEdge` — a typed dependency or consumer relationship; and
- `ConflictSet` — a classification over placements that never grants deletion authority.

One physical artifact used by several hosts appears once with several bindings. Several physical
placements of one logical resource appear as separate selectable rows under one group.

### 4. Include the agentic development footprint

The v1 resource universe includes skills, MCP registrations, plugins, hooks, instruction/context
files, agents, commands/prompts, host adapters, executables, runtimes, models, provider
configuration placements, agent-related caches, credential readiness, and related storage.

Storage is included only when it can be related to agent hosts, projects, dependencies, models,
runtimes, providers, or developer tooling. Cache views show a root summary plus individually
verified actionable children. Installed models are first-class resources with provider,
version/revision, storage, consumers, and lifecycle guidance.

### 5. Make evidence compositional and keep inconclusive data out of action surfaces

Identity, placement, provenance, version, dependency, compatibility, recommendation, impact, and
remedy are independently evidenced. The evidence score is a structured scorecard, not a numeric
confidence average. Claims may be:

- **Verified** — suitable for primary labels and for the exact premises an action requires;
- **Provider-declared** — shown with its named authority and scope;
- **Inferred** — shown only in technical details; or
- omitted when no useful claim can be made.

The user interface never labels a resource `Unknown` or `Unsupported`. Inconclusive discoveries
are omitted from Inventory and actions and summarized separately in Discovery with factual reasons.
A verified resource without verifiable provenance remains visible with its provenance field
omitted. Internal refusal and diagnostic codes may remain closed machine contracts but never leak
as user-facing disposition labels.

### 6. Admit only bounded outcomes into Guidance

The phrase **Needs attention** and the generic **Review** action are removed. Guidance has five
lanes:

1. **Can apply here** — a verified, previewable Managed operation;
2. **Steps available** — a verified condition with a trusted, environment-specific procedure;
3. **Decisions to make** — a bounded choice with concrete consequences;
4. **Updates available** — a verified candidate and verified compatibility; and
5. **Recovery to finish** — an interrupted write whose receipt is not reconciled.

A verified condition with no grounded remedy or bounded decision remains calm Inventory evidence.
It does not enter Guidance, acquire warning styling, contribute a navigation badge, or rise in the
action-priority sort. Its inspector says **No action is requested** and explains why no action is
offered. Warning treatment requires a verified consequential impact and at least one bounded
containment choice.

### 7. Separate candidate, compatibility, and recommendation authority

An available version is not automatically compatible or recommended. Candidate source,
compatibility, pins, channel, and named recommendation authority are independent. `Recommended` is
used only when a named authority supports that exact candidate for the placement.

Stable channels are the default. Prerelease and nightly candidates appear only when the exact
placement is already enrolled or the user explicitly enables the channel. Downgrades and channel
changes are separate operations and are not Managed in v1. Candidates without verified
compatibility remain technical evidence and do not enter Updates available.

Package-manager coverage is capability-driven. Standalone semantic-versioned managers cover the
current major and three preceding majors; OS-coupled managers cover the current and three preceding
supported OS release families; rolling managers use capability-tested command contracts and a
documented minimum tested version.

### 8. Make Discovery configurable, truthful, and completion-oriented

Agentic-kit retains curated automatic discovery. Users may add an exact project or a bounded
collection root, disable an automatic source, and create exact or recursive path exclusions.
Discovery source configuration is user-level `kit.json` intent in v1 and is not importable or
exportable across machines.

Before saving a collection root, Maintenance previews projects found, applied exclusions,
traversal depth, symlinks encountered, and estimated scan work. Network shares, removable media,
cloud placeholders, symlink traversal, and host/WSL boundary crossing are excluded by default;
users add an exact root explicitly when permitted.

Scan budgets bound work slices and unsafe resource consumption, not cumulative completion. A
stable, finite, readable source progresses through owner-private checkpoints until complete. The
last completed snapshot remains authoritative; partial work never replaces it. A budget-limited
run states its coverage exactly and never supports absence, uniqueness, complete-conflict,
reclaimable-total, or Managed-action claims. Individually verified resources found so far may be
shown with **Source scan incomplete** in technical details.

No filesystem watcher or always-running daemon is added in v1. Passive local scans may run when the
application starts or Maintenance opens, coalesced by freshness. Deep traversal, executable probes,
provider commands, and network access remain explicit. Users can pause, resume, or stop; stopping
removes the source from the active catalog while retaining bounded historical receipts and scan
records.

This is the separate journal-backed scan decision anticipated by ADR-0047. It must reuse or extend
the streaming observation forest rather than introduce a competing walker or a per-file persistent
index.

### 9. Preserve exact provider authority for every write

Candidate verbs are update, disable, remove, repair registration, relink dependency, reinstall,
clean cache, restore, snooze, and acknowledge. Only contextually relevant verbs appear.

Managed writes retain `detect -> findings/actionFor -> preflight -> apply -> verify`, exact
server-derived targets, source-bound plans, one-use capabilities, mutation locking, receipts, and
guarded undo. No destructive or write operation batches in the UI or CLI. Read-only scans, audits,
and queries may batch while retaining per-resource evidence.

General package installation or upgrade execution is not introduced in v1. Existing narrowly
proven Managed providers remain. Guided commands are assembled only from typed trusted fields and
show source, OS, package manager, shell, expected effect, verification command, and privilege
requirement. They are copyable but never executed automatically.

Managed cache cleanup is admitted only when the owning tool defines one lifecycle object and a
provider proves exact identity, ownership, real-path containment, symlink safety, complete impact,
preflight freshness, regeneration consequences, and postcondition verification. No elevated cache
cleanup executes in v1.

Project changes use a separately approved Git-aware transaction: preview a bounded patch, permit
unrelated dirty files, refuse affected-path drift, never stash or commit, apply atomically where
possible, validate, and retain a receipt. A shared dependency is Managed only when every affected
consumer in the relevant environments is verified and previewed.

Exact provider-owned model removal is Managed in v1 only when identity/revision, active-use state,
consumers, logical versus physical storage impact, the provider-native removal verb, and absence
verification are complete. It removes one model per action, requires no elevation, and states that
removal may be irreversible and require redownload. Model download and update remain guided.

### 10. Split interruption audit from receipt reconciliation

An interrupted action offers **Audit interruption**, not a generic Verify again. The audit is
read-only with respect to the resource and discloses the receipt, last durable phase, exact provider
and version, checks, read-only executable probes, and network requirement. It compares current
provider evidence only with the recorded preimage or verified postimage and never retries, replays,
undoes, rolls back, or completes the action.

Read-only audits may batch and remain ephemeral. A conclusive result is recorded one receipt at a
time through a separate confirmed write: **Record no change**, **Record completed**, or **Record
restored**. Non-conclusive audits state which comparisons failed and offer only source-bound
provider guidance. Export remains available before reconciliation.

An unresolved receipt blocks writes to its affected placement, environment, and verified
dependents, not unrelated environments. Receipt-integrity failure remains a broader fail-closed
exception because the affected target cannot be trusted.

### 11. Support hosts, operating systems, shells, and package managers by capability

Launch targets macOS, Linux, Windows, and WSL; Claude, Codex, OpenCode, and an independently
admitted Hermes adapter. Host visibility and actions come from validated capabilities rather than
a hardcoded parity claim. An external adapter cannot self-authorize an operation.

Guided procedures cover bash, zsh, PowerShell, cmd.exe, and the selected WSL shell. A preferred
shell is stored per environment and can be changed in the procedure panel. Recipe dimensions bind
OS and version family, architecture, host and version, resource kind, package manager and tested
range, shell, operation, source authority, privilege, effect, verification, and invalidation.

The package-manager catalogue covers Homebrew, MacPorts, apt, dnf, pacman, zypper, Snap, npm/npx,
pnpm, Yarn, Bun, pip/pipx/uv, Cargo, mise/asdf, WinGet, Chocolatey, and Scoop. Coverage means
detection, installed-version observation, provenance evidence where available, dependency
relationships, candidate comparison, guided procedure generation, and verification—not automatic
installation authority.

Built-in and provider recipes are signed and versioned. Later registry refreshes are explicit,
allowlisted, signature- and publisher-verified, digest-bound, diffed, and require acceptance before
activating newly introduced operations or privilege requirements. Withdrawn recipes remain
historical evidence but cannot create new guidance.

### 12. Protect credentials, paths, preferences, and history

Credential readiness states are **Not configured**, **Configured but not checked**, **Ready**,
**Check failed**, and **Expired or renewal needed**. Passive checks cover presence and safe
permissions. Authentication validity requires an explicit probe. Maintenance may name the
credential mechanism but never exposes its value, token metadata, account email, private registry
URL, or raw configuration.

Rows show scope and a short human-readable location breadcrumb. The owner-only inspector can reveal
and copy the exact path. Human-readable paths never enter filter URLs. Exported receipts are
sanitized by default; including local paths requires an explicit warned choice.

Filter state uses opaque environment, placement, and resource identifiers. URL state overrides the
remembered user view. View, filter, shell, and retention preferences live in owner-private user
state, not project configuration. Discovery roots and exclusions remain user `kit.json` intent.

Scan summaries default to the existing 32-snapshot/90-day precedent per environment. Intermediate
checkpoints are retained only until completion plus a short recovery window. Action receipts are
not automatically deleted in v1; users may clear terminal, non-protected history. Unresolved,
verification-required, undo-eligible, active dismissal, and recipe-acceptance evidence is protected
from ordinary history clearing. Defaults are user-overridable globally and per environment within
those safety floors.

### 13. Treat accessibility and usability evidence as release gates

Desktop uses a selectable inventory with a side inspector; narrow screens use a full-screen detail
view with **Back to N results**. Multiselect facets show counts, removable chips, and one Clear all
action. Unavailable values disappear. Icons always accompany visible text and never carry scope,
source, action, or status meaning alone.

The release must prove keyboard focus continuity, debounced result announcements, table/list and
disclosure semantics, 320 CSS-pixel reflow, target sizing, forced-colors behavior, both themes,
VoiceOver with Safari, and NVDA with Chrome or Edge. Warning treatments remain reserved for
consequential, actionable conditions.

## Consequences

### Positive

- People can inventory the complete verified footprint before deciding what to change.
- Scope, provenance, dependencies, versions, consumers, and actions remain explainable rather than
  being collapsed into a health badge.
- Guidance becomes a work-reduction surface instead of an alarm queue.
- Existing safe providers and receipts survive the product migration.
- Large scans can complete progressively without freezing the dashboard or lying about coverage.

### Negative

- The management projection, dependency graph, discovery-source store, recipe model, resumable scan
  journal, faceted query service, and migration compatibility layer are substantial new contracts.
- Catalog retirement touches Machine Footprint, Maintenance, Models, hooks, adapters, dashboard
  routing, CLI behavior, and history.
- Simultaneous cross-platform launch requires fixtures and conformance evidence for many capability
  combinations while intentionally offering fewer Managed actions than guided procedures.

## V1 non-goals

- General package-manager install, upgrade, or arbitrary command execution
- Elevated or system-wide automatic remediation
- Destructive or write batching
- Implicit Windows/WSL or symlink traversal
- Passive network checks or automatic recipe activation
- Filesystem watchers or an always-running scan daemon
- Model download or update execution
- Import/export of discovery-source configuration
- Guessing provenance, recommendation authority, compatibility, consumers, or safe deletion

## Delivery and status transitions

Implementation proceeds through separately gated slices: contracts and fixtures; read-only
management projection; Discovery and resumable scans; Inventory and Guidance; existing action
migration; interruption audit; exact model removal; Catalog redirects and retirement. The detailed
[migration plan](../design/maintenance-overhaul/migration-plan.md) defines the gates.

This ADR moves from Proposed to Accepted only after the schema, interaction prototype, provider
matrix, privacy review, and acceptance suite are approved. It becomes Implemented only when the
legacy Catalog and findings-first Maintenance surfaces are retired or explicitly retained as
documented compatibility routes and every acceptance gate passes. At that point ADR-0044 may be
marked Superseded; not before.

## Alternatives considered

- **Restyle the findings queue.** Rejected because findings cannot represent a complete healthy
  inventory or provide stable placement identity.
- **Turn Catalog rows directly into actions.** Rejected because measurement evidence does not grant
  lifecycle authority.
- **Show every verified anomaly in Guidance.** Rejected because remedy-free observations create an
  unbounded research queue and alarm fatigue.
- **Use a generic package-manager or shell executor.** Rejected because a display recipe is not an
  exact provider operation or ownership proof.
- **End scans when a small time budget expires.** Rejected because a valid large source could remain
  permanently partial. Work slicing and checkpoints protect responsiveness without abandoning
  completion.
- **Replace the streaming observation forest.** Rejected because ADR-0047 already owns shared
  acquisition semantics and an independent walker would duplicate truth and cost.

## Review triggers

Review this decision before adding elevated execution, write batching, passive network work,
automatic recipe activation, generic package execution, cross-environment mutation, background
watchers, discovery configuration portability, or any Managed action whose provider cannot prove
identity, authority, impact, and verification independently.

## References

- [Maintenance overhaul design package](../design/maintenance-overhaul/README.md)
- `src/lib/maintenance/recovery-coordinator.mjs` — implemented provider-bound current-state
  inspection and receipt reconciliation baseline
- `src/lib/maintenance/transaction-store.mjs` — implemented private integrity-sealed receipt store
- `src/lib/footprint/observation-forest.mjs` — implemented ADR-0047 Projects pilot baseline
- [Carbon status indicators](https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/)
- [GOV.UK warning text](https://design-system.service.gov.uk/components/warning-text/)
- [PatternFly alert guidance](https://www.patternfly.org/components/alert/design-guidelines/)
- [W3C accessible names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)
