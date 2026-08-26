import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectModelBindings } from '../../src/lib/model-inventory/bindings.mjs';
import { collectObservedModels } from '../../src/lib/model-inventory/observed.mjs';
import { collectModelInventory, composeModelSnapshot, refreshModelDiscovery } from '../../src/lib/model-inventory/refresh.mjs';
import { isCompleteStableSnapshot, normalizeBindingRecord, normalizeModelRecord } from '../../src/lib/model-inventory/contracts.mjs';

const SCOPE_KEY = '0123456789abcdef0123456789abcdef';

test('binding collection enumerates routes and escalation without inventing provider identity', () => {
  const result = collectModelBindings({ config: { routing: { routes: {
    testing: { host: 'codex', model: 'gpt-5.6-terra', provenance: 'user', reasoningEffort: 'high', escalation: [
      { host: 'claude', model: 'sonnet' },
    ] },
  } } } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.bindings.map((binding) => ({
    activity: binding.activity, host: binding.host, provider: binding.provider,
    modelRef: binding.modelRef, consumer: binding.consumer,
  })), [
    { activity: 'testing', host: 'codex', provider: null, modelRef: 'gpt-5.6-terra', consumer: 'route:testing' },
    { activity: 'testing', host: 'claude', provider: null, modelRef: 'sonnet', consumer: 'route:testing:escalation:0' },
  ]);
  assert.equal(result.bindings[0].variant.reasoningEffort, 'high');
  assert.doesNotThrow(() => result.bindings.map(normalizeBindingRecord));
});

test('binding collection includes AQE and Ruflo as independently sourced consumers', () => {
  const result = collectModelBindings({
    config: { routing: { routes: {} } },
    aqeConfig: { defaultProvider: 'codex', fallbackChain: [{ provider: 'openrouter', model: 'z-ai/glm-5' }], agentOverrides: { tester: { provider: 'codex', model: 'gpt-5.6-terra' } } },
    rufloConfig: { candidates: [{ provider: 'openrouter', model: 'z-ai/glm-5', price: 0.1 }] },
  });
  assert.deepEqual(new Set(result.bindings.map((binding) => binding.consumer)), new Set(['aqe:default', 'aqe:fallback:0', 'aqe:agent:tester', 'ruflo:candidate:0']));
  assert.equal(result.bindings.find((binding) => binding.consumer === 'ruflo:candidate:0').evidenceClass, 'configured');
});

test('observed collection reuses readIndex and emits no prompt, title, or transcript content', async () => {
  const calls = [];
  const result = await collectObservedModels({
    readIndexFn: async (options) => {
      calls.push(options);
      return { generatedAt: '2026-08-25T13:00:00.000Z', sourceHealth: { codex: { status: 'ok' } }, sessions: [
        { id: 'secret-id', host: 'codex', provider: 'openai', providerProvenance: 'observed', models: ['gpt-5.6-terra'], title: 'PRIVATE PROMPT', turns: ['PRIVATE'] },
        { id: 'other', host: 'codex', provider: 'openai', providerProvenance: 'observed', models: ['gpt-5.6-terra', 'gpt-5.4'] },
      ] };
    },
    indexOptions: { roots: { codex: '/fixtures' } }, scope: { project: '/private/repo' }, scopeKey: SCOPE_KEY,
  });
  assert.equal(calls.length, 1);
  assert.equal(result.status, 'complete');
  const observed = result.models.find((model) => model.identity.modelId === 'gpt-5.6-terra');
  assert.equal(observed.observations, 2);
  for (const field of ['observed', 'entitled', 'policyAllowed', 'routable']) {
    assert.equal(observed.dimensions[field].value, true, field);
    assert.equal(observed.evidence.find(({ id }) => observed.dimensions[field].evidenceRefs.includes(id)).field,
      `dimensions.${field}`);
  }
  assert.doesNotThrow(() => result.models.map(normalizeModelRecord));
  const wire = JSON.stringify(result);
  for (const secret of ['PRIVATE PROMPT', 'PRIVATE', 'secret-id', '/private/repo']) assert.equal(wire.includes(secret), false);
});

test('refresh names contacts, never invokes a model, and preserves per-source failure', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === 'opencode') return { code: 1, stdout: '', stderr: 'catalog unavailable' };
    return { code: 0, stdout: 'NAME ID SIZE MODIFIED\nqwen:latest abcdef 1 GB now\n', stderr: '' };
  };
  const result = await refreshModelDiscovery({
    owners: ['opencode', 'ollama'], online: true, runner, scopeKey: SCOPE_KEY,
    inputs: { ollama: { fetchFn: async (url) => new Response(JSON.stringify(
      new URL(url).pathname === '/api/tags' ? { models: [] } : { models: [] },
    )) } },
  });
  assert.deepEqual(result.contacts, ['OpenCode and Models.dev catalogues', 'local Ollama daemon']);
  assert.equal(result.results.opencode.status, 'unavailable');
  assert.equal(result.results.ollama.status, 'complete');
  assert.deepEqual(
    [result.results.opencode.source.owner, result.results.opencode.source.mode,
      result.results.opencode.source.transport],
    ['opencode', 'online', 'command'],
  );
  assert.equal(calls.some(([, args]) => args.some((arg) => /prompt|chat|run|generate/.test(arg))), false);
});

