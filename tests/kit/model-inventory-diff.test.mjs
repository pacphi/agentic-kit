import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshotHistory, diffSnapshots } from '../../src/lib/model-inventory/diff.mjs';
import { modelIdentityKey } from '../../src/lib/model-inventory/contracts.mjs';

const AT = '2026-08-25T12:00:00.000Z';

function model(id, overrides = {}) {
  return {
    key: { host: 'codex', provider: 'openai', modelId: id, scopeId: 'scope-a' },
    aliases: [], lifecycle: { state: 'active' }, capabilities: { tools: true },
    dimensions: {}, evidence: [], ...overrides,
  };
}

function snapshot(id, models, { scope = 'scope-a', status = 'complete' } = {}) {
  return {
    schemaVersion: 1, snapshotId: id, capturedAt: AT,
    scope: { fingerprint: scope, hosts: ['codex'] },
    sources: [{ id: 'catalog', status, capturedAt: AT, scopeFingerprint: scope }],
    models, bindings: [], changes: [], opportunities: [], diagnostics: [],
  };
}

function at(value, capturedAt) { return { ...value, capturedAt, sources: value.sources.map((source) => ({ ...source, capturedAt })) }; }

test('identical same-scope snapshots produce no lifecycle changes', () => {
  const before = snapshot('before', [model('gpt-a')]);
  const after = snapshot('after', [model('gpt-a')]);
  assert.deepEqual(diffSnapshots(before, after).changes, []);
});

test('complete same-scope snapshots require repeated absence before removal', () => {
  const before = snapshot('before', [model('gpt-a')]);
  const after = snapshot('after', [model('gpt-b')]);
  const first = diffSnapshots(before, after);
  assert.deepEqual(first.changes.map(({ kind }) => kind).sort(), ['model-added', 'model-missing']);
  assert.equal(first.changes.find(({ kind }) => kind === 'model-missing').provisional, true);

  const identity = modelIdentityKey(before.models[0].key);
  const result = diffSnapshots(
    before,
    after,
    { absenceCounts: { [identity]: 2 } },
  );
  assert.deepEqual(result.changes.map(({ kind }) => kind).sort(), ['model-added', 'model-removed']);
  assert.equal(result.changes.every(({ provisional }) => provisional === false), true);
});

test('retained history confirms removal after two complete consecutive absences', () => {
  const present = at(snapshot('present', [model('gpt-a')]), '2026-08-23T12:00:00.000Z');
  const firstMissing = at(snapshot('missing-1', []), '2026-08-24T12:00:00.000Z');
  const secondMissing = at(snapshot('missing-2', []), '2026-08-25T12:00:00.000Z');
  const result = diffSnapshotHistory(firstMissing, secondMissing, [present, firstMissing, secondMissing]);
  assert.deepEqual(result.changes.map(({ kind }) => kind), ['model-removed']);
  assert.equal(result.changes[0].subject, modelIdentityKey(present.models[0].key));
  assert.equal(result.changes[0].provisional, false);
});

test('partial or stale evidence suppresses removals', () => {
  for (const status of ['partial', 'stale']) {
    const result = diffSnapshots(
      snapshot('before', [model('gpt-a')]),
      snapshot(`after-${status}`, [], { status }),
    );
    assert.equal(result.changes.some(({ kind }) => kind === 'model-removed'), false);
    assert.match(result.diagnostics.join(' '), /suppressed model removals/);
  }
});

test('alias targets, lifecycle, visibility, and capabilities diff independently', () => {
  const before = model('gpt-a', {
    aliases: [{ name: 'default', resolvesTo: 'gpt-a' }],
    visibility: 'list', lifecycle: { state: 'active' }, capabilities: { tools: true, vision: false },
  });
  const after = model('gpt-a', {
    aliases: [{ name: 'default', resolvesTo: 'gpt-b' }],
    visibility: 'hidden', lifecycle: { state: 'retiring', replacement: 'gpt-b' },
    capabilities: { tools: true, vision: true },
  });
  const kinds = diffSnapshots(snapshot('before', [before]), snapshot('after', [after]))
    .changes.map(({ kind }) => kind);
  assert.deepEqual(kinds.sort(), [
    'alias-target-changed', 'capability-changed', 'lifecycle-changed', 'visibility-changed',
  ]);
});

test('cross-scope comparison is refused rather than reported as mass churn', () => {
  const result = diffSnapshots(
    snapshot('before', [model('gpt-a')]),
    snapshot('after', [model('gpt-b')], { scope: 'scope-b' }),
  );
  assert.equal(result.comparable, false);
  assert.equal(result.reason, 'scope-changed');
  assert.deepEqual(result.changes, []);
});
