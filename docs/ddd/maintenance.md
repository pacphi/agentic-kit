# Maintenance domain

Maintenance is the implemented human-guided control plane defined by
[ADR-0044](../adr/0044-receipt-aware-maintenance-control-plane.md). It explains upgrade and cleanup
pressure, then carries out only operations for which ownership, provider capability, verification,
and recovery evidence are explicit.

Its promise is:

> Tell me what needs attention, explain the impact, and help me change only what can be proven safe
> to target.

It is not a generic cleaner. It does not infer deletion authority from a name, age, cache location,
digest match, or missing usage observation.

## Boundary

**System measures; Maintenance acts.**

[Machine Footprint](machine-footprint.md) owns the read-only inventory, project pressure, source
relationships, freshness, and advisory candidates. Maintenance consumes those facts without
turning an observation into ownership. Catalog, Advisory, and the Footprint collectors do not
mutate the machine.

[Integration Management](integration-management.md) owns host lifecycle capability, desired state,
and agentic-kit ownership receipts. Maintenance asks which exact provider operation exists. It does
not manufacture a missing lifecycle verb.

Dashboard Delivery owns the authenticated loopback boundary and accessible interactions.
Maintenance owns the application service used by both the CLI and **System > Maintenance**.
Placement under System is navigation, not domain ownership.

## Model

    Footprint evidence       Ownership evidence       Provider probes
             \                     |                       /
              +--------------------+----------------------+
                                   |
                          MaintenanceFinding[]
                                   |
                         select + refresh
                                   |
                           MaintenancePlan
                      short-lived + source-bound
                                   |
                  confirmation + ActionCapability
                                   |
                         TransactionCoordinator
                 preflight -> apply -> verify -> receipt
                                   |
                         undo or reconciliation

### MaintenanceFinding

A finding is an evidence-backed condition, never an instruction. The closed state vocabulary is:

- <code>current-healthy</code>;
- <code>update-available</code>;
- <code>stale-configuration</code>;
- <code>orphaned-cache</code>;
- <code>superseded-version</code>;
- <code>unsupported-incompatible</code>;
- <code>modified</code>;
- <code>ambiguous</code>; and
- <code>unreadable-partial</code>.

Every finding retains identity, owner, source, capture health, completeness, affected consumers,
missing evidence, and a prescriptive action label. Missing provider authority leaves a finding
visible but report-only with a resource-specific reason.

Affected consumers are host bindings, not inferred copies. One shared physical artifact carried by
Claude, Codex, and OpenCode remains one artifact with a three-host blast radius. A disabled binding
is visible evidence but is not treated as affected by a proposed change.

### CapabilityRelationship

A relationship is typed evidence joining observed project and shared occurrences for the same host,
kind, and logical name. Maintenance currently classifies four human decisions:

- <code>redundant-project-override</code> — complete bounded definitions are equal;
- <code>same-name-different-definition</code> — complete bounded definitions differ;
- <code>tracked-source-copy</code> — equal definitions are project source tracked by Git; and
- <code>legacy-equivalent-transport</code> — canonical and legacy MCP registrations have equal
  observed transport configuration.

Relationship members expose bounded, path-free source, scope, ownership, and tracking labels to the
dashboard. Equality does not prove host selection, ownership, health, intent, or removal authority.
All four classifications are report-only in the current service registry.

### SuggestedAction

Every finding carries a direct imperative, ordered procedure, expected impact, preservation
boundary, and a resource-specific reason when automation is blocked. The UI presents the imperative
in the ledger, keeps the procedure under **How to resolve**, and does not repeat safety-class enums
for report-only work. This is human guidance, not a provider operation. An action becomes
previewable only when a registered provider independently proves ownership, exact targeting,
verification, and rollback behavior.

### MaintenanceAction

An action binds one exact provider operation and target identity to expected before/after state,
safety class, rollback class, restart requirement, and verification contract. Commands and paths
are server-derived. A browser cannot submit either.

### MaintenancePlan

A plan is an immutable, five-minute selection of actions bound to current evidence, source
fingerprint, scope, safety class, and content-derived digest. It is not authorization and expires
when its evidence drifts.

The issue #198 <code>ak x skills plan</code> result is a read-only skill preview. It is useful
evidence but is not a MaintenancePlan or permission to mutate.

### ActionProvider

The resource-owner-specific provider contract is:

    detect -> findings/actionFor -> preflight -> apply -> verify
                                      |
                                      +-> inspectCurrent -> undo -> verifyUndo

Every stage can refuse or return incomplete evidence. A provider advertises only operations backed
by a verified host-native lifecycle or an exact, bounded agentic-kit-owned procedure. There is no
generic shell, recursive-delete, plugin-cache, or arbitrary-path provider.

### ActionCapability

The dashboard receives an opaque, in-memory, one-use authorization after confirmation. It binds the
session, HTTP verb, plan digest, action IDs, source fingerprint, scope, safety class, and expiry.
Only its hash remains server-side, and it is consumed before asynchronous provider work. A plan ID
is not this capability.

### TransactionReceipt

A receipt is owner-private durable evidence. It binds intent, policy, source fingerprint, fixed
operation, preimage, timestamps, result, verification, postimage, rollback class, and rollback
material. A zero native-command exit without a verified postcondition is failure or partial state,
not success.

Receipts also provide the current durable history shown by Maintenance. Public projections remove
paths, commands, diagnostics, and rollback material.

## Evidence and version policy

