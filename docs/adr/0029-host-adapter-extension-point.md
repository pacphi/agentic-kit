# ADR-0029 — Host adapters as a published extension point

- **Status:** Proposed
- **Date:** 2026-08-11
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0017](0017-opencode-host.md), [ADR-0018](0018-generalized-host-worker-execution.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md)
- **Product proposal:**
  [Host adapters as a published extension point](../HOST-ADAPTER-EXTENSION-PROPOSAL.md)
- **First consumer:** [ADR-0030](0030-hermes-reference-adapter.md)

## Context

ADR-0016 replaced hardcoded host lists with a capability registry; ADR-0017 proved the shape by
adding a third host; ADR-0018 generalized execution behind a host-neutral lifecycle. The result is
that **the contracts an agent CLI must satisfy are already written down and already enforced**:

| Contract | Validator | Location |
|---|---|---|
| Host descriptor | `validateHostAdapter` | `src/lib/adapters/registries.mjs` |
| Projection / observability | `validateProjectionAdapter`, `validateObservabilityAdapter` | same |
| Cross-axis invariants | `validateRegistries` | same, run at construction |
| Configuration lifecycle | `validateLifecycleAdapter` (`detect`/`plan`/`apply`/`verify`/`undo`) | `src/lib/adapters/lifecycle.mjs` |
| Ownership + teardown | `ownership`, `mayUndo`, `undoOwnedValues` | `lifecycle.mjs`, `ownership.mjs` |
| Worker execution | `validateExecutionAdapter` (8 methods), `validateWorkerResult` | `src/lib/execution/schema.mjs` |
| Normalized facts | `normalizedFacts` (`schemaVersion: 1`, provenance-bearing) | `src/lib/adapters/facts.mjs` |
| Guidance rows | `registry(customBlocks)` — already user-extensible via kit.json | `src/lib/blocks.mjs` |

Adoption is real, not aspirational. `OPENCODE_LIFECYCLE_ADAPTER` implements the full five-verb
contract, and both `src/commands/sync.mjs` and `src/commands/x/host.mjs` already drive it through
the generic `runLifecycle` rather than through opencode-specific dispatch. A reusable
`createSubprocessExecutionAdapter` already factors what Claude and Codex share.

What is **not** generic is the last mile. Adapter *selection* is a module import of a named constant
(`runLifecycle({ adapter: OPENCODE_LIFECYCLE_ADAPTER, … })`), and `src/commands/status.mjs`
hand-rolls a per-host block that imports eight functions directly from `src/lib/opencode.mjs`. So
every new host still costs edits across `setup`, `sync`, `status`, `uninstall`, `x/host`,
`providers`, `versions`, `nudge`, and the footprint collectors — even though the contracts those
edits satisfy are already specified.

That last mile is what makes a fourth host an ask rather than a plug-in. A host maintained by
someone who does not maintain agentic-kit currently has two options, both bad: land in-tree and
become the maintainer's permanent obligation for a CLI they may not run, or fork and drift on every
upstream refactor.

## Decision

### 1. Publish the adapter contract; do not absorb hosts one at a time

An **out-of-tree host adapter** is a node module exporting a single manifest, validated by the
validators that already exist:

```js
export const akHostAdapter = {
  contract: 1,
  host,               // → validateHostAdapter
  projections: [],    // → validateProjectionAdapter
  observability: [],  // → validateObservabilityAdapter
  lifecycle,          // → validateLifecycleAdapter
  execution,          // → validateExecutionAdapter (required iff canRouteActivities)
  guidance: [],       // → block registry rows, the existing customBlocks shape
};
```

The contract is not new surface area invented for this ADR. It is the set of interfaces ADR-0016 and
ADR-0018 already defined, made **reachable** — exported from a stable entrypoint and admitted at
runtime rather than only at module-construction time.

### 2. Discovery is explicit registration, never a naming convention

Adapters are named in `kit.json`:

```json
{ "hostAdapters": [ { "id": "hermes", "module": "@example/ak-host-hermes" } ] }
```

