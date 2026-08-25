import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOpenCode, discoverOpenCode } from '../../src/lib/model-inventory/discovery/opencode.mjs';
import { collectOllama, discoverOllama } from '../../src/lib/model-inventory/discovery/ollama.mjs';
import { DISCOVERY_DISPATCH, discoverModels } from '../../src/lib/model-inventory/discovery/index.mjs';
import { normalizeModelRecord, normalizeSourceResult } from '../../src/lib/model-inventory/contracts.mjs';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/model-inventory');
const fixture = (...parts) => fs.readFileSync(path.join(FIX, ...parts), 'utf8');
const SCOPE_KEY = '0123456789abcdef0123456789abcdef';

test('OpenCode normalizes provider-qualified ids in project scope', () => {
  const result = discoverOpenCode({ raw: fixture('opencode', 'models.txt'), scope: { project: '/private/repo' }, scopeKey: SCOPE_KEY });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.models.map((model) => [model.identity.provider, model.identity.modelId]), [
    ['anthropic', 'claude-sonnet-5'], ['openrouter', 'z-ai/glm-5'],
  ]);
  assert.equal(JSON.stringify(result).includes('/private/repo'), false);
  assert.equal(result.models.every((model) => model.states.entitled === 'unknown'), true);
  assert.doesNotThrow(() => result.models.map(normalizeModelRecord));
  assert.doesNotThrow(() => normalizeSourceResult(result.source));
});

test('OpenCode preserves configured global and agent model evidence', () => {
  const result = discoverOpenCode({
    raw: 'anthropic/claude-sonnet-5\n', scopeKey: SCOPE_KEY,
    configRaw: JSON.stringify({ model: 'openrouter/z-ai/glm-5', agent: { review: { model: 'anthropic/claude-opus-5' } } }),
  });
  assert.equal(result.models.find((model) => model.displayName === 'openrouter/z-ai/glm-5').states.effective, true);
  assert.equal(result.models.find((model) => model.displayName === 'anthropic/claude-opus-5').states.configured, true);
  assert.equal(result.models.find((model) => model.displayName === 'anthropic/claude-opus-5').states.discoverable, 'unknown');
});

test('OpenCode reads resolved root, agent, and command model configuration', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'debug') return { code: 0, stdout: JSON.stringify({
      model: 'openrouter/z-ai/glm-5',
      agent: { review: { model: 'anthropic/claude-opus-5' } },
      command: { audit: { model: 'openai/gpt-5.6-sol#high' } },
    }), stderr: '' };
    return { code: 0, stdout: 'openrouter/z-ai/glm-5\n', stderr: '' };
  };
  const result = await collectOpenCode({ runner, scopeKey: SCOPE_KEY });
  assert.deepEqual(calls.map(([, args]) => args), [['debug', 'config'], ['models', '--verbose']]);
  assert.equal(result.models.find(({ identity }) => identity.modelId === 'z-ai/glm-5').states.effective, true);
  assert.equal(result.models.find(({ identity }) => identity.modelId === 'claude-opus-5').states.configured, true);
  assert.deepEqual(result.models.find(({ identity }) => identity.modelId === 'gpt-5.6-sol').variant.configuredVariants, ['high']);
});

test('OpenCode accepts current object selectors and optional configured variants', () => {
  const result = discoverOpenCode({
    raw: '', scopeKey: SCOPE_KEY,
    configRaw: { model: { providerID: 'openai', model: 'gpt-5.6-terra' },
      agent: { review: { model: 'openai/gpt-5.6-sol#high' } } },
  });
  assert.equal(result.models.find((model) => model.identity.modelId === 'gpt-5.6-terra').states.effective, true);
  assert.deepEqual(result.models.find((model) => model.identity.modelId === 'gpt-5.6-sol').variant.configuredVariants, ['high']);
});

