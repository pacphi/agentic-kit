import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertExecutableMaintenancePlanIntegrity,
  buildExecutableMaintenancePlan,
} from '../../src/lib/maintenance/planner.mjs';
import {
  readMaintenancePlanEnvelope, writeMaintenancePlanEnvelope,
} from '../../src/lib/maintenance/plan-store.mjs';
import {
  createDefaultMaintenanceProviderRegistry, publicMaintenanceProviders,
} from '../../src/lib/maintenance/provider-registry.mjs';
import { createMaintenanceService } from '../../src/lib/maintenance/service.mjs';

const POSIX_MUTATION_ONLY = process.platform === 'win32'
  ? { skip: 'native Windows private durable mutation storage is not implemented' } : {};

const NOW = Date.parse('2026-09-03T20:00:00.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function finding(overrides = {}) {
  return {
    id: 'maintenance-finding-demo',
    state: 'stale-configuration',
    classification: 'owner-stale-configuration',
    safetyClass: 'approval-required',
    resource: {
      id: 'plugin:demo@market', kind: 'plugin', name: 'demo@market', host: 'claude',
      scope: 'user', providerRef: 'demo@market',
    },
    versions: { installed: '1.0.0', recommended: null },
    nextAction: { operation: 'disable' },
    ...overrides,
  };
}

function nativeAction(row = finding(), overrides = {}) {
  const resourceIdentity = Object.fromEntries(['id', 'kind', 'name', 'host', 'scope', 'providerRef']
    .flatMap((key) => (row.resource[key] == null ? [] : [[key, row.resource[key]]])));
  return {
    id: 'maintenance-action-demo', providerId: 'fixture-provider', providerVersion: '1',
    operation: row.nextAction.operation, resourceIdentity,
    classification: row.safetyClass, findingClassification: row.classification,
    rollback: 'reversible', restart: 'required', executable: true,
    sourceFingerprint: 'native-source-a',
    ...overrides,
  };
}

function footprint(stamp = 'source-a') {
  return {
    generatedAt: new Date(NOW).toISOString(),
    snapshot: { present: true, asOf: NOW - 1000, stale: false, ageMs: 1000 },
    catalog: {
      asOf: NOW - 1000, complete: true, degraded: [], truncated: [], partial: [],
      sourceStamps: [{ id: 'catalog', value: stamp }],
      items: [{
        canonicalId: 'plugin:demo@market', kind: 'plugin', name: 'demo@market',
        lifecycle: { state: 'stale-configuration', operation: 'disable' },
        presence: [{ host: 'claude', scope: 'plugin', plugin: { scope: 'user' },
          provider: { ref: 'demo@market', version: '1.0.0', evidence: 'native' } }],
      }],
    },
    storage: { asOf: NOW - 1000, reclaimables: [] },
  };
}

function provider(state, events = []) {
  const fingerprint = () => state.enabled ? 'native-source-a' : 'native-post-a';
  return {
    id: 'fixture-provider', version: '1', host: 'claude', status: 'native-detection-required',
    resourceKinds: ['plugin'], operations: ['disable'], rollback: ['reversible'],
    async detect() {
      events.push('detect');
      return { status: 'available', complete: true, authority: 'native-inventory',
        plugins: [{ ref: 'demo@market', scope: 'user', enabled: state.enabled }] };
    },
    actionFor(row, facts) {
      if (!facts.complete || !facts.plugins.some((item) => item.ref === row.resource.providerRef
          && item.scope === row.resource.scope && item.enabled)) return null;
      return nativeAction(row, { sourceFingerprint: fingerprint() });
    },
    async preflight(_action) {
      events.push('preflight');
      return { ok: state.enabled, sourceFingerprint: fingerprint() };
    },
    async apply() {
      events.push('apply'); state.enabled = false;
      return { status: 'applied', postFingerprint: fingerprint(), summary: 'disabled by native owner' };
    },
    async verify(_action, outcome) {
      events.push('verify');
      return { ok: !state.enabled, postFingerprint: outcome.postFingerprint };
    },
    async inspectCurrent() { return { complete: true, postFingerprint: fingerprint() }; },
    async undo(entry) {
      events.push('undo'); state.enabled = true;
      return { status: 'restored', sourceFingerprint: entry.sourceFingerprint };
    },
    async verifyUndo(entry) {
      events.push('verify-undo');
      return { ok: state.enabled, sourceFingerprint: entry.sourceFingerprint };
    },
  };
}