Scanning `npm root -g` for an `ak-host-*` prefix is **rejected**. It would make an unrelated
`npm install` sufficient to get third-party code executed inside ak on the next `ak status` — the
precise fail-open pattern ADR-0023 exists to prevent. Registration is a deliberate act, recorded in
the user's own config, and removable by editing one array.

### 3. Third-party code runs with ak's privileges; ak discloses rather than pretends

ak cannot sandbox an in-process node module, and this ADR does not claim otherwise. Instead:

- Host trust manifests gain a `third-party-adapter` change kind. Before any mutation, the manifest
  names the package, its **resolved path**, and its version — the same pre-disclosure surface
  ADR-0023 already requires for approvals and MCP registrations.
- ADR-0018's trust-boundary contract is restated at registration: an adapter is code you are
  choosing to run with your user privileges, exactly like the repositories `ak run` operates in.

A subprocess/RPC adapter protocol would be genuinely sandboxable and language-agnostic, and is
**deferred, not dismissed** — re-specifying the eight-method execution lifecycle and the five-verb
configuration lifecycle as a wire protocol is a much larger commitment than this ADR should make
before a second adapter exists to generalize from.

### 4. External adapters are capability-capped

The loader refuses an adapter that declares `canBePrimary: true`, a non-null `aqeProvider`, or
`commandStatusline: true`, and never auto-seeds its routes.

This is not distrust; it is that those three surfaces carry **first-party obligations** ak cannot
discharge for code it does not ship — primary-host mirroring (ADR-0006), AQE provider projection,
and statusline rendering all require ak-side behavior keyed to a specific host. The cap is exactly
the shape OpenCode already occupies, so it is a tested configuration rather than new policy. An
external host may be `canDriveSession` and `canRouteActivities`; those are contract-satisfiable.

### 5. Loading is fail-closed per adapter, not per process

First-party registries throw at construction, deliberately: a broken built-in is a build error.
A broken **third-party** adapter must not be able to brick `ak status` for the hosts that work.

Each adapter is validated in isolation. A failure — bad contract version, failed validator, module
that will not import — is reported with the package name, the failing path, and the validator's own
error, and that adapter alone is skipped. Every other subsystem continues and says so, per
ADR-0023's explicit-degradation rule. A refused adapter never leaves partial wiring behind, because
nothing is applied before admission.

### 6. `contract: 1`, and no stability promise while the package is alpha

The manifest carries an integer contract version. A mismatch is refused with a message naming both
the adapter's version and ak's, rather than being coerced.

Stated plainly, because publishing an extension point implies an obligation that is easy to acquire
by accident: **while `@pacphi/agentic-kit` is `4.0.0-alpha.*`, this surface is unstable and may
change between alphas.** Adapter authors track alphas or pin. A semver-stable commitment is a
separate, later decision, made when there is evidence about what actually needs to change.

### 7. What each side owes

| ak owes | The adapter owes |
|---|---|
| Registry admission + validation | `detect`/`plan`/`apply`/`verify`/`undo` |
| Driving the lifecycle (`runLifecycle`) | Its host's own config writing, backup-first and merge-not-clobber |
| Command wiring: setup, sync, status, uninstall, `host pick` | An execution adapter if it claims `canRouteActivities` |
| Guidance reconciliation via existing block rows | Guidance block templates in its host's idiom |
| Trust disclosure before mutation | Honest capability declarations |
| Calling `undo` on teardown | Ownership receipts via `ownership`/`mayUndo` |
| The contract, its version, and its tests | Its own tests, and its host's correctness |

### 8. The in-tree work this requires

Three changes, each independently useful even if no external adapter ever ships:

- **Adapter selection becomes registry-driven.** `sync` and `x/host` resolve the lifecycle adapter
  from the registry by host id instead of importing a named constant. The driver is already
  generic; only the lookup changes.
- **`status` renders hosts from `normalizedFacts`.** A lifecycle adapter's `detect` already returns
  facts in a versioned, provenance-bearing schema. Rendering from that schema replaces the
  hand-wired per-host block, which is the only reason `status.mjs` imports host internals at all.
