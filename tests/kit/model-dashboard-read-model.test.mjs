import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDashboardModelPayload, createDashboardModelViewPayload,
} from '../../src/lib/model-inventory/read-model.mjs';
import { modelIdentityKey } from '../../src/lib/model-inventory/contracts.mjs';
import { discoverAnthropicPublicCatalog } from '../../src/lib/model-inventory/discovery/anthropic-catalog.mjs';
import { startDashboard as realStartDashboard } from '../../src/lib/dashboard-server.mjs';

const AT = '2026-08-25T12:00:00.000Z';
const KEY = 'cd'.repeat(32);

function startDashboard(opts = {}) {
  return realStartDashboard(opts);
}

function evidence(id, field, source, klass = 'catalog') {
  return {
    id, field, source, class: klass, capturedAt: AT, freshness: 'fresh',
    completeness: 'complete', scopeFingerprint: 'scope-private', refs: [],
  };
}

function dimensions(values = {}, refs = {}) {
  return Object.fromEntries([
    'configured', 'effective', 'observed', 'discoverable', 'entitled',
    'policyAllowed', 'routable', 'recommended',
  ].map((name) => [name, {
    value: values[name] ?? null,
    evidenceRefs: refs[name] ? [refs[name]] : [],
  }]));
}

function model({ host, provider, id, name, source, values = {}, lifecycle = 'active', replacement = null, catalog }) {
  const refs = {};
  const rows = [];
  for (const [field, value] of Object.entries(values)) {
    if (value == null) continue;
    const evidenceId = `${id}-${field}`;
    refs[field] = evidenceId;
    rows.push(evidence(evidenceId, `dimensions.${field}`, source,
      source.includes('config') ? 'configured' : 'catalog'));
  }
  if (catalog) rows.push(evidence(`${id}-catalog`, 'variant.catalog', source));
  if (replacement) rows.push(evidence(`${id}-lifecycle`, 'lifecycle', source, 'first-party'));
  return {
    key: { host, provider, modelId: id, scopeId: 'scope-private', digest: null },
    displayName: name, aliases: [], visibility: values.discoverable === true ? 'visible' : 'unknown',
    variant: catalog ? { catalog } : {}, capabilities: {}, pricing: null, edges: [],
    lifecycle: { state: lifecycle, replacement, notice: null, effectiveAt: null,
      evidenceRefs: replacement ? [`${id}-lifecycle`] : [] },
    dimensions: dimensions(values, refs), evidence: rows,
  };
}

