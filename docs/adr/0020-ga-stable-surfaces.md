# ADR-0020 — One stable GA surface per capability

- **Status:** Implemented
- **Date:** 2026-07-30
- **Updated:** 2026-07-30
- **Update note:** Completed the migrate/remove inventory, canonical config cutover, package
  boundary, active-guidance cleanup, and regression guards for the 4.0 GA surface.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0018](0018-generalized-host-worker-execution.md),
  [ADR-0019](0019-escalation-in-ak-run.md), [issue #83](https://github.com/pacphi/agentic-kit/issues/83)

## Context

The 4.0 alpha accumulated compatibility commands, an adapter-specific execution projection,
transitional configuration names, and generated guidance that described both the replacement and
the path it replaced. Keeping those surfaces for GA would create multiple answers to basic
questions: how to run a pipeline, how to manage hosts, where routing intent lives, and which
component owns execution.

OpenCode sharpens the boundary. It is a routable execution host, but it must remain explicit,
supervised, non-primary, outside AQE provider routing, and absent from vendor-diversity facts unless
its actual inference provider is independently observed.

## Decision

1. `ak run` is the only execution command. It owns host-neutral templates, run-local route
   overrides, bounded concurrency, deadlines, JSON results, and per-worker escalation.
2. `ak host` is the user command for host lifecycle, routing, and the colocated provider-binding
   controls. `ak x host` is its plumbing spelling. Host and inference-provider concepts remain
   separate.
3. Routing intent uses one top-level, versioned envelope:

   ```json
   {
     "routing": {
       "version": 1,
       "primaryHost": "claude",
       "routes": {
         "implementation": {
           "host": "codex",
           "model": "gpt-5.4",
           "provenance": "user",
           "escalation": []
         }
       }
     }
   }
   ```

   Migration is deterministic and one-way. It preserves route host, model, escalation order, and
   provenance, removes the old fields after a successful write, and is idempotent on later loads.
4. The runtime no longer installs or invokes a separate collaboration adapter or initializes an
   adapter-specific dual-execution mode. Claude and Codex execute through the same supervised
   worker contract as every other routable host.
5. Active help, operational documentation, generated guidance, and examples describe only GA
   surfaces. ADRs may retain old names as decision history when their status or amendment clearly
   points here. The upgrading guide contains the single concise user migration.
6. OpenCode remains disabled until explicitly enabled. Its routes execute only through `ak run`;
   they never project to AQE, never make OpenCode primary, and never establish an inference vendor
   from host identity or a configured model selector.

## Inventory and disposition

| Pre-GA surface | GA disposition |
| -------------- | -------------- |
| `ak dual`, `ak provider`, `ak x provider` and their aliases | **Remove.** Unknown-command behavior replaces compatibility dispatch. |
| `src/commands/dual.mjs`, `tests/kit/dual-cli.test.mjs`, and `tests/kit/dual-preflight.test.mjs` | **Remove.** `ak run` owns the complete supervised execution contract. |
| `src/commands/x/provider.mjs` | **Migrate.** The stable plumbing entry is `src/commands/x/host.mjs`. |
| `DUAL_RUN_TEMPLATES`, `DUAL_RUN_TEMPLATE_NAMES` | **Migrate.** `RUN_TEMPLATES` and `RUN_TEMPLATE_NAMES` are the host-neutral registry used by `ak run`. |
| `policyToDualRunConfig` | **Remove.** `materializeRunPlan` is the sole host-neutral plan materializer. |
| `escalatePolicy` | **Remove.** The supervised runner applies each worker's bounded ladder and records attempt evidence. |
| `seedDualRouting`, `seedDualRoutingIfDualHost` | **Migrate.** `seedActivityRoutes` and `seedActivityRoutesIfMultiHost` own canonical route seeding. |
| `CODEX_ADAPTER_PKG`, `codexAdapterAction`, `ensureCodexAdapter`, `ensureDualAgents` | **Remove.** Host workers use the in-repository supervisor; the upgrading guide explains manual cleanup because old releases recorded no ownership receipt. |
| `writeConfigModule`, `nativeWalConflict` | **Remove.** `ak run` neither writes adapter config modules nor shares the compatibility executor's native/WASM database. |
| `adaptDualRunRecord`, `DUAL_TEMPLATES`, `DUAL_TEMPLATE_NAMES` | **Remove.** Structured supervised-worker events are the only live execution adapter. |
| Historical `dual-run` event labels | **Migrate on read.** They retain truthful `internal` provenance instead of being overstated as native execution. |
| `providers.dualRouting`, route `source`, and route `escalate` | **Migrate once.** Use versioned `routing.routes`, `provenance`, and `escalation`. |
| `providers.primaryHost` and `providers.hosts` | **Migrate once.** Use `routing.primaryHost` and versioned `integrations.hosts`. |
| `providers.bindings` | **Migrate once without loss.** Merge into versioned `integrations.bindings`; conflicting ids fail closed. |
| Codex/OpenCode MCP, management, and catalog ownership fields under `providers` | **Migrate once.** Use versioned `integrations.ownership`. |
| `legacyRouteProvider`, derived compatibility exports, and usage-output aliases | **Remove.** Registry selectors and canonical `byHost`/`provider` fields are the only live views. |
| Templates, route overrides, concurrency, timeout, JSON output, escalation, and error behavior | **Migrate.** `ak run` preserves them through templates, repeatable `--route`, `--max-concurrent`, `--timeout`, `--json`, `--escalate`, and structured worker results; it is concurrent by default and uses `--max-concurrent 1` for sequential execution. |
| Active help, templates, operational docs, dashboard copy, and examples | **Migrate.** Render only GA commands and canonical fields. |
| Historical ADR vocabulary | **Retain as history.** Each affected ADR points to this implemented decision. |
| Upgrade and GA release guidance | **Retain once.** `docs/UPGRADING.md` is the sole active compatibility vocabulary. |
| npm package source enumeration and ignored/generated workspace artifacts | **Migrate.** The manifest excludes hidden QE/runtime state and the build gate rejects generated or private artifacts in the dry-run tarball. |

## Consequences

- Removed commands fail as unknown commands and do not emit deprecation warnings.
- A clean install has one execution path and one host-management namespace.
- Configuration readers may recognize the old shape only inside the one-way migration boundary;
  writers and ordinary runtime code use the canonical envelope exclusively.
- Generated machine guidance cannot revive removed commands after `ak sync`.
- OpenCode routability does not weaken permission, provider-provenance, billing, or vendor-diversity
  boundaries established by ADR-0018.

## Verification

- Negative command tests cover every removed spelling and assert absence from help.
- A static guard scans active docs, help, dashboard copy, and generated templates for retired
  command, configuration, adapter, and initialization advice.
- Migration fixtures prove preservation, one-way removal, and idempotency.
- Capability tests prove OpenCode is opt-in, non-primary, not AQE-projected, and not a vendor fact.
