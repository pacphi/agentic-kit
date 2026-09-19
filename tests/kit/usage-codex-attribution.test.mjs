// Codex usage attribution (ADR-0052): known non-tool item types, imported
// Claude sessions, subagent replay + own usage, counter resets, per-event
// day/model attribution. Hermetic: pure parser calls on synthetic rollouts and
// tmpdir sandboxes — never ~/.codex, ~/.claude or ~/.config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex, SCHEMA_VERSION, _resetForTest } from '../../src/lib/usage-index.mjs';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';
import { Rollout, usage, codexSandbox, stubDeps, forkedSubagent, subagentMeta } from './helpers/codex-rollout.mjs';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const opts = (sb, extra = {}) => ({
  days: 14, now: NOW, roots: sb.roots, cachePath: sb.cachePath, deps: stubDeps(), ...extra,
});

// ── X-9: known non-tool item types are not "unknown" ───────────────────────

const KNOWN_NON_TOOL_ITEMS = ['Reasoning', 'SubAgentActivity', 'ImageView', 'Extension', 'WebSearch', 'ContextCompaction'];

function itemRollout(types) {
  const r = new Rollout({ id: 'x9' }).meta().turn().user();
  for (const t of types) r.item(t);
  return r.agent().tokenCount(usage({ input: 100, output: 20 }));
}

test('X-9: item types the host is known to emit are not reported as unknown kinds', () => {
  const { parseStats } = parseCodex(itemRollout(KNOWN_NON_TOOL_ITEMS).toString(), { id: 'x9' });
  assert.deepEqual(parseStats.unknownItemTypes, {});
  assert.equal(parseStats.unknownItemTypeOverflow, 0);
});

test('X-9: a genuinely new item type is still surfaced', () => {
  const { parseStats } = parseCodex(itemRollout([...KNOWN_NON_TOOL_ITEMS, 'HologramProjection']).toString(), { id: 'x9' });
  assert.deepEqual(parseStats.unknownItemTypes, { HologramProjection: 1 });
});

test('X-9: a corpus of only known item types raises no unknown-item-types warning', async () => {
  _resetForTest();
  const sb = codexSandbox({ 'rollout-2026-07-24T09-00-00-x9.jsonl': itemRollout(KNOWN_NON_TOOL_ITEMS) });
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.sourceHealth.codex.diagnostics.warnings.includes('unknown-item-types'), false);
  assert.equal(agg.sourceHealth.codex.status, 'ok');
});

// ── X-3: imported Claude Code sessions are not native Codex sessions ───────

/** Mirrors a real imported rollout: `external-import-turn-N` turn ids, no
 *  turn_context, no thread_source, input_tokens 0 with only total_tokens. */