function payload() {
  const models = [
    model({
      host: 'codex', provider: null, id: 'gpt-5.6-codex', name: 'GPT-5.6 Codex',
      source: 'codex-cache', values: { observed: true, discoverable: true, entitled: true },
      lifecycle: 'retiring', replacement: 'gpt-5.7-codex',
    }),
    model({
      host: 'opencode', provider: 'openrouter', id: '~anthropic/claude-sonnet-latest',
      name: 'Anthropic Claude Sonnet Latest', source: 'opencode-models',
      values: { discoverable: true },
      catalog: {
        source: 'models.dev', public: true, servingProvider: 'openrouter', publisher: 'Anthropic',
        family: 'claude-sonnet', selector: 'openrouter/~anthropic/claude-sonnet-latest',
        links: {
          catalog: 'https://models.dev/models/anthropic/claude-sonnet-4-6',
          provider: 'https://private.example.test/models/secret',
          weights: 'https://token@huggingface.co/models/nope',
        },
      },
    }),
    model({
      host: 'codex', provider: 'private-provider', id: 'private-deployment', name: 'Acme Secret Model',
      source: 'codex-cache', values: { configured: true, effective: true },
    }),
    model({
      host: 'opencode', provider: 'custom-private', id: 'secret/model', name: 'Secret Model',
      source: 'opencode-models', values: { discoverable: true },
      catalog: { source: 'opencode', servingProvider: 'custom-private', selector: 'custom-private/secret/model' },
    }),
    model({
      host: 'ollama', provider: null, id: 'local-alpha', name: 'Local Alpha',
      source: 'ollama-catalog', values: { discoverable: true }, lifecycle: 'retiring',
    }),
    model({
      host: 'claude', provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6',
      source: 'claude-config', values: { configured: true, effective: true },
    }),
    model({
      host: 'claude', provider: 'private-gateway', id: 'claude-private-acme', name: 'Acme Claude Gateway',
      source: 'claude-config', values: { configured: true, effective: true },
    }),
    model({
      host: 'codex', provider: null, id: 'gpt-5.7-codex', name: 'GPT-5.7 Codex',
      source: 'codex-cache', values: { discoverable: true },
    }),
  ];
  return {
    status: 'cached',
    snapshot: {
      schemaVersion: 1, snapshotId: 'snapshot-private', capturedAt: AT,
      scope: { fingerprint: 'scope-private', hosts: ['codex', 'opencode', 'ollama'], profileFingerprints: {} },
      sources: [
        { id: 'codex-cache', owner: 'codex', ownerType: 'host', transport: 'file', network: 'never', mode: 'local', status: 'complete', capturedAt: AT, schema: 'codex-model-cache-v1', scopeFingerprint: 'scope-private', diagnostics: [] },
        { id: 'opencode-models', owner: 'opencode', ownerType: 'host', transport: 'command', network: 'never', mode: 'local', status: 'complete', capturedAt: AT, schema: 'opencode-models-lines-v1', scopeFingerprint: 'scope-private', diagnostics: [] },
        { id: 'ollama-catalog', owner: 'ollama', ownerType: 'host', transport: 'command', network: 'local', mode: 'local', status: 'complete', capturedAt: AT, schema: 'ollama-ls-v1', scopeFingerprint: 'scope-private', diagnostics: [] },
      ],
      models, bindings: [], changes: [], diagnostics: [],
    },
    history: [{ snapshotId: 'snapshot-private', capturedAt: AT }],
    comparison: { baseline: null, latest: 'snapshot-private', comparable: false, diagnostics: [] },
  };
}

