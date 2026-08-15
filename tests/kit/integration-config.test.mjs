import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_INTEGRATIONS_VERSION,
  migrateIntegrationConfig,
  validateEndpoint,
} from '../../src/lib/adapters/config.mjs';
import { migrateConfig } from '../../src/lib/adapters/migration.mjs';
import { migrateKitConfig } from '../../src/lib/config.mjs';

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

test('integration migration is versioned, deterministic, and idempotent', () => {
  const input = structuredClone(legacyDual);
  const first = migrateIntegrationConfig(input);
  const second = migrateIntegrationConfig(structuredClone(first));
  assert.equal(CURRENT_INTEGRATIONS_VERSION, 2,
    'v2 distinguishes completed GA cutover from additive v1 snapshots');
  assert.equal(first.integrations.version, CURRENT_INTEGRATIONS_VERSION);
  assert.deepEqual(second, first);
  assert.deepEqual(input, legacyDual, 'migration must not mutate its input');
  assert.equal(first.unrelated, 'keep-me');
  assert.deepEqual(first.providers.customUserField, { preserve: true });
  assert.equal(Object.hasOwn(first.providers, 'hosts'), false);
  assert.deepEqual(first.providers.dualRouting, legacyDual.providers.dualRouting,
    'the independent routing migration still owns this field');
});

test('top-level migration retires routing compatibility fields but keeps provider-axis state', () => {
  const migrated = migrateKitConfig({
    ...structuredClone(legacyDual),
    providers: {
      ...structuredClone(legacyDual.providers),
      primaryHost: 'codex',
      aqeFallback: [{ provider: 'openrouter', models: ['z-ai/glm-5'], source: 'user' }],
      maxBudgetUsd: 7,
    },
  });
  assert.deepEqual(migrated.routing, {
    version: 1,
    primaryHost: 'codex',
    routes: {
      implementation: {
        host: 'codex',
        model: 'gpt-5.4',
        provenance: 'user',
        escalation: [{ host: 'claude', model: 'claude-opus-5' }],
      },
    },
  });
  for (const key of ['hosts', 'primaryHost', 'dualRouting']) {
    assert.equal(Object.hasOwn(migrated.providers, key), false);
  }
  assert.deepEqual(migrated.providers.aqeFallback,
    [{ provider: 'openrouter', models: ['z-ai/glm-5'], source: 'user' }]);
  assert.equal(migrated.providers.maxBudgetUsd, 7);
  assert.deepEqual(migrateKitConfig(structuredClone(migrated)), migrated);
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
  // the 'unknown' provenance path no longer exists post-F-13: a host with no
  // registered native provider gets no binding at all, so any binding that
  // IS produced is always 'inferred'.
  assert.equal(route.provenance, 'inferred');
  assert.notEqual(route.provenance, 'observed');
});

test('legacy OpenCode ownership markers migrate canonically without inferring a provider', () => {
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
  for (const key of ['opencodeMcp', 'opencodeManaged', 'opencodeCatalogDir']) {
    assert.equal(Object.hasOwn(migrated.providers, key), false);
  }
  const binding = migrated.integrations.bindings.find(({ host }) => host === 'opencode');
  assert.equal(binding, undefined,
    'opencode has no host-login native provider in the registry, so migration infers no binding for it (F-13)');
});

test('legacy Codex ownership markers migrate together and are retired', () => {
  const reverseMarker = 'rufloCodexMcp';
  const migrated = migrateIntegrationConfig({
    providers: { codexMcp: 'ak', [reverseMarker]: 'ak', aqeProvider: 'openai' },
  });
  assert.deepEqual(migrated.integrations.ownership.codex, {
    source: 'legacy-providers',
    mcp: 'ak',
    reverseMcp: 'ak',
  });
  assert.equal(Object.hasOwn(migrated.providers, 'codexMcp'), false);
  assert.equal(Object.hasOwn(migrated.providers, reverseMarker), false);
  assert.equal(migrated.providers.aqeProvider, 'openai');
});

test('null legacy markers are retired without manufacturing ownership', () => {
  const reverseMarker = 'rufloCodexMcp';
  const migrated = migrateIntegrationConfig({
    providers: {
      codexMcp: null,
      [reverseMarker]: null,
      opencodeMcp: null,
      opencodeManaged: null,
      opencodeCatalogDir: null,
    },
    integrations: { schemaVersion: 1 },
  });
  assert.equal(Object.hasOwn(migrated.integrations, 'ownership'), false);
  assert.equal(Object.hasOwn(migrated.integrations, 'schemaVersion'), false);
  assert.deepEqual(migrated.providers, {});
});

