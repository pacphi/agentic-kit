// Oversized Codex rollouts (ADR-0052): a >512 MB rollout used to throw
// ERR_STRING_TOO_LONG in readFileSync and silently vanish from the scorecard.
// A bounded-memory chunked reader now feeds the SAME parser, and anything that
// still cannot be parsed is reported. Hermetic: tmpdir files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';
import { openCodexRollout } from '../../src/lib/codex-rollout-reader.mjs';
import { Rollout, usage, codexSandbox, stubDeps, forkedSubagent } from './helpers/codex-rollout.mjs';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const opts = (sb, extra = {}) => ({
  days: 14, now: NOW, roots: sb.roots, cachePath: sb.cachePath, deps: stubDeps(), ...extra,
});

function tmpFile(body, name = 'rollout.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-codex-reader-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

const collect = (source) => [...source.lines];

// ── the reader itself ───────────────────────────────────────────────────────

test('reader: yields exactly the objects the string path would, across any chunk size', () => {
  const objects = [
    { type: 'session_meta', payload: { id: 'é☃𝄞', cwd: '/tmp/ü' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'multi-byte: 日本語 🚀   line-sep' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(500) } },
  ];
  const body = objects.map((o) => JSON.stringify(o)).join('\n'); // no trailing newline
  const file = tmpFile(body);
  for (const chunkBytes of [1, 2, 3, 7, 64, 1000, 1 << 20]) {
    assert.deepEqual(collect(openCodexRollout(file, { chunkBytes })), objects, `chunkBytes=${chunkBytes}`);
  }
});

test('reader: skips blank, non-object and malformed lines, like the string path', () => {
  const good = { type: 'event_msg', payload: { type: 'agent_message', message: 'ok' } };
  const file = tmpFile(['', 'not json', '[1,2]', '{"broken":', JSON.stringify(good), '   ', ''].join('\n'));
  assert.deepEqual(collect(openCodexRollout(file, { chunkBytes: 5 })), [good]);
});

test('reader: an oversized line is clipped to its identifying head, never held or parsed', () => {
  const huge = JSON.stringify({
    timestamp: '2026-07-24T09:00:00.000Z', ordinal: 7, type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'CommandExecution', aggregated_output: 'y'.repeat(50_000) } },
  });
  const skipped = JSON.stringify({
    timestamp: '2026-07-24T09:00:01.000Z', ordinal: 8, type: 'response_item',
    payload: { type: 'function_call_output', output: 'z'.repeat(50_000) },
  });
  const after = { timestamp: '2026-07-24T09:00:02.000Z', ordinal: 9, type: 'event_msg', payload: { type: 'agent_message', message: 'still here' } };
  const file = tmpFile([huge, skipped, JSON.stringify(after)].join('\n') + '\n');
  const source = openCodexRollout(file, { chunkBytes: 4096, maxLineBytes: 8192 });
  const got = collect(source);
  assert.equal(got.length, 2, 'the oversized response_item carries nothing the parser needs and is dropped');
  assert.deepEqual(got[0], {
    timestamp: '2026-07-24T09:00:00.000Z', ordinal: 7, type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'CommandExecution' } }, clipped: true,
  });
  assert.deepEqual(got[1], after);
  assert.equal(source.stats.clippedLines, 2, 'both oversized lines are counted, not silently dropped');
});

test('reader: a line that ends exactly at the limit is parsed, one byte over is clipped', () => {
  const at = (n) => {
    const o = { type: 'event_msg', payload: { type: 'agent_message', message: '' } };
    const pad = n - Buffer.byteLength(JSON.stringify(o));
    o.payload.message = 'p'.repeat(pad);
    return JSON.stringify(o);
  };
  const exact = at(300);
  assert.equal(Buffer.byteLength(exact), 300);
  const file = tmpFile(`${exact}\n${at(301)}\n`);
  const source = openCodexRollout(file, { chunkBytes: 50, maxLineBytes: 300 });
  const got = collect(source);
  assert.equal(got.length, 2);
  assert.equal(got[0].clipped, undefined);
  assert.equal(got[1].clipped, true);
  assert.equal(source.stats.clippedLines, 1);
});

test('reader: iterating twice re-reads the file and resets the clip count', () => {
  const file = tmpFile(`${JSON.stringify({ type: 'a' })}\n${'{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning"}},"pad":"'}${'q'.repeat(400)}"}\n`);
  const source = openCodexRollout(file, { chunkBytes: 32, maxLineBytes: 200 });
  assert.equal(collect(source).length, 2);
  assert.equal(source.stats.clippedLines, 1);
  assert.equal(collect(source).length, 2);
  assert.equal(source.stats.clippedLines, 1, 'a second pass does not double-count');
});

test('reader: exposes the head of the file for session-origin detection', () => {
  const file = tmpFile(`${JSON.stringify({ type: 'session_meta', payload: { id: 'h' } })}\n${'x'.repeat(400_000)}\n`);
  const { head } = openCodexRollout(file);
  assert.ok(head.startsWith('{"type":"session_meta"'));
  assert.ok(head.length <= 256 * 1024);
});

