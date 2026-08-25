import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consumerDiagnostics, explainModel, impactGraph, planModelChange,
} from '../../src/lib/model-inventory/impact.mjs';
import {
  createDashboardModelPayload, createModelReadModel, summarizeModelHealth,
} from '../../src/lib/model-inventory/read-model.mjs';

const AT = '2026-08-25T12:00:00.000Z';

function evidence(id, field) {
  return {
    id, field, source: 'codex-cache', class: 'catalog', capturedAt: AT,
    freshness: 'fresh', completeness: 'complete', scopeFingerprint: 'scope-a',
  };
}

function model(id, { dimensions = {}, capabilities = {}, lifecycle = { state: 'active' } } = {}) {
  const evidenceRows = [
    evidence(`${id}-routable`, 'dimensions.routable'),
    evidence(`${id}-lifecycle`, 'lifecycle'),
  ];
  return {
    key: { host: 'codex', provider: 'openai', modelId: id, scopeId: 'scope-a', digest: `digest-${id}` },
    dimensions: {
      routable: { value: true, evidenceRefs: [`${id}-routable`] },
      discoverable: { value: true }, entitled: { value: true }, policyAllowed: { value: true },
      ...dimensions,
    },
    capabilities, lifecycle: { ...lifecycle, evidenceRefs: [`${id}-lifecycle`] },
    pricing: { basis: 'per-million-tokens', input: 1, output: 2, currency: 'USD',
      evidenceRefs: [`${id}-lifecycle`] },
    edges: [{ kind: 'same-family-newer', from: id, to: `${id}-next`, provenance: 'first-party',
      scopeFingerprint: 'scope-a', evidenceRefs: [`${id}-lifecycle`] }],
    evidence: evidenceRows,
  };
}

function fixture({ targetDimensions = {} } = {}) {
  const oldModel = model('gpt-old', { capabilities: { tools: true } });
  const newModel = model('gpt-new', {
    dimensions: targetDimensions, capabilities: { tools: true },
    lifecycle: { state: 'active' },
  });
  return {
    schemaVersion: 1, snapshotId: 'snapshot-a', capturedAt: AT,
    scope: { fingerprint: 'scope-a', hosts: ['codex'] },
    sources: [{ id: 'codex-cache', owner: 'codex', ownerType: 'host', transport: 'file', network: 'never',
      mode: 'local', schema: 'codex-model-cache-v1', status: 'complete', capturedAt: AT,
      scopeFingerprint: 'scope-a' }],
    models: [oldModel, newModel],
    bindings: [
      {
        id: 'route-implementation', consumer: 'route:implementation', activity: 'implementation',
        host: 'codex', provider: 'openai', configured: 'gpt-old', effective: 'gpt-old',
        provenance: 'configured', consumerState: 'configured', evidenceRefs: ['route-config'],
      },
      {
        id: 'aqe-coder', consumer: 'aqe:agent:coder', activity: 'implementation',
        host: 'codex', provider: 'openai', configured: 'gpt-old', effective: 'gpt-old',
        provenance: 'configured', consumerState: 'reported', drift: true, evidenceRefs: ['aqe-config'],
      },
      {
        id: 'ruflo-openai', consumer: 'ruflo:provider:openai', activity: 'implementation',
        host: 'codex', provider: 'openai', configured: 'gpt-old', effective: 'gpt-old',
        provenance: 'observed', consumerState: 'runtime-proven', evidenceRefs: ['ruflo-runtime'],
      },
    ],
    changes: [], opportunities: [], diagnostics: [],
  };
}

test('explain returns field evidence and every bound consumer without upgrading provenance', () => {
  const result = explainModel(fixture(), 'codex:gpt-old');
  assert.equal(result.found, true);
  assert.equal(result.matches[0].dimensions.routable.evidenceRefs[0], 'gpt-old-routable');
  assert.deepEqual(result.matches[0].bindings.map(({ id }) => id), [
    'route-implementation', 'aqe-coder', 'ruflo-openai',
  ]);
  assert.deepEqual(result.consumers.map(({ state }) => state), ['reported', 'runtime-proven']);
});

test('plan is read-only, emits the canonical action, and keeps quality unknown', () => {
  const result = planModelChange(fixture(), {
    activity: 'implementation', from: 'codex:gpt-old', to: 'codex:gpt-new',
  });
  assert.equal(result.plannable, true);
  assert.equal(result.readOnly, true);
  assert.match(result.action.command, /^ak host pick --route /);
  assert.match(result.action.command, /implementation:codex:gpt-new/);
  assert.equal(result.action.executed, false);
  assert.equal(result.action.commandMutates, true);
  assert.equal(result.action.requiresExplicitUserAction, true);
  assert.equal(result.compatibility.quality.state, 'unknown');
  assert.equal(result.compatibility.quality.claim, null);
  assert.equal(result.invalidationMarkers.length, 3);
  assert.equal(result.invalidationMarkers.every((marker) =>
    marker.consumer === '#109' && marker.retainHistory), true);
});