test('combined collection keeps discovery, configured, and observed evidence separate', async () => {
  const result = await collectModelInventory({
    config: { routing: { routes: { testing: { host: 'codex', model: 'gpt-x', provenance: 'user' } } } },
    discoveryOptions: { owners: [], online: false }, scopeKey: SCOPE_KEY,
    readIndexFn: async () => ({ generatedAt: '2026-08-25T13:00:00.000Z', sessions: [] }),
  });
  assert.equal(result.bindings.bindings[0].evidenceClass, 'configured');
  assert.deepEqual(result.discovery.results, {});
  assert.deepEqual(result.observed.models, []);
});

test('snapshot composition emits a normalized same-scope stable baseline', async () => {
  const collection = await collectModelInventory({
    config: { routing: { routes: { testing: { host: 'codex', model: 'gpt-x' } } } },
    discoveryOptions: {
      owners: ['codex'], scopeKey: SCOPE_KEY,
      inputs: { codex: { cacheRaw: JSON.stringify({ models: [{ slug: 'gpt-x', visibility: 'list' }] }), configRaw: '' } },
    },
    readIndexFn: async () => ({ generatedAt: '2026-08-25T13:00:00.000Z', sessions: [] }),
    scopeKey: SCOPE_KEY,
  });
  const snapshot = composeModelSnapshot(collection, {
    scopeKey: SCOPE_KEY, capturedAt: '2026-08-25T13:00:00.000Z', scope: { project: '/private/repo' },
  });
  assert.equal(isCompleteStableSnapshot(snapshot), true);
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.bindings.length, 1);
  assert.equal(snapshot.models[0].dimensions.configured.value, true);
  assert.equal(snapshot.models[0].dimensions.effective.value, true);
  assert.equal(snapshot.models[0].dimensions.configured.evidenceRefs.length > 0, true);
  assert.equal(JSON.stringify(snapshot).includes('/private/repo'), false);
  assert.equal(snapshot.sources.every((source) => source.scopeFingerprint === snapshot.scope.fingerprint), true);
});

test('Codex cache facts join an independently observed OpenAI path without duplicate casing rows', async () => {
  const collection = await collectModelInventory({
    discoveryOptions: {
      owners: ['codex'], scopeKey: SCOPE_KEY, capturedAt: '2026-08-25T13:00:00.000Z',
      inputs: { codex: { cacheRaw: JSON.stringify({ models: [{
        slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list',
      }] }), configRaw: '' } },
    },
    readIndexFn: async () => ({
      generatedAt: '2026-08-25T13:00:00.000Z',
      sessions: [{ host: 'codex', provider: 'openai', models: ['gpt-5.6-terra'] }],
    }),
    scopeKey: SCOPE_KEY,
  });
  const snapshot = composeModelSnapshot(collection, {
    scopeKey: SCOPE_KEY, capturedAt: '2026-08-25T13:00:00.000Z',
  });
  const matches = snapshot.models.filter(({ key }) => key.modelId === 'gpt-5.6-terra');
  assert.equal(matches.length, 1);
  assert.deepEqual({
    provider: matches[0].key.provider,
    displayName: matches[0].displayName,
    observed: matches[0].dimensions.observed.value,
    discoverable: matches[0].dimensions.discoverable.value,
  }, {
    provider: 'openai', displayName: 'GPT-5.6-Terra', observed: true, discoverable: true,
  });
  assert.deepEqual(new Set(matches[0].evidence.map(({ source }) => source)),
    new Set(['codex-cache', 'usage-index']));
});

test('provider-neutral Codex catalogue facts do not collapse a custom provider path', async () => {
  const collection = await collectModelInventory({
    discoveryOptions: {
      owners: ['codex'], scopeKey: SCOPE_KEY, capturedAt: '2026-08-25T13:00:00.000Z',
      inputs: { codex: { cacheRaw: JSON.stringify({ models: [{
        slug: 'gpt-custom', display_name: 'GPT Custom', visibility: 'list',
      }] }), configRaw: '' } },
    },
    readIndexFn: async () => ({
      generatedAt: '2026-08-25T13:00:00.000Z',
      sessions: [{ host: 'codex', provider: 'custom-gateway', models: ['gpt-custom'] }],
    }),
    scopeKey: SCOPE_KEY,
  });
  const snapshot = composeModelSnapshot(collection, {
    scopeKey: SCOPE_KEY, capturedAt: '2026-08-25T13:00:00.000Z',
  });
  assert.deepEqual(snapshot.models.filter(({ key }) => key.modelId === 'gpt-custom')
    .map(({ key }) => key.provider).sort((a, b) => (a ?? '').localeCompare(b ?? '')),
  [null, 'custom-gateway']);
});

