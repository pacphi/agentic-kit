// Claude Code writes ONE transcript line per content block of an assistant
// message and repeats the same `message.usage` on every one of them. The parser
// must count a message ONCE (keyed by `message.id`, falling back to
// `requestId`), not once per line. Tool blocks are distinct lines and stay
// counted per block. Hermetic: pure parser calls plus tmpdir sandboxes — never
// ~/.claude or ~/.config/agentic-kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaude } from '../../src/lib/usage-parsers.mjs';
import { decodeClaudeRecord } from '../../src/lib/telemetry-records.mjs';
import { buildIndex, SCHEMA_VERSION, _resetForTest } from '../../src/lib/usage-index.mjs';
import { costOf, priceFor } from '../../src/lib/pricing.mjs';

const T0 = Date.parse('2026-08-20T10:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const line = (o) => JSON.stringify(o);

const USAGE = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 700 };

const prompt = (s = 0) => line({
  type: 'user', timestamp: at(s), message: { role: 'user', content: 'do the thing' },
});

/** One assistant transcript line — a single content block of message `id`. */
const asst = ({ id, s, block, usage = USAGE, model = 'claude-opus-5', requestId, extra = {} }) => line({
  type: 'assistant', timestamp: at(s), ...(requestId ? { requestId } : {}), ...extra,
  message: {
    role: 'assistant', model, ...(id ? { id } : {}), usage, content: block ? [block] : [],
  },
});

const text = (t = 'hi') => ({ type: 'text', text: t });
const toolUse = (n, name = 'Read') => ({ type: 'tool_use', id: `tu_${n}`, name, input: {} });

const parse = (lines) => parseClaude(lines.join('\n'), { id: 'sess', dirName: '-Users-me-proj' }).session;
const only = (rec) => {
  assert.equal(rec.usage.length, 1, 'one day/model row');
  return rec.usage[0];
};

test('decodeClaudeRecord exposes message.id, falling back to requestId', () => {
  assert.equal(decodeClaudeRecord({ type: 'assistant', message: { id: 'msg_1' } }).messageId, 'msg_1');
  assert.equal(decodeClaudeRecord({ type: 'assistant', requestId: 'req_9', message: {} }).messageId, 'req_9');
  assert.equal(decodeClaudeRecord({ type: 'assistant', message: { id: 'msg_1' }, requestId: 'req_9' }).messageId, 'msg_1');
  assert.equal(decodeClaudeRecord({ type: 'assistant', message: {} }).messageId, null);
});

test('a multi-line message with identical usage on every line counts once', () => {
  const rec = parse([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: { type: 'thinking', thinking: '...' } }),
    asst({ id: 'msg_A', s: 6, block: text() }),
    asst({ id: 'msg_A', s: 7, block: toolUse(1) }),
  ]);
  const row = only(rec);
  assert.equal(row.input, 10);
  assert.equal(row.output, 200);
  assert.equal(row.cacheRead, 5000);
  assert.equal(row.cacheWrite, 700);
  assert.equal(row.responses, 1);
  assert.equal(rec.responses, 1);
  assert.equal(Object.values(rec.punchcard).reduce((a, n) => a + n, 0), 1, 'punchcard counts the message once');
});

test('two distinct message ids count twice', () => {
  const rec = parse([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: text() }),
    asst({ id: 'msg_A', s: 6, block: toolUse(1) }),
    asst({ id: 'msg_B', s: 20, block: text() }),
  ]);
  const row = only(rec);
  assert.equal(row.output, 400);
  assert.equal(row.responses, 2);
  assert.equal(rec.responses, 2);
});

test('last line of an id wins when streamed usage grows', () => {
  const rec = parse([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: text(), usage: { ...USAGE, output_tokens: 12 } }),
    asst({ id: 'msg_A', s: 6, block: toolUse(1), usage: { ...USAGE, output_tokens: 200 } }),
  ]);
  assert.equal(only(rec).output, 200, 'not 12, not 212');
});

test('interleaved tool_result user lines do not split a message id', () => {
  const rec = parse([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: toolUse(1) }),
    line({ type: 'user', timestamp: at(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } }),
    asst({ id: 'msg_A', s: 7, block: toolUse(2) }),
  ]);
  assert.equal(only(rec).responses, 1);
  assert.equal(only(rec).output, 200);
});

