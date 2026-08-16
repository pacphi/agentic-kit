// The D2 keystone (ADR-0031 §1): a maintainer-granted capability
// (canBePrimary/commandStatusline) must become LIVE in effectiveHostRegistry()
// once applyAdmitted is handed a per-host grantsByName lookup — and must be
// impossible to smuggle anything else through that same seam. This file tests
// admitted.mjs's own overlay guarantee in isolation, with an injected
// grantsByName object (no fs, no grants.mjs) — the full bootstrap ->
// grants.mjs -> applyAdmitted wiring (including the manifest-hash-mismatch
// edit-invalidation case) is covered in adapter-admission.test.mjs instead.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAdmitted, resetAdmitted, effectiveHostRegistry, effectivePrimaryHostIds,
} from '../../src/lib/adapters/admitted.mjs';
import { HOST_REGISTRY, primaryHostIds } from '../../src/lib/adapters/registries.mjs';
import { hostTierLabel } from '../../src/lib/hosts.mjs';

beforeEach(() => resetAdmitted());

/** A validated, admittable host entry — canBePrimary/commandStatusline start
 *  false (the manifest floor: external adapters may never self-declare
 *  either, see manifest.mjs's cap-can-be-primary/cap-command-statusline
 *  refusals), so every capability these tests observe as true came from the
 *  grant overlay, never the manifest. */
