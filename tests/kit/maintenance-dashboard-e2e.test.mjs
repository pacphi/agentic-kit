import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { createMaintenanceProviderRegistry } from '../../src/lib/maintenance/provider-registry.mjs';
import { createMaintenanceService } from '../../src/lib/maintenance/service.mjs';
import {
  listMaintenanceReceipts, readMaintenanceReceipt,
} from '../../src/lib/maintenance/transaction-store.mjs';

const PRIVATE_PATH = '/private/maintenance-e2e/provider-state.json';
const PRIVATE_COMMAND = 'native-plugin disable demo@market';
const PRIVATE_ARG = '--credential=e2e-secret';
// Hermetic provider policy: the default registry registers the Ollama model
// provider with a real loopback probe; every real-service composition in this
// file opts out so no test ever touches 127.0.0.1:11434.
const HERMETIC_PROVIDERS = Object.freeze({ ollamaModel: { enabled: false } });
const HERMETIC_MAINTENANCE = Object.freeze({ providerOptions: HERMETIC_PROVIDERS });

function request(server, route, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'x-dash-token': server.token,
      origin: `http://127.0.0.1:${server.port}`,
      'sec-fetch-site': 'same-origin',
    };
    if (body != null) headers['content-type'] = 'application/json';
    const req = http.request({
      host: '127.0.0.1', port: server.port, path: route, method, headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data ? JSON.parse(data) : null,
        raw: data,
      }));
    });
    req.on('error', reject);
    req.end(body == null ? undefined : JSON.stringify(body));
  });
}

function catalogFootprint(revision, measuredAt) {
  return {
    generatedAt: new Date(measuredAt).toISOString(),
    snapshot: { present: true, asOf: measuredAt, stale: false, ageMs: 1_000 },
    catalog: {
      asOf: measuredAt, complete: true, degraded: [], truncated: [], partial: [],
      sourceStamps: [{ id: 'native-catalog', value: `revision-${revision}` }],
      items: [{
        canonicalId: 'plugin:demo@market', kind: 'plugin', name: 'demo@market',
        privatePath: PRIVATE_PATH, command: PRIVATE_COMMAND, argv: [PRIVATE_ARG],
        lifecycle: { state: 'stale-configuration', operation: 'disable' },
        presence: [{
          host: 'claude', scope: 'plugin', plugin: { scope: 'user' },
          provider: {
            ref: 'demo@market', version: '1.0.0', evidence: 'native',
            privatePath: PRIVATE_PATH,
          },
        }],
      }],
    },
    storage: { asOf: measuredAt, reclaimables: [] },
  };
}

