import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_BINDINGS,
  HOST_REGISTRY,
  PROVIDER_REGISTRY,
  resolveBinding,
} from '../../src/lib/adapters/index.mjs';

const provider = (id) => PROVIDER_REGISTRY.find((entry) => entry.id === id);

test('Ollama is one local provider with truthful bounded capabilities', () => {
  const ollama = provider('ollama');
  assert.ok(ollama);
  assert.equal(ollama.billing, 'local');
  assert.deepEqual(ollama.credentials, { kind: 'none' });
  assert.equal(ollama.capabilities.modelDiscovery, true);
  assert.equal(ollama.capabilities.runtimeDiscovery, true);
  assert.equal(ollama.capabilities.pricing, 'zero');
  assert.equal(ollama.capabilities.quota, false);
  assert.equal(ollama.capabilities.cacheAccounting, 'unknown');
});

test('Ollama has independent Claude and Codex bindings to the same provider', () => {
  const claude = resolveBinding(BUILTIN_BINDINGS, { host: 'claude', provider: 'ollama' });
  const codex = resolveBinding(BUILTIN_BINDINGS, { host: 'codex', provider: 'ollama' });
  assert.ok(claude);
  assert.ok(codex);
  assert.notEqual(claude.id, codex.id);
  assert.equal(claude.transport, 'anthropic-compatible');
  assert.equal(codex.transport, 'openai-compatible');
  assert.equal(claude.endpoint, 'http://127.0.0.1:11434');
  assert.equal(codex.endpoint, 'http://127.0.0.1:11434/v1/');
  assert.equal(claude.managedBy, 'external');
  assert.equal(codex.managedBy, 'external');
});

test('removing one Ollama binding does not alter or disable the other', () => {
  const withoutClaude = BUILTIN_BINDINGS.filter(({ id }) => id !== 'ollama-via-claude');
  assert.equal(resolveBinding(withoutClaude, { host: 'claude', provider: 'ollama' }), null);
  assert.equal(resolveBinding(withoutClaude, { host: 'codex', provider: 'ollama' }).id,
    'ollama-via-codex');
});

test('OpenRouter is a provider only and never becomes a transcript or routing host', () => {
  const openrouter = provider('openrouter');
  assert.ok(openrouter);
  assert.equal(openrouter.billing, 'metered');
  assert.equal(HOST_REGISTRY.some(({ id }) => id === 'openrouter'), false);
  assert.equal(BUILTIN_BINDINGS.some(({ host }) => host === 'openrouter'), false);
  assert.deepEqual(openrouter.transports, ['openai-compatible']);
  assert.equal(openrouter.capabilities.pricing, 'dated-offline');
});

test('OpenRouter identity stores only an environment variable name', () => {
  const openrouter = provider('openrouter');
  assert.deepEqual(openrouter.credentials, {
    kind: 'environment',
    env: ['OPENROUTER_API_KEY'],
  });
  const serialized = JSON.stringify(openrouter);
  assert.equal(serialized.includes('sk-or-'), false);
  assert.equal(serialized.includes('apiKey'), false);
});

test('OpenRouter observability is provider evidence, not host evidence', () => {
  const openrouter = provider('openrouter');
  assert.deepEqual(openrouter.observability, ['openrouter-metadata']);
  for (const host of HOST_REGISTRY) {
    assert.equal(host.observability.includes('openrouter-metadata'), false);
  }
});