test('owner-visible projection exposes exact model identity while withholding configuration secrets and trusted links', () => {
  const result = createDashboardModelPayload(payload(), { key: KEY });
  const [codex, opencode, privateCodex, customOpenCode, , claude, privateClaude] = result.snapshot.models;

  assert.deepEqual({
    displayName: codex.displayName, humanName: codex.humanName, selector: codex.selector,
    servingProvider: codex.servingProvider, publisher: codex.publisher, privacyClass: codex.privacyClass,
  }, {
    displayName: 'GPT-5.6 Codex', humanName: 'GPT-5.6 Codex', selector: 'gpt-5.6-codex',
    servingProvider: 'openai', publisher: 'OpenAI', privacyClass: 'public-catalog',
  });
  assert.deepEqual({
    displayName: opencode.displayName, selector: opencode.selector,
    servingProvider: opencode.servingProvider, publisher: opencode.publisher, family: opencode.family,
  }, {
    displayName: 'Anthropic Claude Sonnet Latest', selector: '~anthropic/claude-sonnet-latest',
    servingProvider: 'openrouter', publisher: 'Anthropic', family: 'claude-sonnet',
  });
  assert.deepEqual(opencode.links, [{
    kind: 'catalog', label: 'Models.dev',
    url: 'https://models.dev/models/anthropic/claude-sonnet-4-6',
  }]);
  assert.deepEqual({
    displayName: claude.displayName, selector: claude.selector,
    servingProvider: claude.servingProvider, publisher: claude.publisher,
  }, {
    displayName: 'Claude Sonnet 4.6', selector: 'claude-sonnet-4-6',
    servingProvider: 'anthropic', publisher: 'Anthropic',
  });
  assert.equal(claude.links.some(({ url }) => url.startsWith('https://platform.claude.com/')), true);
  assert.equal(codex.links.some(({ url }) => url.startsWith('https://developers.openai.com/')), true);
  assert.deepEqual({
    replacement: codex.lifecycle.replacement, replacementName: codex.lifecycle.replacementName,
    replacementSelector: codex.lifecycle.replacementSelector,
  }, {
    replacement: 'gpt-5.7-codex', replacementName: 'gpt-5.7-codex',
    replacementSelector: 'gpt-5.7-codex',
  });

  assert.deepEqual({
    name: privateCodex.displayName, selector: privateCodex.selector, provider: privateCodex.servingProvider,
    privacyClass: privateCodex.privacyClass,
  }, {
    name: 'Acme Secret Model', selector: 'private-deployment', provider: 'private-provider',
    privacyClass: 'owner-visible',
  });
  assert.deepEqual({
    name: customOpenCode.displayName, selector: customOpenCode.selector, provider: customOpenCode.servingProvider,
  }, { name: 'Secret Model', selector: 'secret/model', provider: 'custom-private' });
  assert.deepEqual({
    name: privateClaude.displayName, selector: privateClaude.selector, provider: privateClaude.servingProvider,
  }, { name: 'Acme Claude Gateway', selector: 'claude-private-acme', provider: 'private-gateway' });

  const datedInput = payload();
  datedInput.snapshot.models[5].key.modelId = 'claude-haiku-4-5-20251001';
  datedInput.snapshot.models[5].displayName = 'claude-haiku-4-5-20251001';
  const dated = createDashboardModelPayload(datedInput, { key: KEY }).snapshot.models[5];
  assert.equal(dated.displayName, 'Claude Haiku 4.5 (2025-10-01)');

  const legacyAliasInput = payload();
  legacyAliasInput.snapshot.models[5].key.modelId = 'claude-opus-4-5';
  legacyAliasInput.snapshot.models[5].displayName = 'claude-opus-4-5';
  const legacyAlias = createDashboardModelPayload(legacyAliasInput, { key: KEY }).snapshot.models[5];
  assert.deepEqual({
    displayName: legacyAlias.displayName, selector: legacyAlias.selector,
    privacyClass: legacyAlias.privacyClass,
  }, {
    displayName: 'Claude Opus 4.5', selector: 'claude-opus-4-5',
    privacyClass: 'public-catalog',
  });

  const gatewayInput = payload();
  gatewayInput.snapshot.models[5].key.provider = 'private-gateway';
  const gatewayOfficial = createDashboardModelPayload(gatewayInput, { key: KEY }).snapshot.models[5];
  assert.equal(gatewayOfficial.publisher, 'Anthropic');
  assert.equal(gatewayOfficial.servingProvider, 'private-gateway');

  const privateLookingOfficial = payload();
  for (const id of [
    'claude-sonnet-private-acme', 'claude-sonnet-42', 'claude-opus-99-99',
    'claude-haiku-4-5-20991231',
  ]) privateLookingOfficial.snapshot.models.push(model({
    host: 'claude', provider: 'private-gateway', id,
    name: `Secret ${id}`, source: 'claude-config', values: { configured: true, effective: true },
  }));
  privateLookingOfficial.snapshot.models[3].variant.configuredVariants = ['private-prod'];
  const privateProjection = createDashboardModelPayload(privateLookingOfficial, { key: KEY });
  const serializedPrivate = JSON.stringify(privateProjection);
  for (const modelId of [
    'claude-sonnet-private-acme', 'claude-sonnet-42', 'claude-opus-99-99',
    'claude-haiku-4-5-20991231',
  ]) assert.equal(serializedPrivate.includes(modelId), true, modelId);
  assert.equal(serializedPrivate.includes('private-prod'), false, 'private execution variant stays hidden');
  assert.equal(privateProjection.snapshot.models.slice(-4)
    .every(({ privacyClass }) => privacyClass === 'owner-visible'), true);

  const localInput = payload();
  localInput.snapshot.models[4].key.provider = 'ollama';
  localInput.snapshot.models[4].variant = {
    modifiedAt: '2026-08-24T10:00:00.000Z', format: 'gguf', family: 'qwen3',
    families: ['qwen3'], parameterSize: '30.5B', quantizationLevel: 'Q4_K_M',
    expiresAt: '2026-08-25T14:00:00.000Z', licenseSummary: 'Apache-2.0',
    advertisedCapabilities: ['completion', 'tools'], reasoningEffort: 'private-local-setting',
  };
  const local = createDashboardModelPayload(localInput, { key: KEY }).snapshot.models[4];
  assert.deepEqual(local.variant, {
    modifiedAt: '2026-08-24T10:00:00.000Z', format: 'gguf', family: 'qwen3',
    families: ['qwen3'], parameterSize: '30.5B', quantizationLevel: 'Q4_K_M',
    expiresAt: '2026-08-25T14:00:00.000Z', licenseSummary: 'Apache-2.0',
    advertisedCapabilities: ['completion', 'tools'],
    reasoningEffort: local.variant.reasoningEffort,
  });
  assert.match(local.variant.reasoningEffort, /^variant-[a-f0-9]{12}$/);
});

