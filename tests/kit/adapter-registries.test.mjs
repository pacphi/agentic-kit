import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_REGISTRY,
  PROVIDER_REGISTRY,
  PROJECTION_REGISTRY,
  OBSERVABILITY_REGISTRY,
  validateRegistries,
} from '../../src/lib/adapters/index.mjs';
import {
  validHost, validProvider, validRegistries,
} from './helpers/integration-builders.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the built-in registries satisfy their own contract', () => {
  assert.deepEqual(validateRegistries({
    hosts: HOST_REGISTRY,
    providers: PROVIDER_REGISTRY,
    projections: PROJECTION_REGISTRY,
    observability: OBSERVABILITY_REGISTRY,
  }), []);
});

// qe-court A3: the cross-axis invariants now run AT module construction — a
// host edit that violates canDriveSession → canBePrimary/canRouteActivities
// (or any other cross-axis rule) makes the import itself throw instead of
// loading silently. Pin it with a real import in a fresh process.
test('the shipped registries cannot fail construction-time validation (import cannot throw)', () => {
  const r = spawnSync(process.execPath, ['-e',
    "import('./src/lib/adapters/registries.mjs').then(() => console.log('construction-valid'))",
  ], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, `registries module must import cleanly:\n${r.stderr}`);
  assert.match(r.stdout, /construction-valid/);
});

test('built-in ids are unique within each registry and host/provider axes stay distinct', () => {
  for (const [axis, entries] of Object.entries({
    hosts: HOST_REGISTRY,
    providers: PROVIDER_REGISTRY,
    projections: PROJECTION_REGISTRY,
    observability: OBSERVABILITY_REGISTRY,
  })) {
    const ids = entries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `${axis} ids must be unique`);
  }
  const hostIds = new Set(HOST_REGISTRY.map((entry) => entry.id));
  for (const provider of PROVIDER_REGISTRY) {
    assert.equal(hostIds.has(provider.id), false, `${provider.id} must not also be a host`);
  }
});

test('registry validation reports duplicate ids with a deterministic field path', () => {
  const registries = validRegistries({
    hosts: [validHost(), validHost({ label: 'Duplicate host' })],
  });
  assert.deepEqual(validateRegistries(registries), [
    { path: 'hosts[1].id', code: 'duplicate-id', value: 'test-host' },
  ]);
});

test('registry validation rejects dangling projection and observability references', () => {
  const registries = validRegistries({
    hosts: [validHost({
      configProjection: 'missing-projection',
      observability: ['missing-source'],
    })],
  });
  assert.deepEqual(validateRegistries(registries), [
    { path: 'hosts[0].configProjection', code: 'unknown-projection', value: 'missing-projection' },
    { path: 'hosts[0].observability[0]', code: 'unknown-observability', value: 'missing-source' },
  ]);
});

test('routing and primary capabilities require a session-driving host', () => {
  const registries = validRegistries({
    hosts: [validHost({ capabilities: {
      ...validHost().capabilities,
      canDriveSession: false,
      canBePrimary: true,
      canRouteActivities: true,
    } })],
  });
  assert.deepEqual(validateRegistries(registries), [
    { path: 'hosts[0].capabilities.canBePrimary', code: 'requires-canDriveSession', value: true },
    { path: 'hosts[0].capabilities.canRouteActivities', code: 'requires-canDriveSession', value: true },
  ]);
});

test('billing and credential combinations reject fabricated local and metered semantics', () => {
  const localWithKey = validProvider({
    id: 'bad-local',
    billing: 'local',
    credentials: { kind: 'env', names: ['LOCAL_API_KEY'] },
    capabilities: { ...validProvider().capabilities, pricing: 'dated-offline' },
  });
  const meteredWithoutKey = validProvider({
    id: 'bad-metered',
    billing: 'metered',
    credentials: { kind: 'none' },
  });
  const errors = validateRegistries(validRegistries({ providers: [localWithKey, meteredWithoutKey] }));
  assert.deepEqual(errors, [
    { path: 'providers[0].credentials.kind', code: 'local-credentials-must-be-none', value: 'env' },
    { path: 'providers[0].capabilities.pricing', code: 'local-pricing-must-be-zero', value: 'dated-offline' },
    { path: 'providers[1].credentials.kind', code: 'metered-credentials-required', value: 'none' },
  ]);
});

test('credential descriptors contain environment variable names, never credential values', () => {
  const provider = validProvider({
    credentials: { kind: 'env', names: ['sk-secret-value'] },
  });
  assert.deepEqual(validateRegistries(validRegistries({ providers: [provider] })), [
    { path: 'providers[0].credentials.names[0]', code: 'invalid-env-name', value: 'sk-secret-value' },
  ]);
});
