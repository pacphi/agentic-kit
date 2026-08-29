// SCHEMA v6 additions to the Codex parse path: reasoning-output detail, the
// embedded rate-limit snapshot (normalized, duration-keyed), the aggregate's
// codexRateLimits history, and the ledger seam on buildIndex. Self-contained
// fixtures — nothing here reads ~/.claude, ~/.codex or ~/.config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, readSession, _resetForTest } from '../../src/lib/usage-index.mjs';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';

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

function rolloutItemCompleted(id, { mixed = false } = {}) {
  const line = (o) => `${JSON.stringify(o)}\n`;
  const meta = line({ timestamp: T0, type: 'session_meta', payload: {
    id, cwd: '/Users/me/proj', thread_source: 'user', model_provider: 'openai',
  } });
  const context = line({ timestamp: T0, type: 'turn_context', payload: { model: 'gpt-5.6' } });
  const legacy = mixed
    ? line({ timestamp: T0, type: 'event_msg', payload: { type: 'user_message', message: 'legacy prompt' } })
      + line({ timestamp: T1, type: 'event_msg', payload: { type: 'agent_message', message: 'legacy response' } })
    : '';
  const current = line({ timestamp: T0, type: 'event_msg', payload: {
    type: 'item_completed', item: { type: 'UserMessage', id: 'user-1', content: [{ type: 'text', text: 'current prompt' }] },
  } }) + line({
    timestamp: T0, type: 'event_msg', payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 } },
    },
  }) + line({ timestamp: T1, type: 'event_msg', payload: {
    type: 'item_completed', item: { type: 'AgentMessage', id: 'agent-1', content: [{ type: 'Text', text: 'current response' }] },
  } }) + line({ timestamp: T1, type: 'event_msg', payload: {
    type: 'item_completed', item: { type: 'CommandExecution', id: 'command-1', command: 'echo hidden' },
  } });
  return meta + context + legacy + current;
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

test('parseCodex normalizes current item_completed messages and exposes bounded diagnostics', async () => {
  _resetForTest();
  const id = 'item-completed-1';
  const sb = sandbox({ [`rollout-2026-07-24T09-00-00-${id}.jsonl`]: rolloutItemCompleted(id) });
  const agg = await buildIndex(opts(sb));
  const s = agg.sessions.find((x) => x.id === id);
  assert.ok(s, 'current-format session is retained');
  assert.equal(s.prompts, 1);
  assert.equal(s.responses, 1);
  assert.equal(s.tokens, 120);
  assert.equal(agg.sourceHealth.codex.status, 'ok');
  assert.deepEqual(agg.sourceHealth.codex.diagnostics, {
    files: 1, cachedFiles: 0, parsedFiles: 1, unparsedFiles: 0,
    filesWithTokens: 1, filesWithResponses: 1,
    legacyEvents: 0, itemCompletedEvents: 3, tokenCountEvents: 1,
    prompts: 1, responses: 1, unknownItemTypes: { CommandExecution: 1 }, unknownItemTypeOverflow: 0,
    warnings: ['unknown-item-types'],
    common: {
      unitsSeen: 1, unitsParsed: 1, unitsWithUsage: 1,
      unitsWithPrompts: 1, unitsWithResponses: 1,
      prompts: 1, responses: 1,
      warnings: ['unknown-item-types'], unknownKinds: { CommandExecution: 1 }, unknownKindOverflow: 0,
    },
  });

  const detail = await readSession(id, opts(sb));
  assert.deepEqual(detail.turns.map((t) => [t.role, t.text]), [
    ['user', 'current prompt'], ['assistant', 'current response'],
  ]);
});

test('parseCodex accepts a mixed legacy/current rollout without dropping either message family', async () => {
  _resetForTest();
  const id = 'item-completed-mixed';
  const sb = sandbox({ [`rollout-2026-07-24T09-00-00-${id}.jsonl`]: rolloutItemCompleted(id, { mixed: true }) });
  const agg = await buildIndex(opts(sb));
  const s = agg.sessions.find((x) => x.id === id);
  assert.equal(s.prompts, 2);
  assert.equal(s.responses, 2);
  assert.equal(agg.sourceHealth.codex.diagnostics.legacyEvents, 2);
  assert.equal(agg.sourceHealth.codex.diagnostics.itemCompletedEvents, 3);
});

