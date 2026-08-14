import { isDeepStrictEqual } from 'node:util';
import { immutable } from './schema.mjs';
import { PROVIDER_REGISTRY } from './registries.mjs';

export const CURRENT_INTEGRATIONS_VERSION = 2;

// A host's native provider = the registry provider with host-login
// credentials whose projections include that host (anthropic -> claude,
// openai -> codex). Derived from the registry instead of a literal map so
// it can't drift from the adapters it describes, and so a host with no such
// provider (e.g. opencode) simply has none — never a synthetic stand-in
// (F-13). Two host-login providers claiming the same host would silently
// last-write-wins in a plain Map build, defeating the whole point of
// deriving this from the registry — fail loudly at load time instead.
function buildNativeProviderByHost(providers) {
  const byHost = new Map();
  for (const provider of providers) {
    if (provider.credentials?.kind !== 'host-login') continue;
    for (const host of provider.projections) {
      const existing = byHost.get(host);
      if (existing && existing !== provider.id) {
        throw new Error(
          `adapter registry ambiguity: both '${existing}' and '${provider.id}' claim host-login for host '${host}'`,
        );
      }
      byHost.set(host, provider.id);
    }
  }
  return byHost;
}
const NATIVE_PROVIDER_BY_HOST = buildNativeProviderByHost(PROVIDER_REGISTRY);

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => plain(value) && Object.hasOwn(value, key);

function mergeBindings(current = [], legacy = []) {
  const merged = structuredClone(current);
  for (const binding of legacy) {
    if (merged.some((candidate) => isDeepStrictEqual(candidate, binding))) continue;
    const conflict = typeof binding?.id === 'string'
      ? merged.find((candidate) => candidate?.id === binding.id)
      : null;
    if (conflict) {
      throw new TypeError(
        `integrations binding conflict: providers.bindings entry ${binding.id} differs from integrations.bindings`,
      );
    }
    merged.push(structuredClone(binding));
  }
  return merged;
}

export function validateEndpoint(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { return { ok: false, reason: 'invalid-url' }; }
  if (parsed.username || parsed.password) return { ok: false, reason: 'embedded-credentials' };
  if (parsed.hash) return { ok: false, reason: 'fragment' };
  const secretParam = /^(?:access_?token|token|key|api_?key|auth|authorization|signature|sig|secret|password)$/i;
  if ([...parsed.searchParams.keys()].some((name) => secretParam.test(name))) {
    return { ok: false, reason: 'secret-query' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, reason: 'unsupported-protocol' };
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && !loopback) return { ok: false, reason: 'remote-http' };
  return { ok: true, normalized: endpoint };
}

export function migrateIntegrationConfig(config = {}, _options = {}) {
  const out = structuredClone(plain(config) ? config : {});
  if (out.integrations !== undefined && !plain(out.integrations)) return immutable(out);
  const existing = out.integrations ?? {};
  if (Number.isInteger(existing.version) && existing.version > CURRENT_INTEGRATIONS_VERSION) {
    return immutable(out);
  }
  if (Object.hasOwn(existing, 'bindings') && !Array.isArray(existing.bindings)) {
    return immutable(out);
  }
  if (Object.hasOwn(existing, 'hosts') && !plain(existing.hosts)) return immutable(out);
  if (Object.hasOwn(existing, 'ownership') && !plain(existing.ownership)) return immutable(out);

  const providers = plain(out.providers) ? out.providers : {};
  if (own(providers, 'hosts') && !plain(providers.hosts)) return immutable(out);
  if (own(providers, 'bindings') && !Array.isArray(providers.bindings)) return immutable(out);

  // The alpha writer's host set deliberately wins once at cutover over an
  // older additive integrations.hosts snapshot.
  const hosts = own(providers, 'hosts')
    ? structuredClone(providers.hosts)
    : structuredClone(existing.hosts ?? {});
  const enabled = Object.entries(hosts).filter(([, on]) => on).map(([host]) => host);
  const priorBindings = mergeBindings(
    Array.isArray(existing.bindings) ? existing.bindings : [],
    Array.isArray(providers.bindings) ? providers.bindings : [],
  );
  const seenHosts = new Set(priorBindings.map((binding) => binding.host));
  // A host with no registered native provider (F-13) gets no inferred
  // binding at all — nothing is restamped on any load, and it stays that
  // way until a real binding is declared for it.
  const inferred = enabled
    .filter((host) => !seenHosts.has(host))
    .map((host) => {
      const provider = NATIVE_PROVIDER_BY_HOST.get(host);
      return provider ? {
        id: `${provider}-via-${host}`,
        host,
        provider,
        model: null,
        transport: 'native',
        endpoint: null,
        provenance: 'inferred',
        managedBy: 'unknown',
      } : null;
    })
    .filter((binding) => binding !== null);
  const ownership = structuredClone(existing.ownership ?? {});
  const reverseMarker = 'rufloCodexMcp';
  const hasLegacyCodex = (own(providers, 'codexMcp') && providers.codexMcp != null)
    || (own(providers, reverseMarker) && providers[reverseMarker] != null);
  if (hasLegacyCodex) {
    ownership.codex = {
      source: 'legacy-providers',
      ...(plain(ownership.codex) ? ownership.codex : {}),
      ...(own(providers, 'codexMcp') ? { mcp: structuredClone(providers.codexMcp) } : {}),
      ...(own(providers, reverseMarker)
        ? { reverseMcp: structuredClone(providers[reverseMarker]) } : {}),
    };
  }
  const hasLegacyOpenCode = ['opencodeMcp', 'opencodeManaged', 'opencodeCatalogDir']
    .some((key) => own(providers, key) && providers[key] != null);
  if (hasLegacyOpenCode) {
    ownership.opencode = {
      source: 'legacy-providers',
      ...(plain(ownership.opencode) ? ownership.opencode : {}),
      ...(own(providers, 'opencodeMcp')
        ? { mcp: structuredClone(providers.opencodeMcp) } : {}),
      ...(own(providers, 'opencodeManaged')
        ? { managed: structuredClone(providers.opencodeManaged) } : {}),
      ...(own(providers, 'opencodeCatalogDir')
        ? { catalogDir: structuredClone(providers.opencodeCatalogDir) } : {}),
    };
  }
  out.integrations = {
    ...existing,
    version: CURRENT_INTEGRATIONS_VERSION,
    hosts,
    bindings: [...priorBindings, ...inferred],
    ...(Object.keys(ownership).length ? { ownership } : {}),
  };
  delete out.integrations.schemaVersion;
  if (plain(out.providers)) {
    for (const key of [
      'hosts', 'bindings', 'codexMcp', reverseMarker,
      'opencodeMcp', 'opencodeManaged', 'opencodeCatalogDir',
    ]) delete out.providers[key];
  }
  return immutable(out);
}