function statefulFixture() {
  const state = { enabled: true, nativeRevision: 1, catalogRevision: 1 };
  const measuredAt = Date.now() - 1_000;
  const events = [];
  const refreshes = [];
  const nativeFingerprint = () => `native:${state.enabled ? 'enabled' : 'disabled'}:${state.nativeRevision}`;
  const collector = {
    async read() {
      events.push('catalog-read');
      return catalogFootprint(state.catalogRevision, measuredAt);
    },
    async refreshDeep(targets) {
      events.push(`catalog-refresh:${state.enabled ? 'enabled' : 'disabled'}`);
      refreshes.push({ enabled: state.enabled, targets: structuredClone(targets ?? null) });
      state.catalogRevision++;
      return { ok: true };
    },
  };
  const provider = {
    id: 'e2e-native-plugin', version: '1', host: 'claude', status: 'available',
    resourceKinds: ['plugin'], operations: ['disable'], rollback: ['reversible'],
    async detect() {
      events.push('native-detect');
      return {
        status: 'available', complete: true, authority: 'native-inventory',
        plugins: [{ ref: 'demo@market', scope: 'user', enabled: state.enabled }],
        privatePath: PRIVATE_PATH, command: PRIVATE_COMMAND, argv: [PRIVATE_ARG],
      };
    },
    actionFor(finding, facts) {
      const present = facts.plugins.some((item) => item.ref === finding.resource.providerRef
        && item.scope === finding.resource.scope && item.enabled === true);
      if (!present || finding.nextAction?.operation !== 'disable') return null;
      const resourceIdentity = Object.fromEntries(
        ['id', 'kind', 'name', 'host', 'scope', 'providerRef']
          .flatMap((key) => (finding.resource[key] == null ? [] : [[key, finding.resource[key]]])),
      );
      return {
        id: 'maintenance-action-e2e-disable', providerId: this.id, providerVersion: this.version,
        operation: 'disable', resourceIdentity,
        classification: finding.safetyClass, findingClassification: finding.classification,
        rollback: 'reversible', restart: 'required', executable: true,
        sourceFingerprint: nativeFingerprint(),
      };
    },
    async preflight(action) {
      events.push('native-preflight');
      return { ok: state.enabled, sourceFingerprint: nativeFingerprint(), actionId: action.id };
    },
    async apply() {
      events.push('native-apply');
      state.enabled = false;
      return {
        status: 'applied', postFingerprint: nativeFingerprint(), summary: 'Disabled by native owner.',
        path: PRIVATE_PATH, command: PRIVATE_COMMAND, argv: [PRIVATE_ARG],
      };
    },
    async verify(_action, outcome) {
      events.push('native-verify');
      return { ok: !state.enabled, postFingerprint: outcome.postFingerprint };
    },
    async inspectCurrent() {
      events.push('native-inspect');
      return { postFingerprint: nativeFingerprint(), privatePath: PRIVATE_PATH };
    },
    async undo(entry) {
      events.push('native-undo');
      state.enabled = true;
      return {
        status: 'restored', sourceFingerprint: entry.sourceFingerprint,
        path: PRIVATE_PATH, command: PRIVATE_COMMAND, argv: [PRIVATE_ARG],
      };
    },
    async verifyUndo(entry) {
      events.push('native-verify-undo');
      return { ok: state.enabled, sourceFingerprint: entry.sourceFingerprint };
    },
  };
  return { state, events, refreshes, collector, provider };
}

