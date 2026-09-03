# ADR-0044 — Receipt-aware Maintenance control plane

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** agentic-kit maintainers
- **Related:** [issue #198](https://github.com/pacphi/agentic-kit/issues/198),
  [issue #200](https://github.com/pacphi/agentic-kit/issues/200),
  [ADR-0005](0005-dashboard-in-page-routing-reveal.md),
  [ADR-0014](0014-dashboard-auth-and-remediation.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0025](0025-machine-footprint-metrics.md), and
  [ADR-0041](0041-host-neutral-hook-configuration-assurance.md)

> **Implementation status:** this ADR accepts a target architecture. Issue #200 tracks delivery.
> No Maintenance mutation route, command, provider, capability, or receipt described here should
> be read as shipped until its implementation and tests land.

## Context

People do not merely want an inventory of their agent resources. They want help deciding what to
upgrade, disable, archive, remove, or preserve, and they need the system to explain the evidence,
consequences, recovery path, and unresolved uncertainty before it acts.

Issue #198 established the read-only prerequisite. Its merged Catalog v2 work provides canonical
standalone and plugin-qualified identities, plugin-to-capability relationships, source scope,
provider and version facts, bounded entrypoint digests, source-probe drift, project capability
pressure, and `ak x skills plan` as a non-mutating preview. The dashboard now gives the host
profile and cross-host catalog bounded viewports, with project pressure in a separate full-width
section. This is sufficient to close #198 independently of this decision.

### Issue #198 prerequisite verification

The accepted look-back is against merged
[PR #201](https://github.com/pacphi/agentic-kit/pull/201). “Complete” below means complete for the
read-only contract, never proof that an action is safe.

| #198 requirement | Verified evidence | Outcome |
|------------------|-------------------|---------|
| Distinguish standalone and plugin contributions | CatalogInventory v2 keys plugin contributions by kind, full `plugin@marketplace` producer, and logical name | Complete |
| Retain provider/version/source scope | Occurrences carry host, surface, scope, project, path, provider/version/state, digest status, and evidence authority | Complete; fallback evidence stays qualified |
| Relate overlapping capabilities | Exact logical-name and bounded entrypoint-digest relationships are explicit and separate from identity | Complete; equality is not ownership |
| Explain project pressure | Project, user, and enabled-plugin contributions are separated per project and host | Complete; context inclusion stays unknown unless a host proves it |
| Surface source drift | Deep snapshots retain bounded source stamps and cheap probes report changed-at-probes | Complete; unchanged probes are not full-tree freshness |
| Provide a safe planning seam | `ak x skills plan --project <path>` classifies and previews without writes | Complete; its plan ID is not authorization |
| Make the dashboard consumable | Host profile and cross-host records use bounded viewports; project pressure has a separate full-width disclosure | Complete |

Maintenance adds a stricter consuming rule: incomplete, dirty, drifted, symlinked, or otherwise
unreproducible evidence cannot authorize apply. That is control-plane hardening, not a reason to
reopen #198's non-authorizing preview contract.

That foundation deliberately does not grant mutation authority. In particular:

- equal logical names do not identify the same owned artifact;
- an entrypoint digest covers only the bounded `SKILL.md` or command entrypoint, not a skill's
  supporting scripts, references, or assets;
- cache presence, age, and location do not prove that a resource is orphaned;
- registration does not prove configuration, reachability, health, authentication, or
  authorization;
- an absent usage observation does not prove that a resource is unused; and
- an immutable-looking plan identifier is evidence identity, not user authorization.

The existing Dashboard rejects non-GET requests. Machine Footprint and its System views are
read-only by design. Adding buttons by relaxing either boundary would combine observation,
authorization, and execution in one unsafe step.

## Decision

Create **Maintenance** as a separate bounded context and expose it as a new secondary destination
under the dashboard's **System** area. Preserve the rule:

> **System measures; Maintenance acts.**

Machine Footprint continues to own read-only measurement, catalog inventory, project pressure,
and advisory candidates. Integration Management continues to own lifecycle capabilities and
ownership facts. Maintenance consumes those facts through explicit ports; it owns findings,
plans, action policy, execution coordination, verification, undo, and transaction receipts. The
System shell is placement, not domain ownership.

The CLI and dashboard use the same Maintenance application service. Presentation may select and
confirm actions, but it cannot construct an executor command, filesystem target, policy result, or
stronger evidence claim.

## Domain model

```text
Footprint evidence + Integration ownership + Provider capability probes
                              |
                              v
                    MaintenanceFinding[]
                              |
                    select + refresh evidence
                              v
                       MaintenancePlan
                 (immutable, short-lived, source-bound)
                              |
          explicit confirmation + one-use ActionCapability
                              v
                 MaintenanceTransaction coordinator
                 preflight -> apply -> verify -> receipt
                              |
                    guarded undo, when available
```

- **MaintenanceFinding** is an evidence-backed condition, not an action. Its states are
  `current`, `update-available`, `stale-configuration`, `orphaned-cache`,
  `superseded-version`, `unsupported`, `incompatible`, `modified`, `ambiguous`, and
  `unreadable-or-partial`. It retains source, capture time, completeness, ownership, affected
  consumers, and missing evidence.
- **MaintenanceAction** names one exact provider operation, target identity, expected impact,
  safety class, rollback class, restart requirement, and verification contract. It never carries
  browser-supplied argv or a browser-supplied path.
- **MaintenancePlan** is an immutable, short-lived aggregate of selected action IDs. It binds the
  finding evidence, exact source fingerprint, scope, projected result, safety class, expiry, and
  content-derived plan digest. It is not authorization.
- **ActionProvider** is a capability-aware port for one resource owner or host. It advertises only
  operations backed by an implemented native lifecycle or an exact agentic-kit-owned procedure.
  Its contract is `detect -> propose -> preflight -> apply -> verify -> undo`, with an explicit
  unsupported result at every stage.
- **ActionCapability** is an ephemeral, one-use authorization minted server-side for a current
  selected plan and presented only through the confirmation flow. It binds the dashboard session,
  plan digest, selected action IDs, source fingerprint, scope, safety class, and expiry. It is
  distinct from a plan and from a durable receipt.
- **TransactionReceipt** is owner-only durable evidence of intent, policy decision, preimage or
  native before-state, fixed operation, timestamps, result, verification, postimage or native
  after-state, rollback material, and source identity. A successful command without successful
  verification is not a successful transaction.

Version evidence remains multi-dimensional. Installed/effective version, recommended compatible
version, producer/plugin version, marketplace or source revision, cache generation, content
digest, and evidence capture health are separate fields. “Latest” never means “recommended”
without compatible provider policy.

## Human workflow and presentation

The shared workflow is:

```text
scan -> recommendations -> select -> preview impact -> confirm
     -> apply -> verify -> receipt/undo
```

The System > Maintenance view groups findings under **Updates ready**, **Safe cleanup**,
**Needs review**, **Unsupported or blocked**, and **Recent changes / Undo**. Every recommendation
answers what the resource is, who owns it, why it is present, what depends on it, what will change,
whether restart is required, how rollback works, and how fresh and complete the evidence is.

Use plain-language states such as **Ready to apply**, **Review required**, and **Cannot safely
automate**. Do not add a hygiene score, combine unlike safety classes into one reclaimable total,
or offer “Clean all”. Native dialogs must manage initial and restored focus, keep confirmation
explicit, announce transaction progress and results through an appropriate status region, expose
unknown and degraded evidence textually, and make receipts and undo usable from a keyboard.

## Safety and rollback classifications

Keep the existing action safety vocabulary:

- **safe-automatic eligible** — ownership, current-state evidence, provider operation, and
  verification are strong enough for the system to propose the action;
- **approval-required** — the system can prepare an exact action but a human must resolve impact
  or preservation risk;
- **upstream-required** — no safe local provider operation exists; show a verified native command
  or upstream workflow instead of an apply control; and
- **never-automatic** — evidence or recovery is structurally insufficient.

“Eligible” never means background execution. Dashboard mutations always require a deliberate
selection and confirmation. One transaction cannot mix safety classes.

Track rollback separately as **reversible**, **compensating**, or **irreversible**. A filesystem
rename backed by a validated preimage can be reversible. Marketplace refreshes, package
installations, network operations, and process termination are not filesystem-atomic; their
provider may offer only compensating recovery or no undo at all, and the UI must say so before
confirmation.

## Initial provider boundary

The first executable release uses the smallest provider set that can rely on existing lifecycle
surfaces:

| Provider | Initially actionable | Explicit limitation |
|----------|----------------------|---------------------|
| Claude plugin | Native enable, disable, update, uninstall, and prune operations proven by the installed CLI | Plugin cache children are never direct targets |
| Codex plugin | Native remove and marketplace-upgrade operations proven by the installed CLI | Do not invent per-plugin update or disable; marketplace upgrade is not called a plugin update without post-scan evidence |
| OpenCode plugin | Nothing; findings and upstream guidance only | No safe native plugin lifecycle manager was proven at decision time |
| Claude/Codex MCP | Native removal with topology checks before and after | Registration remains distinct from configuration, reachability, health, authentication, and authorization |
| OpenCode MCP | Nothing; findings and upstream guidance only | No safe native removal verb was proven at decision time |
| Agentic-kit daemon | The existing identity-proven Ruflo MCP orphan procedure | No generic process termination; identity is reacquired immediately before the signal |
| Agentic-kit-owned projection | Deferred until an exact ownership receipt includes a complete current tree manifest | Today's entrypoint-only digest cannot authorize deleting a skill directory |
| Agentic-kit cache | Deferred until an exact owner-native or bounded agentic-kit procedure exists per cache | Age, path, and reproducibility claims alone are insufficient |

A capability probe or a pinned built-in provider contract may establish that a native verb exists.
The matrix records verified capabilities on the decision date; runtime probing and provider tests
must narrow it when an installed host version differs. The UI renders an action only when the
relevant provider advertises it for that exact resource. There is no generic shell provider,
recursive-delete provider, or “best guess” host adapter.

Plugin-provided skills, commands, agents, and MCP servers are managed through their marketplace-
qualified plugin owner. Updating or removing a plugin is followed by a fresh native inventory and
an affected Catalog slice rescan before success is reported. Standalone skills may not become
automatically removable until ownership receipts cover the complete bounded tree, not just the
entrypoint. Historical transcripts remain unique data and review/archival-only. Pinned runtimes
remain review-only until known project pins have been checked.

## Transaction invariants

Every mutating transaction must:

1. validate a current, unexpired plan and exact selected action IDs;
2. compare the plan's source fingerprint with a newly acquired source fingerprint;
3. complete every action's preflight before the first mutation;
4. perform a live evidence and ownership re-audit immediately before apply;
5. reject globs, traversal, symlink escape, special files, client paths, and client commands;
6. select fixed argv arrays from the server-side provider registry;
7. serialize overlapping mutations and persist an interrupted-transaction journal;
8. verify native inventory and the smallest affected Catalog slice after every action;
9. write a private receipt for success, failure, and partial/compensating outcomes; and
10. permit undo only when current state still matches the receipt's recorded postcondition.

Failure stops dependent and not-yet-started actions. The receipt preserves completed outcomes and
the coordinator applies only provider-declared compensation. It must not describe multiple native
operations as atomic when they are not.

## Dashboard mutation boundary

ADR-0014's token, Host, Origin, Sec-Fetch-Site, no-store, CSP, and loopback protections remain.
The implementation may add only these allowlisted route shapes:

- `GET /api/maintenance`
- `POST /api/maintenance/plans`
- `POST /api/maintenance/apply`
- `POST /api/maintenance/undo`

The existing blanket non-GET rejection stays the default for every other route. Maintenance POST
requests are JSON-only with bounded schemas and bodies. They require the per-session dashboard
token in its header form; the SSE query-token exception does not apply. Apply and undo additionally
require an unexpired one-use ActionCapability. Existing Host, Origin, and Sec-Fetch-Site checks run
before parsing the body. No endpoint accepts arbitrary commands, paths, provider IDs, or action
descriptions from the browser.

## CLI target contract

The planned command family is:

```text
ak maintain scan [--deep] [--json]
ak maintain plan [--project <path>] [--json]
ak maintain apply --plan <id> --actions <id,...> --yes
ak maintain undo --receipt <id> --yes
```

`scan` and `plan` are read-only. `apply` and `undo` require explicit confirmation even outside the
dashboard and call the same plan, provider, verification, and receipt services. CLI availability is
not implied by accepting this ADR.

## Delivery and dependency order

1. Lock the #198 read model and make incomplete, dirty, or drifted evidence fail closed.
2. Add read-only findings and Maintenance plan generation over typed evidence ports.
3. Extract a host-neutral transaction coordinator from hook remediation without weakening that
   context's existing invariants.
4. Add and test host-native plugin and MCP providers, advertising only proven verbs.
5. Extend agentic-kit ownership receipts with complete tree manifests before adding projection
   archive/removal.
6. Adapt the existing identity-proven daemon procedure and add cache providers only where an exact
   owner-native or bounded agentic-kit procedure exists.
7. Add the System > Maintenance read model, then the narrowly allowlisted action routes and
   accessible confirm/progress/receipt interactions.
8. Verify convergence, interruption recovery, guarded undo, and provider limitations end to end.

Each slice must remain useful and safe if later slices do not ship. Read-only findings may name an
upstream workflow without offering an executable action.

## Consequences

- Users gain one place to understand maintenance pressure and act where authority is proven.
- Machine Footprint collectors and existing System measurement routes remain non-mutating.
- Dashboard delivery gains a deliberately narrow mutation exception, increasing the security and
  accessibility test burden.
- Some apparently obvious cleanup remains report-only. This is an intentional product result, not
  incomplete UI, when the host lacks a safe operation or the evidence cannot authorize change.
- Full-tree ownership receipts become a prerequisite for skill-directory removal; current
  entrypoint digests remain valuable relationship evidence but cannot be promoted into ownership.
- External lifecycle operations may be compensating or irreversible and are never presented as
  atomic filesystem transactions.

## Alternatives considered

- **Keep all remediation in copyable shell commands.** Rejected as the final architecture because
  it cannot provide a shared verified transaction and receipt experience, though it remains the
  honest fallback for upstream-required actions.
- **Add actions directly to Catalog or Advisory.** Rejected because it would give a measurement
  context mutation authority and blur inventory evidence with lifecycle ownership.
- **Infer deletion from age, name, digest equality, or cache location.** Rejected because none of
  those facts proves ownership, uniqueness, compatibility, or recoverability.
- **Relax the dashboard's non-GET guard generally.** Rejected because only four exact Maintenance
  routes require mutation, and every other route should retain the safer default.
- **Implement a generic filesystem or shell provider.** Rejected because client-influenced paths
  and commands would bypass the resource owner's lifecycle and make verification ambiguous.

## Review triggers

Amend this decision when a host adds or removes a supported lifecycle verb, when ownership receipt
schema changes, when an action needs network or elevated privileges, when a new rollback class is
required, or before any background, bulk, destructive-history, trust-store, or third-party cache
mutation is proposed.