test('known entitlement, policy, or routability failure blocks a mechanical plan', () => {
  for (const dimension of ['entitled', 'policyAllowed', 'routable']) {
    const result = planModelChange(fixture({ targetDimensions: { [dimension]: { value: false } } }), {
      activity: 'implementation', from: 'codex:gpt-old', to: 'codex:gpt-new',
    });
    assert.equal(result.plannable, false, dimension);
    assert.equal(result.action, null, dimension);
    assert.match(result.compatibility.blockers.join(' '), new RegExp(dimension));
  }
});

test('unknown required availability evidence blocks a mechanical compatibility claim', () => {
  for (const dimension of ['discoverable', 'entitled', 'policyAllowed', 'routable']) {
    const result = planModelChange(fixture({ targetDimensions: { [dimension]: { value: null } } }), {
      activity: 'implementation', from: 'codex:gpt-old', to: 'codex:gpt-new',
    });
    assert.equal(result.plannable, false, dimension);
    assert.match(result.compatibility.blockers.join(' '), new RegExp(`${dimension} is unknown`));
  }
});

test('AQE and Ruflo diagnostics distinguish configured/reported/runtime-proven state', () => {
  const diagnostics = consumerDiagnostics(fixture());
  assert.deepEqual(diagnostics.map(({ consumer, state, drift }) => [consumer, state, drift]), [
    ['aqe:agent:coder', 'reported', true],
    ['ruflo:provider:openai', 'runtime-proven', false],
  ]);
});

test('impact graph and read model expose consumers and attention without mutation claims', () => {
  const snapshot = fixture();
  const graph = impactGraph(snapshot);
  assert.equal(graph.edges.length, 3);
  const readModel = createModelReadModel(snapshot, {
    changes: [{ kind: 'alias-target-changed', severity: 'warn', subject: 'alias' }],
  });
  assert.equal(readModel.counts.aliasChanges, 1);
  assert.equal(readModel.counts.driftedConsumers, 1);
  assert.equal(summarizeModelHealth(snapshot).level, 'warn');
});

test('Dashboard projection pseudonymizes identifiers while exact CLI evidence remains unchanged', () => {
  const snapshot = fixture();
  const exact = createModelReadModel(snapshot);
  const payload = createDashboardModelPayload({
    status: 'cached', snapshot: exact,
    history: [{ snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt }],
    comparison: { baseline: snapshot.snapshotId, latest: snapshot.snapshotId,
      diagnostics: ['codex-cache: stale'] },
  }, { key: 'ef'.repeat(32) });
  const wire = JSON.stringify(payload);
  for (const raw of ['gpt-old', 'gpt-new', 'digest-gpt', 'openai', 'route-implementation',
    'aqe-coder', 'ruflo-openai']) assert.equal(wire.includes(raw), false, raw);
  assert.match(payload.snapshot.models[0].key.modelId, /^model-[a-f0-9]{12}$/);
  assert.equal(payload.snapshot.models[0].evidence[0].source, 'codex-cache');
  assert.equal(payload.snapshot.sources[0].id, 'codex-cache');
  assert.deepEqual({ owner: payload.snapshot.sources[0].owner, mode: payload.snapshot.sources[0].mode,
    schema: payload.snapshot.sources[0].schema },
  { owner: 'codex', mode: 'local', schema: 'codex-model-cache-v1' });
  assert.match(payload.snapshot.models[0].key.digest, /^digest-[a-f0-9]{12}$/);
  assert.match(payload.snapshot.models[0].edges[0].from, /^model-[a-f0-9]{12}$/);
  assert.match(payload.snapshot.models[0].edges[0].evidenceRefs[0], /^evidence-[a-f0-9]{12}$/);
  assert.deepEqual({ input: payload.snapshot.models[0].pricing.input,
    output: payload.snapshot.models[0].pricing.output, currency: payload.snapshot.models[0].pricing.currency },
  { input: 1, output: 2, currency: 'USD' });
  assert.notEqual(payload.snapshot.scope.fingerprint, 'scope-a');
  assert.notEqual(payload.snapshot.snapshotId, 'snapshot-a');
  assert.equal(payload.snapshot.privacy.exactIdentifiers, false);
  assert.equal(exact.models[0].key.modelId, 'gpt-old');
  assert.equal(exact.bindings[0].id, 'route-implementation');
});

test('Dashboard projection fails closed without a valid existing key', () => {
  assert.throws(() => createDashboardModelPayload({
    status: 'cached', snapshot: createModelReadModel(fixture()),
  }), /privacy key unavailable/);
});
