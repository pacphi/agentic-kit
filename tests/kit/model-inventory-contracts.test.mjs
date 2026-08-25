import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_INVENTORY_SCHEMA_VERSION, modelIdentityKey, normalizeModelRecord,
  normalizeSnapshot, normalizeSourceResult,
} from '../../src/lib/model-inventory/contracts.mjs';

const AT = '2026-08-25T12:00:00.000Z';

function evidence(id, field, klass) {
  return {
    id, field, source: `fixture:${field}`, class: klass, capturedAt: AT,
    freshness: 'fresh', completeness: 'complete', scopeFingerprint: 'scope-a',
  };
}

function model(overrides = {}) {
  return {
    key: { host: 'codex', provider: 'openai', modelId: 'gpt-x', scopeId: 'scope-a' },
    dimensions: {
      configured: { value: true, evidenceRefs: ['configured'] },
      observed: { value: false, evidenceRefs: ['observed'] },
      entitled: { value: null, evidenceRefs: [] },
    },
    evidence: [
      evidence('configured', 'dimensions.configured', 'configured'),
      evidence('observed', 'dimensions.observed', 'observed'),
    ],
    ...overrides,
  };
}

test('model contract preserves independent dimensions and per-field evidence', () => {
  const value = normalizeModelRecord(model());
  assert.equal(value.dimensions.configured.value, true);
  assert.equal(value.dimensions.observed.value, false);
  assert.equal(value.dimensions.entitled.value, null);
  assert.equal(value.dimensions.routable.value, null);
  assert.deepEqual(value.dimensions.configured.evidenceRefs, ['configured']);
  assert.equal(value.evidence[0].field, 'dimensions.configured');
  assert.equal(value.evidence[0].class, 'configured');
  assert.equal(Object.isFrozen(value), true);
});

test('host, provider, concrete model, and scope are all part of identity', () => {
  const base = { host: 'opencode', provider: 'openrouter', modelId: 'vendor/model', scopeId: 'project-a' };
  assert.notEqual(modelIdentityKey(base), modelIdentityKey({ ...base, provider: 'gateway' }));
  assert.notEqual(modelIdentityKey(base), modelIdentityKey({ ...base, scopeId: 'project-b' }));
  assert.notEqual(modelIdentityKey(base), modelIdentityKey({ ...base, host: 'codex' }));
});

test('dimension evidence references must resolve within the model record', () => {
  assert.throws(() => normalizeModelRecord(model({
    dimensions: { configured: { value: true, evidenceRefs: ['missing'] } },
  })), /unknown evidence missing/);
});

test('source completeness cannot be asserted by a partial or stale result', () => {
  const partial = normalizeSourceResult({
    id: 'codex-cache', status: 'partial', complete: true, capturedAt: AT,
    scopeFingerprint: 'scope-a',
  });
  assert.equal(partial.complete, false);
  const complete = normalizeSourceResult({
    id: 'codex-cache', status: 'complete', capturedAt: AT, scopeFingerprint: 'scope-a',
  });
  assert.equal(complete.complete, true);
});

test('snapshot rejects duplicate model identities without collapsing records', () => {
  const raw = {
    schemaVersion: MODEL_INVENTORY_SCHEMA_VERSION,
    snapshotId: 'snapshot-a', capturedAt: AT,
    scope: { fingerprint: 'scope-a', hosts: ['codex'] },
    sources: [{ id: 'codex-cache', status: 'complete', capturedAt: AT, scopeFingerprint: 'scope-a' }],
    models: [model(), model()], bindings: [],
  };
  assert.throws(() => normalizeSnapshot(raw), /duplicate identities/);
});
