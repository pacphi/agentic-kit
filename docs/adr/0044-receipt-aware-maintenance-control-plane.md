# ADR-0044 — Receipt-aware Maintenance control plane

- **Status:** Implemented
- **Date:** 2026-09-03
- **Updated:** 2026-09-03 — issue #200 delivered the control plane, bounded providers, dashboard
  action boundary, durable receipts, guarded undo, fail-closed interruption recovery, prescriptive
  relationship findings, and resilient dashboard loading
- **Deciders:** agentic-kit maintainers
- **Related:** [issue #198](https://github.com/pacphi/agentic-kit/issues/198),
  [issue #200](https://github.com/pacphi/agentic-kit/issues/200),
  [ADR-0005](0005-dashboard-in-page-routing-reveal.md),
  [ADR-0014](0014-dashboard-auth-and-remediation.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0025](0025-machine-footprint-metrics.md), and
  [ADR-0041](0041-host-neutral-hook-configuration-assurance.md)

## Context

Inventory alone does not help a person decide what to upgrade, disable, archive, remove, or
preserve. Safe assistance must explain evidence and impact, use the resource owner's real
lifecycle surface, verify the result, preserve a durable receipt, and stop when a premise is
uncertain.

Issue #198 supplied the read-only prerequisite. It closed through
[PR #201](https://github.com/pacphi/agentic-kit/pull/201), merged as <code>1bf0a5b</code>.
Regression coverage is in:

- <code>tests/kit/footprint-collectors.test.mjs</code>;
- <code>tests/kit/footprint-snapshot-v2.test.mjs</code>;
- <code>tests/kit/skill-maintenance-plan.test.mjs</code>; and
- <code>tests/ui/dashboard-ui.mjs</code>.

### Issue #198 verification

| Requirement | Verified result | Deliberate limit |
|-------------|-----------------|------------------|
| Separate standalone and plugin contributions | Catalog v3 keys plugin capabilities by kind, full plugin-at-marketplace producer, and logical name | Matching names do not prove ownership or equivalence |
| Preserve provider, version, and source scope | Occurrences retain host, surface, scope, project, path, producer/version/state, digest status, and evidence authority | Fallback evidence stays qualified |
| Relate overlaps | Exact logical-name, bounded entrypoint-digest, and bounded full-definition relationships are distinct from identity | Definition equality does not prove host selection, ownership, or safe removal |
| Explain project pressure | Project, user, and enabled-plugin contributions are separated by project and host | Presence does not prove model-context inclusion |
| Surface source drift | Deep snapshots retain bounded source stamps and cheap probes report changed sources | An unchanged probe is not a full-tree freshness proof |
| Provide a safe planning seam | <code>ak x skills plan --project PATH</code> previews without writes | Its content-derived ID is not mutation authority |
| Keep the dashboard consumable | Catalog uses bounded lists and a separate full-width project-pressure disclosure | Catalog remains a measurement view |

Maintenance applies a stricter rule: incomplete, drifted, symlinked, ambiguous, or otherwise
unprovable evidence cannot authorize an action. The bounded full-definition digest can classify a
relationship, but neither it nor the issue #198 entrypoint digest is a complete ownership receipt.

## Decision

Maintenance is a separate bounded context exposed as **System > Maintenance**:

> **System measures; Maintenance acts.**

Machine Footprint owns read-only inventory, pressure, freshness, and advisory candidates.
Integration Management owns lifecycle capability and ownership facts. Maintenance consumes both
through typed ports and owns findings, short-lived plans, provider policy, execution, verification,
undo, recovery, and receipts. Dashboard Delivery owns the HTTP and accessible interaction
boundary. Placement under System does not give a collector mutation authority.

The CLI and dashboard call the same application service. A client selects opaque finding, plan,
action, or receipt IDs; it never supplies a command, path, provider implementation, or policy
decision.

## Domain model

    Footprint evidence + Integration ownership + provider probes
                                |
                                v
                      MaintenanceFinding[]
                                |
                      select + refresh evidence
                                v
                       MaintenancePlan
                 immutable, short-lived, source-bound
                                |
          explicit confirmation + one-use ActionCapability
                                v
                 MaintenanceTransaction coordinator
                 preflight -> apply -> verify -> receipt
                                |
                 guarded undo or receipt reconciliation

- **MaintenanceFinding** is an evidence-backed condition, not an instruction. Its states are
  <code>current-healthy</code>, <code>update-available</code>,
  <code>stale-configuration</code>, <code>orphaned-cache</code>,
  <code>superseded-version</code>, <code>unsupported-incompatible</code>,
  <code>modified</code>, <code>ambiguous</code>, and <code>unreadable-partial</code>.
- **CapabilityRelationship** joins project and shared occurrences for one host, resource kind, and
  logical name. The implemented classifications are identical project copy, different definition,
  tracked project copy, and equivalent legacy transport. All are report-only in this decision.
- **SuggestedAction** is the recommendation, ordered procedure, expected impact, preservation
  boundary, and automation-blocking reason presented for every finding. It is guidance until a
  provider independently authorizes an executable action.
- **MaintenanceAction** binds one provider operation and target identity to impact, safety class,
  rollback class, restart requirement, and verification contract.
- **MaintenancePlan** is an immutable selection bound to evidence, source fingerprint, scope,
  expiry, and content-derived digest. Plans expire after five minutes and are not authorization.
- **ActionProvider** owns one bounded resource family. Its implemented contract is
  <code>detect -> findings/actionFor -> preflight -> apply -> verify</code>, with
  <code>inspectCurrent</code>, <code>undo</code>, and <code>verifyUndo</code> required where
  rollback is advertised.
- **ActionCapability** is an in-memory, one-use dashboard authorization bound to session, HTTP
  verb, plan digest, action IDs, source fingerprint, scope, safety class, and expiry. Only its hash
  is retained server-side, and it is consumed before provider work.
- **TransactionReceipt** is owner-private durable evidence of intent, policy, preimage, exact
  operation, outcome, verification, postimage, rollback material, and source identity. An
  unverifiable native success is not a committed transaction.

Installed/effective version, compatible candidate, producer/plugin version, source revision, cache
generation, digest, and capture health remain separate facts. The control plane does not translate
“available” into “latest” or “recommended”.

## Safety and rollback policy

| Safety class | Meaning |
|--------------|---------|
| <code>safe-automatic</code> | Exact ownership, current evidence, bounded operation, and verification support an executable proposal; human confirmation remains mandatory |
| <code>approval-required</code> | An exact action exists, but a person must accept preservation or impact risk |
| <code>upstream-required</code> | No safe local provider operation exists; explain the upstream workflow and expose no apply control |
| <code>never-automatic</code> | Authority or recovery is structurally insufficient; preserve the resource |

One transaction cannot mix safety classes. “Safe” never means background execution. Rollback is a
separate <code>reversible</code>, <code>compensating</code>, or <code>irreversible</code> fact.
Native marketplace, package, network, and process operations are not presented as
filesystem-atomic.

## Implemented provider matrix

| Provider | Executable operations | Fail-closed limits |
|----------|-----------------------|--------------------|
| Claude plugin | Native disable, enable as undo, update, and remove with preserved data | Update needs one exact host-reported candidate. Prune is unsupported. Update/remove are irreversible; all actions require restart. |
| Codex plugin | Native remove for an exact removal finding | No per-plugin update or disable verb is invented. Version candidates and ambiguous rows remain report-only. Removal is irreversible and requires restart. |
| Codex MCP | Native remove for an exact user-scope registration | Project-scope findings remain report-only. Registration is not configuration, reachability, health, authentication, or authorization. Removal is irreversible and requires restart. |
| Claude MCP | None | No Claude MCP provider is registered; findings remain report-only. |
| OpenCode plugin and MCP | None | Explicit unsupported providers keep these findings report-only. |
| Agentic-kit-owned skill | The conditional adapter can archive or prune under one exact ownership contract; its projected finding offers archive only | This adapter is not in the stock CLI/dashboard registry because no production receipt/root resolver supplies it yet. When composed explicitly, it requires exact roots and an <code>agentic-kit.skill-tree-ownership/v1</code> receipt covering the complete current tree. Symlinked, modified, partial, unreadable, ambiguous, unreceipted, user-owned, and plugin-cache targets are preserved. Archive is reversible and requires restart. |
| Agentic-kit stale npx environment | Clean | Offered only for a collector candidate tied to the bounded owned npx procedure, with complete bytes/files and exact root, owner, and shape checks. It is irreversible; transcripts and unrelated caches are not executable. |
| Ruflo MCP orphan | Terminate | Only a same-user, PPID-1, exact Ruflo MCP transport whose identity is rechecked before signalling. Numeric UID is required; Windows and unknown-UID cases stay report-only. No generic daemon kill exists. |

The default service registers Claude plugin, Codex plugin, Codex MCP, and Ruflo MCP orphan
providers. It adds the stale npx provider only for an exact current Footprint candidate and the
owned-skill provider only when complete receipt/root inputs are configured by the composition root;
the stock composition currently supplies none. The UI advertises only operations from that live
service registry.

## Transaction and recovery invariants

Every apply transaction:

1. validates a current plan, digest, exact action IDs, and explicit confirmation;
2. resolves the provider from the live registry, replans, and compares source state;
3. completes every preflight before the first effect;
4. rejects client paths/commands, traversal, globs, symlink escape, and special files;
5. serializes mutation behind an owner-private, integrity-sealed lock;
6. dispatches fixed provider operations, then verifies provider postconditions;
7. refreshes the full deep System/Footprint snapshot before reporting a verified effect; and
8. seals a private receipt for success, failure, partial, and recovery-required outcomes.

Failure stops dependent and not-yet-started actions. Compensation runs in reverse order only when
declared by the provider. Undo requires a committed receipt, the same provider/version, a rollback-
capable action, an exact current postimage, and verified restoration.

An uncertain dispatch is never retried or blindly rolled back. It blocks later mutations until a
human runs:

    ak maintain recover --receipt ID --yes

Recovery observes and reconciles; it never reapplies or undoes an action. Every entry must be
inspectable by the recorded provider/version, and all entries must agree wholly with their
preimages or verified postimages. Mixed, changing, missing-provider, inspection-failed, or
refresh-failed state remains <code>partial-recovery-required</code>. Provable no-change seals
<code>recovered-no-change</code>; complete postimage seals <code>committed</code>; verified undone
preimage seals <code>rolled-back</code>. A prepared journal with no dispatched outcome may seal
<code>aborted-no-change</code>.

The mutation lock may be reclaimed automatically only when its private, integrity-sealed owner
record proves this machine, the current numeric UID, and a PID proven dead, with a second identity
check under an exclusive reclaim marker. Remote-machine, tampered, malformed, symlinked,
wrong-owner, liveness-unknown, and UID-unknown locks remain busy.

## Dashboard boundary

The dashboard allowlist is exactly:

    GET  /api/maintenance
    POST /api/maintenance/plans
    POST /api/maintenance/apply
    POST /api/maintenance/undo

Every other route retains default non-GET rejection. POST requests require the per-session header
token, valid Host/Origin/Sec-Fetch-Site evidence, <code>application/json</code>, an exact schema, and
a body no larger than 64 KiB. The SSE query-token exception does not apply. The dashboard has no
recovery endpoint: it displays recovery-required evidence and directs the operator to the CLI.

The view groups **Updates ready**, **Safe cleanup**, **Needs review**, **Unsupported or blocked**,
and **Recent changes / Undo**. Every row exposes a suggested action; the selected finding adds its
ordered procedure, expected effect, preservation boundary, blocked-automation reason, and bounded
observed-copy evidence. It acts on one finding at a time, offers no cross-class batch or “Clean
all”, presents unknown evidence textually, and makes confirmation, progress, receipt, and undo
flows keyboard-accessible. A failed read keeps a visible **Retry report** recovery path. Dashboard
bootstrap retains its fragment token in page memory when browser storage is unavailable, preventing
authenticated content from degrading into blank panels.

## CLI contract

    ak maintain scan [--deep] [--json]
    ak maintain plan [--findings ID,...] [--safety-class CLASS]
                     [--project PATH] [--executable] [--json]
    ak maintain apply --plan ID --digest SHA256 --actions ID,... --yes [--json]
    ak maintain undo --receipt ID --yes [--json]
    ak maintain recover --receipt ID --yes [--json]

<code>scan</code> and ordinary <code>plan</code> are read-only. <code>--executable</code> derives
actions from the current provider registry and persists the short-lived plan. Apply, undo, and
recover require explicit confirmation. CLI batches must share provider, operation, safety class,
and rollback class.

## Consequences and non-claims

- People get one place to review maintenance pressure and act where authority is proven.
- Catalog, Advisory, and every Machine Footprint collector remain measurement-only.
- Durable receipts use private directories and files; public projections omit paths, commands,
  rollback material, and raw provider diagnostics.
- Some obvious-looking cleanup remains report-only when the host lacks a safe verb or evidence
  cannot authorize a change.
- Full-definition equality, Git tracking, and configuration equality support decision guidance but
  do not grant mutation authority.
- Apply and undo perform a full deep System/Footprint refresh, not the originally proposed
  smallest-slice refresh.
- Missing usage does not prove “unused”; age does not prove stale; registration does not prove
  runtime health; a version candidate is not a “latest” recommendation.
- Recovery proves current state and reconciles a receipt. It does not complete, compensate, or
  atomically transform an interrupted external operation.

## Alternatives considered

- **Put actions in Catalog or Advisory.** Rejected because measurement would gain mutation
  authority.
- **Infer deletion from age, name, digest equality, or cache location.** Rejected because none
  proves complete ownership, uniqueness, compatibility, or recoverability.
- **Relax dashboard POST generally.** Rejected in favor of four exact Maintenance routes.
- **Use a generic shell or filesystem provider.** Rejected because client-influenced targets would
  bypass lifecycle ownership and make verification ambiguous.

## Review triggers

Amend this decision when a host adds or removes a lifecycle verb, the ownership-receipt schema
changes, a provider needs network or elevated privilege, recovery gains a new provable state, or
before any background, bulk, destructive-history, trust-store, or third-party-cache mutation.