test('a missing message id falls back to requestId, then to line identity', () => {
  const viaRequest = parse([
    prompt(),
    asst({ s: 5, block: text(), requestId: 'req_1' }),
    asst({ s: 6, block: toolUse(1), requestId: 'req_1' }),
  ]);
  assert.equal(only(viaRequest).responses, 1, 'requestId groups lines');

  const noIds = parse([
    prompt(),
    asst({ s: 5, block: text() }),
    asst({ s: 6, block: toolUse(1) }),
  ]);
  assert.equal(only(noIds).responses, 2, 'no id at all: every line is its own message, nothing merged or dropped');
  assert.equal(only(noIds).output, 400);
});

test('a synthetic API-error line neither bumps responses nor the punchcard', () => {
  const rec = parse([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: text() }),
    asst({
      s: 9, block: text('API Error'), model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 },
      extra: { isApiErrorMessage: true },
    }),
  ]);
  assert.equal(rec.exceptions, 1);
  assert.equal(rec.responses, 1, 'the placeholder is an exception, not a model response');
  assert.equal(Object.values(rec.punchcard).reduce((a, n) => a + n, 0), 1);
  assert.equal(only(rec).responses, 1);
  assert.ok(!rec.models.includes('<synthetic>'));
});

test('context samples are recorded once per message id, from its last line', () => {
  const rec = parse([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: text() }),
    asst({ id: 'msg_A', s: 6, block: toolUse(1) }),
    asst({ id: 'msg_B', s: 20, block: text(), usage: { ...USAGE, cache_read_input_tokens: 9000 } }),
    asst({ id: 'msg_B', s: 21, block: toolUse(2), usage: { ...USAGE, cache_read_input_tokens: 9000 } }),
  ]);
  assert.equal(rec.contextEvidence.input.samples, 2);
  assert.equal(rec.contextEvidence.input.first, 10 + 5000 + 700);
  assert.equal(rec.contextEvidence.input.last, 10 + 9000 + 700);
  assert.equal(rec.ctxLastTokens, 10 + 9000 + 700);
});

test('tool_use blocks are still counted per block (their lines are distinct)', () => {
  const rec = parse([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: toolUse(1, 'Read') }),
    asst({ id: 'msg_A', s: 6, block: toolUse(2, 'Read') }),
    asst({ id: 'msg_A', s: 7, block: toolUse(3, 'Bash') }),
  ]);
  assert.deepEqual(rec.tools, { Read: 2, Bash: 1 });
  assert.equal(only(rec).responses, 1, 'while the message itself counts once');
});

test('latency: the first real assistant line after a prompt still closes the sample', () => {
  const rec = parse([
    prompt(0),
    asst({ id: 'msg_A', s: 8, block: text() }),
    asst({ id: 'msg_A', s: 9, block: toolUse(1) }),
  ]);
  assert.equal(rec.latCount, 1);
  assert.equal(rec.latHist[2], 1, '8s → 5-10s bucket, taken from the first line');
});

test('usage is attributed to the last line\'s model and day', () => {
  const rec = parse([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: text(), model: 'claude-opus-5' }),
    asst({ id: 'msg_A', s: 6, block: toolUse(1), model: 'claude-opus-5' }),
    asst({ id: 'msg_B', s: 30, block: text(), model: 'claude-haiku-4-5' }),
  ]);
  assert.deepEqual(rec.usage.map((r) => [r.model, r.responses]).sort(), [['claude-haiku-4-5', 1], ['claude-opus-5', 1]]);
});

test('turn rows (reader path) are still emitted per transcript line', () => {
  const { turns } = parseClaude([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: text('one') }),
    asst({ id: 'msg_A', s: 6, block: text('two') }),
  ].join('\n'), { id: 'sess', dirName: 'd', withTurns: true });
  assert.equal(turns.filter((t) => t.role === 'assistant').length, 2);
});

// ── schema version ──────────────────────────────────────────────────────────

