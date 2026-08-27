# ADR-0037 — Complexity program: structural patterns and gates

- **Status:** Implemented
- **Date:** 2026-08-26
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0036](0036-dashboard-client-modularization-and-shared-loopback-server.md)

## Context

A 2026-08-26 full-codebase complexity audit (ESLint `complexity` over `src/` + `bin/`,
plus four parallel review agents) found 399 functions over cyclomatic complexity 10,
six over CC 100 (worst: `status.mjs collect()` at CC 250), eleven source files over
1,000 lines, and no lint rule enforcing any of it. More importantly, the duplication
behind those numbers had produced five real behavioral divergences:

1. The live Codex adapters (status-plane and content-plane) never learned the newer
   `item_completed` message generation the batch parser handled — newer Codex sessions
   appeared dead in the live view.
2. The provider-convergence pipeline was pasted three times (`pick`/`sync`/`setup`);
   only `sync`'s copy healed retired routes, so `ak host pick` persisted config its
   sibling command had to repair — the issue #129 failure shape.
3. Signal-kind inference existed twice with disagreeing fallbacks.
4. `ak status` re-implemented, read-side, drift comparisons whose write-side twins
   lived in `providers.mjs` — issue #129's class, re-created.

## Decision

One refactor program (branch `refactor/complexity-program`), executed as five
file-disjoint parallel tracks with serial gated integration, established these as the
repository's sanctioned structures:

- **Section registry for `ak status`** — `src/commands/status/sections/*.mjs`, each
  exporting `{id, collect(ctx)}`, iterated by a small `collect()` orchestrator with a
  uniform per-section error contract (generalizing the pre-existing
  `HOST_DETAIL_RENDERERS` pattern). Row order, subsystem strings, messages, and fix
  strings are load-bearing (`sync` plans from them); the golden snapshot
  (`tests/kit/status-golden.test.mjs` + fixture) pins them byte-for-byte and is
  regenerated only deliberately (`STATUS_GOLDEN_UPDATE=1`).
- **One provider pipeline** — `convergeProviderStack()` in `src/lib/providers.mjs` is
  the only definition of the hosts→routes→router→codex-mcp→providers sequence;
  commands supply reporting/persistence policy. `applyAqeRouter` folds ordered
  surface reconcilers, each `(draft, ctx) → {detail, error, changed}`.
- **Ordered step registries for convergence commands** — `sync`'s and `setup`'s run
  flows are `[{id, when, run}]` arrays; array order carries the ordering invariants
  that previously lived in comments.
- **Writer-owned drift comparators** — `providerEnvDrift()` / `aqeRouterDrift()` are
  exported from `providers.mjs`, computed from the writer's own predicates and
  dry-run fold; status consumes them. A parity test
  (`tests/kit/providers-drift-parity.test.mjs`) asserts status's reported drift
  equals the writer's own computation, killing the #129 class structurally.
- **Single decode layer for vendor telemetry** — `src/lib/telemetry-records.mjs`
  (`decodeCodexRecord` / `decodeClaudeRecord`) is the one home of wire-format
  knowledge; batch usage scanning and all live adapters consume it. Only decode is
  shared — aggregation and event emission remain separate by design.
- **Statusline segment providers** — the emitted `statusline-footer.cjs` template
  renders through an ordered array of per-segment functions inside its single-file
  marked region (no build step; template constraints in the file header).
- **Dashboard modularization** — per [ADR-0036](0036-dashboard-client-modularization-and-shared-loopback-server.md):
  route-table dispatcher, `sseRoute()` lifecycle helper, real browser modules
  concatenated by collectors, `loopback-server.mjs` for loopback security primitives.
- **Gates** — the dashboard Playwright suite (`pnpm run test:ui`) runs in CI;
  `complexity: 25` / `max-depth: 5` / `max-lines: 1000` ESLint **warnings** apply to
  `src/` + `bin/`. Warnings are visibility, not a wall: new code should land under
  the thresholds, and they ratchet to errors per-directory as areas come clean.

## Consequences

- All six CC>100 functions are gone (worst named targets: `collect()` 250→4,
  `dashboard-server` handler 194→13, `rufloActivationSegments` 193→9, `pick()`
  144→11, `applyAqeRouter` 111→21, `sync run()` 110→20; also `scan` 73→13,
  `detectInsights` 71→7, `reduceLiveEvent` 81→12). All five behavioral divergences
  are fixed with regression tests.
- The measured CC>10 count rose (399→~507) because the dashboard client's ~184
  functions became visible to ESLint for the first time — the denominator became
  honest; per-function severity dropped sharply.
- Known residual backlog (deliberately not part of this program): `uninstall run()`
  (CC 100), `model-inventory` discovery and `footprint`/`adapters` functions in the
  50–65 band, and the newly visible client functions (`system-projects` 88,
  `overview` 63). `providers.mjs` sits just over the 1,000-line warning; a future
  `aqe-router.mjs` split would clear it.
- **Wave 2 update (2026-08-26):** the `opencode.mjs` receipt-reconciliation family
  named above is done — `reconcileOwnedMap` (+ a `reconcileFamilyPermissions`
  family-atomicity wrapper for the permission block) now backs `applyOpencode`
  (71→21), and every other named function over CC 25 in `opencode.mjs`
  (`normalizeManaged` 32, `opencodeConverged` 28, `undoOpencode` 26, `opencodeStack`
  44, `syncAgents` 50, `agentsStatus` 46, `removeArtifacts` 26), in
  `src/lib/execution/opencode.mjs` (`terminalResult` 30, `launch` 36), and in the
  emitted `src/templates/opencode-ruflo-gateway.js` template (`config` 28) is under
  the gate. `opencode.mjs` (1,573 lines) was also split into five files, each under
  1,000 lines (`opencode.mjs` is now a re-export barrel; see ADR-0017 §2).
- **Wave 2 closure (2026-08-27):** the whole residual backlog above is cleared —
  seven parallel tracks brought `uninstall run()` (100→5), the adapters family
  (conformance 60→19, admission 55, four validators 45–49 → all <25), footprint
  (`collectProjects` 59→16, `storage.mjs` split three ways), model-inventory
  (`discoverOllamaApi` 65→13), the telemetry residuals (`adaptCodexLedger` 65→20,
  `parseCodex` 53→11, `usage-index.mjs` split into index-I/O plus
  `usage-parsers.mjs` and `usage-aggregate.mjs`, removing a latent circular
  import), the AQE-router
  machinery out of `providers.mjs` into `aqe-router.mjs`, and every over-25
  dashboard client function (worst `renderSysStorage` 88 → an orchestrator of ≤22
  helpers) under the gate. One real defect was found and fixed along the way — a
  literal NUL byte in the Models "Used for" sort key (`mliRouteValue`), a live sort
  bug. **Repo-wide there is now no function over CC 50**, and that ceiling is
  enforced as an ERROR (`pnpm run lint:cc`, wired into `check` and CI's quality
  job); the warn-25 tier stays advisory with ~30 functions in the 26–49 band, led
  by `createLiveEvent` (49), which stays as the deliberate validation-boundary
  exemption. Remaining advisory residuals live in the lint output, not in this
  document.
