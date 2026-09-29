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
  const reconciled = reconcileClaudeCostState(rec, deps);
  assert.equal(reconciled.status, 'mismatch');
  assert.equal(reconciled.reportedUsd, 2);
  assert.equal(reconciled.estimatedUsd, evidence.estimatedUsd);
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
  assert.equal(reconcileClaudeCostState(mismatch, deps).status, 'scope-mismatch');
  const unknown = parse(snapshot(1, { hasUnknownModelCost: true }));
  assert.equal(reconcileClaudeCostState(unknown, deps).status, 'scope-unknown');
  const routed = parse(snapshot(1));
  routed.sessionOrigin.thirdPartyProvider = 'amazon-bedrock';
  assert.equal(reconcileClaudeCostState(routed, deps).status, 'scope-unknown');
});

test('matching amount and exact model/token scope reports matched', () => {
  const amount = costOf({ model: 'claude-opus-5', day: '2026-09-28', input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  assert.equal(reconcileClaudeCostState(parse(snapshot(amount)), deps).status, 'matched');
});

test('aggregate and session detail expose reconciliation without adding the snapshot to totals', () => {
  const rec = parse(snapshot(2));
  const now = Date.parse('2026-09-29T00:00:00Z');
  const agg = aggregate([rec], { days: 7, now, cutoff: now - 7 * 86400000, deps });
  const messageCost = sessionCostEvidence(rec, deps).estimatedUsd;
  assert.equal(agg.sessions[0].cost, messageCost);
  assert.equal(agg.totals.cost, messageCost);
  assert.equal(agg.sessions[0].claudeCostState.status, 'mismatch');
  assert.equal(agg.sessions[0].claudeCostState.reportedUsd, 2);
  assert.equal(sessionPayload(rec, [], deps).meta.claudeCostState.status, 'mismatch');
});

test('schema 26 cold and warm cache reads retain the checkpoint diagnostic', async () => {
  assert.equal(SCHEMA_VERSION, 26);
  const root = tempDir('ak-claude-cost-state');
  const project = path.join(root, 'claude', 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 's1.jsonl'), [assistant, snapshot(2)].join('\n'));
  const options = {
    days: 7, now: Date.parse('2026-09-29T00:00:00Z'),
    roots: { claude: path.join(root, 'claude'), codex: path.join(root, 'codex') },
    cachePath: path.join(root, 'cache', 'usage-index.json'), deps,
  };
  _resetForTest();
  const cold = await buildIndex(options);
  const cache = JSON.parse(fs.readFileSync(options.cachePath, 'utf8'));
  for (const entry of Object.values(cache.entries)) delete entry.session.claudeCostState;
  fs.writeFileSync(options.cachePath, JSON.stringify(cache));
  _resetForTest();
  const reparsed = await buildIndex(options);
  assert.equal(reparsed.sessions[0].claudeCostState.status, 'mismatch');
  _resetForTest();
  const warm = await buildIndex(options);
  assert.deepEqual(warm.sessions[0].claudeCostState, cold.sessions[0].claudeCostState);
  assert.equal(warm.sessions[0].claudeCostState.status, 'mismatch');
  assert.equal(warm.totals.cost, cold.totals.cost);
});