test('migration attention names affected routes, replacement, action, and first-party notice', () => {
  const input = payload();
  input.snapshot.models[0].lifecycle.notice = 'https://developers.openai.com/api/docs/deprecations/';
  input.snapshot.bindings = [{
    id: 'binding:codex-review', consumer: 'route:review', activity: 'review',
    host: 'codex', provider: 'openai', configured: 'gpt-5.6-codex', effective: 'gpt-5.6-codex',
    consumerState: 'configured', evidenceRefs: [],
  }];
  const [attention] = createDashboardModelPayload(input, { key: KEY }).snapshot.attention;
  assert.deepEqual({
    kind: attention.kind, current: attention.currentModel, replacement: attention.replacementModel,
    routes: attention.affectedRoutes, docs: attention.documentationUrl, action: attention.action,
  }, {
    kind: 'migration', current: 'GPT-5.6 Codex', replacement: 'gpt-5.7-codex',
    routes: [{ activity: 'review', consumer: 'review · primary', role: 'primary' }],
    docs: 'https://developers.openai.com/api/docs/deprecations/',
    action: 'ak models plan --activity review --to codex:gpt-5.7-codex',
  });
});

test('public lifecycle history stays in the catalogue without creating local migration alerts', () => {
  const input = payload();
  const retired = model({
    host: 'claude', provider: null, id: 'claude-opus-4-1-20250805',
    name: 'Claude Opus 4.1 (2025-08-05)', source: 'anthropic-docs',
    values: { discoverable: false }, lifecycle: 'removed', replacement: 'claude-opus-4-8',
  });
  retired.lifecycle.notice = 'https://platform.claude.com/docs/en/about-claude/model-deprecations';
  for (const row of retired.evidence) row.class = 'first-party';
  input.snapshot.models.push(retired);

  const full = createDashboardModelPayload(input, { key: KEY });
  assert.equal(full.snapshot.counts.migrations, 0);
  assert.equal(full.snapshot.attention.some(({ kind }) => kind === 'migration'), false);

  const relevant = createDashboardModelViewPayload(input, {
    key: KEY, query: new URLSearchParams('view=inventory'),
  });
  assert.equal(relevant.inventory.items.some(({ selector }) => (
    selector === 'claude-opus-4-1-20250805'
  )), false);
  const catalogue = createDashboardModelViewPayload(input, {
    key: KEY, query: new URLSearchParams('view=inventory&relevance=all'),
  });
  assert.equal(catalogue.inventory.items.some(({ selector }) => (
    selector === 'claude-opus-4-1-20250805'
  )), true);
});

test('owner-visible change history names the model and change without exposing transport joins', () => {
  const input = payload();
  const target = input.snapshot.models[0];
  const identity = modelIdentityKey(target.key);
  input.snapshot.changes = [{
    kind: 'model-added', subject: identity, before: null, after: target.key,
    severity: 'info', provisional: false, evidenceRefs: ['private-change-evidence'],
  }];

  const [change] = createDashboardModelPayload(input, { key: KEY }).snapshot.changes;
  assert.deepEqual(change, {
    kind: 'model-added', label: 'Model added', modelName: 'GPT-5.6 Codex',
    selector: 'gpt-5.6-codex', modelProvider: 'openai', host: 'codex',
    detail: 'Appeared in the latest inventory.', severity: 'info', provisional: false,
    detectedAt: AT,
  });
  assert.equal(JSON.stringify(change).includes(identity), false);
  assert.equal(JSON.stringify(change).includes('private-change-evidence'), false);
});

