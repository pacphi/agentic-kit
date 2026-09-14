# Autonomous Learning and Operations Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the master, contracts and foundation before executing these tasks.

**Goal:** Close the autonomous research, candidate evaluation, memory and recovery loop over the qualified foundation.

**Architecture:** Real upstream engines perform their specialties; LAB supplies bounded adapters and an independent durable acceptance boundary. Schedule only after successful manual cycles, and retain every result including rejected or inconclusive experiments.

**Tech stack:** MetaHarness Flywheel/Darwin/Router, Dream Machine compiler/ledger, Ruflo MCP, AgentDB, Agentic QE, Rust Autogenous and the LAB Node 24 controller.

**Spec:** [Master plan](implementation-plan.md), [C1–C8 contracts](contracts.md), [T01–T08 foundation](foundation.md).

## Global constraints

All [master constraints](implementation-plan.md#global-constraints) apply. Every path below is relative to LAB unless explicitly labeled AK. The actual session/tool limits determine concurrency. Upstream search promotion, LAB champion selection and production application are distinct states and identities.

## T09 — real Flywheel search and independent acceptance

**Depends on:** T08. **Owner:** integration/evaluation lane. **Deliverable:** one complete real-engine experiment with durable acceptance.

**Files:** Create `src/integrations/flywheel.ts`, `src/evaluation/development-rule.ts`, `src/evaluation/acceptance.ts`, `src/evaluation/statistics.ts`, `src/control/champions.ts`, `config/gates/quality.json`, `config/gates/latency.json`, `tests/flywheel.test.ts`, `tests/acceptance.test.ts`, `tests/champions.test.ts`.

**Interfaces:** `runSearch(input, deps): Promise<{candidateRef: string; replayRef: string}>`; real `Evaluator`, `Proposer`, `Signer`, `LineageStore` from Flywheel; `developmentRule(evidence): PromotionDecision`; C6 `judgeCandidate`, `ChampionStore.select/rollback`. `createChampionStore(journal)` returns that store; `acceptCandidate(candidateRef, context)` obtains a one-use acceptance shard and produces the durable decision.

- [ ] Write a frozen development gate test:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentRule } from '../src/evaluation/development-rule.ts';
test('refuses a quality gain that carries a hard regression', () => {
  const baseline = { primary:0.5, noopRate:0.2, costPerWin:1, regressed:false };
  const candidate = { ...baseline, primary:0.9, regressed:true };
  assert.equal(developmentRule({ baseline, candidate }).promote, false);
});
```

- [ ] Run `node --experimental-strip-types --test tests/flywheel.test.ts`; use actual `runFlywheelGenerations` with explicit mutation targets, frozen development rule, required anchor, signed receipts and the durable T08 lineage store. Turn evaluation caching off for stochastic runs.
- [ ] Map rich development outcomes onto real Flywheel Score fields. Reject unknown monetary data in cost-driven modes; quality-only runs may use a consistently documented nonmonetary resource basis, identified in the accompanying evidence, never labeled USD. The numeric projection does not replace C4 records.
- [ ] Implement C6 acceptance in a separate process with private corpus access. Never accept Flywheel's `finalPolicy` directly. Verify candidate/source/artifact identities, consume a one-use shard, run baseline/candidate pairs and the frozen anchor, and compute the task-cluster confidence bound with a deterministic seed.
- [ ] Persist the LAB acceptance receipt before a conditional champion transaction. Recheck epoch, grant and expected old head inside the transaction. The engine's `onGeneration` callback cannot install a champion. Hash gate source and config; replay verifies both plus sidecar outcomes rather than trusting only an upstream function fingerprint.
- [ ] Test insufficient pairs, reused shard, no-op/quality disagreement, missing anchor, mismatched source, expired grant, signer mismatch, failed journal append, stale champion and crash before pointer commit. Include actual upstream replay verification as well as LAB receipt validation.
- [ ] Run Flywheel/acceptance/champion tests. Gate: a deterministic fixture can improve and persist a laboratory candidate, a malicious candidate is rejected, and every persistence fault leaves the previous champion unchanged.

## T10 — Dream compiler with enforceable local output

**Depends on:** T09; T04 containment is mandatory before executing compiled instructions. **Owner:** Dream integration lane. **Deliverable:** compiled, reproducible research cycles with no default publication.

**Files:** Create `src/integrations/dream.ts`, `src/research/hypothesis.ts`, `src/research/cycle.ts`, `config/dream.json`, `patches/dream-machine/local-output.patch`, `tests/dream.test.ts`, `tests/cycle.test.ts`, `tests/fixtures/dream/`; record upstream patch provenance in `docs/upstream-compatibility.md`.

**Interfaces:** `compileDream(config, toolchain): Promise<{promptRef:string; compilerRef:string}>`; `validateHypothesis(value): Hypothesis`; `runCycle(eventRef, context): Promise<string>` returning a terminal experiment record. `Hypothesis` contains `id`, `family`, `workloadRef`, `baselineRef`, `mutationTargets`, `objective`, `expectedDirection`, `invariantRefs`, and `researchEvidenceRefs`.

- [ ] Write the compilation contract test:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDreamOutputMode } from '../src/integrations/dream.ts';
test('rejects an unqualified compiler for local-only execution', () => {
  assert.throws(() => validateDreamOutputMode({ localOutput:false }, 'local'), /local-output/);
});
```

