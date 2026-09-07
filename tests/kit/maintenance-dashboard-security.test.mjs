import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createMaintenanceCapabilityStore,
  maintenanceMutationRejection,
  readMaintenanceJson,
  validateMaintenanceBody,
} from '../../src/lib/dashboard/maintenance-security.mjs';

const HEADERS = {
  host: '127.0.0.1:7431',
  origin: 'http://127.0.0.1:7431',
  'sec-fetch-site': 'same-origin',
};

test('maintenance mutation origin requires exact same-origin browser evidence', () => {
  assert.equal(maintenanceMutationRejection(HEADERS), null);
  assert.match(maintenanceMutationRejection({ ...HEADERS, origin: 'http://localhost:7431' }), /foreign Origin/);
  assert.match(maintenanceMutationRejection({ ...HEADERS, 'sec-fetch-site': 'cross-site' }), /cross-site/);
  assert.match(maintenanceMutationRejection({ host: HEADERS.host, origin: HEADERS.origin }), /fetch metadata/);
  assert.match(maintenanceMutationRejection({ host: HEADERS.host, 'sec-fetch-site': 'same-origin' }), /exact Origin/);
});

test('maintenance mutation schemas reject client-supplied authority', () => {
  assert.deepEqual(validateMaintenanceBody('/api/maintenance/plans', { findingIds: ['finding-a'] }), {
    findingIds: ['finding-a'],
  });
  for (const extra of ['path', 'command', 'providerId', 'argv', 'actionIds', 'planDigest']) {
    assert.throws(() => validateMaintenanceBody('/api/maintenance/plans', {
      findingIds: ['finding-a'], [extra]: 'hostile',
    }), /invalid/);
  }
  assert.throws(() => validateMaintenanceBody('/api/maintenance/plans', { findingIds: ['same', 'same'] }), /invalid/);
  assert.throws(() => validateMaintenanceBody('/api/maintenance/undo', {
    receiptId: '../receipt', preview: true,
  }), /invalid/);
});

test('maintenance JSON reader is content-type and size bounded', async () => {
  const request = (body, headers) => Object.assign(Readable.from([Buffer.from(body)]), { headers });
  assert.deepEqual(await readMaintenanceJson(request('{"findingIds":["a"]}', {
    'content-type': 'application/json; charset=utf-8',
  })), { findingIds: ['a'] });
  await assert.rejects(readMaintenanceJson(request('{}', { 'content-type': 'text/plain' })), {
    statusCode: 415,
  });
  await assert.rejects(readMaintenanceJson(request('{', { 'content-type': 'application/json' })), {
    statusCode: 400,
  });
  await assert.rejects(readMaintenanceJson(request('{}'.padEnd(65_537, ' '), {
    'content-type': 'application/json',
  })), { statusCode: 413 });
  await assert.rejects(readMaintenanceJson(request('{}', {
    'content-type': 'application/json', 'content-length': '999999',
  })), { statusCode: 413 });
});

test('maintenance capabilities are session-bound, expiring, exact-verb and one-use', () => {
  let clock = 1_000;
  let serial = 0;
  const random = () => Buffer.alloc(32, ++serial).toString('base64url');
  const store = createMaintenanceCapabilityStore({ now: () => clock, random, ttlMs: 100 });
  const apply = store.mint({
    sessionToken: 'session-a', verb: 'apply', authority: { planId: 'p1' },
  });
  assert.throws(() => store.consume({ capability: apply, sessionToken: 'session-b', verb: 'apply' }), /absent|belongs/);
  assert.throws(() => store.consume({ capability: apply, sessionToken: 'session-a', verb: 'undo' }), /absent|belongs/);
  assert.deepEqual(store.consume({ capability: apply, sessionToken: 'session-a', verb: 'apply' }), { planId: 'p1' });
  assert.throws(() => store.consume({ capability: apply, sessionToken: 'session-a', verb: 'apply' }), /absent|expired/);

  const undo = store.mint({ sessionToken: 'session-a', verb: 'undo', authority: { receiptId: 'r1' } });
  clock += 101;
  assert.throws(() => store.consume({ capability: undo, sessionToken: 'session-a', verb: 'undo' }), /absent|expired/);
  assert.equal(store.size(), 0);
  assert.throws(() => store.mint({
    sessionToken: 'session-a', verb: 'apply', authority: { planId: 'bad' }, expiresAt: Number.NaN,
  }), /expiry/);
});

// ── ADR-0048 v2 additions ──────────────────────────────────────────────────