test('payload envelopes allowlist cached, history, comparison, and empty fields', () => {
  const input = payload();
  input.status = 'private-status-secret';
  input.privateDebug = 'private-debug-value';
  input.history[0].privatePath = '/secret/history/path';
  input.history.push({
    snapshotId: 'snapshot-private-two', capturedAt: 'not-a-timestamp-secret',
    rawIdentifier: 'history-private-identifier',
  });
  input.comparison.privateProvider = 'comparison-private-provider';
  const result = createDashboardModelPayload(input, { key: KEY });
  const wire = JSON.stringify(result);
  for (const secret of [
    'private-status-secret', 'private-debug-value', '/secret/history/path', 'not-a-timestamp-secret',
    'history-private-identifier', 'comparison-private-provider',
  ]) assert.equal(wire.includes(secret), false, secret);
  assert.deepEqual(Object.keys(result).sort(), ['comparison', 'history', 'snapshot', 'status']);
  assert.equal(result.status, 'cached');
  assert.deepEqual(Object.keys(result.history[0]).sort(), ['capturedAt', 'snapshotId']);
  assert.deepEqual(Object.keys(result.comparison).sort(), [
    'baseline', 'comparable', 'diagnostics', 'latest',
  ]);
  assert.equal(result.history.length, 1);

  for (const empty of [
    null,
    { status: 'empty', snapshot: null, history: [], hint: 'private hint', privateDebug: 'secret' },
    { status: 'cached', snapshot: null, history: [], privateDebug: 'secret' },
  ]) assert.deepEqual(createDashboardModelPayload(empty), {
    status: 'empty', snapshot: null, history: [], hint: 'ak models refresh',
  });
});

test('owner-visible bindings name the consumer, exact model, and provider without internal ids', () => {
  const input = payload();
  input.snapshot.bindings = [{
    id: 'binding:secret-route-id', consumer: 'route:implementation:escalation:0', activity: 'implementation',
    host: 'codex', provider: 'private-provider', configured: 'private-deployment', effective: 'private-deployment',
    consumerState: 'configured', evidenceRefs: [],
  }];
  const [binding] = createDashboardModelPayload(input, { key: KEY }).snapshot.bindings;
  assert.deepEqual({
    consumer: binding.consumer, role: binding.role, modelName: binding.modelName,
    selector: binding.selector, modelProvider: binding.modelProvider,
  }, {
    consumer: 'implementation · fallback 1', role: 'fallback 1', modelName: 'Acme Secret Model',
    selector: 'private-deployment', modelProvider: 'private-provider',
  });
  assert.equal(JSON.stringify(binding).includes('secret-route-id'), false);
});

test('an exact official Claude id observed by the Claude host establishes Anthropic as model provider', () => {
  const input = payload();
  const observed = model({
    host: 'claude', provider: null, id: 'claude-opus-4-8', name: 'claude-opus-4-8',
    source: 'usage-index', values: { observed: true, entitled: true },
  });
  for (const row of observed.evidence) row.class = 'observed';
  input.snapshot.models.push(observed);
  const projected = createDashboardModelPayload(input, { key: KEY }).snapshot.models.at(-1);
  assert.deepEqual({
    name: projected.displayName, provider: projected.servingProvider, publisher: projected.publisher,
  }, { name: 'Claude Opus 4.8', provider: 'anthropic', publisher: 'Anthropic' });
});

test('Anthropic public facts survive the owner-visible Dashboard projection without claiming access', () => {
  const catalog = discoverAnthropicPublicCatalog({
    capturedAt: AT, scopeKey: '0123456789abcdef0123456789abcdef',
  });
  const input = payload();
  input.snapshot.sources = [catalog.source];
  input.snapshot.models = catalog.models;
  input.snapshot.bindings = [];
  const result = createDashboardModelPayload(input, { key: KEY });
  const fable = result.snapshot.models.find(({ selector }) => selector === 'claude-fable-5');
  assert.deepEqual({
    name: fable.displayName, provider: fable.servingProvider, publisher: fable.publisher,
    lifecycle: fable.lifecycle.state, scope: fable.variant.lifecycleScope,
    availability: fable.variant.availability, context: fable.capabilities.contextLimit,
    output: fable.capabilities.outputLimit, discoverable: fable.dimensions.discoverable.value,
    entitled: fable.dimensions.entitled.value, routable: fable.dimensions.routable.value,
  }, {
    name: 'Claude Fable 5', provider: 'anthropic', publisher: 'Anthropic', lifecycle: 'active',
    scope: 'Anthropic-operated platforms', availability: 'general', context: 1_000_000,
    output: 128_000, discoverable: true, entitled: null, routable: null,
  });
  assert.equal(fable.links.some(({ url }) => (
    url === 'https://platform.claude.com/docs/en/about-claude/models/overview'
  )), true);
  assert.equal(fable.pricing.source, 'Anthropic Models and pricing');
  assert.equal(result.snapshot.counts.migrations, 0);
});

