import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaude } from '../../src/lib/model-inventory/discovery/claude.mjs';
import { discoverCodex } from '../../src/lib/model-inventory/discovery/codex.mjs';
import {
  ANTHROPIC_PUBLIC_MODELS, discoverAnthropicPublicCatalog,
} from '../../src/lib/model-inventory/discovery/anthropic-catalog.mjs';
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
  assert.equal(selected.edges.some(({ kind, from, to }) =>
    kind === 'resolves-to' && from === 'sonnet' && to === 'claude-sonnet-5-20260801'), true);
  assert.equal(result.models.find((model) => model.identity.modelId === 'claude-opus-5').states.policyAllowed, true);
  assert.doesNotThrow(() => result.models.map(normalizeModelRecord));
  assert.doesNotThrow(() => normalizeSourceResult(result.source));
});

test('Claude keeps the 1M selector as a variant instead of a duplicate base model', () => {
  const result = discoverClaude({
    settingsRaw: JSON.stringify({ model: 'claude-fable-5[1m]' }),
    capturedAt: '2026-08-25T13:00:00.000Z', scopeKey: SCOPE_KEY,
  });
  assert.equal(result.models.some(({ key }) => key.modelId.endsWith('[1m]')), false);
  const configured = result.models.find((model) =>
    model.key.modelId === 'claude-fable-5' && model.dimensions.configured.value === true);
  assert.equal(configured.variant.contextWindow, 1_000_000);
  assert.equal(configured.aliases.some(({ name, resolvesTo }) =>
    name === 'claude-fable-5[1m]' && resolvesTo === 'claude-fable-5'), true);
  assert.equal(configured.evidence.every(({ refs }) => refs.includes(
    'https://code.claude.com/docs/en/model-config')), true);
  assert.doesNotThrow(() => result.models.map(normalizeModelRecord));
});

test('Claude public facts retain first-party lifecycle, discovery, limits, and scope', () => {
  const result = discoverAnthropicPublicCatalog({
    capturedAt: '2026-09-02T13:00:00.000Z', scope: { profile: 'default' }, scopeKey: SCOPE_KEY,
  });
  assert.equal(result.source.id, 'anthropic-docs');
  assert.equal(result.source.ownerType, 'provider');
  assert.equal(result.source.sourceVersion, '2026-09-02');
  assert.equal(result.models.length, ANTHROPIC_PUBLIC_MODELS.length);

  const fable = result.models.find((model) => model.identity.modelId === 'claude-fable-5');
  assert.equal(fable.lifecycle.state, 'active');
  assert.equal(fable.dimensions.discoverable.value, true);
  assert.equal(fable.dimensions.entitled.value, null);
  assert.equal(fable.dimensions.routable.value, null);
  assert.equal(fable.capabilities.contextLimit, 1_000_000);
  assert.equal(fable.capabilities.outputLimit, 128_000);
  assert.equal(fable.evidence.every(({ source, class: klass, refs }) =>
    source === 'anthropic-docs' && klass === 'first-party'
      && refs.some((ref) => ref.startsWith('https://platform.claude.com/'))), true);
  assert.deepEqual(fable.evidence.find(({ field }) => field === 'pricing').refs,
    ['https://platform.claude.com/docs/en/about-claude/pricing']);
  assert.deepEqual(fable.evidence.find(({ field }) => field === 'lifecycle').refs,
    ['https://platform.claude.com/docs/en/about-claude/model-deprecations']);
  assert.deepEqual(fable.evidence.find(({ field }) => field === 'capabilities.outputLimit').refs,
    ['https://platform.claude.com/docs/en/build-with-claude/context-windows']);

  const mythosPreview = result.models.find((model) =>
    model.identity.modelId === 'claude-mythos-preview');
  assert.equal(mythosPreview.capabilities.contextLimit, 1_000_000);
  assert.equal(mythosPreview.capabilities.outputLimit, 128_000);
  const sonnet = result.models.find((model) => model.identity.modelId === 'claude-sonnet-4-6');
  assert.equal(sonnet.capabilities.outputLimit, 128_000);

  const retired = result.models.find((model) =>
    model.identity.modelId === 'claude-opus-4-1-20250805');
  assert.equal(retired.lifecycle.state, 'removed');
  assert.equal(retired.lifecycle.replacement, 'claude-opus-4-8');
  assert.equal(retired.lifecycle.effectiveAt, '2026-08-05T00:00:00.000Z');
  assert.equal(retired.dimensions.discoverable.value, false);
  assert.equal(retired.edges.some(({ kind, provenance }) =>
    kind === 'resolves-to' && provenance === 'first-party'), true);
  assert.doesNotThrow(() => result.models.map(normalizeModelRecord));
  assert.doesNotThrow(() => normalizeSourceResult(result.source));
});

