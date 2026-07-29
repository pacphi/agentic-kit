import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIntegrationFacts,
  resolveBinding,
  validateBinding,
  assertValidBinding,
} from '../../src/lib/adapters/index.mjs';
import {
  validBinding, validRegistries,
} from './helpers/integration-builders.mjs';

test('one provider binds independently to multiple hosts', () => {
  const registries = validRegistries();
  const claude = validBinding({
    id: 'ollama-via-claude', host: 'claude', provider: 'ollama',
    transport: 'anthropic-compatible', endpoint: 'http://127.0.0.1:11434',
    model: 'qwen3.6:latest',
  });
  const codex = validBinding({
    id: 'ollama-via-codex', host: 'codex', provider: 'ollama',
    transport: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1/',
    model: 'qwen3-coder:30b',
  });
  const bindings = [claude, codex];
  assert.notEqual(bindings[0].id, bindings[1].id);
  assert.equal(bindings[0].provider, bindings[1].provider);
  assert.equal(resolveBinding(bindings, { host: 'claude', provider: 'ollama' }).id, claude.id);
  assert.equal(resolveBinding(bindings, { host: 'codex', provider: 'ollama' }).id, codex.id);
  assert.deepEqual(validateBinding(claude, registries, {
    hosts: ['claude'], providers: ['ollama'],
    transports: { ollama: ['anthropic-compatible', 'openai-compatible'] },
  }), []);
});

test('binding validation rejects dangling axes and unsupported transports', () => {
  const binding = validBinding({
    host: 'missing-host', provider: 'missing-provider', transport: 'native',
  });
  assert.deepEqual(validateBinding(binding, validRegistries()), [
    { path: 'binding.host', code: 'unknown-host', value: 'missing-host' },
    { path: 'binding.provider', code: 'unknown-provider', value: 'missing-provider' },
    { path: 'binding.transport', code: 'unsupported-transport', value: 'native' },
  ]);
});

test('strict binding validation rejects credential-bearing endpoints', () => {
  const registries = validRegistries();
  for (const endpoint of [
    'https://user:secret@inference.example.test/v1',
    'https://inference.example.test/v1#secret',
    'https://inference.example.test/v1?token=secret',
    'http://inference.example.test/v1',
  ]) {
    assert.throws(() => assertValidBinding(validBinding({ endpoint }), registries),
      /invalid endpoint/);
  }
});

test('ambiguous matching bindings remain unresolved', () => {
  const bindings = [
    validBinding({ id: 'first', endpoint: 'https://one.example.test/v1' }),
    validBinding({ id: 'second', endpoint: 'https://two.example.test/v1' }),
  ];
  assert.equal(resolveBinding(bindings, {
    host: 'test-host', provider: 'test-provider',
  }), null);
  assert.equal(resolveBinding(bindings, {
    host: 'test-host', provider: 'test-provider',
    endpoint: 'https://two.example.test/v1',
  }).id, 'second');
});

test('normalized facts keep host, provider, model, billing, and provenance separate', () => {
  const facts = normalizeIntegrationFacts({
    hosts: { claude: { present: true, enabled: true } },
    providers: { ollama: { configured: true, reachable: true, billing: 'local' } },
    bindings: [{
      host: 'claude', provider: 'ollama', model: 'qwen3.6:latest',
      provenance: 'configured', reachable: true,
    }],
  });
  assert.equal(facts.hosts.claude.present, true);
  assert.equal(facts.providers.ollama.billing, 'local');
  assert.deepEqual(facts.bindings[0], {
    host: 'claude',
    provider: 'ollama',
    model: 'qwen3.6:latest',
    billing: 'local',
    provenance: 'configured',
    reachable: true,
    pricing: 0,
    quota: null,
    cacheAccounting: null,
  });
});

test('unknown facts remain unknown rather than becoming free or subscription defaults', () => {
  const facts = normalizeIntegrationFacts({
    hosts: { claude: { present: true } },
    bindings: [{ host: 'claude', model: 'unidentified-model', provenance: 'unknown' }],
  });
  assert.deepEqual(facts.bindings[0], {
    host: 'claude',
    provider: null,
    model: 'unidentified-model',
    billing: 'unknown',
    provenance: 'unknown',
    reachable: null,
    pricing: null,
    quota: null,
    cacheAccounting: null,
  });
});

test('host transcript evidence alone cannot upgrade provider provenance to observed', () => {
  const facts = normalizeIntegrationFacts({
    hosts: { claude: { present: true } },
    bindings: [{
      host: 'claude', provider: 'ollama', provenance: 'configured',
      evidence: [{ kind: 'host-transcript', host: 'claude' }],
    }],
  });
  assert.equal(facts.bindings[0].provenance, 'configured');
});

test('observed provider evidence outranks configured and inferred evidence', () => {
  const facts = normalizeIntegrationFacts({
    bindings: [{
      host: 'codex', provider: 'openrouter', model: 'z-ai/glm-5.2',
      provenance: 'configured',
      evidence: [
        { kind: 'legacy-route', provenance: 'inferred' },
        { kind: 'provider-response', provider: 'openrouter', provenance: 'observed' },
      ],
    }],
  });
  assert.equal(facts.bindings[0].provenance, 'observed');
  assert.equal(facts.bindings[0].provider, 'openrouter');
});