- [ ] Export `validateDreamOutputMode(capabilities, mode)` from the bridge; run `node --experimental-strip-types --test tests/dream.test.ts`. Capability evidence is tied to the compiled artifact digest, not a package version string alone.
- [ ] In a reviewed upstream checkout, add a typed `publicationMode: 'local'|'draft-pr'` compiler seam, render the local terminal artifact/ledger path explicitly, and retain all required research/evaluation/verdict stages. Add upstream golden tests proving local mode emits no commit/push/gist/issue/PR action. Store the patch and source/build digests; prefer an upstream published equivalent once available. Do not patch an installed user-global package.
- [ ] Use the real compiler and ledger package. Align configuration with `docs/adr`, real per-family evaluator commands and the proposed daily UTC schedule. Do not run the research-lite script or assume its dry-run is spend-free. Store original generated prompt plus its config/compiler identity.
- [ ] `runCycle` recalls prior outcomes, selects one falsifiable hypothesis, freezes evaluator inputs, launches isolated candidate work, evaluates, records critique and writes exactly one terminal verdict. The generated prose guides the agent; T04/T06 enforce authority even if the prose asks for something else. Use real AQE tools for testing work and record actual tool/host execution evidence.
- [ ] Test compiler mismatch, missing evaluator, missing credentials, timeout at each phase, denied publisher request, duplicate event and ledger failure. The authoritative terminal record is transactional; Dream Markdown ledger is regenerated/idempotently appended from that record, so a rendering failure cannot erase a completed run.
- [ ] Run Dream/cycle tests and three isolated manual cycles: accepted deterministic improvement, rejected regression and blocked/inconclusive run. Gate G2: each leaves source-bound artifacts and a terminal record without a remote side effect.

## T11 — durable scheduler, global slots and Ruflo coordination

**Depends on:** T10. **Owner:** controller lane. **Deliverable:** recurring experiments that survive restart without duplicate writers.

**Files:** Create `src/control/queue.ts`, `src/control/scheduler.ts`, `src/control/slots.ts`, `src/control/events.ts`, `src/integrations/ruflo.ts`, `src/cli.ts`, `deploy/ak-lab.service`, `deploy/ak-lab.timer`, `tests/queue.test.ts`, `tests/scheduler.test.ts`, `tests/slots.test.ts`, `tests/integration/scheduler-restart.test.ts`.

