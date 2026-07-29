import { immutable } from './schema.mjs';

export const INTEGRATIONS_SCHEMA_VERSION = 1;

export function normalizeIntegrations(config = {}) {
  const source = /** @type {any} */ (config && typeof config === 'object' ? config : {});
  const existing = source.integrations && typeof source.integrations === 'object'
    ? source.integrations : {};
  if (Number.isInteger(existing.version) && existing.version > INTEGRATIONS_SCHEMA_VERSION) {
    return immutable(structuredClone(existing));
  }
  if (Object.hasOwn(existing, 'bindings') && !Array.isArray(existing.bindings)) {
    return immutable(structuredClone(existing));
  }
  const legacyHosts = source.providers?.hosts && typeof source.providers.hosts === 'object'
    ? source.providers.hosts : {};
  const hosts = { ...legacyHosts, ...(existing.hosts ?? {}) };
  // Migration preserves user intent byte-for-byte structurally. Validation and
  // resolution are separate operations; enriching a binding here would make
  // the two public migration entry points oscillate between shapes.
  const bindings = structuredClone(existing.bindings ?? source.providers?.bindings ?? []);
  if (!Array.isArray(bindings)) throw new TypeError('integrations.bindings must be an array');
  return immutable({
    version: INTEGRATIONS_SCHEMA_VERSION,
    hosts,
    bindings,
  });
}

export function migrateConfig(config = {}) {
  const before = /** @type {any} */ (config && typeof config === 'object' ? config : {});
  if ((Number.isInteger(before.integrations?.version)
      && before.integrations.version > INTEGRATIONS_SCHEMA_VERSION)
    || (Object.hasOwn(before.integrations ?? {}, 'bindings')
      && !Array.isArray(before.integrations.bindings))) {
    return immutable({ changed: false, config: structuredClone(before) });
  }
  const integrations = normalizeIntegrations(before);
  const current = before.integrations;
  const changed = !current || current.version !== integrations.version
    || Object.hasOwn(current, 'schemaVersion')
    || JSON.stringify(current.hosts ?? {}) !== JSON.stringify(integrations.hosts)
    || JSON.stringify(current.bindings ?? []) !== JSON.stringify(integrations.bindings);
  return immutable({
    changed,
    config: changed ? { ...structuredClone(before), integrations } : structuredClone(before),
  });
}

export function legacyRouteProvider(route, bindings = []) {
  if (!route?.host) return { provider: null, provenance: 'unknown', binding: null };
  const candidates = bindings.filter((binding) => binding.host === route.host
    && (!route.model || !binding.model || binding.model === route.model));
  if (candidates.length !== 1) return { provider: null, provenance: 'unknown', binding: null };
  return immutable({ provider: candidates[0].provider, provenance: 'inferred', binding: candidates[0].id });
}