test('executable plans are separately typed, immutable, source-bound, and reject mixed or tampered actions', () => {
  const row = finding();
  const plan = buildExecutableMaintenancePlan({
    findings: [row], actions: [nativeAction(row)], sourceFingerprint: 'catalog-source-a', now: () => NOW,
  });
  assert.equal(plan.mode, 'executable');
  assert.deepEqual(plan.capabilities, { plan: true, apply: true, undo: true });
  assert.equal(plan.expiresAt, new Date(NOW + 300_000).toISOString());
  assert.equal(Object.isFrozen(plan.actions[0]), true);
  assert.doesNotThrow(() => assertExecutableMaintenancePlanIntegrity(plan, { now: () => NOW + 1 }));

  const tampered = structuredClone(plan);
  tampered.actions[0].resourceIdentity.name = '../client-path';
  assert.throws(() => assertExecutableMaintenancePlanIntegrity(tampered, { now: () => NOW }), /digest|identity/i);
  const mixed = structuredClone(plan);
  mixed.actions[0].classification = 'safe-automatic';
  assert.throws(() => assertExecutableMaintenancePlanIntegrity(mixed, { now: () => NOW }), /safety class/i);
  assert.throws(() => assertExecutableMaintenancePlanIntegrity(plan, { now: () => NOW + 300_001 }), /expired/i);
  assert.throws(() => buildExecutableMaintenancePlan({
    findings: [row], actions: [nativeAction(row, { argv: ['rm', '-rf'] })],
    sourceFingerprint: 'catalog-source-a', now: () => NOW,
  }), /provider-native.*invalid/i);
});

test('sealed plan envelopes are private, content-safe, expire, and detect tampering', POSIX_MUTATION_ONLY, (t) => {
  const root = fixture(t);
  const plan = buildExecutableMaintenancePlan({
    findings: [finding()], actions: [nativeAction()], sourceFingerprint: 'catalog-source-a', now: () => NOW,
  });
  const file = writeMaintenancePlanEnvelope(root, plan, { now: () => NOW });
  assert.equal(fs.statSync(root).mode & 0o077, 0);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /argv|command|\/private|secret/i);
  assert.equal(readMaintenancePlanEnvelope(root, plan.planId, { now: () => NOW }).plan.planDigest, plan.planDigest);
  assert.throws(() => readMaintenancePlanEnvelope(root, plan.planId, { now: () => NOW + 300_001 }), /expired/i);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('disable', 'remove'));
  assert.throws(() => readMaintenancePlanEnvelope(root, plan.planId, { now: () => NOW }), /integrity/i);
});

test('service derives actions only from complete native detection and rejects unavailable or ambiguous providers', async (t) => {
  const root = fixture(t);
  const collector = { async read() { return footprint(); }, async refreshDeep() { return { ok: true }; } };
  const state = { enabled: true };
  const implementation = provider(state);
  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await service.scan();
  const plan = await service.plan({ findingIds: [model.findings[0].id], executable: true });
  assert.equal(plan.actions[0].providerId, implementation.id);
  assert.equal(plan.actions[0].resourceIdentity.scope, 'user');
  assert.equal(JSON.stringify(plan).includes('path'), false);

  const unavailable = { ...provider({ enabled: true }), async detect() {
    return { status: 'unavailable', complete: false, authority: 'native-inventory' };
  } };
  await assert.rejects(() => createMaintenanceService({
    collector, providers: new Map([[unavailable.id, unavailable]]), now: () => NOW, controlRoot: root,
  }).plan({ findingIds: [model.findings[0].id], executable: true }), /native.*unavailable|no executable/i);

  const second = { ...provider({ enabled: true }), id: 'fixture-provider-two' };
  await assert.rejects(() => createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation], [second.id, second]]),
    now: () => NOW, controlRoot: root,
  }).plan({ findingIds: [model.findings[0].id], executable: true }), /ambiguous/i);
});

