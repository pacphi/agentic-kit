import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_REGISTRY, validateHostAdapter } from '../../src/lib/adapters/index.mjs';
import {
  setupTrustManifest, trustManifestForOperation, newlyEnabledHostTrustManifest,
  autoApproveValues, trustManifestLines, rufloComponentsTrustGroup,
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

test('managed browser disclosure does not imply a host approval-policy change', () => {
  const manifest = setupTrustManifest({
    agentBrowser: true,
    integrations: { hosts: {}, tools: {} },
  }, { hosts: [] });
  const browser = manifest.find((group) => group.componentId === 'agent-browser');
  assert.ok(browser);
  const rendered = trustManifestLines([browser]).join('\n');
  assert.match(rendered, /managed component changes disclosed; host approval\/sandbox policy unchanged/);
  assert.doesNotMatch(rendered, /receives the listed grants/);
});

test('setup discloses bounded Codex MCP removals without leaking machine paths', () => {
  const manifest = setupTrustManifest({
    agentBrowser: false, integrations: { hosts: { codex: true } },
  }, {
    hosts: [], project: true,
    codexRepairPlan: [
      { name: 'codex', scope: 'user', repairKind: 'recursive-codex', file: '/Users/alice/.codex/config.toml' },
      { name: 'claude-flow', scope: 'user', repairKind: 'legacy-ruflo', file: '/Users/alice/.codex/config.toml' },
    ],
  });
  const repair = manifest.find((group) => group.componentId === 'codex-mcp-repair');
  const rendered = trustManifestLines([repair]).join('\n');
  assert.match(rendered, /\[user\] mcp-registration-removal: \[mcp_servers\.codex\]/);
  assert.match(rendered, /\[user\] mcp-registration-removal: \[mcp_servers\.claude-flow\]/);
  assert.match(rendered, /create a current-state recovery copy/);
  assert.match(rendered, /through `codex mcp`/);
  assert.match(rendered, /approval\/sandbox policy unchanged/);
  assert.doesNotMatch(rendered, /\/Users\/alice/);
});

test('project Codex MCP repair disclosure names its bounded edit mechanism', () => {
  const manifest = setupTrustManifest({ agentBrowser: false }, {
    hosts: [], project: true,
    codexRepairPlan: [{
      name: 'codex', scope: 'project', repairKind: 'recursive-codex',
      file: '/work/project/.codex/config.toml',
    }],
  });
  const rendered = trustManifestLines(manifest).join('\n');
  assert.match(rendered, /with a bounded exact-table edit/);
  assert.doesNotMatch(rendered, /\/work\/project/);
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
  const companion = setupTrustManifest(cfg, { hosts: [], companionPreflight: preflight })
    .find((group) => group.companionId === 'deja-vu');
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
  const packageFact = manifest.find((group) => group.companionId === 'deja-vu').changes[0];
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
  const removal = manifest.find((group) => group.companionId === 'deja-vu').changes
    .find((change) => change.kind === 'companion-target-removal');
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
    agentBrowser: false, integrations: { hosts: { grok: true } }, aqe: true, ruvnetBrain: true,
  }, { hosts: [future] });
  // Default rufloComponents intent (ADR-0058) is always managed absent an
  // explicit opt-out, so its disclosure group rides along here too.
  assert.equal(manifest.length, 2);
  assert.equal(manifest[0].hostId, 'grok');
  assert.equal(manifest[0].changes[0].value, 'ruflo mcp start');
  assert.equal(manifest[1].componentId, 'ruflo-components');
  const picked = trustManifestForOperation({
    integrations: { hosts: { grok: true } }, aqe: true, ruvnetBrain: true,
  }, { hosts: [future], operation: 'host-pick' });
  assert.equal(picked[0].hostId, 'grok');
});

test('ruflo components trust group discloses every managed change with benefit, cost and opt-out', () => {
  const group = rufloComponentsTrustGroup({
    rufloComponents: {
      typesafePicker: true, minilmPicker: true, mcpGovernance: { maxCallsPerMinute: 120 },
      learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false,
    },
  });
  const text = trustManifestLines([group]).join('\n');
  for (const needle of [
    '@ruvector/typesafe', 'CLAUDE_FLOW_ROUTER_TYPESAFE=1', 'CLAUDE_FLOW_ROUTER_EMBEDDER=minilm',
    '.harness/mcp-policy.json', 'RUFLO_INTELLIGENCE_MODE=balanced', 'ruflo funnel disable', 'rufloComponents',
  ]) assert.ok(text.includes(needle), needle);
});

test('ruflo components trust group omits opted-out components', () => {
  const group = rufloComponentsTrustGroup({
    rufloComponents: {
      typesafePicker: false, minilmPicker: false, mcpGovernance: false,
      learningProfile: false, turnCredit: false, memoryFix2887: false, funnel: true,
    },
  });
  assert.equal(group, null);
});

test('ruflo components funnel disclosure names the irreversible funnel ID + event-queue deletion (ruling 2)', () => {
  const group = rufloComponentsTrustGroup({
    rufloComponents: {
      typesafePicker: false, minilmPicker: false, mcpGovernance: false,
      learningProfile: false, turnCredit: false, memoryFix2887: false, funnel: false,
    },
  });
  const funnelChange = group.changes.find((c) => c.id === 'rc-funnel');
  assert.match(funnelChange.effect, /no promotional tips or statusline promos/);
  assert.match(funnelChange.effect, /deletes ruflo's local funnel ID and event queue/);
});

test('ruflo components governance disclosure states enforcement is scoped to the ak-written policy file (ruling 3)', () => {
  const group = rufloComponentsTrustGroup({
    rufloComponents: {
      typesafePicker: false, minilmPicker: false, mcpGovernance: { maxCallsPerMinute: 60 },
      learningProfile: false, turnCredit: false, memoryFix2887: false, funnel: true,
    },
  });
  const text = trustManifestLines([group]).join('\n');
  assert.match(text, /enforced only against the policy file ak itself wrote/);
  assert.match(text, /project's own existing \.harness\/mcp-policy\.json is left alone/);
});
