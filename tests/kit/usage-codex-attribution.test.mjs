// Codex usage attribution (ADR-0052): known non-tool item types, imported
// Claude sessions, subagent replay + own usage, counter resets, per-event
// day/model attribution. Hermetic: pure parser calls on synthetic rollouts and
// tmpdir sandboxes — never ~/.codex, ~/.claude or ~/.config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex, SCHEMA_VERSION, _resetForTest } from '../../src/lib/usage-index.mjs';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';
import { Rollout, usage, codexSandbox, stubDeps } from './helpers/codex-rollout.mjs';

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
