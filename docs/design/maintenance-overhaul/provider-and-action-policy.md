# Provider and action policy

- **Design status:** Proposed
- **Governing decision:** [ADR-0048](../../adr/0048-inventory-led-maintenance-resource-management.md)
- **Safety floor:** [ADR-0044](../../adr/0044-receipt-aware-maintenance-control-plane.md)

This policy explains when Maintenance may offer an in-product operation, when it may offer sourced
steps, and when it must leave a verified condition in Inventory without assigning work to the user.

## Assistance levels

### Managed

Agentic Kit has a registered provider for one exact resource kind, operation, environment, scope,
provider version, target identity, impact, and verification contract. The UI may offer Preview and
Apply after current evidence, policy, and one-use capability checks.

`Managed` never means background, silent, safe in every environment, elevated, or batched.

### Guided

A signed/versioned built-in or provider recipe supplies a bounded procedure for the exact OS, host,
resource, package manager, shell, and version range. The user executes any command outside Agentic
Kit and returns to run the stated verification.

### Inventory evidence only

The resource and condition are verified, but Agentic Kit has neither a Managed operation, a trusted
procedure, nor a bounded decision. The resource remains visible. Guidance and navigation badges do
not include it, and the inspector says **No action is requested**.

An inferred condition cannot enter any of these levels as a primary claim.

## Guidance admission

| Lane | Required evidence | Primary interaction |
|---|---|---|
| Can apply here | Exact placement, condition, authority, impact, preflight, verification | Preview operation |
| Steps available | Exact placement and compatible signed/versioned recipe | Open procedure |
| Decisions to make | Exact placement and a bounded choice with consequences | Compare choices |
| Updates available | Installed version, candidate source, verified compatibility | Inspect candidate or procedure |
| Recovery to finish | Integrity-valid unfinished receipt or explicit integrity failure | Audit interruption |

Warning treatment additionally requires verified consequential impact and a bounded containment
choice. Guidance admission is about reducing work, not classifying every unfavorable observation.

## Action vocabulary

The candidate verbs are:

- update;
- disable;
- remove;
- repair registration;
- relink dependency;
- reinstall;
- clean cache;
- restore;
- snooze; and
- acknowledge.

Only contextually relevant verbs appear. Buttons name the target kind, such as **Remove MCP
registration** or **Disable Claude plugin**. `Fix`, `Repair all`, `Clean all`, and generic `Review`
are prohibited.

## Managed operation contract

Every Managed action retains the implemented sequence:

```text
detect -> finding/action candidate -> plan -> preflight -> apply -> verify -> receipt
                                                        \-> undo when independently supported
```

Before effect, the service must prove:

1. exact provider and provider version;
2. exact placement and server-derived target;
3. current ownership or native lifecycle authority;
4. current source fingerprint and evidence completeness;
5. operation compatibility with OS, host, scope, and installed version;
6. complete affected-consumer preview when the target is shared;
7. rollback, restart, privilege, network, and irreversibility disclosure;
8. all preflights completed after confirmation; and
9. one unexpired, session-bound, one-use action capability.

The browser supplies only opaque IDs and confirmation. It never supplies a command, path, package,
provider implementation, policy, or executable.

No destructive or write action batches in either CLI or UI. Read-only detection, scan, query,
preview acquisition, and interruption audit may batch while retaining independent results.

## Existing providers

ADR-0044's narrowly proven providers remain eligible under their exact current contracts. Migration
cannot broaden their resource kinds, scopes, verbs, targets, or rollback claims. A provider appears
in the new UI only after its existing conformance tests pass against the new placement and Guidance
projection.

Internal provider refusal codes remain available for deterministic control flow and diagnostics.
They are translated to a factual explanation or omitted from Inventory; they never render as an
`Unknown` or `Unsupported` resource label.

## Missing dependencies

For a verified missing dependency such as an MCP registration whose configured executable is not
present, Guidance treats these as separate possible outcomes:

1. **Repair command path** — change the exact registration to a verified executable placement;
2. **Relink dependency** — bind to another verified compatible dependency;
3. **Reinstall dependency** — follow a source-bound package-manager procedure; and
4. **Remove registration** — remove only the exact host/scope registration.

No option is preferred without named authority. Command configuration may be inspected, but
environment variable values, credentials, account identifiers, and private endpoints remain
redacted.

## Package-manager coverage

