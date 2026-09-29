// Regression for lost or explicitly invalid ownership boundaries in mixed files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';
import { openCodexRollout } from '../../src/lib/codex-rollout-reader.mjs';
import { scanTranscriptCwds } from '../../src/lib/footprint/project-sources.mjs';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';
import { Rollout, usage, codexSandbox, stubDeps } from './helpers/codex-rollout.mjs';

function beforeGap({ nativeActivity = true, imports = true } = {}) {
  const r = new Rollout({ id: 'mixed' }).meta({ cwd: '/copied', originator: 'Codex Desktop' });
  if (imports) r.taskStarted('external-import-turn-1').agent('copy').tokenCount(usage({ input: 1000 }));
  r.taskStarted('native-1').turn('gpt-5.6', { turn_id: 'native-1', cwd: '/native' });
  if (nativeActivity) r.agent('own').tokenCount(usage({ input: 100 }));
  return r;
}
function afterGap(r) { return r.agent('owner-unproved').tokenCount(usage({ input: 500 })); }
function parseBoth(r) {
  const sb = codexSandbox({ 'rollout-gap.jsonl': r });
  const file = path.join(sb.roots.codex, '2026', '07', '24', 'rollout-gap.jsonl');
  return [parseCodex(String(r), { id: 'fallback' }),
    parseCodex(openCodexRollout(file, { chunkBytes: 37 }), { id: 'fallback' }),
    parseCodex(openCodexRollout(file), { id: 'fallback' })];
}
function assertExcluded(result) {
  assert.equal(result.session.responses, 0, 'incomplete mixed files are conservatively excluded');
  assert.deepEqual(result.session.usage, [], 'copied cumulative usage cannot enter native totals');
  assert.equal(result.session.importEvidence.ownershipComplete, false);
  assert.equal(result.session.imported, true);
}

for (const broken of ['{"type":"event_msg","payload":{"type":"task_started","turn_id":"external-import-turn-2"',
  'not-json', '[]', 'null']) {
  test(`string and streaming parsing disclose a lost ownership boundary: ${broken.slice(0, 12)}`, () => {
    const r = beforeGap();
    r.lines.push(broken);
    afterGap(r);
    for (const result of parseBoth(r)) {
      assertExcluded(result);
      assert.equal(result.session.importEvidence.malformedRecords, 1);
    }
    const sb = codexSandbox({ 'rollout-gap.jsonl': r });
    const scan = scanTranscriptCwds(sb.roots.codex, 'codex');
    assert.deepEqual(scan.sightings, []);
    assert.equal(scan.importedUnresolved, 1);
    assert.equal(scan.complete, false);
  });
}

test('string and streaming Codex imports keep whitespace-prefixed records fail closed', () => {
  const r = beforeGap();
  r.lines.push('  {"type":"event_msg","payload":{"type":"task_started","turn_id":"native-2"}}');
  afterGap(r);
  for (const result of parseBoth(r)) {
    assertExcluded(result);
    assert.equal(result.session.importEvidence.malformedRecords, 1);
  }
});

for (const turnId of [null, '', 'bad id', 1, {}, [], 'x'.repeat(257)]) {
  test(`explicitly invalid context ID breaks adjacency: ${JSON.stringify(turnId).slice(0, 24)}`, () => {
    const r = afterGap(beforeGap().turn('copied-model', { turn_id: turnId, cwd: '/copied' }));
    for (const result of parseBoth(r)) {
      assertExcluded(result);
      assert.ok(result.session.importEvidence.ambiguousRecords >= 3);
    }
    const noOwn = afterGap(beforeGap({ nativeActivity: false })
      .turn('copied-model', { turn_id: turnId, cwd: '/copied' }));
    const sb = codexSandbox({ 'rollout-gap.jsonl': noOwn });
    const scan = scanTranscriptCwds(sb.roots.codex, 'codex');
    assert.deepEqual(scan.sightings, [], 'unproved native adjacency must not establish an app or project');
    assert.equal(scan.importedMixed, 0);
    assert.equal(scan.importedUnresolved, 1);
    assert.equal(scan.complete, false);
    assert.equal(scan.sessionCountComplete, false);
  });
}

test('absent context ID can enrich an identified native turn without breaking ownership', () => {
  const r = afterGap(beforeGap().turn('gpt-5.6', { cwd: '/native' }));
  for (const result of parseBoth(r)) {
    assert.equal(result.session.responses, 2);
    assert.equal(result.session.usage[0].input, 600);
    assert.equal(result.session.importEvidence.ownershipComplete, true);
  }
});

test('all-native legacy files retain their permissive skip behavior', () => {
  const r = beforeGap({ imports: false });
  r.lines.push('{bad-json');
  afterGap(r.turn('gpt-5.6', { turn_id: null }));
  for (const result of parseBoth(r)) {
    assert.equal(result.session.responses, 2);
    assert.equal(result.session.usage[0].input, 600);
    assert.equal(result.session.imported, undefined);
  }
});

test('malformed mixed-file ownership remains disclosed in cold and warm index diagnostics', async () => {
  const r = beforeGap();
  r.lines.push('{broken-boundary');
  afterGap(r);
  for (const streamAboveBytes of [0, 1_000_000]) {
    const sb = codexSandbox({ 'rollout-gap.jsonl': r });
    for (let n = 0; n < 2; n++) {
      _resetForTest();
      const a = await buildIndex({ days: 14, now: Date.parse('2026-07-25T12:00:00Z'), roots: sb.roots,
        cachePath: sb.cachePath, deps: stubDeps(), readLimits: { streamAboveBytes } });
      assert.equal(a.totals.responses, 0);
      assert.equal(a.totals.input, 0);
      assert.equal(a.sourceHealth.codex.diagnostics.importOwnershipIncompleteFiles, 1);
    }
  }
});
