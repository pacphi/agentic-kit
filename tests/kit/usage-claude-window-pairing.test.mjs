// A Claude context-pressure sample exists exactly when a statusline-ledger
// window covers the message (ADR-0042). parseClaude stays pure: the window log
// arrives as an option, never read from disk here. Hermetic: pure parser calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../../src/lib/usage-parsers.mjs';

const T0 = Date.parse('2026-08-20T10:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const line = (o) => JSON.stringify(o);

const asst = (id, s, { input = 100_000, cacheRead = 0, cacheWrite = 0 } = {}) => line({
  type: 'assistant', timestamp: at(s),
  message: {
    role: 'assistant', id, model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
  },
});
const prompt = (s) => line({ type: 'user', timestamp: at(s), message: { role: 'user', content: 'go' } });

const parse = (lines, opts = {}) => parseClaude(lines.join('\n'), { id: 'sess', dirName: '-p', ...opts }).session;
const ent = (s, size, model = 'm') => ({ t: T0 + s * 1000, size, model });

test('no window log: input-only exactly as before (partial, no pressure, no window)', () => {
  const rec = parse([prompt(0), asst('m1', 5, { input: 200_000 })]);
  assert.equal(rec.contextEvidence.state, 'partial');
  assert.equal(rec.contextEvidence.pressure, null);
  assert.equal(rec.contextEvidence.window, null);
  assert.equal(rec.contextEvidence.input.peak, 200_000);
  assert.equal(rec.ctxWindow ?? null, null);
  for (const windowLog of [null, undefined, [], 'garbage']) {
    assert.equal(parse([prompt(0), asst('m1', 5)], { windowLog }).contextEvidence.pressure, null);
  }
});

test('a covering window yields an observed, runtime-provenance pressure sample from gross input', () => {
  const rec = parse(
    [prompt(0), asst('m1', 5, { input: 10_000, cacheRead: 300_000, cacheWrite: 40_000 })],
    { windowLog: [ent(0, 1_000_000)] },
  );
  const ev = rec.contextEvidence;
  assert.equal(ev.state, 'observed');
  assert.equal(ev.window.provenance, 'runtime-observed');
  assert.equal(ev.window.last, 1_000_000);
  assert.equal(ev.pressure.samples, 1);
  assert.equal(ev.pressure.peakBps, 3500, '350,000 gross input / 1,000,000');
  assert.equal(rec.ctxWindow, 1_000_000);
});

test('the window in effect at each message is used across a mid-session change', () => {
  const rec = parse(
    [
      prompt(0), asst('m1', 5, { input: 100_000 }),   // 200K window -> 50.00%
      prompt(60), asst('m2', 65, { input: 100_000 }), // switched to 1M -> 10.00%
    ],
    { windowLog: [ent(0, 200_000, 'a'), ent(30, 1_000_000, 'b')] },
  );
  const p = rec.contextEvidence.pressure;
  assert.equal(p.samples, 2);
  assert.equal(p.firstBps, 5000);
  assert.equal(p.lastBps, 1000);
  assert.equal(p.peakBps, 5000);
  assert.equal(rec.contextEvidence.window.min, 200_000);
  assert.equal(rec.contextEvidence.window.max, 1_000_000);
});

test('messages the ledger does not cover stay input-only while covered ones get pressure', () => {
  const rec = parse(
    [
      prompt(0), asst('m1', 5, { input: 100_000 }),        // 1h+ before the first entry: unknown window
      prompt(7300), asst('m2', 7305, { input: 100_000 }),  // covered
    ],
    { windowLog: [ent(7200, 1_000_000)] },
  );
  const ev = rec.contextEvidence;
  assert.equal(ev.input.samples, 2, 'both messages still carry input evidence');
  assert.equal(ev.pressure.samples, 1, 'only the covered message is a pressure sample');
  assert.equal(ev.state, 'observed');
});

test('a message shortly before the first entry takes the first window (lead tolerance)', () => {
  const rec = parse([prompt(0), asst('m1', 5)], { windowLog: [ent(20, 1_000_000)] });
  assert.equal(rec.contextEvidence.pressure.samples, 1);
});

test('a session with no covered message stays partial', () => {
  const rec = parse([prompt(0), asst('m1', 5)], { windowLog: [ent(7200, 1_000_000)] });
  assert.equal(rec.contextEvidence.state, 'partial');
  assert.equal(rec.contextEvidence.pressure, null);
});

test('a message with no token evidence yields no sample even when a window covers it', () => {
  const rec = parse([prompt(0), asst('m1', 5, { input: 0 })], { windowLog: [ent(0, 1_000_000)] });
  const ev = rec.contextEvidence;
  assert.equal(ev.state, 'not-recorded');
  assert.deepEqual([ev.input, ev.window, ev.pressure], [null, null, null]);
});
