import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostsWithCapability,
  providersWithCapability,
  deriveCompatibilityExports,
  validatePrimaryHost,
  validateActivityHost,
} from '../../src/lib/adapters/index.mjs';
import { HOSTS as LEGACY_PROVIDER_HOSTS, API_PROVIDERS } from '../../src/lib/providers.mjs';
import {
  HOSTS as LEGACY_ROUTING_HOSTS,
  PRIMARY_HOSTS,
  isRoutableHost,
} from '../../src/lib/routing.mjs';
import { validHost, validProvider } from './helpers/integration-builders.mjs';

const hosts = [
  validHost({ id: 'claude', label: 'Claude Code' }),
  validHost({ id: 'codex', label: 'Codex CLI' }),
  validHost({
    id: 'future-host',
    label: 'Future Host',
    capabilities: {
      ...validHost().capabilities,
      canBePrimary: false,
      canRouteActivities: false,
      transcripts: false,
    },
  }),
];

const providers = [
  validProvider({ id: 'anthropic' }),
  validProvider({ id: 'openai' }),
  validProvider({
    id: 'future-provider',
    capabilities: {
      ...validProvider().capabilities,
      modelDiscovery: true,
    },
  }),
];

test('host selectors derive behavior solely from capability flags', () => {
  assert.deepEqual(hostsWithCapability(hosts, 'canDriveSession').map(({ id }) => id),
    ['claude', 'codex', 'future-host']);
  assert.deepEqual(hostsWithCapability(hosts, 'canBePrimary').map(({ id }) => id),
    ['claude', 'codex']);
  assert.deepEqual(hostsWithCapability(hosts, 'canRouteActivities').map(({ id }) => id),
    ['claude', 'codex']);
  assert.deepEqual(hostsWithCapability(hosts, 'transcripts').map(({ id }) => id),
    ['claude', 'codex']);
});

test('a managed future host can participate in lifecycle without becoming routable', () => {
  assert.deepEqual(validatePrimaryHost('future-host', hosts), {
    ok: false, reason: 'capability-canBePrimary-required',
  });
  assert.deepEqual(validateActivityHost('future-host', hosts), {
    ok: false, reason: 'capability-canRouteActivities-required',
  });
  assert.deepEqual(validatePrimaryHost('claude', hosts), { ok: true });
  assert.deepEqual(validateActivityHost('codex', hosts), { ok: true });
});

test('provider selectors add a future provider without adding a host', () => {
  assert.deepEqual(providersWithCapability(providers, 'modelDiscovery').map(({ id }) => id),
    ['future-provider']);
  assert.equal(hosts.some(({ id }) => id === 'future-provider'), false);
});

test('compatibility exports are derived views of registries', () => {
  const compatibility = deriveCompatibilityExports({ hosts, providers });
  assert.deepEqual(compatibility.hostIds, ['claude', 'codex', 'future-host']);
  assert.deepEqual(compatibility.primaryHostIds, ['claude', 'codex']);
  assert.deepEqual(compatibility.routableHostIds, ['claude', 'codex']);
  assert.deepEqual(compatibility.apiProviderIds, ['anthropic', 'openai', 'future-provider']);
});

test('current compatibility exports remain aligned with built-in registry views', () => {
  const compatibility = deriveCompatibilityExports();
  assert.deepEqual(LEGACY_ROUTING_HOSTS, compatibility.routableHostIds);
  assert.deepEqual(PRIMARY_HOSTS, compatibility.primaryHostIds);
  assert.deepEqual(LEGACY_PROVIDER_HOSTS.map(({ id }) => id), compatibility.managedHostIds);
  assert.deepEqual(API_PROVIDERS.map(({ id }) => id), compatibility.apiProviderIds);
  for (const id of compatibility.routableHostIds) assert.equal(isRoutableHost(id), true);
});
