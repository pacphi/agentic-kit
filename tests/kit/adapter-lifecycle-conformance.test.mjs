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

test('dry-run detects and plans but never calls undo', async () => {
  const surface = fakeSurface({ enabled: true });
  const adapter = fakeLifecycleAdapter(surface);
  let undoCalls = 0;
  const realUndo = adapter.undo;
  adapter.undo = (context) => {
    undoCalls++;
    return realUndo(context);
  };
  const result = await runLifecycle({ adapter, action: 'undo', dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(undoCalls, 0);
  assertNoWrites(surface, { enabled: true }, 'dry-run undo must not write');
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

// ── F8 (security-review follow-up): fail-closed gate on apply ─────────────
// Mirrors the ADMITTED-host hook-failure shapes exactly (lifecycle-registry.mjs's
// hookFailureResult): detect/verify failure -> {observed:null, error}; plan
// failure -> {changed:false, operations:[], error}. opencode's own detect()/
// plan() never emit a `.error` key on any path (see opencode.mjs), so the
// gate below only ever fires for an admitted host's genuine hook failure.

test('apply is aborted when detect returns the admitted-host hook-failure shape ({observed:null, error})', async () => {
  let applyCalls = 0;
  const adapter = {
    id: 'fake-hook-failure',
    detect() { return { observed: null, error: 'detect hook exited 1' }; },
    plan() { throw new Error('plan must never run when detect failed'); },
    apply() { applyCalls++; return { changed: true }; },
    verify() { return { observed: null }; },
    undo() { return { changed: false }; },
  };
  const result = await runLifecycle({ adapter, action: 'apply' });
  assert.equal(applyCalls, 0, 'apply must never run after a detect hook failure');
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.deepEqual(result.errors, ['detect hook exited 1']);
});

test('apply is aborted when plan returns the admitted-host hook-failure shape ({changed:false, operations:[], error})', async () => {
  let applyCalls = 0;
  const adapter = {
    id: 'fake-hook-failure',
    detect() { return { observed: { enabled: false } }; },
    plan() { return { changed: false, operations: [], error: 'plan hook exited 1' }; },
    apply() { applyCalls++; return { changed: true }; },
    verify() { return { observed: { enabled: false } }; },
    undo() { return { changed: false }; },
  };
  const result = await runLifecycle({ adapter, action: 'apply' });
  assert.equal(applyCalls, 0, 'apply must never run after a plan hook failure');
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.deepEqual(result.errors, ['plan hook exited 1']);
});

test('the fail-closed gate does not fire for a normal facts/plan shape carrying no `.error` key (opencode-safety proof)', async () => {
  // fakeLifecycleAdapter's detect/plan return {observed:{...}} / {changed,
  // operations} — exactly the shape opencode's own detect()/plan() return
  // (no `.error` key ever) — so apply must run through untouched.
  const surface = fakeSurface({ enabled: false });
  const adapter = fakeLifecycleAdapter(surface);
  const result = await runLifecycle({ adapter, action: 'apply' });
  assert.equal(result.changed, true, 'apply must still run when neither facts nor plan carry an `.error` key');
  assert.deepEqual(surface.snapshot(), { enabled: true });
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