Launch procedure coverage includes:

- Homebrew and MacPorts;
- apt, dnf, pacman, zypper, and Snap;
- npm/npx, pnpm, Yarn, and Bun;
- pip, pipx, and uv;
- Cargo;
- mise and asdf; and
- WinGet, Chocolatey, and Scoop.

Minimum capability means the adapter can independently provide, where the manager supports it:

1. manager detection and exact executable identity;
2. installed manager version and tested contract range;
3. installed resource version;
4. package or source provenance evidence;
5. dependency and reverse-dependency evidence;
6. a source-bound candidate comparison;
7. a typed copyable procedure; and
8. a verification procedure.

These capabilities do not authorize general package installation or upgrade execution in v1.

### N-3 interpretation

- Standalone semantic-versioned managers: current major plus three preceding majors.
- OS-coupled managers: current plus three preceding supported OS release families.
- Rolling managers: capability-tested command contracts with a documented minimum version.

Detected versions outside the tested contract remain Inventory facts. Procedures and actions whose
compatibility cannot be verified are omitted.

## Guided procedure contract

A procedure contains typed fields rather than an arbitrary shell string:

```text
ProcedureRecipe
  recipeId
  recipeVersion
  publisher
  signatureChain
  contentDigest
  sourceAuthority
  osAndVersionRange
  architecture
  hostAndVersionRange
  resourceKind
  packageManagerAndRange
  shell
  operation
  typedArguments
  expectedEffect
  preservedResources
  verification
  privilegeRequirement
  networkRequirement
  invalidationInputs
```

The renderer supports bash, zsh, PowerShell, cmd.exe, and the selected WSL shell. A preferred shell
is stored per environment and can be changed in the panel. Rendering escapes only typed trusted
fields; discovered untrusted text never becomes executable syntax.

The procedure shows source, expected effect, verification command, and privilege before Copy. It
never executes automatically. A persistent checklist retains completed steps; partial success shows
the next grounded steps.

Elevated procedures remain offline user work in v1. Maintenance explains how to open an elevated
terminal using a built-in or provider recipe and never solicits or handles a password.

## Recipe refresh and trust

Built-in and provider recipes are signed/versioned release content. A later allowlisted registry
refresh is explicit and must:

1. fetch from provider-fixed HTTPS authority;
2. verify signature chain and publisher identity;
3. verify content digest and schema;
4. enforce response and redirect bounds;
5. compare old and new recipes;
6. show the diff; and
7. require acceptance before activating any new operation, target breadth, network behavior, or
   privilege requirement.

Withdrawn recipes remain visible in Activity and historical receipts but cannot create new
Guidance. An accepted recipe never gains Managed authority unless a separate provider capability
proves it.

## Managed cache cleanup

An Apply cleanup button is eligible only when:

- the owning tool defines the target as one cache lifecycle object;
- the provider resolves one exact target under an exact root;
- current ownership and real-path containment are proven;
- named roots and targets are not symlinks or special nodes;
- file and byte impact is complete and previewable;
- the source fingerprint is revalidated after confirmation;
- the resource is reproducible and redownload/offline effects are disclosed;
- no elevation is required;
- the provider removes only the declared target; and
- absence is verified and receipted.

An aggregate cache action is allowed only when the package manager itself defines the whole cache
as one lifecycle object and the preview proves complete impact. Otherwise the root is a summary and
actions target individually verified children. General package-manager caches remain Guided until
an independent provider satisfies this contract.

## Git-aware project patches

A project write requires:

- an exact repository/worktree placement;
- a bounded patch preview with copy support;
- Git status and affected-path fingerprints;
- unrelated dirty paths permitted;
- affected-path, index, worktree, submodule, symlink, or source drift refused;
- no stash, commit, branch creation, push, or merge;
- atomic or guarded file replacement with exact preimages;
- syntax/schema validation and declared project checks;
- local apply only after separate confirmation; and
- a receipt with guarded restoration where current state still matches.

The UI gives stage-by-stage feedback: previewed, preflighted, applying, validating, verified, or
recovery to finish.

## Shared dependencies

A shared runtime, executable, provider configuration, credential mechanism, model, or storage
placement may be Managed only when every affected consumer in the relevant environments is
verified and shown. A partial consumer graph can support a factual dependency and Guided procedure,
but never a complete blast-radius claim or Managed shared change.

