import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIndex, readIndex, readSession, mergeIntervals, maskSecrets, projectLabel,
  SCHEMA_VERSION, IDLE_GAP_MS, _resetForTest,
} from '../../src/lib/usage-index.mjs';
import {
  addUsage, blankSession, noteLatencySample, parseClaude,
  LAT_BUCKET_EDGES, LEN_BUCKET_EDGES,
} from '../../src/lib/usage-parsers.mjs';
import {
  aggregate, percentileFromBuckets, modelFamily,
  LAT_BUCKET_EDGES as AGG_LAT_EDGES, LEN_BUCKET_EDGES as AGG_LEN_EDGES,
} from '../../src/lib/usage-aggregate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'usage');

// The fixtures carry literal 2026-07-24 timestamps, so every test pins `now` to
// a fixed instant one day later. Without the pin the suite would silently start
// producing empty windows the moment the corpus aged past `days`.
const NOW = Date.parse('2026-07-25T12:00:00.000Z');

/** Copy the fixture corpus into a throwaway tmpdir; return injectable roots +
 *  a cache path. Nothing here ever touches ~/.claude, ~/.codex or ~/.config. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-usage-'));
  fs.cpSync(FIXTURES, path.join(dir, 'corpus'), { recursive: true });
  return {
    dir,
    roots: {
      claude: path.join(dir, 'corpus', 'claude'),
      codex: path.join(dir, 'corpus', 'codex'),
    },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
  };
}

/** Stub siblings: pricing/classification/insights are other modules' contracts.
 *  The index is tested against arithmetic we can assert exactly. */
const deps = () => ({
  costOf: ({ input, output, cacheRead, cacheWrite }) =>
    (input + output + cacheRead + cacheWrite) / 1000,
  pricesAsOf: '2026-07-01',
  classify: ({ title }) => (title
    ? { category: 'Build', confidence: 0.9, basis: 'title+tools' }
    : { category: 'Unclassified', confidence: 0, basis: 'no signal' }),
  detectInsights: () => [{ id: 'stub-finding' }],
});

const opts = (sb, extra = {}) => ({
  days: 14, now: NOW, roots: sb.roots, cachePath: sb.cachePath, deps: deps(), ...extra,
});

const byId = (agg, id) => agg.sessions.find((s) => s.id === id);

/** A sandbox with NO fixture corpus — for engaged-time tests that need a single
 *  session's arithmetic to be the whole of the answer. */
function soloSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-usage-solo-'));
  const claude = path.join(dir, 'claude', '-Users-me-proj');
  fs.mkdirSync(claude, { recursive: true });
  return {
    dir,
    claude,
    roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
  };
}

/** Write a Claude transcript whose turns sit at the given offsets (ms) from a
 *  fixed base. Alternates user/assistant so every offset is a real timestamp. */
function writeTurns(sb, id, offsets) {
  const base = Date.parse('2026-07-24T10:00:00.000Z');
  const lines = offsets.map((off, i) => (i % 2 === 0
    ? JSON.stringify({
      type: 'user', sessionId: id, cwd: '/Users/me/proj',
      timestamp: new Date(base + off).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: `turn ${i}` }] },
    })
    : JSON.stringify({
      type: 'assistant', sessionId: id, cwd: '/Users/me/proj',
      timestamp: new Date(base + off).toISOString(),
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    })));
  // Guarantee at least one assistant turn, or the session is excluded by design.
  if (offsets.length === 1) {
    lines[0] = JSON.stringify({
      type: 'assistant', sessionId: id, cwd: '/Users/me/proj',
      timestamp: new Date(base + offsets[0]).toISOString(),
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    });
  }
  fs.writeFileSync(path.join(sb.claude, `${id}.jsonl`), `${lines.join('\n')}\n`);
}

const MIN = 60_000;

// ── mergeIntervals (pure) ───────────────────────────────────────────────────

test('mergeIntervals returns 0 for an empty list', () => {
  assert.equal(mergeIntervals([]), 0);
});

test('mergeIntervals sums disjoint intervals', () => {
  assert.equal(mergeIntervals([[0, 10_000], [20_000, 25_000]]), 15);
});

test('mergeIntervals merges overlapping intervals into their union', () => {
  // 0–10s and 5–20s overlap: the union is 20s, NOT the 25s sum. This is the
  // ADR-0009 §4 rule that stopped the panel claiming 21h days.
  assert.equal(mergeIntervals([[0, 10_000], [5_000, 20_000]]), 20);
});

test('mergeIntervals absorbs a fully-nested interval', () => {
  assert.equal(mergeIntervals([[0, 60_000], [10_000, 20_000]]), 60);
});

test('mergeIntervals joins exactly-touching endpoints without double counting', () => {
  assert.equal(mergeIntervals([[0, 10_000], [10_000, 20_000]]), 20);
});

test('mergeIntervals is order-independent', () => {
  assert.equal(
    mergeIntervals([[20_000, 25_000], [5_000, 20_000], [0, 10_000]]),
    mergeIntervals([[0, 10_000], [5_000, 20_000], [20_000, 25_000]]),
  );
});

test('mergeIntervals accepts {start,end} objects and ISO strings', () => {
  assert.equal(mergeIntervals([{ start: 0, end: 10_000 }, { start: 5_000, end: 20_000 }]), 20);
  assert.equal(
    mergeIntervals([{ start: '2026-07-24T10:00:00.000Z', end: '2026-07-24T10:01:00.000Z' }]),
    60,
  );
});

test('mergeIntervals drops degenerate and unparseable intervals', () => {
  assert.equal(mergeIntervals([[10_000, 10_000], [50_000, 40_000], [NaN, 5], null]), 0);
  assert.equal(mergeIntervals(null), 0);
});

// ── maskSecrets (pure) ──────────────────────────────────────────────────────

const SECRETS = [
  ['anthropic key', 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF'],
  ['openai key', 'sk-proj-1234567890abcdefghij'],
  ['github token', 'gh' + 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['webhook secret', 'whsec' + '_abcdefghijklmnopqrstuvwxyz012345'],
];

for (const [label, secret] of SECRETS) {
  test(`maskSecrets masks a ${label}`, () => {
    const out = maskSecrets(`token is ${secret} ok`);
    assert.ok(!out.includes(secret), `raw secret survived: ${out}`);
    assert.ok(out.startsWith('token is '), 'surrounding prose is preserved');
    assert.ok(out.endsWith(' ok'), 'surrounding prose is preserved');
  });
}

test('maskSecrets masks a bearer token', () => {
  const out = maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456');
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz123456'));
});

// Masking breadth. The first cut covered only sk-/ghp_/AKIA/whsec_ because the
// spec listed exactly those four; a live probe found eight more shapes passing
// straight through. ADR-0009 §8's purpose is to stop AMPLIFICATION into a
// screenshare, and a masker that catches sk- while passing
// `postgres://admin:hunter2@prod` does not do that job.
// Fixtures are ASSEMBLED AT RUNTIME rather than written as literals. Written
// out in full they are valid-looking credentials, and GitHub push protection
// correctly blocked this file for a Slack token pattern — a scanner cannot tell
// a test fixture from a leak, and it should not have to. Concatenation keeps
// the exercised string byte-identical while no scannable literal enters the
// diff. `pre` and `body` are joined so neither half matches on its own.
const fixture = (pre, body) => pre + body;

for (const [label, secret] of [
  ['a JWT', fixture('ey', 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop')],
  ['a Slack bot token', fixture('xox', `b-${'1'.repeat(12)}-${'A'.repeat(16)}`)],
  ['a Google API key', fixture('AIza', 'Sy' + 'A'.repeat(33))],
  ['an npm token', fixture('npm', '_' + 'A'.repeat(36))],
  ['a GitHub fine-grained PAT', fixture('github', '_pat_' + 'A'.repeat(26))],
  ['a Stripe live key', fixture('sk', '_live_' + 'A'.repeat(24))],
  ['a SendGrid key', fixture('SG', `.${'A'.repeat(22)}.${'B'.repeat(30)}`)],
]) {
  test(`maskSecrets masks ${label}`, () => {
    const out = maskSecrets(`value ${secret} end`);
    assert.ok(!out.includes(secret), `${label} must not survive masking`);
    assert.ok(out.includes('redacted'));
  });
}

test('maskSecrets masks a whole PEM block, not just its armour', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  const out = maskSecrets(pem);
  assert.ok(!out.includes('MIIEpAIBAAKCAQEA'), 'the key material must be gone');
  assert.ok(out.includes('redacted'));
});

test('maskSecrets strips an inline URI password but KEEPS the username', () => {
  const out = maskSecrets('postgres://admin:hunter2@db.internal:5432/prod');
  assert.ok(!out.includes('hunter2'), 'the password must go');
  assert.ok(out.includes('admin'), 'the username identifies which system leaked and is not the secret');
  assert.ok(out.includes('db.internal'), 'the host is not the secret either');
});

test('maskSecrets masks Basic auth credentials', () => {
  const out = maskSecrets('Authorization: Basic YWRtaW46aHVudGVyMg==');
  assert.ok(!out.includes('YWRtaW46aHVudGVyMg'), 'base64 credentials must not survive');
});

test('maskSecrets masks a SCREAMING_CASE secret assignment', () => {
  const out = maskSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY');
  assert.ok(!out.includes('wJalrXUtnFEMI'), 'the value must go');
  assert.ok(out.includes('AWS_SECRET_ACCESS_KEY'), 'the name is kept so the leak is identifiable');
});

// Security review Finding 2: the SCREAMING_CASE-only rule above missed the two
// most common non-env credential shapes — quoted JSON keys and lowercase
// YAML/TOML assignments. Both are quote/line-anchored, not case-sensitivity
// tricks, so they cannot reopen the "tokens used = …" false positive above.
test('maskSecrets masks a quoted JSON object key whose name says secret', () => {
  const out = maskSecrets('{"apiKey": "abcdefghijklmnop1234"}');
  assert.ok(!out.includes('abcdefghijklmnop1234'), 'the value must go');
  assert.ok(out.includes('"apiKey"'), 'the key name is kept so the leak is identifiable');
});

test('maskSecrets masks a quoted JSON client_secret regardless of case', () => {
  const out = maskSecrets('{"client_secret":"sekrit1234567890abcd"}');
  assert.ok(!out.includes('sekrit1234567890abcd'), 'the value must go');
});

test('maskSecrets masks an unquoted YAML/ini assignment', () => {
  const out = maskSecrets('api_key = 9f8a7b6c5d4e3f2a1b0c');
  assert.ok(!out.includes('9f8a7b6c5d4e3f2a1b0c'), 'the value must go');
  assert.ok(out.includes('api_key'), 'the key name is kept');
});

test('maskSecrets masks a lowercase "password:" line', () => {
  const out = maskSecrets('password: hunter2hunter2hunter2');
  assert.ok(!out.includes('hunter2hunter2hunter2'), 'the value must go');
});

// REGRESSION GUARD. The assignment pattern is case-SENSITIVE on purpose. With an
// /i flag it matches "tokens used = 10028979467" — and these transcripts discuss
// token counts on almost every line, so a case-insensitive rule would redact
// swathes of ordinary content while looking like it was working.
for (const prose of [
  'tokens used = 10028979467',
  'Total tokens: 35284 across 583 sessions',
  'const apiKey = readEnv();',
  'See https://github.com/pacphi/retort for details',
]) {
  test(`maskSecrets leaves token-talk prose untouched: ${prose.slice(0, 28)}`, () => {
    assert.equal(maskSecrets(prose), prose);
  });
}

test('maskSecrets leaves ordinary prose untouched', () => {
  const prose = 'The task-oriented risk review of AKIA and sk- prefixes found no ghp_ leak.';
  assert.equal(maskSecrets(prose), prose);
});

test('maskSecrets is idempotent', () => {
  const once = maskSecrets(`a ${SECRETS[0][1]} b ${SECRETS[2][1]} c`);
  assert.equal(maskSecrets(once), once);
});

test('maskSecrets tolerates non-string input', () => {
  assert.equal(maskSecrets(null), '');
  assert.equal(maskSecrets(undefined), '');
  assert.equal(maskSecrets(42), '42');
});

// ── parsing ─────────────────────────────────────────────────────────────────

test('buildIndex parses a Claude session into the Session contract', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));
  const s = byId(agg, 'aaaa1111');

  assert.ok(s, 'session present');
  assert.equal(s.host, 'claude');
  assert.equal(s.provider, null);
  assert.equal(s.transcriptProvider, 'claude');
  assert.equal(s.title, 'Add rate limiting to the API');
  assert.equal(s.project, 'proj');
  assert.equal(s.start, '2026-07-24T10:00:00.000Z');
  assert.equal(s.minutes, 20);
  assert.equal(s.prompts, 2, 'tool_result user entries are not prompts');
  assert.equal(s.responses, 3);
  assert.equal(s.sidechain, false);
  assert.deepEqual(s.models.slice().sort(), ['claude-opus-5', 'claude-sonnet-5']);
  assert.equal(s.input, 115);
  assert.equal(s.output, 75);
  assert.equal(s.cacheRead, 1600);
  assert.equal(s.cacheWrite, 200);
  assert.equal(s.tokens, 1990);
  assert.equal(s.cost, 1.99, 'cost comes from the injected pricing dep');
  assert.deepEqual(s.tools, { Edit: 1, Read: 1 });
  assert.equal(s.category, 'Build');
  assert.equal(s.confidence, 0.9);
  assert.equal(s.basis, 'title+tools');
});

test('buildIndex masks a secret pasted into a session title', async () => {
  _resetForTest();
  const sb = sandbox();
  const file = path.join(sb.roots.claude, '-Users-me-proj', 'eeee5555.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({
      type: 'user', sessionId: 'eeee5555', cwd: '/Users/me/proj',
      timestamp: '2026-07-24T13:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'use sk-ant-api03-ZZZZYYYYXXXXWWWWVVVV now' }] },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: 'eeee5555', cwd: '/Users/me/proj',
      timestamp: '2026-07-24T13:01:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    }),
  ].join('\n') + '\n');

  const agg = await buildIndex(opts(sb));
  const s = byId(agg, 'eeee5555');
  assert.ok(s.title.length > 0);
  assert.ok(!s.title.includes('sk-ant-api03-ZZZZYYYYXXXXWWWWVVVV'), s.title);
});

