import { immutable } from './schema.mjs';

export const CURRENT_INTEGRATIONS_VERSION = 1;

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
  const out = structuredClone(config);
  const existing = out.integrations ?? {};
  if (Number.isInteger(existing.version) && existing.version > CURRENT_INTEGRATIONS_VERSION) {
    return immutable(out);
  }
  if (Object.hasOwn(existing, 'bindings') && !Array.isArray(existing.bindings)) {
    return immutable(out);
  }
  const enabled = Object.entries(out.providers?.hosts ?? {}).filter(([, on]) => on).map(([host]) => host);
  const defaults = { claude: 'anthropic', codex: 'openai' };
  const priorBindings = Array.isArray(existing.bindings) ? existing.bindings : [];
  const seenHosts = new Set(priorBindings.map((binding) => binding.host));
  const inferred = enabled.filter((host) => !seenHosts.has(host)).map((host) => ({
    id: `${defaults[host] ?? 'unknown'}-via-${host}`,
    host,
    provider: defaults[host] ?? null,
    model: null,
    transport: 'native',
    endpoint: null,
    provenance: defaults[host] ? 'inferred' : 'unknown',
    managedBy: 'unknown',
  }));
  const legacyOpenCode = out.providers?.opencodeMcp === 'ak'
    || out.providers?.opencodeManaged != null
    || out.providers?.opencodeCatalogDir != null;
  const ownership = {
    ...(existing.ownership ?? {}),
    ...(legacyOpenCode && !existing.ownership?.opencode ? { opencode: {
      source: 'legacy-providers',
      mcp: out.providers?.opencodeMcp ?? null,
      managed: structuredClone(out.providers?.opencodeManaged ?? null),
      catalogDir: out.providers?.opencodeCatalogDir ?? null,
    } } : {}),
  };
  out.integrations = {
    ...existing,
    version: CURRENT_INTEGRATIONS_VERSION,
    hosts: { ...(out.providers?.hosts ?? {}), ...(existing.hosts ?? {}) },
    bindings: [...priorBindings, ...inferred],
    ...(Object.keys(ownership).length ? { ownership } : {}),
  };
  return immutable(out);
}
