import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/commands/models.mjs';

const capturedAt = '2026-08-25T13:00:00.000Z';
const snapshot = {
  schemaVersion: 1, snapshotId: 'models:test', capturedAt,
  scope: { fingerprint: 'scope:test', hosts: ['codex'] },
  sources: [{ id: 'codex-cache', owner: 'codex', status: 'complete', complete: true, capturedAt, scopeFingerprint: 'scope:test' }],
  models: [{
    key: { host: 'codex', provider: 'openai', modelId: 'gpt-x', scopeId: 'scope:host' },
    displayName: 'gpt-x', aliases: [], visibility: 'visible', variant: {},
    lifecycle: { state: 'active', replacement: null, evidenceRefs: ['ev'] }, capabilities: {},
    dimensions: Object.fromEntries(['configured', 'effective', 'observed', 'discoverable', 'entitled', 'policyAllowed', 'routable', 'recommended']
      .map((name) => [name, { value: ['configured', 'effective', 'discoverable', 'entitled', 'policyAllowed', 'routable'].includes(name) ? true : null, evidenceRefs: ['ev'] }])),
    evidence: [{ id: 'ev', field: 'catalog', source: 'codex-cache', class: 'catalog', capturedAt,
      freshness: 'fresh', completeness: 'complete', scopeFingerprint: 'scope:host', refs: [] }],
  }],
  bindings: [], changes: [], opportunities: [], diagnostics: [],
};

const cfg = { integrations: { hosts: { claude: true, codex: true, opencode: false } } };
const store = { snapshots: [snapshot], baselineByScope: { 'scope:test': snapshot.snapshotId } };

async function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { return { code: await fn(), output: lines.join('\n') }; } finally { console.log = original; }
}

test('models status is a cache-only read', async () => {
  let collected = 0;
  const result = await capture(() => run({
    flags: { json: true }, positionals: ['status'],
    deps: { loadConfig: () => cfg, readStore: () => store, collect: async () => { collected++; } },
  }));
  assert.equal(result.code, 0);
  assert.equal(collected, 0);
  assert.equal(JSON.parse(result.output).inventory.snapshotId, 'models:test');
});

test('models status host filter rejects unknown owners and narrows evidence', async () => {
  const invalid = await capture(() => run({
    flags: { json: true, host: 'unknown' }, positionals: ['status'],
    deps: { loadConfig: () => cfg, readStore: () => store },
  }));
  assert.equal(invalid.code, 2);

  const mixed = structuredClone(snapshot);
  mixed.sources.push({ ...mixed.sources[0], id: 'claude-config', owner: 'claude' });
  mixed.models.push({ ...mixed.models[0], key: { ...mixed.models[0].key, host: 'claude' } });
  const filtered = await capture(() => run({
    flags: { json: true, host: 'codex' }, positionals: ['status'],
    deps: { loadConfig: () => cfg, readStore: () => ({ ...store, snapshots: [mixed] }) },
  }));
  const value = JSON.parse(filtered.output);
  assert.deepEqual(value.inventory.sources.map(({ id }) => id), ['codex-cache']);
  assert.deepEqual(value.inventory.models.map(({ key }) => key.host), ['codex']);
});

test('models refresh dry-run contacts nothing and writes nothing', async () => {
  let collected = 0;
  let appended = 0;
  const result = await capture(() => run({
    flags: { json: true, 'dry-run': true, all: true }, positionals: ['refresh'],
    deps: {
      loadConfig: () => cfg, collect: async () => { collected++; }, append: () => { appended++; },
    },
  }));
  assert.equal(result.code, 0);
  assert.equal(collected, 0);
  assert.equal(appended, 0);
  assert.deepEqual(JSON.parse(result.output).owners, ['claude', 'codex', 'opencode', 'ollama']);
  assert.equal(JSON.parse(result.output).online, false);
});

test('online contact is reported only when OpenCode is in refresh scope', async () => {
  const codex = await capture(() => run({
    flags: { json: true, online: true, host: 'codex', 'dry-run': true }, positionals: ['refresh'],
    deps: { loadConfig: () => cfg },
  }));
  assert.equal(JSON.parse(codex.output).online, false);
  assert.equal(JSON.parse(codex.output).onlineRequested, true);
  const opencode = await capture(() => run({
    flags: { json: true, online: true, host: 'opencode', 'dry-run': true }, positionals: ['refresh'],
    deps: { loadConfig: () => cfg },
  }));
  assert.equal(JSON.parse(opencode.output).online, true);
});

test('models refresh is the sole collection and snapshot write boundary', async () => {
  let options;
  let appended;
  const result = await capture(() => run({
    flags: { json: true, online: true, host: 'codex' }, positionals: ['refresh'],
    deps: {
      loadConfig: () => cfg, readJson: () => null, aqeFile: () => '/fixture/aqe.json',
      collect: async (value) => { options = value; return snapshot; },
      append: (value) => { appended = value; return store; },
    },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(options.discoveryOptions.owners, ['codex']);
  assert.equal(options.discoveryOptions.online, true);
  assert.equal(appended.snapshotId, 'models:test');
});

test('models explain and plan remain read-only', async () => {
  const explain = await capture(() => run({
    flags: { json: true }, positionals: ['explain', 'codex:gpt-x'],
    deps: { loadConfig: () => cfg, readStore: () => store },
  }));
  assert.equal(JSON.parse(explain.output).found, true);
  const plan = await capture(() => run({
    flags: { json: true, activity: 'testing', to: 'codex:gpt-x' }, positionals: ['plan'],
    deps: { loadConfig: () => cfg, readStore: () => store },
  }));
  const value = JSON.parse(plan.output);
  assert.equal(value.readOnly, true);
  assert.equal(value.action.executed, false);
});
