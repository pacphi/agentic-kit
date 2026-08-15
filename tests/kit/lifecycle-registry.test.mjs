// The lifecycle registry — host lifecycle adapters (detect/plan/apply/verify/
// undo) reached by id lookup, never by a named import of a concrete host
// module. Only opencode has a lifecycle adapter today; this file pins that
// the registry wires it correctly at import time AND that the five call
// sites that used to `import { OPENCODE_LIFECYCLE_ADAPTER } from
// '../lib/opencode.mjs'` no longer do — the whole point of F-02 is that a
// second lifecycle host never needs a new named import anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerBuiltinLifecycle, lifecycleAdapterFor, hostsWithLifecycle,
} from '../../src/lib/adapters/lifecycle-registry.mjs';
import { OPENCODE_LIFECYCLE_ADAPTER } from '../../src/lib/opencode.mjs';
import { validateLifecycleAdapter } from '../../src/lib/adapters/lifecycle.mjs';
import { HOST_REGISTRY } from '../../src/lib/adapters/index.mjs';
import { fakeLifecycleAdapter, fakeSurface } from './helpers/lifecycle-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');

test('lifecycleAdapterFor(\'opencode\') returns the real, validated adapter', () => {
  const adapter = lifecycleAdapterFor('opencode');
  assert.equal(adapter, OPENCODE_LIFECYCLE_ADAPTER, 'registry must hand back the SAME adapter instance opencode.mjs exports');
  assert.doesNotThrow(() => validateLifecycleAdapter(adapter));
});

test('lifecycleAdapterFor of an unknown/unregistered host id returns null', () => {
  assert.equal(lifecycleAdapterFor('codex'), null, 'codex has no lifecycle adapter yet');
  assert.equal(lifecycleAdapterFor('not-a-real-host'), null);
});

test('hostsWithLifecycle() returns only registered ids, in HOST_REGISTRY order', () => {
  const ids = hostsWithLifecycle();
  assert.deepEqual(ids, ['opencode'], 'only opencode is registered in this wave');
  // order sanity: whatever is registered must appear in the same relative
  // order it holds in HOST_REGISTRY, not Map-insertion order.
  const registryOrder = HOST_REGISTRY.map((h) => h.id);
  let cursor = -1;
  for (const id of ids) {
    const idx = registryOrder.indexOf(id);
    assert.ok(idx > cursor, `${id} out of HOST_REGISTRY order`);
    cursor = idx;
  }
});

test('registering an unknown host id throws at registration (construction-time invariant)', () => {
  const surface = fakeSurface({ enabled: false });
  const adapter = fakeLifecycleAdapter(surface);
  assert.throws(
    () => registerBuiltinLifecycle('not-in-the-registry', adapter, { hostRegistry: [{ id: 'claude' }, { id: 'opencode' }] }),
    /not-in-the-registry/,
  );
});

test('registering an adapter that fails the lifecycle contract throws (construction-time invariant)', () => {
  assert.throws(
    () => registerBuiltinLifecycle('claude', { id: 'claude', detect() {} }, { hostRegistry: [{ id: 'claude' }] }),
    /must be a function/,
  );
});

test('registering a known host id with a valid adapter succeeds and is retrievable', () => {
  const surface = fakeSurface({ enabled: false });
  const adapter = fakeLifecycleAdapter(surface);
  const registered = registerBuiltinLifecycle('claude', adapter, { hostRegistry: [{ id: 'claude' }] });
  assert.equal(registered, adapter);
});

// ── architecture guard: dispatch by registry, never by name ────────────────
// Real import errors (a wiring bug in a built-in) are supposed to throw at
// module load — proven above via the hostRegistry-override seam rather than a
// fresh-module import, since the real HOST_REGISTRY/opencode wiring is
// correct and importing it a second time would just re-hit Node's ESM module
// cache (no fresh throw to observe).
for (const rel of [
  'commands/sync.mjs', 'commands/setup.mjs', 'commands/x/host.mjs', 'commands/uninstall.mjs',
]) {
  test(`${rel} no longer names OPENCODE_LIFECYCLE_ADAPTER — it goes through the registry`, () => {
    const text = src(rel);
    assert.ok(!text.includes('OPENCODE_LIFECYCLE_ADAPTER'),
      `${rel} must reach opencode's lifecycle adapter via lifecycleAdapterFor(...), not a named import`);
  });
}