function importedRollout(id, turns = 3) {
  const r = new Rollout({ id }).meta({ thread_source: undefined, source: 'vscode' });
  for (let n = 1; n <= turns; n++) {
    r.taskStarted(`external-import-turn-${n}`).user(`imported prompt ${n}`).agent(`imported answer ${n}`);
    r.raw('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 1942 * n }, last_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 1942 } } });
  }
  return r;
}

function nativeRollout(id, { prompts = 1 } = {}) {
  const r = new Rollout({ id }).meta().turn('gpt-5.6');
  for (let n = 0; n < prompts; n++) {
    r.user(`native prompt ${n}`).agent(`native answer ${n}`).tokenCount(usage({ input: 1000, cached: 400, output: 100 }));
  }
  return r;
}

test('X-3: parseCodex marks an imported rollout and counts none of its activity', () => {
  const { session, parseStats } = parseCodex(importedRollout('imp1').toString(), { id: 'imp1' });
  assert.equal(session.imported, true);
  assert.equal(session.prompts, 0);
  assert.equal(session.responses, 0);
  assert.deepEqual(session.usage, []);
  assert.equal(parseStats.imported, true);
});

test('X-3: a native rollout is never marked imported', () => {
  const { session, parseStats } = parseCodex(nativeRollout('nat1').toString(), { id: 'nat1' });
  assert.equal(session.imported, undefined);
  assert.equal(parseStats.imported, undefined);
});

test('X-3: imports are excluded from sessions, prompts, responses and yield diagnostics, and counted', async () => {
  _resetForTest();
  const sb = codexSandbox({
    'rollout-2026-07-24T09-00-00-nat1.jsonl': nativeRollout('nat1', { prompts: 2 }),
    'rollout-2026-07-24T09-05-00-imp1.jsonl': importedRollout('imp1'),
    'rollout-2026-07-24T09-06-00-imp2.jsonl': importedRollout('imp2', 5),
  });
  const agg = await buildIndex(opts(sb));
  assert.deepEqual(agg.sessions.map((s) => s.id), ['nat1']);
  assert.equal(agg.totals.sessions, 1);
  assert.equal(agg.totals.prompts, 2);
  assert.equal(agg.totals.responses, 2);
  const d = agg.sourceHealth.codex.diagnostics;
  assert.equal(d.importedExcluded, 2, 'the exclusion is recorded, never silent');
  assert.equal(d.files, 3);
  assert.equal(d.parsedFiles, 1);
  assert.equal(d.filesWithResponses, 1);
  assert.equal(d.unparsedFiles, 0);
  assert.equal(agg.sourceHealth.codex.status, 'ok');
  assert.equal(d.common.unitsWithResponses, 1);

  // A second scan reads the cached imported entries and reports the same.
  _resetForTest();
  const again = await buildIndex(opts(sb));
  assert.equal(again.sourceHealth.codex.diagnostics.importedExcluded, 2);
  assert.equal(again.sourceHealth.codex.diagnostics.cachedFiles, 3);
  assert.equal(again.totals.sessions, 1);
});

// ── X-4 / X-2: subagent replay is not the subagent's own activity ──────────

const W = 200_000;

/** A user thread with two prompts, two answers, two tool runs and known usage:
 *  cumulative gross 3000 / cached 500 / out 300 / reasoning 30. */
function parentThread() {
  return new Rollout({ id: 'parent' }).meta().turn('gpt-5.6')
    .user('parent prompt one').item('CommandExecution').agent('parent answer one')
    .tokenCount(usage({ input: 1000, output: 100, reasoning: 30 }), { window: W })
    .user('parent prompt two').item('CommandExecution').agent('parent answer two')
    .tokenCount(usage({ input: 2000, cached: 500, output: 200 }), { window: W });
}

/** The child's OWN work: gross 2000 / cached 300 / out 200 / reasoning 25. */
const childWork = (r) => r
  .agent('own answer').item('CommandExecution')
  .tokenCount(usage({ input: 1500, cached: 300, output: 150, reasoning: 20 }), { window: W })
  .tokenCount(usage({ input: 500, output: 50, reasoning: 5 }), { window: W });

const rowsOf = (session) => session.usage.reduce((a, r) => ({
  input: a.input + r.input, output: a.output + r.output, cacheRead: a.cacheRead + r.cacheRead,
  cacheWrite: a.cacheWrite + r.cacheWrite, responses: a.responses + r.responses,
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 });

test('X-2/X-4: a forked subagent counts only its own tokens, responses, tools and context samples', () => {
  const child = forkedSubagent({ parent: parentThread(), own: childWork });
  const { session, parseStats } = parseCodex(child.toString(), { id: 'child' });
  assert.equal(session.threadSource, 'subagent', 'still flagged so human-prompt figures exclude it');
  assert.deepEqual(rowsOf(session), { input: 1700, output: 200, cacheRead: 300, cacheWrite: 0, responses: 1 });
  assert.equal(session.reasoningOutput, 25, 'the replayed 30 reasoning tokens are not the child\'s');
  assert.equal(session.prompts, 0, 'replayed parent prompts are not the subagent\'s');
  assert.equal(session.responses, 1, 'only the child\'s own answer');
  assert.equal(session.tools.CommandExecution, 1, 'the replayed parent tool runs are not the child\'s');
  const ctx = session.contextEvidence.input;
  assert.equal(ctx.samples, 2, 'no context sample from replayed token_counts');
  assert.equal(ctx.peak, 1500, 'peak pressure comes from the child\'s own events, not the replay\'s 2000');
  // The raw per-event diagnostics still count everything the file carried.
  assert.equal(parseStats.responses, 3);
  assert.equal(parseStats.tokenCountEvents, 4);
});

test('X-2/X-4: a degenerate history-start ordinal (the file length) falls back to the first message addressed to the thread', () => {
  const child = forkedSubagent({ parent: parentThread(), own: childWork, start: 'end' });
  const { session } = parseCodex(child.toString(), { id: 'child' });
  assert.deepEqual(rowsOf(session), { input: 1700, output: 200, cacheRead: 300, cacheWrite: 0, responses: 1 });
  assert.equal(session.prompts, 0);
  assert.equal(session.contextEvidence.input.samples, 2);
});

test('X-2: an unforked subagent replays nothing, so ALL of its usage is its own', () => {
  const r = new Rollout({ id: 'unforked' }).meta(subagentMeta('unforked')).taskStarted('t').turn('gpt-5.6-sub');
  r.raw('response_item', { type: 'agent_message', author: '/root', recipient: '/root/worker', content: [] });
  childWork(r);
  const { session } = parseCodex(r.toString(), { id: 'unforked' });
  assert.deepEqual(rowsOf(session), { input: 1700, output: 200, cacheRead: 300, cacheWrite: 0, responses: 1 });
  assert.equal(session.contextEvidence.input.samples, 2);
});

test('X-2: a guardian-style subagent (no agent path, history start at the file end) counts all of its usage', () => {
  const r = new Rollout({ id: 'guard' }).meta({ thread_source: 'subagent', source: { subagent: { other: 'guardian' } } })
    .taskStarted('t').turn('codex-auto-review').user('review this').agent('approved');
  r.tokenCount(usage({ input: 900, cached: 100, output: 50 }), { window: W });
  r.patchMeta({ subagent_history_start_ordinal: r.ordinal });
  const { session } = parseCodex(r.toString(), { id: 'guard' });
  assert.deepEqual(rowsOf(session), { input: 800, output: 50, cacheRead: 100, cacheWrite: 0, responses: 1 });
});

test('X-2: a subagent whose every token_count is replayed has no usage of its own', () => {
  const child = forkedSubagent({ parent: parentThread(), own: (r) => r.agent('no tokens yet') });
  const { session } = parseCodex(child.toString(), { id: 'child' });
  assert.deepEqual(session.usage, []);
  assert.equal(session.reasoningOutput, 0);
});

test('X-2: a pre-ordinal subagent rollout cannot separate its replay, so its cumulative usage is still not counted', () => {
  // No `ordinal` on any envelope: the replay is indistinguishable from own
  // turns. Counting the cumulative total could double-count the parent by
  // orders of magnitude, so the conservative pre-ADR-0052 behaviour holds.
  const lines = [
    { type: 'session_meta', timestamp: '2026-07-24T09:00:00.000Z', payload: { id: 'legacy', cwd: '/Users/me/proj', thread_source: 'subagent' } },
    { type: 'turn_context', timestamp: '2026-07-24T09:00:01.000Z', payload: { model: 'gpt-5.6' } },
    { type: 'event_msg', timestamp: '2026-07-24T09:00:02.000Z', payload: { type: 'agent_message', message: 'done' } },
    { type: 'event_msg', timestamp: '2026-07-24T09:00:03.000Z', payload: { type: 'token_count', info: { total_token_usage: usage({ input: 900_000, cached: 850_000, output: 9000 }) } } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const { session } = parseCodex(lines, { id: 'legacy' });
  assert.deepEqual(session.usage, []);
  assert.equal(session.responses, 1, 'the session itself stays visible');
});

test('X-2: the ledger still strips a subagent that only the ledger identifies', async () => {
  _resetForTest();
  // A rollout whose meta carries no thread_source: its usage is the
  // unsubtracted cumulative total, so a ledger-named subagent must not bill it.
  const raw = nativeRollout('ledgered').toString().replace('"thread_source":"user"', '"thread_source":null');
  const sb = codexSandbox({ 'rollout-2026-07-24T09-00-00-ledgered.jsonl': raw });
  const agg = await buildIndex(opts(sb, {
    codexState: { threads: new Map([['ledgered', { threadSource: 'subagent' }]]), parents: new Map() },
  }));
  assert.equal(agg.sessions.find((s) => s.id === 'ledgered').tokens, 0);
});

test('X-2: aggregation reports the subagent\'s own cost and keeps it out of human prompts', async () => {
  _resetForTest();
  const sb = codexSandbox({
    'rollout-2026-07-24T09-00-00-parent.jsonl': parentThread(),
    'rollout-2026-07-24T10-00-00-child.jsonl': forkedSubagent({ parent: parentThread(), own: childWork }),
  });
  const agg = await buildIndex(opts(sb));
  const child = agg.sessions.find((s) => s.id === 'child');
  assert.equal(child.tokens, 2200, 'own tokens: 1700 + 200 + 300');
  assert.equal(agg.totals.tokens, 3300 + 2200, 'parent 3300 + the child\'s own 2200, replay counted once');
  assert.equal(agg.totals.humanPrompts, 2, 'the subagent\'s replayed prompts are not human typing');
  assert.equal(agg.bySource.subagent.sessions, 1);
  assert.equal(agg.bySource.subagent.tokens, 2200);
  assert.equal(agg.bySource.main.tokens, 3300);
});

// ── schema version ──────────────────────────────────────────────────────────

test('SCHEMA_VERSION is 23 and a forged v22 Codex cache is discarded and re-parsed', async () => {
  assert.equal(SCHEMA_VERSION, 23, 'Codex attribution changes every cached Codex record');
  _resetForTest();
  const sb = codexSandbox({ 'rollout-2026-07-24T09-00-00-x9.jsonl': itemRollout(KNOWN_NON_TOOL_ITEMS) });
  const first = await buildIndex(opts(sb));
  assert.equal(first.sourceHealth.codex.diagnostics.warnings.length, 0);

  // Forge the pre-fix cache: same file key, v22 stamp, the permanent unknown-kind noise.
  const cache = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
  cache.schemaVersion = 22;
  for (const e of Object.values(cache.entries)) e.parseStats.unknownItemTypes = { Reasoning: 4 };
  fs.writeFileSync(sb.cachePath, JSON.stringify(cache));

  _resetForTest();
  const again = await buildIndex(opts(sb));
  assert.equal(again.sourceHealth.codex.diagnostics.cachedFiles, 0, 'the v22 entry was not trusted');
  assert.deepEqual(again.sourceHealth.codex.diagnostics.unknownItemTypes, {});
});
