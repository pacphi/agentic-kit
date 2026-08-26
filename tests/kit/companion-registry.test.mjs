import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_REGISTRY,
  MANAGED_COMPANION_REGISTRY,
  managedCompanionFor,
  managedCompanionIds,
} from '../../src/lib/adapters/index.mjs';

test('deja-vu is a static managed companion, not a host', () => {
  assert.deepEqual(managedCompanionIds(), ['deja-vu']);
  assert.equal(HOST_REGISTRY.some(({ id }) => id === 'deja-vu'), false);

  const companion = managedCompanionFor('deja-vu');
  assert.equal(companion.configKey, 'dejaVu');
  assert.equal(companion.enabledByDefault, false);
  assert.deepEqual(companion.modes, ['mcp', 'auto']);
  assert.deepEqual(companion.hosts, ['claude', 'codex', 'opencode']);
  assert.deepEqual(companion.install, {
    bin: 'deja',
    npmPackage: '@vshulcz/deja-vu',
    minimumVersion: '0.19.0',
  });
});

test('managed companion registry is immutable and lookup is nullable', () => {
  assert.equal(Object.isFrozen(MANAGED_COMPANION_REGISTRY), true);
  assert.equal(Object.isFrozen(MANAGED_COMPANION_REGISTRY[0]), true);
  assert.equal(managedCompanionFor('unknown'), null);
  assert.throws(() => {
    MANAGED_COMPANION_REGISTRY[0].hosts.push('unknown');
  }, TypeError);
});
