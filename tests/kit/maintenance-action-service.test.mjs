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
    async inspectCurrent() { return { postFingerprint: fingerprint() }; },
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

test('sealed plan envelopes are private, content-safe, expire, and detect tampering', (t) => {
  const root = fixture(t);
  const plan = buildExecutableMaintenancePlan({
    findings: [finding()], actions: [nativeAction()], sourceFingerprint: 'catalog-source-a', now: () => NOW,
  });
  const file = writeMaintenancePlanEnvelope(root, plan);
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

test('scan and read-only planning do not create the maintenance control root', async (t) => {
  const root = path.join(fixture(t), 'not-created');
  const collector = { async read() { return footprint(); } };
  const service = createMaintenanceService({ collector, providers: new Map(), now: () => NOW, controlRoot: root });
  const model = await service.scan();
  await service.plan({ findingIds: [model.findings[0].id] });
  assert.equal(fs.existsSync(root), false);
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

test('service applies exact confirmed selection, refreshes catalog before success, sanitizes receipt, and refuses replay', async (t) => {
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

test('catalog refresh failure cannot masquerade as success and triggers reversible compensation', async (t) => {
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

test('service undo preview and execution guard the recorded postimage and are idempotent', async (t) => {
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

test('default registry reports unsupported OpenCode surfaces without fabricating a provider', () => {
  const registry = createDefaultMaintenanceProviderRegistry();
  assert.equal(registry.has('opencode-plugin'), false);
  assert.equal(registry.has('opencode-mcp'), false);
  assert.equal(registry.has('agentic-kit-owned-skill'), false);
  assert.equal(registry.has('agentic-kit-npx-cache'), false);
  const capabilities = publicMaintenanceProviders(registry, { includeUnsupported: true });
  assert.equal(capabilities.some((item) => item.host === 'opencode' && item.status === 'unsupported'), true);
});
