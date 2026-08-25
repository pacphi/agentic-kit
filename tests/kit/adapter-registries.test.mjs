import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_REGISTRY,
  PROVIDER_REGISTRY,
  PROJECTION_REGISTRY,
  OBSERVABILITY_REGISTRY,
  MODEL_DISCOVERY_REGISTRY,
  validateRegistries,
  validateHostAdapter,
  validateModelDiscoveryAdapter,
  defaultHostMap,
  assertValidBinding,
} from '../../src/lib/adapters/index.mjs';
import {
  validHost, validProvider, validRegistries,
} from './helpers/integration-builders.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the built-in registries satisfy their own contract', () => {
  assert.deepEqual(validateRegistries({
    hosts: HOST_REGISTRY,
    providers: PROVIDER_REGISTRY,
    projections: PROJECTION_REGISTRY,
    observability: OBSERVABILITY_REGISTRY,
  }), []);
});

test('model discovery registry is immutable metadata, never executable dispatch', () => {
  assert.deepEqual(MODEL_DISCOVERY_REGISTRY.map((entry) => entry.id), [
    'claude-config', 'codex-cache', 'opencode-models', 'ollama-catalog',
  ]);
  for (const entry of MODEL_DISCOVERY_REGISTRY) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.values(entry).some((value) => typeof value === 'function'), false);
    assert.match(entry.ownerType, /^(host|provider)$/);
    assert.match(entry.network, /^(never|local|explicit)$/);
  }
  assert.throws(() => { MODEL_DISCOVERY_REGISTRY[0].id = 'changed'; }, TypeError);
});

test('model discovery descriptor validation rejects ambiguous owners and unsafe command metadata', () => {
  assert.throws(() => validateModelDiscoveryAdapter({
    id: 'ambiguous', ownerType: 'host', ownerId: 'claude', provider: 'anthropic',
    transport: 'file', network: 'never', schema: 'v1',
  }), /unknown field provider/);
  assert.throws(() => validateModelDiscoveryAdapter({
    id: 'unsafe', ownerType: 'host', ownerId: 'opencode', transport: 'command',
    command: 'opencode models', network: 'explicit', schema: 'v1',
  }), /command must be an executable name/);
  assert.throws(() => validateModelDiscoveryAdapter({
    id: 'unsafe-http', ownerType: 'provider', ownerId: 'ollama', transport: 'http',
    endpoint: 'http://remote.example:11434', network: 'local', schema: 'v1',
  }), /loopback HTTP/);
  assert.doesNotThrow(() => validateModelDiscoveryAdapter({
    id: 'local-http', ownerType: 'provider', ownerId: 'ollama', transport: 'http',
    endpoint: 'http://127.0.0.1:11434', network: 'local', schema: 'v1',
  }));
});

// qe-court A3: the cross-axis invariants now run AT module construction — a
// host edit that violates canDriveSession → canBePrimary/canRouteActivities
// (or any other cross-axis rule) makes the import itself throw instead of
// loading silently. Pin it with a real import in a fresh process.
test('the shipped registries cannot fail construction-time validation (import cannot throw)', () => {
  const r = spawnSync(process.execPath, ['-e',
    "import('./src/lib/adapters/registries.mjs').then(() => console.log('construction-valid'))",
  ], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, `registries module must import cleanly:\n${r.stderr}`);
  assert.match(r.stdout, /construction-valid/);
});

test('built-in ids are unique within each registry and host/provider axes stay distinct', () => {
  for (const [axis, entries] of Object.entries({
    hosts: HOST_REGISTRY,
    providers: PROVIDER_REGISTRY,
    projections: PROJECTION_REGISTRY,
    observability: OBSERVABILITY_REGISTRY,
  })) {
    const ids = entries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `${axis} ids must be unique`);
  }
  const hostIds = new Set(HOST_REGISTRY.map((entry) => entry.id));
  for (const provider of PROVIDER_REGISTRY) {
    assert.equal(hostIds.has(provider.id), false, `${provider.id} must not also be a host`);
  }
});

