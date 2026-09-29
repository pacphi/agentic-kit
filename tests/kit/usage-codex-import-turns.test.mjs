// Ownership is exercised through parser, aggregate/cache and bounded discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';
import { scanTranscriptCwds, discoverProjectSources } from '../../src/lib/footprint/project-sources.mjs';
import { Rollout, usage, codexSandbox, stubDeps, forkedSubagent } from './helpers/codex-rollout.mjs';

const imported = (originator = 'Codex Desktop') => new Rollout({ id: 'mixed' })
  .meta({ originator, cwd: '/copied', thread_source: undefined })
  .taskStarted('external-import-turn-1').turn('copied-model', { turn_id: 'external-import-turn-1', cwd: '/copied' })
  .user('copied secret prompt').agent('copied secret answer').item('FileChange')
  .tokenCount(usage({ input: 1000, cached: 200, output: 100 }));
const own = (r) => r.taskStarted('native-1').turn('gpt-5.6', { turn_id: 'native-1', cwd: '/genuine' })
  .user('genuine prompt').agent('genuine answer').item('CommandExecution')
  .tokenCount(usage({ input: 100, cached: 20, output: 10 }));
const parse = (r) => parseCodex(String(r), { id: 'fallback', withTurns: true });

test('mixed ownership excludes copied content and cumulative baseline but retains genuine project and surface', () => {
  const { session: s, turns, parseStats } = parse(own(imported()));
  assert.equal(s.imported, undefined);
  assert.equal(s.id, 'mixed');
  assert.equal(s.prompts, 1);
  assert.equal(s.responses, 1);
  assert.deepEqual(s.models, ['gpt-5.6']);
  assert.deepEqual(s.tools, { CommandExecution: 1 });
  assert.equal(s.contextEvidence.input.samples, 1);
  assert.equal(s.contextEvidence.input.peak, 100);
  assert.equal(s.usage[0].input, 80);
  assert.equal(s.usage[0].cacheRead, 20);
  assert.equal(s.usage[0].output, 10);
  assert.equal(s.project, 'genuine');
  assert.equal(s.sessionOrigin.surface, 'chatgpt-desktop-codex');
  assert.equal(s.importEvidence.importedTurns, 1);
  assert.equal(parseStats.prompts, 1);
  assert.equal(parseStats.responses, 1);
  assert.equal(JSON.stringify({ s, turns }).includes('copied secret'), false);
});

test('native CLI continuation keeps its declaration and handles a cumulative reset', () => {
  const { session: s } = parse(own(imported('codex-tui').resetTotal()));
  assert.equal(s.sessionOrigin.surface, 'codex-cli');
  assert.equal(s.usage[0].input, 80);
  assert.equal(s.usage[0].output, 10);
});

test('native before late import stays counted and repeated metadata cannot replace identity or native origin', () => {
  const r = new Rollout({ id: 'first' }).meta({ originator: 'codex-tui' })
    .taskStarted('native-1').turn().user('own').agent().tokenCount(usage({ input: 100, output: 10 }))
    .meta({ id: 'parent', originator: 'Codex Desktop' }).taskStarted('external-import-turn-1')
    .user('copied').agent().tokenCount(usage({ input: 2000, output: 200 }));
  const { session: s } = parse(r);
  assert.equal(s.id, 'first');
  assert.equal(s.responses, 1);
  assert.equal(s.usage[0].input, 100);
  assert.equal(s.sessionOrigin.surface, 'codex-cli');
});

test('foreign imported completion does not close a native turn; a new imported start does', () => {
  const r = imported().taskStarted('native-1')
    .raw('event_msg', { type: 'item_completed', turn_id: 'native-1', item: { type: 'AgentMessage', text: 'own' } })
    .raw('event_msg', { type: 'task_complete', turn_id: 'external-import-turn-1' })
    .tokenCount(usage({ input: 100, output: 10 }))
    .raw('event_msg', { type: 'task_complete', turn_id: 'native-1' })
    .taskStarted('external-import-turn-2').agent('copy').tokenCount(usage({ input: 500, output: 50 }));
  const { session: s } = parse(r);
  assert.equal(s.responses, 1);
  assert.equal(s.usage[0].input, 100);
  assert.equal(s.importEvidence.importedTurns, 2);
});

test('missing or mismatched turn IDs cannot establish native ownership after import', () => {
  const r = imported().taskStarted(undefined);
  // Builder has a default ID; replace this boundary with a truly missing ID.
  r.lines.pop();
  r.raw('event_msg', { type: 'task_started' }).user('ambiguous').agent('ambiguous')
    .tokenCount(usage({ input: 100, output: 10 }));
  const { session: s } = parse(r);
  assert.equal(s.imported, true);
  assert.equal(s.responses, 0);
  assert.ok(s.importEvidence.ambiguousRecords > 0);
  const mismatch = own(imported()).raw('event_msg', { type: 'agent_message', turn_id: 'unopened', message: 'ambiguous' });
  assert.equal(parse(mismatch).session.responses, 1);
});

