# Autonomous Experimentation Foundation Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`; execute checked tasks in dependency order. Read the master and contracts first.

**Goal:** Produce an isolated, source-bound, independently verifiable whole-`ak run` evaluator.

**Architecture:** Keep runtime behavior in AK and place policy, container supervision, budgets, journal and evidence adapters in LAB. Build boundaries before model-enabled experiments.

**Tech stack:** AK JavaScript ESM/JSDoc; LAB TypeScript/Node 24, SQLite, container runtime, real AQE and Ruflo interfaces.

**Spec:** [Master plan](implementation-plan.md), [C1–C8 contracts](contracts.md).

## Global constraints

All [master constraints](implementation-plan.md#global-constraints) apply. File paths are explicitly prefixed `AK` or `LAB`. Test examples define intended public behavior; they have not been implemented or executed. Complete each test cycle before integrating its changes. No task authorizes a commit or remote write.

## T01 — policy, ownership and companion bootstrap

**Depends on:** no implementation task. **Owner:** integration agent. **Deliverable:** reviewed autonomy contract and an offline-capable private package.

**Files:** Modify AK `docs/adr/0022-metaharness-as-optional-assurance-companion.md`, `docs/METAHARNESS-COMPANION-PROPOSAL.md`; create AK `docs/ddd/experimental-learning.md`. Create LAB `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `config/lab.json`, `src/contracts.ts`, `src/policy.ts`, `tests/policy.test.ts`, `tests/helpers.ts`.

**Interfaces:** C1–C9 types live in LAB `src/contracts.ts`; `validatePolicy(input: unknown): LabPolicy` and `renderGrantProposal(policy: LabPolicy): object` live in `src/policy.ts`. `tests/helpers.ts` exports `policyFixture(): LabPolicy` and `sourceBindingFixture(): SourceBinding`, complete deterministic fixtures defined in C9 with explicitly synthetic identities.

- [ ] Write the following boundary test plus cases for unknown fields, mutable evaluator paths, non-integer limits and implicit metered mode:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePolicy } from '../src/policy.ts';
import { policyFixture } from './helpers.ts';
test('rejects a lane ceiling above available agent slots', () => {
  const policy = policyFixture();
  policy.limits.maxLanes = 5;
  assert.throws(() => validatePolicy(policy), /maxLanes/);
});
```

- [ ] Define scripts: `test` = `node --experimental-strip-types --test "tests/*.test.ts"`; `test:integration` uses `tests/integration/*.test.ts`; `typecheck` = `tsc --noEmit`; `build` = `tsc -p tsconfig.build.json`; `verify:artifact` = `node dist/verify-artifact.js`. Build uses NodeNext ESM and `rewriteRelativeImportExtensions`; avoid enums/parameter properties so Node's type stripping can run tests.
- [ ] Run `node --experimental-strip-types --test tests/policy.test.ts`; expect missing module/export failure, then implement exact C2 validation. Use explicit property allowlists, bounded finite integers and contained relative mutation paths. Reject blank/duplicate targets and `../`, absolute paths, NUL, wildcards and protected evaluator/grant files.
- [ ] Amend ADR-0022 with automatic laboratory selection, immutable acceptance authority, local publication default and exclusive ownership. Retain Proposed until separately accepted. Add DDD aggregates: Experiment, Grant, Reservation, EvaluationBundle and Champion; document the events that cross contexts.
- [ ] Add exact qualified upstream package versions to LAB only; lock artifacts once. Keep unimplemented optional features disabled. Create `src/verify-artifact.ts` to inspect packed LAB contents for secrets, state databases, candidate worktrees and test-only credentials; `verify:artifact` becomes required once packaging is introduced in T17.
- [ ] Rerun policy tests/typecheck; confirm AK package and lockfile are unchanged. G0 evidence is the rendered grant proposal and ADR diff, not an activated grant.

## T02 — sanitized versioned core result

**Depends on:** T01 contracts. **Owner:** AK lane. **Deliverable:** opt-in public DTO with complete failure behavior.

**Files:** Create AK `src/lib/execution/companion-result.mjs`, `src/lib/execution/companion-result.schema.json`, `src/lib/execution/companion-catalog.mjs`, `tests/kit/companion-result.test.mjs`, `tests/kit/run-companion.test.mjs`, `tests/kit/helpers/companion-fixtures.mjs`; modify `src/commands/run.mjs`, `tests/kit/run-command.test.mjs` only where small shared expectations need updating. Add user documentation in `docs/HOST-SUPPORT.md`.

**Interfaces:** `buildCompanionResult({plan, results, runId, timing, sourceObservation, catalog, status, reasonCode})`, `validateCompanionResult(value)`, and `serializeCompanionResult(value)` in `companion-result.mjs`; `buildExportCatalog(plan, knownModels, knownProviders)` in `companion-catalog.mjs`. Test helper `plannedResult()` returns a complete C1 planned DTO; `completedInput()` returns one exact valid existing worker result plus its matching catalog.

- [ ] Write a confidentiality test before adding the exporter:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanionResult } from '../../src/lib/execution/companion-result.mjs';
import { completedInput } from './helpers/companion-fixtures.mjs';
test('excludes task and private runtime failure content', () => {
  const input = completedInput();
  input.plan.workers[0].prompt = 'PRIVATE_TASK';
  input.results[0].failure = { reason: 'PRIVATE_HANDOFF' };
  assert.doesNotMatch(JSON.stringify(buildCompanionResult(input)), /PRIVATE_/);
});
```

- [ ] Run `node --test tests/kit/companion-result.test.mjs`; observe failure, then implement field-by-field construction. Reuse existing status/category vocabularies; reject unsupported schema values. Never spread plan/result/raw usage objects. Closed error codes replace raw exception messages.
- [ ] Add `result-profile: {type:'string'}` to command options. Require `--json`; accept only `companion-v1`. Validate profile arguments before building/launching workers. Create one result writer shared by all command-level success, invalid request, alignment rejection and execution exception exits. Legacy branches retain their established shape.
- [ ] Capture source HEAD/dirty observation before execution with a bounded Git probe; unknown probe results become null. This is not the content snapshot supplied by LAB. Generate UUID and timing locally; do not accept an arbitrary caller digest as observed provenance.
- [ ] Add exact 128 KiB, worker/attempt count, multibyte, unknown provider/model, absent usage, malicious keys, alignment-failure and dry-run tests. Test a parsed valid request failing before executePlan and ensure exactly one JSON value; malformed top-level CLI parsing is covered by adapter failure tests.
- [ ] Run `node --test tests/kit/companion-result.test.mjs tests/kit/run-companion.test.mjs tests/kit/run-command.test.mjs tests/kit/dispatch-surface.test.mjs`; run `pnpm run typecheck` and `pnpm run build`. Gate: no secret markers, truthful unknowns, legacy behavior retained, zero added runtime dependencies.

## T03 — cooperative whole-plan cancellation

**Depends on:** T02. **Owner:** AK lane. **Deliverable:** caller abort reaches running adapters and prevents pending work.

**Files:** Modify AK `src/lib/execution/runner.mjs`, `src/commands/run.mjs`; create `src/lib/execution/cancellation.mjs`, `tests/kit/run-cancellation.test.mjs`, `tests/kit/helpers/cancellation-adapter.mjs`. Reuse `src/lib/execution/process-tree.mjs`; do not duplicate host transport logic.

**Interfaces:** Add optional `signal: AbortSignal` to `executeRunPlan` and thread it through attempt/escalation options. `linkCancellation(parentSignal, attemptController): () => void` links parent abort and returns a listener disposer. Test helper `controlledAdapter()` returns an existing valid execution-adapter shape plus observable counters and deferred readiness/observation controls.

- [ ] Write a no-launch-on-preabort test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRunPlan } from '../../src/lib/execution/runner.mjs';
test('does not resolve an adapter after caller cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  const plan = { workers: [{ id:'a', role:'coder', activity:'implementation', host:'codex', prompt:'fixture' }] };
  const results = await executeRunPlan(plan, { signal:controller.signal, adapters:{} });
  assert.equal(results[0].status, 'cancelled');
});
```

