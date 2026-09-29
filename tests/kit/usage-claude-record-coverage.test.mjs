import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseClaude } from '../../src/lib/usage-parsers.mjs';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const at = '2026-09-28T12:00:00Z';
const line = (value) => JSON.stringify(value);
const assistant = { type: 'assistant', timestamp: at, message: {
  id: 'm1', role: 'assistant', model: 'claude-opus-5',
  usage: { input_tokens: 3, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }],
} };
const deps = { costOf: () => 2, pricesAsOf: '2026-09-01',
  classify: () => ({ category: 'Build', confidence: 1, basis: 'test' }), detectInsights: () => [] };

const raw = [
  line({ type: 'user', timestamp: at, message: { role: 'user', content: 'hello' } }),
  line(assistant), line({ type: 'ai-title', aiTitle: 'safe title' }),
  line({ type: 'cost-state', sessionId: 's1', totalCostUSD: 1 }),
  line({ type: 'system', timestamp: at }), line({ type: 'attachment', timestamp: at }),
  line({ type: 'future-private-type', timestamp: at, message: { usage: { output_tokens: 900 } } }),
  line({ type: 42, timestamp: at }), '{bad json',
].join('\n');

test('Claude record coverage separates handled, ignored, unknown, invalid type and malformed JSON', () => {
  const { session, parseStats } = parseClaude(raw, { id: 's1' });
  assert.deepEqual(parseStats, {
    knownHandledRecords: 4, knownIgnoredRecords: 2, unknownRecords: 1,
    invalidTypeRecords: 1, malformedRecords: 1,
  });
  assert.equal(session.responses, 1);
  assert.equal(session.usage[0].input, 3);
  assert.equal(session.usage[0].output, 5);
  assert.equal(JSON.stringify({ session, parseStats }).includes('future-private-type'), false);
});

test('cold, warm and legacy v26 cache expose count-only incomplete coverage without changing totals', async () => {
  const root = tempDir('ak-claude-record-coverage');
  const project = path.join(root, 'claude', 'project');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 's1.jsonl');
  fs.writeFileSync(file, raw);
  const options = { days: 7, now: Date.parse('2026-09-29T00:00:00Z'),
    roots: { claude: path.join(root, 'claude'), codex: path.join(root, 'codex') },
    cachePath: path.join(root, 'cache.json'), deps };
  _resetForTest();
  const cold = await buildIndex(options);
  const expected = { knownHandledRecords: 4, knownIgnoredRecords: 2, unknownRecords: 1,
    invalidTypeRecords: 1, malformedRecords: 1, coverage: 'incomplete' };
  assert.deepEqual(cold.sourceHealth.claude.diagnostics.records, expected);
  assert.equal(cold.sourceHealth.claude.status, 'degraded');
  assert.equal(cold.totals.responses, 1);
  assert.equal(cold.totals.cost, 2);
  const cached = JSON.parse(fs.readFileSync(options.cachePath, 'utf8'));
  assert.deepEqual(cached.entries[file].parseStats, {
    knownHandledRecords: 4, knownIgnoredRecords: 2, unknownRecords: 1,
    invalidTypeRecords: 1, malformedRecords: 1,
  });
  assert.equal(JSON.stringify(cached).includes('future-private-type'), false);
  _resetForTest();
  const warm = await buildIndex(options);
  assert.deepEqual(warm.sourceHealth.claude.diagnostics.records, expected);
  assert.equal(warm.totals.cost, cold.totals.cost);

  delete cached.entries[file].parseStats;
  fs.writeFileSync(options.cachePath, JSON.stringify(cached));
  _resetForTest();
  const repaired = await buildIndex(options);
  assert.deepEqual(repaired.sourceHealth.claude.diagnostics.records, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.cachePath, 'utf8')).entries[file].parseStats,
    { knownHandledRecords: 4, knownIgnoredRecords: 2, unknownRecords: 1,
      invalidTypeRecords: 1, malformedRecords: 1 });
});

test('known-only files report complete coverage and an unreadable root reports unknown coverage', async () => {
  const root = tempDir('ak-claude-record-health');
  const project = path.join(root, 'claude', 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 's1.jsonl'), [line(assistant), line({ type: 'system' })].join('\n'));
  const options = { days: 7, now: Date.parse('2026-09-29T00:00:00Z'),
    roots: { claude: path.join(root, 'claude'), codex: path.join(root, 'codex') },
    cachePath: path.join(root, 'cache.json'), deps };
  _resetForTest();
  const good = await buildIndex(options);
  assert.deepEqual(good.sourceHealth.claude.diagnostics.records, {
    knownHandledRecords: 1, knownIgnoredRecords: 1, unknownRecords: 0,
    invalidTypeRecords: 0, malformedRecords: 0, coverage: 'complete',
  });
  assert.equal(good.sourceHealth.claude.status, 'ok');
  const badRoot = path.join(root, 'not-a-directory');
  fs.writeFileSync(badRoot, '');
  _resetForTest();
  const bad = await buildIndex({ ...options, roots: { ...options.roots, claude: badRoot } });
  assert.equal(bad.sourceHealth.claude.status, 'degraded');
  assert.equal(bad.sourceHealth.claude.diagnostics.records.coverage, 'unknown');
});
