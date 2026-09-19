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