- [ ] Run `node --test tests/kit/run-cancellation.test.mjs`; expect failure, then link the parent signal without converting caller cancellation to timeout. Preserve the existing per-attempt deadline across readiness/prepare/launch/observe.
- [ ] Before every start or escalation, check the caller signal. Mark pending workers cancelled; settle active workers through their existing cancel/cleanup path. Ensure each resource is finalized once even if timeout and abort race. Cancel all dependents on an admission/policy denial; ordinary task failure preserves current unrelated-branch semantics.
- [ ] In the run command, install scoped SIGINT/SIGTERM handlers around execution and remove them in `finally`. Propagate cancellation to the profile DTO. Do not intercept process signals globally for unrelated commands.
- [ ] Test abort during each lifecycle stage, after normal completion, during escalation, and concurrently with timeout; include a detached grandchild integration fixture. Failed cleanup must override apparent success with orphan evidence. Hard termination can produce no DTO, which the LAB adapter must handle.
- [ ] Run focused cancellation plus `execution-runner`, `execution-handoff`, `subprocess-execution` and `opencode-execution` suites. Gate: the default no-signal path remains compatible, and cancellation makes no later launch or escalation call.

## T04 — qualified runtime boundary

**Depends on:** T01; can run alongside T02/T06. **Owner:** isolation lane. **Deliverable:** a proved execution environment, not a wrapper claiming to be a sandbox.

