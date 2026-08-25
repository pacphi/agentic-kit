import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDashboardModelPayload, createDashboardModelViewPayload,
} from '../../src/lib/model-inventory/read-model.mjs';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';

const AT = '2026-08-25T12:00:00.000Z';
const KEY = 'cd'.repeat(32);

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

test('privacy projection exposes only evidence-backed public catalog identity and trusted links', () => {
  const result = createDashboardModelPayload(payload(), { key: KEY });
  const [codex, opencode, privateCodex, customOpenCode, , claude, privateClaude] = result.snapshot.models;

  assert.deepEqual({
    displayName: codex.displayName, humanName: codex.humanName, selector: codex.selector,
    servingProvider: codex.servingProvider, publisher: codex.publisher, privacyClass: codex.privacyClass,
  }, {
    displayName: 'GPT-5.6 Codex', humanName: 'GPT-5.6 Codex', selector: 'gpt-5.6-codex',
    servingProvider: null, publisher: 'OpenAI', privacyClass: 'public-catalog',
  });
  assert.deepEqual({
    displayName: opencode.displayName, selector: opencode.selector,
    servingProvider: opencode.servingProvider, publisher: opencode.publisher, family: opencode.family,
  }, {
    displayName: 'Anthropic Claude Sonnet Latest', selector: 'openrouter/~anthropic/claude-sonnet-latest',
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
    replacement: 'gpt-5.7-codex', replacementName: 'GPT-5.7 Codex',
    replacementSelector: 'gpt-5.7-codex',
  });

  const wire = JSON.stringify([privateCodex, customOpenCode, privateClaude]);
  for (const secret of ['private-provider', 'private-deployment', 'Acme Secret Model',
    'custom-private', 'secret/model', 'Secret Model', 'private-gateway',
    'claude-private-acme', 'Acme Claude Gateway']) assert.equal(wire.includes(secret), false, secret);
  for (const item of [privateCodex, customOpenCode, privateClaude]) {
    assert.equal(item.privacyClass, 'private');
    assert.equal(item.humanName, null);
    assert.equal(item.selector, null);
    assert.equal(item.servingProvider, null);
    assert.match(item.displayName, /^model-[a-f0-9]{12}$/);
  }

  const datedInput = payload();
  datedInput.snapshot.models[5].key.modelId = 'claude-haiku-4-5-20251001';
  datedInput.snapshot.models[5].displayName = 'claude-haiku-4-5-20251001';
  const dated = createDashboardModelPayload(datedInput, { key: KEY }).snapshot.models[5];
  assert.equal(dated.displayName, 'Claude Haiku 4.5 (2025-10-01)');

  const gatewayInput = payload();
  gatewayInput.snapshot.models[5].key.provider = 'private-gateway';
  const gatewayOfficial = createDashboardModelPayload(gatewayInput, { key: KEY }).snapshot.models[5];
  assert.equal(gatewayOfficial.publisher, 'Anthropic');
  assert.equal(gatewayOfficial.servingProvider, null);

  const privateLookingOfficial = payload();
  privateLookingOfficial.snapshot.models.push(model({
    host: 'claude', provider: 'private-gateway', id: 'claude-sonnet-private-acme',
    name: 'Claude Secret Acquisition', source: 'claude-config',
    values: { configured: true, effective: true },
  }));
  privateLookingOfficial.snapshot.models[3].variant.configuredVariants = ['private-prod'];
  const privateProjection = createDashboardModelPayload(privateLookingOfficial, { key: KEY });
  const serializedPrivate = JSON.stringify(privateProjection);
  for (const secret of ['claude-sonnet-private-acme', 'Claude Secret Acquisition', 'private-prod']) {
    assert.equal(serializedPrivate.includes(secret), false, secret);
  }
  assert.equal(privateProjection.snapshot.models.at(-1).privacyClass, 'private');
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
  assert.deepEqual(result.inventory.facets.hosts, ['claude', 'codex', 'ollama', 'opencode']);
  assert.deepEqual(result.inventory.facets.providers, ['anthropic', 'openrouter']);
  assert.deepEqual(result.inventory.facets.publishers, ['Anthropic', 'OpenAI']);
  assert.deepEqual(result.inventory.facets.lifecycles, ['active', 'retiring']);
  assert.equal(result.snapshot.snapshotId.startsWith('snapshot-'), true);
  const names = result.inventory.items.map(({ displayName }) => displayName);
  assert.deepEqual(names.slice(0, 2), ['Claude Sonnet 4.6', 'GPT-5.6 Codex']);
  assert.equal(names.slice(2).every((name) => /^model-[a-f0-9]{12}$/.test(name)), true);
});

test('inventory filtering and sorting use only projected fields and keep unknown last both directions', () => {
  const publicOnly = createDashboardModelViewPayload(payload(), {
    key: KEY,
    query: new URLSearchParams('view=inventory&relevance=all&provider=openrouter&publisher=Anthropic&search=sonnet'),
  });
  assert.equal(publicOnly.inventory.filteredTotal, 1);
  assert.equal(publicOnly.inventory.items[0].selector, 'openrouter/~anthropic/claude-sonnet-latest');

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
  const server = await startDashboard({
    cwd, port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: {}, modelScopeKey: KEY, models: async () => { reads++; return payload(); },
    discoverProjects: () => [], machineWideIntel: () => ({}),
  });
  const get = async (suffix) => {
    const response = await fetch(`${server.url}api/models${suffix}`, {
      headers: { 'x-dash-token': server.token },
    });
    return { response, body: await response.json() };
  };
  try {
    const summary = await get('?view=summary');
    assert.equal(summary.response.status, 200);
    assert.equal('models' in summary.body.snapshot, false);
    assert.equal(summary.response.headers.get('cache-control'), 'no-store');

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
    assert.equal(reads, 4);
  } finally {
    await server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
