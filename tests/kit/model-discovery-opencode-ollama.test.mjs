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

test('OpenCode accepts current object selectors and optional configured variants', () => {
  const result = discoverOpenCode({
    raw: '', scopeKey: SCOPE_KEY,
    configRaw: { model: { providerID: 'openai', model: 'gpt-5.6-terra' },
      agent: { review: { model: 'openai/gpt-5.6-sol#high' } } },
  });
  assert.equal(result.models.find((model) => model.identity.modelId === 'gpt-5.6-terra').states.effective, true);
  assert.deepEqual(result.models.find((model) => model.identity.modelId === 'gpt-5.6-sol').variant.configuredVariants, ['high']);
});

test('OpenCode uses literal argv and refresh is the only online boundary', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: fixture('opencode', 'models.txt'), stderr: '' };
  };
  await collectOpenCode({ runner, online: false, provider: 'x; touch /tmp/nope', scopeKey: SCOPE_KEY });
  await collectOpenCode({ runner, online: true, provider: 'anthropic', scopeKey: SCOPE_KEY });
  assert.deepEqual(calls[0].args, ['models', 'x; touch /tmp/nope']);
  assert.deepEqual(calls[1].args, ['models', 'anthropic', '--refresh']);
  assert.equal(calls.every((call) => call.options.shell === false), true);
});

test('Ollama parses local names and digests without claiming entitlement', () => {
  const result = discoverOllama({ raw: fixture('ollama', 'list.txt'), scopeKey: SCOPE_KEY });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.models.map((model) => model.identity.modelId), ['qwen3-coder:latest', 'deepseek-r1:8b']);
  assert.equal(result.models[0].variant.digest, '9e3f6a12abcd');
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