test('Claude descriptor reads managed policy and only whitelisted process model environment', async () => {
  const reads = [];
  const result = await refreshModelDiscovery({
    owners: ['claude'], scopeKey: SCOPE_KEY,
    inputs: { claude: { settingsRaw: JSON.stringify({ model: 'sonnet' }) } },
    processEnvironment: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-managed',
      ANTHROPIC_API_KEY: 'must-not-cross', UNRELATED: 'must-not-cross',
    },
    readFileFn: (file) => {
      reads.push(file);
      if (String(file).includes('managed-settings.json')) return JSON.stringify({ availableModels: ['sonnet'] });
      throw new Error('unexpected read');
    },
  });
  assert.equal(reads.some((file) => String(file).includes('managed-settings.json')), true);
  assert.equal(result.results.claude.models[0].key.modelId, 'claude-sonnet-managed');
  assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
  assert.deepEqual([result.results.claude.source.owner, result.results.claude.source.mode], ['claude', 'local']);
});

test('Claude snapshot merges public facts while preserving field-specific access evidence', async () => {
  const collection = await collectModelInventory({
    discoveryOptions: {
      owners: ['claude'], scopeKey: SCOPE_KEY, capturedAt: '2026-08-25T13:00:00.000Z',
      inputs: { claude: { settingsRaw: JSON.stringify({ model: 'claude-fable-5[1m]' }) } },
    },
    readIndexFn: async () => ({
      generatedAt: '2026-08-25T13:00:00.000Z',
      sessions: [{ host: 'claude', provider: 'anthropic', models: ['claude-fable-5'] }],
    }),
    scopeKey: SCOPE_KEY,
  });
  const snapshot = composeModelSnapshot(collection, {
    scopeKey: SCOPE_KEY, capturedAt: '2026-08-25T13:00:00.000Z',
  });
  assert.equal(snapshot.models.some(({ key }) => key.modelId === 'claude-fable-5[1m]'), false);
  const fable = snapshot.models.find(({ key }) => key.modelId === 'claude-fable-5');
  assert.deepEqual({
    displayName: fable.displayName,
    provider: fable.key.provider,
    configured: fable.dimensions.configured.value,
    observed: fable.dimensions.observed.value,
    discoverable: fable.dimensions.discoverable.value,
    entitled: fable.dimensions.entitled.value,
    routable: fable.dimensions.routable.value,
    lifecycle: fable.lifecycle.state,
  }, {
    displayName: 'Claude Fable 5', provider: 'anthropic', configured: true, observed: true, discoverable: true,
    entitled: true, routable: true, lifecycle: 'active',
  });
  assert.equal(fable.pricing.input, 10);
  assert.equal(fable.pricing.output, 50);
  assert.equal(fable.variant.contextWindow, 1_000_000);
  assert.equal(fable.aliases.some(({ name }) => name === 'claude-fable-5[1m]'), true);
  assert.deepEqual(new Set(fable.evidence.map(({ source }) => source)),
    new Set(['anthropic-docs', 'claude-config', 'usage-index']));
  assert.deepEqual(new Set(snapshot.sources.map(({ id }) => id)),
    new Set(['anthropic-docs', 'claude-config', 'usage-index']));
});

test('Claude public aliases merge into one configured canonical model record', async () => {
  const collection = await collectModelInventory({
    discoveryOptions: {
      owners: ['claude'], scopeKey: SCOPE_KEY, capturedAt: '2026-08-25T13:00:00.000Z',
      inputs: { claude: { settingsRaw: JSON.stringify({ model: 'claude-opus-4-5' }) } },
    },
    readIndexFn: async () => ({ generatedAt: '2026-08-25T13:00:00.000Z', sessions: [] }),
    scopeKey: SCOPE_KEY,
  });
  const snapshot = composeModelSnapshot(collection, {
    scopeKey: SCOPE_KEY, capturedAt: '2026-08-25T13:00:00.000Z',
  });
  assert.equal(snapshot.models.some(({ key }) => key.modelId === 'claude-opus-4-5'), false);
  const opus = snapshot.models.find(({ key }) => key.modelId === 'claude-opus-4-5-20251101');
  assert.equal(opus.dimensions.configured.value, true);
  assert.equal(opus.lifecycle.state, 'active');
  assert.equal(opus.capabilities.contextLimit, 200_000);
  assert.equal(opus.aliases.some(({ name }) => name === 'claude-opus-4-5'), true);
});
