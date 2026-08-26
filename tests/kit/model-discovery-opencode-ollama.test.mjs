import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOpenCode, discoverOpenCode } from '../../src/lib/model-inventory/discovery/opencode.mjs';
import {
  collectOllama, discoverOllama, discoverOllamaApi,
} from '../../src/lib/model-inventory/discovery/ollama.mjs';
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
  assert.equal(claude.lifecycle.state, 'active');
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

test('OpenCode accepts a production-sized verbose listing within byte and record bounds', () => {
  const raw = Array.from({ length: 402 }, (_, index) => {
    const id = `lab/model-${index}`;
    return [
      `openrouter/${id}`,
      JSON.stringify({
        id,
        providerID: 'openrouter',
        name: `Model ${index}`,
        status: 'active',
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: true },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
        },
        limit: { context: 200_000, output: 100_000 },
      }, null, 2),
    ].join('\n');
  }).join('\n');
  assert.ok(raw.split(/\r?\n/).length > 8_192);
  assert.ok(Buffer.byteLength(raw) < 2 * 1024 * 1024);

  const result = discoverOpenCode({ raw, scopeKey: SCOPE_KEY });
  assert.equal(result.status, 'complete');
  assert.equal(result.models.length, 402);
  assert.equal(result.models.at(-1).identity.modelId, 'lab/model-401');
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

test('OpenCode reports malformed and unsupported HTTP-200 catalogues as partial proof', async () => {
  for (const catalogBody of [
    '<html>not json</html>',
    JSON.stringify({ openrouter: { id: 'renamed-provider', models: {} } }),
  ]) {
    const runner = async (_command, args) => ({
      code: 0,
      stdout: args.includes('--verbose') ? fixture('opencode', 'models-verbose.txt') : '',
      stderr: '',
    });
    const result = await collectOpenCode({
      runner,
      fetchFn: async () => new Response(catalogBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      online: true,
      configRaw: '{}',
      scopeKey: SCOPE_KEY,
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.diagnostics.some(({ code }) => code === 'catalog-proof-invalid'), true);
  }
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

test('Ollama API joins installed, bounded details, and loaded runtime evidence without claiming use', () => {
  const result = discoverOllamaApi({
    scopeKey: SCOPE_KEY,
    tagsRaw: { models: [{ name: 'qwen3-coder:latest', digest: 'sha256:9e3f6a12abcd', size: 18_000,
      modified_at: '2026-08-24T10:00:00Z', details: { format: 'gguf', family: 'qwen3', families: ['qwen3'],
        parameter_size: '30.5B', quantization_level: 'Q4_K_M' } }] },
    psRaw: { models: [{ name: 'qwen3-coder:latest', size: 12_000, size_vram: 8_000,
      context_length: 32_768, expires_at: '2026-08-25T14:00:00Z' }] },
    showByModel: { 'qwen3-coder:latest': { license: 'Apache-2.0\nfull body omitted',
      capabilities: ['completion', 'tools', 'thinking', 'unknown-private'],
      model_info: { 'qwen3.context_length': 131_072 }, details: { family: 'qwen3' },
      template: 'PRIVATE TEMPLATE', modelfile: 'PRIVATE MODELFILE' } },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.source.schema, 'ollama-api-v1');
  assert.equal(result.source.transport, 'http');
  const [model] = result.models;
  assert.equal(model.identity.host, 'ollama');
  assert.equal(model.identity.provider, 'ollama');
  assert.deepEqual(model.variant, {
    digest: 'sha256:9e3f6a12abcd', sizeBytes: 18_000, modifiedAt: '2026-08-24T10:00:00.000Z',
    format: 'gguf', family: 'qwen3', families: ['qwen3'], parameterSize: '30.5B',
    quantizationLevel: 'Q4_K_M', loaded: true, memoryBytes: 12_000, vramBytes: 8_000,
    expiresAt: '2026-08-25T14:00:00.000Z', contextWindow: 32_768,
    licenseSummary: 'Apache-2.0', advertisedCapabilities: ['completion', 'tools', 'thinking'],
  });
  assert.deepEqual(model.capabilities, { contextLimit: 32_768, toolcall: true, reasoning: true });
  assert.equal(model.pricing.input, 0);
  assert.equal(model.dimensions.observed.value, null);
  assert.equal(model.evidence.find(({ field }) => field === 'variant.loaded').class, 'runtime');
  assert.equal(JSON.stringify(model).includes('PRIVATE TEMPLATE'), false);
  assert.equal(JSON.stringify(model).includes('PRIVATE MODELFILE'), false);
  assert.doesNotThrow(() => normalizeModelRecord(model));
  assert.doesNotThrow(() => normalizeSourceResult(result.source));
});

test('Ollama collector contacts only loopback tags, show, and runtime APIs', async () => {
  const calls = [];
  const payload = (value) => new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
  const fetchFn = async (url, options) => {
    calls.push([new URL(url).pathname, options.method, options.body]);
    if (new URL(url).pathname === '/api/tags') return payload({ models: [
      { name: 'qwen3-coder:latest', digest: '9e3f6a12abcd', details: {} },
    ] });
    if (new URL(url).pathname === '/api/ps') return payload({ models: [] });
    return payload({ capabilities: ['tools'] });
  };
  const result = await collectOllama({ fetchFn, runner: async () => assert.fail('CLI fallback ran'), scopeKey: SCOPE_KEY });
  assert.equal(result.status, 'complete');
  assert.deepEqual(calls.map(([pathname, method]) => [pathname, method]), [
    ['/api/tags', 'GET'], ['/api/ps', 'GET'], ['/api/show', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[2][2]), { model: 'qwen3-coder:latest' });
});

test('Ollama API failure falls back to bounded argv and remains partial', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: fixture('ollama', 'list.txt'), stderr: '' };
  };
  const result = await collectOllama({ fetchFn: async () => { throw new Error('offline'); }, runner, scopeKey: SCOPE_KEY });
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls[0].args, ['ls']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(result.source.diagnostics.includes('api-unavailable'), true);
  const oversized = await collectOllama({ fetchFn: async () => { throw new Error('offline'); },
    runner: async () => ({ code: 0, stdout: 'x'.repeat(3_000_000), stderr: '' }), scopeKey: SCOPE_KEY });
  assert.equal(oversized.status, 'unsupported');
  assert.equal(oversized.source.diagnostics.includes('output-too-large'), true);
});

test('Ollama collector applies one end-to-end refresh time budget', async () => {
  let runnerCalled = false;
  const fetchFn = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const started = Date.now();
  const result = await collectOllama({
    fetchFn, timeout: 25, scopeKey: SCOPE_KEY,
    runner: async () => { runnerCalled = true; return { code: 1, stdout: '', stderr: '' }; },
  });
  assert.ok(Date.now() - started < 250);
  assert.equal(runnerCalled, false);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.source.diagnostics.includes('refresh-timeout'), true);
});

test('dispatch map is separate from immutable registry metadata', async () => {
  assert.deepEqual(Object.keys(DISCOVERY_DISPATCH), ['claude', 'codex', 'opencode', 'ollama']);
  assert.equal(typeof DISCOVERY_DISPATCH.opencode, 'function');
  const result = await discoverModels('opencode', { raw: fixture('opencode', 'models.txt'), scopeKey: SCOPE_KEY });
  assert.equal(result.models.length, 2);
  await assert.rejects(discoverModels('unknown-host'), /unsupported model discovery owner/);
});