test('Codex source health degrades when token-bearing files yield zero normalized responses', async () => {
  _resetForTest();
  const id = 'item-completed-zero';
  const line = (o) => `${JSON.stringify(o)}\n`;
  const raw = line({ timestamp: T0, type: 'session_meta', payload: { id, cwd: '/Users/me/proj' } })
    + line({ timestamp: T0, type: 'turn_context', payload: { model: 'gpt-5.6' } })
    + line({ timestamp: T0, type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, total_tokens: 120 } },
    } });
  const sb = sandbox({ [`rollout-2026-07-24T09-00-00-${id}.jsonl`]: raw });
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.totals.sessions, 0);
  assert.equal(agg.sourceHealth.codex.status, 'degraded');
  assert.equal(agg.sourceHealth.codex.reason, 'parse-yield-zero');
  assert.deepEqual(agg.sourceHealth.codex.diagnostics.warnings, ['zero-response-yield']);
});

test('Codex source health exposes partial response yield across token-bearing files', async () => {
  _resetForTest();
  const id = 'item-completed-partial';
  const line = (o) => `${JSON.stringify(o)}\n`;
  const zero = line({ timestamp: T0, type: 'session_meta', payload: { id: 'zero-yield', cwd: '/Users/me/proj' } })
    + line({ timestamp: T0, type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, total_tokens: 120 } },
    } });
  const sb = sandbox({
    [`rollout-2026-07-24T09-00-00-${id}.jsonl`]: rollout(id),
    'rollout-2026-07-24T09-00-01-zero-yield.jsonl': zero,
  });
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.totals.sessions, 1);
  assert.equal(agg.sourceHealth.codex.status, 'degraded');
  assert.equal(agg.sourceHealth.codex.reason, 'parse-yield-partial');
  assert.deepEqual(agg.sourceHealth.codex.diagnostics.warnings, ['partial-response-yield']);
  assert.equal(agg.sourceHealth.codex.diagnostics.filesWithTokens, 2);
  assert.equal(agg.sourceHealth.codex.diagnostics.filesWithResponses, 1);
});

test('schema 10 reparses a legacy Codex cache instead of trusting zero-turn records', async () => {
  _resetForTest();
  const id = 'schema-bump-codex';
  const fileName = `rollout-2026-07-24T09-00-00-${id}.jsonl`;
  const sb = sandbox({ [fileName]: rolloutItemCompleted(id) });
  await buildIndex(opts(sb));

  const cache = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
  const file = path.join(sb.roots.codex, '2026', '07', '24', fileName);
  cache.schemaVersion = 9;
  cache.entries[file].session.prompts = 0;
  cache.entries[file].session.responses = 0;
  cache.entries[file].session.usage = [];
  fs.writeFileSync(sb.cachePath, JSON.stringify(cache));

  _resetForTest();
  const agg = await buildIndex(opts(sb));
  const s = agg.sessions.find((x) => x.id === id);
  assert.equal(s.prompts, 1);
  assert.equal(s.responses, 1);
  assert.equal(s.tokens, 120);
  assert.equal(agg.sourceHealth.codex.diagnostics.cachedFiles, 0);
  assert.equal(agg.sourceHealth.codex.diagnostics.parsedFiles, 1);
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

test('parseCodex v11: mode, duration, aborts, ctx window, typed tools', () => {
  const plusSec = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString();
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'cx1', cwd: '/tmp/p', thread_source: 'user' }, timestamp: T0 }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6', approval_policy: 'never', sandbox_policy: 'workspace-write' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', started_at: T0, model_context_window: 272000, turn_id: 't1' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'done' }, timestamp: plusSec(T0, 6) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } }, timestamp: plusSec(T0, 7) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', duration_ms: 9000, error: null, turn_id: 't1' }, timestamp: plusSec(T0, 9) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'user_interrupt', turn_id: 't2' }, timestamp: plusSec(T0, 20) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } } }, timestamp: plusSec(T0, 21) }),
  ].join('\n');
  const { session: rec } = parseCodex(lines, { id: 'cx1' });
  assert.equal(rec.mode, 'auto-edit');
  assert.equal(rec.modeRaw, 'never/workspace-write');
  assert.equal(rec.latCount, 1);
  assert.equal(rec.latHist[2], 1);           // 6s prompt→agent gap
  assert.equal(rec.aborts, 1);
  assert.equal(rec.ctxWindow, 272000);
  assert.equal(rec.tools.CommandExecution, 1);
});

// The REAL wire shape. Surveyed over this machine's rollouts (2026-08-28,
// 400 files): `sandbox_policy` is an OBJECT keyed `.type` in 1,110/1,110
// occurrences — {"type":"danger-full-access"} (1004), {"type":"read-only"}
// (59), and {"type":"workspace-write", …} with extra fields (47). The string
// form the taxonomy was written against occurred ZERO times, so before the
// extraction only the approval-only 'guarded' rule could ever fire for codex:
// plan/auto-edit/unrestricted were unreachable on live data and modeRaw
// persisted the failed toString "never/[object Object]".
// `approval_policy` is a plain string in the same corpus ("never" 1524,
// "on-request" 39), so only the sandbox half needs extracting.
const turnCtx = (approval, sandbox) => JSON.stringify({
  type: 'turn_context',
  payload: { model: 'gpt-5.6', approval_policy: approval, sandbox_policy: sandbox },
  timestamp: T0,
});
const codexModeOf = (id, approval, sandbox) => parseCodex([
  JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/tmp/p', thread_source: 'user' }, timestamp: T0 }),
  turnCtx(approval, sandbox),
].join('\n'), { id }).session;

