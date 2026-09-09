import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertMaintenancePersistenceSupported } from '../../src/lib/maintenance/persistence-support.mjs';
import { ensurePrivateMaintenanceRoot } from '../../src/lib/maintenance/plan-store.mjs';
import { listMaintenanceReceipts } from '../../src/lib/maintenance/transaction-store.mjs';

test('native Windows persistence refuses rather than claiming private durable storage', () => {
  assert.throws(() => assertMaintenancePersistenceSupported({ platform: 'win32' }), {
    code: 'MAINTENANCE_PERSISTENCE_UNAVAILABLE',
  });
});

test('POSIX persistence proceeds to the actual filesystem durability checks', () => {
  assert.doesNotThrow(() => assertMaintenancePersistenceSupported({ platform: 'linux' }));
  assert.doesNotThrow(() => assertMaintenancePersistenceSupported({ platform: 'darwin' }));
});

test('inventory storage setup and empty receipt inspection remain available on every host', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-readonly-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(ensurePrivateMaintenanceRoot(root), root);
  assert.deepEqual(listMaintenanceReceipts(path.join(root, 'transactions')), []);
});