test('OpenCode accepts current OpenRouter tilde selectors', () => {
  const result = discoverOpenCode({
    raw: 'openrouter/~anthropic/claude-sonnet-latest\n', scopeKey: SCOPE_KEY,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.models.map((model) => [model.identity.provider, model.identity.modelId]), [
    ['openrouter', '~anthropic/claude-sonnet-latest'],
  ]);
});

test('OpenCode parses verbose catalog metadata into bounded public fields only', () => {
  const result = discoverOpenCode({
    raw: fixture('opencode', 'models-verbose.txt'),
    catalogRaw: fixture('opencode', 'modelsdev-api.json'), scopeKey: SCOPE_KEY,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.models.length, 3);
  const claude = result.models.find((model) => model.identity.modelId === '~anthropic/claude-sonnet-latest');
  assert.equal(claude.displayName, 'Anthropic Claude Sonnet Latest');
  assert.deepEqual(claude.variant.catalog, {
    source: 'models.dev',
    public: true,
    servingProvider: 'openrouter',
    publisher: null,
    family: 'claude-sonnet',
    selector: 'openrouter/~anthropic/claude-sonnet-latest',
    releaseDate: '2026-04-27',
    status: 'active',
    links: { catalog: 'https://models.dev/' },
  });
  assert.deepEqual(claude.variant.availableVariants, ['high', 'low']);
  assert.deepEqual(claude.capabilities, {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    contextLimit: 1000000,
    outputLimit: 128000,
  });
  assert.deepEqual({
    basis: claude.pricing.basis,
    input: claude.pricing.input,
    output: claude.pricing.output,
    currency: claude.pricing.currency,
    effectiveAt: claude.pricing.effectiveAt,
  }, {
    basis: 'per-million-tokens', input: 2, output: 10, currency: 'USD', effectiveAt: null,
  });
  const custom = result.models.find((model) => model.identity.provider === 'private-gateway');
  assert.deepEqual(custom.variant.catalog, {
    source: 'opencode',
    public: false,
    servingProvider: 'private-gateway',
    publisher: null,
    family: 'private-family',
    selector: 'private-gateway/deployment-42',
    releaseDate: null,
    status: 'active',
  });
  const serialized = JSON.stringify(result);
  for (const secret of ['private-gateway.example', 'must-not-persist', 'internal.example',
    'never-persist-this', 'private-tenant', '"api":', '"headers":', '"options":']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.doesNotThrow(() => result.models.map(normalizeModelRecord));
});

test('OpenCode never treats provider syntax or custom metadata as public catalog proof', () => {
  const raw = [
    'openrouter/acme/finance-secret',
    JSON.stringify({ id: 'acme/finance-secret', providerID: 'openrouter',
      name: 'Board Acquisition Model', family: 'finance' }),
  ].join('\n');
  const result = discoverOpenCode({
    raw, catalogRaw: fixture('opencode', 'modelsdev-api.json'), scopeKey: SCOPE_KEY,
  });
  const secret = result.models[0];
  assert.equal(secret.variant.catalog.public, false);
  assert.equal(secret.variant.catalog.publisher, null);
  assert.equal(secret.variant.catalog.links, undefined);
});

test('OpenCode bounds invalid-line diagnostics and accepts bounded custom string ids', () => {
  const invalid = Array.from({ length: 10_000 }, () => '!').join('\n');
  const result = discoverOpenCode({ raw: `custom provider/model with spaces ✓\n${invalid}\n`, scopeKey: SCOPE_KEY });
  assert.ok(result.diagnostics.length <= 64);
  assert.equal(result.diagnostics.at(-1).code, 'diagnostics-truncated');
  assert.equal(result.models.some(({ identity }) => identity.modelId === 'model with spaces ✓'), true);
});

test('OpenCode uses literal argv and refresh is the only online boundary', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: fixture('opencode', 'models.txt'), stderr: '' };
  };
  const catalogBody = fixture('opencode', 'modelsdev-api.json');
  const fetchFn = async () => new Response(catalogBody, {
    headers: { 'content-length': String(Buffer.byteLength(catalogBody)) },
  });
  await collectOpenCode({ runner, online: false, provider: 'x; touch /tmp/nope',
    configRaw: '{}', scopeKey: SCOPE_KEY });
  await collectOpenCode({ runner, fetchFn, online: true, provider: 'anthropic',
    configRaw: '{}', scopeKey: SCOPE_KEY });
  assert.deepEqual(calls[0].args, ['models', 'x; touch /tmp/nope', '--verbose']);
  assert.deepEqual(calls[1].args, ['models', 'anthropic', '--refresh']);
  assert.deepEqual(calls[2].args, ['models', 'anthropic', '--verbose']);
  assert.equal(calls.every((call) => call.options.shell === false), true);
});

test('Ollama parses local names and digests without claiming entitlement', () => {
  const result = discoverOllama({ raw: fixture('ollama', 'list.txt'), scopeKey: SCOPE_KEY });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.models.map((model) => model.identity.modelId), ['qwen3-coder:latest', 'deepseek-r1:8b']);
  assert.equal(result.models[0].variant.digest, '9e3f6a12abcd');
  assert.equal(result.models[0].key.digest, '9e3f6a12abcd');
  assert.equal(result.models[0].states.configured, 'unknown');
  assert.equal(result.models[0].states.entitled, 'unknown');
  assert.doesNotThrow(() => result.models.map(normalizeModelRecord));
  assert.doesNotThrow(() => normalizeSourceResult(result.source));
});

test('Ollama collector invokes ls only and caps untrusted output', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: 'x'.repeat(3_000_000), stderr: '' };
  };
  const result = await collectOllama({ runner, scopeKey: SCOPE_KEY });
  assert.deepEqual(calls[0].args, ['ls']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(result.status, 'unsupported');
});

test('dispatch map is separate from immutable registry metadata', async () => {
  assert.deepEqual(Object.keys(DISCOVERY_DISPATCH), ['claude', 'codex', 'opencode', 'ollama']);
  assert.equal(typeof DISCOVERY_DISPATCH.opencode, 'function');
  const result = await discoverModels('opencode', { raw: fixture('opencode', 'models.txt'), scopeKey: SCOPE_KEY });
  assert.equal(result.models.length, 2);
  await assert.rejects(discoverModels('unknown-host'), /unsupported model discovery owner/);
});