test('a marker embedded in prompt text changes no ownership', () => {
  const r = new Rollout({ id: 'ordinary' }).meta().turn().user('external-import-turn-1').agent()
    .tokenCount(usage({ input: 100, output: 10 }));
  assert.equal(parse(r).session.responses, 1);
  assert.equal(parse(r).session.imported, undefined);
});

test('replayed imports do not replace child identity or count parent native activity', () => {
  const parent = own(imported());
  const child = forkedSubagent({ id: 'child', parent,
    own: (r) => r.user('child').agent().tokenCount(usage({ input: 50, output: 5 })) });
  const { session: s } = parse(child);
  assert.equal(s.id, 'child');
  assert.equal(s.threadSource, 'subagent');
  assert.equal(s.responses, 1);
  assert.equal(s.usage[0].input, 50);
});

test('cold and warm aggregate retain mixed usage and exclusion diagnostics', async () => {
  const sb = codexSandbox({ 'rollout-mixed.jsonl': own(imported()), 'rollout-copy.jsonl': imported() });
  const options = { days: 14, now: Date.parse('2026-07-25T12:00:00Z'), roots: sb.roots,
    cachePath: sb.cachePath, deps: stubDeps() };
  for (let n = 0; n < 2; n++) {
    _resetForTest();
    const a = await buildIndex(options);
    assert.equal(a.totals.sessions, 1);
    assert.equal(a.totals.responses, 1);
    assert.equal(a.totals.input, 80);
    assert.equal(a.sessions[0].importEvidence.importedTurns, 1);
    assert.equal(a.sessions[0].cost, 1);
    assert.equal(a.sourceHealth.codex.diagnostics.importedExcluded, 1);
    assert.equal(a.sourceHealth.codex.diagnostics.importedMixed, 1);
    assert.equal(a.sourceHealth.codex.diagnostics.importedTurnsExcluded, 2);
    if (n) assert.equal(a.sourceHealth.codex.diagnostics.cachedFiles, 2);
  }
});

test('bounded tail discovery finds interleaved native Desktop activity beyond the head', () => {
  const r = imported().raw('response_item', { type: 'message', content: 'x'.repeat(300_000) });
  own(r).taskStarted('external-import-turn-2').agent('later copied answer');
  const sb = codexSandbox({ 'rollout-mixed.jsonl': r });
  const scan = scanTranscriptCwds(sb.roots.codex, 'codex');
  assert.equal(scan.sightings.length, 1);
  assert.equal(scan.sightings[0].cwd, '/genuine');
  assert.equal(scan.sightings[0].sessionOrigin.surface, 'chatgpt-desktop-codex');
  assert.equal(scan.importedExcluded, 0);
  assert.equal(scan.importedMixed, 1);
});

test('bounded observations cannot label a large unseen middle imported-only or recover its encoded directory', () => {
  const r = imported().raw('response_item', { type: 'message', content: 'x'.repeat(3_000_000) });
  const sb = codexSandbox({ 'rollout-copy.jsonl': r });
  const scan = scanTranscriptCwds(sb.roots.codex, 'codex', { decodeDir: () => '/not-evidence' });
  assert.equal(scan.sightings.length, 0);
  assert.equal(scan.importedExcluded, 0);
  assert.equal(scan.importedUnresolved, 1);
  assert.equal(scan.complete, false);
  assert.equal(scan.sessionCountComplete, false);
});

test('a pure import whose whole bounded file is read remains excluded', () => {
  const sb = codexSandbox({ 'rollout-copy.jsonl': imported() });
  const scan = scanTranscriptCwds(sb.roots.codex, 'codex');
  assert.equal(scan.importedExcluded, 1);
  assert.equal(scan.sightings.length, 0);
  assert.equal(scan.complete, true);
  assert.equal(fs.existsSync(path.join(sb.dir, 'cache')), false);
});

// A reset can restart above the old imported total; last===total is explicit
// first-call evidence even when no monotonic field decreased.
test('a native counter reset above the imported baseline books the whole first call', () => {
  const r = imported().resetTotal().taskStarted('native-1').turn()
    .agent().tokenCount(usage({ input: 2000, cached: 400, output: 200 }));
  const s = parse(r).session;
  assert.equal(s.usage[0].input, 1600);
  assert.equal(s.usage[0].cacheRead, 400);
  assert.equal(s.usage[0].output, 200);
});

test('imported discovery excludes replayed native parent activity in a child with no own work', () => {
  const r = forkedSubagent({ parent: own(imported()), own: () => {} });
  const sb = codexSandbox({ 'rollout-child.jsonl': r });
  const scan = scanTranscriptCwds(sb.roots.codex, 'codex');
  assert.equal(scan.sightings.length, 0);
});

