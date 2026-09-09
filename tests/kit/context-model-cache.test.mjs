import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedContextModels, MAX_CONTEXT_MODELS } from '../../src/lib/context-model-cache.mjs';
import { buildContextReport } from '../../src/lib/context-report.mjs';
const at = '2026-09-09T14:00:00Z', now = Date.parse(at);
function snapshot() {
  const models = ['claude', 'codex', 'opencode'].map(host => ({
    key: { host, modelId: `${host}-model`, provider: 'provider', scopeId: 'scope-1' },
    capabilities: { contextLimit: 200000, outputLimit: 32000 },
    variant: { effectiveContextWindow: 999999 },
    evidence: ['contextLimit', 'outputLimit'].map(field => ({ field: `capabilities.${field}`,
      source: host === 'claude' ? 'anthropic-docs' : host === 'codex' ? 'codex-cache' : 'opencode-models',
      class: 'catalog', capturedAt: at, scopeFingerprint: 'scope-1', freshness: 'fresh' })),
    rawConfig: { apiKey: 'DO-NOT-PROJECT' },
  }));
  return { capturedAt: at, scope: { fingerprint: 'scope-1' }, models,
    sources: models.map(model => ({ id: model.evidence[0].source, scopeFingerprint: 'scope-1' })) };
}
test('cached per-host capacity preserves provenance without deriving effective session limits', () => {
  const data = snapshot(), rows = cachedContextModels(data, 'opencode', { now }).models;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { model: 'opencode-model', provider: 'provider', capacityWindow: 200000,
    inputLimit: null, outputLimit: 32000, basis: 'catalog', capturedAt: at,
    scopeId: 'scope-1', freshness: 'fresh', sources: ['opencode-models'] });
  assert.equal(JSON.stringify(rows).includes('DO-NOT-PROJECT'), false);
  assert.equal(Object.hasOwn(rows[0], 'effectiveWindow'), false);
});
test('missing or cross-scope field evidence cannot become a model capacity', () => {
  const data = snapshot();
  data.models[0].evidence = [];
  assert.deepEqual(cachedContextModels(data, 'claude', { now }).models, []);
  data.models[1].key.scopeId = 'scope-other';
  assert.deepEqual(cachedContextModels(data, 'codex', { now }).models, []);
});
test('stale observations retain their age instead of becoming fresh on dashboard inspection', () => {
  const data = snapshot();
  const result = cachedContextModels(data, 'claude', { now: now + 8 * 86400000 });
  assert.equal(result.models[0].freshness, 'stale');
  assert.equal(result.models[0].capturedAt, at);
});
test('model rows are bounded and unsafe identifiers are not forwarded', () => {
  const data = snapshot(), template = data.models[0];
  data.models = Array.from({ length: MAX_CONTEXT_MODELS + 3 }, (_, index) => ({ ...template, key: { ...template.key, modelId: `model-${index}` } }));
  data.models.push({ ...template, key: { ...template.key, modelId: '<script>secret</script>' } });
  const result = cachedContextModels(data, 'claude', { now });
  assert.equal(result.models.length, MAX_CONTEXT_MODELS);
  assert.equal(result.omitted, 3);
});
test('host reports use cached catalogs even without live or managed context inspection', () => {
  const report = buildContextReport({ integrations: { hosts: { claude: true, codex: true, opencode: true } } },
    { available: false, reason: 'unverified native client' }, { now, modelSnapshot: snapshot() });
  assert.deepEqual(report.hosts.map(host => [host.host, host.models[0].basis, host.usage]),
    [['claude', 'catalog', null], ['codex', 'catalog', null], ['opencode', 'catalog', null]]);
  assert.ok(report.hosts.every(host => host.inventoryScopeId === 'scope-1'));
});