**Interfaces:** `enqueueEvent({type,sourceRef,bucket,incidentId?}): string`; `claimNext(ownerId,epoch): LabEvent|null`; `runScheduledOnce(context): Promise<void>`; `acquireSlots(requestId,count): Promise<SlotLease>`; `releaseSlots(requestId): void`; `RufloPort.call(name,args): Promise<unknown>` uses a qualified MCP connection and validated discovered schemas. C9 defines event and slot types.

- [ ] Write an event deduplication test:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventQueue } from '../src/control/queue.ts';
test('queues the same source-change event once', () => {
  const queue = createEventQueue(':memory:');
  const event = { type:'source-changed', sourceRef:'sha256:'+'1'.repeat(64), bucket:'2026-09-12' };
  assert.equal(queue.enqueueEvent(event), queue.enqueueEvent(event));
  queue.close();
});
```

- [ ] Define `createEventQueue(database)` as the production queue facade, run `node --experimental-strip-types --test tests/queue.test.ts`, then implement unique dedup keys and transactional claims. Each claim binds owner/epoch, deadline and reconciled runtime identity.
- [ ] Discover Ruflo tool schemas and record registration separately from actual execution. Register bounded researcher/proposer/critic roles with the configured MCP server; native Claude/Codex workers perform the work. Missing coordination is an explicit unqualified live profile, not a fictional swarm. Reuse the configured transport; do not open a second unmanaged AgentDB driver.
- [ ] Implement minimal CLI: `inspect --json`, `plan --config --json`, `grant --proposal`, `run --once --config`, `enqueue --type --source-ref`, `pause`, `resume`, `report --run`. Grant activation requires the concrete operator-approved proposal; `resume` does not create authority. All verbs are new LAB commands, not new AK commands.
- [ ] Timer activation is a separate operation after G2 and grant approval. It invokes the absolute installed LAB artifact with `run --once`; nightly/event queues share the same controller lock. Cap all nested model activity through the global slot allocator, including independent model graders. Do not hold all slots in a parent waiting for its own child.
- [ ] Test two controllers, stale epochs, oversubscribed nested calls, timer/event collision, pause during verification, expired grant and restart with a surviving runtime. Reconcile/terminate before requeue; never infer stopped from a missing PID alone.
- [ ] Run queue/scheduler/slot suites and restart integration. Gate: at most one writer per candidate, four total available slots respected, no duplicate expensive execution, and every admitted job obtains a terminal record even on budget halt.

## T12 — bounded Darwin candidates and learned Router policies

**Depends on:** T09; scheduled retraining requires T11. **Owner:** learning lane. **Deliverable:** real learned policy candidates admitted only through independent LAB gates.

**Files:** Create `src/integrations/darwin.ts`, `src/integrations/router.ts`, `src/learning/dataset.ts`, `src/learning/embeddings.ts`, `src/learning/proposals.ts`, `src/learning/context-policy.ts`, `config/mutation-targets.json`, `tests/darwin.test.ts`, `tests/router.test.ts`, `tests/dataset.test.ts`, `tests/context-policy.test.ts`.

**Interfaces:** `proposeVariants(baseRef, context): Promise<string[]>`; `buildRoutingRows(outcomes, embeddings): RoutingRow[]`, with `RoutingRow={embedding:number[],scores:Record<string,number>}`; `trainRouter(rows,prices,options): RouterArtifact`; `chooseExperimentalRoute(artifact,embedding,catalog): RouteAdvice`; `embedFixture(fixtureRef,backend): Promise<{vector:number[];modelRef:string}>`; `materializeTask(fixtureRef,policy,exampleRetriever): Promise<string>` returns the content-addressed admitted task artifact.

- [ ] Write a missing-price guard because upstream otherwise defaults absent prices to zero:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { trainRouter } from '../src/integrations/router.ts';
test('refuses to train cost routing with an unpriced candidate', () => {
  const rows = [{ embedding:[1,0], scores:{'eligible-route':0.9} }];
  assert.throws(() => trainRouter(rows, {}, { qualityBar:0.8,
    embeddingModelRef:'sha256:'+'1'.repeat(64) }), /price/);
});
```

