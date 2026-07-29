import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLifecycle } from '../../src/lib/adapters/lifecycle.mjs';
import { undoOwnedValues } from '../../src/lib/adapters/ownership.mjs';
import {
  assertNoWrites, fakeLifecycleAdapter, fakeSurface,
} from './helpers/lifecycle-harness.mjs';

test('detect is read-only and returns observed facts', async () => {
  const surface = fakeSurface({ enabled: false, user: 'keep' });
  const before = surface.snapshot();
  const result = await runLifecycle({
    adapter: fakeLifecycleAdapter(surface),
    action: 'detect',
  });
  assert.deepEqual(result, { observed: { enabled: false, user: 'keep' } });
  assertNoWrites(surface, before, 'detect must not write');
});

test('planning is deterministic, read-only, and does not mutate detected facts', async () => {
  const surface = fakeSurface({ enabled: false });
  const adapter = fakeLifecycleAdapter(surface);
  const facts = { observed: { enabled: false } };
  const original = structuredClone(facts);
  const first = await runLifecycle({ adapter, action: 'plan', facts });
  const second = await runLifecycle({ adapter, action: 'plan', facts });
  assert.deepEqual(second, first);
  assert.deepEqual(facts, original);
  assert.deepEqual(first.operations, [{ path: 'enabled', prior: false, written: true }]);
  assertNoWrites(surface, { enabled: false }, 'plan must not write');
});

test('dry-run detects and plans but never calls apply', async () => {
  const surface = fakeSurface({ enabled: false });
  const adapter = fakeLifecycleAdapter(surface);
  let applyCalls = 0;
  const realApply = adapter.apply;
  adapter.apply = (context) => {
    applyCalls++;
    return realApply(context);
  };
  const result = await runLifecycle({ adapter, action: 'apply', dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.changed, true);
  assert.equal(applyCalls, 0);
  assertNoWrites(surface, { enabled: false }, 'dry-run must not write');
});

test('apply is idempotent after the desired state is reached', async () => {
  const surface = fakeSurface({ enabled: false, user: 'keep' });
  const adapter = fakeLifecycleAdapter(surface);
  const first = await runLifecycle({ adapter, action: 'apply' });
  const second = await runLifecycle({ adapter, action: 'apply' });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(surface.snapshot(), { enabled: true, user: 'keep' });
});

test('verify reports observed truth rather than the planned value', async () => {
  const surface = fakeSurface({ enabled: false });
  const adapter = fakeLifecycleAdapter(surface);
  const plan = await runLifecycle({ adapter, action: 'plan' });
  surface.replace({ enabled: 'externally-changed' });
  const verified = await runLifecycle({ adapter, action: 'verify', plan });
  assert.deepEqual(verified, { observed: { enabled: 'externally-changed' } });
});

test('undo restores only a value still equal to the value ak wrote', () => {
  assert.deepEqual(undoOwnedValues(
    { enabled: true, user: 'keep' },
    [{ path: 'enabled', prior: false, written: true }],
  ), {
    value: { enabled: false, user: 'keep' },
    changed: true,
    preserved: [],
  });
});

test('undo preserves a user value changed after apply', () => {
  assert.deepEqual(undoOwnedValues(
    { enabled: 'user-choice', user: 'keep' },
    [{ path: 'enabled', prior: false, written: true }],
  ), {
    value: { enabled: 'user-choice', user: 'keep' },
    changed: false,
    preserved: ['enabled'],
  });
});

test('undo removes an ak-created value while preserving sibling configuration', () => {
  assert.deepEqual(undoOwnedValues(
    { env: { AK_MANAGED: 'yes', USER_KEY: 'keep' } },
    [{ path: 'env.AK_MANAGED', prior: undefined, written: 'yes' }],
  ), {
    value: { env: { USER_KEY: 'keep' } },
    changed: true,
    preserved: [],
  });
});
