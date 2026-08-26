import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_REGISTRY, validateHostAdapter } from '../../src/lib/adapters/index.mjs';
import {
  setupTrustManifest, trustManifestForOperation, newlyEnabledHostTrustManifest,
  autoApproveValues, trustManifestLines,
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

test('deja-vu setup disclosure is a companion group with exact v0.19 boundaries', () => {
  const cfg = {
    integrations: {
      hosts: { claude: true, codex: true, opencode: true },
      tools: { dejaVu: { enabled: true, mode: 'auto', hosts: ['claude', 'codex', 'opencode'], indexOnSetup: true } },
    },
  };
  const preflight = {
    facts: { install: { version: null } },
    plan: { operations: [{ kind: 'package-install', version: '0.19.0' }] },
  };
  const companion = setupTrustManifest(cfg, { hosts: [], companionPreflight: preflight })[0];
  assert.equal(companion.companionId, 'deja-vu');
  assert.equal(companion.hostId, undefined, 'managed companion must not masquerade as a host');
  assert.equal(companion.approvalPolicy, 'explicit-opt-in');
  const rendered = trustManifestLines([companion]).join('\n');
  for (const value of [
    '@vshulcz/deja-vu@0.19.0', 'claude-auto', 'codex-auto', 'opencode-auto',
    'PreToolUse command/edit', 'PreToolUse Bash/apply_patch',
    'no action-time PreToolUse', 'plaintext global deja-vu index with best-effort redaction',
    'deja doctor --json --offline (schema v2)',
  ]) assert.ok(rendered.includes(value), `missing companion trust fact: ${value}`);
  assert.doesNotMatch(rendered, /deja warmup|deja update|--all|\/Users\//);
});

test('deja-vu trust rendering bounds an untrusted installed-version observation', () => {
  const cfg = {
    integrations: {
      hosts: { claude: true },
      tools: { dejaVu: { enabled: true, mode: 'mcp', hosts: ['claude'], indexOnSetup: false } },
    },
  };
  const malicious = '0.19.0\n\u001b[31m/Users/alice/private/transcript';
  const manifest = setupTrustManifest(cfg, {
    hosts: [], companionPreflight: {
      facts: { install: { version: malicious } }, plan: { operations: [] },
    },
  });
  const rendered = trustManifestLines(manifest).join('\n');
  assert.match(rendered, /@vshulcz\/deja-vu@unknown/);
  assert.doesNotMatch(rendered, /alice|private|0\.19\.0/);
  assert.equal(rendered.includes('\u001b'), false);
});

test('deja-vu trust observes but never adopts a compatible external npm install', () => {
  const cfg = {
    integrations: {
      hosts: { claude: true },
      tools: { dejaVu: { enabled: true, mode: 'mcp', hosts: ['claude'], indexOnSetup: false } },
    },
  };
  const manifest = setupTrustManifest(cfg, {
    hosts: [], companionPreflight: {
      facts: { install: { version: '0.19.0', ownership: 'external', receiptState: 'missing' } },
      plan: { operations: [] },
    },
  });
  const packageFact = manifest[0].changes[0];
  assert.equal(packageFact.kind, 'npm-package-observation');
  assert.equal(packageFact.owner, 'user/external');
  assert.match(packageFact.effect, /without adopting, updating, or removing/);
});

test('deja-vu mode changes disclose the exact receipt-owned prior target removal', () => {
  const cfg = {
    integrations: {
      hosts: { claude: true },
      tools: { dejaVu: { enabled: true, mode: 'mcp', hosts: ['claude'], indexOnSetup: false } },
    },
  };
  const manifest = setupTrustManifest(cfg, {
    hosts: [], companionPreflight: {
      facts: { install: { version: '0.19.0', ownership: 'agentic-kit' } },
      plan: { operations: [{ kind: 'target-remove', host: 'claude', mode: 'auto' }] },
    },
  });
  const removal = manifest[0].changes.find((change) => change.kind === 'companion-target-removal');
  assert.equal(removal.value, 'claude-auto');
  assert.match(removal.effect, /receipt-owned prior claude wiring/);
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