- [ ] Run `node --experimental-strip-types --test tests/router.test.ts`; then call actual `Router.fromExamples` after validating finite equal-dimension nonzero embeddings, quality range, prices and approved candidate IDs. Persist rows, model/backend identity, prices, options and artifact digest. Refuse `metBar:false` as an automatic recommendation.
- [ ] Obtain embeddings from the qualified existing Ruflo/RuVector facility; record actual backend/model/dimension and reject hash/random fallback vectors. Do not create a hand-written semantic index. Training data excludes acceptance shards and retains actual provider/model provenance. Validate with time-separated/project-separated outcomes and fixed-route baselines before allowing laboratory selection.
- [ ] Use real Darwin prompt-policy or numeric APIs for permitted targets only. Begin with context example count/retrieval depth within fixed ranges, or prompt surfaces whose external tool/score gates remain immutable. Permission ceilings, gate policy, hidden tests, invocation/time/spend ceilings, providers and default AK routes are never genes.
- [ ] Wire genes to actual behavior: `context.maxExamples` is an integer 0–4 and `context.retrievalDepth` is an integer 1–8. `materializeTask` queries only the approved training-example namespace through the real memory/retrieval port, selects at most `maxExamples`, excludes private labels, enforces the fixed task byte ceiling and seals the resulting task bytes. Route variants map catalog IDs to existing `--route` arguments. Code variants point to a sealed isolated source patch and explicitly select C4's source-comparison axis. A changed gene must change a recorded input or be rejected as a no-op; it must not merely change a scorecard label.
- [ ] Execute Darwin's external evaluator inside the qualified runtime: upstream inherited environment, unlimited output buffering or direct-PID timeout cannot weaken T04/T05 bounds. Its winner is provisional; re-evaluate through T09. Compare against a simple bounded parameter sweep before crediting Darwin with improvement.
- [ ] Test NaN/mismatched vectors, unknown prices, sparse task families, duplicate leaked labels, unavailable models, non-clearing predictions, forbidden genes, no-op variants, changed source on the wrong comparison axis and output overflow. Too few independent labels yields `insufficient-evidence`, not a fabricated cheap route.
- [ ] Run Darwin/Router/dataset tests plus held-out comparisons. Gate G3: learning alters only experimental policy artifacts and produces reproducible confidence/resource evidence without widening authority.

## T13 — real Autogenous JSONL observer and replay bridge

**Depends on:** T08; can proceed alongside T10–T12 in a separate workspace. **Owner:** Rust integration lane. **Deliverable:** a bounded wrapper around actual pinned Rust primitives.

**Files:** Create `rust/observer-bridge/Cargo.toml`, `rust/observer-bridge/Cargo.lock`, `rust/observer-bridge/src/main.rs`, `rust/observer-bridge/src/protocol.rs`, `rust/observer-bridge/src/operations.rs`, `rust/observer-bridge/tests/protocol.rs`, `src/integrations/autogenous.ts`, `src/observation/fixture-adapter.ts`, `tests/autogenous.test.ts`, `tests/fixtures/streams/`.

**Interfaces:** C8 JSONL protocol; `decodeFixtureRecord(host,record): string[]`; `invokeAutogenous(operation,body,context): Promise<object>`. Rust operations call actual observer/admission/generator/evaluator crates from the pinned source checkout, with lockfile and resulting binary digest recorded in qualification.

