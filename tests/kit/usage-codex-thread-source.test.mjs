import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySessionSurface } from '../../src/lib/session-surface.mjs';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';
import { applyCodexLedger } from '../../src/lib/usage-aggregate.mjs';
import { rowCostEvidence } from '../../src/lib/usage-cost.mjs';
import { costOf } from '../../src/lib/pricing.mjs';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';
import { Rollout, usage, codexSandbox, stubDeps } from './helpers/codex-rollout.mjs';

test('enumerated Codex thread sources classify without guessing an unknown source', () => {
  for (const [threadSource, initiator] of [
    ['user', 'person'], ['chatgpt_handoff', 'person'], ['guardian_review', 'agent'],
    ['subagent', 'agent'], ['agent_created_thread', 'agent'], ['automation', 'automation'],
    ['future_source', 'unknown'],
  ]) {
    assert.equal(classifySessionSurface({ host: 'codex', originator: 'Codex Desktop', threadSource }).initiator,
      initiator, threadSource);
  }
  assert.equal(classifySessionSurface({ host: 'codex', originator: 'codex_exec', threadSource: 'user' }).initiator, 'automation');
  assert.equal(classifySessionSurface({ host: 'codex', originator: 'codex_cli_rs', source: 'mcp', threadSource: 'user' }).initiator, 'agent');
});

test('structured source proves parent only with the observed thread_spawn shape', () => {
  const parentId = '123e4567-e89b-42d3-a456-426614174000';
  const child = new Rollout({ id: 'child' }).meta({ originator: 'Codex Desktop', thread_source: 'subagent',
    source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } } })
    .turn('gpt-5.6-sol').agent().tokenCount(usage({ input: 100, output: 20 }));
  const parsed = parseCodex(child.toString(), { id: 'child' }).session;
  assert.equal(parsed.parentSessionId, parentId);
  assert.equal(parsed.threadSource, 'subagent');
  assert.equal(parsed.sessionOrigin.initiator, 'agent');
  assert.ok(parsed.usage.length > 0, 'own usage is retained');
  const malformed = new Rollout({ id: 'other' }).meta({ source: { subagent: { thread_spawn: { parent_thread_id: '../secret' } } } });
  assert.equal(parseCodex(malformed.toString(), { id: 'other' }).session.parentSessionId, null);
});

test('ledger backfill updates session origin and safely rolls child under its observed parent surface', () => {
  const origin = (threadSource, surface) => ({ ...classifySessionSurface({ host: 'codex',
    originator: surface === 'codex-ide' ? 'codex_vscode' : 'Codex Desktop', threadSource }),
    origin: 'unknown', evidence: 'desktop-origin-not-declared' });
  const parent = { id: 'parent', provider: 'codex', threadSource: 'user', sessionOrigin: origin('user', 'codex-ide') };
  const child = { id: 'child', provider: 'codex', threadSource: null, sessionOrigin: origin(null, 'desktop'),
    usage: [{ input: 20 }], reasoningOutput: 2 };
  const ledger = { threads: new Map([['child', { threadSource: 'guardian_review' }]]),
    parents: new Map([['child', 'parent']]) };
  const [p, c] = applyCodexLedger([parent, child], ledger);
  assert.equal(p, parent);
  assert.equal(c.threadSource, 'guardian_review');
  assert.equal(c.sessionOrigin.initiator, 'agent');
  assert.equal(c.sessionOrigin.surface, 'codex-ide');
  assert.equal(c.parentSessionId, 'parent');
  assert.deepEqual(c.usage, child.usage, 'reviewer own tokens are not stripped');
  const noParent = applyCodexLedger([child], ledger)[0];
  assert.equal(noParent.parentSessionId, null);
  assert.equal(noParent.sessionOrigin.surface, 'chatgpt-desktop-codex');
  const declared = { ...child, threadSource: 'subagent', parentSessionId: 'parent',
    sessionOrigin: origin('subagent', 'desktop') };
  assert.equal(applyCodexLedger([parent, declared], null)[1].sessionOrigin.surface, 'codex-ide',
    'first declaration supplies a parent even when the optional ledger is absent');
  const a = { ...declared, id: 'a', parentSessionId: 'b' };
  const b = { ...parent, id: 'b', threadSource: null, parentSessionId: 'a' };
  assert.equal(applyCodexLedger([a, b], null)[0].parentSessionId, null,
    'cyclic parent declarations supply no rollup evidence');
});

test('Auto-review tokens remain counted but the unpublished model is unpriced', () => {
  const row = { model: 'codex-auto-review', provider: 'openai', day: '2026-09-29',
    input: 100, output: 20, cacheRead: 0, cacheWrite: 0, responses: 1 };
  const evidence = rowCostEvidence(row, { provider: 'codex' }, { costOf });
  assert.equal(evidence.estimatedUsd, 0);
  assert.equal(evidence.unpricedMessages, 1);
  assert.equal(rowCostEvidence({ ...row, model: 'gpt-5.6-sol' }, { provider: 'codex' }, { costOf }).unpricedMessages, 0);
});

test('cold and warm aggregates retain child own usage and unpriced reviewer coverage under parent surface', async () => {
  const parentId = '123e4567-e89b-42d3-a456-426614174000';
  const childId = '123e4567-e89b-42d3-a456-426614174001';
  const reviewId = '123e4567-e89b-42d3-a456-426614174002';
  const parent = new Rollout({ id: parentId }).meta({ originator: 'codex_vscode' })
    .turn('gpt-5.6-sol').user().agent().tokenCount(usage({ input: 100, output: 20 }));
  const child = new Rollout({ id: childId }).meta({ originator: 'Codex Desktop', thread_source: 'subagent',
    source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } } })
    .turn('gpt-5.6-sol').agent().tokenCount(usage({ input: 50, output: 20 }));
  const reviewer = new Rollout({ id: reviewId }).meta({ originator: 'Codex Desktop', thread_source: 'guardian_review',
    source: { subagent: { other: 'guardian' } } })
    .turn('codex-auto-review').agent().tokenCount(usage({ input: 25, output: 5 }));
  const sb = codexSandbox({
    'rollout-2026-07-24T09-00-00-parent.jsonl': parent,
    'rollout-2026-07-24T09-01-00-child.jsonl': child,
    'rollout-2026-07-24T09-02-00-review.jsonl': reviewer,
  });
  const options = { days: 14, now: Date.parse('2026-07-25T12:00:00Z'), roots: sb.roots,
    cachePath: sb.cachePath, codexState: { threads: new Map(), parents: new Map([[reviewId, parentId]]) },
    deps: { ...stubDeps(), costOf } };
  _resetForTest();
  const cold = await buildIndex(options);
  _resetForTest();
  const warm = await buildIndex(options);
  for (const agg of [cold, warm]) {
    assert.equal(agg.totals.tokens, 220);
    assert.equal(agg.totals.humanPrompts, 1);
    assert.equal(agg.bySource.subagent.tokens, 100);
    assert.equal(agg.sessions.find((s) => s.id === childId).tokens, 70);
    const review = agg.sessions.find((s) => s.id === reviewId);
    assert.equal(review.tokens, 30);
    assert.equal(review.cost, 0);
    assert.equal(review.costEvidence.unpricedMessages, 1);
    assert.equal(review.sessionOrigin.surface, 'codex-ide');
  }
  assert.deepEqual(warm.totals, cold.totals);
  assert.deepEqual(warm.sessions.map((s) => s.sessionOrigin), cold.sessions.map((s) => s.sessionOrigin));
});