function admittedHost(overrides = {}) {
  return {
    id: 'hermes',
    label: 'Hermes',
    install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: {
      canDriveSession: true, canBePrimary: false, canRouteActivities: true,
      commandStatusline: false, transcripts: true, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
    trust: { approvalPolicy: 'unchanged', changes: [] },
    enabledByDefault: false,
    configProjection: 'ruflo',
    observability: [],
    ...overrides,
  };
}

// ── flag-off / nothing-admitted byte-identity ───────────────────────────────

test('nothing admitted: effectiveHostRegistry() is HOST_REGISTRY by identity, effectivePrimaryHostIds() == primaryHostIds()', () => {
  assert.equal(effectiveHostRegistry(), HOST_REGISTRY);
  assert.deepEqual(effectivePrimaryHostIds(), primaryHostIds());
});

test('applyAdmitted with no grantsByName leaves capabilities at the manifest floor (byte-identical entry)', () => {
  applyAdmitted([{ entry: admittedHost() }]);
  const entry = effectiveHostRegistry().find((h) => h.id === 'hermes');
  assert.equal(entry.capabilities.canBePrimary, false);
  assert.equal(entry.capabilities.commandStatusline, false);
  assert.equal(effectivePrimaryHostIds().includes('hermes'), false);
  assert.deepEqual([...effectivePrimaryHostIds()].sort(), [...primaryHostIds()].sort());
});

test('applyAdmitted({grantsByName: {}}) — no entry for this host — is identical to no grantsByName at all', () => {
  applyAdmitted([{ entry: admittedHost() }], { grantsByName: {} });
  const entry = effectiveHostRegistry().find((h) => h.id === 'hermes');
  assert.equal(entry.capabilities.canBePrimary, false);
});

// ── the keystone: a granted capability lights up ────────────────────────────

test('a granted canBePrimary makes effectiveHostRegistry() show it true, and effectivePrimaryHostIds() include the host', () => {
  applyAdmitted([{ entry: admittedHost() }], { grantsByName: { hermes: { canBePrimary: true } } });
  const entry = effectiveHostRegistry().find((h) => h.id === 'hermes');
  assert.equal(entry.capabilities.canBePrimary, true);
  assert.ok(effectivePrimaryHostIds().includes('hermes'));
});

test('a granted canBePrimary lights up hostTierLabel — "drives sessions · can lead"', () => {
  applyAdmitted([{ entry: admittedHost() }], { grantsByName: { hermes: { canBePrimary: true } } });
  assert.equal(hostTierLabel('hermes'), 'drives sessions · can lead');
});

test('without the grant, hostTierLabel reflects the ungranted (routing-only external) tier', () => {
  applyAdmitted([{ entry: admittedHost() }]);
  assert.equal(hostTierLabel('hermes'), 'routing only · external adapter · not AQE');
});

test('a granted commandStatusline flips only that flag, leaving canBePrimary at the manifest floor', () => {
  applyAdmitted([{ entry: admittedHost() }], { grantsByName: { hermes: { commandStatusline: true } } });
  const entry = effectiveHostRegistry().find((h) => h.id === 'hermes');
  assert.equal(entry.capabilities.commandStatusline, true);
  assert.equal(entry.capabilities.canBePrimary, false);
  assert.equal(effectivePrimaryHostIds().includes('hermes'), false);
});

test('a host absent from grantsByName stays at its manifest floor while a sibling host in the same call is granted', () => {
  applyAdmitted([
    { entry: admittedHost({ id: 'hermes' }) },
    { entry: admittedHost({ id: 'iris' }) },
  ], { grantsByName: { hermes: { canBePrimary: true } } });
  const hosts = effectiveHostRegistry();
  assert.equal(hosts.find((h) => h.id === 'hermes').capabilities.canBePrimary, true);
  assert.equal(hosts.find((h) => h.id === 'iris').capabilities.canBePrimary, false);
});

// ── defensive allow-list: the overlay can NEVER carry anything else ─────────

test('a grantsByName entry cannot flip canRouteActivities, transcripts, or any non-grantable capability', () => {
  applyAdmitted([{ entry: admittedHost({
    capabilities: {
      canDriveSession: true, canBePrimary: false, canRouteActivities: false,
      commandStatusline: false, transcripts: false, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
  }) }], {
    grantsByName: {
      hermes: {
        canBePrimary: true, canRouteActivities: true, transcripts: true,
        usage: true, nativeMcpConfig: true, nativeGuidance: true, canDriveSession: true,
      },
    },
  });
  const { capabilities } = effectiveHostRegistry().find((h) => h.id === 'hermes');
  assert.equal(capabilities.canBePrimary, true, 'the one grantable flag actually granted must flip');
  assert.equal(capabilities.canRouteActivities, false, 'not grantable — must stay at the manifest floor');
  assert.equal(capabilities.transcripts, false, 'not grantable — must stay at the manifest floor');
  assert.equal(capabilities.usage, false, 'not grantable — must stay at the manifest floor');
  assert.equal(capabilities.nativeMcpConfig, false, 'not grantable — must stay at the manifest floor');
  assert.equal(capabilities.nativeGuidance, false, 'not grantable — must stay at the manifest floor');
});

test('a grantsByName entry can never introduce a key outside the eight schema-defined capabilities (e.g. aqeProvider)', () => {
  applyAdmitted([{ entry: admittedHost() }], {
    grantsByName: { hermes: { canBePrimary: true, aqeProvider: 'claude-code' } },
  });
  const { capabilities } = effectiveHostRegistry().find((h) => h.id === 'hermes');
  assert.equal(capabilities.aqeProvider, undefined, 'aqeProvider must never reach a host capabilities object via a grant');
  assert.deepEqual(Object.keys(capabilities).sort(), [
    'canBePrimary', 'canDriveSession', 'canRouteActivities', 'commandStatusline',
    'nativeGuidance', 'nativeMcpConfig', 'transcripts', 'usage',
  ]);
});

test('a grant can never flip a capability back to false — it can only raise, never lower', () => {
  applyAdmitted([{ entry: admittedHost({
    capabilities: {
      canDriveSession: true, canBePrimary: false, canRouteActivities: true,
      commandStatusline: false, transcripts: true, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
  }) }], { grantsByName: { hermes: { canBePrimary: false } } });
  const { capabilities } = effectiveHostRegistry().find((h) => h.id === 'hermes');
  assert.equal(capabilities.canBePrimary, false);
});

// ── deep-freeze holds on the grant-augmented entry too ──────────────────────

test('the grant-augmented entry (and its capabilities) is still deep-frozen', () => {
  applyAdmitted([{ entry: admittedHost() }], { grantsByName: { hermes: { canBePrimary: true } } });
  const entry = effectiveHostRegistry().find((h) => h.id === 'hermes');
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.capabilities));
  assert.throws(() => { 'use strict'; entry.capabilities.canBePrimary = false; }, TypeError);
  assert.equal(entry.capabilities.canBePrimary, true, 'the mutation attempt must not have taken effect');
});

// ── F-6 (LOW hardening): prototype-chain safety on the grantsByName lookup ──
// entry.id is a consented-but-adapter-supplied string; a host literally named
// 'constructor' must never resolve to Object.prototype.constructor via `[]`
// lookup on a plain object literal (grantsByName here is deliberately `{}`,
// NOT Object.create(null), to prove the READ side's own Object.hasOwn guard
// holds independently of admission.mjs building it null-prototype).

test('a host id of "constructor" is never misread as granted via the prototype chain (plain-object grantsByName)', () => {
  applyAdmitted([{ entry: admittedHost({ id: 'constructor' }) }], { grantsByName: {} });
  const entry = effectiveHostRegistry().find((h) => h.id === 'constructor');
  assert.equal(entry.capabilities.canBePrimary, false);
  assert.equal(entry.capabilities.commandStatusline, false);
});

test('effectiveHostRegistry() still returns HOST_REGISTRY entries by identity alongside a granted admitted entry', () => {
  applyAdmitted([{ entry: admittedHost() }], { grantsByName: { hermes: { canBePrimary: true } } });
  const combined = effectiveHostRegistry();
  assert.ok(HOST_REGISTRY.every((host) => combined.includes(host)), 'built-in entries must be unchanged references');
});
