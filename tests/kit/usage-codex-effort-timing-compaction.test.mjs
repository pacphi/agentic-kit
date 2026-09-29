import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';
import { Rollout, usage, codexSandbox, stubDeps } from './helpers/codex-rollout.mjs';
import { forkedSubagent } from './helpers/codex-rollout.mjs';

const now = Date.parse('2026-07-25T12:00:00Z');
const compacted = { window_number: 2, replacement_history: [], latest_token_usage_record: {} };
const sample = () => new Rollout({ id: 'unit10' }).meta()
  .taskStarted('t1').turn('gpt-5.6', { effort: 'high' }).user('work')
  .tokenCount(usage({ input: 100, output: 5 }))
  .raw('event_msg', { type: 'task_complete', duration_ms: 9000, time_to_first_token_ms: 1200 })
  .raw('compacted', compacted)
  .item('ContextCompaction', { id: 'compaction-1' })
  .taskStarted('t2').turn('gpt-5.6', { effort: 'low' }).user('continue')
  .tokenCount(usage({ input: 40, output: 3 }))
  .raw('event_msg', { type: 'task_complete', duration_ms: 7000, time_to_first_token_ms: 800 });

test('native effort, measured first-token times and paired compaction reconcile without token replay', () => {
  const rec = parseCodex(String(sample()), { id: 'fallback' }).session;
  assert.deepEqual(rec.codexEffort, { last: 'low', counts: { high: 1, low: 1 } });
  assert.deepEqual(rec.firstTokenMs, { count: 2, total: 2000, min: 800, max: 1200, provenance: 'host-observed' });
  assert.equal(rec.compactions, 1);
  const a = aggregate([rec], { days: 14, now, cutoff: now - 14 * 86400000, deps: stubDeps() });
  assert.equal(a.totals.tokens, 148);
  assert.equal(a.sessions[0].compactions, 1);
  assert.deepEqual(a.sessions[0].codexEffort, rec.codexEffort);
  assert.deepEqual(a.sessions[0].firstTokenMs, rec.firstTokenMs);
  assert.equal(a.totals.compactions, 1);
  assert.deepEqual(a.totals.firstTokenMs, { count: 2, total: 2000, min: 800, max: 1200, provenance: 'host-observed' });
});

test('missing or malformed timing and unbounded effort never become measurements', () => {
  const r = new Rollout({ id: 'invalid' }).meta()
    .raw('event_msg', { type: 'task_started', turn_id: 't1', started_at: '2026-07-24T09:00:00.000Z' })
    .turn('gpt-5.6', { effort: 'arbitrary provider string' }).user('work')
    .tokenCount(usage({ input: 20, output: 2 }))
    .raw('event_msg', { type: 'task_complete', duration_ms: 4500 })
    .turn('gpt-5.6', { effort: 'high'.repeat(100) })
    .raw('event_msg', { type: 'task_complete', duration_ms: 1, time_to_first_token_ms: -1 });
  const rec = parseCodex(String(r), { id: 'fallback' }).session;
  assert.equal(rec.codexEffort, null);
  assert.equal(rec.firstTokenMs, null);
  assert.equal(rec.compactions, 0);
  assert.equal(rec.latCount > 0, true, 'existing total-duration latency remains separate');
});

test('cold and warm cache retain the same observed detail', async () => {
  const sb = codexSandbox({ 'rollout-unit10.jsonl': sample() });
  const options = { days: 14, now, roots: sb.roots, cachePath: sb.cachePath, deps: stubDeps() };
  for (let i = 0; i < 2; i++) {
    _resetForTest();
    const a = await buildIndex(options);
    assert.equal(a.sessions[0].codexEffort.last, 'low');
    assert.equal(a.sessions[0].firstTokenMs.total, 2000);
    assert.equal(a.sessions[0].compactions, 1);
    assert.equal(a.totals.tokens, 148);
    if (i) assert.equal(a.sourceHealth.codex.diagnostics.cachedFiles, 1);
  }
});

test('imported turns cannot contribute effort, first-token time or compaction', () => {
  const r = new Rollout({ id: 'mixed' }).meta({ originator: 'Codex Desktop' })
    .taskStarted('external-import-turn-1').turn('gpt-5.6', { turn_id: 'external-import-turn-1', effort: 'high' })
    .raw('event_msg', { type: 'task_complete', time_to_first_token_ms: 999 })
    .raw('compacted', compacted)
    .taskStarted('native-1').turn('gpt-5.6', { turn_id: 'native-1', effort: 'low' })
    .tokenCount(usage({ input: 20, output: 2 }))
    .raw('event_msg', { type: 'task_complete', time_to_first_token_ms: 20 });
  const rec = parseCodex(String(r), { id: 'fallback' }).session;
  assert.deepEqual(rec.codexEffort, { last: 'low', counts: { low: 1 } });
  assert.deepEqual(rec.firstTokenMs, { count: 1, total: 20, min: 20, max: 20, provenance: 'host-observed' });
  assert.equal(rec.compactions, 0);
});

test('subagent replay contributes no parent effort, timing or compaction', () => {
  const parent = new Rollout({ id: 'parent' }).meta().taskStarted('parent-turn')
    .turn('gpt-5.6', { effort: 'high' })
    .raw('event_msg', { type: 'task_complete', time_to_first_token_ms: 900 })
    .raw('compacted', compacted);
  const child = forkedSubagent({ id: 'child', parent, own: (r) => r
    .turn('gpt-5.6', { effort: 'medium' })
    .tokenCount(usage({ input: 10, output: 2 }))
    .raw('event_msg', { type: 'task_complete', time_to_first_token_ms: 30 }) });
  const rec = parseCodex(String(child), { id: 'fallback' }).session;
  assert.deepEqual(rec.codexEffort, { last: 'medium', counts: { medium: 1 } });
  assert.equal(rec.firstTokenMs.total, 30);
  assert.equal(rec.compactions, 0);
});

test('older v26 records with absent or malformed optional detail remain unmeasured', () => {
  const old = parseCodex(String(new Rollout({ id: 'old' }).meta().taskStarted('t1')
    .turn().tokenCount(usage({ input: 10, output: 2 }))), { id: 'fallback' }).session;
  delete old.codexEffort;
  delete old.firstTokenMs;
  delete old.compactions;
  const malformed = { ...old, id: 'malformed', codexEffort: { last: 'arbitrary', counts: { arbitrary: 1 } },
    firstTokenMs: { count: 1, total: -3, min: -3, max: -3, provenance: 'derived' }, compactions: -2 };
  const a = aggregate([old, malformed], { days: 14, now, cutoff: now - 14 * 86400000, deps: stubDeps() });
  for (const row of a.sessions) {
    assert.equal(row.codexEffort, null);
    assert.equal(row.firstTokenMs, null);
    assert.equal(row.compactions, 0);
  }
  assert.equal(a.totals.compactions, 0);
  assert.equal(a.totals.firstTokenMs, null);
});
