import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMaintenancePersistenceSupported } from '../../src/lib/maintenance/persistence-support.mjs';

test('native Windows persistence refuses rather than claiming private durable storage', () => {
  assert.throws(() => assertMaintenancePersistenceSupported({ platform: 'win32' }), {
    code: 'MAINTENANCE_PERSISTENCE_UNAVAILABLE',
  });
});

test('POSIX persistence proceeds to the actual filesystem durability checks', () => {
  assert.doesNotThrow(() => assertMaintenancePersistenceSupported({ platform: 'linux' }));
  assert.doesNotThrow(() => assertMaintenancePersistenceSupported({ platform: 'darwin' }));
});
