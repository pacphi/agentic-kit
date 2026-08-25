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
  assert.equal(result.models.find((model) => model.identity.modelId === 'gpt-5.6-terra').observations, 2);
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
  const result = await refreshModelDiscovery({ owners: ['opencode', 'ollama'], online: true, runner, scopeKey: SCOPE_KEY });
  assert.deepEqual(result.contacts, ['opencode catalog', 'local Ollama daemon']);
  assert.equal(result.results.opencode.status, 'unavailable');
  assert.equal(result.results.ollama.status, 'complete');
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
  assert.equal(JSON.stringify(snapshot).includes('/private/repo'), false);
  assert.equal(snapshot.sources.every((source) => source.scopeFingerprint === snapshot.scope.fingerprint), true);
});