- [ ] Write transport-format separation before decoding fixtures:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFixtureRecord } from '../src/observation/fixture-adapter.ts';
test('ignores provider SSE passed as a Codex JSONL record', () => {
  assert.deepEqual(decodeFixtureRecord('codex', 'data: {"choices":[]}'), []);
});
```

- [ ] Run `node --experimental-strip-types --test tests/autogenous.test.ts`; implement explicit observed fixture dialects. Unknown event types are recorded/skipped, not guessed to contain model text. Only fixture content is admitted initially.
- [ ] Rust input reads are capped before allocating an entire line; serde tagged operations reject unknown fields. Call `StreamObserver::with_fingerprint_key`, `arm` and `observe_chunk`; require a real experimental fingerprint key supplied by the controller. Do not use deterministic demo signing/fingerprint keys outside synthetic tests.
- [ ] Bound record size, output size, in-flight requests and elapsed time per C8. Errors produce request ID plus closed code on stdout and bounded diagnostics on stderr. Wrap actual upstream outputs in a field-by-field DTO; never echo the input sample.
- [ ] Test chunk-boundary signatures, Unicode, long lines, malformed JSON/SSE, expired detector, benign quoted instruction, missing key, child crash and timeout. Run upstream fmt/clippy/tests against its pinned source before testing the bridge.
- [ ] Run `cargo test --locked --manifest-path rust/observer-bridge/Cargo.toml`, clippy with warnings denied, and Node adapter tests. Gate: real detectors run, no raw sample escapes, and observer failure cannot hang or mutate `ak run`.

## T14 — privacy-approved incident-to-candidate learning

**Depends on:** T09, T13; T11 connects events. **Owner:** observation/evaluation lane. **Deliverable:** automatic typed detector proposals from authorized samples.

**Files:** Create `src/observation/incidents.ts`, `src/observation/samples.ts`, `src/observation/propose.ts`, `src/observation/replay.ts`, `src/observation/event-source.ts`, `tests/samples.test.ts`, `tests/incidents.test.ts`, `tests/detector-learning.test.ts`.

**Interfaces:** `resolveSample(incidentRef,grantRef)` per C8; `processIncident(incidentRef,context): Promise<{state:'queued'|'sample-unavailable'|'denied';candidateRefs:string[]}>`; `evaluateDetector(candidateRef,corpusRef,context): Promise<EvaluationBundle>`. Incident records carry fingerprint, detector/trace identity, fixture reference when authorized, match codes and provenance; no implicit content capture.

- [ ] Write a fingerprint-only refusal test:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampleResolver } from '../src/observation/samples.ts';
test('cannot reconstruct a sample from a fingerprint-only incident', async () => {
  const resolver = createSampleResolver({ lookup:async()=>({ fingerprint:'abc' }) });
  assert.equal(await resolver.resolveSample('incident-1','grant-1'), null);
});
```

- [ ] Define the injected resolver as the production sample lookup port; run `node --experimental-strip-types --test tests/samples.test.ts`. Validate grant, source class, sample digest/size and training-only split before reading bytes. No raw-home transcript scanning is an allowed fallback.
- [ ] Call actual `autogenous_generator::propose` through T13 with sample, incident hash, parent genome identity, LAB signer and fixed TTL. Generator inputs never include acceptance labels. Record each candidate's exact detector artifact and expiry; reject unsupported/expired/authority-expanding mutations before replay.
- [ ] Replay independent benign and malicious fixtures with the actual evaluator; report confidence intervals and false positives. Route admissible candidates into T09; automatic selection changes only a shadow detector set. No real blocking/termination or upstream service promotion endpoint is connected.
- [ ] Add a metadata observer port over existing AK event exports without altering their privacy contract. Metadata can trigger fixture selection but cannot prove content-injection detection. Opt-in content observation is a separate admitted source profile; keep it disabled until sample/retention tests pass.
- [ ] Test denied source, acceptance-corpus access, expired candidate, repeated incident, missing sample, regression on benign quotes and live-event format drift. Gate G4: an incident becomes a testable proposal automatically, with measurable replay evidence and no production intervention.

