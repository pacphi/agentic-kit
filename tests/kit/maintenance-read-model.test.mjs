import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('service invokes a deep System scan only when explicitly requested', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-deep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const collector = {
    async refreshDeep() { calls.push('deep'); return { ok: true }; },
    async read() { calls.push('read'); return footprint(); },
  };
  const service = createMaintenanceService({ collector, providers: new Map(), controlRoot: root, now: () => NOW });

  await service.scan({ deep: false });
  assert.deepEqual(calls, ['read']);
  calls.length = 0;
  await service.scan({ deep: true });
  assert.deepEqual(calls, ['deep', 'read']);
});

test('dashboard-style reports read the durable scan without rerunning collectors or providers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const provider = {
    id: 'scan-provider', version: '1', host: 'claude', status: 'available',
    resourceKinds: [], operations: [], rollback: [],
    async detect() {
      calls.push('detect');
      return { status: 'available', complete: true, authority: 'native-inventory' };
    },
  };
  const collector = {
    async read() { calls.push('read'); return footprint(); },
    async refreshDeep() { calls.push('deep'); return { ok: true }; },
  };
  const service = createMaintenanceService({
    collector, providers: new Map([[provider.id, provider]]), controlRoot: root, now: () => NOW,
  });

  const before = await service.report();
  assert.equal(before.scan.status, 'not-scanned');
  assert.equal(before.findings[0].classification, 'maintenance-scan-required');
  assert.deepEqual(calls, [], 'reading the report must not touch host or filesystem collectors');

  const scanned = await service.scan();
  assert.equal(scanned.scan.status, 'complete');
  assert.deepEqual(calls, ['read', 'detect']);
  calls.length = 0;
  assert.deepEqual(await service.report(), scanned);
  assert.deepEqual(await service.report(), scanned);
  assert.deepEqual(calls, [], 'browser polling reads the saved report only');

  const reloaded = createMaintenanceService({
    collector, providers: new Map([[provider.id, provider]]), controlRoot: root, now: () => NOW,
  });
  assert.deepEqual(await reloaded.report(), scanned, 'the latest scan survives a dashboard restart');
  assert.deepEqual(calls, []);
});

test('persisted reports age without rescanning and stale evidence loses action authority', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-age-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let at = NOW;
  const calls = [];
  const provider = {
    id: 'scan-provider', version: '1', host: 'claude', status: 'available',
    resourceKinds: [], operations: [], rollback: [],
    async detect() {
      calls.push('detect');
      return { status: 'available', complete: true, authority: 'native-inventory' };
    },
  };
  const service = createMaintenanceService({
    collector: { async read() { calls.push('read'); return footprint(); } },
    providers: new Map([[provider.id, provider]]), controlRoot: root, now: () => at,
  });

  await service.scan();
  calls.length = 0;
  at += 8 * 86_400_000;
  const report = await service.report();

  assert.equal(report.scan.status, 'stale');
  assert.equal(report.freshness.status, 'stale');
  assert.equal(report.freshness.ageMs, 8 * 86_400_000 + 1_000);
  assert.deepEqual(report.capabilities, { plan: false, apply: false, undo: false });
  assert.equal(report.findings.every((finding) => finding.nextAction?.executable !== true), true);
  assert.deepEqual(calls, [], 'aging a report must not touch collectors or native providers');
});

test('missing and corrupt scan reports expose no mutation capability', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createMaintenanceService({ controlRoot: root, providers: new Map(), now: () => NOW });

  const missing = await service.report();
  assert.deepEqual(missing.capabilities, { plan: false, apply: false, undo: false });
  assert.equal(missing.findings[0].nextAction.operation, 'scan');

  fs.writeFileSync(path.join(root, 'latest-scan.json'), '{"broken":true}\n');
  const corrupt = await service.report();
  assert.equal(corrupt.scan.status, 'unavailable');
  assert.deepEqual(corrupt.capabilities, { plan: false, apply: false, undo: false });
});

test('service produces selection-bound read-only plans that cannot cross the mutation boundary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const collector = { async read() { return footprint(); } };
  const service = createMaintenanceService({ collector, providers: new Map(), controlRoot: root, now: () => NOW });
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

test('project selection uses an opaque project reference and never emits the project path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = footprint();
  input.storage.reclaimables = [];
  input.catalog.items = [{
    canonicalId: 'skill:project-copy', kind: 'skill', name: 'project-copy', variantCount: 2,
    presence: [{ host: 'codex', scope: 'project', project: '/private/project-a' }],
  }];
  const collector = { async read() { return input; } };
  const service = createMaintenanceService({ collector, providers: new Map(), controlRoot: root, now: () => NOW });
  const model = await service.scan();

  assert.match(model.findings[0].resource.projectRef, /^maintenance-project-/);
  assert.doesNotMatch(JSON.stringify(model), /\/private\/project-a/);
  const plan = await service.plan({ project: '/private/project-a' });
  assert.equal(plan.actions.length, 1);
});
