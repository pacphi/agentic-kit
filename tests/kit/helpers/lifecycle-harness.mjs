import assert from 'node:assert/strict';

export function fakeSurface(initial = {}) {
  let state = structuredClone(initial);
  const calls = [];
  return {
    calls,
    read() {
      calls.push(['read']);
      return structuredClone(state);
    },
    write(next) {
      calls.push(['write', structuredClone(next)]);
      state = structuredClone(next);
    },
    snapshot() {
      return structuredClone(state);
    },
    replace(next) {
      state = structuredClone(next);
    },
  };
}

export function fakeLifecycleAdapter(surface, desired = { enabled: true }) {
  return {
    id: 'fake-projection',
    detect() {
      return { observed: surface.read() };
    },
    plan({ facts }) {
      const prior = facts.observed.enabled;
      return {
        changed: prior !== desired.enabled,
        operations: prior === desired.enabled ? [] : [{
          path: 'enabled', prior, written: desired.enabled,
        }],
      };
    },
    apply({ plan }) {
      if (!plan.changed) return { changed: false };
      const next = surface.read();
      next.enabled = desired.enabled;
      surface.write(next);
      return { changed: true };
    },
    verify() {
      return { observed: surface.read() };
    },
    undo({ ownership }) {
      const next = surface.read();
      const owned = ownership.operations[0];
      if (next.enabled !== owned.written) return { changed: false, preservedUserValue: true };
      if (owned.prior === undefined) delete next.enabled;
      else next.enabled = owned.prior;
      surface.write(next);
      return { changed: true };
    },
  };
}

export function assertNoWrites(surface, before, message) {
  assert.deepEqual(surface.snapshot(), before, message);
  assert.equal(surface.calls.some(([kind]) => kind === 'write'), false, message);
}
