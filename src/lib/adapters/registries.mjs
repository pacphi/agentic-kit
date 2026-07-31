import {
  BILLING_TYPES, CREDENTIAL_KINDS, assertEnum, assertId, assertRecord,
  assertStringArray, immutable, registryFrom,
} from './schema.mjs';

const HOST_CAPABILITIES = Object.freeze([
  'canDriveSession', 'canBePrimary', 'canRouteActivities', 'commandStatusline',
  'transcripts', 'usage', 'nativeMcpConfig', 'nativeGuidance',
]);
const PROVIDER_CAPABILITIES = Object.freeze([
  'modelDiscovery', 'runtimeDiscovery', 'quota', 'pricing', 'cacheAccounting',
]);

function validateCapabilities(value, names, field) {
  assertRecord(value, field);
  for (const name of names) {
    if (!(name in value)) throw new TypeError(`${field}.${name} is required`);
    if (name === 'pricing' || name === 'cacheAccounting') {
      if (typeof value[name] !== 'string') throw new TypeError(`${field}.${name} must be a string`);
    } else if (typeof value[name] !== 'boolean') {
      throw new TypeError(`${field}.${name} must be boolean`);
    }
  }
  return value;
}

export function validateProjectionAdapter(value) {
  assertRecord(value, 'projection');
  assertId(value.id, 'projection.id');
  if (typeof value.label !== 'string' || !value.label) throw new TypeError('projection.label is required');
  assertEnum(value.format, ['json', 'toml', 'env', 'cli', 'internal'], 'projection.format');
  return immutable(structuredClone(value));
}

export function validateObservabilityAdapter(value) {
  assertRecord(value, 'observability');
  assertId(value.id, 'observability.id');
  assertEnum(value.kind, ['transcript', 'usage', 'quota', 'catalog', 'runtime', 'statusline'], 'observability.kind');
  assertStringArray(value.evidence, 'observability.evidence', { allowEmpty: false });
  return immutable(structuredClone(value));
}

export function validateHostAdapter(value, {
  projections, observability,
} = /** @type {any} */ ({})) {
  assertRecord(value, 'host');
  assertId(value.id, 'host.id');
  if (typeof value.label !== 'string' || !value.label) throw new TypeError('host.label is required');
  assertRecord(value.install, 'host.install');
  if (typeof value.install.bin !== 'string' || !value.install.bin) throw new TypeError('host.install.bin is required');
  assertEnum(value.install.externalInstallPolicy,
    ['detect-never-overwrite', 'managed', 'unmanaged'], 'host.install.externalInstallPolicy');
  validateCapabilities(value.capabilities, HOST_CAPABILITIES, 'host.capabilities');
  assertId(value.configProjection, 'host.configProjection');
  assertStringArray(value.observability, 'host.observability');
  if (projections && !projections[value.configProjection]) {
    throw new TypeError(`host ${value.id} references unknown projection ${value.configProjection}`);
  }
  for (const id of value.observability) {
    if (observability && !observability[id]) throw new TypeError(`host ${value.id} references unknown observability ${id}`);
  }
  return immutable(structuredClone(value));
}

export function validateProviderAdapter(value, {
  projections, observability,
} = /** @type {any} */ ({})) {
  assertRecord(value, 'provider');
  assertId(value.id, 'provider.id');
  if (typeof value.label !== 'string' || !value.label) throw new TypeError('provider.label is required');
  assertEnum(value.billing, BILLING_TYPES, 'provider.billing');
  assertRecord(value.credentials, 'provider.credentials');
  assertEnum(value.credentials.kind, CREDENTIAL_KINDS, 'provider.credentials.kind');
  if (value.credentials.kind === 'environment') {
    assertStringArray(value.credentials.env, 'provider.credentials.env', { allowEmpty: false });
  }
  if (value.billing === 'local' && value.credentials.kind !== 'none') {
    throw new TypeError(`local provider ${value.id} cannot require credentials`);
  }
  assertStringArray(value.transports, 'provider.transports', { allowEmpty: false });
  assertStringArray(value.projections, 'provider.projections');
  assertStringArray(value.observability, 'provider.observability');
  validateCapabilities(value.capabilities, PROVIDER_CAPABILITIES, 'provider.capabilities');
  for (const id of value.projections) {
    if (projections && !projections[id]) throw new TypeError(`provider ${value.id} references unknown projection ${id}`);
  }
  for (const id of value.observability) {
    if (observability && !observability[id]) throw new TypeError(`provider ${value.id} references unknown observability ${id}`);
  }
  return immutable(structuredClone(value));
}

