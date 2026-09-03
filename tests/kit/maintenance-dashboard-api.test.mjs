import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { publicMaintenanceModel } from '../../src/lib/dashboard/maintenance-api.mjs';

function request(server, route, {
  method = 'GET', token = server.token, body, origin = true, fetchSite = 'same-origin', contentType = 'application/json',
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['x-dash-token'] = token;
    if (origin) headers.origin = `http://127.0.0.1:${server.port}`;
    if (fetchSite) headers['sec-fetch-site'] = fetchSite;
    if (body != null) headers['content-type'] = contentType;
    const req = http.request({ host: '127.0.0.1', port: server.port, path: route, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body != null) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

function fixtureService() {
  const calls = { scan: 0, plan: 0, apply: 0, preview: 0, undo: 0 };
  const finding = {
    id: 'finding-a', state: 'update-available', bucket: 'updatesReady',
    classification: 'native-update', safetyClass: 'approval-required',
    resource: { id: 'plugin-a', kind: 'plugin', name: '<hostile>', host: 'claude', scope: 'user' },
    evidence: { completeness: 'complete', sources: ['native-inventory'] },
    nextAction: { operation: 'update', executable: true },
  };
  return {
    calls,
    async scan() {
      calls.scan++;
      return {
        schemaVersion: 1, mode: 'control-plane', asOf: '2026-09-03T00:00:00.000Z', sourceFingerprint: 'source-a',
        capabilities: { plan: true, apply: true, undo: true },
        freshness: { completeness: 'complete', gaps: [] },
        summary: { total: 1, actionable: 1, updatesReady: 1 }, findings: [finding], receipts: [],
      };
    },
    async plan({ findingIds, executable }) {
      calls.plan++;
      assert.deepEqual(findingIds, ['finding-a']);
      assert.equal(executable, true);
      return {
        schemaVersion: 1, mode: 'control-plane', capabilities: { plan: true, apply: true, undo: true },
        planId: 'plan-a', planDigest: 'digest-a', sourceFingerprint: 'source-a', safetyClass: 'approval-required',
        generatedAt: '2026-09-03T00:00:00.000Z', expiresAt: '2099-09-03T00:05:00.000Z', findingIds,
        actions: [{
          id: 'action-a', providerId: 'native.claude-plugin', providerVersion: '1', operation: 'update',
          classification: 'approval-required', findingClassification: 'native-update', rollback: 'irreversible',
          restart: 'required', executable: true, sourceFingerprint: 'source-a',
          resourceIdentity: finding.resource,
        }],
      };
    },
    async apply(input) {
      calls.apply++;
      assert.deepEqual(input.actionIds, ['action-a']);
      assert.equal(input.expectedPlanDigest, 'digest-a');
      assert.equal(input.confirmed, true);
      return {
        ok: true, status: 'committed', receipt: {
          id: 'receipt-a', status: 'committed', receiptFile: '/private/must-not-leak',
          actions: [{ actionId: 'action-a', operation: 'update', state: 'verified' }],
          verification: { nativeStateVerified: true, affectedCatalogRescanned: true },
        },
      };
    },
    async prepareUndo({ receiptId }) {
      calls.preview++;
      return { receiptId, undoable: true, actionCount: 1, summary: 'Restore the recorded preimage.' };
    },
    async undo({ receiptId, confirmed }) {
      calls.undo++;
      assert.equal(confirmed, true);
      return { ok: true, status: 'rolled-back', receipt: { id: receiptId, status: 'rolled-back' } };
    },
  };
}

test('maintenance dashboard projection derives human summary fields without inventing authority', () => {
  const projected = publicMaintenanceModel({
    summary: { updatesReady: 1, unsupportedOrBlocked: 1 },
    findings: [
      { id: 'a', bucket: 'updatesReady', ownership: { owner: 'native owner' },
        evidence: { completeness: 'complete', freshness: 'fresh', sources: ['native'], gaps: ['gap-a'] },
        nextAction: { executable: true } },
      { id: 'b', bucket: 'unsupportedOrBlocked', evidence: { completeness: 'partial' }, nextAction: { executable: false } },
    ],
    receipts: [{ id: 'r1', status: 'committed', updatedAt: '2026-09-03T00:00:00.000Z' }],
  });
  assert.deepEqual({
    total: projected.summary.total,
    actionable: projected.summary.actionable,
    incompleteSources: projected.summary.incompleteSources,
    blocked: projected.summary.blocked,
    recentChanges: projected.summary.recentChanges,
  }, { total: 2, actionable: 1, incompleteSources: 1, blocked: 1, recentChanges: 1 });
  assert.equal(projected.findings[0].owner, 'native owner');
  assert.deepEqual(projected.findings[0].evidence.reasons, ['gap-a']);
  assert.equal(projected.findings[0].evidence.source, 'native');
  assert.equal(projected.receipts[0].completedAt, '2026-09-03T00:00:00.000Z');
});

test('dashboard Maintenance API keeps GET lazy and mutation paths exact', async (t) => {
  const service = fixtureService();
  const server = await startDashboard({
    port: 0, maintenance: service,
    fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: {},
  });
  t.after(() => server.close());

  const unauthenticated = await request(server, '/api/maintenance', { token: null, origin: false, fetchSite: null });
  assert.equal(unauthenticated.status, 401);
  assert.equal(service.calls.scan, 0);

  const report = await request(server, '/api/maintenance', { origin: false, fetchSite: null });
  assert.equal(report.status, 200);
  assert.equal(report.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(report.body).findings[0].resource.name, '<hostile>');

  const wrongMethod = await request(server, '/api/status', { method: 'POST', body: {} });
  assert.equal(wrongMethod.status, 405);
  const unknownMutation = await request(server, '/api/maintenance/other', { method: 'POST', body: {} });
  assert.equal(unknownMutation.status, 405);
});

test('dashboard Maintenance capabilities bind preview, confirmation, apply and guarded undo', async (t) => {
  const service = fixtureService();
  const server = await startDashboard({ port: 0, maintenance: service, usage: {} });
  t.after(() => server.close());

  const queryToken = await request(server, `/api/maintenance/plans?token=${server.token}`, {
    method: 'POST', token: null, body: { findingIds: ['finding-a'] },
  });
  assert.equal(queryToken.status, 401);
  assert.equal(service.calls.plan, 0);

  const noOrigin = await request(server, '/api/maintenance/plans', {
    method: 'POST', origin: false, body: { findingIds: ['finding-a'] },
  });
  assert.equal(noOrigin.status, 403);
  const crossSite = await request(server, '/api/maintenance/plans', {
    method: 'POST', fetchSite: 'cross-site', body: { findingIds: ['finding-a'] },
  });
  assert.equal(crossSite.status, 403);

  const injection = await request(server, '/api/maintenance/plans', {
    method: 'POST', body: { findingIds: ['finding-a'], command: 'rm', path: '/tmp/x' },
  });
  assert.equal(injection.status, 400);
  assert.equal(service.calls.plan, 0);

  const planned = await request(server, '/api/maintenance/plans', {
    method: 'POST', body: { findingIds: ['finding-a'] },
  });
  assert.equal(planned.status, 200, planned.body);
  const preview = JSON.parse(planned.body);
  assert.equal(preview.confirmation.typedPhrase, 'APPLY 1');
  assert.deepEqual(preview.confirmation.willChange, ['update <hostile>']);
  assert.equal(preview.confirmation.preserved.length, 2);
  assert.equal(preview.plan.actions[0].executable, true);
  assert.doesNotMatch(planned.body, /private\/must-not-leak|argv|command/);

  const refusedPhrase = await request(server, '/api/maintenance/apply', {
    method: 'POST', body: { capability: preview.capability, confirm: true, typedPhrase: 'wrong' },
  });
  assert.equal(refusedPhrase.status, 409);
  assert.equal(service.calls.apply, 0);
  const replayAfterRefusal = await request(server, '/api/maintenance/apply', {
    method: 'POST', body: { capability: preview.capability, confirm: true, typedPhrase: 'APPLY 1' },
  });
  assert.equal(replayAfterRefusal.status, 409);

  const plannedAgain = JSON.parse((await request(server, '/api/maintenance/plans', {
    method: 'POST', body: { findingIds: ['finding-a'] },
  })).body);
  const applied = await request(server, '/api/maintenance/apply', {
    method: 'POST', body: { capability: plannedAgain.capability, confirm: true, typedPhrase: 'APPLY 1' },
  });
  assert.equal(applied.status, 200, applied.body);
  assert.equal(service.calls.apply, 1);
  assert.equal(JSON.parse(applied.body).receipt.undoEligible, true);
  assert.doesNotMatch(applied.body, /receiptFile|private/);
  const replay = await request(server, '/api/maintenance/apply', {
    method: 'POST', body: { capability: plannedAgain.capability, confirm: true, typedPhrase: 'APPLY 1' },
  });
  assert.equal(replay.status, 409);

  const undoPreview = await request(server, '/api/maintenance/undo', {
    method: 'POST', body: { receiptId: 'receipt-a', preview: true },
  });
  assert.equal(undoPreview.status, 200, undoPreview.body);
  const undoAuthority = JSON.parse(undoPreview.body);
  const undone = await request(server, '/api/maintenance/undo', {
    method: 'POST', body: { capability: undoAuthority.capability, confirm: true, typedPhrase: 'UNDO' },
  });
  assert.equal(undone.status, 200, undone.body);
  assert.equal(service.calls.undo, 1);
});
