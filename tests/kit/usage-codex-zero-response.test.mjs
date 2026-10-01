import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';
import { Rollout, usage, codexSandbox, stubDeps } from './helpers/codex-rollout.mjs';

const now = Date.parse('2026-07-25T12:00:00Z');
const native = () => new Rollout({ id: 'tool-only' }).meta().taskStarted('native-1').turn()
  .item('CommandExecution').tokenCount(usage({ input: 120, cached: 20, output: 7 }))
  .raw('event_msg', { type: 'turn_aborted' });
const totalOnly = () => new Rollout({ id: 'total-only' }).meta().taskStarted('native-1').turn()
  .raw('event_msg', { type: 'token_count', info: {
    total_token_usage: { total_tokens: 127 }, last_token_usage: { total_tokens: 127 },
  } });

test('native tool-only component usage counts with zero normalized responses', () => {
  const parsed = parseCodex(String(native()), { id: 'fallback' });
  assert.equal(parsed.session.responses, 0);
  assert.deepEqual(parsed.session.usage.map(({ input, cacheRead, output }) => ({ input, cacheRead, output })),
    [{ input: 100, cacheRead: 20, output: 7 }]);
  const result = aggregate([parsed.session], { days: 14, now, cutoff: now - 14 * 86400000, deps: stubDeps() });
  assert.equal(result.totals.sessions, 1);
  assert.equal(result.totals.responses, 0);
  assert.equal(result.totals.input, 100);
  assert.equal(result.totals.cacheRead, 20);
  assert.equal(result.totals.output, 7);
  assert.equal(result.totals.tokens, 127);
});

test('cold and warm cache count component usage without responses and retain missing-breakdown diagnostics', async () => {
  const sb = codexSandbox({ 'rollout-native.jsonl': native(), 'rollout-total.jsonl': totalOnly() });
  const options = { days: 14, now, roots: sb.roots, cachePath: sb.cachePath, deps: stubDeps() };
  for (let i = 0; i < 2; i++) {
    _resetForTest();
    const result = await buildIndex(options);
    assert.equal(result.totals.sessions, 1);
    assert.equal(result.totals.responses, 0);
    assert.equal(result.totals.tokens, 127);
    assert.equal(result.sourceHealth.codex.diagnostics.zeroResponseUsageFiles, 1);
    assert.equal(result.sourceHealth.codex.diagnostics.totalOnlyTokenCountEvents, 1);
    assert.equal(result.sourceHealth.codex.diagnostics.zeroResponseUnsupportedFiles, 1);
    assert.ok(result.sourceHealth.codex.diagnostics.warnings.includes('total-only-token-count'));
    assert.equal(result.sourceHealth.codex.status, 'degraded');
    if (i) assert.equal(result.sourceHealth.codex.diagnostics.cachedFiles, 2);
  }
});

test('total-only counter cannot create a priced row or fabricated components', () => {
  const parsed = parseCodex(String(totalOnly()), { id: 'fallback' });
  assert.equal(parsed.session.responses, 0);
  assert.deepEqual(parsed.session.usage, []);
  assert.equal(parsed.parseStats.totalOnlyTokenCountEvents, 1);
  const result = aggregate([parsed.session], { days: 14, now, cutoff: now - 14 * 86400000, deps: stubDeps() });
  assert.equal(result.totals.sessions, 0);
  assert.equal(result.totals.tokens, 0);
  assert.equal(result.totals.cost, 0);
});

test('a total-only gap cannot make a later component snapshot double count earlier usage', () => {
  const r = native();
  r.raw('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 200 } } });
  r.tokenCount(usage({ input: 50, output: 5 }));
  const parsed = parseCodex(String(r), { id: 'fallback' });
  assert.equal(parsed.parseStats.totalOnlyTokenCountEvents, 1);
  assert.deepEqual(parsed.session.usage.map(({ input, cacheRead, output }) => ({ input, cacheRead, output })),
    [{ input: 100, cacheRead: 20, output: 7 }]);
});

test('import copies and incomplete mixed ownership cannot become zero-response billable sessions', async () => {
  const copy = new Rollout({ id: 'copy' }).meta({ originator: 'Codex Desktop' })
    .taskStarted('external-import-turn-1').tokenCount(usage({ input: 500 }));
  const mixed = new Rollout({ id: 'mixed' }).meta({ originator: 'Codex Desktop' })
    .taskStarted('external-import-turn-1').tokenCount(usage({ input: 500 }))
    .taskStarted('native-1').tokenCount(usage({ input: 50 }));
  mixed.lines.push('{broken-boundary');
  const sb = codexSandbox({ 'rollout-copy.jsonl': copy, 'rollout-mixed.jsonl': mixed });
  const result = await buildIndex({ days: 14, now, roots: sb.roots, cachePath: sb.cachePath, deps: stubDeps() });
  assert.equal(result.totals.sessions, 0);
  assert.equal(result.totals.tokens, 0);
  assert.equal(result.sourceHealth.codex.diagnostics.importedExcluded, 2);
  assert.equal(result.sourceHealth.codex.diagnostics.importOwnershipIncompleteFiles, 1);
});

test('an imported total-only baseline cannot bill the next native cumulative snapshot', () => {
  const r = new Rollout({ id: 'mixed-total' }).meta({ originator: 'Codex Desktop' })
    .taskStarted('external-import-turn-1')
    .raw('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 500 } } })
    .taskStarted('native-1').turn('gpt-5.6', { turn_id: 'native-1' })
    .raw('event_msg', { type: 'token_count', info: {
      total_token_usage: usage({ input: 550, output: 5 }),
      last_token_usage: usage({ input: 50, output: 5 }),
    } });
  const parsed = parseCodex(String(r), { id: 'fallback' });
  assert.equal(parsed.session.responses, 0);
  assert.deepEqual(parsed.session.usage, []);
  assert.equal(parsed.session.importEvidence.ownershipComplete, true);
});