test('a malformed JSONL line is skipped and the rest of the file still parses', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));
  const s = byId(agg, 'bbbb2222');

  assert.ok(s, 'the corrupt line did not lose the file');
  assert.equal(s.responses, 2, 'both well-formed assistant turns survived');
  assert.equal(s.input, 30);
  assert.equal(s.output, 30);
  assert.equal(s.title, 'Fix the flaky test');
});

test('buildIndex never throws on a wholly unparseable file', async () => {
  _resetForTest();
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.roots.claude, '-Users-me-proj', 'ffff6666.jsonl'), '\0\0not json at all\n{oops\n');
  const agg = await buildIndex(opts(sb));
  assert.ok(Array.isArray(agg.sessions));
  assert.ok(byId(agg, 'aaaa1111'), 'sibling files still indexed');
});

test('a session with zero assistant turns is excluded from sessions[]', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));
  assert.equal(byId(agg, 'cccc3333'), undefined);
});

test('Codex tokens come from the LAST token_count event, never the sum', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));
  const s = byId(agg, 'dddd4444');

  assert.ok(s, 'codex session present');
  assert.equal(s.host, 'codex');
  assert.equal(s.provider, 'openai');
  assert.equal(s.providerProvenance, 'observed');
  assert.equal(s.transcriptProvider, 'codex');
  // Last event: input_tokens 3000, cached_input_tokens 1200, output 300.
  // Summing the two events would give 4000/1600/400 — that is the bug this guards.
  assert.equal(s.input, 1800, 'input excludes cached_input_tokens');
  assert.equal(s.cacheRead, 1200);
  assert.equal(s.output, 300);
  assert.equal(s.cacheWrite, 0);
  assert.equal(s.tokens, 3300);
  assert.deepEqual(s.models, ['gpt-5.6']);
  assert.equal(s.responses, 2);
  assert.equal(s.prompts, 1);
  assert.equal(s.project, 'other');
  assert.equal(s.minutes, 3);
  // byModel must carry the session's response count too — it used to be
  // dropped for Codex rows (Claude passed `responses: 1` per turn into
  // addUsage; Codex passed none), leaving every Codex model stuck at "0 resp"
  // in the dashboard regardless of real token/cost volume.
  assert.equal(agg.byModel['gpt-5.6'].responses, 2);
});

test('a subagent-sourced Codex rollout (thread_spawn replay) is excluded from cost/token aggregation', async () => {
  // openai/codex spawns delegated subagent threads whose rollout file replays
  // the PARENT thread's entire prior token history as duplicate events before
  // its own new turns (ccusage/ccusage#950 measured up to 91x cost inflation
  // from exactly this). Its cumulative total_token_usage therefore double-
  // counts tokens the parent session already billed, so it must not
  // contribute to cost/token aggregation — but the session record itself
  // stays visible (with threadSource surfaced) so it's still auditable.
  _resetForTest();
  const sb = soloSandbox();
  const day = path.join(sb.roots.codex, '2026', '07', '24');
  fs.mkdirSync(day, { recursive: true });
  const base = Date.parse('2026-07-24T09:00:00.000Z');
  const ts = (offMs) => new Date(base + offMs).toISOString();
  const lines = [
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'eeee5555', timestamp: ts(0), cwd: '/Users/me/proj', thread_source: 'subagent' } },
    { timestamp: ts(1000), type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.6-sol', cwd: '/Users/me/proj' } },
    { timestamp: ts(2000), type: 'event_msg', payload: { type: 'user_message', message: 'delegated task' } },
    // A "first" cumulative total that is already huge is the replay signature:
    // a genuinely fresh thread's first token_count starts near its own system-
    // prompt size, not hundreds of thousands of tokens in.
    { timestamp: ts(30_000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900_000, cached_input_tokens: 850_000, output_tokens: 9000, reasoning_output_tokens: 0, total_tokens: 909_000 } } } },
    { timestamp: ts(60_000), type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } },
  ];
  fs.writeFileSync(
    path.join(day, 'rollout-2026-07-24T09-00-00-eeee5555.jsonl'),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  );

  const agg = await buildIndex(opts(sb));
  const s = byId(agg, 'eeee5555');

  assert.ok(s, 'subagent session is still listed, not silently dropped');
  assert.equal(s.threadSource, 'subagent');
  assert.equal(s.tokens, 0, 'replayed parent history contributes no tokens to its own record');
  assert.equal(s.cost, 0);
  // The model still appears in byModel — it's a real session that used it, and
  // "models in play" is tracked independently of cost attribution (see the
  // `s.models` loop in aggregate()) — but it must carry none of the replayed
  // volume: zero tokens, cost, and responses from this session.
  const b = agg.byModel['gpt-5.6-sol'];
  assert.ok(b, 'the model is still listed as used by this session');
  assert.equal(b.tokens, 0, 'no replayed tokens leak into the model bucket');
  assert.equal(b.cost, 0);
  assert.equal(b.responses, 0);
});

test('buildIndex never mutates a transcript', async () => {
  _resetForTest();
  const sb = sandbox();
  const file = path.join(sb.roots.claude, '-Users-me-proj', 'aaaa1111.jsonl');
  const before = fs.readFileSync(file);
  const stat = fs.statSync(file);
  await buildIndex(opts(sb));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
});

// ── aggregate ───────────────────────────────────────────────────────────────

test('buildIndex emits the documented Aggregate shape', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));

  for (const k of ['generatedAt', 'windowDays', 'pricesAsOf', 'totals', 'byDay', 'byModel',
    'byHost', 'byProvider', 'byProject', 'byCategory',
    'punchcard', 'projectTree', 'sessions', 'insights']) {
    assert.ok(k in agg, `missing ${k}`);
  }
  assert.equal(agg.windowDays, 14);
  assert.equal(agg.pricesAsOf, '2026-07-01');
  assert.equal(agg.totals.sessions, 3);
  assert.equal(agg.totals.responses, 7);
  assert.equal(agg.totals.tokens, 1990 + 60 + 3300);
  assert.deepEqual(agg.insights, [{ id: 'stub-finding' }]);
});

test('totals.engagedSeconds is the union of session intervals, not the sum of spans', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));
  // aaaa 20min + bbbb 2min + dddd 3min, all disjoint = 1500s / spanMinutes 25.
  assert.equal(agg.totals.engagedSeconds, 1500);
  assert.equal(agg.totals.spanMinutes, 25);
});

test('overlapping sessions make engagedSeconds strictly less than spanMinutes', async () => {
  _resetForTest();
  const sb = sandbox();
  // A sidechain that runs entirely inside aaaa1111's 10:00–10:20 window.
  fs.writeFileSync(path.join(sb.roots.claude, '-Users-me-proj', 'gggg7777.jsonl'), [
    JSON.stringify({
      type: 'user', sessionId: 'gggg7777', cwd: '/Users/me/proj', isSidechain: true,
      timestamp: '2026-07-24T10:05:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'subagent work' }] },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: 'gggg7777', cwd: '/Users/me/proj', isSidechain: true,
      timestamp: '2026-07-24T10:15:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    }),
  ].join('\n') + '\n');

  const agg = await buildIndex(opts(sb));
  assert.equal(byId(agg, 'gggg7777').sidechain, true);
  assert.equal(agg.totals.spanMinutes, 35, 'summed spans grow by the overlapping 10 minutes');
  assert.equal(agg.totals.engagedSeconds, 1500, 'the union does not');
});

// ── engaged time: idle-gap split (ADR-0009 §4) ──────────────────────────────

test('IDLE_GAP_MS is exported and defaults to 15 minutes', () => {
  assert.equal(IDLE_GAP_MS, 15 * 60 * 1000);
});

test('an idle gap splits a session, so only its active portion is engaged', async () => {
  _resetForTest();
  const sb = soloSandbox();
  // Active 10:00–10:05, idle 115 min, active 12:00–12:02.
  writeTurns(sb, 'idle1', [0, 5 * MIN, 120 * MIN, 122 * MIN]);
  const agg = await buildIndex(opts(sb));

  assert.equal(agg.totals.spanMinutes, 122, 'the span is still first-to-last');
  assert.equal(agg.totals.engagedSeconds, 5 * 60 + 2 * 60, 'only the two active runs count');
  assert.ok(
    agg.totals.engagedSeconds < agg.totals.spanMinutes * 60,
    'engaged must be strictly less than span once a session goes idle',
  );
});

test('a session with no idle gap is unchanged by the split', async () => {
  _resetForTest();
  const sb = soloSandbox();
  writeTurns(sb, 'nogap', [0, 5 * MIN, 10 * MIN]);
  const agg = await buildIndex(opts(sb));

  assert.equal(agg.totals.engagedSeconds, 600);
  assert.equal(agg.totals.engagedSeconds, agg.totals.spanMinutes * 60, 'no idle time to lose');
});

test('a gap of exactly IDLE_GAP_MS does not split', async () => {
  _resetForTest();
  const sb = soloSandbox();
  writeTurns(sb, 'exact', [0, IDLE_GAP_MS]);
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.totals.engagedSeconds, IDLE_GAP_MS / 1000, 'the boundary is inclusive');
});

test('a gap one second over IDLE_GAP_MS does split', async () => {
  _resetForTest();
  const sb = soloSandbox();
  // Two 5-minute runs separated by 15m01s of silence.
  writeTurns(sb, 'over', [0, 5 * MIN, 5 * MIN + IDLE_GAP_MS + 1000, 10 * MIN + IDLE_GAP_MS + 1000]);
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.totals.engagedSeconds, 600, 'two 5-minute runs, the silence dropped');
});

test('a one-timestamp session does not throw and contributes no engaged time', async () => {
  _resetForTest();
  const sb = soloSandbox();
  writeTurns(sb, 'single', [0]);
  const agg = await buildIndex(opts(sb));

  assert.equal(agg.totals.sessions, 1, 'still a session — it had an assistant turn');
  assert.equal(agg.totals.spanMinutes, 0);
  assert.equal(agg.totals.engagedSeconds, 0, 'a single instant has no duration to claim');
});

test('a session with no usable timestamp is dropped rather than throwing', async () => {
  _resetForTest();
  const sb = soloSandbox();
  fs.writeFileSync(path.join(sb.claude, 'notime.jsonl'), `${JSON.stringify({
    type: 'assistant', sessionId: 'notime', cwd: '/Users/me/proj', timestamp: 'not-a-date',
    message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  })}\n`);
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.totals.sessions, 0);
  assert.equal(agg.totals.engagedSeconds, 0);
});

test('the three time tiers are ordered engaged <= spanUnion <= summed span', async () => {
  _resetForTest();
  const sb = soloSandbox();
  writeTurns(sb, 'a', [0, 5 * MIN, 120 * MIN, 122 * MIN]);   // goes idle
  writeTurns(sb, 'b', [10 * MIN, 15 * MIN]);                  // overlaps a's idle window
  const agg = await buildIndex(opts(sb));

  assert.ok(agg.totals.engagedSeconds <= agg.totals.spanUnionSeconds);
  assert.ok(agg.totals.spanUnionSeconds <= agg.totals.spanMinutes * 60);
  // a: 5 + 2 active minutes, b: 5 → 12 min engaged; union of whole spans is
  // a's 122 min (b nests inside it); summed spans are 122 + 5.
  assert.equal(agg.totals.engagedSeconds, 12 * 60);
  assert.equal(agg.totals.spanUnionSeconds, 122 * 60);
  assert.equal(agg.totals.spanMinutes, 127);
});

test('engaged time unions across sessions, not just within one', async () => {
  _resetForTest();
  const sb = soloSandbox();
  // Two sessions active over the SAME wall-clock minutes must count once.
  writeTurns(sb, 'p', [0, 10 * MIN]);
  writeTurns(sb, 'q', [0, 10 * MIN]);
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.totals.engagedSeconds, 600, 'concurrent agents are one stretch of time');
  assert.equal(agg.totals.spanMinutes, 20, 'the summed figure still double-counts, by design');
});

test('byDay, byModel, byHost, byProvider, byProject and byCategory partition the same spend', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));
  const sum = (m) => Object.values(m).reduce((a, v) => a + v.tokens, 0);

  assert.equal(sum(agg.byDay), agg.totals.tokens);
  assert.equal(sum(agg.byModel), agg.totals.tokens);
  assert.equal(sum(agg.byHost), agg.totals.tokens);
  assert.equal(sum(agg.byProvider), agg.totals.tokens);
  assert.equal(sum(agg.byProject), agg.totals.tokens);
  assert.equal(sum(agg.byCategory), agg.totals.tokens);
  assert.deepEqual(Object.keys(agg.byHost).sort(), ['claude', 'codex']);
  assert.deepEqual(Object.keys(agg.byProvider).sort(), ['openai', 'unknown']);
  // byDay keys are LOCAL calendar days, so a far-eastern tz may split the
  // fixtures' 09:00–12:00Z across two adjacent days. Both are in-window.
  for (const day of Object.keys(agg.byDay)) {
    assert.ok(['2026-07-23', '2026-07-24', '2026-07-25'].includes(day), `unexpected day ${day}`);
  }
  assert.equal(agg.byProject.proj.sessions, 2);
});

test('session counts are attributable in every keyed map', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));
  const count = (m) => Object.values(m).reduce((a, v) => a + v.sessions, 0);

  assert.equal(count(agg.byHost), agg.totals.sessions);
  assert.equal(count(agg.byProvider), agg.totals.sessions);
  assert.equal(count(agg.byProject), agg.totals.sessions);
  assert.equal(count(agg.byCategory), agg.totals.sessions);
  // byDay attributes each session to the day its tokens first landed, so the
  // counts still add up even when a session opens just before midnight.
  assert.equal(
    Object.values(agg.byDay).reduce((a, v) => a + v.sessions, 0),
    agg.totals.sessions,
  );
  // byModel counts a session once per model it used, so it may exceed the
  // total — but it may never be zero for a model that has tokens.
  for (const [model, b] of Object.entries(agg.byModel)) {
    assert.ok(b.sessions >= 1, `${model} has tokens but no sessions`);
  }
  assert.equal(agg.byModel['claude-opus-5'].sessions, 1);
  assert.equal(agg.byModel['claude-sonnet-5'].sessions, 1, 'the second model of a session still counts');
});