function assertNoPrivateTransport(value, { capability = true } = {}) {
  const forbiddenKeys = new Set(['path', 'command', 'argv', ...(capability ? ['capability'] : [])]);
  const visit = (current) => {
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      assert.equal(forbiddenKeys.has(key), false, `public payload exposed ${key}`);
      visit(child);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, new RegExp([
    PRIVATE_PATH, PRIVATE_COMMAND, PRIVATE_ARG,
  ].map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
}

test('dashboard HTTP executes and undoes one maintenance finding through the real service stack', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-http-e2e-'));
  const controlRoot = path.join(scratch, 'control');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const fixture = statefulFixture();
  const providers = createMaintenanceProviderRegistry([fixture.provider]);
  const service = createMaintenanceService({
    collector: fixture.collector, providers, controlRoot, providerOptions: HERMETIC_PROVIDERS,
    now: Date.now, nonce: () => 'http-e2e',
  });
  const server = await startDashboard({
    port: 0, maintenance: service, usage: {}, maintenanceOptions: HERMETIC_MAINTENANCE,
    fetchStatus: async () => ({ overall: 'ok', rows: [] }),
  });
  t.after(() => server.close());

  const report = await request(server, '/api/maintenance?refresh=scan');
  assert.equal(report.status, 200);
  assert.equal(report.headers['cache-control'], 'no-store');
  assertNoPrivateTransport(report.body);
  const target = report.body.findings.find((finding) => finding.resource?.name === 'demo@market');
  assert.ok(target, 'the real scanner should project the stale plugin');
  assert.equal(fixture.state.enabled, true);
  assert.equal(fixture.events.includes('native-apply'), false);
  const detectCount = fixture.events.filter((event) => event === 'native-detect').length;
  const passiveReport = await request(server, '/api/maintenance');
  assert.equal(passiveReport.status, 200);
  assert.equal(fixture.events.filter((event) => event === 'native-detect').length, detectCount,
    'ordinary dashboard refresh must not rerun native provider detection');

  const planned = await request(server, '/api/maintenance/plans', {
    method: 'POST', body: { findingIds: [target.id] },
  });
  assert.equal(planned.status, 200, planned.raw);
  assert.match(planned.body.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(planned.body.plan.findingIds, [target.id]);
  assert.equal(planned.body.plan.actions.length, 1);
  assert.equal(planned.body.confirmation.typedPhrase, 'APPLY 1');
  assertNoPrivateTransport(planned.body.plan);
  assertNoPrivateTransport(planned.body.confirmation);
  assert.equal(fixture.state.enabled, true);
  assert.equal(fixture.events.includes('native-apply'), false);
  assert.equal(fs.existsSync(path.join(controlRoot, 'latest-scan.json')), true,
    'the explicit scan persists its content-free report');
  assert.equal(fs.existsSync(path.join(controlRoot, 'transactions')), false,
    'preview must not create the mutation journal');

  const unconfirmed = await request(server, '/api/maintenance/apply', {
    method: 'POST',
    body: { capability: planned.body.capability, confirm: false, typedPhrase: 'APPLY 1' },
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(fixture.state.enabled, true);
  assert.equal(fixture.events.includes('native-apply'), false);

  const applied = await request(server, '/api/maintenance/apply', {
    method: 'POST',
    body: { capability: planned.body.capability, confirm: true, typedPhrase: 'APPLY 1' },
  });
  assert.equal(applied.status, 200, applied.raw);
  assert.equal(applied.body.ok, true);
  assert.equal(applied.body.status, 'committed');
  assert.equal(applied.body.receipt.verification.nativeStateVerified, true);
  assert.equal(applied.body.receipt.verification.affectedCatalogRefreshed, true);
  assert.equal(applied.body.receipt.undoEligible, true);
  assertNoPrivateTransport(applied.body.receipt);
  assert.equal(fixture.state.enabled, false);
  assert.ok(fixture.events.indexOf('native-verify') < fixture.events.indexOf('catalog-refresh:disabled'));
  assert.deepEqual(fixture.refreshes[0], {
    enabled: false,
    targets: null,
  });

  const receiptsRoot = path.join(controlRoot, 'transactions');
  assert.equal(listMaintenanceReceipts(receiptsRoot).length, 1);
  const durableApplied = readMaintenanceReceipt(receiptsRoot, applied.body.receipt.id).receipt;
  assert.equal(durableApplied.status, 'committed');
  assertNoPrivateTransport(durableApplied);

  const replay = await request(server, '/api/maintenance/apply', {
    method: 'POST',
    body: { capability: planned.body.capability, confirm: true, typedPhrase: 'APPLY 1' },
  });
  assert.equal(replay.status, 409);
  assert.equal(fixture.events.filter((event) => event === 'native-apply').length, 1);
  assert.equal(listMaintenanceReceipts(receiptsRoot).length, 1);

  const undoPreview = await request(server, '/api/maintenance/undo', {
    method: 'POST', body: { receiptId: applied.body.receipt.id, preview: true },
  });
  assert.equal(undoPreview.status, 200, undoPreview.raw);
  assert.match(undoPreview.body.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(undoPreview.body.confirmation.typedPhrase, 'UNDO');
  assertNoPrivateTransport(undoPreview.body.confirmation);
  assert.equal(fixture.state.enabled, false);

  const undoUnconfirmed = await request(server, '/api/maintenance/undo', {
    method: 'POST',
    body: { capability: undoPreview.body.capability, confirm: false, typedPhrase: 'UNDO' },
  });
  assert.equal(undoUnconfirmed.status, 400);
  assert.equal(fixture.state.enabled, false);

  const undone = await request(server, '/api/maintenance/undo', {
    method: 'POST',
    body: { capability: undoPreview.body.capability, confirm: true, typedPhrase: 'UNDO' },
  });
  assert.equal(undone.status, 200, undone.raw);
  assert.equal(undone.body.ok, true);
  assert.equal(undone.body.status, 'rolled-back');
  assertNoPrivateTransport(undone.body.receipt);
  assert.equal(fixture.state.enabled, true);
  assert.ok(fixture.events.indexOf('native-verify-undo') < fixture.events.indexOf('catalog-refresh:enabled'));
  assert.equal(fixture.refreshes.length, 2);
  assert.equal(readMaintenanceReceipt(receiptsRoot, applied.body.receipt.id).receipt.status, 'rolled-back');

  const undoReplay = await request(server, '/api/maintenance/undo', {
    method: 'POST',
    body: { capability: undoPreview.body.capability, confirm: true, typedPhrase: 'UNDO' },
  });
  assert.equal(undoReplay.status, 409);
  assert.equal(fixture.events.filter((event) => event === 'native-undo').length, 1);

  const driftPlan = await request(server, '/api/maintenance/plans', {
    method: 'POST', body: { findingIds: [target.id] },
  });
  assert.equal(driftPlan.status, 200, driftPlan.raw);
  fixture.state.nativeRevision++;
  const drifted = await request(server, '/api/maintenance/apply', {
    method: 'POST',
    body: { capability: driftPlan.body.capability, confirm: true, typedPhrase: 'APPLY 1' },
  });
  assert.equal(drifted.status, 409);
  assert.equal(fixture.state.enabled, true);
  assert.equal(fixture.events.filter((event) => event === 'native-apply').length, 1);
  assert.equal(listMaintenanceReceipts(receiptsRoot).length, 1);
});

// ── ADR-0048 v2 over the real loopback server ──────────────────────────────

function rawRequest(server, route, {
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
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, raw: data,
        body: data && res.headers['content-type']?.includes('json') ? JSON.parse(data) : null,
      }));
    });
    req.on('error', reject);
    req.end(body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)));
  });
}