test('summary mode omits only the large model inventory and reports inventory counts', () => {
  const result = createDashboardModelViewPayload(payload(), {
    key: KEY, query: new URLSearchParams('view=summary'),
  });
  assert.equal('models' in result.snapshot, false);
  assert.deepEqual(result.snapshot.bindings, []);
  assert.deepEqual(result.snapshot.changes, []);
  assert.equal(result.inventory.total, 8);
  assert.equal(result.inventory.relevantTotal, 5);
  assert.equal(result.snapshot.counts.models, 8);
});

test('summary mode projects windowed observed models and joins actual route last-use evidence', () => {
  const input = payload();
  input.snapshot.bindings = [{
    id: 'binding:codex-review', consumer: 'route:review', activity: 'review',
    host: 'codex', provider: null, configured: 'gpt-5.6-codex', effective: 'gpt-5.6-codex',
    consumerState: 'configured', evidenceRefs: [],
  }];
  const usage = {
    generatedAt: '2026-08-25T13:30:00.000Z',
    sessions: [{
      id: 'private-session-one', host: 'codex', provider: 'openai',
      models: ['gpt-5.6-codex'], start: '2026-08-24T10:00:00.000Z', minutes: 30,
      responses: 8, tokens: 1_000, cost: 0.25, title: 'private title', project: 'private project',
    }, {
      id: 'private-session-two', host: 'codex', provider: 'openai',
      models: ['gpt-5.6-codex'], start: '2026-08-25T12:00:00.000Z', minutes: 15,
      responses: 3, tokens: 500, cost: 0.1,
    }, {
      id: 'private-opencode-session', host: 'opencode', provider: 'lmstudio',
      models: ['qwen/qwen3-coder-30b'], start: '2026-08-23T12:00:00.000Z', minutes: 5,
      responses: 1, tokens: 100, cost: 0,
    }],
  };
  const result = createDashboardModelViewPayload(input, {
    key: KEY, usage, days: 14, query: new URLSearchParams('view=summary&days=14'),
  });
  assert.equal(result.observedWindow.days, 14);
  assert.equal(result.observedWindow.generatedAt, usage.generatedAt);
  assert.deepEqual(result.observedWindow.models.map((row) => ({
    model: row.modelName, provider: row.modelProvider, host: row.host,
    sessions: row.sessions, lastUsed: row.lastUsed,
  })), [{
    model: 'GPT-5.6 Codex', provider: 'openai', host: 'codex', sessions: 2,
    lastUsed: '2026-08-25T12:15:00.000Z',
  }, {
    model: 'qwen/qwen3-coder-30b', provider: 'lmstudio', host: 'opencode', sessions: 1,
    lastUsed: '2026-08-23T12:05:00.000Z',
  }]);
  assert.equal(result.snapshot.bindings[0].modelProvider, 'openai');
  assert.equal(result.snapshot.bindings[0].lastUsed, '2026-08-25T12:15:00.000Z');
  const wire = JSON.stringify(result);
  assert.equal(wire.includes('private-session-one'), false);
  assert.equal(wire.includes('private title'), false);
  assert.equal(wire.includes('private project'), false);
});