**Files:** Create LAB `src/runtime/contracts.ts`, `src/runtime/qualification.ts`, `src/runtime/container.ts`, `src/runtime/egress.ts`, `config/runtime-profile.json`, `runtime/Dockerfile`, `runtime/egress-policy.json`, `tests/runtime.test.ts`, `tests/integration/runtime-isolation.test.ts`, `tests/fixtures/runtime-probes/` with explicit write/network/descendant probes.

**Interfaces:** `createContainerBackend(profile): RuntimeBackend`; `requireQualification(receipt, profileDigest): void`; C3 backend methods. `runtime/egress.ts` renders a fixed gateway policy from admitted transport endpoints; it does not accept arbitrary endpoint strings from tasks.

- [ ] Write the qualification refusal test:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { requireQualification } from '../src/runtime/qualification.ts';
test('refuses a profile without containment evidence', () => {
  assert.throws(() => requireQualification(null, 'sha256:'+'1'.repeat(64)), /unqualified/);
});
```

- [ ] Run `node --experimental-strip-types --test tests/runtime.test.ts`; implement exact backend/profile digest matching, grant-compatible host inventory, engine identity, tested cgroup limits and expiry. Refuse native-host fallback when qualification fails.
- [ ] Build a pinned Node 24 image with approved host binaries installed during image creation. Candidate root filesystem is read-only except bounded tmp/home and its own work volume. Mount neither real checkout/home nor controller state. Keep engine socket and credentials on the controller side. Independent verifiers use a separate no-network image with read-only candidate artifacts and private verifier data.
- [ ] Route permitted provider traffic through a separately controlled transport gateway; deny direct outbound networking, metadata-service access and GitHub writes. Test bypass via raw IP, DNS, proxy overrides and alternate transports. Read-only web research runs as a separate admitted role with no publisher/provider secrets.
- [ ] Verify actual subscription authentication in this environment without copying the complete workstation home or silently using API keys. If a host cannot operate under the boundary, report that route unqualified and continue offline capability development; do not assert dual-host live parity.
- [ ] Run `node --experimental-strip-types --test --test-name-pattern runtime-isolation tests/integration/runtime-isolation.test.ts`. Include an attempted unregistered nested model session in the probes. Gate: denied writes/egress, resource-limit enforcement, no surviving descendant on forced cleanup, nested call accounting, credentials absent from outputs, and explicit measured receipt.

## T05 — whole-run adapter

**Depends on:** T03, T04, T06. **Owner:** integration lane. **Deliverable:** one admitted isolated `ak run` with bounded output and total deadline.

**Files:** Create LAB `src/execution/ak-adapter.ts`, `src/execution/result-reader.ts`, `src/execution/arguments.ts`, `tests/ak-adapter.test.ts`, `tests/result-reader.test.ts`, `tests/integration/ak-invocation.test.ts`, `tests/fixtures/fake-ak.mjs`.

**Interfaces:** `runAk(request: RunRequest, deps): Promise<InvocationResult>`; `readCompanionResult(bytes: Uint8Array): CompanionResult`; `buildAkArgs(task, routePolicy, limits): string[]`. Dependencies are the C3 backend, T06 admission/reservations, T08 evidence writer and a clock; until T08 lands use an in-memory test sink only, never describe it as durable.

- [ ] Write malformed-public-result rejection:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompanionResult } from '../src/execution/result-reader.ts';
test('rejects legacy raw plan output at the companion boundary', () => {
  const bytes = new TextEncoder().encode('{"plan":{"prompt":"private"},"results":[]}');
  assert.throws(() => readCompanionResult(bytes), /schema/);
});
```