const PROJECTION_MAP = registryFrom([
  { id: 'claude', label: 'Claude settings and environment', format: 'json' },
  { id: 'codex', label: 'Codex configuration and profiles', format: 'toml' },
  { id: 'opencode', label: 'OpenCode configuration', format: 'json' },
  { id: 'ruflo', label: 'Ruflo router configuration', format: 'cli' },
  { id: 'aqe', label: 'Agentic QE router configuration', format: 'json' },
], validateProjectionAdapter, 'projection');

const OBSERVABILITY_MAP = registryFrom([
  { id: 'claude-transcripts', kind: 'transcript', evidence: ['host', 'model'] },
  { id: 'claude-statusline', kind: 'statusline', evidence: ['host', 'quota'] },
  { id: 'codex-transcripts', kind: 'transcript', evidence: ['host', 'model'] },
  { id: 'codex-app-server', kind: 'quota', evidence: ['host', 'quota'] },
  { id: 'opencode-logs', kind: 'transcript', evidence: ['host', 'model'] },
  { id: 'ollama-catalog', kind: 'catalog', evidence: ['provider', 'model', 'digest'] },
  { id: 'ollama-runtime', kind: 'runtime', evidence: ['provider', 'endpoint'] },
  { id: 'openrouter-metadata', kind: 'usage', evidence: ['provider', 'model', 'billing'] },
], validateObservabilityAdapter, 'observability');