test('maintenance v2 route table matches every allowlisted path exactly and binds opaque path parameters', async () => {
  const {
    MAINTENANCE_MUTATION_ROUTES, MAINTENANCE_V2_MUTATION_ROUTES, MAINTENANCE_V2_ROUTES, isMaintenanceMutationRoute,
    matchMaintenanceV2Route,
  } = await import('../../src/lib/dashboard/maintenance-security.mjs');
  const V2 = '/api/maintenance/v2';
  const placementId = 'plc_abcdefghijklmnopqrstuvwxyz1';
  const guidanceId = 'gid_abcdefghijklmnopqrstuvwxyz1';
  const receiptId = 'mnt-20260905T110000000Z-fixture01';
  assert.deepEqual(matchMaintenanceV2Route('GET', `${V2}/inventory`), { name: 'inventory', params: {} });
  assert.deepEqual(matchMaintenanceV2Route('GET', `${V2}/placements/${placementId}`), { name: 'placement', params: { placementId } });
  assert.deepEqual(matchMaintenanceV2Route('GET', `${V2}/procedures/${guidanceId}`), { name: 'procedure', params: { guidanceId } });
  assert.deepEqual(matchMaintenanceV2Route('GET', `${V2}/receipts/${receiptId}`), { name: 'receipt', params: { receiptId } });
  assert.deepEqual(matchMaintenanceV2Route('POST', `${V2}/scans`), { name: 'scanControl', params: {} });
  assert.deepEqual(matchMaintenanceV2Route('GET', `${V2}/scans`), { name: 'scans', params: {} });
  for (const path of [
    `${V2}/inventory/`, `${V2}/Inventory`, `${V2}/placements/${guidanceId}`, `${V2}/placements/plc_short`,
    `${V2}/placements/${placementId}/`, `${V2}/procedures/${placementId}`, `${V2}/receipts/receipt-1`,
    `${V2}/receipts/mnt-${'a'.repeat(121)}`, `${V2}/receipts/mnt-a/b`, `${V2}/placements/reveal`, `${V2}/plans`,
    `${V2}/inventory?scope=user`, '/api/maintenance/plans',
  ]) {
    assert.equal(matchMaintenanceV2Route('GET', path), null, path);
  }
  assert.equal(matchMaintenanceV2Route('POST', `${V2}/inventory`), null);
  assert.equal(matchMaintenanceV2Route('POST', `${V2}/placements/${placementId}`), null);
  assert.equal(MAINTENANCE_V2_ROUTES.length, 30);
  assert.equal(MAINTENANCE_V2_MUTATION_ROUTES.size, 21);
  for (const route of MAINTENANCE_V2_MUTATION_ROUTES) {
    assert.equal(matchMaintenanceV2Route('POST', route)?.name !== undefined, true, route);
    assert.equal(isMaintenanceMutationRoute(route), true);
  }
  assert.deepEqual([...MAINTENANCE_MUTATION_ROUTES], ['/api/maintenance/plans', '/api/maintenance/apply', '/api/maintenance/undo']);
  assert.equal(isMaintenanceMutationRoute(`${V2}/inventory`), false);
  assert.equal(isMaintenanceMutationRoute(`${V2}/placements/${placementId}`), false);
});

test('maintenance capability store accepts the reconcile verb and keeps it distinct from apply and undo', async () => {
  const { createMaintenanceCapabilityStore: createStore } = await import('../../src/lib/dashboard/maintenance-security.mjs');
  let serial = 0;
  const store = createStore({ now: () => 1_000, random: () => Buffer.alloc(32, ++serial).toString('base64url') });
  const reconcile = store.mint({ sessionToken: 's', verb: 'reconcile', authority: { receiptId: 'mnt-1', outcome: 'record-no-change' } });
  assert.throws(() => store.consume({ capability: reconcile, sessionToken: 's', verb: 'apply' }), /belongs/);
  assert.throws(() => store.consume({ capability: reconcile, sessionToken: 's', verb: 'undo' }), /belongs/);
  assert.deepEqual(store.consume({ capability: reconcile, sessionToken: 's', verb: 'reconcile' }), { receiptId: 'mnt-1', outcome: 'record-no-change' });
  assert.throws(() => store.mint({ sessionToken: 's', verb: 'disposition', authority: {} }), /invalid maintenance capability authority/);
});