- [ ] Run `node --experimental-strip-types --test tests/result-reader.test.ts`; implement strict schema/size checks, one JSON document and no trailing output. Use the copied/versioned C1 schema with an integrity test against AK's export schema; no imports from AK private modules.
- [ ] Acquire admission and budget before backend start. Bound cumulative bytes while streaming, not after concatenating an unbounded string. On overflow or deadline, cancel and clean up the whole instance; discard raw captured content after recording a safe digest/closed failure code.
- [ ] Pass task text as a literal argument from its admitted fixture. A task containing shell metacharacters remains text. Do not append permission-bypass flags or `--escalate` unless explicitly admitted; initial profile has no escalation. Suppress inherited update hooks and experimental adapter auto-admission in the isolated image.
- [ ] Test exit 0 with invalid DTO, nonzero exit with valid failure DTO, permission/auth rejection, overflow, preabort, hanging process, orphaned cleanup and two documents on stdout. Fake-ak modes are selected by test arguments, never ambient provider keys.
- [ ] Run `node --experimental-strip-types --test tests/ak-adapter.test.ts tests/result-reader.test.ts tests/integration/ak-invocation.test.ts`. Gate: no successful invocation with missing result, unknown cleanup, an expired grant, or an unreconciled reservation.

## T06 — transactional policy, leases and resource reservations

**Depends on:** T01; may run alongside T02/T04. **Owner:** journal lane. **Deliverable:** durable local controller state and bounded shared budgets.

**Files:** Create LAB `src/storage/database.ts`, `src/storage/migrations/001.sql`, `src/control/admission.ts`, `src/control/reservations.ts`, `src/control/leases.ts`, `src/control/grants.ts`, `tests/storage.test.ts`, `tests/admission.test.ts`, `tests/reservations.test.ts`, `tests/integration/journal-restart.test.ts`.

**Interfaces:** `openJournal(path): Journal`; `authorize(request: ActionRequest, context): DecisionReceipt`; `reserve(key, kind, maximum): Promise<Reservation>`; `settle(key, actualOrUnknown): Promise<void>`; `claim(resourceRef, ownerId, epoch, until): Claim`; `activateGrant(proposalRef, signer): Promise<GrantRef>`. C9 defines journal/reservation/claim types. `Journal` owns transaction, prepared query, close, migrations and integrity-check operations; do not expose arbitrary SQL to candidates.

