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
  const calls = { report: 0, scan: 0, plan: 0, apply: 0, preview: 0, undo: 0 };
  const finding = {
    id: 'finding-a', state: 'update-available', bucket: 'updatesReady',
    classification: 'native-update', safetyClass: 'approval-required',
    resource: { id: 'plugin-a', kind: 'plugin', name: '<hostile>', host: 'claude', scope: 'user' },
    evidence: { completeness: 'complete', sources: ['native-inventory'] },
    nextAction: { operation: 'update', executable: true },
  };
  const report = () => ({
        schemaVersion: 1, mode: 'control-plane', asOf: '2026-09-03T00:00:00.000Z', sourceFingerprint: 'source-a',
        scan: { status: 'complete', checkedAt: '2026-09-03T00:00:00.000Z', deep: true,
          coverage: 'partial', providersChecked: 2, providersComplete: 1, providersTotal: 3 },
        capabilities: { plan: true, apply: true, undo: true },
        freshness: { completeness: 'complete', gaps: [] },
        summary: { total: 1, actionable: 1, updatesReady: 1 }, findings: [finding],
        receipts: [
          { id: 'durable-no-change', status: 'aborted-no-change', updatedAt: '2026-09-03T00:03:00.000Z' },
          { id: 'durable-recovery', status: 'partial-recovery-required', updatedAt: '2026-09-03T00:04:00.000Z' },
        ],
      });
  return {
    calls,
    async report() { calls.report++; return report(); },
    async scan() { calls.scan++; return report();
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
          impact: {
            capabilities: ['skill reviewer', 'command ship'],
            preserved: ['Standalone skill reviewer on Codex'],
          },
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
      { id: 'a', bucket: 'updatesReady', statusLabel: 'Upgrade available', ownership: { owner: 'native owner' },
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
  assert.equal(projected.findings[0].statusLabel, 'Upgrade available');
  assert.deepEqual(projected.findings[0].evidence.reasons, ['gap-a']);
  assert.equal(projected.findings[0].evidence.source, 'native');
  assert.equal(projected.receipts[0].completedAt, '2026-09-03T00:00:00.000Z');
  assert.equal(projected.receipts[0].statusLabel, 'Change recorded');
  assert.equal(projected.receipts[0].timestampLabel, 'Recorded');
});

test('maintenance dashboard projects bounded provider activity and withholds action capability while it runs', () => {
  const projected = publicMaintenanceModel({
    capabilities: { plan: true, apply: true, undo: true },
    activity: {
      kind: 'provider', status: 'running', phase: 'providers',
      startedAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:01.000Z',
      progress: { done: 2, total: 5, unit: 'providers', path: '/Users/alice/private' },
      path: '/Users/alice/private', command: 'codex plugin list',
    },
  });

  assert.deepEqual(projected.activity, {
    kind: 'provider', status: 'running', phase: 'providers',
    startedAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:01.000Z',
    finishedAt: null, progress: { done: 2, total: 5, unit: 'providers' },
  });
  assert.deepEqual(projected.capabilities, { plan: false, apply: false, undo: false });
  assert.doesNotMatch(JSON.stringify(projected), /Users\/alice|codex plugin list/);
});

test('maintenance dashboard projection gives every durable receipt a human status, tone, and time meaning', () => {
  const updatedAt = '2026-09-03T00:04:00.000Z';
  const cases = [
    ['committed', 'Change recorded', 'ready', 'Recorded', false, true],
    ['rolled-back', 'Change rolled back', 'ready', 'Recorded', false, false],
    ['aborted-no-change', 'No change made', 'ready', 'Recorded', false, false],
    ['recovered-no-change', 'No change observed', 'ready', 'Recorded', false, false],
    ['partial-recovery-required', 'Recovery required', 'blocked', 'Updated', true, false],
    ['unknown-recovery-required', 'Recovery required', 'blocked', 'Updated', true, false],
    ['applying', 'Apply interrupted', 'blocked', 'Updated', true, false],
    ['verifying', 'Verification interrupted', 'blocked', 'Updated', true, false],
    ['refreshing-catalog', 'Catalog refresh interrupted', 'blocked', 'Updated', true, false],
    ['undoing', 'Undo interrupted', 'blocked', 'Updated', true, false],
  ];
  const projected = publicMaintenanceModel({
    findings: [],
    receipts: cases.map(([status], index) => ({
      id: `receipt-${index}`, status, updatedAt, actionCount: 1,
      undoEligible: true, undo: { eligible: true },
    })),
  });

  for (const [index, expected] of cases.entries()) {
    const [status, statusLabel, statusTone, timestampLabel, recoveryRequired, undoEligible] = expected;
    const receipt = projected.receipts[index];
    assert.deepEqual({
      status: receipt.status, statusLabel: receipt.statusLabel, statusTone: receipt.statusTone,
      timestampLabel: receipt.timestampLabel, recoveryRequired: receipt.recoveryRequired,
      undoEligible: receipt.undoEligible,
    }, { status, statusLabel, statusTone, timestampLabel, recoveryRequired, undoEligible });
    assert.equal(receipt.updatedAt, updatedAt);
    assert.equal(receipt.summary.length > 20, true);
    assert.equal(receipt.undo.eligible, undoEligible);
  }
});

test('maintenance dashboard projection removes local paths from public evidence while retaining its diagnosis', () => {
  const localPath = '/Users/alice/private-repo';
  const projected = publicMaintenanceModel({
    freshness: {
      gaps: [`catalog:degraded:claude-project-skills:${localPath}`],
    },
    findings: [{
      id: 'private-evidence',
      evidence: {
        source: `native-scan:${localPath}/.claude/skills`,
        sources: [`plugin-cache:${localPath}`, 'https://example.test/catalog'],
        gaps: [`catalog:degraded:claude-project-skills:${localPath}`],
        reasons: [`read failed for ${localPath}/SKILL.md`],
      },
    }],
  });

  assert.doesNotMatch(JSON.stringify(projected), /\/Users\/alice\/private-repo/);
  assert.equal(projected.findings[0].evidence.source, 'native-scan:[local path omitted]');
  assert.deepEqual(projected.findings[0].evidence.sources, [
    'plugin-cache:[local path omitted]', 'https://example.test/catalog',
  ]);
  assert.deepEqual(projected.findings[0].evidence.gaps, [
    'catalog:degraded:claude-project-skills:[local path omitted]',
  ]);
  assert.deepEqual(projected.findings[0].evidence.reasons, ['read failed for [local path omitted]']);
  assert.deepEqual(projected.freshness.gaps, [
    'catalog:degraded:claude-project-skills:[local path omitted]',
  ]);
});

test('maintenance dashboard projection bounds relationship evidence to typed, path-free members', () => {
  const members = Array.from({ length: 10 }, (_, index) => ({
    role: index === 0 ? 'project-copy' : 'shared-copy',
    label: `<copy-${index}>`, host: 'codex', scope: index === 0 ? 'project' : 'user',
    projectRef: `maintenance-project-${index}`, projectLabel: `project-${index}`,
    ownership: index === 0 ? 'unknown' : 'user-owned',
    tracking: index === 0 ? 'untracked' : 'unknown', workingTree: 'clean',
    path: `/Users/alice/private-${index}`, command: 'rm -rf /', digest: `secret-${index}`,
  }));
  const projected = publicMaintenanceModel({ findings: [{
    id: 'relationship-a', classification: 'redundant-project-override',
    relationship: {
      kind: 'redundant-project-override', basis: 'same-entrypoint', resolution: 'not-reported',
      memberCount: 10, truncated: false, members,
      arbitrary: '/Users/alice/must-not-leak',
    },
  }] });

  assert.deepEqual(projected.findings[0].relationship.members.length, 8);
  assert.equal(projected.findings[0].relationship.memberCount, 10);
  assert.equal(projected.findings[0].relationship.truncated, true);
  assert.deepEqual(Object.keys(projected.findings[0].relationship).sort(),
    ['basis', 'kind', 'memberCount', 'members', 'resolution', 'truncated']);
  assert.doesNotMatch(JSON.stringify(projected), /\/Users\/alice|rm -rf|secret-/);
});

test('maintenance dashboard projects bounded consumer hosts without turning inventory into usage', () => {
  const projected = publicMaintenanceModel({ findings: [{
    id: 'consumer-a',
    consumerHosts: {
      basis: 'catalog-presence',
      hosts: ['opencode', 'claude', 'codex', 'claude', '<hostile>'],
      count: 9,
      truncated: false,
      path: '/Users/alice/private',
    },
  }, {
    id: 'consumer-unknown',
    consumerHosts: { basis: 'observed-use', hosts: ['claude'] },
  }] });

  assert.deepEqual(projected.findings[0].consumerHosts, {
    basis: 'catalog-presence', hosts: ['claude', 'codex', 'opencode'], count: 9, truncated: true,
  });
  assert.deepEqual(projected.findings[1].consumerHosts, {
    basis: 'not-measured', hosts: [], count: 0, truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(projected), /hostile|\/Users\/alice/);
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
  assert.equal(service.calls.report, 0);

  const report = await request(server, '/api/maintenance', { origin: false, fetchSite: null });
  assert.equal(report.status, 200);
  assert.equal(report.headers['cache-control'], 'no-store');
  const reportBody = JSON.parse(report.body);
  assert.equal(service.calls.report, 1);
  assert.equal(service.calls.scan, 0, 'ordinary GET reads the persisted report without provider detection');
  assert.deepEqual(reportBody.scan, {
    status: 'complete', checkedAt: '2026-09-03T00:00:00.000Z', deep: true,
    coverage: 'partial', providersChecked: 2, providersComplete: 1, providersTotal: 3,
  });
  assert.equal(reportBody.findings[0].resource.name, '<hostile>');
  assert.deepEqual(reportBody.receipts.map((receipt) => ({
    statusLabel: receipt.statusLabel, statusTone: receipt.statusTone,
    timestampLabel: receipt.timestampLabel, updatedAt: receipt.updatedAt,
  })), [
    { statusLabel: 'No change made', statusTone: 'ready', timestampLabel: 'Recorded', updatedAt: '2026-09-03T00:03:00.000Z' },
    { statusLabel: 'Recovery required', statusTone: 'blocked', timestampLabel: 'Updated', updatedAt: '2026-09-03T00:04:00.000Z' },
  ]);

  const wrongMethod = await request(server, '/api/status', { method: 'POST', body: {} });
  assert.equal(wrongMethod.status, 405);
  const unknownMutation = await request(server, '/api/maintenance/other', { method: 'POST', body: {} });
  assert.equal(unknownMutation.status, 405);

  const rescanned = await request(server, '/api/maintenance?refresh=scan', { origin: false, fetchSite: null });
  assert.equal(rescanned.status, 200);
  assert.equal(service.calls.scan, 1, 'only the explicit scan query invokes maintenance scanning');

  const unknownRefresh = await request(server, '/api/maintenance?refresh=deep', { origin: false, fetchSite: null });
  const duplicateRefresh = await request(server, '/api/maintenance?refresh=scan&refresh=scan', { origin: false, fetchSite: null });
  const unknownQuery = await request(server, '/api/maintenance?extra=scan', { origin: false, fetchSite: null });
  assert.deepEqual([unknownRefresh.status, duplicateRefresh.status, unknownQuery.status], [400, 400, 400]);
  assert.equal(service.calls.scan, 1, 'ambiguous scan queries never invoke maintenance scanning');
});

test('dashboard Maintenance reports provider activity and refuses action requests during a scan', async (t) => {
  const service = fixtureService();
  service.scanState = () => ({
    kind: 'provider', status: 'running', phase: 'providers',
    startedAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:01.000Z',
    finishedAt: null, progress: { done: 1, total: 4, unit: 'providers' },
  });
  service.plan = async () => {
    const error = new Error('Maintenance provider scan is in progress.');
    error.code = 'MAINTENANCE_SCAN_IN_PROGRESS';
    error.statusCode = 409;
    throw error;
  };
  const server = await startDashboard({ port: 0, maintenance: service, usage: {} });
  t.after(() => server.close());

  const report = await request(server, '/api/maintenance', { origin: false, fetchSite: null });
  assert.equal(report.status, 200);
  const body = JSON.parse(report.body);
  assert.equal(body.activity.status, 'running');
  assert.deepEqual(body.activity.progress, { done: 1, total: 4, unit: 'providers' });
  assert.deepEqual(body.capabilities, { plan: false, apply: false, undo: false });

  const preview = await request(server, '/api/maintenance/plans', {
    method: 'POST', body: { findingIds: ['finding-a'] },
  });
  assert.equal(preview.status, 409);
  assert.deepEqual(JSON.parse(preview.body), {
    error: 'maintenance provider check is in progress',
    code: 'MAINTENANCE_SCAN_IN_PROGRESS', effect: 'not-started',
  });
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
  assert.deepEqual(preview.confirmation.willChange, [
    'update <hostile>', 'Affected: skill reviewer', 'Affected: command ship',
  ]);
  assert.equal(preview.confirmation.preserved.includes('Standalone skill reviewer on Codex'), true);
  assert.equal(preview.plan.actions[0].executable, true);
  assert.doesNotMatch(planned.body, /private\/must-not-leak|argv|"command"\s*:/);

  const refusedPhrase = await request(server, '/api/maintenance/apply', {
    method: 'POST', body: { capability: preview.capability, confirm: true, typedPhrase: 'wrong' },
  });
  assert.equal(refusedPhrase.status, 409);
  assert.equal(JSON.parse(refusedPhrase.body).effect, 'not-started');
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

test('dashboard Maintenance API distinguishes pre-mutation refusal from a receipted recovery outcome', async (t) => {
  const service = fixtureService();
  service.apply = async () => ({
    ok: false,
    status: 'partial-recovery-required',
    receipt: {
      id: 'receipt-recovery', status: 'partial-recovery-required',
      summary: 'Provider dispatch needs inspection.', receiptFile: '/Users/alice/private-repo/receipt.json',
    },
  });
  const server = await startDashboard({ port: 0, maintenance: service, usage: {} });
  t.after(() => server.close());

  const recoveryPlan = JSON.parse((await request(server, '/api/maintenance/plans', {
    method: 'POST', body: { findingIds: ['finding-a'] },
  })).body);
  const recovery = await request(server, '/api/maintenance/apply', {
    method: 'POST',
    body: { capability: recoveryPlan.capability, confirm: true, typedPhrase: 'APPLY 1' },
  });
  const recoveryBody = JSON.parse(recovery.body);
  assert.equal(recovery.status, 409);
  assert.equal(recoveryBody.effect, 'recovery-required');
  assert.equal(recoveryBody.receipt.id, 'receipt-recovery');
  assert.equal(recoveryBody.receipt.status, 'partial-recovery-required');
  assert.doesNotMatch(recovery.body, /receiptFile|\/Users\/alice\/private-repo/);

  service.apply = async () => ({ ok: false, status: 'preflight-refused' });
  const refusalPlan = JSON.parse((await request(server, '/api/maintenance/plans', {
    method: 'POST', body: { findingIds: ['finding-a'] },
  })).body);
  const refused = await request(server, '/api/maintenance/apply', {
    method: 'POST',
    body: { capability: refusalPlan.capability, confirm: true, typedPhrase: 'APPLY 1' },
  });
  assert.equal(refused.status, 409);
  assert.equal(JSON.parse(refused.body).effect, 'not-started');
  assert.equal(JSON.parse(refused.body).receipt, undefined);
});