test('inventory mode defaults to relevant rows, pages at 100 max, and returns stable metadata', () => {
  const result = createDashboardModelViewPayload(payload(), {
    key: KEY, query: new URLSearchParams('view=inventory&offset=0&limit=1000&sort=displayName&direction=asc'),
  });
  assert.equal(result.inventory.total, 8);
  assert.equal(result.inventory.relevantTotal, 5);
  assert.equal(result.inventory.filteredTotal, 5);
  assert.equal(result.inventory.limit, 100);
  assert.equal(result.inventory.offset, 0);
  assert.equal(result.inventory.hasMore, false);
  assert.equal(result.inventory.nextOffset, null);
  assert.equal(result.inventory.sort, 'displayName');
  assert.equal(result.inventory.direction, 'asc');
  assert.deepEqual(result.inventory.facets.hosts, [
    { value: 'claude', count: 2 }, { value: 'codex', count: 3 },
    { value: 'ollama', count: 1 }, { value: 'opencode', count: 2 },
  ]);
  assert.deepEqual(result.inventory.facets.providers,
    ['anthropic', 'custom-private', 'openai', 'openrouter', 'private-gateway', 'private-provider']
      .map((value) => ({ value, count: value === 'openai' ? 2 : 1 })));
  assert.deepEqual(result.inventory.facets.publishers,
    [{ value: 'Anthropic', count: 2 }, { value: 'OpenAI', count: 2 }]);
  assert.deepEqual(result.inventory.facets.lifecycles,
    [{ value: 'active', count: 6 }, { value: 'retiring', count: 2 }]);
  assert.deepEqual(result.inventory.facets.dimensions.entitled,
    [{ value: 'unknown', count: 7 }, { value: 'yes', count: 1 }]);
  assert.equal(result.snapshot.snapshotId.startsWith('snapshot-'), true);
  const names = result.inventory.items.map(({ displayName }) => displayName);
  for (const name of ['Acme Claude Gateway', 'Acme Secret Model', 'Claude Sonnet 4.6', 'GPT-5.6 Codex']) {
    assert.equal(names.includes(name), true, name);
  }
});

test('inventory filtering and sorting use only projected fields and keep unknown last both directions', () => {
  const publicOnly = createDashboardModelViewPayload(payload(), {
    key: KEY,
    query: new URLSearchParams('view=inventory&relevance=all&provider=openrouter&publisher=Anthropic&search=sonnet'),
  });
  assert.equal(publicOnly.inventory.filteredTotal, 1);
  assert.equal(publicOnly.inventory.items[0].selector, '~anthropic/claude-sonnet-latest');

  for (const direction of ['asc', 'desc']) {
    const sorted = createDashboardModelViewPayload(payload(), {
      key: KEY,
      query: new URLSearchParams(`view=inventory&relevance=all&sort=entitled&direction=${direction}`),
    });
    assert.equal(sorted.inventory.items.at(-1).dimensions.entitled.value, null, direction);
    assert.equal(sorted.inventory.items[0].dimensions.entitled.value, true, direction);
  }
  const unknown = createDashboardModelViewPayload(payload(), {
    key: KEY,
    query: new URLSearchParams('view=inventory&relevance=all&entitled=unknown'),
  });
  assert.equal(unknown.inventory.filteredTotal, 7);

  const shorthand = createDashboardModelViewPayload(payload(), {
    key: KEY,
    query: new URLSearchParams('view=inventory&relevance=all&evidenceField=entitled&evidenceValue=yes'),
  });
  assert.equal(shorthand.inventory.filteredTotal, 1);
  assert.deepEqual(shorthand.inventory.filters,
    { relevance: 'all', evidenceField: 'entitled', evidenceValue: 'yes' });
});

test('inventory query rejects non-allowlisted sort, filters, and invalid offsets', () => {
  for (const params of [
    'view=inventory&sort=identity',
    'view=inventory&offset=-1',
    'view=inventory&configured=maybe',
    'view=inventory&evidenceField=recommended&evidenceValue=yes',
    'view=inventory&evidenceField=observed',
    'view=inventory&privateSelector=secret',
    'view=summary&limit=10',
  ]) {
    assert.throws(() => createDashboardModelViewPayload(payload(), {
      key: KEY, query: new URLSearchParams(params),
    }), /invalid model inventory query/);
  }
});