test('registry validation reports duplicate ids with a deterministic field path', () => {
  const registries = validRegistries({
    hosts: [validHost(), validHost({ label: 'Duplicate host' })],
  });
  assert.deepEqual(validateRegistries(registries), [
    { path: 'hosts[1].id', code: 'duplicate-id', value: 'test-host' },
  ]);
});

test('registry validation rejects dangling projection and observability references', () => {
  const registries = validRegistries({
    hosts: [validHost({
      configProjection: 'missing-projection',
      observability: ['missing-source'],
    })],
  });
  assert.deepEqual(validateRegistries(registries), [
    { path: 'hosts[0].configProjection', code: 'unknown-projection', value: 'missing-projection' },
    { path: 'hosts[0].observability[0]', code: 'unknown-observability', value: 'missing-source' },
  ]);
});

test('routing and primary capabilities require a session-driving host', () => {
  const registries = validRegistries({
    hosts: [validHost({ capabilities: {
      ...validHost().capabilities,
      canDriveSession: false,
      canBePrimary: true,
      canRouteActivities: true,
    } })],
  });
  assert.deepEqual(validateRegistries(registries), [
    { path: 'hosts[0].capabilities.canBePrimary', code: 'requires-canDriveSession', value: true },
    { path: 'hosts[0].capabilities.canRouteActivities', code: 'requires-canDriveSession', value: true },
  ]);
});

test('billing and credential combinations reject fabricated local and metered semantics', () => {
  const localWithKey = validProvider({
    id: 'bad-local',
    billing: 'local',
    credentials: { kind: 'env', names: ['LOCAL_API_KEY'] },
    capabilities: { ...validProvider().capabilities, pricing: 'dated-offline' },
  });
  const meteredWithoutKey = validProvider({
    id: 'bad-metered',
    billing: 'metered',
    credentials: { kind: 'none' },
  });
  const errors = validateRegistries(validRegistries({ providers: [localWithKey, meteredWithoutKey] }));
  assert.deepEqual(errors, [
    { path: 'providers[0].credentials.kind', code: 'local-credentials-must-be-none', value: 'env' },
    { path: 'providers[0].capabilities.pricing', code: 'local-pricing-must-be-zero', value: 'dated-offline' },
    { path: 'providers[1].credentials.kind', code: 'metered-credentials-required', value: 'none' },
  ]);
});

test('credential descriptors contain environment variable names, never credential values', () => {
  const provider = validProvider({
    credentials: { kind: 'env', names: ['sk-secret-value'] },
  });
  assert.deepEqual(validateRegistries(validRegistries({ providers: [provider] })), [
    { path: 'providers[0].credentials.names[0]', code: 'invalid-env-name', value: 'sk-secret-value' },
  ]);
});

// F-15: the {claude:true, codex:false, opencode:false} enablement literal used
// to be triplicated across config.mjs, providers.mjs and x/host.mjs. It is now
// derived from HOST_REGISTRY.enabledByDefault via defaultHostMap().
test('defaultHostMap mirrors the historical host-enablement default', () => {
  assert.deepEqual(defaultHostMap(), { claude: true, codex: false, opencode: false });
});

test('defaultHostMap returns a fresh, independently mutable object every call', () => {
  const first = defaultHostMap();
  first.codex = true;
  assert.notEqual(first, defaultHostMap());
  assert.deepEqual(defaultHostMap(), { claude: true, codex: false, opencode: false });
});

test('every built-in host declares a boolean enabledByDefault', () => {
  for (const host of HOST_REGISTRY) {
    assert.equal(typeof host.enabledByDefault, 'boolean', `${host.id}.enabledByDefault must be boolean`);
  }
});

test('validateHostAdapter rejects a host with a missing or non-boolean enabledByDefault', () => {
  assert.throws(() => validateHostAdapter(validHost()), /host\.enabledByDefault must be boolean/);
  assert.throws(() => validateHostAdapter(validHost({ enabledByDefault: 'yes' })),
    /host\.enabledByDefault must be boolean/);
});

