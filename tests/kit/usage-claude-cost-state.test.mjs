import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../../src/lib/usage-parsers.mjs';
import { sessionCostEvidence, reconcileClaudeCostState } from '../../src/lib/usage-cost.mjs';
import { costOf } from '../../src/lib/pricing.mjs';
import { aggregate, sessionPayload } from '../../src/lib/usage-aggregate.mjs';
import { buildIndex, SCHEMA_VERSION, _resetForTest } from '../../src/lib/usage-index.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import fs from 'node:fs';
import path from 'node:path';

const line = (value) => JSON.stringify(value);
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
const assistant = line({ type: 'assistant', timestamp: '2026-09-28T12:00:00Z', message: {
  id: 'm1', role: 'assistant', model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'ok' }],
} });
const snapshot = (totalCostUSD, overrides = {}) => line({
  type: 'cost-state', sessionId: 's1', totalCostUSD, startTime: Date.parse('2026-09-28T11:00:00Z'),
  modelUsage: { 'claude-opus-5': {
    inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40,
    thinkingTokens: 0, webSearchRequests: 0, costUSD: totalCostUSD,
  } }, hasUnknownModelCost: false, ...overrides,
});
const parse = (...records) => parseClaude([assistant, ...records].join('\n'), { id: 's1' }).session;
const deps = { costOf, classify: () => ({ category: 'Unclassified', confidence: 0, basis: 'test' }), detectInsights: () => [] };

test('latest valid cumulative snapshot remains separate from message cost', () => {
  const rec = parse(snapshot(1), snapshot(2));
  assert.equal(rec.claudeCostState.reportedUsd, 2);
  assert.equal(rec.claudeCostState.currency, 'USD');
  assert.equal(rec.claudeCostState.provenance, 'claude-code-cost-state');
  assert.equal(rec.claudeCostState.validSnapshots, 2);
  assert.equal(rec.claudeCostState.coverage, 'session-cumulative');
  const evidence = sessionCostEvidence(rec, deps);
  assert.equal(evidence.estimatedUsd, costOf({ model: 'claude-opus-5', day: '2026-09-28', input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }));
  const reconciled = reconcileClaudeCostState(rec);
  assert.equal(reconciled.status, 'scope-unknown');
  assert.equal(reconciled.reportedUsd, 2);
  assert.equal(reconciled.estimatedUsd, null);
  assert.equal(reconciled.checkpointStartMs, Date.parse('2026-09-28T11:00:00Z'));
  assert.equal(reconciled.checkpointEndMs, null);
  assert.equal(reconciled.messageFirstAtMs, Date.parse('2026-09-28T12:00:00Z'));
  assert.equal(reconciled.messageLastAtMs, Date.parse('2026-09-28T12:00:00Z'));
});

test('malformed and unsupported later checkpoints cannot replace latest valid', () => {
  const rec = parse(snapshot(1), snapshot(-1), snapshot('2'),
    line({ type: 'cost-state', sessionId: 's1', futureCost: 3 }), snapshot(4, { sessionId: 'other' }));
  assert.equal(rec.claudeCostState.reportedUsd, 1);
  assert.equal(rec.claudeCostState.validSnapshots, 1);
  assert.equal(rec.claudeCostState.malformedSnapshots, 2);
  assert.equal(rec.claudeCostState.unsupportedSnapshots, 2);
});

test('scope mismatch or unknown model prevents a cost equality claim', () => {
  const mismatch = parse(snapshot(1, { modelUsage: { 'claude-opus-5': {
    inputTokens: 11, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40,
    webSearchRequests: 0, costUSD: 1,
  } } }));
  assert.deepEqual(reconcileClaudeCostState(mismatch).scopeReasons, ['model-token-totals-differ']);
  const unknown = parse(snapshot(1, { hasUnknownModelCost: true }));
  assert.equal(reconcileClaudeCostState(unknown).status, 'scope-unknown');
  const routed = parse(snapshot(1));
  routed.sessionOrigin.thirdPartyProvider = 'amazon-bedrock';
  assert.equal(reconcileClaudeCostState(routed).status, 'scope-unknown');
});

