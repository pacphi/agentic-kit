// Claude Code writes ONE transcript line per content block of an assistant
// message and repeats the same `message.usage` on every one of them. The parser
// must count a message ONCE (keyed by `message.id`, falling back to
// `requestId`), not once per line. Tool blocks are distinct lines and stay
// counted per block. Hermetic: pure parser calls plus tmpdir sandboxes — never
// ~/.claude or ~/.config/agentic-kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseClaude } from '../../src/lib/usage-parsers.mjs';
import { reconcileClaudeMessages } from '../../src/lib/usage-claude-dedup.mjs';
import { decodeClaudeRecord } from '../../src/lib/telemetry-records.mjs';
import { buildIndex, SCHEMA_VERSION, _resetForTest } from '../../src/lib/usage-index.mjs';
import { costOf, priceFor } from '../../src/lib/pricing.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const T0 = Date.parse('2026-08-20T10:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const dayAt = (s) => {
  const d = new Date(at(s));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
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

test('cross-file copies charge one richest message while source sessions keep their response counts', () => {
  const a = parse([prompt(), asst({ id: 'msg_shared', s: 5, block: text(), usage: { ...USAGE, output_tokens: 12 } })]);
  const b = parse([prompt(), asst({ id: 'msg_shared', s: 6, block: text(), usage: { ...USAGE, output_tokens: 200 } })]);
  a.id = 'a'; b.id = 'b';
  const [aa, bb] = reconcileClaudeMessages([a, b]);
  assert.equal(a.responses + b.responses, 2, 'cached transcript observations are untouched');
  assert.equal(aa.responses + bb.responses, 2, 'session counts still describe each file');
  assert.equal(aa.accountedResponses + bb.accountedResponses, 1);
  assert.equal(aa.usage[0].output + bb.usage[0].output, 200);
  assert.equal(aa.usage[0].cacheRead + bb.usage[0].cacheRead, 5000);
  assert.equal(aa.usage[0].responses + bb.usage[0].responses, 1);
  assert.deepEqual(reconcileClaudeMessages([b, a]).map((r) => [r.id, r.usage[0].output]),
    [[bb.id, bb.usage[0].output], [aa.id, aa.usage[0].output]], 'file traversal cannot elect a different charge');
});

test('missing IDs and distinct same-count IDs never collapse across files', () => {
  const a = parse([prompt(), asst({ s: 5, block: text() }), asst({ id: 'msg_one', s: 6, block: text() })]);
  const b = parse([prompt(), asst({ s: 5, block: text() }), asst({ id: 'msg_two', s: 6, block: text() })]);
  const rows = reconcileClaudeMessages([a, b]);
  assert.equal(rows.reduce((n, r) => n + r.accountedResponses, 0), 4);
  assert.equal(rows.reduce((n, r) => n + r.usage[0].output, 0), 800);
});

test('malformed repeated identifiers are not cross-file identity proof', () => {
  const a = parse([asst({ id: 'not-an-api-message-id', s: 5, block: text() })]);
  const b = parse([asst({ id: 'not-an-api-message-id', s: 5, block: text() })]);
  const rows = reconcileClaudeMessages([a, b]);
  assert.equal(rows.reduce((n, r) => n + r.accountedResponses, 0), 2);
  assert.equal(rows.reduce((n, r) => n + r.usage[0].output, 0), 400);
});

test('message ID, request ID and serving-provider namespaces stay separate', () => {
  const plain = parse([asst({ id: 'same', s: 5, block: text() })]);
  const request = parse([asst({ requestId: 'same', s: 5, block: text() })]);
  const bedrock = parse([asst({ id: 'same', s: 5, block: text(), model: 'us.anthropic.claude-sonnet-4-20250514-v1:0' })]);
  const rows = reconcileClaudeMessages([plain, request, bedrock]);
  assert.equal(rows.reduce((n, r) => n + r.accountedResponses, 0), 3);
  assert.equal(rows.reduce((n, r) => n + r.usage[0].output, 0), 600);
});

test('partial copied snapshots reconcile component maxima once', () => {
  const a = parse([asst({ id: 'msg_partial', s: 5, block: text(), usage: { ...USAGE, cache_read_input_tokens: 0 } })]);
  const b = parse([asst({ id: 'msg_partial', s: 6, block: text(), usage: { ...USAGE, output_tokens: 20 } })]);
  const rows = reconcileClaudeMessages([a, b]);
  assert.equal(rows.reduce((n, r) => n + r.usage[0].output, 0), 200);
  assert.equal(rows.reduce((n, r) => n + r.usage[0].cacheRead, 0), 5000);
  assert.equal(rows.reduce((n, r) => n + r.accountedResponses, 0), 1);
});

test('equal claims have a stable accounting owner when sidechain and source differ', () => {
  const main = parse([asst({ id: 'msg_tie', s: 5, block: text() })]);
  const side = parse([asst({ id: 'msg_tie', s: 5, block: text() })]);
  main.sidechain = false; side.sidechain = true;
  main.claudeSourceKey = 'a'; side.claudeSourceKey = 'b';
  const forward = reconcileClaudeMessages([main, side]);
  const reverse = reconcileClaudeMessages([side, main]);
  assert.equal(forward.find((r) => r.claudeSourceKey === 'a').accountedResponses, 1);
  assert.equal(reverse.find((r) => r.claudeSourceKey === 'a').accountedResponses, 1);
  assert.equal(forward.find((r) => r.claudeSourceKey === 'b').accountedResponses, 0);
  assert.equal(reverse.find((r) => r.claudeSourceKey === 'b').accountedResponses, 0);
  const x = parse([asst({ id: 'msg_same_metadata', s: 5, block: text() })]);
  const y = parse([asst({ id: 'msg_same_metadata', s: 5, block: text() })]);
  x.claudeSourceKey = 'x'; y.claudeSourceKey = 'y';
  assert.equal(reconcileClaudeMessages([x, y]).find((r) => r.claudeSourceKey === 'x').accountedResponses, 1);
  assert.equal(reconcileClaudeMessages([y, x]).find((r) => r.claudeSourceKey === 'x').accountedResponses, 1,
    'source identity settles a tie even when every visible session field matches');
});

test('one identity is charged once across current, previous and combined windows regardless of lookback', async () => {
  _resetForTest();
  const dir = tempDir('ak-cross-window');
  const root = path.join(dir, 'claude');
  const proj = path.join(root, '-Users-me-proj');
  fs.mkdirSync(proj, { recursive: true });
  const oldFile = path.join(proj, 'old.jsonl');
  const newFile = path.join(proj, 'new.jsonl');
  const write = (file, s, output) => {
    fs.writeFileSync(file, [prompt(s), asst({ id: 'msg_shared', s: s + 5, block: text(),
      usage: { ...USAGE, output_tokens: output } })].join('\n') + '\n');
    fs.utimesSync(file, new Date(at(s)), new Date(at(s + 5)));
  };
  write(oldFile, 0, 200);
  write(newFile, 86_400, 100);
  const o = { days: 1, now: T0 + 2 * 86_400_000,
    roots: { claude: root, codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'usage-index.json'), codexState: null,
    deps: { costOf: ({ output }) => output / 100, pricesAsOf: 'fixture',
      classify: () => ({ category: 'Build', confidence: 1, basis: 'fixture' }), detectInsights: () => [] } };
  const plain = await buildIndex(o);
  assert.equal(plain.totals.output, 0, 'the richer older copy is the single accounting owner');
  assert.equal(plain.totals.responses, 0);
  assert.equal(plain.totals.cost, 0);
  assert.deepEqual(plain.sourceHealth.claude.identityCoverage,
    { horizonDays: 2, horizonCoversComparison: true, basis: 'file-mtime-and-session-end' });
  _resetForTest();
  const widenedCurrent = await buildIndex({ ...o, lookbackDays: 2 });
  assert.equal(widenedCurrent.totals.output, plain.totals.output);
  assert.equal(widenedCurrent.totals.responses, plain.totals.responses);
  _resetForTest();
  const widened = await buildIndex({ ...o, lookbackDays: 2, previous: true });
  assert.equal(widened.totals.output, plain.totals.output, 'comparison cannot change the displayed charge');
  assert.equal(widened.totals.responses, plain.totals.responses);
  assert.equal(widened.previous.totals.output, 200);
  assert.equal(widened.previous.totals.responses, 1);
  assert.equal(widened.previous.totals.cost, 2);
  _resetForTest();
  const combined = await buildIndex({ ...o, days: 2 });
  assert.equal(combined.totals.output, 200);
  assert.equal(combined.totals.responses, 1);
  assert.equal(combined.totals.cost, 2);
  assert.equal(widened.totals.output + widened.previous.totals.output, combined.totals.output);
  assert.equal(widened.totals.responses + widened.previous.totals.responses, combined.totals.responses);
  _resetForTest();
  const warmPlain = await buildIndex(o);
  assert.equal(warmPlain.totals.output, plain.totals.output);
  const outsideFile = path.join(proj, 'outside.jsonl');
  write(outsideFile, -86_400, 300);
  _resetForTest();
  const longLookback = await buildIndex({ ...o, lookbackDays: 5, previous: true });
  assert.equal(longLookback.totals.output, plain.totals.output,
    'a third copy outside the fixed accounting horizon cannot change current ownership');
  assert.equal(longLookback.previous.totals.output, 200);
  _resetForTest();
  assert.equal((await buildIndex(o)).totals.output, plain.totals.output,
    'cached older history cannot change the plain query');
  _resetForTest();
  const capped = await buildIndex({ ...o, days: 400 });
  assert.deepEqual(capped.sourceHealth.claude.identityCoverage,
    { horizonDays: 730, horizonCoversComparison: false, basis: 'file-mtime-and-session-end' },
    'a caller wider than the supported dashboard window sees the identity cap');
});

test('equal copied usage still yields one charge across adjacent windows', async () => {
  _resetForTest();
  const dir = tempDir('ak-equal-cross-window');
  const root = path.join(dir, 'claude');
  const proj = path.join(root, '-Users-me-proj');
  fs.mkdirSync(proj, { recursive: true });
  for (const [name, seconds] of [['old', 0], ['new', 86_400]]) {
    const file = path.join(proj, `${name}.jsonl`);
    fs.writeFileSync(file, asst({ id: 'msg_equal', s: seconds + 5, block: text() }) + '\n');
    fs.utimesSync(file, new Date(at(seconds)), new Date(at(seconds + 5)));
  }
  const o = { days: 1, now: T0 + 2 * 86_400_000,
    roots: { claude: root, codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'usage-index.json'), codexState: null,
    deps: { costOf: ({ output }) => output / 100, pricesAsOf: 'fixture',
      classify: () => ({ category: 'Build', confidence: 1, basis: 'fixture' }), detectInsights: () => [] } };
  const split = await buildIndex({ ...o, previous: true });
  assert.equal(split.previous.totals.sessions, 1, 'comparison is acquired within the common identity horizon');
  _resetForTest();
  const combined = await buildIndex({ ...o, days: 2 });
  assert.equal(split.totals.output + split.previous.totals.output, 200);
  assert.equal(split.totals.responses + split.previous.totals.responses, 1);
  assert.equal(combined.totals.output, 200);
  assert.equal(combined.totals.responses, 1);
  assert.equal(split.totals.cost + split.previous.totals.cost, combined.totals.cost);
});

test('malformed cached Claude claim is reparsed instead of crashing or trusted', async () => {
  _resetForTest();
  const dir = tempDir('ak-malformed-claims');
  const root = path.join(dir, 'claude');
  const proj = path.join(root, '-Users-me-proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'one.jsonl');
  fs.writeFileSync(file, asst({ id: 'msg_one', s: 5, block: text() }) + '\n');
  const o = { days: 14, now: T0 + 86_400_000,
    roots: { claude: root, codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'usage-index.json'), codexState: null,
    deps: { costOf: () => 0, pricesAsOf: 'fixture',
      classify: () => ({ category: 'Build', confidence: 1, basis: 'fixture' }), detectInsights: () => [] } };
  assert.equal((await buildIndex(o)).totals.output, 200);
  const original = JSON.parse(fs.readFileSync(o.cachePath, 'utf8'));
  const claim = original.entries[file].session.claudeMessages[0];
  for (const malformed of [[null], [{ ...claim, usage: { ...claim.usage, output: 201 } }],
    [claim, claim]]) {
    const cache = structuredClone(original);
    cache.entries[file].session.claudeMessages = malformed;
    fs.writeFileSync(o.cachePath, JSON.stringify(cache));
    _resetForTest();
    assert.equal((await buildIndex(o)).totals.output, 200);
    const repaired = JSON.parse(fs.readFileSync(o.cachePath, 'utf8'));
    assert.equal(repaired.entries[file].session.claudeMessages.length, 1);
    assert.equal(typeof repaired.entries[file].session.claudeMessages[0].identity, 'string');
  }
});

test('invalid cached claims do not mask a source that becomes unreadable before reparse', async () => {
  _resetForTest();
  const dir = tempDir('ak-claim-fallback');
  const root = path.join(dir, 'claude');
  const proj = path.join(root, '-Users-me-proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'one.jsonl');
  fs.writeFileSync(file, asst({ id: 'msg_one', s: 5, block: text() }) + '\n');
  const o = { days: 14, now: T0 + 86_400_000,
    roots: { claude: root, codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'usage-index.json'), codexState: null,
    deps: { costOf: () => 0, pricesAsOf: 'fixture',
      classify: () => ({ category: 'Build', confidence: 1, basis: 'fixture' }), detectInsights: () => [] } };
  await buildIndex(o);
  const cache = JSON.parse(fs.readFileSync(o.cachePath, 'utf8'));
  cache.entries[file].session.claudeMessages = [null];
  fs.writeFileSync(o.cachePath, JSON.stringify(cache));
  _resetForTest();
  const result = await buildIndex({ ...o, onProgress: ({ phase, scanned }) => {
    if (phase === 'scan' && scanned === 0) {
      fs.unlinkSync(file);
      fs.mkdirSync(file); // still stats, but is no longer a readable transcript
    }
  } });
  assert.equal(result.totals.sessions, 0, 'an invalid cache is not a fallback observation');
  assert.equal(result.sourceHealth.claude.status, 'degraded');
  assert.equal(result.sourceHealth.claude.diagnostics.common.unitsSeen, 1);
  assert.equal(result.sourceHealth.claude.diagnostics.common.unitsParsed, 0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(o.cachePath, 'utf8')).entries).length, 0);
});

test('index keeps cross-file accounting on cold, warm, add, change and removal scans', async () => {
  _resetForTest();
  const dir = tempDir('ak-cross-file');
  const root = path.join(dir, 'claude');
  const proj = path.join(root, '-Users-me-proj');
  const other = path.join(root, '-Users-me-other');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const a = path.join(proj, 'a.jsonl');
  const b = path.join(other, 'b.jsonl');
  const c = path.join(proj, 'c.jsonl');
  const write = (file, messages) => fs.writeFileSync(file,
    [prompt(), ...messages].join('\n') + '\n');
  write(a, [asst({ id: 'msg_shared', s: 5, block: text(), usage: { ...USAGE, output_tokens: 12 } })]);
  write(b, [asst({ id: 'msg_shared', s: 86_406, block: text(), usage: USAGE })]);
  const o = { days: 14, now: T0 + 2 * 86_400_000,
    roots: { claude: root, codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'usage-index.json'), codexState: null,
    deps: { costOf: ({ output }) => output / 100, pricesAsOf: 'fixture',
      classify: () => ({ category: 'Build', confidence: 1, basis: 'fixture' }), detectInsights: () => [] } };
  const check = (result, count, output, responses, sharedProject) => {
    assert.equal(result.totals.sessions, count);
    assert.equal(result.totals.responses, responses);
    assert.equal(result.totals.output, output);
    assert.equal(result.totals.cost, output / 100);
    assert.equal(result.totals.tokens, result.totals.input + result.totals.output
      + result.totals.cacheRead + result.totals.cacheWrite);
    assert.equal(Object.values(result.byDay).reduce((n, row) => n + row.tokens, 0), result.totals.tokens);
    assert.ok(result.byDay[dayAt(sharedProject === 'other' ? 86_406 : 5)].tokens > 0,
      'the elected copy owns its local billing day');
    assert.equal(Object.values(result.byModel).reduce((n, row) => n + row.output, 0), output);
    assert.equal(Object.values(result.byProvider).reduce((n, row) => n + row.output, 0), output);
    assert.equal(Object.values(result.byProject).reduce((n, row) => n + row.output, 0), output);
    assert.equal(result.byProject[sharedProject].output,
      sharedProject === 'other' ? output - (count === 3 ? 200 : 0) : output);
    assert.equal(Object.values(result.bySource).reduce((n, row) => n + row.responses, 0), responses);
    assert.equal(Object.values(result.punchcard).reduce((n, value) => n + value, 0), responses);
    assert.equal(result.projectTree.reduce((n, row) => n + row.tokens, 0), result.totals.tokens);
    assert.equal(result.sessions.reduce((n, row) => n + row.output, 0), output);
    assert.equal(result.sessions.reduce((n, row) => n + row.responses, 0), count,
      'each session retains its own observed response count');
    assert.equal(result.sessions.reduce((n, row) => n + row.accountedResponses, 0), responses);
  };
  check(await buildIndex(o), 2, 200, 1, 'other');
  const legacy = JSON.parse(fs.readFileSync(o.cachePath, 'utf8'));
  for (const entry of Object.values(legacy.entries)) delete entry.session.claudeMessages;
  fs.writeFileSync(o.cachePath, JSON.stringify(legacy));
  _resetForTest();
  check(await buildIndex(o), 2, 200, 1, 'other'); // compatible schema-26 cache reparses old Claude entries
  _resetForTest();
  check(await buildIndex(o), 2, 200, 1, 'other'); // genuinely warm
  write(c, [asst({ id: 'msg_distinct', s: 7, block: text(), usage: USAGE })]);
  _resetForTest();
  check(await buildIndex(o), 3, 400, 2, 'other');
  write(b, [asst({ id: 'msg_shared', s: 86_408, block: text(), usage: { ...USAGE, output_tokens: 300 } })]);
  fs.utimesSync(b, new Date(T0), new Date(T0 + 20_000));
  _resetForTest();
  check(await buildIndex(o), 3, 500, 2, 'other');
  fs.unlinkSync(b);
  _resetForTest();
  check(await buildIndex(o), 2, 212, 2, 'proj');
});

// ── schema version ──────────────────────────────────────────────────────────

test('SCHEMA_VERSION is at least 22 and a v21 cache is discarded and re-parsed de-duplicated', async () => {
  assert.ok(SCHEMA_VERSION >= 22, 'the de-dup correction changes every cached Claude record');
  _resetForTest();
  const dir = tempDir('ak-dedup');
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