test('reader: a pass reads only the bytes that existed when it started (an active rollout cannot run it forever)', () => {
  const file = tmpFile(`${JSON.stringify({ type: 'a' })}\n${JSON.stringify({ type: 'b' })}\n`);
  const source = openCodexRollout(file, { chunkBytes: 4 });
  const it = source.lines[Symbol.iterator]();
  assert.deepEqual(it.next().value, { type: 'a' }, 'the pass has started');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'late' })}\n`);
  assert.deepEqual([...it], [{ type: 'b' }], 'the appended line belongs to the next pass');
  assert.deepEqual(collect(source), [{ type: 'a' }, { type: 'b' }, { type: 'late' }]);
});

test('reader: an unopenable file throws a coded fs error the caller can classify', () => {
  assert.throws(() => openCodexRollout(path.join(os.tmpdir(), 'ak-does-not-exist', 'rollout.jsonl')), { code: 'ENOENT' });
});

// ── parse equivalence: string path vs streaming path ────────────────────────

function richRollout() {
  const parent = new Rollout({ id: 'parent' }).meta().turn('gpt-5.6')
    .at('2026-07-22T12:00:00.000Z').user('p one').item('CommandExecution').agent('a')
    .tokenCount(usage({ input: 1000, cached: 200, output: 100 }), { window: 200_000 })
    .at('2026-07-23T12:00:00.000Z').user('p two').agent('b')
    .tokenCount(usage({ input: 2000, cached: 900, output: 200 }), { window: 200_000 });
  return forkedSubagent({
    parent,
    own: (r) => r.at('2026-07-24T09:00:00.000Z').agent('own').item('CommandExecution')
      .tokenCount(usage({ input: 1500, cached: 300, output: 150, reasoning: 20 }), { window: 200_000 })
      .resetTotal().turn('gpt-5.6-mini').agent('own two').tokenCount(usage({ input: 400, output: 40 })),
  });
}

test('parse equivalence: the streaming source produces the same record and stats as the string', () => {
  const body = richRollout().toString();
  const file = tmpFile(body);
  const fromString = parseCodex(body, { id: 'child' });
  for (const chunkBytes of [3, 97, 4096]) {
    const fromStream = parseCodex(openCodexRollout(file, { chunkBytes }), { id: 'child' });
    assert.deepEqual(fromStream.session, fromString.session, `session, chunkBytes=${chunkBytes}`);
    assert.deepEqual(fromStream.parseStats, fromString.parseStats, `parseStats, chunkBytes=${chunkBytes}`);
  }
});

test('parse equivalence: an oversized tool line still tallies its tool and counts as clipped', () => {
  const r = new Rollout({ id: 'big' }).meta().turn('gpt-5.6').user('go');
  r.raw('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', aggregated_output: 'o'.repeat(20_000) } });
  r.agent('done').tokenCount(usage({ input: 100, output: 10 }));
  const file = tmpFile(r.toString());
  const { session, parseStats } = parseCodex(openCodexRollout(file, { chunkBytes: 1024, maxLineBytes: 4096 }), { id: 'big' });
  assert.equal(session.tools.CommandExecution, 1);
  assert.equal(session.responses, 1);
  assert.equal(parseStats.clippedLines, 1);
});

// ── through the index ───────────────────────────────────────────────────────

test('index: forcing the streaming path yields the identical aggregate', async () => {
  const files = { 'rollout-2026-07-24T09-00-00-child.jsonl': richRollout() };
  _resetForTest();
  const viaString = await buildIndex(opts(codexSandbox(files)));
  _resetForTest();
  const viaStream = await buildIndex(opts(codexSandbox(files), { readLimits: { streamAboveBytes: 0, chunkBytes: 61 } }));
  const strip = (agg) => ({ sessions: agg.sessions, totals: agg.totals, byDay: agg.byDay, byModel: agg.byModel });
  assert.deepEqual(strip(viaStream), strip(viaString));
  assert.equal(viaStream.sourceHealth.codex.diagnostics.unparsedFiles, 0);
});

test('index: an unreadable rollout is reported as an unparsed file with its reason, not silently dropped', async (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) {
    t.skip('needs POSIX permissions and a non-root user');
    return;
  }
  _resetForTest();
  const sb = codexSandbox({
    'rollout-2026-07-24T09-00-00-ok.jsonl': new Rollout({ id: 'ok' }).meta().turn().user().agent().tokenCount(usage({ input: 10, output: 1 })),
    'rollout-2026-07-24T09-05-00-locked.jsonl': new Rollout({ id: 'locked' }).meta().turn().user().agent(),
  });
  const locked = path.join(sb.dir, 'codex', '2026', '07', '24', 'rollout-2026-07-24T09-05-00-locked.jsonl');
  fs.chmodSync(locked, 0o000);
  try {
    const agg = await buildIndex(opts(sb));
    const d = agg.sourceHealth.codex.diagnostics;
    assert.equal(d.unparsedFiles, 1);
    assert.deepEqual(d.unparsedReasons, { 'read-error': 1 });
    assert.ok(d.warnings.includes('unparsed-rollouts'));
    assert.deepEqual(agg.sessions.map((s) => s.id), ['ok']);
  } finally {
    fs.chmodSync(locked, 0o600);
  }
});

test('index: a clipped oversized line is counted in the codex diagnostics and raises a warning', async () => {
  _resetForTest();
  const r = new Rollout({ id: 'clip' }).meta().turn('gpt-5.6').user('go');
  r.raw('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', aggregated_output: 'o'.repeat(20_000) } });
  r.agent('done').tokenCount(usage({ input: 100, output: 10 }));
  const sb = codexSandbox({ 'rollout-2026-07-24T09-00-00-clip.jsonl': r });
  const agg = await buildIndex(opts(sb, { readLimits: { streamAboveBytes: 0, chunkBytes: 1024, maxLineBytes: 4096 } }));
  const d = agg.sourceHealth.codex.diagnostics;
  assert.equal(d.clippedLines, 1);
  assert.ok(d.warnings.includes('oversized-lines-clipped'));
  assert.equal(agg.sessions[0].tools.CommandExecution, 1);
});