## T15 — reports, learning outbox and optional draft publisher

**Depends on:** T11–T14; can initially ship without the optional publisher. **Owner:** integration agent. **Deliverable:** useful morning reports and persisted learning without uncontrolled side effects.

**Files:** Create `src/reporting/summary.ts`, `src/reporting/dream-ledger.ts`, `src/integrations/memory.ts`, `src/control/outbox.ts`, `src/publication/publisher.ts`, `tests/reporting.test.ts`, `tests/outbox.test.ts`, `tests/publisher.test.ts`.

**Interfaces:** `renderRunReport(runRef): string`; `renderDreamLedger(runRefs): string`; `deliverMemory(outboxId, RufloPort): Promise<void>`; `publishDraft(artifactRef,grant:PublicationGrant,PublisherPort): Promise<PublicationResult>`. C9 defines grant/result types; PublisherPort supplies `verifyGrant`, `verifyArtifact` and `createDraft`, and none is called for local-only publication.

- [ ] Write the no-publication-by-default contract:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishDraft } from '../src/publication/publisher.ts';
test('local mode performs no remote publication', async () => {
  const grant = { publication:'local' as const, grantRef:'sha256:'+'1'.repeat(64),
    epoch:1, artifactRefs:[], repository:null };
  const result = await publishDraft('sha256:'+'2'.repeat(64), grant, {
    verifyGrant:async()=>{ throw new Error('unexpected grant lookup'); },
    verifyArtifact:async()=>{ throw new Error('unexpected artifact lookup'); },
    createDraft:async()=>{ throw new Error('remote call forbidden'); }
  });
  assert.equal(result.state, 'local-only');
});
```

- [ ] Run `node --experimental-strip-types --test tests/publisher.test.ts`; implement the exact C9 PublicationGrant/PublicationResult contract. Check local mode before credential lookup/network calls; the draft path independently verifies the grant reference and artifact scope.
- [ ] Render facts separately: static fit, verifier outcomes, provider provenance, cost kind, source freshness, search winner, accepted champion, memory delivery and optional publication. Include every REJECT/INCONCLUSIVE and its next experimental implication. No “self-healed” or “saved USD” claim without corresponding measured evidence.
- [ ] Use the real Dream ledger package to validate/render its row vocabulary. Reconcile by run ID through the journal to avoid duplicate nightly rows. The report links to immutable evidence; raw prompts and samples are absent.
- [ ] Deliver AgentDB learning references via configured Ruflo `memory_store`, using deterministic project/experiment keys, agent-output provenance and source citations. Retry outbox delivery idempotently, verify readback, and never rerun evaluation to repair memory delivery. Actual tool absence is visible as pending/unavailable.
- [ ] Optional publisher requires a separate preapproved draft-PR grant and credential outside candidate images. Verify artifact/source/decision digests immediately before creating one draft. No gists, force-push, merge or release; stale input requires reevaluation. Cap open proposals at two while retaining offline learning throughput.
- [ ] Run report/outbox/publisher tests. Gate: reports explain what happened, memory outages preserve work, and local mode cannot invoke any remote publisher operation.

## T16 — champion rollback, freshness and crash recovery

**Depends on:** T09, T11, T15. **Owner:** integration/reliability lane. **Deliverable:** observable recovery and rollback without losing evidence or authority.

**Files:** Create `src/control/recovery.ts`, `src/control/rollback.ts`, `src/evidence/freshness.ts`, `src/control/retention.ts`, `tests/rollback.test.ts`, `tests/freshness.test.ts`, `tests/integration/recovery.test.ts`, `tests/retention.test.ts`.

**Interfaces:** `reconcileAfterRestart(context): Promise<RecoveryReport>`; C6 `ChampionStore.rollback`; `checkFreshness(binding,current): {fresh:boolean;changedRefs:string[]}`; `planRetention(policy): RetentionPlan`; `applyRetention(plan,grant): Promise<void>`. RecoveryReport enumerates restored, cancelled, uncertain and blocked run IDs; RetentionPlan lists exact artifact references and retention reasons.

- [ ] Write stale-evidence refusal:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFreshness } from '../src/evidence/freshness.ts';
import { sourceBindingFixture } from './helpers.ts';
test('invalidates evidence after verifier identity changes', () => {
  const baseline = sourceBindingFixture();
  const current = { ...baseline, verifierDigest:'sha256:'+'f'.repeat(64) };
  assert.equal(checkFreshness(baseline, current).fresh, false);
});
```

