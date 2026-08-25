import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planModelChange, routeIntelligenceFeed } from '../../src/lib/model-inventory/impact.mjs';

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
    activity: 'implementation', to: 'opencode:vendor/gpt-new',
  });
  assert.equal(result.plannable, true);
  assert.match(result.action.command, /implementation:opencode:openrouter\/vendor\/gpt-new/);
  assert.equal(result.edges[0].kind, 'mechanically-compatible');
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