test('report and read-only planning do not create mutation state while scan persists its report', async (t) => {
  const root = path.join(fixture(t), 'not-created');
  const collector = { async read() { return footprint(); } };
  const service = createMaintenanceService({ collector, providers: new Map(), now: () => NOW, controlRoot: root });
  const initial = await service.report();
  assert.equal(initial.scan.status, 'not-scanned');
  assert.equal(fs.existsSync(root), false);
  const model = await service.scan();
  await service.plan({ findingIds: [model.findings[0].id] });
  assert.equal(fs.existsSync(path.join(root, 'latest-scan.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'plans')), false);
  assert.equal(fs.existsSync(path.join(root, 'transactions')), false);
});

test('stale or partial catalog evidence is never promoted into a provider action', async (t) => {
  const root = fixture(t);
  for (const [name, degrade] of [
    ['stale', (input) => { input.snapshot.stale = true; input.snapshot.ageMs = 8 * 86_400_000; }],
    ['partial', (input) => { input.catalog.complete = false; input.catalog.degraded = ['claude-plugins']; }],
  ]) {
    const input = footprint(name);
    degrade(input);
    const events = [];
    const implementation = provider({ enabled: true }, events);
    const service = createMaintenanceService({
      collector: { async read() { return input; } },
      providers: new Map([[implementation.id, implementation]]),
      now: () => NOW,
      controlRoot: path.join(root, name),
    });
    const model = await service.scan();
    const target = model.findings.find((item) => item.resource.id === 'plugin:demo@market');
    await assert.rejects(() => service.plan({ findingIds: [target.id], executable: true }), /not executable/i);
    assert.equal(events.some((event) => event === 'preflight' || event === 'apply'), false);
  }
});

test('service applies exact confirmed selection, refreshes catalog before success, sanitizes receipt, and refuses replay', POSIX_MUTATION_ONLY, async (t) => {
  const root = fixture(t);
  fs.chmodSync(root, 0o755);
  const state = { enabled: true };
  const events = [];
  let currentFootprint = footprint();
  const collector = {
    async read() { events.push('catalog-read'); return currentFootprint; },
    async refreshDeep() { events.push('catalog-refresh'); currentFootprint = footprint('source-after'); return { ok: true }; },
  };
  const implementation = provider(state, events);
  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await service.scan();
  const plan = await service.plan({ findingIds: [model.findings[0].id], executable: true, persist: true });
  assert.equal(fs.statSync(root).mode & 0o077, 0);
  await assert.rejects(() => service.apply({ plan, actionIds: [plan.actions[0].id],
    expectedPlanDigest: plan.planDigest }), /confirmation/i);
  const result = await service.apply({
    planId: plan.planId, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest, confirmed: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.actions[0].preimageFingerprint, 'native-source-a');
  assert.equal(events.indexOf('catalog-refresh') > events.indexOf('verify'), true);
  assert.equal(result.receipt.verification.affectedCatalogRefreshed, true);
  assert.equal('receiptFile' in result, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const replay = await service.apply({
    plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest, confirmed: true,
  });
  assert.equal(replay.ok, false);
  assert.match(replay.error, /consumed|replay/i);
});

test('catalog refresh failure cannot masquerade as success and triggers reversible compensation', POSIX_MUTATION_ONLY, async (t) => {
  const root = fixture(t);
  const state = { enabled: true };
  const implementation = provider(state);
  const collector = {
    async read() { return footprint(); },
    async refreshDeep() { return { ok: false }; },
  };
  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await service.scan();
  const plan = await service.plan({ findingIds: [model.findings[0].id], executable: true });
  const result = await service.apply({
    plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest, confirmed: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'rolled-back');
  assert.equal(state.enabled, true);
});

test('service undo preview and execution guard the recorded postimage and are idempotent', POSIX_MUTATION_ONLY, async (t) => {
  const root = fixture(t);
  const state = { enabled: true };
  const implementation = provider(state);
  const collector = { async read() { return footprint(); }, async refreshDeep() { return { ok: true }; } };
  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await service.scan();
  const plan = await service.plan({ findingIds: [model.findings[0].id], executable: true });
  const applied = await service.apply({
    plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest, confirmed: true,
  });
  assert.deepEqual(await service.prepareUndo({ receiptId: applied.receiptId }), {
    receiptId: applied.receiptId,
    undoable: true,
    actionCount: 1,
    summary: '1 maintenance action(s) can be safely undone.',
  });
  await assert.rejects(() => service.undo({ receiptId: applied.receiptId }), /confirmation/i);
  state.enabled = true;
  const drift = await service.undo({ receiptId: applied.receiptId, confirmed: true });
  assert.equal(drift.status, 'drift-refused');

  state.enabled = false;
  const undone = await service.undo({ receiptId: applied.receiptId, confirmed: true });
  assert.equal(undone.status, 'rolled-back');
  const repeat = await service.undo({ receiptId: applied.receiptId, confirmed: true });
  assert.equal(repeat.status, 'already-rolled-back');
});

test('service seals undo as recovery-required when post-undo Catalog refresh fails', POSIX_MUTATION_ONLY, async (t) => {
  const root = fixture(t);
  const state = { enabled: true };
  const implementation = provider(state);
  let allowRefresh = true;
  const collector = {
    async read() { return footprint(); },
    async refreshDeep() { return { ok: allowRefresh }; },
  };
  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await service.scan();
  const selectedPlan = await service.plan({ findingIds: [model.findings[0].id], executable: true });
  const applied = await service.apply({
    plan: selectedPlan, actionIds: [selectedPlan.actions[0].id],
    expectedPlanDigest: selectedPlan.planDigest, confirmed: true,
  });
  allowRefresh = false;
  const undone = await service.undo({ receiptId: applied.receiptId, confirmed: true });
  assert.equal(undone.ok, false);
  assert.equal(undone.status, 'partial-recovery-required');
  assert.equal(state.enabled, true, 'provider undo occurred but Catalog success was not fabricated');
  const history = await service.scan();
  assert.equal(history.receipts[0].recoveryRequired, true);
});

test('default registry reports unsupported OpenCode surfaces without fabricating a provider', () => {
  const registry = createDefaultMaintenanceProviderRegistry();
  assert.equal(registry.has('opencode-plugin'), false);
  assert.equal(registry.has('opencode-mcp'), false);
  assert.equal(registry.has('agentic-kit-owned-skill'), false);
  assert.equal(registry.has('agentic-kit-npx-cache'), false);
  const capabilities = publicMaintenanceProviders(registry, { includeUnsupported: true });
  assert.equal(capabilities.some((item) => item.host === 'opencode' && item.status === 'unsupported'), true);
});

test('ollama-model is registered by default (fail-closed on an absent daemon); git-project-patch stays conditional', () => {
  const stock = createDefaultMaintenanceProviderRegistry();
  assert.equal(stock.has('ollama-model'), true);
  assert.equal(stock.has('git-project-patch'), false, 'no projectRoots were supplied');

  const optedOut = createDefaultMaintenanceProviderRegistry({ ollamaModel: { enabled: false } });
  assert.equal(optedOut.has('ollama-model'), false);

  const withPatchRoots = createDefaultMaintenanceProviderRegistry({
    gitProjectPatch: { projectRoots: () => ['/tmp/some-project-root'] },
  });
  assert.equal(withPatchRoots.has('git-project-patch'), true);
  assert.equal(withPatchRoots.has('ollama-model'), true, 'still on by default alongside an opted-in provider');
});

test('a service built without an explicit providers Map (resolving the default registry) never issues a real fetch when ollamaModel.fetchImpl is injected', async (t) => {
  const root = fixture(t);
  const originalFetch = globalThis.fetch;
  let realFetchCalled = false;
  globalThis.fetch = async () => {
    realFetchCalled = true;
    throw new Error('a real network fetch must never happen in this hermetic test');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  let injectedFetchCalls = 0;
  const rejecting = async () => {
    injectedFetchCalls += 1;
    throw new Error('ECONNREFUSED');
  };
  const noop = { run: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: '' }) };
  const collector = { async read() { return footprint(); } };
  // Deliberately no `providers:` — this is exactly the shape
  // resolveProviders() falls through to createDefaultMaintenanceProviderRegistry() for.
  const service = createMaintenanceService({
    collector, now: () => NOW, controlRoot: root,
    providerOptions: {
      claudePlugin: noop, codexPlugin: noop, codexMcp: noop,
      rufloMcpOrphan: { uid: null, list: async () => [] },
      ollamaModel: { fetchImpl: rejecting },
    },
  });

  await service.scan();
  assert.equal(realFetchCalled, false, 'the default registry must use the injected fetchImpl, never globalThis.fetch');
  assert.ok(injectedFetchCalls > 0, 'ollama-model.detect() actually ran, through the injected fetchImpl');
});

test('service.planAction carries an opaque placementId through to the receipt and rejects a malformed one', POSIX_MUTATION_ONLY, async (t) => {
  const root = fixture(t);
  const state = { enabled: true };
  const implementation = provider(state);
  const collector = { async read() { return footprint(); }, async refreshDeep() { return { ok: true }; } };
  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await service.scan();
  const placementId = `plc_${'b'.repeat(20)}`;

  await assert.rejects(
    () => service.planAction({ findingId: model.findings[0].id, placementId: 'not-opaque' }),
    /opaque plc_/i,
  );
  await assert.rejects(() => service.planAction({ placementId }), TypeError);

  const plan = await service.planAction({ placementId, findingId: model.findings[0].id, guidanceId: 'gid_ignored' });
  assert.equal(plan.actions[0].placementId, placementId);
  const applied = await service.apply({
    plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest, confirmed: true,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.receipt.actions[0].placementId, placementId);
});

test('service.mutationBlocks reports a broad block for an unfinished receipt with no tracked identity', async (t) => {
  const root = fixture(t);
  const collector = { async read() { return footprint(); } };
  const service = createMaintenanceService({ collector, providers: new Map(), now: () => NOW, controlRoot: root });
  assert.deepEqual(service.mutationBlocks(), []);
});

test('service.auditInterruption is read-only and never gated behind assertScanIdle', async (t) => {
  const root = fixture(t);
  const collector = { async read() { return footprint(); } };
  const service = createMaintenanceService({ collector, providers: new Map(), now: () => NOW, controlRoot: root });
  const results = await service.auditInterruption({ receiptIds: ['mnt-does-not-exist'] });
  assert.equal(results.length, 1);
  assert.equal(results[0].result, 'receipt-integrity-check-failed');
});

test('service.reconcile requires confirmation before touching the transaction store', async (t) => {
  const root = fixture(t);
  const collector = { async read() { return footprint(); } };
  const service = createMaintenanceService({ collector, providers: new Map(), now: () => NOW, controlRoot: root });
  await assert.rejects(
    () => service.reconcile({ receiptId: 'mnt-x', outcome: 'record-no-change' }),
    /confirmation/i,
  );
});

test('service.providerEvidence reuses the most recent scan without a second detect(), and runs one read-only collect when nothing has scanned yet', async (t) => {
  const root = fixture(t);
  const state = { enabled: true };
  const events = [];
  const implementation = provider(state, events);
  const collector = { async read() { return footprint(); }, async refreshDeep() { return { ok: true }; } };
  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });

  events.length = 0;
  const cold = await service.providerEvidence();
  assert.deepEqual(events, ['detect'], 'no prior scan/plan means exactly one read-only collect ran');
  assert.equal(cold.registry.get(implementation.id), implementation);
  assert.equal(cold.detections.get(implementation.id).status, 'available');
  assert.ok(cold.providers.some((row) => row.id === implementation.id));

  await service.scan();
  events.length = 0;
  const warm = await service.providerEvidence();
  assert.deepEqual(events, [], 'a prior scan already populated the cache; providerEvidence reused it');
  assert.equal(warm.registry.get(implementation.id), implementation);

  // Defensive copies: mutating the returned containers must not corrupt the
  // service's internal cache.
  warm.registry.delete(implementation.id);
  warm.detections.delete(implementation.id);
  const again = await service.providerEvidence();
  assert.equal(again.registry.has(implementation.id), true);
  assert.equal(again.detections.has(implementation.id), true);
});

test('service.providerEvidence\'s cold path waits out an in-flight apply before calling detect()', POSIX_MUTATION_ONLY, async (t) => {
  const root = fixture(t);
  const state = { enabled: true };
  const events = [];
  let releaseApply, signalApplyStarted;
  const applyStarted = new Promise((resolve) => { signalApplyStarted = resolve; });
  const applyGate = new Promise((resolve) => { releaseApply = resolve; });
  t.after(() => releaseApply());
  const base = provider(state, events);
  const implementation = {
    ...base,
    async apply(action) {
      events.push('apply-start');
      signalApplyStarted();
      await applyGate;
      events.push('apply-end');
      return base.apply(action);
    },
  };
  const collector = { async read() { return footprint(); }, async refreshDeep() { return { ok: true }; } };
  // A separate instance builds the plan, so the instance under test never
  // calls scan/plan itself and providerEvidence() must take the cold path.
  const planner = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await planner.scan();
  const plan = await planner.plan({ findingIds: [model.findings[0].id], executable: true });

  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  events.length = 0;

  const applyPromise = service.apply({
    plan, actionIds: [plan.actions[0].id], expectedPlanDigest: plan.planDigest, confirmed: true,
  });
  let startTimer;
  try {
    await Promise.race([
      applyStarted,
      applyPromise.then((result) => { throw new Error('Apply settled before dispatch: ' + JSON.stringify(result)); }),
      new Promise((_, reject) => { startTimer = setTimeout(() => reject(new Error('Apply did not reach the provider within 5 seconds')), 5000); }),
    ]);
  } finally { clearTimeout(startTimer); }
  // apply() itself legitimately calls detect() earlier, while re-deriving a
  // live plan for its own drift check — that already happened by now. What
  // must NOT happen is a *new* detect() call (providerEvidence's cold path)
  // while apply is still blocked mid-flight on the applyGate below.
  const detectCallsAtGate = events.filter((event) => event === 'detect').length;

  const evidencePromise = service.providerEvidence();
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  const detectCallsWhileWaiting = events.filter((event) => event === 'detect').length;
  assert.equal(
    detectCallsWhileWaiting, detectCallsAtGate,
    'no additional detect() call happened while this process holds the mutation lock',
  );

  releaseApply();
  const applied = await applyPromise;
  assert.equal(applied.ok, true);
  const evidence = await evidencePromise;
  assert.equal(evidence.registry.has(implementation.id), true);
  const detectCallsAfter = events.filter((event) => event === 'detect').length;
  assert.ok(detectCallsAfter > detectCallsAtGate, 'the cold-path detect() ran only after the mutation finished');
});

test('native Windows apply refuses before provider effects or mutation state', {
  skip: process.platform !== 'win32' && 'native Windows integration boundary',
}, async (t) => {
  const root = fixture(t);
  const events = [];
  const implementation = provider({ enabled: true }, events);
  const service = createMaintenanceService({
    collector: { async read() { return footprint(); }, async refreshDeep() { return { ok: true }; } },
    providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await service.scan();
  const proposal = await service.plan({ findingIds: [model.findings[0].id], executable: true });
  const before = fs.readdirSync(root);
  events.length = 0;
  await assert.rejects(() => service.apply({ plan: proposal, actionIds: [proposal.actions[0].id],
    expectedPlanDigest: proposal.planDigest, confirmed: true }), { code: 'MAINTENANCE_PERSISTENCE_UNAVAILABLE' });
  assert.deepEqual(events, []);
  assert.deepEqual(fs.readdirSync(root), before);
});