test('Claude public facts include Fable 5.1 and Mythos 5.1 as active, priced entries', () => {
  const result = discoverAnthropicPublicCatalog({
    capturedAt: '2026-09-02T13:00:00.000Z', scopeKey: SCOPE_KEY,
  });
  const fable51 = result.models.find((model) => model.identity.modelId === 'claude-fable-5-1');
  assert.equal(fable51.lifecycle.state, 'active');
  assert.equal(fable51.dimensions.discoverable.value, true);
  assert.equal(fable51.capabilities.contextLimit, 1_000_000);
  assert.equal(fable51.capabilities.outputLimit, 128_000);
  assert.equal(fable51.pricing.basis, 'per-million-tokens');
  assert.equal(fable51.pricing.input, 10);
  assert.equal(fable51.pricing.output, 50);
  assert.equal(fable51.pricing.currency, 'USD');

  const mythos51 = result.models.find((model) => model.identity.modelId === 'claude-mythos-5-1');
  assert.equal(mythos51.lifecycle.state, 'active');
  assert.equal(mythos51.variant.availability, 'limited');
  assert.equal(mythos51.capabilities.contextLimit, 1_000_000);

  // Fable 5 stays a distinct, still-active entry — 5.1 is additive, not a rename.
  const fable5 = result.models.find((model) => model.identity.modelId === 'claude-fable-5');
  assert.equal(fable5.lifecycle.state, 'active');
});

test('Claude bundled public facts become explicitly stale instead of silently aging', () => {
  const result = discoverAnthropicPublicCatalog({
    capturedAt: '2026-12-09T00:00:00.000Z', scopeKey: SCOPE_KEY,
  });
  assert.equal(result.source.status, 'stale');
  assert.equal(result.models[0].evidence.every(({ freshness }) => freshness === 'stale'), true);
});

test('Claude rejects oversized or invalid settings as unsupported without leaking raw input', () => {
  const huge = '{"model":"' + 'x'.repeat(1_100_000) + '"}';
  for (const raw of [huge, '{not-json']) {
    const result = discoverClaude({ settingsRaw: raw, scopeKey: SCOPE_KEY });
    assert.equal(result.status, 'partial');
    assert.equal(result.source.status, 'unsupported-schema');
    assert.equal(result.sources[0].id, 'anthropic-docs');
    assert.equal(result.models.length, ANTHROPIC_PUBLIC_MODELS.length);
    assert.equal(JSON.stringify(result).includes('not-json'), false);
  }
});

test('Codex parses visibility and reasoning variants without treating a local upgrade hint as retirement evidence', () => {
  const result = discoverCodex({
    cacheRaw: fixture('codex', 'models-cache.json'),
    now: Date.parse('2026-08-25T13:00:00.000Z'), scope: { profile: 'default' }, scopeKey: SCOPE_KEY,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.models.length, 2);
  const terra = result.models.find((model) => model.identity.modelId === 'gpt-5.6-terra');
  assert.deepEqual(terra.variant.reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(terra.variant.contextWindow, 272000);
  assert.equal(terra.variant.maximumContextWindow, 872000);
  assert.equal(terra.variant.effectiveContextWindowPercent, 95);
  assert.equal(terra.variant.effectiveContextWindow, 258400);
  assert.equal(terra.variant.autoCompactTokenLimit, 240000);
  assert.equal(terra.variant.maxOutputTokens, 128000);
  assert.equal(terra.states.entitled, 'unknown');
  assert.equal(terra.states.configured, 'unknown');
  assert.equal(terra.states.observed, 'unknown');
  assert.equal(terra.dimensions.configured.value, null);
  const old = result.models.find((model) => model.identity.modelId === 'gpt-5.4');
  assert.equal(old.lifecycle.state, 'hidden');
  assert.equal(old.lifecycle.replacement, null);
  assert.equal(old.edges.some(({ kind }) => kind === 'first-party-migration'), false);
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