- **A fixture adapter in `tests/`** exercises admission, capability caps, contract-version refusal,
  per-adapter isolation, and teardown — so the extension point is proven in-tree, with no external
  package required for CI.

`install.npmPackage` must also become genuinely optional: `src/lib/footprint/install.mjs` calls
`npmRoot(host.install.npmPackage)` unguarded, and a host installed by pip, uv, or a vendor script
has none.

## Consequences

- The maintenance split inverts. agentic-kit owns a small versioned contract, a loader, and a
  fixture adapter. Host-specific correctness — a config format ak never parses, a CLI ak never
  spawns, a vendor's release cadence — belongs to whoever wants that host, and their breakage is
  their breakage.
- ADR-0017's per-host cost stops being the template. A fourth, fifth, or sixth host does not
  require a fourth, fifth, or sixth ADR in this repository.
- The two in-tree refactors delete host-specific code rather than adding it: `status.mjs` stops
  importing `lib/opencode.mjs` internals, and adapter selection stops being a hardcoded import.
- The package stays **zero-runtime-dependency**. An adapter is a package the *user* installs and
  registers; it is not a dependency of `@pacphi/agentic-kit`.
- The honest cost: a published contract acquires consumers, and consumers constrain refactors. §6's
  alpha-instability statement is what keeps that cost bounded until it is worth paying.
- A user who registers a hostile adapter has run hostile code with their own privileges. §3
  discloses this; it does not prevent it, and no in-process design could.

## Alternatives considered

- **Absorb each host in-tree, as ADR-0017 did for OpenCode.** Rejected as the general answer. It
  works, and it is why the contracts exist — but it makes every host a permanent obligation for a
  solo maintainer, including hosts they do not run and cannot verify. The first request for a
  fourth host is the right moment to decide this once rather than four times.
- **Naming-convention discovery from the global npm tree.** Rejected under §2.
- **A subprocess/RPC adapter protocol.** Deferred under §3.
- **Leave external hosts to forks.** Rejected: it is the worst outcome for both sides. The fork
  drifts on every refactor, and agentic-kit gets no conformance evidence about whether its own
  abstractions actually hold.
- **A plugin API broader than hosts (providers, observability sources, commands).** Rejected as
  scope: hosts are where the demand and the proven contracts are. Providers are already declarable
  as data, and command extension has no requesting use case.

## Required evidence

This ADR is Proposed; no implementation is authorized or claimed. Promotion to Accepted requires:

- The fixture adapter passing admission, cap-refusal (`canBePrimary`, `aqeProvider`,
  `commandStatusline`), contract-version refusal, and per-adapter isolation — one bad adapter
  leaves the rest of `ak status` intact and reported.
- `sync`, `status`, `host pick`, and `uninstall` driving a registered adapter with no host-specific
  imports, and OpenCode passing unchanged through the registry-driven path.
- A trust manifest that names the package, resolved path, and version before the first mutation.
- Teardown proof: `ak host off` calls `undo`, an adapter whose `undo` fails retains its markers and
  reports honestly rather than claiming a clean removal.
- One real external adapter as conformance evidence — [ADR-0030](0030-hermes-reference-adapter.md).

## References

- Existing contracts: `src/lib/adapters/{registries,lifecycle,ownership,facts,schema}.mjs`,
  `src/lib/execution/{schema,subprocess,adapters}.mjs`, `src/lib/blocks.mjs` (`registry`,
  `customBlocks`).
- Existing adoption: `OPENCODE_LIFECYCLE_ADAPTER` (`src/lib/opencode.mjs`), driven via
  `runLifecycle` from `src/commands/sync.mjs` and `src/commands/x/host.mjs`.
- The remaining last mile: the per-host block in `src/commands/status.mjs`, and
  `npmRoot(host.install.npmPackage)` in `src/lib/footprint/install.mjs`.
- ADR-0016 (the registry this publishes), ADR-0017 (the per-host cost this replaces),
  ADR-0018 (execution lifecycle and trust boundary), ADR-0023 (fail-closed, pre-disclosure).
