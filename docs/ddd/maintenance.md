# Maintenance Domain

This document specifies the target domain accepted by
[ADR-0044](../adr/0044-receipt-aware-maintenance-control-plane.md) and tracked by
[GitHub issue #200](https://github.com/pacphi/agentic-kit/issues/200).

> **Delivery status:** accepted plan, not current behavior. The Catalog v2 and
> `ak x skills plan` read-only foundation from issue #198 is implemented. Maintenance findings,
> commands, action providers, dashboard routes, transactions, receipts, and undo remain planned
> until their implementation and tests land.

The read-only prerequisite was verified against merged
[PR #201](https://github.com/pacphi/agentic-kit/pull/201): canonical standalone/plugin identity,
provider/version/source-scope occurrences, explicit name and entrypoint relationships, project
pressure, source drift, bounded dashboard views, and the non-mutating skill preview are present.
ADR-0044 records the detailed matrix and the limitations Maintenance must preserve.

## Purpose

Maintenance helps a human understand upgrade and cleanup pressure, decide what to preserve or
change, and carry out only those operations for which ownership, provider capability,
verification, and recovery are explicit. Its promise is:

> Tell me what is outdated or unnecessary, explain why, show the consequences, and help me change
> it safely.

It is not a generic cleaner. It does not infer deletion authority from names, age, similarity,
digest equality, cache location, or missing usage observations.

## Boundary

**System measures; Maintenance acts.**

[Machine Footprint](machine-footprint.md) owns observed local inventory, project pressure, source
relationships, bounded digest evidence, freshness, and advisory candidates. Maintenance consumes
those facts but may not reinterpret a filesystem observation as ownership or a safe-delete
decision. The existing Machine Footprint collectors and System routes remain read-only.

[Integration Management](integration-management.md) owns host and resource lifecycle capabilities,
native-surface facts, desired state, and agentic-kit ownership receipts. Maintenance asks that
context which exact provider operation is available; it does not manufacture a missing lifecycle
verb.

Dashboard Delivery owns the protected HTTP boundary and accessible interaction. Maintenance owns
the application service behind both the future CLI and System > Maintenance view. Placement under
System is information architecture, not a transfer of mutation authority to Machine Footprint.

The implemented prerequisite is:

```text
ak system --deep
        |
        v
CatalogInventory v2
  occurrences: host + source scope + project + producer/version + entrypoint digest
  relationships: exact logical name + exact entrypoint digest
  pressure: project / user / enabled-plugin contributions; incomplete evidence is explicit
        |
        v
ak x skills plan --project <path>
  classifies; reports source state; projects a possible result; writes nothing
```

Issue #198 owns that measurement-and-preview foundation. This domain owns future apply, upgrade,
disable, uninstall, prune, verification, receipt, and guarded-undo behavior.

## Model

```text
Catalog/Footprint ports       Ownership/lifecycle ports       Provider probes
          \                            |                         /
           +---------------------------+------------------------+
                                       |
                                       v
                              MaintenanceFinding[]
                                       |
                          selection + evidence refresh
                                       v
                                MaintenancePlan
                           short-lived + source-bound
                                       |
                       confirmation + ActionCapability
                                       v
                             TransactionCoordinator
                  preflight -> live re-audit -> apply -> verify
                                       |
                                       v
                              TransactionReceipt
                                       |
                                 guarded undo
```

### MaintenanceFinding

A finding is an evidence-backed condition, never an instruction. Supported target states are:

- `current`;
- `update-available`;
- `stale-configuration`;
- `orphaned-cache`;
- `superseded-version`;
- `unsupported` or `incompatible`;
- `modified`;
- `ambiguous`; and
- `unreadable-or-partial`.

Each finding carries its resource identity, owner, observed and desired/recommended facts, source,
capture time, completeness, affected consumers, evidence gaps, and candidate next step. A finding
whose authority or provider is missing remains explainable and report-only.

### MaintenanceAction

An action is one exact operation proposed by one ActionProvider. It binds:

- provider and target identity;
- expected before-state and projected after-state;
- affected capabilities and paths as server-derived evidence;
- safety and rollback classes;
- restart requirement;
- preflight and verification contracts; and
- an explicit unsupported reason when no executor exists.

It contains no browser-supplied command or filesystem target.

### MaintenancePlan

A plan is an immutable, short-lived selection of MaintenanceActions, bound to exact evidence and a
current source fingerprint. It records action IDs, scope, safety class, impact, expiry, and a
content-derived plan digest. It is not authorization and cannot be replayed after evidence drift.

The existing `ak x skills plan` output is a **skill maintenance preview**: useful input to findings,
but not this aggregate, an ActionCapability, or permission to mutate.

### ActionProvider

An ActionProvider is a resource-owner-specific port:

```text
detect -> propose -> preflight -> apply -> verify -> undo
```

Every step can return unsupported or degraded evidence. A provider advertises only operations
implemented through a proven host-native lifecycle or an exact agentic-kit-owned procedure. There
is no generic shell, recursive-delete, plugin-cache, or arbitrary-path provider.

### ActionCapability

An ActionCapability is ephemeral one-use authorization minted server-side for a current selected
plan and presented only through the confirmation flow. It binds dashboard session, plan digest,
selected action IDs, source fingerprint, scope, safety class, and expiry. It is consumed whether
apply succeeds or fails. It is not stored as durable authority and cannot be widened by the
browser.

### TransactionReceipt

A TransactionReceipt is private durable evidence, not merely a success log. It binds intent,
policy decision, source fingerprint, exact inputs, fixed operation, timestamps, before-state,
result, verification, after-state, rollback class, rollback material, and any compensation. A zero
native-command exit without a verified postcondition is recorded as failed or partial, never
successful.

## Version and evidence model

The following axes are independent:

1. installed/effective version;
2. recommended compatible version;
3. producer/plugin version;
4. marketplace or source revision;
5. cache generation;
6. content digest; and
7. evidence capture time, freshness, and health.

“Latest” is not automatically “recommended”. Compatibility policy and provider ownership decide.
An entrypoint digest proves only the bytes hashed; it says nothing about supporting files,
ownership, context loading, safe removal, or compatibility.

## Policy

### Action safety

| Class | Meaning | UI behavior |
|-------|---------|-------------|
| `safe-automatic-eligible` | Ownership, current evidence, provider operation, and verification are strong enough to propose | Human selection and confirmation still required |
| `approval-required` | An exact action exists, but impact or preservation risk needs judgment | Explain the decision and require confirmation |
| `upstream-required` | The local system has no safe provider operation | Show a verified native command or upstream workflow; no apply control |
| `never-automatic` | Authority or recovery is structurally insufficient | Preserve and explain the blocker |

One transaction cannot mix safety classes. Eligibility never permits background or implicit
execution.

### Rollback

Rollback is a separate dimension:

- `reversible` — the recorded preimage can be restored and verification is defined;
- `compensating` — a provider can issue a new operation toward the prior state but cannot undo the
  original operation atomically; or
- `irreversible` — no safe automated recovery is available.

Marketplace refreshes, package installs, network operations, and process termination are not
filesystem-atomic. The UI states the rollback class and restart requirement before confirmation.

## Provider policy

The minimum initial executable set is deliberately narrow:

### Host-native plugins

- Preserve `plugin@marketplace/version -> skills | commands | agents | MCP servers`.
- Advertise only lifecycle verbs supported by the selected host and implemented as fixed argv.
- Claude may expose its proven enable, disable, update, uninstall, and prune verbs. Codex may
  expose its proven remove and marketplace-upgrade verbs; it must not invent per-plugin update or
  disable. OpenCode remains report-only until it proves a safe plugin lifecycle manager.
- Update, disable, or remove through the owning host, never by deleting a cache child.
- Rescan native inventory and the affected Catalog slice after an operation.
- A host without a safe verb is report-only for that action.

### Host-native MCP registrations

- Keep registered, configured, reachable, healthy, authenticated, and authorized separate.
- Remove only through a supported native operation, with topology checked immediately before and
  after apply.
- Claude and Codex may expose their proven native removal operation. OpenCode remains report-only
  for removal until a safe native removal verb is proven.
- Never rewrite a host config as a guessed substitute for a missing lifecycle command.

### Agentic-kit-owned projections

- Archive or remove only when an exact ownership receipt covers a complete bounded tree and every
  current file matches that receipt.
- The current entrypoint-only skill receipt is insufficient to authorize directory deletion.
- Preserve modified, ambiguous, symlinked, unreadable, partial, unreceipted, and user-owned trees.
- Exact name, semantic similarity, and digest equality are supporting evidence only.

### Agentic-kit caches and daemons

- The first daemon provider may adapt only the existing identity-proven Ruflo MCP orphan
  procedure; it is not a generic process-kill provider.
- Cache actions remain deferred until each cache has an existing owner-native cleanup command or a
  bounded agentic-kit-owned procedure.
- Reproducibility and exact ownership are prerequisites; age alone is not.
- Recheck process command, owner, parent identity, and other provider-required invariants
  immediately before termination.
- Historical transcripts remain unique data and review/archival-only.
- Pinned runtimes remain review-only until every known project pin is checked.

## Transaction rules

Before the first mutation, the coordinator validates every selected action and completes every
preflight. Immediately before apply, it reacquires live evidence and ownership and compares the
source fingerprint. Any drift expires the plan.

All filesystem inputs must be absolute server-derived paths contained by a proven root. Globs,
traversal, symlink escape, special files, and browser paths are rejected. Native commands are fixed
argv arrays chosen from the server-side provider registry. Overlapping mutations are serialized,
and an owner-only journal makes interrupted work visible after restart.

After each operation, the provider verifies its native inventory and the smallest affected Catalog
slice. Failure stops dependent and not-yet-started actions. Completed outcomes remain in a receipt;
only provider-declared compensation runs. Undo is available only when current state matches the
recorded postcondition and the rollback class permits it.

## Dashboard and CLI delivery

Maintenance is planned as a new secondary destination under **System**, with five human-oriented
groups:

1. Updates ready
2. Safe cleanup
3. Needs review
4. Unsupported or blocked
5. Recent changes / Undo

Every row answers what the resource is, who owns it, why it is present, what depends on it, what
will change, whether restart is required, how recovery works, and how fresh and complete the
evidence is. Use **Ready to apply**, **Review required**, and **Cannot safely automate**. Do not
add a hygiene score, a cross-class reclaimable total, or “Clean all”.

The target routes are:

```text
GET  /api/maintenance
POST /api/maintenance/plans
POST /api/maintenance/apply
POST /api/maintenance/undo
```

The three POST routes are the only planned exceptions to the dashboard's blanket non-GET guard.
They retain the per-session header token and Host, Origin, and Sec-Fetch-Site checks; accept only
bounded JSON; and never accept a command or path. Apply and undo require a one-use
ActionCapability. The SSE query-token exception does not apply to POST.

The planned CLI twin is:

```text
ak maintain scan [--deep] [--json]
ak maintain plan [--project <path>] [--json]
ak maintain apply --plan <id> --actions <id,...> --yes
ak maintain undo --receipt <id> --yes
```

The browser and CLI call the same application service. Native confirmation dialogs manage initial
and restored focus; transaction progress and results are announced; unknown/degraded evidence is
textual; and receipt/undo controls work with a keyboard.

## Delivery sequence

1. Pin the #198 read model and make incomplete, dirty, or drifted evidence fail closed.
2. Add read-only findings and MaintenancePlan generation.
3. Extract a generic transaction coordinator from hook remediation while preserving that
   context's existing safety invariants.
4. Add host-native plugin and MCP providers for proven verbs only.
5. Extend ownership receipts to complete tree manifests before skill projection archival/removal.
6. Adapt the existing identity-proven daemon procedure and add cache providers only where an exact
   procedure exists.
7. Add System > Maintenance, then the narrow action routes and accessible interactions.
8. Prove convergence, interruption recovery, guarded undo, and report-only limitations.

Each step is independently useful and safe if later work does not ship.

## Invariants and non-claims

- Installed does not mean enabled; enabled does not mean effective or loaded into model context.
- Registration does not mean configured, reachable, healthy, authenticated, or authorized.
- A source timestamp does not prove nested content unchanged.
- A plan identifier is not authorization; an ActionCapability is not a receipt.
- Equal entrypoint digests do not prove equal trees, ownership, or safe deletion.
- Age and missing observations do not prove staleness, orphaning, or disuse.
- A machine-wide count is not a project-specific context budget.
- Machine Footprint remains read-only even though Maintenance appears in the same System area.
- Unsupported host operations remain visible limitations, never fabricated buttons.
