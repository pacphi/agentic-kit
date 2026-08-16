import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_REGISTRY, validateHostAdapter } from '../../src/lib/adapters/index.mjs';
import {
  setupTrustManifest, trustManifestForOperation, newlyEnabledHostTrustManifest,
  autoApproveValues,
} from '../../src/lib/trust-manifest.mjs';
import { validHost } from './helpers/integration-builders.mjs';

test('every host adapter must declare an explicit setup trust posture', () => {
  assert.throws(() => validateHostAdapter(validHost({ trust: undefined })),
    /host\.trust must be an object/);
  assert.throws(() => validateHostAdapter(validHost({ trust: {
    approvalPolicy: 'managed',
    changes: [{
      id: 'bad-change', kind: 'auto-approve', scope: 'user', owner: 'test',
      value: 'test_*', effect: 'test effect', operations: ['setup'],
      features: ['unknown-feature'],
    }],
  } })), /host\.trust\.changes\[0\]\.features must be one of/);
});

test('host-pick preflight includes only newly enabled hosts and its own operations', () => {
  const cfg = {
    integrations: { hosts: { claude: true, codex: false, opencode: false } },
    aqe: true, ruvnetBrain: true,
  };
  const first = newlyEnabledHostTrustManifest(cfg, ['claude', 'codex', 'opencode']);
  assert.deepEqual(first.map((group) => group.hostId), ['codex', 'opencode']);
  assert.equal(first.find((group) => group.hostId === 'codex').changes
    .some((change) => change.value === 'aqe init --with-codex'), false,
  'host pick must not disclose a setup-only AQE action it does not run');
  assert.equal(newlyEnabledHostTrustManifest(cfg, ['claude']).length, 0,
    'an already accepted host must not prompt again');
});

test('built-in hosts distinguish managed approval from unchanged host policy', () => {
  const byId = Object.fromEntries(HOST_REGISTRY.map((host) => [host.id, host]));
  assert.equal(byId.claude.trust.approvalPolicy, 'managed');
  assert.equal(byId.opencode.trust.approvalPolicy, 'managed');
  assert.equal(byId.codex.trust.approvalPolicy, 'unchanged');
  assert.deepEqual(autoApproveValues('opencode'), [
    'claude-flow_*', 'claude_flow_*',
    'agentic-qe_*', 'agentic_qe_*',
    'ruvnet-brain_*', 'ruvnet_brain_*',
    'ak_ruflo_*, ak_aqe_*, ak_skill_search, ak_agent_*',
  ]);
});

test('a future enabled host joins setup disclosure without a setup command branch', () => {
  const future = {
    id: 'grok', label: 'Grok CLI',
    trust: {
      approvalPolicy: 'unchanged',
      changes: [{
        id: 'grok-ruflo-mcp', kind: 'mcp-registration', scope: 'user',
        owner: 'agentic-kit', value: 'ruflo mcp start',
        effect: 'register Ruflo in Grok', operations: ['setup', 'host-pick'],
      }],
    },
  };
  const manifest = setupTrustManifest({
    integrations: { hosts: { grok: true } }, aqe: true, ruvnetBrain: true,
  }, { hosts: [future] });
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].hostId, 'grok');
  assert.equal(manifest[0].changes[0].value, 'ruflo mcp start');
  const picked = trustManifestForOperation({
    integrations: { hosts: { grok: true } }, aqe: true, ruvnetBrain: true,
  }, { hosts: [future], operation: 'host-pick' });
  assert.equal(picked[0].hostId, 'grok');
});
