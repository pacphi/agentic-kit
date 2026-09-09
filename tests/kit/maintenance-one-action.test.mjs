// MNT-ACT-001: every write plan/apply/reconcile carries exactly one action
// and one exact placement, in the planner, the coordinator, and the service
// (CLI/API-shaped requests), and the refusal happens before any provider
// call, mutation lock, or journal write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyMaintenancePlan } from '../../src/lib/maintenance/coordinator.mjs';
import {
  assertExecutableMaintenancePlanIntegrity, buildExecutableMaintenancePlan, buildMaintenancePlan,
} from '../../src/lib/maintenance/planner.mjs';
import { createMaintenanceService } from '../../src/lib/maintenance/service.mjs';

const NOW = Date.parse('2026-09-05T12:00:00.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-one-action-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function finding(id, overrides = {}) {
  return {
    id,
    state: 'stale-configuration',
    classification: 'owner-stale-configuration',
    safetyClass: 'approval-required',
    resource: {
      id: `plugin:${id}@market`, kind: 'plugin', name: `${id}@market`, host: 'claude',
      scope: 'user', providerRef: `${id}@market`,
    },
    versions: { installed: '1.0.0', recommended: null },
    nextAction: { operation: 'disable' },
    ...overrides,
  };
}

function nativeAction(row, overrides = {}) {
  const resourceIdentity = Object.fromEntries(['id', 'kind', 'name', 'host', 'scope', 'providerRef']
    .flatMap((key) => (row.resource[key] == null ? [] : [[key, row.resource[key]]])));
  return {
    id: `maintenance-action-${row.id}`, providerId: 'fixture-provider', providerVersion: '1',
    operation: row.nextAction.operation, resourceIdentity,
    classification: row.safetyClass, findingClassification: row.classification,
    rollback: 'reversible', restart: 'required', executable: true,
    sourceFingerprint: `native-source-${row.id}`,
    ...overrides,
  };
}

test('planner.buildExecutableMaintenancePlan refuses more than one finding or action with ONE_ACTION_PER_PLAN', () => {
  const rowA = finding('a');
  const rowB = finding('b');
  assert.throws(() => buildExecutableMaintenancePlan({
    findings: [rowA, rowB], actions: [nativeAction(rowA), nativeAction(rowB)],
    sourceFingerprint: 'fp', now: () => NOW,
  }), (error) => error.code === 'ONE_ACTION_PER_PLAN');
  assert.throws(() => buildExecutableMaintenancePlan({
    findings: [rowA], actions: [nativeAction(rowA), nativeAction(rowB)],
    sourceFingerprint: 'fp', now: () => NOW,
  }), (error) => error.code === 'ONE_ACTION_PER_PLAN');
  assert.throws(() => buildExecutableMaintenancePlan({
    findings: [], actions: [], sourceFingerprint: 'fp', now: () => NOW,
  }), (error) => error.code === 'ONE_ACTION_PER_PLAN');
  // The one-action rule never touched non-executable (read-only) plans, which
  // may still list many findings.
  const readOnly = buildMaintenancePlan({ findings: [rowA, rowB], sourceFingerprint: 'fp', now: () => NOW });
  assert.equal(readOnly.findingIds.length, 2);
});

test('planner.assertExecutableMaintenancePlanIntegrity refuses an executable plan tampered to carry two actions', () => {
  const row = finding('a');
  const plan = buildExecutableMaintenancePlan({
    findings: [row], actions: [nativeAction(row)], sourceFingerprint: 'fp', now: () => NOW,
  });
  const tampered = structuredClone(plan);
  tampered.actions.push(nativeAction(finding('b')));
  tampered.findingIds.push('b');
  assert.throws(
    () => assertExecutableMaintenancePlanIntegrity(tampered, { now: () => NOW + 1 }),
    (error) => error.code === 'ONE_ACTION_PER_PLAN',
  );
});

test('coordinator.applyMaintenancePlan refuses a multi-action request before any provider call, lock, or journal write', async (t) => {
  const root = fixture(t);
  const rowA = finding('a');
  const rowB = finding('b');
  const actionA = nativeAction(rowA);
  const actionB = nativeAction(rowB);
  const plan = {
    schemaVersion: 1, planId: 'maintenance-plan-multi', planDigest: 'digest-multi',
    sourceFingerprint: 'fp-multi', generatedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 300_000).toISOString(), safetyClass: 'approval-required',
    actions: [actionA, actionB],
  };
  const calls = [];
  const provider = {
    id: 'fixture-provider', version: '1',
    async preflight(item) { calls.push(`preflight:${item.id}`); return { ok: true, sourceFingerprint: item.sourceFingerprint }; },
    async apply(item) { calls.push(`apply:${item.id}`); return { status: 'applied', postFingerprint: `post-${item.id}` }; },
    async verify(item, outcome) { calls.push(`verify:${item.id}`); return { ok: true, postFingerprint: outcome.postFingerprint }; },
  };
  const result = await applyMaintenancePlan({
    plan, actionIds: [actionA.id, actionB.id], expectedPlanDigest: plan.planDigest,
    providers: new Map([[provider.id, provider]]), transactionsRoot: root,
    refreshPlan: async () => plan, now: () => NOW, nonce: () => 'multi',
  });
  assert.equal(result.status, 'preflight-refused');
  assert.match(result.error, /exactly one/i);
  assert.deepEqual(calls, [], 'no provider method was ever called');
  assert.deepEqual(fs.readdirSync(root), [], 'no mutation lock or receipt directory was created');
});