test('active legacy hosts win once over a stale additive integration snapshot', () => {
  const migrated = migrateIntegrationConfig({
    providers: { hosts: { claude: false, codex: true, opencode: true } },
    integrations: {
      version: 1,
      hosts: { claude: true, codex: false, opencode: false },
      bindings: [],
    },
  });
  assert.equal(migrated.integrations.version, CURRENT_INTEGRATIONS_VERSION);
  assert.deepEqual(migrated.integrations.hosts,
    { claude: false, codex: true, opencode: true });
  assert.equal(Object.hasOwn(migrated.providers, 'hosts'), false);
});

test('legacy bindings survive a stale additive integration snapshot without duplication', () => {
  const legacyBinding = {
    id: 'openrouter-via-codex',
    host: 'codex',
    provider: 'openrouter',
    model: 'openai/gpt-5.4',
    transport: 'native',
    endpoint: null,
    provenance: 'user',
    managedBy: 'user',
  };
  const migrated = migrateIntegrationConfig({
    providers: { bindings: [legacyBinding] },
    integrations: { version: 1, hosts: {}, bindings: [] },
  });
  assert.deepEqual(migrated.integrations.bindings, [legacyBinding]);
  assert.equal(Object.hasOwn(migrated.providers, 'bindings'), false);
  assert.deepEqual(migrateIntegrationConfig(structuredClone(migrated)), migrated);
});

test('conflicting canonical and legacy binding ids fail closed', () => {
  const canonical = {
    id: 'shared', host: 'codex', provider: 'openai', model: null,
    transport: 'native', endpoint: null, provenance: 'user', managedBy: 'user',
  };
  assert.throws(() => migrateIntegrationConfig({
    providers: { bindings: [{ ...canonical, provider: 'openrouter' }] },
    integrations: { version: 1, hosts: {}, bindings: [canonical] },
  }), /integrations binding conflict/);
});

test('legacy OpenCode ownership merges beside an existing ownership receipt', () => {
  const legacy = {
    providers: { opencodeMcp: 'ak', opencodeManaged: { mcp: {} } },
    integrations: {
      version: 1,
      ownership: {
        codex: { source: 'existing' },
        opencode: { source: 'v1-snapshot', mcp: null, keep: true },
      },
    },
  };
  const migrated = migrateIntegrationConfig(legacy);
  assert.deepEqual(migrated.integrations.ownership.codex, { source: 'existing' });
  assert.deepEqual(migrated.integrations.ownership.opencode, {
    source: 'v1-snapshot',
    mcp: 'ak',
    keep: true,
    managed: { mcp: {} },
  }, 'active legacy values override a stale v1 snapshot without dropping canonical fields');
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

test('migrating claude+codex+opencode infers registry-native bindings and nothing for opencode', () => {
  const migrated = migrateIntegrationConfig({
    providers: { hosts: { claude: true, codex: true, opencode: true } },
  });
  const byHost = Object.fromEntries(migrated.integrations.bindings.map((b) => [b.host, b]));
  assert.equal(byHost.claude.id, 'anthropic-via-claude');
  assert.equal(byHost.claude.provider, 'anthropic');
  assert.equal(byHost.claude.provenance, 'inferred');
  assert.equal(byHost.codex.id, 'openai-via-codex');
  assert.equal(byHost.codex.provider, 'openai');
  assert.equal(byHost.codex.provenance, 'inferred');
  assert.equal(Object.hasOwn(byHost, 'opencode'), false,
    'opencode has no host-login native provider registered, so it gets no inferred binding');
});

test('inferring native bindings is idempotent — a second migration pass never restamps', () => {
  const first = migrateIntegrationConfig({
    providers: { hosts: { claude: true, codex: true, opencode: true } },
  });
  const second = migrateIntegrationConfig(structuredClone(first));
  assert.deepEqual(second, first);
});

test('a prior user binding for a host wins over the registry-derived default', () => {
  const priorBinding = {
    id: 'openrouter-via-codex',
    host: 'codex',
    provider: 'openrouter',
    model: 'openai/gpt-5.4',
    transport: 'native',
    endpoint: null,
    provenance: 'user',
    managedBy: 'user',
  };
  const migrated = migrateIntegrationConfig({
    providers: { hosts: { claude: true, codex: true }, bindings: [priorBinding] },
  });
  const codexBindings = migrated.integrations.bindings.filter((b) => b.host === 'codex');
  assert.equal(codexBindings.length, 1);
  assert.deepEqual(codexBindings[0], priorBinding);
});

test('migrateIntegrationConfig handles an empty hosts map without inferring anything', () => {
  const migrated = migrateIntegrationConfig({ providers: { hosts: {} } });
  assert.deepEqual(migrated.integrations.bindings, []);
  assert.deepEqual(migrated.integrations.hosts, {});
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
