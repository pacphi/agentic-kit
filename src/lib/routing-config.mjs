import { isDeepStrictEqual } from 'node:util';
import { immutable } from './adapters/schema.mjs';

export const ROUTING_SCHEMA_VERSION = 1;
export const DEFAULT_PRIMARY_HOST = 'claude';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => plain(value) && Object.hasOwn(value, key);
// Frozen at the pre-GA cutover: migration must preserve the host that an
// omitted alpha route inherited then, even if live defaults change later.
const LEGACY_DEFAULT_HOSTS = {
  specification: 'claude',
  architecture: 'claude',
  design: 'claude',
  implementation: 'codex',
  testing: 'codex',
  review: 'claude',
  'security-scan': 'codex',
  'security-analysis': 'claude',
  documentation: 'codex',
  debugging: 'claude',
  packaging: 'codex',
  release: 'claude',
};

/** Convert the persisted alpha route shape without resolving defaults.
 * Absence is meaningful: a missing escalation inherits the built-in ladder,
 * while an empty escalation deliberately suppresses it. */
export function legacyRoutesToCanonical(routes = {}) {
  if (!plain(routes)) throw new TypeError('providers.dualRouting must be an object');
  const out = {};
  for (const [activity, route] of Object.entries(routes)) {
    if (!plain(route)) {
      throw new TypeError(`providers.dualRouting.${activity} must be an object`);
    }
    const next = {};
    for (const [key, value] of Object.entries(route)) {
      if (key === 'source' || key === 'escalate') continue;
      next[key] = structuredClone(value);
    }
    if (!own(next, 'host')) {
      const defaultHost = LEGACY_DEFAULT_HOSTS[activity];
      if (!defaultHost) {
        throw new TypeError(
          `providers.dualRouting.${activity}.host is required because the activity has no default host`,
        );
      }
      next.host = defaultHost;
    }
    next.provenance = own(route, 'source') ? structuredClone(route.source) : 'user';
    if (own(route, 'escalate')) next.escalation = structuredClone(route.escalate);
    out[activity] = next;
  }
  return out;
}

export function validateRoutingEnvelope(envelope) {
  if (!plain(envelope)) throw new TypeError('routing must be an object');
  if (envelope.version !== ROUTING_SCHEMA_VERSION) {
    throw new TypeError(`unsupported routing.version ${String(envelope.version)}`);
  }
  if (typeof envelope.primaryHost !== 'string' || envelope.primaryHost.length === 0) {
    throw new TypeError('routing.primaryHost must be a non-empty string');
  }
  if (!plain(envelope.routes)) throw new TypeError('routing.routes must be an object');
  for (const [activity, route] of Object.entries(envelope.routes)) {
    if (!plain(route)) throw new TypeError(`routing.routes.${activity} must be an object`);
    if (typeof route.host !== 'string' || route.host.length === 0) {
      throw new TypeError(`routing.routes.${activity}.host must be a non-empty string`);
    }
    if (own(route, 'model') && route.model !== null
      && (typeof route.model !== 'string' || route.model.length === 0)) {
      throw new TypeError(`routing.routes.${activity}.model must be a non-empty string or null`);
    }
    if (!['default', 'seeded', 'user'].includes(route.provenance)) {
      throw new TypeError(`routing.routes.${activity}.provenance must be default, seeded, or user`);
    }
    if (own(route, 'escalation')) {
      if (!Array.isArray(route.escalation)) {
        throw new TypeError(`routing.routes.${activity}.escalation must be an array`);
      }
      for (const [index, rung] of route.escalation.entries()) {
        if (!plain(rung) || typeof rung.host !== 'string' || rung.host.length === 0) {
          throw new TypeError(`routing.routes.${activity}.escalation[${index}].host must be a non-empty string`);
        }
        if (own(rung, 'model') && rung.model !== null
          && (typeof rung.model !== 'string' || rung.model.length === 0)) {
          throw new TypeError(`routing.routes.${activity}.escalation[${index}].model must be a non-empty string or null`);
        }
      }
    }
  }
  return envelope;
}

/** Normalize the top-level routing envelope and retire only the legacy fields
 * that were successfully represented. Future versions remain fully opaque. */
export function migrateRoutingConfig(config = {}) {
  const out = structuredClone(plain(config) ? config : {});
  const providers = plain(out.providers) ? out.providers : {};
  const hasLegacyRoutes = own(providers, 'dualRouting');
  const hasLegacyPrimary = own(providers, 'primaryHost');
  const existing = out.routing;

  if (plain(existing) && Number.isInteger(existing.version)
    && existing.version > ROUTING_SCHEMA_VERSION) {
    return immutable(out);
  }

  let routing;
  if (existing !== undefined) {
    validateRoutingEnvelope(existing);
    if (hasLegacyPrimary && providers.primaryHost !== existing.primaryHost) {
      throw new TypeError('routing conflict: providers.primaryHost differs from routing.primaryHost');
    }
    if (hasLegacyRoutes) {
      const legacyRoutes = legacyRoutesToCanonical(providers.dualRouting);
      if (!isDeepStrictEqual(legacyRoutes, existing.routes)) {
        throw new TypeError('routing conflict: providers.dualRouting differs from routing.routes');
      }
    }
    routing = structuredClone(existing);
  } else {
    routing = {
      version: ROUTING_SCHEMA_VERSION,
      primaryHost: hasLegacyPrimary ? structuredClone(providers.primaryHost) : DEFAULT_PRIMARY_HOST,
      routes: hasLegacyRoutes ? legacyRoutesToCanonical(providers.dualRouting) : {},
    };
    validateRoutingEnvelope(routing);
  }

  out.routing = routing;
  if (plain(out.providers)) {
    delete out.providers.primaryHost;
    delete out.providers.dualRouting;
  }
  return immutable(out);
}

/** Validated read API for routing consumers. */
export function routingIntent(config = {}) {
  return immutable(structuredClone(validateRoutingEnvelope(config.routing)));
}