test('mixed streaming and string parsing agree without leaking copied context', async () => {
  const { openCodexRollout } = await import('../../src/lib/codex-rollout-reader.mjs');
  const r = own(imported());
  const sb = codexSandbox({ 'rollout-mixed.jsonl': r });
  const file = path.join(sb.roots.codex, '2026', '07', '24', 'rollout-mixed.jsonl');
  const source = openCodexRollout(file);
  {
    const streamed = parseCodex(source, { id: 'fallback', withTurns: true });
    assert.deepEqual(streamed, parse(r));
    assert.equal(JSON.stringify(streamed).includes('copied-model'), false);
  }
});

test('discovery reports ambiguous missing-ID activity as unresolved even at EOF', () => {
  const r = imported().raw('event_msg', { type: 'task_started' }).agent('unknown owner');
  const sb = codexSandbox({ 'rollout-ambiguous.jsonl': r });
  const scan = scanTranscriptCwds(sb.roots.codex, 'codex');
  assert.equal(scan.importedExcluded, 0);
  assert.equal(scan.importedUnresolved, 1);
  assert.equal(scan.complete, false);
});

test('discovery summary carries mixed and unresolved counts for consumers', () => {
  const sb = codexSandbox({ 'rollout-mixed.jsonl': own(imported()) });
  const result = discoverProjectSources({ claudeRoot: sb.roots.claude, codexRoot: sb.roots.codex,
    opencodeDbFile: path.join(sb.dir, 'absent.db') });
  assert.equal(result.importedMixed, 1);
  assert.equal(result.importedUnresolved, 0);
});

test('bounded import inspection honors a shared byte budget without reading payload bytes', async () => {
  const { inspectCodexImport } = await import('../../src/lib/footprint/codex-import-discovery.mjs');
  const sb = codexSandbox({ 'rollout-copy.jsonl': imported() });
  const file = path.join(sb.roots.codex, '2026', '07', '24', 'rollout-copy.jsonl');
  let reads = 0;
  const fsImpl = { ...fs, readSync: (...args) => { reads++; return fs.readSync(...args); } };
  const result = inspectCodexImport(file, { fsImpl, headBytes: 262144, budget: { remaining: 0 } });
  assert.equal(result.kind, 'unresolved');
  assert.equal(reads, 0);
});

test('a native interval wholly inside an unread gap cannot establish a project', () => {
  const r = imported().raw('response_item', { content: 'x'.repeat(300_000) });
  own(r).taskStarted('external-import-turn-2').raw('response_item', { content: 'y'.repeat(3_000_000) });
  const sb = codexSandbox({ 'rollout-gap.jsonl': r });
  const scan = scanTranscriptCwds(sb.roots.codex, 'codex');
  assert.equal(scan.importedMixed, 0);
  assert.equal(scan.importedUnresolved, 1);
  assert.deepEqual(scan.sightings, []);
});

test('streaming mixed files with clipped ownership evidence are excluded and disclosed', async () => {
  const { openCodexRollout } = await import('../../src/lib/codex-rollout-reader.mjs');
  const r = own(imported()).raw('event_msg', { type: 'item_completed', turn_id: 'external-import-turn-2',
    item: { type: 'FileChange', output: 'x'.repeat(9000) } }).agent('uncertain ownership');
  const sb = codexSandbox({ 'rollout-clipped.jsonl': r });
  const file = path.join(sb.roots.codex, '2026', '07', '24', 'rollout-clipped.jsonl');
  const result = parseCodex(openCodexRollout(file, { maxLineBytes: 4096 }), { id: 'fallback' });
  assert.equal(result.session.responses, 0);
  assert.equal(result.session.importEvidence.ownershipComplete, false);
  assert.equal(result.parseStats.clippedLines, 1);
});

test('import turn diagnostics remain bounded and disclose a truncated unique-turn count', () => {
  const r = imported();
  for (let i = 2; i <= 4097; i++) r.taskStarted(`external-import-turn-${i}`);
  const { session: s } = parse(r);
  assert.equal(s.importEvidence.importedTurns, 4096);
  assert.equal(s.importEvidence.importedTurnCountComplete, false);
  assert.equal(s.imported, true);
});

test('clipped mixed-file exclusion remains visible in cold and warm source-health diagnostics', async () => {
  const r = own(imported()).raw('response_item', { content: 'x'.repeat(9000) });
  const sb = codexSandbox({ 'rollout-clipped.jsonl': r });
  for (let i = 0; i < 2; i++) {
    _resetForTest();
    const a = await buildIndex({ days: 14, now: Date.parse('2026-07-25T12:00:00Z'),
      roots: sb.roots, cachePath: sb.cachePath, deps: stubDeps(),
      readLimits: { streamAboveBytes: 0, maxLineBytes: 4096 } });
    const d = a.sourceHealth.codex.diagnostics;
    assert.equal(a.totals.responses, 0);
    assert.equal(d.importOwnershipIncompleteFiles, 1);
    assert.equal(d.clippedLines, 1);
    assert.ok(d.warnings.includes('oversized-lines-clipped'));
  }
});