test('validateHostAdapter accepts a host with an explicit boolean enabledByDefault', () => {
  assert.doesNotThrow(() => validateHostAdapter(validHost({ enabledByDefault: true })));
  assert.doesNotThrow(() => validateHostAdapter(validHost({ enabledByDefault: false })));
});

// ── F-28: providerEntries moved from a tuple-array `.map` (capabilities derived
// by identity comparison, e.g. `modelDiscovery: id === 'ollama'`) to explicit
// per-entry object records — the same style hostEntries already uses. That
// construction could not express a second local provider needing pricing
// 'zero' WITHOUT modelDiscovery (ADR-0028's local-openai). This test hardcodes
// the five pre-existing rows' expected shape (not re-derived from the source)
// so the refactor cannot silently change what ships. See also ADR-0028.
test('F-28: the five pre-existing providers are unchanged by the per-entry rewrite', () => {
  const byId = Object.fromEntries(PROVIDER_REGISTRY.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.anthropic, {
    id: 'anthropic', label: 'Anthropic', billing: 'subscription',
    credentials: { kind: 'host-login' }, transports: ['native'], projections: ['claude'], observability: [],
    legacy: { apiProvider: true },
    capabilities: {
      modelDiscovery: false, runtimeDiscovery: false, pricing: 'provider-specific',
      quota: true, cacheAccounting: 'provider-dependent',
    },
  });
  assert.deepEqual(byId.openai, {
    id: 'openai', label: 'OpenAI', billing: 'subscription',
    credentials: { kind: 'host-login' }, transports: ['native', 'openai-compatible'], projections: ['codex'], observability: [],
    legacy: { apiProvider: true },
    capabilities: {
      modelDiscovery: false, runtimeDiscovery: false, pricing: 'provider-specific',
      quota: true, cacheAccounting: 'provider-dependent',
    },
  });
  assert.deepEqual(byId.google, {
    id: 'google', label: 'Google Gemini', billing: 'metered',
    credentials: { kind: 'environment', env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
    transports: ['native'], projections: ['ruflo', 'aqe'], observability: [],
    legacy: { apiProvider: true },
    capabilities: {
      modelDiscovery: false, runtimeDiscovery: false, pricing: 'provider-specific',
      quota: false, cacheAccounting: 'provider-dependent',
    },
  });
  assert.deepEqual(byId.openrouter, {
    id: 'openrouter', label: 'OpenRouter', billing: 'metered',
    credentials: { kind: 'environment', env: ['OPENROUTER_API_KEY'] },
    transports: ['openai-compatible'], projections: ['ruflo', 'aqe', 'claude', 'codex', 'opencode'],
    observability: ['openrouter-metadata'],
    legacy: { apiProvider: false },
    capabilities: {
      modelDiscovery: false, runtimeDiscovery: false, pricing: 'dated-offline',
      quota: false, cacheAccounting: 'provider-dependent',
    },
  });
  assert.deepEqual(byId.ollama, {
    id: 'ollama', label: 'Ollama', billing: 'local',
    credentials: { kind: 'none' },
    transports: ['native', 'openai-compatible', 'anthropic-compatible'],
    projections: ['ruflo', 'aqe', 'claude', 'codex', 'opencode'],
    observability: ['ollama-catalog', 'ollama-runtime'],
    legacy: { apiProvider: true },
    capabilities: {
      modelDiscovery: true, runtimeDiscovery: true, pricing: 'zero',
      quota: false, cacheAccounting: 'unknown',
    },
  });
});

// ADR-0028: one generic local provider for any OpenAI-compatible model server
// on loopback (MLX, LM Studio, llama.cpp, vLLM, user-named endpoints), instead
// of enumerating vendors.
test('ADR-0028: local-openai is registered with the accepted shape', () => {
  const localOpenai = PROVIDER_REGISTRY.find((entry) => entry.id === 'local-openai');
  assert.ok(localOpenai, 'local-openai must be registered');
  assert.equal(localOpenai.billing, 'local');
  assert.deepEqual(localOpenai.credentials, { kind: 'none' });
  assert.deepEqual(localOpenai.transports, ['openai-compatible']);
  // Deliberate asymmetry vs ollama: no 'aqe' (ollama is an AQE provider type,
  // local-openai is not) and no 'claude' (claude's projection expects an
  // anthropic-compatible surface; local-openai claims only openai-compatible).
  assert.deepEqual(localOpenai.projections, ['ruflo', 'codex', 'opencode']);
  assert.deepEqual(localOpenai.observability, []);
  assert.deepEqual(localOpenai.capabilities, {
    modelDiscovery: false, runtimeDiscovery: false, pricing: 'zero',
    quota: false, cacheAccounting: 'unknown',
  });
});

test('PROVIDER_REGISTRY has exactly six entries after the local-openai addition', () => {
  assert.deepEqual(PROVIDER_REGISTRY.map((entry) => entry.id).sort(), [
    'anthropic', 'google', 'local-openai', 'ollama', 'openai', 'openrouter',
  ]);
});

// assertValidBinding gating: local-openai's projections/transports are
// exercised end-to-end through a user-declared binding, both the accepted
// shape and the rejections the accepted ADR design implies.
test('assertValidBinding accepts a user-declared local-openai binding on codex', () => {
  const binding = assertValidBinding({
    id: 'local-openai-via-codex', host: 'codex', provider: 'local-openai',
    transport: 'openai-compatible', endpoint: 'http://127.0.0.1:8080/v1',
    provenance: 'configured',
  });
  assert.equal(binding.provider, 'local-openai');
  assert.equal(binding.projection, 'codex');
});

test('assertValidBinding rejects a local-openai binding on the native transport', () => {
  assert.throws(() => assertValidBinding({
    id: 'local-openai-native', host: 'codex', provider: 'local-openai',
    transport: 'native', endpoint: 'http://127.0.0.1:8080/v1', provenance: 'configured',
  }), /unsupported transport/);
});

test('assertValidBinding rejects local-openai for the aqe projection', () => {
  assert.throws(() => assertValidBinding({
    id: 'local-openai-aqe', host: 'codex', provider: 'local-openai',
    transport: 'openai-compatible', endpoint: 'http://127.0.0.1:8080/v1',
    projection: 'aqe', provenance: 'configured',
  }), /does not support projection aqe/);
});

test('assertValidBinding rejects local-openai on claude host default projection', () => {
  assert.throws(() => assertValidBinding({
    id: 'local-openai-claude', host: 'claude', provider: 'local-openai',
    transport: 'openai-compatible', endpoint: 'http://127.0.0.1:8080/v1',
    provenance: 'configured',
  }), /does not support projection claude/);
});

// Endpoint topology pin (review nit): "local" is a BILLING claim (user-run,
// $0 — ADR-0011), not a loopback constraint. A user-run server on another
// machine is legal over https; plain http stays loopback-only
// (validateEndpoint's remote-http rule). Pinned so a future "tighten local
// to loopback" change is a deliberate decision, not drift.
test('assertValidBinding accepts a remote https endpoint for local-openai (billing, not topology)', () => {
  const binding = assertValidBinding({
    id: 'local-openai-lan', host: 'codex', provider: 'local-openai',
    transport: 'openai-compatible', endpoint: 'https://models.lan.example/v1',
    provenance: 'configured',
  });
  assert.equal(binding.endpoint, 'https://models.lan.example/v1');
});

test('assertValidBinding rejects a remote plain-http endpoint for local-openai', () => {
  assert.throws(() => assertValidBinding({
    id: 'local-openai-remote-http', host: 'codex', provider: 'local-openai',
    transport: 'openai-compatible', endpoint: 'http://models.lan.example/v1',
    provenance: 'configured',
  }), /remote-http/);
});
