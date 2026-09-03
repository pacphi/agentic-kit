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
});