No dependency action recursively executes dependent actions. Each write is separately planned,
confirmed, verified, and receipted.

## Managed model removal

Exact provider-owned model removal is eligible when all of these are verified:

- provider, local model identity, digest or revision, and environment;
- provider-native remove verb and tested provider version;
- no active download, generation, or loaded runtime use that the provider reports as unsafe;
- configured routes and every other verified consumer;
- logical model size and physically reclaimable bytes, including shared-blob accounting;
- exact one-model target;
- no privilege elevation or implicit host/WSL crossing;
- provider absence postcondition; and
- irreversible removal and redownload consequences.

Removal is one model per action. Model download, pull, update, migration, and channel change remain
Guided in v1 because they add network, compatibility, storage, and interruption concerns not proven
by the removal contract.

## Credentials and provider configuration

Credential readiness is represented as **Not configured**, **Configured but not checked**,
**Ready**, **Check failed**, or **Expired or renewal needed**. Passive discovery checks only the
mechanism's presence and safe permissions. Authentication validity is an explicit provider probe.

The UI may name a mechanism such as an environment variable, keychain entry, credentials file, or
host login. It never exposes values, token metadata, account email, private registry URL, or raw
configuration. Provider configuration uses exact placement rows grouped under the logical provider.

## WSL and cross-environment actions

Each WSL distribution has its own package managers, shells, paths, providers, resources, and
receipts. Windows host relationships are explicit dependency or consumer edges. An action planned
for Windows cannot execute in WSL, and a WSL action cannot touch a Windows placement, unless a
future independently approved cross-environment provider defines that exact operation.

## Interruption audit and reconciliation

This is a presentation and contract split over existing implementation evidence, not a generic
forensics heuristic. The current `src/lib/maintenance/recovery-coordinator.mjs` already requires the
recorded provider/version, calls its `inspectCurrent`, and compares an exact current fingerprint
with recorded preimages or verified postimages without replaying an action. The current
`src/lib/maintenance/transaction-store.mjs` already integrity-seals owner-private receipts. ADR-0048
separates read-only inspection from the write that records a conclusive result and makes the audit
evidence visible.

### Audit interruption

The audit verifies receipt integrity, reads the last durable phase, loads the exact recorded
provider version, discloses its checks, and calls only its read-only current-state inspector. A
provider-authored executable probe is allowed only after explicit disclosure; network remains a
separate consent.

The audit compares current evidence with the recorded preimage and verified postimage. It never
retries, reapplies, rolls back, compensates, or completes the resource operation.

### Record verified outcome

A conclusive audit enables one separately confirmed receipt write:

- **Record no change** when the journal proves no dispatch or the preimage matches;
- **Record completed** when the verified postimage matches; or
- **Record restored** when an interrupted undo matches the recorded preimage.

Read-only audits may batch, but these writes are individual. Audit results remain exportable before
reconciliation.

### Non-conclusive audit

The UI names the completed checks and failed comparison without using Unknown or Unsupported. It
offers only a matching provider-authored next step. When none exists, it says **No corrective action
is offered** and keeps the receipt open.

An unresolved receipt blocks its placement, environment, and verified dependents. Unrelated
environments remain writable. An integrity-failed receipt keeps the broader fail-closed block
because its target and phase cannot be trusted.

## Dispositions

- **Acknowledge** records intentional awareness; it does not hide the resource.
- **Snooze** removes one Guidance entry until a stated expiry.
- **Ignore exact candidate** applies only to the same candidate identity.

Expiry, candidate change, installed-version change, dependency change, source-fingerprint drift,
or security-severity increase invalidates the disposition. Rescans may therefore resurface a
snoozed item. Every disposition explains this before confirmation and remains visible in Activity.

## Provider conformance evidence

Every `(provider, provider version, resource kind, operation, OS/version family, host/version,
scope)` tuple is admitted independently. Conformance includes:

- positive and refusal paths;
- target and ownership drift;
- symlink, special-node, traversal, and permissions cases;
- incomplete consumer and dependency graphs;
- interruption before dispatch, during effect, during verification, and during catalog refresh;
- postcondition mismatch;
- idempotent audit and receipt reconciliation;
- redaction and export checks; and
- source-bound compatibility fixtures for the N-3 policy.

Registration, discovery, or a passing manifest schema never proves configuration, reachability,
health, authorization, or operation authority.