- [ ] Write the shared-budget race test:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservationLedger } from '../src/control/reservations.ts';
test('reserves a ceiling once across competing claims', async () => {
  const ledger = createReservationLedger({ database:':memory:', ceiling:100 });
  const results = await Promise.allSettled([
    ledger.reserve('a','usdMicros',80), ledger.reserve('b','usdMicros',80)
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  ledger.close();
});
```

- [ ] Define `createReservationLedger({database,ceiling})` as a test-friendly facade over the same production reserve/settle implementation; run `node --experimental-strip-types --test tests/reservations.test.ts`, then implement C5 transaction semantics. Test two separate file-backed connections in integration, not only Promise scheduling in one process.
- [ ] Every action authorization persists a receipt before side effects. Validate signature and epoch; exclude grant signing keys from worker environments. Grant creation renders a concrete policy for approval; activation requires an authenticated operator action and records the exact digest. Revoke/expire denies further calls and initiates cancellation.
- [ ] Lease ownership uses the journal epoch plus current runtime reconciliation. A dead PID is diagnostic. Lease expiry alone does not permit a second writer while a runtime may survive. Refuse ownership takeover until that runtime is proved stopped.
- [ ] Add tests for duplicate idempotency keys, integer overflow/negative amounts, daily-window rollover with outstanding reservations, crash-before-settlement, revoked/expired grant, epoch mismatch, stale lease and database lock timeout. Metered unknown completion retains the maximum reserved amount.
- [ ] Run storage/admission/reservation suites and the restart integration suite. Gate: concurrent reservations never exceed the ceiling, stale writers cannot advance state, and disk/migration failures deny new work with recoverable evidence.

## T07 — corpus, deterministic verifiers and paired evaluation

**Depends on:** T05; T08 supplies durable sink for final integration. **Owner:** evaluation lane, with actual AQE test architecture where available. **Deliverable:** a representative frozen baseline and evaluator.

**Files:** Create LAB `src/evaluation/suites.ts`, `src/evaluation/verifiers.ts`, `src/evaluation/paired.ts`, `src/evaluation/metrics.ts`, `corpora/development.json`, `corpora/anchor.json`, `tests/suites.test.ts`, `tests/paired.test.ts`, `tests/fixtures/corpus/`; place private acceptance shards outside the candidate workspace in `STATE/acceptance/`.

**Interfaces:** `validateSuite(cases: TaskCase[]): TaskCase[]`; `runVerifier(verifierRef, artifactRef, context): Promise<TaskOutcome>`; `evaluatePair(baselineRef, candidateRef, suiteRef, context): Promise<EvaluationBundle>`; `normalizeCost(input): TaskOutcome['cost']`.

- [ ] Write a cost-honesty test:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCost } from '../src/evaluation/metrics.ts';
test('preserves unknown cost when no price evidence exists', () => {
  assert.deepEqual(normalizeCost({}), { kind:'unknown', usdMicros:null, pricingRef:null });
});
```

- [ ] Run `node --experimental-strip-types --test tests/paired.test.ts`; implement strict C4 metrics and fixture identity checks. Verify that fixture IDs and content hashes do not overlap train/development/anchor/acceptance roles.
- [ ] Create six development cases per family: lifecycle (readiness timeout, prepare timeout, abort, escalation denial, detached descendant, failed cleanup); handoff (missing, malformed, oversize, injection marker, fan-in order, escalation producer); ownership (repeat sync, user edits, stale receipt, symlink, unrelated config, rollback); routing (unavailable model, permission, provider unknown, context limit, denied host, escalation provenance); footprint (clean install, warm cache, absent optional tool, multiple projects, bounded history, large fixture).
- [ ] For every case, pin input snapshot, task prompt, allowed output paths and an independent argv-only verifier. Synthetic workers provide deterministic baseline behavior; model-enabled task variants require actual artifact checks. No verifier or expected answer is writable by the candidate.
- [ ] Test reversed order/repeated runs, missing measurement, changed fixture, bad verifier exit, compromised result JSON and baseline/candidate host mismatch. Use task-cluster resampling later, not independent counting of repeated runs of one task.
- [ ] Run `node --experimental-strip-types --test tests/suites.test.ts tests/paired.test.ts`; use existing core focused suites as verifier inputs where applicable. Gate: a deliberately defective candidate fails for the expected invariant, baseline evidence is reproducible and costs/provenance are honestly classified.

## T08 — immutable evidence, durable lineage and artifact import

**Depends on:** T06–T07. **Owner:** integration agent. **Deliverable:** durable source-bound records consumable by the real engines.

**Files:** Create LAB `src/evidence/objects.ts`, `src/evidence/snapshots.ts`, `src/evidence/bundles.ts`, `src/evidence/signing.ts`, `src/integrations/flywheel-lineage.ts`, `tests/evidence.test.ts`, `tests/snapshots.test.ts`, `tests/integration/evidence-crash.test.ts`.

**Interfaces:** `putArtifact(bytes, metadata): Promise<string>`; `readVerified(ref): Promise<Uint8Array>`; `sealSnapshot(root, allowedPaths): Promise<string>`; `persistEvaluation(bundle): Promise<string>`; `createLineageStore(journal)` implements real Flywheel `append/get/walkToRoot/list`; `signLabReceipt(payload, identity)` signs a LAB-domain receipt, not a Ruflo receipt.

- [ ] Write write-failure behavior using the same injected filesystem port as production:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjectStore } from '../src/evidence/objects.ts';
test('does not return an artifact reference after a failed write', async () => {
  const store = createObjectStore({ root:'/fixture', fs:{ writeExclusive:async()=>{ throw new Error('disk-full'); } } });
  await assert.rejects(store.putArtifact(new Uint8Array([1]), { mediaType:'application/json' }), /disk-full/);
});
```

- [ ] Define `createObjectStore({root,fs?})` as the production object-store constructor exposing the listed put/read interfaces; run `node --experimental-strip-types --test tests/evidence.test.ts`, then implement C5 write/flush/rename/readback and journal reference ordering.
- [ ] Content-address exact bytes; never hash a report and then append metadata into the same report. Require immutable signatures to name source, policy, verifier and corpus identities. Plain hashes prove integrity only; unknown signer keys are not trusted merely because included in a bundle.
- [ ] Snapshot only admitted paths. Verify tracked/untracked source coverage, permissions, Unicode path normalization, symlink traversal, changed read-set and oversized artifacts. Keep baseline/candidate manifests and kit/toolchain identities distinct.
- [ ] `LineageStore.append` rejects conflicting duplicate IDs, allows identical replay idempotently and propagates persistence errors. Validate missing parent/cycles while reading; retain rejected candidates. No champion update is performed from an observational `onGeneration` hook.
- [ ] Run evidence/snapshot tests and the actual process-kill crash matrix: before blob rename, after blob before DB commit, after DB commit, interrupted resume. Gate G1: evidence cannot point to missing blobs, defaults remain removable, and a full paired fixture run survives restart or reports an explicit incomplete state.