test('matching amount and exact model/token totals do not attest time or provider scope', () => {
  const amount = costOf({ model: 'claude-opus-5', day: '2026-09-28', input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  const rec = parse(snapshot(amount));
  assert.equal(rec.providerProvenance, 'unknown');
  assert.ok(reconcileClaudeCostState(rec).scopeReasons.includes('serving-provider-unverified'));
  rec.inferenceProvider = 'amazon-bedrock';
  rec.providerProvenance = 'observed';
  assert.ok(reconcileClaudeCostState(rec).scopeReasons.includes('serving-provider-different'));
});

test('a Bedrock assistant model is provider evidence, not an Anthropic serving attestation', () => {
  const model = 'us.anthropic.claude-sonnet-4-6';
  const message = JSON.parse(assistant);
  message.message.model = model;
  const state = JSON.parse(snapshot(1));
  state.modelUsage = { [model]: state.modelUsage['claude-opus-5'] };
  const rec = parseClaude([line(message), line(state)].join('\n'), { id: 's1' }).session;
  assert.equal(rec.sessionOrigin.thirdPartyProvider, 'amazon-bedrock');
  assert.ok(reconcileClaudeCostState(rec).scopeReasons.includes('serving-provider-different'));
});

test('missing and malformed start times stay diagnostic without replacing a valid checkpoint', () => {
  const rec = parse(snapshot(1), snapshot(2, { startTime: undefined }),
    snapshot(3, { startTime: 'bad' }), snapshot(4, { startTime: 1_780_000_000 }));
  assert.equal(rec.claudeCostState.reportedUsd, 1);
  assert.equal(rec.claudeCostState.malformedSnapshots, 3);
  assert.equal(reconcileClaudeCostState(rec).status, 'scope-unknown');
});

test('checkpoint starting after a charged message has mismatched time scope', () => {
  const rec = parse(snapshot(1, { startTime: Date.parse('2026-09-28T12:01:00Z') }));
  assert.equal(rec.claudeMessageCoverage.firstAtMs, Date.parse('2026-09-28T12:00:00Z'));
  assert.deepEqual(reconcileClaudeCostState(rec).scopeReasons, ['checkpoint-start-after-message']);
});

test('an earlier zero-token assistant does not widen charged-message time coverage', () => {
  const zero = JSON.parse(assistant);
  zero.timestamp = '2026-09-28T11:00:00Z';
  zero.message.id = 'zero';
  zero.message.usage = { input_tokens: 0, output_tokens: 0 };
  const rec = parseClaude([line(zero), assistant,
    snapshot(1, { startTime: Date.parse('2026-09-28T11:30:00Z') })].join('\n'), { id: 's1' }).session;
  assert.equal(rec.claudeMessageCoverage.firstAtMs, Date.parse('2026-09-28T12:00:00Z'));
  assert.equal(reconcileClaudeCostState(rec).status, 'scope-unknown');
});

test('overlong model keys remain diagnostic and never enter the cache', () => {
  const allowedModel = 'a'.repeat(100);
  const longModel = 'a'.repeat(101);
  const counts = {
    inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40,
    webSearchRequests: 0, costUSD: 2,
  };
  const rec = parse(snapshot(1, { modelUsage: { [allowedModel]: counts } }),
    snapshot(2, { modelUsage: { [longModel]: counts } }));
  assert.equal(rec.claudeCostState.reportedUsd, 1);
  assert.equal(rec.claudeCostState.malformedSnapshots, 1);
  assert.equal(Object.keys(rec.claudeCostState.modelUsage)[0], allowedModel);
  assert.equal(JSON.stringify(rec).includes(longModel), false);
});

test('aggregate and session detail expose reconciliation without adding the snapshot to totals', () => {
  const rec = parse(snapshot(2));
  const now = Date.parse('2026-09-29T00:00:00Z');
  const agg = aggregate([rec], { days: 7, now, cutoff: now - 7 * 86400000, deps });
  const messageCost = sessionCostEvidence(rec, deps).estimatedUsd;
  assert.equal(agg.sessions[0].cost, messageCost);
  assert.equal(agg.totals.cost, messageCost);
  assert.equal(agg.sessions[0].claudeCostState.status, 'scope-unknown');
  assert.equal(agg.sessions[0].claudeCostState.reportedUsd, 2);
  assert.equal(sessionPayload(rec, [], deps).meta.claudeCostState.status, 'scope-unknown');
});

test('schema 26 cold and warm cache reads retain the checkpoint diagnostic', async () => {
  assert.equal(SCHEMA_VERSION, 26);
  const root = tempDir('ak-claude-cost-state');
  const project = path.join(root, 'claude', 'project');
  fs.mkdirSync(project, { recursive: true });
  const overlongModel = 'a'.repeat(101);
  const invalid = JSON.parse(snapshot(3));
  invalid.modelUsage = { [overlongModel]: invalid.modelUsage['claude-opus-5'] };
  fs.writeFileSync(path.join(project, 's1.jsonl'), [assistant, snapshot(2), line(invalid)].join('\n'));
  const options = {
    days: 7, now: Date.parse('2026-09-29T00:00:00Z'),
    roots: { claude: path.join(root, 'claude'), codex: path.join(root, 'codex') },
    cachePath: path.join(root, 'cache', 'usage-index.json'), deps,
  };
  _resetForTest();
  const cold = await buildIndex(options);
  assert.equal(cold.sessions[0].claudeCostState.malformedSnapshots, 1);
  assert.equal(fs.readFileSync(options.cachePath, 'utf8').includes(overlongModel), false);
  const cache = JSON.parse(fs.readFileSync(options.cachePath, 'utf8'));
  for (const entry of Object.values(cache.entries)) {
    delete entry.session.claudeCostState.startMs;
    delete entry.session.claudeCostState.endMs;
    delete entry.session.claudeMessageCoverage;
  }
  fs.writeFileSync(options.cachePath, JSON.stringify(cache));
  _resetForTest();
  const reparsed = await buildIndex(options);
  assert.equal(reparsed.sessions[0].claudeCostState.status, 'scope-unknown');
  _resetForTest();
  const warm = await buildIndex(options);
  assert.deepEqual(warm.sessions[0].claudeCostState, cold.sessions[0].claudeCostState);
  assert.equal(warm.sessions[0].claudeCostState.status, 'scope-unknown');
  assert.equal(warm.totals.cost, cold.totals.cost);
});