test('parseCodex: the object form of sandbox_policy maps to the taxonomy — unrestricted', () => {
  const rec = codexModeOf('cxm1', 'never', { type: 'danger-full-access' });
  assert.equal(rec.mode, 'unrestricted', 'codex\'s riskiest posture is no longer invisible to detectUnrestrictedMode');
  assert.equal(rec.modeRaw, 'never/danger-full-access', 'the host spelling, not "[object Object]"');
});

test('parseCodex: the object form of sandbox_policy maps to the taxonomy — auto-edit', () => {
  // The real workspace-write object carries siblings; only `.type` is read.
  const rec = codexModeOf('cxm2', 'never', {
    type: 'workspace-write', network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
  });
  assert.equal(rec.mode, 'auto-edit');
  assert.equal(rec.modeRaw, 'never/workspace-write');
});

test('parseCodex: the object form of sandbox_policy maps to the taxonomy — plan', () => {
  const rec = codexModeOf('cxm3', 'on-request', { type: 'read-only' });
  assert.equal(rec.mode, 'plan');
  assert.equal(rec.modeRaw, 'on-request/read-only');
});

test('parseCodex: the object form of sandbox_policy maps to the taxonomy — guarded', () => {
  const rec = codexModeOf('cxm4', 'on-request', { type: 'workspace-write' });
  assert.equal(rec.mode, 'guarded', 'human-in-the-loop approval is the posture');
  assert.equal(rec.modeRaw, 'on-request/workspace-write');
});

test('parseCodex: a sandbox_policy object with no .type contributes no sandbox evidence, never a guess', () => {
  const rec = codexModeOf('cxm5', 'never', { network_access: true });
  assert.equal(rec.mode, null, 'approval "never" alone matches no rule — unmapped, not assumed permissive');
  assert.equal(rec.modeRaw, 'never', 'only the half that was actually observed');
});

// Codex's duration_ms is host-measured turn wall-clock and INCLUDES time the
// turn spent blocked on an approval prompt, so a turn left awaiting approval
// overnight is recorded as a multi-hour "response". The prompt-gap path
// discards exactly that; the fallback must too, or the same wait becomes a
// latency sample. Real corpus max: 94,079,450 ms ≈ 26.1 h.
test('parseCodex: an idle-resume duration_ms is excluded from latency sampling, like the other two paths', () => {
  const plusSec = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString();
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'cx3', cwd: '/tmp/p', thread_source: 'user' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', started_at: T0, model_context_window: 272000, turn_id: 't1' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', duration_ms: 94_079_450, error: null, turn_id: 't1' }, timestamp: plusSec(T0, 94_079) }),
  ].join('\n');
  const { session: rec } = parseCodex(lines, { id: 'cx3' });
  assert.equal(rec.latCount, 0, '26.1 h is an idle resume / blocked approval, not a response latency');
  assert.equal(rec.latHist, null, 'no sample at all — not an overflow-bucket entry beside genuinely slow turns');
});

test('parseCodex: a duration_ms inside the cap still samples through the fallback', () => {
  const plusSec = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString();
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'cx4', cwd: '/tmp/p', thread_source: 'user' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', started_at: T0, model_context_window: 272000, turn_id: 't1' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', duration_ms: 45_000, error: null, turn_id: 't1' }, timestamp: plusSec(T0, 45) }),
  ].join('\n');
  const { session: rec } = parseCodex(lines, { id: 'cx4' });
  assert.equal(rec.latCount, 1, 'the fallback is not disabled, only bounded');
  assert.equal(rec.latHist[4], 1, '45s lands in the (30,60] bucket');
});

test('parseCodex v11: turn_aborted clears pending latency state so a later agent_message is not mis-sampled', () => {
  const plusSec = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString();
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'cx2', cwd: '/tmp/p', thread_source: 'user' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'user_interrupt', turn_id: 't1' }, timestamp: plusSec(T0, 3) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'unrelated' }, timestamp: plusSec(T0, 120) }),
  ].join('\n');
  const { session: rec } = parseCodex(lines, { id: 'cx2' });
  assert.equal(rec.latCount, 0);
});
