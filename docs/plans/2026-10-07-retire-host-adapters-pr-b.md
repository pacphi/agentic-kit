# Retire the external host-adapter contract, PR B: detach the three consumers

## Status

**Executed on the branch, not pushed** (2026-10-13). The maintainer approved the plan on 2026-10-07 with the
recommendation on each of D1 to D5. Plan for pull request B of three for card P0-04, issue
[#324](https://github.com/pacphi/agentic-kit/issues/324). Pull request A is merged
([#468](https://github.com/pacphi/agentic-kit/pull/468)). Tasks 1 to 5 are committed on
`refactor/324-pr-b-detach-consumers`, rebased onto `main` at `d8e02003`; Task 6 ran the full gate and a
fresh whole-branch review, and its findings are fixed. The edits were applied from recorded edit scripts but
**not** replayed into a second worktree. Next: the maintainer's go-ahead to push and open the pull request.

**Goal:** after B, no built-in code reads the admitted-host overlay, so pull request C can delete the
adapter cluster without touching a built-in file. Claude Code, Codex and OpenCode behave exactly as before.

**Spec:** [2026-10-07-retire-host-adapters-design.md](2026-10-07-retire-host-adapters-design.md)

## Decisions

Each decision has evidence and a recommendation. The maintainer accepted the recommendation on all five
(D1 to D5) on 2026-10-07. The plan below follows them.

| # | Question | Evidence | Options | Recommendation |
| --- | --- | --- | --- | --- |
| D1 | Does B delete the external half of `lifecycle-registry.mjs` (the spec says yes)? | `admission.mjs:398` still calls `registerAdmittedLifecycle` through a lazy import. `admission.mjs` stays until C. Deleting the function in B breaks that call and forces edits to `admission.mjs` and about 100 lines of its tests, which C deletes anyway. | **1.** Delete in B, edit `admission.mjs` and its tests. **2.** B detaches only the consumers (setup, sync, uninstall, status, `hostsWithLifecycle`, the flag). The three admitted-builder functions go in C with `admission.mjs`. | **2.** It follows the spec's own rule: a module is deleted only after everything that imports it is gone. |
| D2 | Which condition loads the config in `ak audit hooks`? | `audit.mjs:89` loads it only when `external` or `all` is selected. The OpenCode report reads its ownership from that config (`orchestrator.mjs:55`). Today `--host opencode` alone gets `{}`, so ownership is `null`. | **a.** `hosts.includes('all')`: byte-for-byte same behaviour. **b.** `includesHost(hosts, 'opencode')`: `--host opencode` alone starts reading ownership (a behaviour change). | **a** in B, with a comment. The gap is real, but "OpenCode behaves exactly as before" wins. Note it for later. |
| D3 | Does B stop clearing a stale `_agenticKit.externalDefaultProvider` receipt (`clearStaleDefaultReceipts`)? | The spec's ruling says stale keys stay inert and the source never names them. What AQE does with a stale `externalProviders` entry is **not verified**. | **a.** Drop all external receipt code. **b.** Keep a one-time clear. | **a**, as the spec rules. The exit release's `--purge` covers alpha users. |
| D4 | Where does the `adapters/index.mjs` trim happen? | Four re-exports (`manifest`, `admission`, `admitted`, `aqe-provider`). Only `tests/kit/routing-primary.test.mjs` uses one (`effectivePrimaryHostIds`), and that test checks the overlay. No source file uses them. | B or C | **C.** That test dies with the overlay. PR A's rule keeps tests of dead modules until C. |
| D5 | What happens to ADR-0041 (host-neutral hook configuration), which describes the external audit? | The living-plan rule says to update an ADR in the same change that alters it. The inventory found external-audit text at lines 90-91, 193, 349, 372 and 388-421. Not read in full. | **a.** Add a short "external provider withdrawn in B" note now. **b.** Handle in C with ADR-0029 and ADR-0031. | **b**, so one pass reads all ADRs. B's pull request body says so. |

## Global Constraints

- One pull request, branch `refactor/324-pr-b-detach-consumers`, cut from `main` at `3d0e1142` in the
  worktree `agentic-kit-wt-324b`. Do not push or open the pull request without the maintainer's go-ahead.
  Commit this plan only after approval.
- Keep every module PR C deletes: `admission`, `admitted`, `aqe-provider`, `consent`, `grants`,
  `hook-runner`, `integrity`, `manifest`, `sources`, `execution/admitted.mjs`, and their own tests. B edits no
  file in that list.
- `src/lib/hook-audit/providers/external.mjs` **is** deleted in B. Only `orchestrator.mjs` imports it.
- Claude Code, Codex and OpenCode behave exactly as before. `ak run`, `ak host pick --aqe-provider <built-in>`
  and the Maintenance discovery of Hermes are unchanged.
- A saved `hostAdapters` list stays on disk and the source never reads it (Task 4 retires the key so no
  warning prints).
- Shared helpers stay: `declarationHash`, `plainRecord`, `stableValue`, `AQE_OWNERSHIP_KEY`,
  `AGENT_OVERRIDES_MIN_AQE` and `aqeSupportsAgentOverrides`.
- No aliases or hints for removed behaviour. The old-to-new mapping goes in the pull request body.
- Comments and `test(...)` titles carry no transient labels ("Task 2", "Branch 6a").
- Commit messages are `<type>(<scope>): <description>`. Add no `Co-Authored-By` trailer.
- Run tests with `node scripts/run-tests.mjs focus <files>`, never bare `node --test`. The worktree has no
  `node_modules`: run `pnpm install --frozen-lockfile` once. Never run `pnpm` where `node_modules` is a symlink.
- Apply edits within one file in the order shown. Tests of removed behaviour are deleted or rewritten in the
  same task as the code.

## Task order

```text
1  AQE external-provider code      aqe-router, providers, routing, live-checks, providers-status, x/host
2  Hook audit, external host       delete providers/external.mjs; orchestrator, audit, heal, context audit, dashboard, presentation
3  Lifecycle entries (D1 option 2) lifecycle-registry (consumer-facing half), setup, sync, uninstall, status
4  Retire the hostAdapters key     config.mjs, and the managed block sentence
5  Docs and archive                schema, hooks.md, maintenance.md, README, v5 sources row; archive the PR A plan
6  Gate, review, hand-off          full gate, fresh whole-branch review, pull request body
```

Task 4 runs after 1 to 3 because `providers.mjs` and `hook-audit/providers/external.mjs` read `hostAdapters`,
and `config.mjs` must not drop the key until they are gone. The suite may be red between tasks. It must be
green at Task 6.

## Task 1: AQE external-provider code

**Files.** `src/lib/aqe-router.mjs` (674 lines), `src/lib/providers.mjs` (1180), `src/lib/routing.mjs` (751),
`src/lib/live-checks.mjs` (629), `src/commands/status/sections/providers-status.mjs` (95),
`src/commands/x/host.mjs`.

| File | Delete | Edit |
| --- | --- | --- |
| `aqe-router.mjs` | the `admittedAqeProviders` import; `admittedProviderRecord`; `exactlyOwnedExternalDefault`, `set/clearExternalDefaultOwnership`; `reconcileConflictingDeclaration`, `reconcileProviderActivation`, `reconcileDesiredProvider`, `retireStaleProvider`, `reconcileExternalProviders`; `formatExternalProvidersDetail`; surface 1 `reconcileExternalProvidersSurface` | `reconcileFallbackRetirementSurface` (drop the external-default clause); `reconcileDefaultProviderSurface` (drop the external deselect branch, the `desiredExternal`/`externalActive` filters and the project-local external selection; keep the built-in selection, chain and credential-gap detail); `reconcileAgentOverridesSurface` (drop `desiredExternal` guards); `AQE_ROUTER_SURFACES` (4 to 3 surfaces, fix "Surface N/4" comments); `aqeRouterHasNothingToApply`; `clearStaleDefaultReceipts` (D3); `buildAqeRouterContext` and `runAqeRouterFold` (drop the external fields); imports; the header comment |
| `providers.mjs` | `projectedAqeExternalProviders` import; `aqeExternalProviders`; `aqeSelectableProviderTypes`; `aqeSelectableChainProviderTypes`; `EXTERNAL_PROVIDERS_MIN_AQE`; `aqeSupportsExternalProviders`; `aqeExternalProviderState`; `configuredAdapterIds`; `externalProviderIntent`; `providerExternalState` | `aqeProviderCredential` (replace the external `if (!d)` branch with the plain unknown result); `detectAqeProviders` (iterate `AQE_PROVIDER_TYPES`); the comment above the ownership helpers; check for orphaned imports (`readJson`, `path`, `createHash`, `HOSTS`) |
| `routing.mjs` | the `admittedAqeProviders` import | `aqeProviderForHost` becomes `HOST_PROVIDER[host] ?? null`; `aqeConstructibleProviderTypes` returns the constant (or is inlined at its three call sites); one comment |
| `live-checks.mjs` | the external block in `verifyProjectProviders` (about lines 429-453) | the import list; one `info(...)` string; check whether `disk` and `readJson` have other uses |
| `providers-status.mjs` | the `providerExternalState` use | `credentialChainRow(cfg)` loses its second parameter; import list; header comment |
| `x/host.mjs` | the "admitted · credential not introspectable" branch | the two display strings; `aqeSelectable*` become `AQE_PROVIDER_TYPES` and `AQE_CHAIN_PROVIDER_TYPES` (lines near 230, 255, 1098-1099) |

**Tests.**

- Before deleting `tests/kit/providers-external.test.mjs` (15 tests, all driven by a synthetic `hermes`), port
  three of them to a built-in provider (`ollama` or `codex`), so built-in coverage survives: the empty
  fallback intent retires the managed chain and its default; fallback retirement keeps a user-chosen
  replacement; malformed ownership receipts are relinquished (the `fallbackDefaultProvider` part).
- Keep unchanged and green: `provider-credentials`, `status-viability`, `provider-cli`,
  `host-cli-migration`, `host-pick-rerecord`, `cli-json-honesty`.
- Edit text only: `status-manual-fixes` (comment), `sync-needs-your-action` (fixture string).
- Add a test that `ak x host pick --aqe-provider hermes` says `unknown aqe provider` and lists the built-ins.
- Leave for C: `adapter-aqe-provider.test.mjs`, `tests/live/aqe-external-provider-transport.test.mjs`.

**Visible change.** `ak x host` loses the external header text and the "admitted" row. `ak verify` loses every
"external AQE" row. `ak sync` stops writing, pruning and reporting `externalProviders`, activations and receipts.

## Task 2: Hook audit, external host

**Delete.** `src/lib/hook-audit/providers/external.mjs` (114 lines).

| File | Change |
| --- | --- |
| `hook-audit/orchestrator.mjs` | drop the import, `'external'` from `BUILTIN_HOOK_AUDIT_HOSTS`, the `external?` type and `external = {}` destructure, and the `reports.external` line. `--host all` then means the three built-ins. `config` stays (OpenCode ownership). |
| `commands/audit.mjs` | help text; line 89 becomes `config: hosts.includes('all') ? loadConfigFn() : {}` (D2 option a), with a comment that says why. Do **not** just delete the line: `--host all` would lose OpenCode ownership. A codex-only run must still never call `loadConfigFn` (`hook-audit-hosts.test.mjs` pins it). |
| `commands/heal.mjs` | help text. `heal` reuses `collectHookAudit`, so it inherits the unknown-host rejection. |
| `context-audit.mjs` | drop `'external'` from `CONTEXT_AUDIT_HOSTS`; delete the `hooksProjection` branch. `PROVENANCE` still lists `adapter-declared`: trace its producers during the dry run and drop it only if none remain. |
| `context-audit-sources.mjs` | delete the external branches in `inspectMcpConfig`, `guidanceEvidence`, `modelEvidence`; collapse the `skills[host]` ternary. |
| `dashboard-server.mjs` | drop `'external'` from `DASHBOARD_HOOK_HOSTS`; delete the `external-adapter-manifest` branch in `hookJsonPointer`. |
| `hook-presentation.mjs` | delete the `Adapter manifest` label and the two findings only `external.mjs` emitted (`consent-and-grants-not-inferred`, `target-host-compatibility-unproven`). |
| `hook-remediation/planner.mjs` | delete `PROVIDER_POLICIES.external`. |
| `maintenance/management/hook-scope.mjs` | comment only. |

**Contract.** The inventory read `ga-surface-guard.test.mjs` and found no pin on `ak audit hooks`, `--json`
or the `external` key. This resolves the spec's open question: it is not a GA surface. `ak audit hooks --host
external` exits 2 with `unknown --host value(s): external`. `--json` loses `reports.external`, and the
`hosts` and `runtimeVersions` entries for it. `ak audit context` (default host `all`) loses its `external`
entry, so `summary.hosts` goes from 4 to 3.

**Tests.**

- Delete in `hook-audit-hosts.test.mjs`: the two `--host external` tests and the `externalManifest()` helper.
  Edit the host-neutral test to expect three hosts. Add: `--host external` is rejected; `--host all` equals the
  three built-ins; `--host all` still passes OpenCode ownership through.
- `context-audit.test.mjs` (15 hits): remove the external fixtures and asserts, and the
  `inspectMcpConfig('external')` line. This leaves no test of the `unsupported` health path. Decide in the dry
  run whether to keep one such case through another route.
- `hook-read-model.test.mjs`: re-key the `external`/`hermes` fixture to built-in hosts; delete the
  "adapter records retain their concrete host identity" test (or retarget it).
- `hook-scope-inventory.test.mjs` and `maintenance-management-projection.test.mjs`: drop the
  `external-adapter-manifest` mapping row. Both pass either way.
- Read `hook-presentation.test.mjs` before the edit: it may list the two deleted finding codes.

## Task 3: Lifecycle entries (D1 option 2)

`lifecycle-registry.mjs` has 356 lines. The consumer-facing half changes here. The admitted-builder trio stays
for C.

| Symbol | B change |
| --- | --- |
| `hostsWithLifecycle` | filters `HOST_REGISTRY` (no overlay). Keep this name (many callers). |
| `builtinHostsWithLifecycle` | delete: no source caller, same result as the above. Move its test to `hostsWithLifecycle`. |
| `isBuiltinHost` | delete after its two source callers go. |
| `lifecycleExecutionEnabled` | collapses to `!!cfg?.integrations?.hosts?.[hostId]`. Drop `EXPERIMENTAL_HOST_ADAPTERS_FLAG`. |
| `detectionBinFor` | collapses to `hostId`; inline at `setup.mjs` and `sync.mjs`, or keep as a one-line function. |
| `buildAdmittedLifecycleAdapter`, `registerAdmittedLifecycle`, `resetAdmittedLifecycle`, `ADMITTED_LIFECYCLE_IDS` and their helpers | **stay until C.** `admission.mjs` still imports `registerAdmittedLifecycle`. |

**Callers.**

- `uninstall.mjs` (`stepHostLifecycles`): **delete** the line `if (!isBuiltinHost(hostId) && !lifecycleExecutionEnabled(hostId, cfg)) continue;`.
  Do not replace it with `lifecycleExecutionEnabled`: that would stop OpenCode's undo when the host is
  disabled in config. Collapse the dry-run ternary to the OpenCode message. Rewrite the comment above.
- `status/host-detail.mjs`: delete `admittedLifecycleFallbackRows` (the "external lifecycle host, enabled" row) and the
  imports it alone uses; delete the call at `status.mjs:186`; fix the comment in `status/sections/index.mjs`.
- `setup.mjs`, `sync.mjs`: update imports and the calls to `detectionBinFor`.

**Tests.**

- Delete `tests/kit/external-lifecycle.test.mjs`. Move its one built-in test ("opencode's own lifecycle wiring
  is unaffected") into `lifecycle-registry.test.mjs`.
- `lifecycle-registry.test.mjs` (422 lines, mixed): keep the built-in cases and the architecture guards; edit
  the `lifecycleExecutionEnabled` text guard; delete the cases for `isBuiltinHost`, the flag, `detectionBin`
  and "excludes an admitted host". The admitted-builder cases stay until C.
- `status-command.test.mjs`: delete the admitted-host-row block (about lines 1055-1190). Keep the rest.
- `status-repair-contract.test.mjs`: drop `ADMITTED_HOST`.
- `setup-host-rerecord.test.mjs`: update the module mock if exports change.
- Stays until C: `adapter-admission.test.mjs` lifecycle cases, `adapter-lifecycle-conformance.test.mjs`.

## Task 4: Retire the `hostAdapters` key

- `config.mjs`: delete the default and its comment (lines 66-69). **Add `'hostAdapters'` to
  `RETIRED_TOP_LEVEL_KEYS`.** I checked this: without it, any `kit.json` that still holds the key prints
  `kit.json keys not recognized by this ak version: hostAdapters` on every command. The spec's ruling says
  stale keys stay silent.
- `settings-config.test.mjs`: fix the two comments and add a test that a saved `hostAdapters` produces no
  warning.
- `claude/providers-reference.md` names "admitted external adapters". Change the sentence to "`claude`, `codex`
  and `opencode` run work". I found no version field in `blocks.mjs`; blocks look content-synced. Run
  `blocks-drift-parity.test.mjs` and `guidance-budget.test.mjs`. If either wants a template-version bump,
  bump it in this task. The user-level `~/.claude/CLAUDE.md` copy of the block updates on the next `ak sync`.

## Task 5: Docs and archive

- `docs/schemas/hook-healing-plan.schema.json`: drop `"external"` from `hosts.items.enum`. No test reads it.
- `docs/hooks.md`, `docs/maintenance.md`, `README.md`: drop the external-adapter phrases.
- `docs/proposals/v5-planning-sources.md`: delete the `Hook audit | .../external.mjs` row (dangling path).
- **Fold the PR A plan in.** Move `docs/plans/2026-10-07-retire-host-adapters-pr-a.md` to
  `docs/archive/2026-10-07-plan-retire-host-adapters-pr-a.md` with `node scripts/docs-relocate.mjs --map
  <file.tsv>` (run `--dry-run` first), set its Status to "Executed in
  [#468](https://github.com/pacphi/agentic-kit/pull/468)", and add one index row under a new
  "Added 2026-10-07" section of `docs/archive/README.md`. Update the Status of the design spec: A merged, B in
  progress. Keep the design spec in `docs/plans/` until C.
- Do not edit `docs/archive/` contents other than the moved file and the index.

## Task 6: Gate, review and hand-off

Run, in this order: `pnpm run typecheck`, `pnpm run lint`, `pnpm run lint:cc`, `pnpm run lint:md`,
`pnpm run build`, lychee, `tests/kit/docs-layout.test.mjs`, then `node scripts/run-tests.mjs unit`.
Run the fresh-context whole-branch review on the most capable model. Fix Critical and Important findings with a
failing test first. The pull request body carries the old-to-new table and the D1, D2, D3 and D5 outcomes.

## Review Focus

1. `ak audit hooks --host all` keeps OpenCode ownership (D2). Tested in Task 2.
2. `ak uninstall` still undoes OpenCode when its host is disabled in config. Tested in Task 3.
3. A `kit.json` with `hostAdapters` prints no warning. Tested in Task 4.
4. Ported built-in tests still fail when the built-in logic breaks (check by mutation, not only by running them).
5. `ak sync` against a project that holds old `externalProviders` entries: B stops touching them. AQE's
   behaviour with them is **not verified**.

## How this plan was checked

Three read-only inventories (AQE, hook audit, lifecycle) fed this plan, each from a separate reading of
`3d0e1142`. I spot-checked these claims against the code myself:

- no source file outside the cluster uses the overlay except the five consumers in this plan;
- `config.mjs` would warn on a saved `hostAdapters` if the key left `DEFAULTS` unretired;
- the `uninstall.mjs` line and the `host-detail.mjs` fallback rows read as the lifecycle inventory says;
- `audit.mjs:89` loads config only for `external` or `all`;
- `ga-surface-guard.test.mjs` has no `audit`, `external` or `hooks` hit;
- `admission.mjs:398` is the only cluster call into a file B edits.

**Not verified:** a dry-run or replay of any edit; line numbers below the file headers (they drift after the
first edit); `hook-presentation.test.mjs` and the middle of `lifecycle-registry.test.mjs` (boundaries from test
titles only); the producers of `adapter-declared`; AQE's handling of stale `externalProviders` entries; the
CI cost of the full gate. After approval, the next step is the edit script and a replay in a second worktree,
as for A.