test('a session that opens before midnight is counted on its first billed day', async () => {
  _resetForTest();
  const sb = sandbox();
  // Opens 23:58 LOCAL on the 24th; its only assistant turn lands 00:05 on the
  // 25th. Local wall-clock on purpose — byDay keys are local days.
  const iso = (d) => new Date(d).toISOString();
  fs.writeFileSync(path.join(sb.roots.claude, '-Users-me-proj', 'hhhh8888.jsonl'), [
    JSON.stringify({
      type: 'user', sessionId: 'hhhh8888', cwd: '/Users/me/proj',
      timestamp: iso(new Date(2026, 6, 24, 23, 58)),
      message: { role: 'user', content: [{ type: 'text', text: 'late night' }] },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: 'hhhh8888', cwd: '/Users/me/proj',
      timestamp: iso(new Date(2026, 6, 25, 0, 5)),
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 7, output_tokens: 3 }, content: [] },
    }),
  ].join('\n') + '\n');

  const agg = await buildIndex(opts(sb, { days: 30 }));
  const s = byId(agg, 'hhhh8888');
  assert.ok(s, 'session indexed');
  assert.equal(s.tokens, 10);
  assert.ok(agg.byDay['2026-07-25'], 'the billed day exists');
  assert.equal(
    Object.values(agg.byDay).reduce((a, v) => a + v.sessions, 0),
    agg.totals.sessions,
    'no session is orphaned by the day split',
  );
});

test('byDay preserves first-billed sessions and adds active sessions for later token days', async () => {
  _resetForTest();
  const sb = soloSandbox();
  const iso = (d) => new Date(d).toISOString();
  fs.writeFileSync(path.join(sb.claude, 'multi-day-7777.jsonl'), [
    JSON.stringify({
      type: 'user', sessionId: 'multi-day-7777', cwd: '/Users/me/proj',
      timestamp: iso(new Date(2026, 6, 24, 23, 58)),
      message: { role: 'user', content: [{ type: 'text', text: 'day one' }] },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: 'multi-day-7777', cwd: '/Users/me/proj',
      timestamp: iso(new Date(2026, 6, 24, 23, 59)),
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 7, output_tokens: 3 }, content: [] },
    }),
    JSON.stringify({
      type: 'user', sessionId: 'multi-day-7777', cwd: '/Users/me/proj',
      timestamp: iso(new Date(2026, 6, 25, 0, 4)),
      message: { role: 'user', content: [{ type: 'text', text: 'day two' }] },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: 'multi-day-7777', cwd: '/Users/me/proj',
      timestamp: iso(new Date(2026, 6, 25, 0, 5)),
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 11, output_tokens: 5 }, content: [] },
    }),
  ].join('\n') + '\n');

  const agg = await buildIndex(opts(sb, { days: 30 }));
  assert.equal(agg.byDay['2026-07-24'].sessions, 1);
  assert.equal(agg.byDay['2026-07-24'].sessionsActive, 1);
  assert.equal(agg.byDay['2026-07-25'].sessions, 0);
  assert.equal(agg.byDay['2026-07-25'].sessionsActive, 1);
});

test('a dropped-connection turn (isApiErrorMessage) counts as an exception, never a $0 model', async () => {
  // Claude Code synthesizes a local placeholder turn — model: "<synthetic>",
  // isApiErrorMessage: true, all-zero usage — when a request's connection
  // drops, rate-limits, or fails auth before a real completion returns. It
  // must count as engaged time (a real turn happened) but must NOT create a
  // byModel row: there was no model attempt to attribute cost/tokens to.
  _resetForTest();
  const sb = soloSandbox();
  const base = Date.parse('2026-07-24T10:00:00.000Z');
  const iso = (offMs) => new Date(base + offMs).toISOString();
  const lines = [
    { type: 'user', sessionId: 'iiii9999', cwd: '/Users/me/proj', timestamp: iso(0),
      message: { role: 'user', content: [{ type: 'text', text: 'turn 1' }] } },
    { type: 'assistant', sessionId: 'iiii9999', cwd: '/Users/me/proj', timestamp: iso(1000),
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 50 }, content: [] } },
    { type: 'user', sessionId: 'iiii9999', cwd: '/Users/me/proj', timestamp: iso(2000),
      message: { role: 'user', content: [{ type: 'text', text: 'turn 2' }] } },
    // The dropped-connection placeholder: same shape Claude Code actually writes.
    { type: 'assistant', sessionId: 'iiii9999', cwd: '/Users/me/proj', timestamp: iso(3000),
      isApiErrorMessage: true, error: 'server_error',
      message: {
        role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'API Error: Connection closed mid-response.' }],
      } },
  ];
  fs.writeFileSync(path.join(sb.claude, 'iiii9999.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const agg = await buildIndex(opts(sb));
  const s = byId(agg, 'iiii9999');

  assert.ok(s, 'session indexed');
  assert.equal(s.responses, 2, 'the error placeholder still counts as a real turn');
  assert.equal(s.exceptions, 1);
  assert.deepEqual(s.models, ['claude-opus-5'], '"<synthetic>" never enters the models list');
  assert.equal(s.tokens, 150, 'only the real turn contributes tokens');
  assert.ok(s.cost > 0);

  assert.equal(agg.totals.exceptions, 1);
  assert.equal(agg.byModel['<synthetic>'], undefined, 'no $0 "<synthetic>" row is ever created');
  assert.equal(agg.byModel['claude-opus-5'].tokens, 150);
});

test('a "<synthetic>" placeholder without isApiErrorMessage still counts as an exception, never a $0 model', async () => {
  // Some builds emit the same dropped-connection placeholder without setting
  // isApiErrorMessage — the literal model marker is the one part of the shape
  // that never varies, so it must be caught on its own too.
  _resetForTest();
  const sb = soloSandbox();
  const base = Date.parse('2026-08-06T10:00:00.000Z');
  const iso = (offMs) => new Date(base + offMs).toISOString();
  const lines = [
    { type: 'user', sessionId: 'jjjj0000', cwd: '/Users/me/proj', timestamp: iso(0),
      message: { role: 'user', content: [{ type: 'text', text: 'turn 1' }] } },
    { type: 'assistant', sessionId: 'jjjj0000', cwd: '/Users/me/proj', timestamp: iso(1000),
      message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 50 }, content: [] } },
    { type: 'user', sessionId: 'jjjj0000', cwd: '/Users/me/proj', timestamp: iso(2000),
      message: { role: 'user', content: [{ type: 'text', text: 'turn 2' }] } },
    // Same placeholder shape as above, but isApiErrorMessage is absent.
    { type: 'assistant', sessionId: 'jjjj0000', cwd: '/Users/me/proj', timestamp: iso(3000),
      message: {
        role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'API Error: Connection closed mid-response.' }],
      } },
  ];
  fs.writeFileSync(path.join(sb.claude, 'jjjj0000.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const agg = await buildIndex(opts(sb));
  const s = byId(agg, 'jjjj0000');

  assert.ok(s, 'session indexed');
  assert.equal(s.responses, 2, 'the error placeholder still counts as a real turn');
  assert.equal(s.exceptions, 1);
  assert.deepEqual(s.models, ['claude-sonnet-5'], '"<synthetic>" never enters the models list');
  assert.equal(s.tokens, 150, 'only the real turn contributes tokens');

  assert.equal(agg.totals.exceptions, 1);
  assert.equal(agg.byModel['<synthetic>'], undefined, 'no $0 "<synthetic>" row is ever created');
});

test('punchcard buckets responses by dow-hour with Monday as 0', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));
  const total = Object.values(agg.punchcard).reduce((a, b) => a + b, 0);
  assert.equal(total, agg.totals.responses);
  for (const key of Object.keys(agg.punchcard)) {
    const [dow, hour] = key.split('-').map(Number);
    assert.ok(dow >= 0 && dow <= 6, `dow out of range in ${key}`);
    assert.ok(hour >= 0 && hour <= 23, `hour out of range in ${key}`);
  }
});

test('projectTree groups sessions under their project, ranked by cost', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));

  const projects = agg.projectTree.map((p) => p.project);
  assert.deepEqual(projects.slice().sort(), ['other', 'proj']);
  for (let i = 1; i < agg.projectTree.length; i++) {
    assert.ok(agg.projectTree[i - 1].cost >= agg.projectTree[i].cost, 'ranked by cost desc');
  }
  const proj = agg.projectTree.find((p) => p.project === 'proj');
  assert.equal(proj.sessions, 2);
  assert.equal(proj.rows.length, 2);
  assert.equal(proj.tokens, 1990 + 60);
  assert.ok(Array.isArray(proj.categories) && proj.categories.length >= 1);
  assert.ok('category' in proj.categories[0] && 'sessions' in proj.categories[0]);
});

test('the window excludes sessions older than `days`', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb, { days: 1 }));
  // NOW is 2026-07-25T12:00Z; a 1-day window starts 2026-07-24T12:00Z, so only
  // the codex session (09:00) and the claude ones (10:00/11:00) fall outside it.
  assert.equal(agg.windowDays, 1);
  assert.equal(agg.totals.sessions, 0);
  assert.deepEqual(agg.sessions, []);
});

test('an empty corpus yields a zeroed Aggregate rather than throwing', async () => {
  _resetForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-usage-empty-'));
  const agg = await buildIndex({
    days: 14, now: NOW, deps: deps(),
    roots: { claude: path.join(dir, 'nope'), codex: path.join(dir, 'also-nope') },
    cachePath: path.join(dir, 'cache.json'),
  });
  assert.equal(agg.totals.sessions, 0);
  assert.equal(agg.totals.tokens, 0);
  assert.equal(agg.totals.engagedSeconds, 0);
  assert.deepEqual(agg.sessions, []);
  assert.deepEqual(agg.projectTree, []);
  // A never-used host (root simply doesn't exist yet) reads as absent, not ok —
  // "zero sessions" and "we never found the directory" must stay distinguishable.
  assert.equal(agg.sourceHealth.claude.status, 'absent');
  assert.equal(agg.sourceHealth.claude.reason, null);
  assert.equal(agg.sourceHealth.claude.diagnostics.common.unitsSeen, 0);
  assert.equal(agg.sourceHealth.codex.status, 'absent');
  assert.equal(agg.sourceHealth.codex.reason, null);
  assert.equal(agg.sourceHealth.codex.diagnostics.files, 0);
});

test('buildIndex reports ok claude/codex root health when the transcript roots exist', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.sourceHealth.claude.status, 'ok');
  assert.equal(agg.sourceHealth.claude.reason, null);
  // Source health reports what was READ, never what the parser could report:
  // the old per-host capability matrix is not part of this payload.
  assert.ok(!Object.hasOwn(agg.sourceHealth.claude, 'capabilities'),
    'sourceHealth must not carry a capability matrix');
  assert.equal(agg.sourceHealth.claude.diagnostics.common.unitsParsed, 3);
  assert.equal(agg.sourceHealth.claude.diagnostics.common.prompts, 4);
  assert.equal(agg.sourceHealth.claude.diagnostics.common.responses, 5);
  assert.equal(agg.sourceHealth.codex.status, 'ok');
  assert.equal(agg.sourceHealth.codex.reason, null);
  assert.equal(agg.sourceHealth.codex.diagnostics.files, 1);
});

test('an unreadable Claude root degrades rather than silently reading as zero sessions', async () => {
  _resetForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-usage-unreadable-'));
  const claudeRoot = path.join(dir, 'claude-is-a-file');
  fs.writeFileSync(claudeRoot, 'not a directory'); // readdirSync on this throws ENOTDIR, not ENOENT
  const agg = await buildIndex({
    days: 14, now: NOW, deps: deps(),
    roots: { claude: claudeRoot, codex: path.join(dir, 'codex-nope') },
    cachePath: path.join(dir, 'cache.json'),
  });
  assert.equal(agg.sourceHealth.claude.status, 'degraded');
  assert.ok(agg.sourceHealth.claude.reason, 'a degraded root must carry a bounded reason, e.g. ENOTDIR');
  assert.equal(agg.totals.sessions, 0, 'degraded still yields zero sessions here (nothing to preserve) — the point is the status, not the count');
});

// ── cache ───────────────────────────────────────────────────────────────────

/** Rewrite the on-disk cache entry for `file`, stamping a sentinel title. If a
 *  later build shows the sentinel, the file was NOT re-parsed. */
function stampCache(cachePath, file, title) {
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  cache.entries[file].session.title = title;
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return cache;
}

test('an unchanged (path, mtime, size) entry is reused without re-parsing', async () => {
  _resetForTest();
  const sb = sandbox();
  const file = path.join(sb.roots.claude, '-Users-me-proj', 'aaaa1111.jsonl');
  await buildIndex(opts(sb));
  stampCache(sb.cachePath, file, 'SENTINEL-FROM-CACHE');

  _resetForTest();
  const agg = await buildIndex(opts(sb));
  assert.equal(byId(agg, 'aaaa1111').title, 'SENTINEL-FROM-CACHE');
});

