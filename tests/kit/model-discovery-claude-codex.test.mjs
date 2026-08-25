import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaude } from '../../src/lib/model-inventory/discovery/claude.mjs';
import { discoverCodex } from '../../src/lib/model-inventory/discovery/codex.mjs';
import { normalizeModelRecord, normalizeSourceResult } from '../../src/lib/model-inventory/contracts.mjs';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/model-inventory');
const fixture = (...parts) => fs.readFileSync(path.join(FIX, ...parts), 'utf8');
const SCOPE_KEY = '0123456789abcdef0123456789abcdef';

test('Claude preserves alias and concrete resolution while entitlement stays unknown', () => {
  const result = discoverClaude({
    settingsRaw: fixture('claude', 'settings.json'),
    managedSettingsRaw: fixture('claude', 'managed-settings.json'),
    capturedAt: '2026-08-25T13:00:00.000Z', scope: { profile: 'default', project: '/private/repo' }, scopeKey: SCOPE_KEY,
  });
  assert.equal(result.status, 'complete');
  assert.match(result.source.scopeId, /^scope:[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(result).includes('/private/repo'), false);
  assert.equal(JSON.stringify(result).includes('must-never-appear'), false);
  const selected = result.models.find((model) => model.aliases.some((alias) => alias.name === 'sonnet'));
  assert.equal(selected.identity.modelId, 'claude-sonnet-5-20260801');
  assert.equal(selected.states.configured, true);
  assert.equal(selected.states.effective, true);
  assert.equal(selected.states.entitled, 'unknown');
  assert.equal(result.models.find((model) => model.identity.modelId === 'claude-opus-5').states.policyAllowed, true);
  assert.doesNotThrow(() => result.models.map(normalizeModelRecord));
  assert.doesNotThrow(() => normalizeSourceResult(result.source));
});

test('Claude rejects oversized or invalid settings as unsupported without leaking raw input', () => {
  const huge = '{"model":"' + 'x'.repeat(1_100_000) + '"}';
  for (const raw of [huge, '{not-json']) {
    const result = discoverClaude({ settingsRaw: raw, scopeKey: SCOPE_KEY });
    assert.equal(result.status, 'unsupported-schema');
    assert.deepEqual(result.models, []);
    assert.equal(JSON.stringify(result).includes('not-json'), false);
  }
});

test('Codex parses visibility, reasoning variants, and first-party migration metadata', () => {
  const result = discoverCodex({
    cacheRaw: fixture('codex', 'models-cache.json'),
    now: Date.parse('2026-08-25T13:00:00.000Z'), scope: { profile: 'default' }, scopeKey: SCOPE_KEY,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.models.length, 2);
  const terra = result.models.find((model) => model.identity.modelId === 'gpt-5.6-terra');
  assert.deepEqual(terra.variant.reasoningEfforts, ['low', 'high']);
  assert.equal(terra.variant.contextWindow, 272000);
  assert.equal(terra.states.entitled, 'unknown');
  const old = result.models.find((model) => model.identity.modelId === 'gpt-5.4');
  assert.equal(old.lifecycle.state, 'retiring');
  assert.equal(old.lifecycle.replacement, 'gpt-5.6-terra');
  assert.equal(old.states.discoverable, false);
  assert.doesNotThrow(() => result.models.map(normalizeModelRecord));
  assert.doesNotThrow(() => normalizeSourceResult(result.source));
});

test('Codex includes configured top-level model evidence without parsing unrelated TOML tables', () => {
  const result = discoverCodex({
    cacheRaw: JSON.stringify({ models: [] }), scopeKey: SCOPE_KEY,
    configRaw: 'model = "gpt-private"\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"\n[profiles.other]\nmodel = "ignored"\n',
  });
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].identity.modelId, 'gpt-private');
  assert.equal(result.models[0].identity.provider, 'openai');
  assert.equal(result.models[0].states.configured, true);
  assert.equal(result.models[0].variant.reasoningEffort, 'high');
});

test('Codex schema and enum guards degrade explicitly and never manufacture models', () => {
  const badSchema = discoverCodex({ cacheRaw: JSON.stringify({ models: 'all' }), scopeKey: SCOPE_KEY });
  assert.equal(badSchema.status, 'unsupported-schema');
  assert.match(badSchema.diagnostics[0].code, /schema/);
  const badEnum = discoverCodex({ cacheRaw: JSON.stringify({ models: [{ slug: 'gpt-x', visibility: 'maybe' }] }), scopeKey: SCOPE_KEY });
  assert.equal(badEnum.status, 'partial');
  assert.deepEqual(badEnum.models, []);
  assert.equal(badEnum.source.complete, false);
});
