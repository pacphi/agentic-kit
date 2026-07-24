// #45 defect 2 pre-flight: ak dual run must refuse BEFORE spawning a worker when
// the ruflo memory runtime is WASM-only AND the target DB has an active native WAL
// (`-wal`/`-shm` sidecars). Unit-tests the pure predicate with an injected
// existsSync + a supplied runtime probe — no spawn, no global tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeWalConflict } from '../../src/commands/dual.mjs';

const WASM_ONLY = { installed: true, contexts: [{ context: 'cli', ok: false }, { context: 'memory', ok: true }] };
const ALL_NATIVE = { installed: true, contexts: [{ context: 'cli', ok: true }, { context: 'memory', ok: true }] };
const NOT_INSTALLED = { installed: false, contexts: [] };

const sidecarPresent = (f) => f.endsWith('-wal') || f.endsWith('-shm');
const noSidecar = () => false;

test('refuses when the runtime is WASM-only AND a WAL sidecar is present', () => {
  const c = nativeWalConflict('/proj/.swarm/memory.db', { runtime: WASM_ONLY, existsSync: sidecarPresent });
  assert.equal(c.refuse, true);
  assert.equal(c.wasmOnly, true);
  assert.equal(c.sidecar, true);
});

test('proceeds when the runtime is native even with a live WAL', () => {
  const c = nativeWalConflict('/proj/.swarm/memory.db', { runtime: ALL_NATIVE, existsSync: sidecarPresent });
  assert.equal(c.refuse, false, 'native writer + native store is safe');
});

test('proceeds when there are no sidecars even on a WASM-only runtime', () => {
  const c = nativeWalConflict('/proj/.swarm/memory.db', { runtime: WASM_ONLY, existsSync: noSidecar });
  assert.equal(c.refuse, false, 'no active WAL → nothing to conflict with');
});

test('proceeds when ruflo is not installed at all', () => {
  const c = nativeWalConflict('/proj/.swarm/memory.db', { runtime: NOT_INSTALLED, existsSync: sidecarPresent });
  assert.equal(c.refuse, false);
});

test('a stale zero-length sidecar still counts as active (EC-6, presence not size)', () => {
  // existsSync-based on purpose: false-refusal costs one `ak sync`, false-pass
  // corrupts the DB. A -shm alone is enough.
  const onlyShm = (f) => f.endsWith('-shm');
  const c = nativeWalConflict('/proj/.swarm/memory.db', { runtime: WASM_ONLY, existsSync: onlyShm });
  assert.equal(c.refuse, true);
});