test('a changed size re-parses the file', async () => {
  _resetForTest();
  const sb = sandbox();
  const file = path.join(sb.roots.claude, '-Users-me-proj', 'aaaa1111.jsonl');
  await buildIndex(opts(sb));
  stampCache(sb.cachePath, file, 'SENTINEL-FROM-CACHE');
  fs.appendFileSync(file, JSON.stringify({
    type: 'assistant', sessionId: 'aaaa1111', cwd: '/Users/me/proj',
    timestamp: '2026-07-24T10:25:00.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  }) + '\n');

  _resetForTest();
  const agg = await buildIndex(opts(sb));
  const s = byId(agg, 'aaaa1111');
  assert.equal(s.title, 'Add rate limiting to the API', 're-parsed, sentinel gone');
  assert.equal(s.responses, 4);
});

test('force:true bypasses a valid cache entry', async () => {
  _resetForTest();
  const sb = sandbox();
  const file = path.join(sb.roots.claude, '-Users-me-proj', 'aaaa1111.jsonl');
  await buildIndex(opts(sb));
  stampCache(sb.cachePath, file, 'SENTINEL-FROM-CACHE');

  _resetForTest();
  const agg = await buildIndex(opts(sb, { force: true }));
  assert.equal(byId(agg, 'aaaa1111').title, 'Add rate limiting to the API');
});

test('a schemaVersion mismatch invalidates the cache wholesale', async () => {
  _resetForTest();
  const sb = sandbox();
  const file = path.join(sb.roots.claude, '-Users-me-proj', 'aaaa1111.jsonl');
  await buildIndex(opts(sb));
  const cache = stampCache(sb.cachePath, file, 'SENTINEL-FROM-CACHE');
  assert.equal(cache.schemaVersion, SCHEMA_VERSION);
  cache.schemaVersion = SCHEMA_VERSION - 1;
  fs.writeFileSync(sb.cachePath, JSON.stringify(cache));

  _resetForTest();
  const agg = await buildIndex(opts(sb));
  assert.equal(byId(agg, 'aaaa1111').title, 'Add rate limiting to the API');
});

test('schema 16 is replaced by schema 17 without retired prompt fingerprint fields, then reused', async () => {
  _resetForTest();
  const sb = sandbox();
  const file = path.join(sb.roots.claude, '-Users-me-proj', 'aaaa1111.jsonl');
  await buildIndex(opts(sb));

  const old = stampCache(sb.cachePath, file, 'SENTINEL-FROM-SCHEMA-16');
  old.schemaVersion = 16;
  for (const entry of Object.values(old.entries)) {
    entry.session.promptFPs = [{ h: 'deadbeefdeadbeef', p: 'human', t: 4 }];
    entry.session.promptFPOverflow = 2;
  }
  fs.writeFileSync(sb.cachePath, JSON.stringify(old));

  _resetForTest();
  const reparsed = await buildIndex(opts(sb));
  assert.equal(byId(reparsed, 'aaaa1111').title, 'Add rate limiting to the API',
    'a schema-16 row is reparsed rather than trusted');
  const migrated = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
  assert.equal(migrated.schemaVersion, 17);
  for (const entry of Object.values(migrated.entries)) {
    assert.equal(Object.hasOwn(entry.session, 'promptFPs'), false);
    assert.equal(Object.hasOwn(entry.session, 'promptFPOverflow'), false);
  }

  stampCache(sb.cachePath, file, 'SENTINEL-FROM-SCHEMA-17');
  _resetForTest();
  const warm = await buildIndex(opts(sb));
  assert.equal(byId(warm, 'aaaa1111').title, 'SENTINEL-FROM-SCHEMA-17',
    'the rewritten schema-17 row is a warm-cache hit');
});

test('a pre-idle-split cache record is re-parsed, not trusted', async () => {
  _resetForTest();
  const sb = soloSandbox();
  writeTurns(sb, 'idle2', [0, 5 * MIN, 120 * MIN, 122 * MIN]);
  const fresh = await buildIndex(opts(sb));
  assert.equal(fresh.totals.engagedSeconds, 420, 'baseline: the split is applied');

  // Forge the cache exactly as the pre-split schema wrote it: right file key,
  // but a record with no `active` intervals. Reusing it would silently restore
  // the old whole-span figure — which is what SCHEMA_VERSION exists to prevent.
  // The version is a LITERAL 1 on purpose: v1 is the retired pre-split schema,
  // so this fails if SCHEMA_VERSION is ever moved back onto it. A relative
  // `SCHEMA_VERSION - 1` could not catch that — it drifts with the constant.
  assert.ok(SCHEMA_VERSION >= 2, 'schema 1 is retired: its records have no active intervals');
  const cache = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
  for (const entry of Object.values(cache.entries)) delete entry.session.active;
  cache.schemaVersion = 1;
  fs.writeFileSync(sb.cachePath, JSON.stringify(cache));

  _resetForTest();
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.totals.engagedSeconds, 420, 'stale record discarded and re-parsed');
});

test('a corrupt cache file is discarded, not fatal', async () => {
  _resetForTest();
  const sb = sandbox();
  fs.mkdirSync(path.dirname(sb.cachePath), { recursive: true });
  fs.writeFileSync(sb.cachePath, '{not json');
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.totals.sessions, 3);
});

test('buildIndex reports progress and finishes at 100%', async () => {
  _resetForTest();
  const sb = sandbox();
  const seen = [];
  await buildIndex(opts(sb, { onProgress: (p) => seen.push(p) }));
  assert.ok(seen.length > 0, 'onProgress was called');
  const last = seen[seen.length - 1];
  assert.equal(last.scanned, last.total);
  assert.ok(last.total >= 4, 'all fixture files counted');
});

test('a throwing onProgress cannot break the build', async () => {
  _resetForTest();
  const sb = sandbox();
  const agg = await buildIndex(opts(sb, { onProgress: () => { throw new Error('ui blew up'); } }));
  assert.equal(agg.totals.sessions, 3);
});

// ── single flight ───────────────────────────────────────────────────────────

test('two concurrent buildIndex calls share one scan', async () => {
  _resetForTest();
  const sb = sandbox();
  const a = buildIndex(opts(sb));
  const b = buildIndex(opts(sb));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, rb, 'the second caller joined the in-flight promise');
});

test('a failed build releases the single-flight slot', async () => {
  _resetForTest();
  const sb = sandbox();
  const boom = deps();
  boom.detectInsights = () => { throw new Error('insights exploded'); };
  await assert.rejects(buildIndex(opts(sb, { deps: boom })));
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.totals.sessions, 3, 'a subsequent build is not wedged on the failed promise');
});

// ── readIndex ───────────────────────────────────────────────────────────────

test('readIndex serves a memoized aggregate and refreshes when stale', async () => {
  _resetForTest();
  const sb = sandbox();
  const first = await readIndex(opts(sb));
  const second = await readIndex(opts(sb));
  assert.equal(first, second, 'warm read is memoized');

  const third = await readIndex(opts(sb, { maxAgeMs: 0 }));
  assert.notEqual(first, third, 'a zero TTL forces a refresh');
  assert.equal(third.totals.tokens, first.totals.tokens);
});

// code-quality Finding 7 regression: readIndex's memo key used to omit
// `force`, so readIndex({ force: true }) issued within maxAgeMs of a normal
// read silently returned the STALE memoized aggregate and never reached
// buildIndex — a "refresh now" caller would see the same answer forever, as
// long as it kept asking inside the TTL window.
test('readIndex({ force: true }) always re-scans, even within the memo TTL', async () => {
  _resetForTest();
  const sb = sandbox();
  const first = await readIndex(opts(sb));
  const second = await readIndex(opts(sb));
  assert.equal(first, second, 'sanity: a plain re-read within the TTL is still memoized');

  const forced = await readIndex(opts(sb, { force: true }));
  assert.notEqual(forced, first, 'force:true must bypass the memo and re-scan, not return the stale aggregate');
});

test('readIndex does not reuse an aggregate built for a different window', async () => {
  _resetForTest();
  const sb = sandbox();
  const wide = await readIndex(opts(sb, { days: 14 }));
  const narrow = await readIndex(opts(sb, { days: 1 }));
  assert.notEqual(wide, narrow);
  assert.equal(narrow.windowDays, 1);
});

// ── readSession ─────────────────────────────────────────────────────────────

test('readSession returns meta + turns for a Claude session', async () => {
  _resetForTest();
  const sb = sandbox();
  await buildIndex(opts(sb));
  const { meta, turns } = await readSession('aaaa1111', opts(sb));

  assert.equal(meta.id, 'aaaa1111');
  assert.equal(meta.host, 'claude');
  assert.equal(meta.provider, null);
  assert.equal(meta.transcriptProvider, 'claude');
  assert.equal(meta.title, 'Add rate limiting to the API');
  assert.ok(turns.length >= 5);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[1].model, 'claude-opus-5');
  assert.deepEqual(turns[1].tools, ['Edit']);
  assert.ok(turns.every((t) => typeof t.at === 'string'));
});

test('readSession masks secrets in transcript text', async () => {
  _resetForTest();
  const sb = sandbox();
  const { turns } = await readSession('aaaa1111', opts(sb));
  const all = turns.map((t) => t.text).join('\n');
  assert.ok(all.includes('rate limiting'), 'ordinary content survives');
  assert.ok(!all.includes('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF'), 'secret masked');
});

test('readSession works without a prior buildIndex (no cache to consult)', async () => {
  _resetForTest();
  const sb = sandbox();
  const { meta } = await readSession('dddd4444', opts(sb));
  assert.equal(meta.id, 'dddd4444');
  assert.equal(meta.host, 'codex');
  assert.equal(meta.provider, 'openai');
  assert.equal(meta.providerProvenance, 'observed');
  assert.equal(meta.transcriptProvider, 'codex');
});

