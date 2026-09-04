import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMaintenanceReadModel } from '../../src/lib/maintenance/read-model.mjs';
import { createMaintenanceService } from '../../src/lib/maintenance/service.mjs';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

const measured = (value, partial = false) => ({
  status: 'measured', value, partial, reason: null, asOf: NOW - 1000,
});

function footprint(stamp = 'source-a') {
  return {
    generatedAt: new Date(NOW).toISOString(),
    snapshot: { present: true, asOf: NOW - 1000, stale: false, ageMs: 1000 },
    catalog: {
      asOf: NOW - 1000, complete: true, degraded: [], truncated: [], partial: [],
      sourceStamps: [{ id: 'catalog', value: stamp }], items: [],
    },
    storage: {
      asOf: NOW - 1000,
      reclaimables: [{
        id: 'cache:one', kind: 'regenerable-cache', label: 'Cache one',
        path: '/secret/cache', bytes: measured(12), files: measured(1),
        safety: 'regenerable', advisory: true, rationale: 'Can be reproduced.',
        cleanupHint: 'owner clean --all',
      }],
    },
  };
}

test('read model exposes the versioned read-only contract and five honest buckets', () => {
  const model = buildMaintenanceReadModel({ footprint: footprint(), now: () => NOW });
  assert.equal(model.schemaVersion, 1);
  assert.equal(model.mode, 'read-only');
  assert.deepEqual(model.capabilities, { plan: true, apply: false, undo: false });
  assert.equal(model.asOf, new Date(NOW - 1000).toISOString());
  assert.equal(model.freshness.status, 'fresh');
  assert.deepEqual(Object.keys(model.summary), [
    'updatesReady', 'safeCleanup', 'needsReview', 'unsupportedOrBlocked', 'recentChanges',
  ]);
  assert.equal(model.summary.safeCleanup, 0,
    'reproducible storage without an exact action provider is not safe cleanup authority');
  assert.equal(model.summary.needsReview, 1);
  assert.deepEqual(model.receipts, []);
});

test('source fingerprint is stable for identical evidence and changes on source drift', () => {
  const a = buildMaintenanceReadModel({ footprint: footprint('a'), now: () => NOW });
  const again = buildMaintenanceReadModel({ footprint: footprint('a'), now: () => NOW + 500 });
  const b = buildMaintenanceReadModel({ footprint: footprint('b'), now: () => NOW });
  assert.equal(a.sourceFingerprint, again.sourceFingerprint);
  assert.notEqual(a.sourceFingerprint, b.sourceFingerprint);
});

test('missing footprint sections degrade to a review finding instead of throwing or inventing zeroes', () => {
  const model = buildMaintenanceReadModel({ footprint: {}, now: () => NOW });
  assert.equal(model.freshness.status, 'unknown');
  assert.equal(model.freshness.completeness, 'partial');
  assert.equal(model.summary.needsReview, 1);
  assert.equal(model.findings[0].state, 'unreadable-partial');
  assert.match(model.findings[0].evidence.gaps.join(' '), /catalog|storage/i);
});

test('service invokes a deep System scan only when explicitly requested', async () => {
  const calls = [];
  const collector = {
    async refreshDeep() { calls.push('deep'); return { ok: true }; },
    async read() { calls.push('read'); return footprint(); },
  };
  const service = createMaintenanceService({ collector, now: () => NOW });

  await service.scan({ deep: false });
  assert.deepEqual(calls, ['read']);
  calls.length = 0;
  await service.scan({ deep: true });
  assert.deepEqual(calls, ['deep', 'read']);
});

test('service produces selection-bound read-only plans that cannot cross the mutation boundary', async () => {
  const collector = { async read() { return footprint(); } };
  const service = createMaintenanceService({ collector, now: () => NOW });
  const scan = await service.scan();
  const plan = await service.plan({ findingIds: [scan.findings[0].id] });

  assert.deepEqual(plan.findingIds, [scan.findings[0].id]);
  assert.equal(plan.actions.length, 1);
  await assert.rejects(() => service.apply({
    plan,
    actionIds: [plan.actions[0].id],
    expectedPlanDigest: plan.planDigest,
    confirmed: true,
  }), /executable.*capability boundary/i);
});

test('project selection uses an opaque project reference and never emits the project path', async () => {
  const input = footprint();
  input.storage.reclaimables = [];
  input.catalog.items = [{
    canonicalId: 'skill:project-copy', kind: 'skill', name: 'project-copy', variantCount: 2,
    presence: [{ host: 'codex', scope: 'project', project: '/private/project-a' }],
  }];
  const collector = { async read() { return input; } };
  const service = createMaintenanceService({ collector, now: () => NOW });
  const model = await service.scan();

  assert.match(model.findings[0].resource.projectRef, /^maintenance-project-/);
  assert.doesNotMatch(JSON.stringify(model), /\/private\/project-a/);
  const plan = await service.plan({ project: '/private/project-a' });
  assert.equal(plan.actions.length, 1);
});