const hostEntries = [
  {
    id: 'claude', label: 'Claude Code',
    install: { bin: 'claude', npmPackage: '@anthropic-ai/claude-code', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: { canDriveSession: true, canBePrimary: true, canRouteActivities: true, commandStatusline: true, transcripts: true, usage: true, nativeMcpConfig: true, nativeGuidance: true },
    auth: { apiKeyEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], loginFile: ['.claude', '.credentials.json'], keyOverridesLogin: false },
    legacy: {
      guidanceFile: 'claude', configFormat: 'json',
      statusline: { mode: 'command', scope: 'project', customCommand: true, multiline: true },
      aqeProvider: 'claude-code', envMarkers: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'],
      enableEnv: 'ENABLE_CLAUDE_CODE',
    },
    configProjection: 'claude', observability: ['claude-transcripts', 'claude-statusline'],
  },
  {
    id: 'codex', label: 'OpenAI Codex',
    install: { bin: 'codex', npmPackage: '@openai/codex', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: { canDriveSession: true, canBePrimary: true, canRouteActivities: true, commandStatusline: false, transcripts: true, usage: true, nativeMcpConfig: true, nativeGuidance: true },
    auth: { apiKeyEnv: ['OPENAI_API_KEY'], loginFile: ['.codex', 'auth.json'], keyOverridesLogin: true },
    legacy: {
      guidanceFile: 'agents', configFormat: 'toml',
      statusline: { mode: 'builtin', scope: 'user', customCommand: false, multiline: false },
      aqeProvider: 'codex', envMarkers: ['CODEX_SANDBOX', 'CODEX_HOME', 'CODEX_SESSION_ID'],
      enableEnv: 'ENABLE_CODEX',
    },
    configProjection: 'codex', observability: ['codex-transcripts', 'codex-app-server'],
  },
  {
    id: 'opencode', label: 'OpenCode',
    install: { bin: 'opencode', npmPackage: 'opencode-ai', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: { canDriveSession: true, canBePrimary: false, canRouteActivities: true, commandStatusline: false, transcripts: true, usage: false, nativeMcpConfig: true, nativeGuidance: true },
    auth: { apiKeyEnv: [], loginFile: ['.local', 'share', 'opencode', 'auth.json'], keyOverridesLogin: false },
    legacy: {
      guidanceFile: 'agents-opencode', configFormat: 'json',
      statusline: null, aqeProvider: null, envMarkers: [],
    },
    configProjection: 'opencode', observability: ['opencode-logs'],
  },
];

const providerEntries = [
  ['anthropic', 'Anthropic', 'subscription', { kind: 'host-login' }, ['native'], ['claude'], []],
  ['openai', 'OpenAI', 'subscription', { kind: 'host-login' }, ['native', 'openai-compatible'], ['codex'], []],
  ['google', 'Google Gemini', 'metered', { kind: 'environment', env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] }, ['native'], ['ruflo', 'aqe'], []],
  ['openrouter', 'OpenRouter', 'metered', { kind: 'environment', env: ['OPENROUTER_API_KEY'] }, ['openai-compatible'], ['ruflo', 'aqe', 'claude', 'codex', 'opencode'], ['openrouter-metadata']],
  ['ollama', 'Ollama', 'local', { kind: 'none' }, ['native', 'openai-compatible', 'anthropic-compatible'], ['ruflo', 'aqe', 'claude', 'codex', 'opencode'], ['ollama-catalog', 'ollama-runtime']],
].map(([id, label, billing, credentials, transports, projections, observability]) => ({
  id, label, billing, credentials, transports, projections, observability,
  legacy: { apiProvider: id !== 'openrouter' },
  capabilities: {
    modelDiscovery: id === 'ollama', runtimeDiscovery: id === 'ollama',
    pricing: id === 'ollama' ? 'zero' : (id === 'openrouter' ? 'dated-offline' : 'provider-specific'),
    quota: id === 'anthropic' || id === 'openai',
    cacheAccounting: id === 'ollama' ? 'unknown' : 'provider-dependent',
  },
}));

const HOST_MAP = registryFrom(hostEntries,
  (entry) => validateHostAdapter(entry, { projections: PROJECTION_MAP, observability: OBSERVABILITY_MAP }), 'host');
const PROVIDER_MAP = registryFrom(providerEntries,
  (entry) => validateProviderAdapter(entry, { projections: PROJECTION_MAP, observability: OBSERVABILITY_MAP }), 'provider');

export const PROJECTION_REGISTRY = immutable(Object.values(PROJECTION_MAP));
export const OBSERVABILITY_REGISTRY = immutable(Object.values(OBSERVABILITY_MAP));
export const HOST_REGISTRY = immutable(Object.values(HOST_MAP));
export const PROVIDER_REGISTRY = immutable(Object.values(PROVIDER_MAP));

// Cross-axis invariants — duplicate ids, unknown projection/observability
// references, the canDriveSession → canBePrimary/canRouteActivities
// relationship, billing/credential consistency — are enforced AT CONSTRUCTION,
// not only in tests. Previously validateRegistries ran nowhere in production
// (qe-court charge A3): a host flipped to canRouteActivities without
// canDriveSession would have loaded silently and been accepted by `ak run`.
const registryErrors = validateRegistries({
  hosts: Object.values(HOST_MAP),
  providers: Object.values(PROVIDER_MAP),
  projections: Object.values(PROJECTION_MAP),
  observability: Object.values(OBSERVABILITY_MAP),
});
if (registryErrors.length) {
  throw new Error(`adapter registries invalid: ${registryErrors.map((e) => `${e.path} (${e.code})`).join('; ')}`);
}

/** @param {(entry: any) => boolean} [predicate] */
export const hostIds = (predicate = () => true) => HOST_REGISTRY.filter(predicate).map(({ id }) => id);
/** @param {(entry: any) => boolean} [predicate] */
export const providerIds = (predicate = () => true) => PROVIDER_REGISTRY.filter(predicate).map(({ id }) => id);
export const primaryHostIds = () => hostIds((host) => host.capabilities.canBePrimary);
export const routableHostIds = () => hostIds((host) => host.capabilities.canRouteActivities);
export const managedHostIds = () => hostIds((host) => host.capabilities.canDriveSession);
export function hostsWithCapability(entriesOrCapability, maybeCapability) {
  const entries = Array.isArray(entriesOrCapability) ? entriesOrCapability : HOST_REGISTRY;
  const capability = Array.isArray(entriesOrCapability) ? maybeCapability : entriesOrCapability;
  return entries.filter((host) => host.capabilities?.[capability] === true);
}
export function providersWithCapability(entriesOrCapability, maybeCapability) {
  const entries = Array.isArray(entriesOrCapability) ? entriesOrCapability : PROVIDER_REGISTRY;
  const capability = Array.isArray(entriesOrCapability) ? maybeCapability : entriesOrCapability;
  return entries.filter((provider) => provider.capabilities?.[capability] === true);
}

export function validatePrimaryHost(id, hosts = HOST_REGISTRY) {
  const host = hosts.find((entry) => entry.id === id);
  if (!host) return { ok: false, reason: 'unknown-host' };
  return host.capabilities.canBePrimary
    ? { ok: true } : { ok: false, reason: 'capability-canBePrimary-required' };
}

export function validateActivityHost(id, hosts = HOST_REGISTRY) {
  const host = hosts.find((entry) => entry.id === id);
  if (!host) return { ok: false, reason: 'unknown-host' };
  return host.capabilities.canRouteActivities
    ? { ok: true } : { ok: false, reason: 'capability-canRouteActivities-required' };
}

export function validateRegistries(registries) {
  const errors = [];
  const axes = ['hosts', 'providers', 'projections', 'observability'];
  for (const axis of axes) {
    const seen = new Set();
    for (const [index, entry] of (registries?.[axis] ?? []).entries()) {
      if (seen.has(entry.id)) errors.push({ path: `${axis}[${index}].id`, code: 'duplicate-id', value: entry.id });
      seen.add(entry.id);
    }
  }
  const projections = new Set((registries?.projections ?? []).map((entry) => entry.id));
  const observability = new Set((registries?.observability ?? []).map((entry) => entry.id));
  for (const [index, host] of (registries?.hosts ?? []).entries()) {
    if (!projections.has(host.configProjection)) errors.push({
      path: `hosts[${index}].configProjection`, code: 'unknown-projection', value: host.configProjection,
    });
    for (const [sourceIndex, source] of (host.observability ?? []).entries()) {
      if (!observability.has(source)) errors.push({
        path: `hosts[${index}].observability[${sourceIndex}]`, code: 'unknown-observability', value: source,
      });
    }
    if (!host.capabilities?.canDriveSession) {
      for (const capability of ['canBePrimary', 'canRouteActivities']) {
        if (host.capabilities?.[capability]) errors.push({
          path: `hosts[${index}].capabilities.${capability}`, code: 'requires-canDriveSession', value: true,
        });
      }
    }
  }
  const envName = /^[A-Z][A-Z0-9_]*$/;
  for (const [index, provider] of (registries?.providers ?? []).entries()) {
    const kind = provider.credentials?.kind;
    if (provider.billing === 'local' && kind !== 'none') errors.push({
      path: `providers[${index}].credentials.kind`, code: 'local-credentials-must-be-none', value: kind,
    });
    if (provider.billing === 'local' && provider.capabilities?.pricing !== 'zero') errors.push({
      path: `providers[${index}].capabilities.pricing`, code: 'local-pricing-must-be-zero', value: provider.capabilities?.pricing,
    });
    if (provider.billing === 'metered' && !['env', 'environment'].includes(kind)) errors.push({
      path: `providers[${index}].credentials.kind`, code: 'metered-credentials-required', value: kind,
    });
    for (const [nameIndex, name] of (provider.credentials?.names ?? provider.credentials?.env ?? []).entries()) {
      if (!envName.test(name)) errors.push({
        path: `providers[${index}].credentials.names[${nameIndex}]`, code: 'invalid-env-name', value: name,
      });
    }
  }
  return errors;
}