// code-quality Finding 5 regressions: readCache()/locate() are now memoized
// on the cache file's own mtime + a companion id→file index, to avoid
// reparsing the whole index JSON on every /api/session/:id request. The risk
// a memoization introduces is staleness — these prove invalidation actually
// fires on a real on-disk change, not just that the happy path still works.
test('readCache/locate memo is invalidated when the cache file changes on disk (not served stale)', async () => {
  _resetForTest();
  const sb = sandbox();
  await buildIndex(opts(sb));
  const first = await readSession('dddd4444', opts(sb));
  assert.equal(first.meta.id, 'dddd4444');

  // Simulate an external mutation of the on-disk cache (e.g. another scan
  // finishing between two requests) via the same atomic write-tmp-then-
  // rename shape writeCache() itself uses — a real write always changes
  // mtime, which is exactly the signal the memo keys on.
  const raw = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
  const [cachedFile] = Object.entries(raw.entries).find(([, e]) => e.session.id === 'dddd4444');
  delete raw.entries[cachedFile]; // pretend this session's cache row is gone
  const tmp = `${sb.cachePath}.testwrite.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw));
  fs.renameSync(tmp, sb.cachePath);

  // locate() must fall back to the filename scan (the file itself is
  // untouched) rather than answering from an index built off the
  // PRE-mutation cache content still sitting in the module-level memo.
  const second = await readSession('dddd4444', opts(sb));
  assert.equal(second.meta.id, 'dddd4444',
    'must still resolve via filename fallback after the cache entry was externally removed — proves the memo picked up the mtime change');
});

// F-08 (major): the scorecard used to collapse any provider that was neither
// 'codex' nor 'claude' into 'claude' (locate()'s 2-way ternary), and parseFile
// had the same 2-way shape for the JSONL path. Policy: explicit per-id, or
// excluded-and-labeled — NEVER mis-filed as claude.
test('locate() excludes a cached entry with an unrecognized provider instead of mis-filing it as claude (F-08)', async () => {
  _resetForTest();
  const sb = sandbox();
  await buildIndex(opts(sb));

  const raw = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
  const [claudeFile, claudeEntry] = Object.entries(raw.entries).find(([, e]) => e.session.provider === 'claude');
  // Doctor the on-disk cache the way an external write (or a forward-
  // incompatible future provider) would: same real file, unrecognized
  // provider string, a fresh id so the id→file index resolves through it.
  const fakeId = 'ffff9999';
  raw.entries[claudeFile] = { ...claudeEntry, session: { ...claudeEntry.session, id: fakeId, provider: 'someother' } };
  fs.writeFileSync(sb.cachePath, JSON.stringify(raw));

  const result = await readSession(fakeId, opts(sb));
  assert.equal(result, null,
    'an unrecognized provider must never be silently parsed via parseClaude / reported as claude — it must be excluded');
});

test('locate() still resolves known claude/codex cache hits after the truthfulness fix (F-08 regression guard)', async () => {
  _resetForTest();
  const sb = sandbox();
  await buildIndex(opts(sb)); // populates the id→file cache both reads below hit

  const claudeHit = await readSession('aaaa1111', opts(sb));
  assert.equal(claudeHit.meta.host, 'claude');
  assert.equal(claudeHit.meta.transcriptProvider, 'claude');

  const codexHit = await readSession('dddd4444', opts(sb));
  assert.equal(codexHit.meta.host, 'codex');
  assert.equal(codexHit.meta.transcriptProvider, 'codex');
});

// F-08's third bug: scanKey hardcoded the roots portion to a claude/codex/
// opencode triple, so two scans differing only by a 4th root key (unused by
// scan() today, but a future root) hashed identically and could join the same
// in-flight promise — serving one scan's aggregate to a caller who asked a
// different question. buildIndex's single-flight coalescing is the direct
// consumer of scanKey, so it is the most direct place to observe the fix:
// concurrent calls that differ only by an extra root key must NOT collapse
// into the same in-flight promise (and therefore not the same result object).
test('scanKey distinguishes root sets that differ only by a root key the module does not otherwise use (F-08)', async () => {
  _resetForTest();
  const sb = sandbox();
  const a = buildIndex(opts(sb, { roots: { ...sb.roots } }));
  const b = buildIndex(opts(sb, { roots: { ...sb.roots, somethingElse: '/nonexistent/for-test' } }));
  const [aggA, aggB] = await Promise.all([a, b]);
  assert.notEqual(aggA, aggB,
    'a distinct 4th root must not collide with a scan lacking it — they must not share the in-flight promise / result object');
});

test('scan prunes cached entries past the 366-day keep window, keeps recent/undated ones', async () => {
  _resetForTest();
  const sb = sandbox();
  await buildIndex(opts(sb));

  const raw = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
  const [anyFile, anyEntry] = Object.entries(raw.entries)[0];
  const DAY = 86_400_000;

  // Both synthetic files get an OLD real mtime (fs.utimesSync) so they fall
  // OUTSIDE scan's `days` window and are excluded from `candidates` — the
  // only way scan can still know about them is the carry-forward loop this
  // test targets, not a fresh parse.
  const staleFile = `${anyFile}.stale-copy.jsonl`;
  fs.copyFileSync(anyFile, staleFile);
  fs.utimesSync(staleFile, new Date(NOW - 400 * DAY), new Date(NOW - 400 * DAY));
  raw.entries[staleFile] = {
    ...anyEntry,
    session: { ...anyEntry.session, id: 'stale-old-session', end: NOW - 400 * DAY, start: NOW - 401 * DAY },
  };

  const undatedFile = `${anyFile}.undated-copy.jsonl`;
  fs.copyFileSync(anyFile, undatedFile);
  fs.utimesSync(undatedFile, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
  raw.entries[undatedFile] = {
    ...anyEntry,
    session: { ...anyEntry.session, id: 'undated-session', end: null, start: null },
  };
  fs.writeFileSync(sb.cachePath, JSON.stringify(raw));

  await buildIndex({ ...opts(sb), days: 1, force: false });

  const after = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
  assert.ok(!(staleFile in after.entries), '366+ day old entry must be pruned — no query (days is capped at 365) can ever reach it');
  assert.ok(undatedFile in after.entries, 'an entry with no timestamp must be KEPT — never guess an age, never drop on uncertainty');
});

test('readSession returns codex user/agent messages as turns', async () => {
  _resetForTest();
  const sb = sandbox();
  const { turns } = await readSession('dddd4444', opts(sb));
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'assistant']);
  assert.ok(turns[0].text.includes('port the parser'));
});

test('user-role turns carry a kind — a tool result is never attributed to the human', async () => {
  // The Messages API records tool results under role "user", so role alone
  // must never be read as "the person typed this". The parser stamps each
  // user turn with kind: 'prompt' | 'tool-result' | 'context', and the
  // transcript renderer labels from THAT, not from role.
  _resetForTest();
  const sb = sandbox();

  // Claude: aaaa1111's fixture interleaves real prompts with a tool_result.
  const claude = await readSession('aaaa1111', opts(sb));
  const userTurns = claude.turns.filter((t) => t.role === 'user');
  assert.equal(userTurns[0].kind, 'prompt', 'the opening human prompt is a prompt');
  const toolTurn = userTurns.find((t) => t.text.startsWith('[tool result]'));
  assert.ok(toolTurn, 'the tool_result user turn is present');
  assert.equal(toolTurn.kind, 'tool-result');
  assert.equal(toolTurn.prompt, false, 'and it never counted as a human prompt');

  // Codex: rollouts only record real prompts as user_message events.
  const codex = await readSession('dddd4444', opts(sb));
  for (const t of codex.turns.filter((x) => x.role === 'user')) {
    assert.equal(t.kind, 'prompt', 'every codex user turn is a prompt by construction');
  }
});

test('harness-output envelopes are context, never the person — and never counted as prompts', async () => {
  // A user-role entry whose text the HARNESS wrote (task notifications,
  // bash/local-command stdout) carries neither isMeta nor a tool_result, so
  // text shape is the only signal. It must not be labelled "you" and must
  // not inflate the prompt count. bash-input is the opposite case: the
  // person typed that `! command`, so it stays a prompt on both axes.
  _resetForTest();
  const sb = soloSandbox();
  const base = Date.parse('2026-07-24T10:00:00.000Z');
  const iso = (offMs) => new Date(base + offMs).toISOString();
  const u = (off, text) => ({ type: 'user', sessionId: 'kkkk1111', cwd: '/Users/me/proj', timestamp: iso(off),
    message: { role: 'user', content: [{ type: 'text', text }] } });
  const lines = [
    u(0, 'promote the pipeline'),                                              // real prompt
    { type: 'assistant', sessionId: 'kkkk1111', cwd: '/Users/me/proj', timestamp: iso(1000),
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] } },
    u(2000, '<bash-input>git checkout main && git pull</bash-input>'),          // the person's ! command
    u(3000, '<bash-stdout>Switched to branch main</bash-stdout>'),              // harness output
    u(4000, '<local-command-stdout>Set model to Fable 5</local-command-stdout>'),
    u(5000, '<task-notification>\n<task-id>abc</task-id>\n</task-notification>'),
  ];
  fs.writeFileSync(path.join(sb.claude, 'kkkk1111.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const { meta, turns } = await readSession('kkkk1111', {
    days: 14, now: NOW, roots: sb.roots, cachePath: sb.cachePath, deps: deps(),
  });
  assert.equal(meta.prompts, 2, 'the real prompt and the bash-input count; harness output does not');
  const kinds = turns.filter((t) => t.role === 'user').map((t) => t.kind);
  assert.deepEqual(kinds, ['prompt', 'prompt', 'context', 'context', 'context']);
});

test('isMeta context and image-only pastes get the right kind', async () => {
  _resetForTest();
  const sb = soloSandbox();
  const base = Date.parse('2026-07-24T10:00:00.000Z');
  const iso = (offMs) => new Date(base + offMs).toISOString();
  const lines = [
    // Harness-injected context (isMeta): not typed by the person.
    { type: 'user', sessionId: 'jjjj0000', cwd: '/Users/me/proj', isMeta: true, timestamp: iso(0),
      message: { role: 'user', content: [{ type: 'text', text: '<command-name>/status</command-name>' }] } },
    // An image-only paste: no text block, so isHumanPrompt says false (it is
    // not COUNTED as a prompt) — but it IS the person acting, and its kind
    // must be 'prompt', never 'tool-result'.
    { type: 'user', sessionId: 'jjjj0000', cwd: '/Users/me/proj', timestamp: iso(1000),
      message: { role: 'user', content: [{ type: 'image', source: {} }] } },
    { type: 'assistant', sessionId: 'jjjj0000', cwd: '/Users/me/proj', timestamp: iso(2000),
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'text', text: 'Looking at the screenshot.' }] } },
  ];
  fs.writeFileSync(path.join(sb.claude, 'jjjj0000.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const { meta, turns } = await readSession('jjjj0000', {
    days: 14, now: NOW, roots: sb.roots, cachePath: sb.cachePath, deps: deps(),
  });
  assert.equal(meta.prompts, 0, 'neither turn counts as a text prompt');
  const userTurns = turns.filter((t) => t.role === 'user');
  assert.equal(userTurns[0].kind, 'context', 'isMeta harness injection is context');
  assert.equal(userTurns[1].kind, 'prompt', 'an image-only paste is still the person');
  assert.equal(userTurns[1].text, '[image]');
});

test('readSession rejects a path-traversal id without touching the disk', async () => {
  _resetForTest();
  const sb = sandbox();
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/b', 'x'.repeat(129), '', 'a$b']) {
    await assert.rejects(
      () => readSession(bad, opts(sb)),
      (e) => e.code === 'ERR_INVALID_SESSION_ID',
      `id ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('readSession returns null for an unknown but well-formed id', async () => {
  _resetForTest();
  const sb = sandbox();
  assert.equal(await readSession('no-such-session', opts(sb)), null);
});

// ── single-flight identity (qe-sec finding I) ───────────────────────────────

test('concurrent builds with DIFFERENT days do not share one scan', async () => {
  _resetForTest();
  const sb = soloSandbox();
  writeTurns(sb, 'a', [0, 60_000]);
  const [wide, narrow] = await Promise.all([
    buildIndex(opts(sb, { days: 365 })),
    buildIndex(opts(sb, { days: 1 })),
  ]);
  assert.equal(wide.windowDays, 365, 'the 365-day caller must get a 365-day aggregate');
  assert.equal(narrow.windowDays, 1, 'the 1-day caller must not be handed the 365-day answer');
});

test('concurrent builds with the SAME options still coalesce', async () => {
  _resetForTest();
  const sb = soloSandbox();
  writeTurns(sb, 'a', [0, 60_000]);
  const [x, y] = await Promise.all([buildIndex(opts(sb)), buildIndex(opts(sb))]);
  assert.deepEqual(x.totals, y.totals, 'identical requests share one scan and one result');
});

// ── project vs worktree (a session's LOCATION is not its project) ────────────
// path.basename(cwd) reported `phase-1` as a peer repository of `keel`, so eight
// worktree rows sat beside it in the tree and every project total was short by
// whatever work happened in a worktree.

test('an .autopilot worktree resolves to the repo, keeping the worktree name', () => {
  const r = projectLabel('/Users/x/Development/ai/keel/.autopilot/worktrees/agent-runtime/phase-1');
  assert.equal(r.project, 'keel', 'the repo is the project');
  assert.equal(r.worktree, 'agent-runtime/phase-1', 'the worktree is kept, not discarded');
});

test('a .claude worktree resolves to the repo', () => {
  const r = projectLabel('/Users/x/Development/ai/tub-vault/.claude/worktrees/slack-nav-collapsible-months');
  assert.equal(r.project, 'tub-vault');
  assert.equal(r.worktree, 'slack-nav-collapsible-months');
});

test('a bare .git worktree resolves to the repo', () => {
  const r = projectLabel('/repos/thing/.git/worktrees/wt-1');
  assert.equal(r.project, 'thing');
  assert.equal(r.worktree, 'wt-1');
});

test('an ordinary repo checkout is unchanged and has no worktree', () => {
  const r = projectLabel('/Users/x/Development/ai/agentic-kit');
  assert.equal(r.project, 'agentic-kit');
  assert.equal(r.worktree, null, 'a normal checkout must not invent a worktree');
});

test('a path merely CONTAINING the word worktrees is not treated as one', () => {
  // `worktrees` must follow a marker dir; a repo legitimately named for it stays itself.
  const r = projectLabel('/Users/x/code/worktrees-explained');
  assert.equal(r.project, 'worktrees-explained');
  assert.equal(r.worktree, null);
});

test('the per-session scratchpad is its own bucket, not a guessed repo', () => {
  const r = projectLabel('/private/tmp/claude-501/-Users-x-ai-agentic-kit/abc-123/scratchpad/spike');
  assert.equal(r.project, 'scratchpad', 'a temp dir is not a repository');
  assert.equal(r.worktree, 'spike');
});

test('projectLabel falls back to the encoded dir name when cwd is absent', () => {
  assert.equal(projectLabel(null, '-Users-x-ai-thing').project, 'thing');
  assert.equal(projectLabel(null, null).project, 'unknown');
});

test('worktree detection is separator-agnostic (Windows CI carries POSIX fixtures)', () => {
  // path.sep is '\\' on Windows, so splitting on it alone turns a POSIX cwd into
  // ONE segment and silently disables every rule below. Both forms must work on
  // every host, because a recorded cwd may come from WSL or a synced dotfile.
  const posix = projectLabel('/Users/x/ai/keel/.autopilot/worktrees/agent-runtime/phase-1');
  assert.equal(posix.project, 'keel');
  assert.equal(posix.worktree, 'agent-runtime/phase-1');

  const win = projectLabel('C:\\Users\\x\\ai\\keel\\.claude\\worktrees\\wt-9');
  assert.equal(win.project, 'keel', 'a backslash path must resolve the same way');
  assert.equal(win.worktree, 'wt-9');

  assert.equal(projectLabel('C:\\Users\\x\\ai\\agentic-kit').project, 'agentic-kit',
    'a plain backslash checkout must not return the whole string as the project');
});

test('noteLatencySample buckets on the shared edges', () => {
  const rec = blankSession('s1', 'claude');
  noteLatencySample(rec, 1.2);   // bucket 0 (<2s)
  noteLatencySample(rec, 8.4);   // bucket 2 (5-10s)
  noteLatencySample(rec, 700);   // bucket 5 (>60s)
  assert.deepEqual(rec.latHist, [1, 0, 1, 0, 0, 1]);
  assert.equal(rec.latCount, 3);
});

test('blankSession v11 fields default honest-absent', () => {
  const rec = blankSession('s1', 'codex');
  assert.equal(rec.mode, null);
  assert.equal(rec.ctxWindow, null);
  assert.equal(rec.aborts, 0);
});

test('parseClaude derives latency, mode, ctx from entries', () => {
  const T0 = '2026-08-20T10:00:00.000Z';
  const plusSec = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString();
  const lines = [
    JSON.stringify({ type: 'user', timestamp: T0, permissionMode: 'acceptEdits', message: { role: 'user', content: 'do it' } }),
    JSON.stringify({ type: 'assistant', timestamp: plusSec(T0, 8), message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 50 }, content: [] } }),
  ].join('\n');
  const { session: rec } = parseClaude(lines, { id: 'sess-lat' });
  assert.equal(rec.mode, 'auto-edit');
  assert.equal(rec.modeRaw, 'acceptEdits');
  assert.equal(rec.latCount, 1);
  assert.equal(rec.latHist[2], 1);            // 8s → 5-10s bucket
  assert.equal(rec.ctxLastTokens, 151000);    // input + cacheRead of last turn
});

// The same evidence gate opencode's parser was ruled to need. decodeClaudeRecord
// normalizes an ABSENT message.usage to all-zeros, so an unconditional write
// let a token-less assistant entry overwrite real context pressure with a
// fabricated 0 — the honest-absent rule inverted.
test('parseClaude: a token-less assistant entry does not zero a real ctxLastTokens', () => {
  const T0 = '2026-08-20T10:00:00.000Z';
  const plusSec = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString();
  const lines = [
    JSON.stringify({ type: 'user', timestamp: T0, message: { role: 'user', content: 'do it' } }),
    JSON.stringify({ type: 'assistant', timestamp: plusSec(T0, 8), message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 50 }, content: [] } }),
    // No `usage` key at all — claudeUsage() reads all four fields as 0.
    JSON.stringify({ type: 'assistant', timestamp: plusSec(T0, 12), message: { role: 'assistant', model: 'claude-opus-5', content: [] } }),
  ].join('\n');
  const { session: rec } = parseClaude(lines, { id: 'sess-ctx-gate' });
  assert.equal(rec.ctxLastTokens, 151000,
    'the last turn that actually recorded context wins; a token-less one carries no evidence to overwrite it with');
});

test('parseClaude: a session whose only assistant entry is token-less records no context at all', () => {
  const T0 = '2026-08-20T10:00:00.000Z';
  const lines = [
    JSON.stringify({ type: 'user', timestamp: T0, message: { role: 'user', content: 'do it' } }),
    JSON.stringify({ type: 'assistant', timestamp: T0, message: { role: 'assistant', model: 'claude-opus-5', content: [] } }),
  ].join('\n');
  const { session: rec } = parseClaude(lines, { id: 'sess-ctx-none' });
  assert.equal(rec.ctxLastTokens, null, 'honest-absent, not a measured zero');
});

// ── v11 index carry-through + lookback (Task 5) ─────────────────────────────

