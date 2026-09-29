import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseClaude, parseCodex } from '../../src/lib/usage-parsers.mjs';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import { Rollout } from './helpers/codex-rollout.mjs';

const line = (value) => JSON.stringify(value);
const assistant = (model, extra = {}) => line({ type: 'assistant', timestamp: '2026-09-28T10:00:00Z',
  entrypoint: 'claude-desktop-3p', ...extra,
  message: { id: `m-${model}`, role: 'assistant', model,
    usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: 'text', text: 'ok' }] } });
const parse = (...lines) => parseClaude(lines.join('\n'), { id: 'provider-fixture' }).session;

test('session-bound Bedrock and Vertex model IDs establish a separate provider detail', () => {
  for (const [model, provider] of [
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'amazon-bedrock'],
    ['anthropic.claude-haiku-4-5', 'amazon-bedrock'],
    ['anthropic.claude-opus-4-6-v1', 'amazon-bedrock'],
    ['anthropic.claude-fable-5-1', 'amazon-bedrock'],
    ['claude-sonnet-4-5@20250929', 'google-vertex-ai'],
    ['claude-sonnet-4-5@20240229', 'google-vertex-ai'],
  ]) {
    const rec = parse(assistant(model));
    assert.equal(rec.sessionOrigin.surface, 'claude-desktop');
    assert.deepEqual(rec.sessionOrigin.attributes, ['on 3P']);
    assert.equal(rec.sessionOrigin.thirdPartyProvider, provider);
    assert.equal(rec.sessionOrigin.thirdPartyProviderBasis, 'assistant-model-id');
    assert.equal(rec.inferenceProvider, null, 'existing pricing/provider axis is unchanged');
  }
});

test('ordinary models, unrelated current configuration, unknown gateways and malformed metadata stay unknown', () => {
  for (const model of ['claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5',
    'https://secret:token@private.example/model', '//private.example/model', 'claude-sonnet-4-5@bad',
    'anthropic.claude-sonnet-4-this-is-not-a-model', 'claude-sonnet-4-5@20999999',
    'claude-sonnet-4-5@20260229', 'anthropic.claude-sonnet-4-5-20260229-v1:0',
    { value: 'us.anthropic.claude-sonnet-4-5' }]) {
    const { session: rec, turns } = parseClaude(assistant(model, {
      env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://secret:token@private.example' },
      settings: { env: { CLAUDE_CODE_USE_VERTEX: '1' } },
    }), { id: 'provider-fixture', withTurns: true });
    assert.equal(rec.sessionOrigin.thirdPartyProvider, null);
    assert.equal(JSON.stringify(rec.sessionOrigin).includes('private.example'), false);
    assert.equal(JSON.stringify(rec.sessionOrigin).includes('token'), false);
    assert.equal(JSON.stringify(rec).includes('private.example'), false);
    assert.equal(JSON.stringify(rec).includes('secret:token'), false);
    assert.equal(JSON.stringify(turns).includes('private.example'), false);
  }
});

test('a local API-error placeholder cannot erase a preceding completed provider observation', () => {
  const actual = assistant('us.anthropic.claude-sonnet-4-6');
  const error = assistant('<synthetic>', { isApiErrorMessage: true });
  const rec = parse(actual, error);
  assert.equal(rec.sessionOrigin.thirdPartyProvider, 'amazon-bedrock');
  assert.equal(rec.responses, 1);
  assert.equal(rec.exceptions, 1);
  assert.deepEqual(rec.models, ['us.anthropic.claude-sonnet-4-6']);
});

test('conflicting provider-specific assistant IDs leave session provider unknown', () => {
  const rec = parse(assistant('us.anthropic.claude-sonnet-4-6'), assistant('claude-haiku-4-5@20251001'));
  assert.equal(rec.sessionOrigin.thirdPartyProvider, null);
  assert.equal(rec.sessionOrigin.thirdPartyProviderBasis, undefined);
  assert.equal(parse(assistant('us.anthropic.claude-sonnet-4-6'), assistant('claude-opus-5'))
    .sessionOrigin.thirdPartyProvider, null, 'an unmatched model may have used a different route');
});

test('imported Codex copy never inherits a Claude provider claim', () => {
  const copy = new Rollout({ id: 'copy' }).meta({ originator: 'Codex Desktop' })
    .taskStarted('external-import-turn-1').user('copy').agent('response');
  const rec = parseCodex(copy.toString(), { id: 'copy' }).session;
  assert.equal(rec.imported, true);
  assert.equal(rec.sessionOrigin.thirdPartyProvider, null);
});

test('provider detail survives the existing schema-26 cold and warm cache', async (t) => {
  _resetForTest();
  const dir = tempDir('ak-provider-', t), project = path.join(dir, 'claude', '-synthetic-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'provider-fixture.jsonl'), `${assistant('us.anthropic.claude-sonnet-4-6')}\n`);
  const options = { days: 2, now: Date.parse('2026-09-29T12:00:00Z'),
    roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
    deps: { costOf: () => 0, pricesAsOf: 'fixture', classify: () => ({ category: 'Build', confidence: 1, basis: 'fixture' }), detectInsights: () => [] } };
  const cold = await buildIndex(options);
  assert.equal(cold.sessions[0].sessionOrigin.thirdPartyProvider, 'amazon-bedrock');
  const cache = JSON.parse(fs.readFileSync(options.cachePath, 'utf8'));
  assert.equal(Object.values(cache.entries)[0].session.sessionOrigin.thirdPartyProviderBasis, 'assistant-model-id');
  _resetForTest();
  const warm = await buildIndex(options);
  assert.deepEqual(warm.sessions[0].sessionOrigin, cold.sessions[0].sessionOrigin);
});
