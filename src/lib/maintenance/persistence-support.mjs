import fs from 'node:fs';

/** Native Windows needs a verified private, durable storage adapter before
 * mutation can be enabled. Injected filesystem ports are independently owned
 * adapters; the default Node port cannot establish this guarantee on Windows. */
export function assertMaintenancePersistenceSupported({ fsImpl = fs, platform = process.platform } = {}) {
  if (platform !== 'win32' || fsImpl !== fs) return;
  throw Object.assign(new Error('Native Windows maintenance mutations require a verified private, durable storage adapter. Inventory and guided procedures remain available.'), {
    code: 'MAINTENANCE_PERSISTENCE_UNAVAILABLE',
  });
}
