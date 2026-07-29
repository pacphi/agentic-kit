import { OWNERSHIP_TYPES, PROVENANCE_TYPES, assertEnum, assertId, assertRecord, immutable } from './schema.mjs';
import { HOST_REGISTRY, PROVIDER_REGISTRY, PROJECTION_REGISTRY } from './registries.mjs';
import { validateEndpoint } from './config.mjs';

export function assertValidEndpoint(endpoint, { allowRemote = true } = {}) {
  if (endpoint == null) return 'none';
  const result = validateEndpoint(endpoint);
  if (!result.ok) throw new TypeError(`invalid endpoint: ${result.reason}`);
  const parsed = new URL(result.normalized);
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
  if (!allowRemote && !loopback) throw new TypeError('remote endpoint is not allowed');
  return loopback ? 'loopback' : 'remote-https';
}

export function assertValidBinding(value, {
  hosts = HOST_REGISTRY, providers = PROVIDER_REGISTRY, projections = PROJECTION_REGISTRY,
} = {}) {
  assertRecord(value, 'binding');
  assertId(value.id, 'binding.id');
  assertId(value.host, 'binding.host');
  assertId(value.provider, 'binding.provider');
  const hostMap = Array.isArray(hosts) ? Object.fromEntries(hosts.map((entry) => [entry.id, entry])) : hosts;
  const providerMap = Array.isArray(providers) ? Object.fromEntries(providers.map((entry) => [entry.id, entry])) : providers;
  const projectionMap = Array.isArray(projections) ? Object.fromEntries(projections.map((entry) => [entry.id, entry])) : projections;
  if (!hostMap[value.host]) throw new TypeError(`binding ${value.id} references unknown host ${value.host}`);
  const provider = providerMap[value.provider];
  if (!provider) throw new TypeError(`binding ${value.id} references unknown provider ${value.provider}`);
  if (typeof value.transport !== 'string' || !provider.transports.includes(value.transport)) {
    throw new TypeError(`binding ${value.id} has unsupported transport ${value.transport}`);
  }
  const projection = value.projection ?? hostMap[value.host].configProjection;
  if (!projectionMap[projection]) throw new TypeError(`binding ${value.id} references unknown projection ${projection}`);
  if (!provider.projections.includes(projection)) {
    throw new TypeError(`provider ${value.provider} does not support projection ${projection}`);
  }
  if (value.endpoint != null) assertValidEndpoint(value.endpoint);
  if (value.model != null && (typeof value.model !== 'string' || !value.model)) {
    throw new TypeError('binding.model must be a non-empty string');
  }
  assertEnum(value.provenance ?? 'configured', PROVENANCE_TYPES, 'binding.provenance');
  assertEnum(value.managedBy ?? 'unknown', OWNERSHIP_TYPES, 'binding.managedBy');
  return immutable({
    ...structuredClone(value), projection,
    endpoint: value.endpoint ?? null, model: value.model ?? null,
    provenance: value.provenance ?? 'configured', managedBy: value.managedBy ?? 'unknown',
  });
}

export function validateBindings(values, registries) {
  if (!Array.isArray(values)) throw new TypeError('bindings must be an array');
  const ids = new Set();
  return immutable(values.map((value) => {
    const binding = assertValidBinding(value, registries);
    if (ids.has(binding.id)) throw new TypeError(`duplicate binding id: ${binding.id}`);
    ids.add(binding.id);
    return binding;
  }));
}

export function resolveBinding(bindings, {
  host, provider, model, projection, endpoint,
} = /** @type {any} */ ({})) {
  const candidates = bindings.filter((binding) =>
    (!host || binding.host === host)
    && (!provider || binding.provider === provider)
    && (!model || binding.model === model)
    && (!projection || binding.projection === projection)
    && (!endpoint || binding.endpoint === endpoint));
  return candidates.length === 1 ? candidates[0] : null;
}

export function validateBinding(binding, registries, constraints = {}) {
  const errors = [];
  const hostIds = new Set(constraints.hosts ?? (registries?.hosts ?? []).map((entry) => entry.id));
  const providerIds = new Set(constraints.providers ?? (registries?.providers ?? []).map((entry) => entry.id));
  const provider = (registries?.providers ?? []).find((entry) => entry.id === binding?.provider);
  if (!hostIds.has(binding?.host)) errors.push({ path: 'binding.host', code: 'unknown-host', value: binding?.host });
  if (!providerIds.has(binding?.provider)) errors.push({ path: 'binding.provider', code: 'unknown-provider', value: binding?.provider });
  const transports = constraints.transports?.[binding?.provider] ?? provider?.transports ?? [];
  if (!transports.includes(binding?.transport)) errors.push({
    path: 'binding.transport', code: 'unsupported-transport', value: binding?.transport,
  });
  return errors;
}

export const BUILTIN_BINDINGS = validateBindings([
  {
    id: 'ollama-via-claude', host: 'claude', provider: 'ollama',
    transport: 'anthropic-compatible', endpoint: 'http://127.0.0.1:11434',
    provenance: 'configured', managedBy: 'external',
  },
  {
    id: 'ollama-via-codex', host: 'codex', provider: 'ollama',
    transport: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1/',
    provenance: 'configured', managedBy: 'external',
  },
]);