test('SCHEMA_VERSION is 22 and a v21 cache is discarded and re-parsed de-duplicated', async () => {
  assert.equal(SCHEMA_VERSION, 22, 'the de-dup correction changes every cached Claude record');
  _resetForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dedup-'));
  const proj = path.join(dir, 'claude', '-Users-me-proj');
  fs.mkdirSync(proj, { recursive: true });
  const base = Date.parse('2026-07-24T10:00:00.000Z');
  const mk = (s, id, block) => line({
    type: 'assistant', sessionId: 'dd1', cwd: '/Users/me/proj', timestamp: new Date(base + s * 1000).toISOString(),
    message: { role: 'assistant', id, model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 100 }, content: [block] },
  });
  fs.writeFileSync(path.join(proj, 'dd1.jsonl'), [
    line({ type: 'user', sessionId: 'dd1', cwd: '/Users/me/proj', timestamp: new Date(base).toISOString(), message: { role: 'user', content: 'go' } }),
    mk(5, 'msg_X', text()), mk(6, 'msg_X', toolUse(1)), mk(7, 'msg_X', toolUse(2)),
  ].join('\n') + '\n');
  const o = {
    days: 14, now: Date.parse('2026-07-25T12:00:00.000Z'),
    roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
    deps: { costOf: () => 0, pricesAsOf: 'x', classify: () => ({ category: 'Build', confidence: 1, basis: 'x' }), detectInsights: () => [] },
  };
  const fresh = await buildIndex(o);
  assert.equal(fresh.totals.output, 100);

  // Forge the pre-fix cache: same file key, v21 stamp, inflated 3x usage.
  const cache = JSON.parse(fs.readFileSync(o.cachePath, 'utf8'));
  cache.schemaVersion = 21;
  for (const entry of Object.values(cache.entries)) {
    for (const r of entry.session.usage) { r.output = 300; r.responses = 3; }
  }
  fs.writeFileSync(o.cachePath, JSON.stringify(cache));

  _resetForTest();
  const again = await buildIndex(o);
  assert.equal(again.totals.output, 100, 'stale inflated v21 record was re-parsed, not trusted');
});

// ── C-3: 1-hour cache writes ────────────────────────────────────────────────

test('decodeClaudeRecord retains the 5m/1h cache-write split, clamped to the total', () => {
  const split = decodeClaudeRecord({
    type: 'assistant',
    message: { usage: { cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 } } },
  }).usage;
  assert.equal(split.cacheWrite, 1000);
  assert.equal(split.cacheWrite1h, 600);
  const absent = decodeClaudeRecord({ type: 'assistant', message: { usage: { cache_creation_input_tokens: 50 } } }).usage;
  assert.equal(absent.cacheWrite1h, 0);
  const over = decodeClaudeRecord({
    type: 'assistant',
    message: { usage: { cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 999 } } },
  }).usage;
  assert.equal(over.cacheWrite1h, 10, 'never more than the total it is a subset of');
});

test('parseClaude accumulates cacheWrite1h onto the usage row, once per message id', () => {
  const u = { ...USAGE, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 } };
  const rec = parse([
    prompt(),
    asst({ id: 'msg_A', s: 5, block: text(), usage: u }),
    asst({ id: 'msg_A', s: 6, block: toolUse(1), usage: u }),
  ]);
  assert.equal(only(rec).cacheWrite, 1000);
  assert.equal(only(rec).cacheWrite1h, 600);
});

test('costOf prices 1h cache writes at 2x base input and the rest at 1.25x (Anthropic)', () => {
  const base = { model: 'claude-opus-5', input: 0, output: 0, cacheRead: 0 };
  const in$ = priceFor('claude-opus-5').in;
  const all5m = costOf({ ...base, cacheWrite: 1e6 });
  const half1h = costOf({ ...base, cacheWrite: 1e6, cacheWrite1h: 5e5 });
  const all1h = costOf({ ...base, cacheWrite: 1e6, cacheWrite1h: 1e6 });
  assert.equal(all5m, in$ * 1.25);
  assert.equal(all1h, in$ * 2);
  assert.equal(half1h, in$ * (0.5 * 1.25 + 0.5 * 2));
  // Absent split = every write is 5m, so historical callers price unchanged.
  assert.equal(costOf({ ...base, cacheWrite: 1e6, cacheWrite1h: undefined }), all5m);
});

test('rowCostEvidence carries the 1h split through to the pricer', async () => {
  const { rowCostEvidence } = await import('../../src/lib/usage-cost.mjs');
  const row = { day: '2026-08-20', model: 'claude-opus-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6, cacheWrite1h: 1e6, responses: 1 };
  const { estimatedUsd } = rowCostEvidence(row, { provider: 'claude' }, { costOf });
  assert.equal(estimatedUsd, priceFor('claude-opus-5').in * 2);
});

test('1h split does not change OpenAI pricing (no 1h tier)', () => {
  const base = { model: 'gpt-5.6-sol', input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 };
  assert.equal(costOf({ ...base, cacheWrite1h: 1e6 }), costOf(base));
});