Installed/effective version, compatible candidate, producer/plugin version, source revision, cache
generation, content digest, and evidence health are independent. “Available” is not “latest”, and
“latest” is not automatically “recommended”.

An issue #198 entrypoint digest covers only one bounded capability entrypoint. Catalog v4 also
records a bounded full-definition digest over the observed regular files in a skill tree. Equality
can support a relationship classification, but it still does not prove host selection, ownership,
context loading, compatibility, or safe deletion. A full skill archive requires the stronger
<code>agentic-kit.skill-tree-ownership/v1</code> receipt and exact current tree match.

Version and provider claims are acquired only during an explicit Maintenance scan. The latest report
is persisted privately with its capture time, coverage, completeness, Catalog/source fingerprint,
and provider-evidence fingerprint. Plain report reads never invoke a provider. A stale or drifted
report cannot retain executable capabilities.

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

The default registry always installs Claude plugin, Codex plugin, Codex MCP, and Ruflo orphan
providers. It conditionally adds owned npx storage from an exact current collector candidate and
owned skills only when a composition root supplies complete receipt/root inputs. The stock
composition currently supplies none, so owned skill maintenance is report-only there.

## Transaction rules

Before any effect, the coordinator validates the unexpired plan and digest, resolves live provider
implementations, replans, checks current source state, and completes all preflights. It rejects
client commands/paths, traversal, globs, symlink escape, special files, and targets outside exact
roots.

Mutation is serial. The private integrity-sealed lock records machine, numeric UID, PID, creation
time, and nonce. A stale lock is reclaimed only on the same machine and current numeric UID when
its recorded PID is provably absent and a second check under an exclusive reclaim marker agrees.
Unknown liveness, remote machine, missing numeric UID, owner mismatch, bad modes, symlinks, or seal
failure leave the lock busy.

Providers use fixed operations, verify their postconditions, and then refresh the full deep
System/Footprint snapshot.
Failure stops dependent and not-yet-started work. Compensation runs in reverse order only when
declared. Undo requires a committed receipt, the same provider/version, a rollback-capable action,
an exact current postimage, and verified restoration.

## Interrupted transaction recovery

An uncertain outcome becomes recovery-required and blocks new mutations. Recovery is explicit:

    ak maintain recover --receipt ID --yes

Recovery never replays, retries, applies, undoes, or compensates. It asks every recorded
provider/version to inspect current state:

- all preimages can seal <code>recovered-no-change</code>;
- all verified postimages can seal <code>committed</code>;
- an interrupted undo whose preimages are restored can seal <code>rolled-back</code>; and
- a prepared journal with no dispatched outcome can seal <code>aborted-no-change</code>.

Mixed state, current drift, unavailable provider/version, incomplete inspection, or Catalog refresh
failure leaves <code>partial-recovery-required</code>. The dashboard displays that evidence but has
no recovery endpoint; the operator uses the CLI.

## Surfaces

The Maintenance view groups **Updates ready**, **Safe cleanup**, **Needs review**, **Unsupported or
blocked**, and **Recent changes / Undo**. Each ledger row exposes a direct action. Selection reveals
the potential effect, an optional **How to resolve** procedure, concrete preserved resources, the
resource-specific **Not available here** reason, and a bounded observed-copies table for
relationship findings. Resource, host, relationship, and
text filters compose. Failed reads remain visible with **Retry report**; they do not collapse into
blank panels. The view acts on one finding at a time and offers neither “Clean all” nor an aggregate
reclaimable claim across safety classes.

**Browser refresh** rereads the saved report. **Scan now** performs the exact
<code>?refresh=scan</code> provider measurement and replaces that report atomically. A successful
persisted System deep rescan chains one Maintenance scan, shared by concurrent callers.

The HTTP allowlist is exact:

    GET  /api/maintenance
    POST /api/maintenance/plans
    POST /api/maintenance/apply
    POST /api/maintenance/undo

POST uses the header token, Host/Origin/Sec-Fetch-Site checks, JSON-only exact schemas, and a 64 KiB
body limit. Apply and undo consume a one-use ActionCapability. All other dashboard routes retain
default non-GET rejection.

The CLI exposes:

    ak maintain scan [--deep] [--json]
    ak maintain plan [--findings ID,...] [--safety-class CLASS]
                     [--project PATH] [--executable] [--json]
    ak maintain apply --plan ID --digest SHA256 --actions ID,... --yes [--json]
    ak maintain undo --receipt ID --yes [--json]
    ak maintain recover --receipt ID --yes [--json]

Ordinary scan and plan are read-only. Executable planning derives actions from the current service
registry and persists a five-minute plan. Apply, undo, and recovery require explicit confirmation.
CLI batches must share provider, operation, safety class, and rollback class.

## Invariants and non-claims

- Installed does not mean enabled, effective, or loaded into model context.
- Registration does not mean configured, reachable, healthy, authenticated, or authorized.
- A source timestamp or unchanged cheap probe does not prove nested content unchanged.
- Equal full-definition digests prove only equality of the bounded observed files; they do not prove
  host selection, ownership, usage, intent, or safe deletion.
- Age or absence from observed usage does not prove stale, orphaned, or unused.
- A machine-wide count is not a project-specific context budget.
- Catalog and Advisory remain read-only even though Maintenance shares the System shell.
- Unsupported host operations remain visible limitations, never fabricated buttons.
- A receipt records and reconciles non-atomic provider effects; it does not make them atomic.
