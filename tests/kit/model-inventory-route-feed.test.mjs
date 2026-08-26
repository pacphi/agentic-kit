import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planModelChange, routeIntelligenceFeed } from '../../src/lib/model-inventory/impact.mjs';
import { collectObservedModels } from '../../src/lib/model-inventory/observed.mjs';

const AT = '2026-08-25T12:00:00.000Z';

function model(host, provider, modelId, lifecycle = { state: 'active' }) {
  const evidence = ['discoverable', 'entitled', 'policyAllowed', 'routable'].map((field) => ({
    id: `${modelId}-${field}`, field: `dimensions.${field}`, source: 'catalog', class: 'catalog',
    capturedAt: AT, freshness: 'fresh', completeness: 'complete', scopeFingerprint: 'scope-a',
  }));
  return {
    key: { host, provider, modelId, scopeId: 'scope-a' },
    dimensions: Object.fromEntries(['discoverable', 'entitled', 'policyAllowed', 'routable']
      .map((field) => [field, { value: true, evidenceRefs: [`${modelId}-${field}`] }])),
    lifecycle: { ...lifecycle, evidenceRefs: [] }, capabilities: {}, evidence,
  };
}

function snapshot() {
  return {
    schemaVersion: 1, snapshotId: 'snapshot-a', capturedAt: AT,
    scope: { fingerprint: 'scope-a', hosts: ['codex', 'opencode'] },
    sources: [{ id: 'catalog', status: 'complete', capturedAt: AT, scopeFingerprint: 'scope-a' }],
    models: [
      model('codex', 'openai', 'gpt-old', { state: 'retiring', replacement: 'gpt-new' }),
      model('opencode', 'openrouter', 'vendor/gpt-new'),
    ],
    bindings: [{
      id: 'route-implementation', consumer: 'route:implementation', activity: 'implementation',
      host: 'codex', provider: 'openai', configured: 'gpt-old', effective: 'gpt-old',
      provenance: 'configured', consumerState: 'configured', evidenceRefs: [],
    }],
  };
}

test('OpenCode plans preserve provider-qualified model refs in the canonical command', () => {
  const result = planModelChange(snapshot(), {
    activity: 'implementation', to: 'opencode:openrouter/vendor/gpt-new',
  });
  assert.equal(result.plannable, true);
  assert.match(result.action.command, /implementation:opencode:openrouter\/vendor\/gpt-new/);
  assert.equal(result.edges[0].kind, 'mechanically-compatible');
});

test('a real observed success permits planning when only catalog discovery remains unknown', async () => {
  const observed = await collectObservedModels({
    scopeKey: '0123456789abcdef0123456789abcdef',
    readIndexFn: async () => ({
      generatedAt: AT, sourceHealth: { codex: { status: 'ok' } },
      sessions: [{ host: 'codex', provider: 'openai', models: ['gpt-observed'] }],
    }),
  });
  const value = {
    schemaVersion: 1, snapshotId: 'observed-snapshot', capturedAt: AT,
    scope: { fingerprint: observed.source.scopeFingerprint, hosts: ['codex'] },
    sources: [observed.source], models: observed.models, bindings: [],
  };
  const result = planModelChange(value, { activity: 'testing', to: 'codex:gpt-observed' });
  assert.equal(result.plannable, true);
  assert.equal(result.compatibility.blockers.includes('discoverable is unknown'), false);
  assert.match(result.compatibility.warnings.join(' '), /observed path succeeded/);
});

test('Route Intelligence feed exports evidence and invalidations without quality claims', () => {
  const feed = routeIntelligenceFeed(snapshot(), {
    changes: [{ kind: 'context-changed', subject: 'gpt-new', evidenceRefs: ['gpt-new-routable'] }],
  });
  assert.equal(feed.candidates.length, 2);
  assert.equal(feed.candidates.every(({ quality }) => quality === 'unknown'), true);
  assert.equal(feed.claims.quality, false);
  assert.equal(feed.invalidations.some(({ reason, retainHistory }) =>
    reason === 'first-party-migration' && retainHistory), true);
  assert.equal(feed.invalidations.some(({ reason }) => reason === 'context-changed'), true);
});