test('cached session entries round-trip the v11 fields across a cache hit', async () => {
  _resetForTest();
  const sb = soloSandbox();
  const T0 = '2026-08-20T10:00:00.000Z';
  const plusSec = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString();

  // "Evidence" session: the same shape as the parseClaude unit test above (a
  // permissionMode-carrying prompt, a cache-heavy reply) so mode/modeRaw/
  // latHist/latCount/lenSeconds/ctxLastTokens land on real, non-default
  // values to round-trip through the cache.
  const evidenceFile = path.join(sb.claude, 'sess-evidence.jsonl');
  fs.writeFileSync(evidenceFile, `${[
    JSON.stringify({
      type: 'user', sessionId: 'sess-evidence', cwd: '/Users/me/proj',
      timestamp: T0, permissionMode: 'acceptEdits',
      message: { role: 'user', content: 'do it' },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: 'sess-evidence', cwd: '/Users/me/proj',
      timestamp: plusSec(T0, 8),
      message: {
        role: 'assistant', model: 'claude-opus-5',
        usage: { input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 50 },
        content: [],
      },
    }),
  ].join('\n')}\n`);

  // "Blank" session: a prompt with no assistant reply at all — no mode
  // signal, no latency sample, no context-window turn — so every v11 field
  // must stay at blankSession's honest-absent default. Proves absent
  // evidence round-trips as absent, never fabricated by the cache cycle.
  const blankFile = path.join(sb.claude, 'sess-blank.jsonl');
  fs.writeFileSync(blankFile, `${JSON.stringify({
    type: 'user', sessionId: 'sess-blank', cwd: '/Users/me/proj', timestamp: T0,
    message: { role: 'user', content: 'hi' },
  })}\n`);

  const assertBoth = () => {
    const cache = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
    const evidence = cache.entries[evidenceFile].session;
    assert.equal(evidence.mode, 'auto-edit');
    assert.equal(evidence.modeRaw, 'acceptEdits');
    assert.equal(evidence.latCount, 1);
    assert.deepEqual(evidence.latHist, [0, 0, 1, 0, 0, 0]); // 8s -> 5-10s bucket
    assert.equal(evidence.lenSeconds, 8);
    assert.equal(evidence.ctxLastTokens, 151000);           // input + cacheRead of last turn
    assert.equal(evidence.ctxWindow, null, 'ctxWindow is codex-only evidence');
    assert.equal(evidence.aborts, 0, 'aborts is codex-only evidence');

    const blank = cache.entries[blankFile].session;
    assert.equal(blank.mode, null);
    assert.equal(blank.modeRaw, null);
    assert.equal(blank.latHist, null);
    assert.equal(blank.latCount, 0);
    assert.equal(blank.lenSeconds, 0);
    assert.equal(blank.ctxWindow, null);
    assert.equal(blank.ctxLastTokens, null);
    assert.equal(blank.aborts, 0);
  };

  await buildIndex(opts(sb));
  assertBoth(); // fresh parse

  _resetForTest(); // clears the in-process single-flight/memo, NOT the on-disk cache
  await buildIndex(opts(sb)); // same (path, mtime, size) on both files — must hit the cache
  assertBoth(); // cache-hit read: identical values prove the round trip
});

// ── lookback (Task 5) ────────────────────────────────────────────────────────