- [ ] Run `node --experimental-strip-types --test tests/freshness.test.ts`; implement full C4 binding comparison, read-set/source digest checks and grant/epoch validation. Use qualified Dream freshness support where available; missing source-only features do not silently become a successful freshness result.
- [ ] Recheck the experimental champion on its anchor at the next admitted cycle. A verified regression triggers compare-and-swap rollback to the last still-valid parent and a signed reason receipt. If no parent passes current invariants, suspend that family and use the immutable baseline only if it is still qualified.
- [ ] On restart, reconcile containers before granting claims, restore settled and reserved resource accounting, verify all checkpoint references and reject stale resume states. A swallowed upstream checkpoint error cannot override journal truth. Unknown detached runtime state is blocked and never requeued as fresh work.
- [ ] Retain accepted lineage/rollback evidence while referenced; default raw samples are not retained. Proposed nonreferenced evidence retention is 30 days, rejected candidate artifacts 14 days, grants/decision records 90 days. Do not automatically delete worktrees without a matching cleanup grant; preserve failed/dirty worktrees and stop new work on storage ceiling. Preview deletion with exact IDs; never force-remove recovery evidence.
- [ ] Run real process-kill and disk-failure recovery tests, alongside freshness/rollback/retention tests. Gate: no stale selection, silent data loss, budget reset, duplicate writing execution or successful rollback without a verified pointer transition.

## T17 — artifact, CI and unattended qualification

**Depends on:** T16. **Owner:** integration owner with independent real AQE validation. **Deliverable:** a deployable LAB artifact and an evidence-backed decision to activate its schedule.

**Files:** Create LAB `.github/workflows/ci.yml`, `docs/OPERATIONS.md`, `docs/QUALIFICATION.md`, `tests/artifact.test.ts`, `tests/integration/end-to-end.test.ts`; finish `src/verify-artifact.ts`, `deploy/ak-lab.service` and `deploy/ak-lab.timer`. Modify AK `docs/METAHARNESS-COMPANION-PROPOSAL.md` and ADR-0022 only to record actual completed gates and evidence after implementation.

**Interfaces:** `verifyLabArtifact(artifactPath): Promise<{valid:boolean;reasonCodes:string[]}>`; end-to-end runner invokes the public CLI only. No private cross-repository imports or monkey-patching installed tools.

- [ ] Write an artifact rejection test in `tests/artifact.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPackagePath } from '../src/verify-artifact.ts';
test('excludes operational databases from the distributed package', () => {
  assert.equal(isAllowedPackagePath('state/journal.sqlite'), false);
});
```