test('maintenance v2 body validators enforce exact keys, closed vocabularies, and path-typed inputs only on Discovery routes', async () => {
  const { validateMaintenanceV2Body } = await import('../../src/lib/dashboard/maintenance-security.mjs');
  const now = () => Date.parse('2026-09-05T12:00:00.000Z');
  const placementId = 'plc_abcdefghijklmnopqrstuvwxyz1';
  const guidanceId = 'gid_abcdefghijklmnopqrstuvwxyz1';
  assert.deepEqual(validateMaintenanceV2Body('reveal', { placementId }), { placementId });
  assert.deepEqual(validateMaintenanceV2Body('discoveryPreview', { kind: 'collection-root', root: '/Users/alice/dev' }), { kind: 'collection-root', root: '/Users/alice/dev' });
  assert.deepEqual(validateMaintenanceV2Body('discoveryPreview', { kind: 'exact-project', root: 'C:\\Users\\alice\\dev' }), { kind: 'exact-project', root: 'C:\\Users\\alice\\dev' });
  assert.deepEqual(validateMaintenanceV2Body('discoveryExclusions', { path: '/Users/alice/tmp', recursive: false }), { path: '/Users/alice/tmp', recursive: false });
  assert.deepEqual(validateMaintenanceV2Body('receiptExport', { receiptId: 'mnt-1', includeLocalPaths: false }), { receiptId: 'mnt-1', includeLocalPaths: false, acknowledgedWarning: false });
  assert.deepEqual(validateMaintenanceV2Body('dispositions', { guidanceId, kind: 'snoozed', until: '2026-10-01T00:00:00Z', confirm: true }, { now }), { guidanceId, kind: 'snoozed', until: '2026-10-01T00:00:00Z', confirm: true });
  assert.deepEqual(validateMaintenanceV2Body('scanControl', { action: 'start' }), { action: 'start' });
  assert.deepEqual(validateMaintenanceV2Body('reconcile', { capability: 'x'.repeat(43), confirm: true, typedPhrase: 'RECORD' }), { capability: 'x'.repeat(43), confirm: true, typedPhrase: 'RECORD' });
  assert.deepEqual(validateMaintenanceV2Body('savePreferences', { retention: { maxSummaries: 4 } }), { retention: { maxSummaries: 4 } });
  const rejected = [
    ['reveal', { placementId, root: '/x' }], ['reveal', { placementId: 'plc_abc' }],
    ['checklist', { guidanceId, stepId: 'a/b', done: true }],
    ['discoveryPreview', { kind: 'exact-project', root: '/a/../b' }], ['discoveryPreview', { kind: 'exact-project', root: 'a/b' }],
    ['discoveryPreview', { kind: 'exact-project', root: `/${'a'.repeat(1030)}` }], ['discoveryPreview', { kind: 'exact-project', root: '/a\u0000b' }],
    ['discoverySources', { previewId: 'prv_abcdefghijklmnopqrstuvwxyz1', confirm: 'yes' }],
    ['discoveryAutomatic', { sourceId: 'Claude-User', enabled: true }],
    ['scanControl', { action: 'pause' }], ['scanControl', { action: 'resume', sourceId: 'claude-user', confirm: true }],
    ['receiptExport', { receiptId: 'mnt-1', includeLocalPaths: true }],
    ['dispositions', { guidanceId, kind: 'snoozed', until: '2028-10-01T00:00:00Z', confirm: true }],
    ['dispositions', { guidanceId, kind: 'snoozed', until: '2026-10-01', confirm: true }],
    ['audit', { receiptIds: Array.from({ length: 21 }, (_, index) => `mnt-${index}`) }],
    ['reconcilePreview', { receiptId: 'mnt-1', outcome: 'record-everything' }],
    ['reconcile', { capability: 'x'.repeat(43), confirm: true }],
    ['plans', { placementId, guidanceId, actionIds: ['a'] }], ['plans', { placementId: guidanceId, guidanceId: placementId }],
    ['recipesAccept', { recipeId: 'r1', recipeVersion: 'v 1', confirm: true }],
    ['savePreferences', { lastView: { view: 'nope' } }], ['savePreferences', { retention: { maxSummaries: -1 } }],
    ['nope', {}],
  ];
  for (const [name, body] of rejected) {
    assert.throws(() => validateMaintenanceV2Body(name, body, { now }), TypeError, `${name} ${JSON.stringify(body)}`);
  }
});

test('maintenance v2 query validator normalizes facets and refuses unknown, duplicate, or path-shaped parameters', async () => {
  const { validateMaintenanceV2Query } = await import('../../src/lib/dashboard/maintenance-security.mjs');
  const parse = (name, query) => validateMaintenanceV2Query(name, new URLSearchParams(query));
  assert.deepEqual(parse('inventory', 'scope=across&view=updates&facet.kind=skill&facet.kind=plugin&facet.consumer=claude&sort=kind&limit=25&search=clarity'), {
    scope: 'across', view: 'updates', facets: { kind: ['skill', 'plugin'], consumer: ['claude'] }, sort: 'kind', limit: 25, search: 'clarity',
  });
  assert.deepEqual(parse('inventory', ''), { facets: {} });
  assert.deepEqual(parse('guidance', 'lane=recovery'), { lane: 'recovery' });
  assert.deepEqual(parse('procedure', 'shell=powershell'), { shell: 'powershell' });
  assert.deepEqual(parse('activity', ''), {});
  for (const [name, query] of [
    ['inventory', 'scope=all'], ['inventory', 'limit=500'], ['inventory', 'limit=1e2'], ['inventory', 'facet.kind=skill&facet.kind=skill'],
    ['inventory', 'facet.kind=%2FUsers%2Falice'], ['inventory', 'search=C%3A%5CUsers'], ['inventory', 'cursor=..%2F'],
    ['inventory', 'view=all&view=all'], ['inventory', 'facet.kind=' + Array.from({ length: 33 }, (_, index) => `k${index}`).join('&facet.kind=')],
    ['guidance', 'lane=apply&lane=steps'], ['guidance', 'facet.kind=skill'], ['procedure', 'shell=sh'], ['activity', 'refresh=scan'],
  ]) {
    assert.throws(() => parse(name, query), TypeError, `${name}?${query}`);
  }
});