test('coordinator.applyMaintenancePlan refuses zero action ids the same way, before any effect', async (t) => {
  const root = fixture(t);
  const row = finding('a');
  const action = nativeAction(row);
  const plan = {
    schemaVersion: 1, planId: 'maintenance-plan-zero', planDigest: 'digest-zero',
    sourceFingerprint: 'fp-zero', generatedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 300_000).toISOString(), safetyClass: 'approval-required', actions: [action],
  };
  const result = await applyMaintenancePlan({
    plan, actionIds: [], expectedPlanDigest: plan.planDigest,
    providers: new Map(), transactionsRoot: root,
    refreshPlan: async () => plan, now: () => NOW, nonce: () => 'zero',
  });
  assert.equal(result.status, 'preflight-refused');
  assert.match(result.error, /exactly one/i);
  assert.deepEqual(fs.readdirSync(root), []);
});

function footprint(items) {
  return {
    generatedAt: new Date(NOW).toISOString(),
    snapshot: { present: true, asOf: NOW - 1000, stale: false, ageMs: 1000 },
    catalog: {
      asOf: NOW - 1000, complete: true, degraded: [], truncated: [], partial: [],
      sourceStamps: [{ id: 'catalog', value: 'source-a' }],
      items,
    },
    storage: { asOf: NOW - 1000, reclaimables: [] },
  };
}

function catalogItem(id) {
  return {
    canonicalId: `plugin:${id}@market`, kind: 'plugin', name: `${id}@market`,
    lifecycle: { state: 'stale-configuration', operation: 'disable' },
    presence: [{ host: 'claude', scope: 'plugin', plugin: { scope: 'user' },
      provider: { ref: `${id}@market`, version: '1.0.0', evidence: 'native' } }],
  };
}

function serviceProvider(events) {
  return {
    id: 'fixture-provider', version: '1', host: 'claude', status: 'native-detection-required',
    resourceKinds: ['plugin'], operations: ['disable'], rollback: ['reversible'],
    async detect() {
      events.push('detect');
      return {
        status: 'available', complete: true, authority: 'native-inventory',
        plugins: [{ ref: 'a@market', scope: 'user', enabled: true }, { ref: 'b@market', scope: 'user', enabled: true }],
      };
    },
    actionFor(row, facts) {
      events.push(`actionFor:${row.id}`);
      if (!facts.complete || !facts.plugins.some((item) => item.ref === row.resource.providerRef
          && item.scope === row.resource.scope && item.enabled)) return null;
      return nativeAction(row);
    },
    async preflight() { events.push('preflight'); return { ok: true, sourceFingerprint: 'native-source-a' }; },
    async apply() { events.push('apply'); return { status: 'applied', postFingerprint: 'post-a' }; },
    async verify() { events.push('verify'); return { ok: true, postFingerprint: 'post-a' }; },
  };
}

test('service.plan({executable:true}) refuses a multi-finding request before any provider is asked for an action', async (t) => {
  const root = fixture(t);
  const events = [];
  const implementation = serviceProvider(events);
  const collector = { async read() { return footprint([catalogItem('a'), catalogItem('b')]); } };
  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await service.scan();
  assert.equal(model.findings.length, 2);
  events.length = 0;
  await assert.rejects(
    () => service.plan({ findingIds: model.findings.map((item) => item.id), executable: true }),
    (error) => error.code === 'ONE_ACTION_PER_PLAN',
  );
  // `detect()` is an unavoidable, read-only part of building any findings
  // model; `actionFor()` — the call that would derive a mutation-bound
  // native action for each selected finding — must never run for a refused
  // multi-finding request.
  assert.equal(events.some((event) => event.startsWith('actionFor')), false);
  assert.equal(fs.existsSync(path.join(root, 'plans')), false);
});

test('service.apply refuses a multi-action id request before touching the transaction store', async (t) => {
  const root = fixture(t);
  const events = [];
  const implementation = serviceProvider(events);
  const collector = {
    async read() { return footprint([catalogItem('a'), catalogItem('b')]); },
    async refreshDeep() { return { ok: true }; },
  };
  const service = createMaintenanceService({
    collector, providers: new Map([[implementation.id, implementation]]), now: () => NOW, controlRoot: root,
  });
  const model = await service.scan();
  const planA = await service.plan({ findingIds: [model.findings[0].id], executable: true });
  const planB = await service.plan({ findingIds: [model.findings[1].id], executable: true });
  await assert.rejects(() => service.apply({
    plan: planA, actionIds: [planA.actions[0].id, planB.actions[0].id],
    expectedPlanDigest: planA.planDigest, confirmed: true,
  }), (error) => error.code === 'ONE_ACTION_PER_PLAN' || /exactly one/i.test(error.message));
  assert.equal(fs.existsSync(path.join(root, 'transactions')), false);
});