test('inventory pages are bound to one privacy-projected snapshot id', () => {
  const first = createDashboardModelViewPayload(payload(), {
    key: KEY, query: new URLSearchParams('view=inventory&limit=2'),
  });
  assert.throws(() => createDashboardModelViewPayload(payload(), {
    key: KEY, query: new URLSearchParams('view=inventory&offset=2&limit=2&snapshotId=snapshot-stale'),
  }), (error) => error?.code === 'MODEL_INVENTORY_SNAPSHOT_CHANGED');
  const next = createDashboardModelViewPayload(payload(), {
    key: KEY,
    query: new URLSearchParams(`view=inventory&offset=2&limit=2&snapshotId=${first.snapshot.snapshotId}`),
  });
  assert.equal(next.inventory.offset, 2);
});

test('authenticated /api/models exposes additive summary/inventory modes and generic query failures', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-model-dashboard-'));
  let reads = 0;
  const usageReads = [];
  let usageFails = false;
  const server = await startDashboard({
    cwd, port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: { readIndex: async (options) => {
      usageReads.push(options);
      if (usageFails) throw new Error('private usage failure');
      return { generatedAt: AT, sessions: [] };
    } },
    modelScopeKey: KEY, models: async () => { reads++; return payload(); },
    discoverProjects: () => [], machineWideIntel: () => ({}),
  });
  const get = async (suffix) => {
    const response = await fetch(`${server.url}api/models${suffix}`, {
      headers: { 'x-dash-token': server.token },
    });
    return { response, body: await response.json() };
  };
  try {
    const summary = await get('?view=summary&days=30');
    assert.equal(summary.response.status, 200);
    assert.equal('models' in summary.body.snapshot, false);
    assert.equal(summary.body.observedWindow.days, 30);
    assert.deepEqual(usageReads, [{ days: 30 }]);
    assert.equal(summary.response.headers.get('cache-control'), 'no-store');

    usageFails = true;
    const degraded = await get('?view=summary&days=7');
    assert.equal(degraded.response.status, 200);
    assert.equal(degraded.body.observedWindow.status, 'unavailable');
    assert.equal(degraded.body.observedWindow.days, 7);
    assert.equal(degraded.body.snapshot.counts.models, 8);
    usageFails = false;

    const inventory = await get('?view=inventory&relevance=all&limit=2&offset=2');
    assert.equal(inventory.response.status, 200);
    assert.equal(inventory.body.inventory.items.length, 2);
    assert.equal(inventory.body.inventory.hasMore, true);
    assert.equal(inventory.body.inventory.nextOffset, 4);

    const invalid = await get('?view=inventory&sort=key.modelId');
    assert.equal(invalid.response.status, 400);
    assert.deepEqual(invalid.body, { error: 'invalid model inventory query' });
    const stale = await get('?view=inventory&offset=2&snapshotId=snapshot-stale');
    assert.equal(stale.response.status, 409);
    assert.deepEqual(stale.body, { error: 'model inventory changed; retry' });
    assert.equal(reads, 5);
  } finally {
    await server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('authenticated /api/models allowlists adversarial cached and empty envelopes', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-model-dashboard-private-envelope-'));
  const cached = payload();
  cached.privateDebug = 'http-private-deployment';
  cached.history[0].privatePath = '/http/secret/history';
  cached.comparison.privateProvider = 'http-private-provider';
  let provided = cached;
  const server = await startDashboard({
    cwd, port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: {}, modelScopeKey: KEY, models: async () => provided,
    discoverProjects: () => [], machineWideIntel: () => ({}),
  });
  const get = async () => {
    const response = await fetch(`${server.url}api/models`, {
      headers: { 'x-dash-token': server.token },
    });
    return { response, body: await response.json() };
  };
  try {
    const full = await get();
    assert.equal(full.response.status, 200);
    const fullWire = JSON.stringify(full.body);
    for (const secret of [
      'http-private-deployment', '/http/secret/history', 'http-private-provider',
    ]) assert.equal(fullWire.includes(secret), false, secret);

    provided = {
      status: 'empty', snapshot: null, history: [], hint: 'http-private-hint',
      privateDebug: 'http-empty-private-deployment',
    };
    const empty = await get();
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.body, {
      status: 'empty', snapshot: null, history: [], hint: 'ak models refresh',
    });
  } finally {
    await server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