- [ ] Implement `isAllowedPackagePath(path)` and run `node --experimental-strip-types --test tests/artifact.test.ts`. Verify real tarball contents, hashes and dependencies; exclude grants, keys, journals, corpora marked private, candidate worktrees and raw transcripts.
- [ ] CI runs typecheck, unit tests, artifact build, independent Rust checks and deterministic integration. Container isolation gets an explicit Linux job; AK export/cancellation runs on Linux/macOS/Windows through the existing matrix. Live-provider checks are opt-in and cannot receive secrets from untrusted pull requests.
- [ ] Execute all core and companion gates from the master against exact artifacts. Validate known upstream failure paths: Dream local-output absence, MetaHarness package/schema drift, omitted Router price, Flywheel checkpoint exception and Autogenous persistence/service limitations. Unsupported optional components must be visibly disabled rather than simulated as passing.
- [ ] Document setup, grant activation/revocation, nightly/event triggers, global slot accounting, budget status, report interpretation, missing authentication, sample consent, restart reconciliation, rollback, backup and retention. Include an explicit removal test proving all ordinary AK commands work after LAB is stopped and detached.
- [ ] Activate only the exact qualified artifact after the existing explicit schedule/spend grant. Observe at least fourteen cycles or fourteen days, whichever is longer; inject one expired grant, provider outage, process interruption, storage failure and corrupt artifact using isolated fixtures. Record run IDs and actual terminal evidence.
- [ ] Gate G5: zero unauthorized production/configuration/publication changes, zero unaccounted live calls, no lost admitted run records, no unverified champion transitions, and useful reports including negative outcomes. Mark uncertain capabilities unqualified. Release/publication of LAB remains a separate user-authorized operation.

## T18 — graduation bundle and protected GitHub proposal

**Depends on:** T17 and separately accepted ADR-0022 amendment. **Owner:** integration owner. **Deliverable:** a sealed laboratory candidate can create a draft PR that GitHub independently verifies, without granting LAB merge authority.

**Files:**

- Create: LAB src/graduation/bundle.ts
- Create: LAB src/graduation/publisher.ts
- Create: LAB src/graduation/reverify.ts
- Create: LAB tests/graduation.test.ts
- Create: AK .github/workflows/graduation.yml
- Create: AK .github/workflows/graduation-reusable.yml
- Modify: AK docs/adr/0022-metaharness-as-optional-assurance-companion.md only after design acceptance

**Interfaces:** C10 GraduationBundle, GraduationDecision and publishGraduation. The reusable workflow accepts bundle-ref, expected-main-sha and patch-digest as strings, then emits verified and attestation digest. It receives no raw prompt, credential, mutable path or shell fragment.

- [ ] **Step 1: Write the single-use nonce test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishGraduation } from '../src/graduation/publisher.ts';

test('denies a graduation bundle already consumed by a draft PR', async () => {
  const publisher = {
    verify: async () => ({ nonce: 'fixture-nonce' }),
    consumeNonce: async () => false,
  };
  const result = await publishGraduation('sha256:' + '1'.repeat(64), { publication: 'draft-pr' } as any, publisher as any);
  assert.equal(result.state, 'denied');
});
```

- [ ] **Step 2: Run the focused test**

Run: node --experimental-strip-types --test tests/graduation.test.ts

Expected: failure because the publisher module is absent.

- [ ] **Step 3: Implement bundle validation and publication planning**

Validate every C10 field, receipt signature, one-use nonce, expiry, active grant epoch, expected main SHA, patch digest and evidence reference. Return stale, expired or denied before network access. Create only one branch named from a validated candidate ID and one draft PR. Never force-push, merge, tag, publish packages, change rules or edit project configuration.

- [ ] **Step 4: Add independent GitHub verification**

Use pull request and merge group triggers for candidate verification, contents read permission, unique check names and no secrets. Rebuild the actual PR commit, validate the bundle and changed paths, run relevant checks and then create a provenance attestation with the documented minimum permissions. Do not use pull request target to execute candidate code. Put shared checks in a typed reusable workflow with named secrets only.

- [ ] **Step 5: Test stale, altered and privileged paths**

Test invalid signature, stale main SHA, altered patch, missing evidence, duplicate nonce, network ambiguity, untrusted artifact, required-check omission and merge-queue trigger. Use a synthetic no-op draft PR before evaluating a real candidate.

- [ ] **Step 6: Run the graduation gate**

Run: node --experimental-strip-types --test tests/graduation.test.ts

Expected: GitHub independently reruns the synthetic proposed commit; duplicate and stale attempts fail; normal protected PR review remains required.