test('dashboard HTTP serves the ADR-0048 v2 routes behind the same loopback, token, origin, schema, and size boundary', async (t) => {
  const [{ SENTINEL_FIXTURES, INTERRUPTED_RECEIPT }, { runInventoryQuery }, { inspectorFor }] = await Promise.all([
    import('../fixtures/maintenance/management-fixtures.mjs'),
    import('../../src/lib/maintenance/management/query.mjs'),
    import('../../src/lib/maintenance/management/guidance.mjs'),
  ]);
  const inventory = SENTINEL_FIXTURES.base();
  const applyEntry = inventory.guidanceEntries.find((entry) => entry.lane === 'apply');
  const calls = [];
  const management = {
    async inventory(args) { calls.push(['inventory', args]); return runInventoryQuery(inventory, args); },
    async placement({ placementId }) { calls.push(['placement', { placementId }]); return inspectorFor(inventory, placementId); },
    async revealLocator({ placementId }) {
      calls.push(['revealLocator', { placementId }]);
      return { breadcrumb: ['Claude', 'Plugins'], exactPath: PRIVATE_PATH };
    },
    async auditInterruption({ receiptIds }) {
      calls.push(['auditInterruption', { receiptIds }]);
      return receiptIds.map((receiptId) => ({
        receiptId, integrity: 'valid', result: 'no-action-started', conclusive: true, enables: 'record-no-change',
        lastDurablePhase: 'prepared', provider: { id: 'owned-npx-cache', version: '1' },
        checks: [{ name: 'receipt-integrity', status: 'passed' }], failedComparisons: [], nextSteps: [],
        disclosure: { checks: ['receipt-integrity'], executableProbePolicy: 'read-only-provider-inspector-only', networkPolicy: 'none', checkedAt: '2026-09-05T12:00:00.000Z' },
        receiptFile: PRIVATE_PATH,
        exportable: { receiptId, result: 'no-action-started', conclusive: true, enables: 'record-no-change' },
      }));
    },
    async planAction({ placementId, guidanceId }) {
      calls.push(['planAction', { placementId, guidanceId }]);
      return {
        planId: 'plan-v2', planDigest: 'digest-v2', sourceFingerprint: 'fp-base', safetyClass: 'safe-automatic',
        generatedAt: '2026-09-05T12:00:00.000Z', expiresAt: new Date(Date.now() + 60_000).toISOString(), findingIds: ['finding-plugin'],
        actions: [{
          id: 'action-disable', providerId: 'claude-plugin', providerVersion: '1', operation: 'disable', classification: 'safe-automatic',
          rollback: 'reversible', restart: 'not-required', executable: true, sourceFingerprint: 'fp-base', placementId,
          resourceIdentity: { kind: 'plugin', name: 'frontend-design', host: 'claude', scope: 'user', path: PRIVATE_PATH },
          impact: { preserved: ['Plugin data'] },
        }],
      };
    },
    async apply({ plan, actionIds, expectedPlanDigest, confirmed }) {
      calls.push(['apply', { planId: plan.planId, actionIds, expectedPlanDigest, confirmed }]);
      return { ok: true, status: 'committed', receipt: { id: 'mnt-v2-applied', status: 'committed', actions: plan.actions, receiptFile: PRIVATE_PATH } };
    },
    async prepareUndo({ receiptId }) { return { receiptId, undoable: true, actionCount: 1, summary: 'Restore the recorded preimage.' }; },
  };
  const server = await startDashboard({
    port: 0, management, usage: {}, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    maintenance: { async report() { return {}; }, async scan() { return {}; }, async plan() { return {}; } },
    maintenanceOptions: HERMETIC_MAINTENANCE,
  });
  t.after(() => server.close());
  const V2 = '/api/maintenance/v2';

  // Reads: token required, same-origin metadata optional (like every other GET), no-store, facets applied, no path.
  assert.equal((await rawRequest(server, `${V2}/inventory`, { token: null, origin: false, fetchSite: null })).status, 401);
  assert.deepEqual(calls, []);
  const page = await rawRequest(server, `${V2}/inventory?scope=across&view=all&facet.kind=skill&sort=guidance-first&limit=50`, { origin: false, fetchSite: null });
  assert.equal(page.status, 200, page.raw);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.deepEqual(calls.at(-1), ['inventory', { scope: 'across', view: 'all', facets: { kind: ['skill'] }, sort: 'guidance-first', limit: 50 }]);
  assert.equal(page.body.total, 2);
  assert.deepEqual(page.body.appliedFacets, { kind: ['skill'] });
  assert.ok(page.body.facetCounts.kind.skill >= 2);
  assert.equal(page.body.groups.every((group) => group.kind === 'skill'), true);
  assertNoPrivateTransport(page.body, { capability: false });
  assert.doesNotMatch(page.raw, /Users\/alice|exactLocatorRef/);
  assert.equal((await rawRequest(server, `${V2}/inventory?scope=galaxy`)).status, 400);
  assert.equal((await rawRequest(server, `${V2}/inventory?extra=1`)).status, 400);
  const inspector = await rawRequest(server, `${V2}/placements/${applyEntry.placementId}`);
  assert.equal(inspector.status, 200, inspector.raw);
  assert.equal(inspector.body.whatIsThis.displayName, 'frontend-design');
  assert.equal((await rawRequest(server, `${V2}/placements/not-an-id`)).status, 404);
  assert.equal((await rawRequest(server, `${V2}/nope`)).status, 404, 'unknown v2 GET path');
  assert.equal((await rawRequest(server, `${V2}/placements/reveal`)).status, 404, 'reveal is POST-only');

  // Reveal: the only exact-path route; it requires POST + header token + same-origin like every mutation.
  const reveal = { placementId: applyEntry.placementId };
  assert.equal((await rawRequest(server, `${V2}/placements/reveal`, { method: 'POST', body: reveal, token: null })).status, 401);
  assert.equal((await rawRequest(server, `${V2}/placements/reveal?token=${server.token}`, { method: 'POST', body: reveal, token: null })).status, 401);
  assert.equal((await rawRequest(server, `${V2}/placements/reveal`, { method: 'POST', body: reveal, origin: false })).status, 403);
  assert.equal((await rawRequest(server, `${V2}/placements/reveal`, { method: 'POST', body: reveal, fetchSite: 'cross-site' })).status, 403);
  assert.equal(calls.some(([name]) => name === 'revealLocator'), false);
  const revealed = await rawRequest(server, `${V2}/placements/reveal`, { method: 'POST', body: reveal });
  assert.equal(revealed.status, 200, revealed.raw);
  assert.equal(revealed.body.exactPath, PRIVATE_PATH);
  assert.deepEqual(revealed.body.breadcrumb, ['Claude', 'Plugins']);

  // Audit: read-only batch of ≤ 20 receipt ids, sanitized results, no capability.
  const audited = await rawRequest(server, `${V2}/audit`, { method: 'POST', body: { receiptIds: [INTERRUPTED_RECEIPT.id, 'mnt-second'] } });
  assert.equal(audited.status, 200, audited.raw);
  assert.equal(audited.body.results.length, 2);
  assert.equal(audited.body.results[0].resultLabel, 'No action started');
  assertNoPrivateTransport(audited.body);
  assert.equal((await rawRequest(server, `${V2}/audit`, { method: 'POST', body: { receiptIds: Array.from({ length: 21 }, (_, i) => `mnt-${i}`) } })).status, 400);

  // Plans: one placement, one guidance entry, one action → apply capability.
  const plan = { placementId: applyEntry.placementId, guidanceId: applyEntry.guidanceId };
  assert.equal((await rawRequest(server, `${V2}/plans`, { method: 'POST', body: { ...plan, findingIds: ['x'] } })).status, 400, 'surplus key');
  assert.equal((await rawRequest(server, `${V2}/plans`, { method: 'POST', body: plan, contentType: 'text/plain' })).status, 415, 'wrong content type');
  assert.equal((await rawRequest(server, `${V2}/plans`, { method: 'POST', body: { ...plan, pad: 'x'.repeat(65_536) } })).status, 413, 'oversized body');
  assert.equal(calls.some(([name]) => name === 'planAction'), false);
  const planned = await rawRequest(server, `${V2}/plans`, { method: 'POST', body: plan });
  assert.equal(planned.status, 200, planned.raw);
  assert.deepEqual(calls.at(-1), ['planAction', plan]);
  assert.match(planned.body.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(planned.body.plan.actions.length, 1);
  assert.equal(planned.body.plan.actions[0].placementId, applyEntry.placementId);
  assert.equal(planned.body.confirmation.typedPhrase, null);
  assertNoPrivateTransport(planned.body.plan);
  const applied = await rawRequest(server, `${V2}/apply`, { method: 'POST', body: { capability: planned.body.capability, confirm: true } });
  assert.equal(applied.status, 200, applied.raw);
  assert.deepEqual(calls.at(-1), ['apply', { planId: 'plan-v2', actionIds: ['action-disable'], expectedPlanDigest: 'digest-v2', confirmed: true }]);
  assert.equal(applied.body.receipt.undoEligible, true);
  assertNoPrivateTransport(applied.body);
  assert.equal((await rawRequest(server, `${V2}/apply`, { method: 'POST', body: { capability: planned.body.capability, confirm: true } })).status, 409, 'one-use');

  // Unknown v2 POST paths are not on the mutation allowlist at all.
  assert.equal((await rawRequest(server, `${V2}/other`, { method: 'POST', body: {} })).status, 405);
  assert.equal((await rawRequest(server, `${V2}/inventory`, { method: 'POST', body: {} })).status, 405);
});

test('dashboard HTTP answers 503 on every v2 route when no management facade can be composed, while v1 keeps working', async (t) => {
  const server = await startDashboard({
    port: 0, usage: {}, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    maintenance: { async report() { return { findings: [] }; }, async scan() { return {}; }, async plan() { return {}; } },
    management: async () => { throw new Error('facade unavailable'); },
    maintenanceOptions: HERMETIC_MAINTENANCE,
  });
  t.after(() => server.close());
  assert.equal((await rawRequest(server, '/api/maintenance')).status, 200);
  const read = await rawRequest(server, '/api/maintenance/v2/activity');
  assert.deepEqual([read.status, read.body], [503, { error: 'maintenance management unavailable' }]);
  const written = await rawRequest(server, '/api/maintenance/v2/audit', { method: 'POST', body: { receiptIds: ['mnt-1'] } });
  assert.deepEqual([written.status, written.body], [503, { error: 'maintenance management unavailable' }]);
});