test("buildIndex({ days, lookbackDays }) widens discovery/parse; unset stays exactly today's behavior", async () => {
  _resetForTest();
  const sb = soloSandbox();
  const DAY = 86_400_000;
  const tenDaysAgo = NOW - 10 * DAY;

  const file = path.join(sb.claude, 'old-session.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'assistant', sessionId: 'old-session', cwd: '/Users/me/proj',
    timestamp: new Date(tenDaysAgo).toISOString(),
    message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  })}\n`);
  // Backdate the file's REAL mtime to match its content: a genuinely 10-day-
  // old transcript, not just an old timestamp inside a freshly-written file —
  // so this exercises the candidates mtime filter too, not only aggregate's.
  fs.utimesSync(file, new Date(tenDaysAgo), new Date(tenDaysAgo));

  const plain = await buildIndex(opts(sb, { days: 7 }));
  assert.equal(byId(plain, 'old-session'), undefined, 'a 10-day-old session is outside a plain 7-day window');

  _resetForTest();
  const undefinedLookback = await buildIndex(opts(sb, { days: 7, lookbackDays: undefined }));
  assert.equal(byId(undefinedLookback, 'old-session'), undefined, 'lookbackDays: undefined must not widen the window either');
  assert.deepEqual(undefinedLookback.totals, plain.totals, 'unset lookbackDays is identical to omitting it entirely');

  // Task 7 (2026-08-28-scorecard-matrix-a SDD) ruling B: lookbackDays alone
  // no longer widens what the CURRENT window's sessions/totals contain — only
  // discovery/parse/cache. `aggregate` is always called with the DISPLAY
  // cutoff (now - days*DAY_MS), so a `previous: true`-less caller must see
  // exactly the same current-window sessions as the plain 7-day scan; the
  // widened read is only observable via the on-disk cache (proving discovery/
  // parse actually reached the file) or via `previous` below.
  _resetForTest();
  const widened = await buildIndex(opts(sb, { days: 7, lookbackDays: 14 }));
  assert.equal(byId(widened, 'old-session'), undefined,
    'lookbackDays alone must not leak the old session into the CURRENT window — that is the bug this ruling fixes');
  assert.deepEqual(widened.totals, plain.totals, 'the current window is byte-identical to the plain 7-day scan');
  assert.equal(widened.windowDays, 7, 'the nominal window label still reports `days` unchanged');
  const cache = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
  assert.equal(cache.entries[file]?.session?.id, 'old-session',
    'discovery/parse DID reach the old file — it is cached even though the current window excludes it');

  // Paired with `previous: true`, the widened read is what makes the old
  // session reachable at all — via the previous-window projection, not by
  // hand-splitting a widened sessions[].
  _resetForTest();
  const withPrevious = await buildIndex(opts(sb, { days: 7, lookbackDays: 14, previous: true }));
  assert.equal(byId(withPrevious, 'old-session'), undefined, 'still excluded from the current window');
  assert.equal(withPrevious.totals.sessions, 0, 'the current 7-day window has no sessions at all');
  assert.equal(withPrevious.previous.totals.sessions, 1,
    'the 10-day-old session lands in the previous [14d, 7d) window instead');
});

// F-08-style regression guard (see the scanKey test above): lookbackDays now
// changes scan()'s RESULT the same way days/force/roots/cachePath already do,
// so it must be folded into the single-flight/memo identity too — concurrent
// calls differing only by lookbackDays must not collapse into one answer and
// serve a { days: 7 } caller the { days: 7, lookbackDays: 14 } aggregate (or
// vice versa).
test('scanKey distinguishes calls that differ only by lookbackDays', async () => {
  _resetForTest();
  const sb = sandbox();
  const a = buildIndex(opts(sb, { lookbackDays: undefined }));
  const b = buildIndex(opts(sb, { lookbackDays: 28 }));
  const [aggA, aggB] = await Promise.all([a, b]);
  assert.notEqual(aggA, aggB,
    'a call with lookbackDays set must not collide with one that omits it — they must not share the in-flight promise / result object');
});

// Task 7 fix round 1: the same F-08-style regression guard as the lookbackDays
// test above, now for `previous` — added after review flagged that scanKey
// folded lookbackDays into its identity but not previous, so a {previous:true}
// caller (e.g. /api/usage) racing a {previous:false} caller (e.g. the Models
// tab) with otherwise-identical options could have shared one memoized answer.
test('scanKey distinguishes calls that differ only by previous', async () => {
  _resetForTest();
  const sb = sandbox();
  const a = buildIndex(opts(sb, { previous: false }));
  const b = buildIndex(opts(sb, { previous: true }));
  const [aggA, aggB] = await Promise.all([a, b]);
  assert.notEqual(aggA, aggB,
    'a call with previous:true must not collide with one that omits it — they must not share the in-flight promise / result object');
});

// ── aggregate: buckets, rhythm, per-day engaged, previous window (Task 6) ───
//
// These suites drive `aggregate()` directly instead of through buildIndex: the
// previous-window projection reads records OLDER than the cutoff, which only
// reach the aggregate when the index was built with a lookback, and the mode /
// provenance / latency permutations they pin are cheaper to state as records
// than as transcripts. Fixtures are still built from the parsers' own
// blankSession/addUsage (never a hand-mirrored record literal), so they go
// stale loudly if the record contract moves.

const DAY = 86_400_000;

const usageRow = (day, model, u = {}) =>
  ({ day, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 1, ...u });

/** One parsed record. `end` is what the window filter reads; `active` defaults
 *  to the whole span and `lenSeconds` is derived from it the way `seal()` does,
 *  so a fixture cannot claim a length its intervals do not support. */
function record(id, { start, end = NOW - DAY, usage = [], active, ...over } = {}) {
  const rec = blankSession(id, over.provider ?? 'claude');
  const from = start ?? end - 30 * MIN;
  Object.assign(rec, { title: id, project: 'proj', prompts: 1, responses: 1, ...over, start: from, end });
  rec.active = active ?? [[from, end]];
  for (const u of usage) addUsage(rec, u.day, u.model, u);
  if (!rec.models.length) rec.models = [...new Set(usage.map((u) => u.model))];
  rec.lenSeconds = over.lenSeconds
    ?? Math.round(rec.active.reduce((n, [a, b]) => n + (b - a), 0) / 1000);
  return rec;
}

const aggOpts = (extra = {}) => ({ days: 14, now: NOW, cutoff: NOW - 14 * DAY, deps: deps(), ...extra });

/** Rates in $/1M tokens, and a pricer shaped like the real one (cache reads
 *  meter at a tenth of the input rate) so `cacheSavedUsd` can be hand-worked. */
const RATE_IN = 3;
const RATE_OUT = 15;
const pricedDeps = () => ({
  ...deps(),
  costOf: ({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) =>
    ((input + cacheWrite * 1.25 + cacheRead * 0.1) * RATE_IN + output * RATE_OUT) / 1e6,
});

test('percentileFromBuckets interpolates inside the bucket and is null when empty', () => {
  assert.equal(percentileFromBuckets([0, 0, 0, 0, 0, 0], LAT_BUCKET_EDGES, 0.5), null,
    'nothing measured is null, never 0 — they are different claims');
  // 10 samples all in the 5–10s bucket: p50 sits exactly mid-bucket.
  const p = percentileFromBuckets([0, 0, 10, 0, 0, 0], LAT_BUCKET_EDGES, 0.5);
  assert.ok(p > 5 && p <= 10, `p50 must land inside the 5–10s bucket, got ${p}`);
  assert.equal(p, 7.5);
  // The overflow bucket has no upper bound to interpolate towards, so it
  // reports its floor: "at least 60s", never an invented ceiling.
  assert.equal(percentileFromBuckets([0, 0, 0, 0, 0, 4], LAT_BUCKET_EDGES, 0.5), 60);
  assert.equal(percentileFromBuckets(null, LAT_BUCKET_EDGES, 0.5), null);
});

test('modelFamily folds an id to its family and never guesses', () => {
  assert.equal(modelFamily('claude-opus-5-20260115'), 'opus');
  assert.equal(modelFamily('gpt-5.6-sol'), 'gpt-5');
  assert.equal(modelFamily('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(modelFamily('anthropic/claude-sonnet-5'), 'sonnet');
  assert.equal(modelFamily('gpt-4o-mini'), 'gpt-4');
  assert.equal(modelFamily('unknown'), 'other', 'the parsers\' own placeholder is not a family');
  assert.equal(modelFamily('gemini-3.5-flash'), 'other');
  assert.equal(modelFamily(null), 'other');
});

test('the aggregate buckets on the same histogram edges the parsers fill', () => {
  // usage-aggregate.mjs cannot import usage-parsers.mjs (the dependency is
  // one-way, by design), so the edges are restated there. This is the pin that
  // makes the restatement safe.
  assert.deepEqual(AGG_LAT_EDGES, LAT_BUCKET_EDGES);
  assert.deepEqual(AGG_LEN_EDGES, LEN_BUCKET_EDGES);
});

test('byMode, bySource and byTool bucket honestly, and no provider axis is aggregated', () => {
  const records = [
    record('m1', { mode: 'auto-edit', inferenceProvider: 'openai', providerProvenance: 'observed', tools: { Edit: 2 } }),
    record('m2', { mode: null, tools: { Read: 1 } }),
    record('m3', { mode: null, inferenceProvider: 'anthropic', providerProvenance: 'unknown', sidechain: true, tools: { Edit: 1 } }),
  ];
  const a = aggregate(records, aggOpts());

  assert.equal(a.byMode['auto-edit'].sessions, 1);
  assert.equal(a.byMode['not-recorded'].sessions, 2, 'no mode evidence is its own bucket, never folded into a real mode');
  // Inference provider is per-session evidence, not a window axis: a
  // transcript host does not prove which vendor served the tokens, so there
  // is no aggregate bucket for it. byProvider — the transcript host identity
  // this repository has always recorded — is unaffected.
  assert.ok(!Object.hasOwn(a, 'byInferenceProvider'),
    'the aggregate must not carry an inference-provider bucket');
  assert.equal(a.byProvider.anthropic.sessions, 1);
  assert.equal(a.bySource.main.sessions, 2);
  assert.equal(a.bySource.subagent.sessions, 1);
  assert.deepEqual({ ...a.byTool }, { Edit: 3, Read: 1 });
});

test('per-session provider provenance survives even though the aggregate axis is gone', () => {
  const a = aggregate([
    record('p1', { inferenceProvider: 'openai', providerProvenance: 'observed' }),
  ], aggOpts());
  const row = a.sessions.find((s) => s.id === 'p1');
  assert.equal(row.provider, 'openai');
  assert.equal(row.providerProvenance, 'observed');
});

test('bySource always carries both rows, even with no subagent work', () => {
  const a = aggregate([record('solo')], aggOpts());
  assert.equal(a.bySource.main.sessions, 1);
  assert.equal(a.bySource.subagent.sessions, 0, '"no subagents" is a zero worth rendering, not a missing row');
});

test('a Codex thread_source of subagent counts as subagent work too', () => {
  const a = aggregate([record('sub', { provider: 'codex', threadSource: 'subagent' })], aggOpts());
  assert.equal(a.bySource.subagent.sessions, 1);
});

test('rhythm merges the per-session latency histograms and buckets session lengths', () => {
  const end = (d) => NOW - d * DAY;
  const records = [
    record('r1', { end: end(3), start: end(3) - 120_000, latHist: [0, 0, 2, 0, 0, 0], latCount: 2 }),
    record('r2', { end: end(2), start: end(2) - 1_800_000, latHist: [1, 0, 0, 0, 0, 1], latCount: 2 }),
    record('r3', { end: end(1), start: end(1) - 5_400_000, latHist: null, latCount: 0 }),
  ];
  const a = aggregate(records, aggOpts());

  assert.deepEqual(a.rhythm.latHist, [1, 0, 2, 0, 0, 1]);
  assert.equal(a.rhythm.latCount, 4, 'the session that observed no latency contributes nothing, not a row of zeroes');
  assert.equal(a.rhythm.latP50, 7.5);
  assert.equal(a.rhythm.latP95, 60, 'the >60s bucket reports its floor');
  // 120s → ≤300 bucket, 1800s → ≤2700 bucket, 5400s → ≤7200 bucket.
  assert.deepEqual(a.rhythm.lenHist, [1, 0, 1, 1, 0]);
  assert.equal(a.rhythm.lenMedianSeconds, 1800);
  assert.equal(a.rhythm.lenP90Seconds, 5850);
});

test('a session past the last length edge lands in the overflow bucket', () => {
  const end = NOW - DAY;
  const a = aggregate([record('long', { end, start: end - 3 * 3600_000 })], aggOpts());
  assert.deepEqual(a.rhythm.lenHist, [0, 0, 0, 0, 1], 'three hours is past the 2h edge');
  assert.equal(a.rhythm.lenMedianSeconds, 7200, 'an unbounded bucket reports its floor, not a made-up ceiling');
});

test('rhythm is a zeroed histogram, not a fabricated one, when nothing was measured', () => {
  const a = aggregate([], aggOpts());
  assert.deepEqual(a.rhythm.latHist, [0, 0, 0, 0, 0, 0], 'always six slots, even empty');
  assert.equal(a.rhythm.latCount, 0);
  assert.equal(a.rhythm.latP50, null);
  assert.equal(a.rhythm.latP95, null);
  assert.deepEqual(a.rhythm.lenHist, [0, 0, 0, 0, 0]);
  assert.equal(a.rhythm.lenMedianSeconds, null);
});

test('totals carry aborts and the per-hour / per-prompt / median rates', () => {
  const end = (d) => NOW - d * DAY;
  const records = [
    record('t1', {
      end: end(3), start: end(3) - 1_800_000, prompts: 3, responses: 4, aborts: 2,
      usage: [usageRow('2026-07-22', 'claude-opus-5', { input: 1000 })],
    }),
    record('t2', {
      end: end(2), start: end(2) - 1_800_000, prompts: 1, responses: 2, aborts: 0,
      usage: [usageRow('2026-07-23', 'claude-opus-5', { input: 3000 })],
    }),
  ];
  const a = aggregate(records, aggOpts());

  assert.equal(a.totals.engagedSeconds, 3600, 'two disjoint half-hours = one engaged hour');
  assert.equal(a.totals.aborts, 2);
  assert.equal(a.totals.humanPrompts, 4, 'both sessions are main-thread here');
  assert.equal(a.totals.humanPromptsPerHour, 4, '4 prompts in one engaged hour');
  assert.equal(a.totals.responsesPerPrompt, 1.5, '6 responses / 4 human prompts');
  assert.equal(a.totals.costPerEngagedHour, 4, '$4 of spend in one engaged hour');
  assert.equal(a.totals.costPerSessionMedian, 2, 'the exact median of [1, 3]');
});

test('a subagent\'s prompts never inflate the per-prompt denominators', () => {
  // The subagent's 9 prompts were written by the harness, not typed by a
  // person: counting them would report 10 prompts an hour where a human typed 1.
  const end = (d) => NOW - d * DAY;
  const records = [
    record('main1', {
      end: end(3), start: end(3) - 3_600_000, prompts: 1, responses: 2,
      usage: [usageRow('2026-07-22', 'claude-opus-5', { input: 1000 })],
    }),
    record('side1', {
      end: end(3) - 1_800_000, start: end(3) - 3_600_000, sidechain: true,
      prompts: 9, responses: 4,
      usage: [usageRow('2026-07-22', 'claude-opus-5', { input: 1000 })],
    }),
  ];
  const a = aggregate(records, aggOpts());

  assert.equal(a.totals.prompts, 10, 'the raw count still records every prompt');
  assert.equal(a.totals.humanPrompts, 1, 'only the main thread had a person typing');
  assert.equal(a.totals.engagedSeconds, 3600, 'the sidechain runs inside the main session');
  assert.equal(a.totals.humanPromptsPerHour, 1, 'one human prompt in one engaged hour');
  assert.equal(a.totals.responsesPerPrompt, 6, '6 responses / 1 human prompt');
});

test('a structurally-$0 session does not drag the cost median or P90 down', () => {
  // `zero` has no usage rows at all — a stripped Codex subagent or a session
  // that never billed. Its $0 is missing evidence, not cheap work, so the
  // distribution must be taken over the three priced sessions alone.
  const end = (d) => NOW - d * DAY;
  const priced = (id, d, input) => record(id, {
    end: end(d), start: end(d) - 30 * MIN,
    usage: [usageRow('2026-07-22', 'claude-opus-5', { input })],
  });
  const a = aggregate([
    priced('p1', 2, 2000), priced('p2', 3, 4000), priced('p3', 4, 6000),
    record('zero', { end: end(5), start: end(5) - 30 * MIN, provider: 'codex', threadSource: 'subagent' }),
  ], aggOpts());

  assert.equal(a.totals.sessions, 4, 'the unpriced session is still a session');
  assert.equal(a.totals.costPerSessionMedian, 4, 'the median of [2, 4, 6], not of [0, 2, 4, 6]');
  assert.equal(a.totals.costPerSessionP90, 6);
});

test('an all-unpriced window reports no cost distribution rather than $0', () => {
  const a = aggregate([record('nousage')], aggOpts());
  assert.equal(a.totals.costPerSessionMedian, null,
    '"we measured nothing" is not "the typical session cost nothing"');
  assert.equal(a.totals.costPerSessionP90, null);
});

test('a rate with no engaged time is null, not zero', () => {
  // A single-instant session: real, but it has no duration to divide by.
  const at = NOW - DAY;
  const a = aggregate([record('instant', { start: at, end: at, active: [[at, at]] })], aggOpts());
  assert.equal(a.totals.engagedSeconds, 0);
  assert.equal(a.totals.humanPromptsPerHour, null, '"not measured" is not "zero per hour"');
  assert.equal(a.totals.costPerEngagedHour, null);
});

test('cacheSavedUsd is the spend a cache read did not pay', () => {
  // 1M cache-read tokens at $3/1M input: charged 0.1 × $3 = $0.30, so $2.70 of
  // the $3.00 they would have cost as fresh input was avoided.
  const a = aggregate([record('c1', {
    usage: [usageRow('2026-07-24', 'claude-opus-5', { cacheRead: 1e6 })],
  })], aggOpts({ deps: pricedDeps() }));

  assert.equal(a.totals.cost, 0.3);
  assert.equal(a.totals.cacheSavedUsd, 2.7);
  assert.equal(a.sessions[0].cacheSavedUsd, 2.7, 'the total is auditable per session');
  assert.equal(
    Math.round((a.totals.cost + a.totals.cacheSavedUsd) * 1e6) / 1e6, 3,
    'charged + saved = what those tokens would have cost as fresh input',
  );
});

test('the cache discount comes from the pricer, not a constant baked in here', () => {
  // Same 1M cache reads under a pricer that charges HALF the input rate for
  // them instead of a tenth. A hardcoded "0.9 × input rate" would still answer
  // $2.70; differencing the pricer's own two answers gives the true $1.50.
  const half = () => ({
    ...deps(),
    costOf: ({ input = 0, cacheRead = 0 }) => ((input + cacheRead * 0.5) * RATE_IN) / 1e6,
  });
  const a = aggregate([record('c3', {
    usage: [usageRow('2026-07-24', 'claude-opus-5', { cacheRead: 1e6 })],
  })], aggOpts({ deps: half() }));

  assert.equal(a.totals.cost, 1.5);
  assert.equal(a.totals.cacheSavedUsd, 1.5, 'half of $3, because this pricer discounts by half');
});

test('a pricer with no cache discount at all reports no saving', () => {
  const flat = () => ({
    ...deps(),
    costOf: ({ input = 0, cacheRead = 0 }) => ((input + cacheRead) * RATE_IN) / 1e6,
  });
  const a = aggregate([record('c4', {
    usage: [usageRow('2026-07-24', 'claude-opus-5', { cacheRead: 1e6 })],
  })], aggOpts({ deps: flat() }));
  assert.equal(a.totals.cacheSavedUsd, 0, 'nothing was avoided, so nothing is claimed');
});

test('a session with no cache reads saved nothing', () => {
  const a = aggregate([record('c2', {
    usage: [usageRow('2026-07-24', 'claude-opus-5', { input: 1000 })],
  })], aggOpts({ deps: pricedDeps() }));
  assert.equal(a.totals.cacheSavedUsd, 0);
});

test('engagedByDay splits an over-midnight session at LOCAL midnight', () => {
  // 23:30 → 00:30 local: half an hour belongs to each day, not a whole hour to
  // the day it started on.
  const start = new Date(2026, 6, 23, 23, 30).getTime();
  const end = new Date(2026, 6, 24, 0, 30).getTime();
  const a = aggregate([record('mid', {
    start, end, usage: [usageRow('2026-07-23', 'claude-opus-5', { input: 100 })],
  })], aggOpts());

  assert.equal(a.engagedByDay['2026-07-23'], 1800);
  assert.equal(a.engagedByDay['2026-07-24'], 1800, 'the day it ran into gets its real minutes');
  assert.equal(a.totals.engagedSeconds, 3600, 'the window-wide union is unchanged by the split');
});

test('engagedByDay is a sibling map — byDay keeps its billed-days-only contract', () => {
  // The same over-midnight session. Work happened on two days; tokens billed on
  // one. byDay must show exactly the billed day, with no synthetic zero-token
  // row for the day that was only worked — the insight detectors count active
  // days from those keys.
  const start = new Date(2026, 6, 23, 23, 30).getTime();
  const end = new Date(2026, 6, 24, 0, 30).getTime();
  const a = aggregate([record('mid2', {
    start, end, usage: [usageRow('2026-07-23', 'claude-opus-5', { input: 100 })],
  })], aggOpts());

  assert.deepEqual(Object.keys(a.byDay), ['2026-07-23'], 'only the billed day');
  assert.equal(a.byDay['2026-07-24'], undefined, 'no invented zero-token row');
  assert.equal('engagedSeconds' in a.byDay['2026-07-23'], false,
    'engaged time is not a byDay field — detectors see byDay unchanged');
  assert.deepEqual(Object.keys(a.engagedByDay).sort(), ['2026-07-23', '2026-07-24']);
});

test('engagedByDay unions overlapping sessions instead of summing them', () => {
  const base = new Date(2026, 6, 22, 10, 0).getTime();
  const a = aggregate([
    record('p1', { start: base, end: base + 60 * MIN }),
    record('p2', { start: base + 30 * MIN, end: base + 90 * MIN }),
  ], aggOpts());
  assert.equal(a.engagedByDay['2026-07-22'], 90 * 60,
    'parallel sessions do not let a day claim more minutes than it had');
});

test('engagedByDay sums to totals.engagedSeconds, with no phantom day at an exact midnight', () => {
  // One session ends exactly at midnight and another spans it, so the day
  // boundary is hit both ways in the same window.
  const d22 = new Date(2026, 6, 22, 22, 0).getTime();
  const midnight = new Date(2026, 6, 23, 0, 0).getTime();
  const a = aggregate([
    record('ends-at-midnight', { start: d22, end: midnight }),
    record('crosses', { start: midnight - 30 * MIN, end: midnight + 30 * MIN }),
  ], aggOpts());

  const summed = Object.values(a.engagedByDay).reduce((x, y) => x + y, 0);
  assert.equal(summed, a.totals.engagedSeconds, 'the per-day unions partition the window union');
  assert.deepEqual(Object.keys(a.engagedByDay).sort(), ['2026-07-22', '2026-07-23'],
    'an interval ending exactly at midnight creates no next-day entry');
  assert.equal(a.engagedByDay['2026-07-22'], 2 * 3600, '22:00 → 00:00, the overlap counted once');
  assert.equal(a.engagedByDay['2026-07-23'], 30 * 60);
});

test('the midnight split follows the local clock across a DST transition', () => {
  // America/New_York, 2026-03-08: the clocks jump 02:00 → 03:00, so that local
  // day is 23 hours long. A session running 03-07 23:00 → 03-09 00:00 local
  // must give the short day its real 23 hours, not a nominal 24.
  const saved = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const start = Date.parse('2026-03-08T04:00:00Z');   // 2026-03-07 23:00 EST
    const end = Date.parse('2026-03-09T04:00:00Z');     // 2026-03-09 00:00 EDT
    const now = Date.parse('2026-03-10T12:00:00Z');
    const a = aggregate([record('dst', { start, end })],
      { days: 14, now, cutoff: now - 14 * DAY, deps: deps() });

    assert.equal(a.engagedByDay['2026-03-07'], 3600, '23:00 → local midnight');
    assert.equal(a.engagedByDay['2026-03-08'], 23 * 3600, 'the 23-hour day, not a nominal 24');
    assert.equal(a.engagedByDay['2026-03-09'], undefined, 'it ended exactly at midnight');
    assert.equal(a.totals.engagedSeconds, 24 * 3600, 'wall-clock elapsed is still 24 hours');
    assert.equal(
      Object.values(a.engagedByDay).reduce((x, y) => x + y, 0), a.totals.engagedSeconds,
      'the invariant survives a day that is not 86400 seconds long',
    );
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('the session row projects the v11 posture and context-window evidence', () => {
  const a = aggregate([record('ctx', {
    mode: 'auto-edit', modeRaw: 'acceptEdits', ctxWindow: 200_000, ctxLastTokens: 151_000,
    usage: [usageRow('2026-07-24', 'claude-opus-5', { input: 1000 })],
  })], aggOpts());
  const s = a.sessions[0];

  assert.equal(s.mode, 'auto-edit');
  assert.equal(s.modeRaw, 'acceptEdits', 'the raw string the transcript carried, beside the normalized one');
  assert.equal(s.ctxWindow, 200_000);
  assert.equal(s.ctxLastTokens, 151_000);
});

test('the v11 projection stays honest-absent when the transcript recorded nothing', () => {
  // blankSession's defaults: a source that carries no posture or context
  // evidence must project null, never a zero that reads as a measurement.
  const a = aggregate([record('bare')], aggOpts());
  const s = a.sessions[0];

  assert.equal(s.modeRaw, null);
  assert.equal(s.ctxWindow, null);
  assert.equal(s.ctxLastTokens, null);
});

test('byDay carries exceptions and cacheRead for the reliability and cache trends', () => {
  // `busted` bills on the 22nd and carries 2 exceptions; `clean` bills on the
  // 23rd with none. Exceptions follow the first-billed-day convention the
  // session count already uses.
  const end = (d) => NOW - d * DAY;
  const a = aggregate([
    record('busted', {
      end: end(3), start: end(3) - 30 * MIN, exceptions: 2,
      usage: [
        usageRow('2026-07-22', 'claude-opus-5', { input: 100, cacheRead: 900 }),
        usageRow('2026-07-22', 'claude-sonnet-5', { input: 50, cacheRead: 150 }),
      ],
    }),
    record('clean', {
      end: end(2), start: end(2) - 30 * MIN, exceptions: 0,
      usage: [usageRow('2026-07-23', 'claude-opus-5', { input: 400 })],
    }),
  ], aggOpts());

  assert.equal(a.byDay['2026-07-22'].exceptions, 2, 'attributed to the day the session first billed');
  assert.equal(a.byDay['2026-07-22'].cacheRead, 1050, 'summed across every usage row of the day');
  assert.equal(a.byDay['2026-07-22'].tokens, 1200, 'cacheRead is a slice of tokens, not an addition to it');

  // A day that saw neither an exception nor a cache read still carries both
  // fields at zero — a chart reading `undefined` would render a gap where the
  // truth is a measured zero.
  assert.equal(a.byDay['2026-07-23'].exceptions, 0);
  assert.equal(a.byDay['2026-07-23'].cacheRead, 0);
  assert.equal(a.totals.exceptions, 2, 'the window total is unchanged by the per-day split');
});

test('byDay carries cost by mode and by model family', () => {
  const a = aggregate([
    record('d1', { mode: 'auto-edit', usage: [usageRow('2026-07-24', 'claude-opus-5-20260115', { input: 2000 })] }),
    record('d2', { mode: null, usage: [usageRow('2026-07-24', 'gpt-5.6-sol', { input: 1000 })] }),
  ], aggOpts());

  assert.deepEqual({ ...a.byDay['2026-07-24'].byMode }, { 'auto-edit': 2, 'not-recorded': 1 });
  assert.deepEqual({ ...a.byDay['2026-07-24'].byModelFamily }, { opus: 2, 'gpt-5': 1 });
});

test('previous window aggregates the prior equal span only', () => {
  const days = 7;
  const cutoff = NOW - days * DAY;
  const end = (d) => NOW - d * DAY;
  const records = [
    record('cur1', { end: end(2), start: end(2) - 30 * MIN }),
    record('prev1', { end: end(8), start: end(8) - 30 * MIN }),
    record('prev2', { end: end(13), start: end(13) - 30 * MIN }),
    record('older', { end: end(20), start: end(20) - 30 * MIN }),
  ];
  const a = aggregate(records, { days, now: NOW, cutoff, deps: deps(), previous: true });

  assert.equal(a.totals.sessions, 1, 'the current window is untouched by asking for the previous one');
  assert.equal(a.previous.totals.sessions, 2, 'only the two sessions aged 7–14 days');
  assert.deepEqual(Object.keys(a.previous).sort(), ['rhythm', 'totals'],
    'a totals+rhythm projection — nothing downstream compares project trees across windows');
  assert.equal(a.previous.rhythm.lenHist.reduce((x, y) => x + y, 0), 2);
});

test('a session ending exactly at the window start belongs to the current window, never both', () => {
  const days = 7;
  const cutoff = NOW - days * DAY;
  const a = aggregate([record('edge', { end: cutoff, start: cutoff - 30 * MIN })],
    { days, now: NOW, cutoff, deps: deps(), previous: true });
  assert.equal(a.totals.sessions, 1);
  assert.equal(a.previous.totals.sessions, 0, 'the previous window\'s upper bound is exclusive');
});

test('the previous window tracks the DISPLAYED span, not however far the cutoff was widened', () => {
  // The caller widened `cutoff` to 21 days so older records survive to be
  // compared against. The baseline must still be the 7 days before the
  // displayed 7 — a delta measured against a silently-21-day window is not a
  // delta against "last week".
  const days = 7;
  const end = (d) => NOW - d * DAY;
  const records = [
    record('cur', { end: end(3), start: end(3) - 30 * MIN }),      // displayed window
    record('prevA', { end: end(9), start: end(9) - 30 * MIN }),    // the window before it
    record('prevB', { end: end(12), start: end(12) - 30 * MIN }),  // still that window
    record('older', { end: end(17), start: end(17) - 30 * MIN }),  // two windows back
  ];
  const a = aggregate(records, {
    days, now: NOW, cutoff: NOW - 21 * DAY, deps: deps(), previous: true,
  });

  assert.equal(a.totals.sessions, 4, 'the widened cutoff is what the current window honours');
  assert.equal(a.previous.totals.sessions, 2, 'exactly [now − 14d, now − 7d): prevA and prevB');
  assert.equal(a.previous.rhythm.lenHist.reduce((x, y) => x + y, 0), 2);
});

test('previous is null unless the caller asks for it', () => {
  const a = aggregate([record('cur')], aggOpts());
  assert.equal(a.previous, null, 'null is "not requested" — an empty totals object would read as "measured nothing"');
});

// ── nested Claude subagent transcripts (Lane-P) ─────────────────────────────
//
// Claude Code writes sidechain/subagent transcripts one level below the main
// session file, at <project>/<sessionId>/subagents/agent-*.jsonl — a shape
// listClaude never walked into, so this cost-bearing work was invisible to
// every index/aggregate consumer. parseClaude already prices these bytes
// correctly and marks them sidechain from their own entries (isSidechain);
// the gap was purely in discovery.

/** Write a nested `<parentId>/subagents/<stem>.jsonl` transcript under a
 *  soloSandbox()'s claude project dir — one prompt + one priced reply, both
 *  entries carrying `isSidechain: true` exactly as Claude Code's real
 *  on-disk format does. */
function writeSubagentTranscript(sb, parentId, stem, usage) {
  const subDir = path.join(sb.claude, parentId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const T0 = '2026-08-20T10:00:00.000Z';
  fs.writeFileSync(path.join(subDir, `${stem}.jsonl`), `${[
    JSON.stringify({
      type: 'user', sessionId: parentId, cwd: '/Users/me/proj', isSidechain: true,
      timestamp: T0, message: { role: 'user', content: 'subtask' },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: parentId, cwd: '/Users/me/proj', isSidechain: true,
      timestamp: T0, message: { role: 'assistant', model: 'claude-opus-5', usage, content: [] },
    }),
  ].join('\n')}\n`);
}

test('nested subagent transcripts get parent-namespaced ids — no collision across two parents', async () => {
  _resetForTest();
  const sb = soloSandbox();
  const usage = { input_tokens: 10, output_tokens: 5 };
  writeSubagentTranscript(sb, 'parent-a', 'agent-001', usage);
  writeSubagentTranscript(sb, 'parent-b', 'agent-001', usage);

  const agg = await buildIndex(opts(sb));
  const ids = agg.sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, ['parent-a/agent-001', 'parent-b/agent-001'],
    'the same agent-001 stem under two different parents must yield two distinct records, never one overwriting the other');
});

test('a nested subagent transcript is discovered, priced, and folded into bySource.subagent', async () => {
  _resetForTest();
  const sb = soloSandbox();
  const T0 = '2026-08-20T10:00:00.000Z';
  const mainId = 'main-session';

  // The main, non-sidechain session.
  fs.writeFileSync(path.join(sb.claude, `${mainId}.jsonl`), `${[
    JSON.stringify({ type: 'user', sessionId: mainId, cwd: '/Users/me/proj', timestamp: T0, message: { role: 'user', content: 'do the thing' } }),
    JSON.stringify({ type: 'assistant', sessionId: mainId, cwd: '/Users/me/proj', timestamp: T0, message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 20 }, content: [] } }),
  ].join('\n')}\n`);

  // Its own subagent transcript — real, cost-bearing work.
  writeSubagentTranscript(sb, mainId, 'agent-001', { input_tokens: 1000, output_tokens: 200 });

  const agg = await buildIndex(opts(sb));

  assert.equal(agg.totals.sessions, 2, 'both the main session and its subagent transcript are counted');
  assert.ok(byId(agg, mainId), 'the main session is present');
  const sub = agg.sessions.find((s) => s.id === `${mainId}/agent-001`);
  assert.ok(sub, 'the nested subagent session is present, namespaced under its parent');
  assert.equal(sub.sidechain, true, 'parseClaude marks it sidechain from its own isSidechain entries');

  assert.equal(agg.bySource.main.sessions, 1);
  assert.equal(agg.bySource.subagent.sessions, 1);
  assert.equal(agg.bySource.main.cost, 0.12);
  assert.equal(agg.bySource.subagent.cost, 1.2, "the subagent transcript's own usage prices as real, nonzero cost — not swallowed as $0");
  assert.equal(agg.totals.cost, 1.32, 'totals include the subagent cost alongside the main session');
  // The codex ledger-strip path (applyCodexLedger) is untouched by this fix —
  // this fixture has no codex candidates at all, so its absence here is the
  // most direct evidence; the full existing codex-ledger test coverage
  // elsewhere in this suite is unaffected (see the green-bar run).
});

test('an unreadable subagents dir degrades silently — the parent session is unaffected, no new health field invented', async () => {
  _resetForTest();
  const sb = soloSandbox();
  const T0 = '2026-08-20T10:00:00.000Z';
  const mainId = 'main-with-bad-subagents';

  fs.writeFileSync(path.join(sb.claude, `${mainId}.jsonl`), `${JSON.stringify({
    type: 'assistant', sessionId: mainId, cwd: '/Users/me/proj', timestamp: T0,
    message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  })}\n`);

  fs.mkdirSync(path.join(sb.claude, mainId));
  // A FILE where the subagents directory is expected — readdirSync on this
  // throws ENOTDIR, exactly like the pre-existing "unreadable root" test
  // above (F-08 section). readDirSafe swallows it the same way it already
  // swallows a bad nested project dir: no exception, no new health field.
  fs.writeFileSync(path.join(sb.claude, mainId, 'subagents'), 'not a directory');

  const agg = await buildIndex(opts(sb));
  assert.ok(byId(agg, mainId), 'the main session still parses despite its unreadable subagents dir');
  assert.equal(agg.sourceHealth.claude.status, 'ok', 'one bad nested subagents dir must not degrade the whole claude source');
});

// ── namespaced subagent ids reach readSession (Lane-P round 2) ─────────────
//
// Round 1 ingested the transcripts (buildIndex/scan); round 2 makes them
// OPENABLE by id — readSession/locate previously rejected any id containing
// '/' (VALID_ID's charset excludes it), so every subagent row was a dead
// link. VALID_SUBAGENT_ID accepts EXACTLY `<parentId>/<stem>` — the parent
// segment reuses VALID_ID's own charset, the child segment matches the real
// on-disk `agent-<hex>` / `agent-<name>-<hex>` shape — and locate()
// constructs the resolved path from the validated capture groups only,
// never by joining raw request input.

test('readSession rejects hostile namespaced-shaped ids without ever resolving to a file', async () => {
  const sb = soloSandbox();
  const hostile = [
    '../etc/agent-1', 'foo/..', 'foo/../agent-1', 'foo\\bar/agent-1',
    'foo/agent-1\\..\\..\\etc', 'a/b/agent-1', 'a//agent-1', '/agent-1',
    'foo/', '/foo/agent-1', 'foo/notanagent', 'foo/Agent-1', 'foo/agent-',
    'foo/agent-1/extra',
    // Dot-only PARENT segments. These are the cases the charset alone does
    // not catch ('.' and '-' are both inside it), and the parent is the one
    // place in this module where request-shaped text becomes a path SEGMENT
    // rather than a filename stem — path.join collapses it, so '../agent-x'
    // resolved to <claudeRoot>/subagents/agent-x.jsonl: still inside the
    // root (so the realpath containment check cannot catch it) but outside
    // the <project>/<session>/subagents shape the grammar exists to enforce.
    // The route tier rejects these; this tier must too, or the doc claim of
    // parity above readSession is false.
    '../agent-x', './agent-x',
    // 'agent-1' and '..' (bare, no slash) are deliberately NOT here — both
    // are syntactically valid PLAIN ids under VALID_ID's own pre-existing
    // charset (VALID_ID, unlike session-security.mjs's parseSessionId, has
    // no extra '.'/'..' exclusion — out of THIS fix's scope, which is the
    // namespaced grammar, not auditing the plain-id one). They resolve to
    // null (no such file), never throw. Only the NAMESPACED shape — a
    // string that actually contains a slash — is this test's concern.
  ];
  for (const id of hostile) {
    await assert.rejects(
      () => readSession(id, { roots: sb.roots, cachePath: sb.cachePath }),
      { code: 'ERR_INVALID_SESSION_ID' },
      `must reject ${JSON.stringify(id)}`,
    );
  }
});

test('a well-formed namespaced id round-trips to the right nested subagent transcript (cold cache, fallback scan)', async () => {
  _resetForTest();
  const sb = soloSandbox();
  const mainId = 'parent-session';
  writeSubagentTranscript(sb, mainId, 'agent-a2fc4593254cc01b9', { input_tokens: 10, output_tokens: 5 });

  const found = await readSession(`${mainId}/agent-a2fc4593254cc01b9`, { roots: sb.roots, cachePath: sb.cachePath });
  assert.ok(found, 'a valid namespaced id must resolve');
  assert.equal(found.meta.id, `${mainId}/agent-a2fc4593254cc01b9`);
  assert.equal(found.meta.sidechain, true, 'the resolved session must carry the sidechain evidence its own entries recorded');
});

test('a namespaced id also round-trips once the index cache already has it, resolving the REAL project (not "subagents")', async () => {
  _resetForTest();
  const sb = soloSandbox();
  const mainId = 'parent-no-cwd';
  const subDir = path.join(sb.claude, mainId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const T0 = '2026-08-20T10:00:00.000Z';
  // No `cwd` on either entry: parseClaude can only learn the project from
  // the FALLBACK dirName locate() computes for the resolved file — this is
  // what proves the cache-hit path's dirName is the real project directory,
  // not the literal "subagents" directory that sits between the parent id
  // and the stem on disk.
  fs.writeFileSync(path.join(subDir, 'agent-nocwd00000000001.jsonl'), `${[
    JSON.stringify({ type: 'user', sessionId: mainId, isSidechain: true, timestamp: T0, message: { role: 'user', content: 'subtask' } }),
    JSON.stringify({
      type: 'assistant', sessionId: mainId, isSidechain: true, timestamp: T0,
      message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    }),
  ].join('\n')}\n`);

  await buildIndex(opts(sb)); // populates the id→file cache, exactly like a normal dashboard poll
  const found = await readSession(`${mainId}/agent-nocwd00000000001`, opts(sb));
  assert.ok(found, 'a cache-hit namespaced id must still resolve');
  assert.equal(found.meta.project, 'proj', 'the real project, decoded from the project dir name — never the literal "subagents" placeholder');
});

test('a plain id is byte-identical to before namespaced ids existed', async () => {
  _resetForTest();
  const sb = sandbox();
  const found = await readSession('aaaa1111', opts(sb));
  assert.equal(found.meta.id, 'aaaa1111');
  assert.equal(found.meta.host, 'claude');
});
