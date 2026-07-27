// SCHEMA v6 additions to the Codex parse path: reasoning-output detail, the
// embedded rate-limit snapshot (normalized, duration-keyed), the aggregate's
// codexRateLimits history, and the ledger seam on buildIndex. Self-contained
// fixtures — nothing here reads ~/.claude, ~/.codex or ~/.config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const T0 = '2026-07-24T09:00:00.000Z';
const T1 = '2026-07-24T09:10:00.000Z';

const deps = () => ({
  costOf: () => 1,
  pricesAsOf: '2026-07-01',
  classify: () => ({ category: 'Build', confidence: 0.9, basis: 'stub' }),
  detectInsights: () => [],
});

/** One rollout with two token_count events: cumulative totals plus a live
 *  rate_limits snapshot on each — the LAST of both must win. */
function rollout(id, { threadSource = 'user' } = {}) {
  const line = (o) => `${JSON.stringify(o)}\n`;
  return line({ timestamp: T0, type: 'session_meta', payload: { id, cwd: '/Users/me/proj', thread_source: threadSource } })
    + line({ timestamp: T0, type: 'turn_context', payload: { model: 'gpt-5.6' } })
    + line({ timestamp: T0, type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } })
    + line({
      timestamp: T0, type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } },
        rate_limits: {
          limit_id: 'codex', plan_type: 'prolite',
          primary: { used_percent: 5, window_minutes: 300, resets_at: 1785000000 },
          secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1785400000 },
        },
      },
    })
    + line({ timestamp: T1, type: 'event_msg', payload: { type: 'agent_message', message: 'done' } })
    + line({
      timestamp: T1, type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 600000, cached_input_tokens: 500000, output_tokens: 4000, reasoning_output_tokens: 875, total_tokens: 604000 } },
        rate_limits: {
          limit_id: 'codex', plan_type: 'prolite',
          // The NAMING TRAP, reproduced: primary is the WEEKLY window here.
          primary: { used_percent: 9, window_minutes: 10080, resets_at: 1785649138 },
          secondary: null,
        },
      },
    });
}

function sandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-usage-v6-'));
  const day = path.join(dir, 'codex', '2026', '07', '24');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(day, name), body);
  }
  return {
    roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
  };
}

const opts = (sb, extra = {}) => ({
  days: 14, now: NOW, roots: sb.roots, cachePath: sb.cachePath, deps: deps(), ...extra,
});

test('parseCodex captures reasoning output and the LAST rate-limit snapshot', async () => {
  _resetForTest();
  const sb = sandbox({ 'rollout-2026-07-24T09-00-00-aaaa1111.jsonl': rollout('aaaa1111') });
  const agg = await buildIndex(opts(sb));
  const s = agg.sessions.find((x) => x.id === 'aaaa1111');
  assert.ok(s, 'session parsed');
  assert.equal(s.reasoningOutput, 875, 'last cumulative reasoning figure, not a sum');
  assert.equal(s.rateLimits.planType, 'prolite');
  assert.equal(s.rateLimits.limitId, 'codex');
  assert.equal(s.rateLimits.at, Date.parse(T1), 'the LAST snapshot wins');
  // Duration-keyed, slot-agnostic: this last snapshot's primary IS the weekly.
  assert.deepEqual(s.rateLimits.windows, [
    { usedPercent: 9, windowMinutes: 10080, resetsAt: 1785649138 },
  ]);
  // And the aggregate exposes the window's snapshots as a history, oldest first.
  assert.equal(agg.codexRateLimits.length, 1);
  assert.equal(agg.codexRateLimits[0].windows[0].usedPercent, 9);
});

test('reasoning tokens are annotation only — token totals are unchanged by them', async () => {
  _resetForTest();
  const sb = sandbox({ 'rollout-2026-07-24T09-00-00-bbbb2222.jsonl': rollout('bbbb2222') });
  const agg = await buildIndex(opts(sb));
  const s = agg.sessions.find((x) => x.id === 'bbbb2222');
  // input excludes cached; output is the full output figure, reasoning inside it.
  assert.equal(s.input, 100000);
  assert.equal(s.output, 4000);
  assert.equal(s.cacheRead, 500000);
  assert.equal(s.tokens, 604000);
});

test('a subagent rollout contributes no tokens but keeps its rate-limit snapshot out of nothing', async () => {
  _resetForTest();
  const sb = sandbox({ 'rollout-2026-07-24T09-00-00-cccc3333.jsonl': rollout('cccc3333', { threadSource: 'subagent' }) });
  const agg = await buildIndex(opts(sb));
  const s = agg.sessions.find((x) => x.id === 'cccc3333');
  assert.ok(s, 'subagent session stays visible');
  assert.equal(s.tokens, 0, 'replayed parent history is excluded');
  assert.equal(s.threadSource, 'subagent');
});

test('buildIndex applies an injected Codex ledger: subagent stripped without a rollout marker', async () => {
  _resetForTest();
  const raw = rollout('dddd4444').replace('"thread_source":"user"', '"thread_source":null');
  const sb = sandbox({ 'rollout-2026-07-24T09-00-00-dddd4444.jsonl': raw });
  const withLedger = await buildIndex(opts(sb, {
    codexState: { threads: new Map([['dddd4444', { threadSource: 'subagent' }]]), parents: new Map() },
  }));
  const s = withLedger.sessions.find((x) => x.id === 'dddd4444');
  assert.equal(s.threadSource, 'subagent');
  assert.equal(s.tokens, 0, 'ledger-identified subagent must not bill its replayed history');

  // Same corpus, no ledger: the heuristic alone cannot know, tokens remain.
  _resetForTest();
  const without = await buildIndex(opts(sb, { force: true, codexState: null }));
  assert.equal(without.sessions.find((x) => x.id === 'dddd4444').tokens, 604000);
});
