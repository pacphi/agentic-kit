import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_INTEGRATIONS_VERSION,
  migrateIntegrationConfig,
  validateEndpoint,
} from '../../src/lib/adapters/config.mjs';
import { migrateConfig } from '../../src/lib/adapters/migration.mjs';

const legacyDual = {
  providers: {
    hosts: { claude: true, codex: true },
    aqeProvider: null,
    dualRouting: {
      implementation: {
        host: 'codex', model: 'gpt-5.4', source: 'user',
        escalate: [{ host: 'claude', model: 'claude-opus-5' }],
      },
    },
    customUserField: { preserve: true },
  },
  unrelated: 'keep-me',
};

test('legacy migration is additive, versioned, deterministic, and idempotent', () => {
  const input = structuredClone(legacyDual);
  const first = migrateIntegrationConfig(input);
  const second = migrateIntegrationConfig(structuredClone(first));
  assert.equal(first.integrations.version, CURRENT_INTEGRATIONS_VERSION);
  assert.deepEqual(second, first);
  assert.deepEqual(input, legacyDual, 'migration must not mutate its input');
  assert.equal(first.unrelated, 'keep-me');
  assert.deepEqual(first.providers.customUserField, { preserve: true });
  assert.deepEqual(first.providers.dualRouting, legacyDual.providers.dualRouting,
    'legacy routing intent must survive byte-for-byte structurally');
});

test('public migration helpers converge on one canonical integrations.version field', () => {
  const first = migrateIntegrationConfig(structuredClone(legacyDual));
  const middle = migrateConfig(structuredClone(first)).config;
  const final = migrateIntegrationConfig(structuredClone(middle));
  assert.deepEqual(final, first);
  assert.equal(final.integrations.version, CURRENT_INTEGRATIONS_VERSION);
  assert.equal(Object.hasOwn(final.integrations, 'schemaVersion'), false);
});

test('future integration versions are preserved opaquely and never downgraded', () => {
  const future = {
    unrelated: 'keep',
    integrations: {
      version: CURRENT_INTEGRATIONS_VERSION + 10,
      bindings: { futureShape: ['opaque', 'intent'] },
      futureField: { preserve: true },
    },
  };
  assert.deepEqual(migrateIntegrationConfig(structuredClone(future)), future);
  assert.deepEqual(migrateConfig(structuredClone(future)).config, future);
});

test('malformed current-version bindings are preserved rather than silently dropped', () => {
  const malformed = {
    integrations: {
      version: CURRENT_INTEGRATIONS_VERSION,
      bindings: { not: 'an array' },
    },
  };
  assert.deepEqual(migrateIntegrationConfig(structuredClone(malformed)), malformed);
  assert.deepEqual(migrateConfig(structuredClone(malformed)).config, malformed);
});

test('legacy host routes never manufacture observed provider provenance', () => {
  const migrated = migrateIntegrationConfig(structuredClone(legacyDual));
  const route = migrated.integrations.bindings.find((binding) => binding.host === 'codex');
  assert.ok(route, 'migration should expose a normalized binding for an enabled legacy host');
  assert.ok(['inferred', 'unknown'].includes(route.provenance));
  assert.notEqual(route.provenance, 'observed');
});

test('legacy OpenCode ownership markers migrate additively without inferring a provider', () => {
  const legacy = {
    providers: {
      hosts: { claude: true, codex: false, opencode: true },
      opencodeMcp: 'ak',
      opencodeManaged: { mcp: { 'claude-flow': { prior: null, written: { type: 'local' } } } },
      opencodeCatalogDir: '/catalog',
    },
  };
  const migrated = migrateIntegrationConfig(legacy);
  assert.equal(migrated.integrations.ownership.opencode.source, 'legacy-providers');
  assert.deepEqual(migrated.integrations.ownership.opencode.managed, legacy.providers.opencodeManaged);
  assert.equal(migrated.providers.opencodeMcp, 'ak', 'migration is additive; legacy receipt remains');
  const binding = migrated.integrations.bindings.find(({ host }) => host === 'opencode');
  assert.equal(binding.provider, null);
  assert.equal(binding.provenance, 'unknown');
});

test('legacy OpenCode ownership merges beside an existing ownership receipt', () => {
  const legacy = {
    providers: { opencodeMcp: 'ak', opencodeManaged: { mcp: {} } },
    integrations: { ownership: { codex: { source: 'existing' } } },
  };
  const migrated = migrateIntegrationConfig(legacy);
  assert.deepEqual(migrated.integrations.ownership.codex, { source: 'existing' });
  assert.equal(migrated.integrations.ownership.opencode.source, 'legacy-providers');
});

test('migration never persists API keys found in process environment', () => {
  const migrated = migrateIntegrationConfig(structuredClone(legacyDual), {
    env: {
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENAI_API_KEY: 'openai-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
    },
  });
  const serialized = JSON.stringify(migrated);
  for (const secret of ['anthropic-secret', 'openai-secret', 'openrouter-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('endpoint validation accepts loopback HTTP and remote HTTPS', () => {
  for (const endpoint of [
    'http://127.0.0.1:11434',
    'http://localhost:11434/v1/',
    'http://[::1]:11434/v1',
    'https://openrouter.ai/api/v1',
  ]) {
    assert.deepEqual(validateEndpoint(endpoint), { ok: true, normalized: endpoint },
      `expected valid endpoint: ${endpoint}`);
  }
});

test('endpoint validation rejects unsafe or ambiguous endpoints', () => {
  const cases = new Map([
    ['http://inference.example.test/v1', 'remote-http'],
    ['https://user:secret@example.test/v1', 'embedded-credentials'],
    ['https://example.test/v1#token', 'fragment'],
    ['file:///tmp/socket', 'unsupported-protocol'],
    ['http://localhost.example.test:11434', 'remote-http'],
    ['https://example.test/v1?api_key=secret', 'secret-query'],
    ['https://example.test/v1?signature=secret', 'secret-query'],
    ['not a url', 'invalid-url'],
  ]);
  for (const [endpoint, reason] of cases) {
    assert.deepEqual(validateEndpoint(endpoint), { ok: false, reason },
      `expected ${reason}: ${endpoint}`);
  }
});
