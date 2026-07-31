import { isDeepStrictEqual } from 'node:util';
import {
  CURRENT_INTEGRATIONS_VERSION,
  migrateIntegrationConfig,
} from './config.mjs';
import { immutable } from './schema.mjs';

export const INTEGRATIONS_SCHEMA_VERSION = CURRENT_INTEGRATIONS_VERSION;

export function normalizeIntegrations(config = {}) {
  const migrated = migrateIntegrationConfig(config);
  return immutable(structuredClone(migrated.integrations ?? {}));
}

export function migrateConfig(config = {}) {
  const before = config && typeof config === 'object' ? structuredClone(config) : {};
  const next = migrateIntegrationConfig(before);
  return immutable({
    changed: !isDeepStrictEqual(before, next),
    config: structuredClone(next),
  });
}
