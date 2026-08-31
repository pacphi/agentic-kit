// GET /api/prompts/samples — the masked verbatim endpoint (Coaching redesign
// §4.2). SECURITY is the point of this file, so the security contract is
// asserted FIRST (mirroring the deep-pass review): a planted secret is redacted
// in every returned sample; a key with path chars / `..` / an unknown value is
// rejected 404 with no read; every transcript path is guarded against the known
// roots; an oversized transcript is skipped before it is read; a resolution
// failure degrades to an honest empty result, never a stack trace or a path;
// and a hostile `window` coerces safely. No unmasked text ever leaves the
// process, and nothing is persisted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { blankSession, addUsage, notePromptFingerprint, promptFingerprint } from '../../src/lib/usage-parsers.mjs';
import { maskSecrets } from '../../src/lib/usage-aggregate.mjs';
import { SCHEMA_VERSION } from '../../src/lib/usage-index.mjs';
import { resolvesWithinRoot } from '../../src/lib/dashboard/session-security.mjs';
import { MAX_DEEP_FILE_BYTES } from '../../src/commands/usage/deep-pass.mjs';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const DAY = '2026-07-24';
const DAY2 = '2026-07-23';

function get(url, token) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { 'x-dash-token': token } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

/** One valid Claude transcript: a user turn per text, then an assistant turn so
 *  the session is a real session (the parser and the window gate both require
 *  one). Written straight to `file`. */
function writeClaude(file, id, texts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = NOW - 60_000;
  const lines = texts.map((text, i) => JSON.stringify({
    type: 'user', sessionId: id, cwd: '/tmp/verify',
    timestamp: new Date(base + i * 1000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  }));
  lines.push(JSON.stringify({
    type: 'assistant', sessionId: id, cwd: '/tmp/verify',
    timestamp: new Date(base + 30_000).toISOString(),
    message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** The cache record for one session — the SAME fingerprints the transcript
 *  re-fingerprints to (both call promptFingerprint on the same text), so the
 *  deep-pass join is exact. `day` drives firstBilledDay → the occurrence date. */
function recFor(id, texts, day) {
  const rec = blankSession(id, 'claude');
  const end = NOW - 60_000;
  Object.assign(rec, { title: id, project: 'verify', prompts: texts.length, responses: 1, start: end - 60_000, end });
  addUsage(rec, day, 'claude-opus-5', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, responses: 1 });
  for (const t of texts) notePromptFingerprint(rec, t, 'prompt');
  return rec;
}

function writeCache(cacheFile, entries) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries }));
}

/** A throwaway workspace: a transcript root, a cache file, and injectable server
 *  options that keep the endpoint hermetic — never touching ~/.claude or
 *  ~/.config. `maskSecrets` is the REAL masker so the redaction is really tested. */
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-samples-'));
  const root = path.join(dir, 'root');
  const cacheFile = path.join(dir, 'cache', 'usage-index.json');
  fs.mkdirSync(root, { recursive: true });
  return { dir, root, cacheFile };
}

async function startWith(ws, { roots } = {}) {
  return startDashboard({
    port: 0,
    fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: { maskSecrets },
    promptSamples: { cacheFile: ws.cacheFile, roots: roots ?? [ws.root], now: NOW },
  });
}

const keyOf = (...texts) => texts.map((t) => promptFingerprint(t).h).sort()[0];
const url = (srv, key, window = 14) => `${srv.url}api/prompts/samples?key=${encodeURIComponent(key)}&window=${window}`;

// ── (a) a planted secret is redacted in every returned sample ────────────────

test('a secret pasted into a prompt is redacted in the returned sample, never raw', async () => {
  const ws = workspace();
  const RAW = 'A'.repeat(40);
  const SECRET_TEXT = `deploy the release using sk-ant-api03-${RAW} right now`;
  // Three sessions of the SAME secret-bearing prompt → one cluster keyed on its
  // hash. The masker runs at egress, so the hash includes the secret but the
  // sample must not.
  const entries = {};
  for (const id of ['sec-1', 'sec-2', 'sec-3']) {
    const file = path.join(ws.root, 'verify', `${id}.jsonl`);
    writeClaude(file, id, [SECRET_TEXT]);
    entries[file] = { session: recFor(id, [SECRET_TEXT], DAY) };
  }
  writeCache(ws.cacheFile, entries);
  const srv = await startWith(ws);
  try {
    const r = await get(url(srv, keyOf(SECRET_TEXT)), srv.token);
    assert.equal(r.status, 200, r.body);
    const { samples } = JSON.parse(r.body);
    assert.ok(samples.length >= 1, 'the cluster resolves at least one sample');
    for (const s of samples) {
      assert.ok(s.includes('sk-…redacted'), `sample not redacted: ${JSON.stringify(s)}`);
      assert.ok(!s.includes(RAW), 'the raw secret key must never appear');
      assert.ok(!s.includes('sk-ant-api03-A'), 'no secret prefix+body survives');
    }
    assert.ok(!r.body.includes(RAW), 'the raw secret must not appear anywhere in the payload');
  } finally {
    await srv.close();
  }
});

// ── (b) key validation: charset THEN the window's own key set, before any read ─

test('a key with path chars / .. / the wrong shape is rejected 404 with no read', async () => {
  const ws = workspace();
  // A cluster exists, and its sole transcript carries a canary — so "no read"
  // is provable: a rejected key must never surface the canary.
  const TEXT = 'please run the whole verification suite twice CANARYSENTINEL now';
  const entries = {};
  for (const id of ['v-1', 'v-2', 'v-3']) {
    const file = path.join(ws.root, 'verify', `${id}.jsonl`);
    writeClaude(file, id, [TEXT]);
    entries[file] = { session: recFor(id, [TEXT], DAY) };
  }
  writeCache(ws.cacheFile, entries);
  const srv = await startWith(ws);
  try {
    for (const bad of ['../../etc/passwd', '..%2f..%2fetc', 'not-a-hex-key', '', 'AAAAAAAAAAAAAAAA', 'g'.repeat(16), '0'.repeat(15), '0'.repeat(17)]) {
      const r = await get(url(srv, bad), srv.token);
      assert.equal(r.status, 404, `expected 404 for key ${JSON.stringify(bad)}, got ${r.status}`);
      const body = JSON.parse(r.body);
      assert.equal(body.error, 'unknown cluster');
      assert.ok(!('samples' in body), 'a rejected key carries no samples');
      assert.ok(!r.body.includes('CANARYSENTINEL'), 'a rejected key must never trigger a transcript read');
      assert.ok(!/\/(?:etc|Users|home|tmp)\//.test(r.body), `no filesystem path leaked: ${r.body}`);
    }
    // A well-formed 16-hex key that names no cluster in this window → 404, no read.
    const r = await get(url(srv, 'deadbeefdeadbeef'), srv.token);
    assert.equal(r.status, 404);
    assert.ok(!r.body.includes('CANARYSENTINEL'), 'an unknown-but-valid key resolves nothing');
  } finally {
    await srv.close();
  }
});

// ── (c) every transcript path is contained in a known root ───────────────────

test('resolvesWithinRoot admits paths under the root at any depth and rejects escapes', () => {
  const root = path.join(os.tmpdir(), 'guard-root');
  assert.equal(resolvesWithinRoot(root, path.join(root, 'proj', 's.jsonl')), true, 'deep child admitted');
  assert.equal(resolvesWithinRoot(root, path.join(root, '..', 'escape.jsonl')), false, 'traversal rejected');
  assert.equal(resolvesWithinRoot(root, `${root}-sibling/x.jsonl`), false, 'a prefix sibling is not inside');
  assert.equal(resolvesWithinRoot(root, root), false, 'the root itself is not a child');
  assert.equal(resolvesWithinRoot(root, null), false, 'a non-string path is never inside');
});

test('a cache entry whose transcript sits outside the roots is dropped, never opened', async () => {
  const ws = workspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-poison-'));
  const T1 = 'please run the whole verification suite twice';
  const T2 = 'please run the whole verification suite twice now';
  const POISON = 'please run the whole verification suite twice CANARYWORD';
  // Two in-root near-dup members across two days form the cluster; a THIRD
  // near-dup member lives only in an out-of-root transcript carrying CANARYWORD.
  const inFile1 = path.join(ws.root, 'verify', 'in-1.jsonl');
  const inFile2 = path.join(ws.root, 'verify', 'in-2.jsonl');
  const poisonFile = path.join(outside, 'evil.jsonl');
  writeClaude(inFile1, 'in-1', [T1]);
  writeClaude(inFile2, 'in-2', [T2]);
  writeClaude(poisonFile, 'poison-sess', [POISON]); // readable IF the guard failed
  writeCache(ws.cacheFile, {
    [inFile1]: { session: recFor('in-1', [T1], DAY) },
    [inFile2]: { session: recFor('in-2', [T2], DAY2) },
    [poisonFile]: { session: recFor('poison-sess', [POISON], DAY) },
  });
  const srv = await startWith(ws);
  try {
    const r = await get(url(srv, keyOf(T1, T2)), srv.token);
    assert.equal(r.status, 200, r.body);
    const { samples, occurrences } = JSON.parse(r.body);
    assert.ok(!r.body.includes('CANARYWORD'), 'the out-of-root transcript was never read');
    for (const s of samples) assert.ok(!s.includes('CANARYWORD'), 'no out-of-root text in a sample');
    const ids = occurrences.map((o) => o.sessionId);
    assert.ok(!ids.includes('poison-sess'), 'the out-of-root session is not even an occurrence');
    assert.deepEqual(ids.sort(), ['in-1', 'in-2'], 'only the in-root sessions occur');
  } finally {
    await srv.close();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ── (d) an oversized transcript is skipped before it is read ─────────────────

test('a transcript over MAX_DEEP_FILE_BYTES withholds its text but still occurs', async () => {
  const ws = workspace();
  const TEXT = 'please run the whole verification suite twice';
  // Two in-root sessions across two days, BOTH backed by an oversized (sparse)
  // transcript. The fingerprint projection still knows both occurrences, but the
  // text is withheld because every holder exceeds the ceiling — honest
  // degradation, and proof the ceiling is enforced before the read.
  const entries = {};
  for (const [id, day] of [['big-1', DAY], ['big-2', DAY2]]) {
    const file = path.join(ws.root, 'verify', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, 'this line is never parsed\n');
    fs.ftruncateSync(fd, MAX_DEEP_FILE_BYTES + 1); // logical size over the ceiling, sparse
    fs.closeSync(fd);
    assert.ok(fs.statSync(file).size > MAX_DEEP_FILE_BYTES, 'the fixture is genuinely oversized');
    entries[file] = { session: recFor(id, [TEXT], day) };
  }
  writeCache(ws.cacheFile, entries);
  const srv = await startWith(ws);
  try {
    const r = await get(url(srv, keyOf(TEXT)), srv.token);
    assert.equal(r.status, 200, r.body);
    const { samples, occurrences } = JSON.parse(r.body);
    assert.deepEqual(samples, [], 'no text egresses when every holder is oversized');
    assert.equal(occurrences.length, 2, 'the occurrences are still reported from fingerprints');
    assert.deepEqual(occurrences.map((o) => o.sessionId).sort(), ['big-1', 'big-2']);
  } finally {
    await srv.close();
  }
});

// ── (e) a resolution failure is an honest empty result, never a stack/path ────

test('an unreadable cache degrades to an honest empty result', async () => {
  const ws = workspace();
  fs.mkdirSync(path.dirname(ws.cacheFile), { recursive: true });
  fs.writeFileSync(ws.cacheFile, '{ this is not valid json');
  const srv = await startWith(ws);
  try {
    const r = await get(url(srv, 'deadbeefdeadbeef'), srv.token);
    // readPromptEntries swallows a corrupt cache to [] → no cluster → 404, and
    // never a stack trace or a path.
    assert.equal(r.status, 404);
    assert.ok(!/Error|\/Users\/|\.jsonl/.test(r.body), `no internals leaked: ${r.body}`);
  } finally {
    await srv.close();
  }
});

// ── (f) a hostile window param coerces safely (same clamp as /api/usage) ──────

test('a junk or negative window coerces to a sane value instead of throwing', async () => {
  const ws = workspace();
  const TEXT = 'please run the whole verification suite twice';
  const entries = {};
  for (const [id, day] of [['w-1', DAY], ['w-2', DAY2]]) {
    const file = path.join(ws.root, 'verify', `${id}.jsonl`);
    writeClaude(file, id, [TEXT]);
    entries[file] = { session: recFor(id, [TEXT], day) };
  }
  writeCache(ws.cacheFile, entries);
  const srv = await startWith(ws);
  try {
    for (const w of ['abc', '-5', '0', '99999', '']) {
      const r = await get(url(srv, keyOf(TEXT), w), srv.token);
      assert.equal(r.status, 200, `window=${JSON.stringify(w)} should coerce, got ${r.status}: ${r.body}`);
      const { samples } = JSON.parse(r.body);
      assert.ok(samples.length >= 1, `window=${JSON.stringify(w)} still resolves the cluster`);
    }
  } finally {
    await srv.close();
  }
});

// ── the happy path: masked, distinct samples + the occurrence strip ──────────

test('a valid cluster returns distinct masked samples and its occurrence strip', async () => {
  const ws = workspace();
  const T1 = 'please run the whole verification suite twice';
  const T2 = 'please run the whole verification suite twice now';
  const T3 = 'please run the whole verification suite twice again';
  const spec = [['q-1', [T1]], ['q-2', [T2]], ['q-3', [T3]]];
  const entries = {};
  for (const [id, texts] of spec) {
    const file = path.join(ws.root, 'verify', `${id}.jsonl`);
    writeClaude(file, id, texts);
    entries[file] = { session: recFor(id, texts, DAY) };
  }
  writeCache(ws.cacheFile, entries);
  const srv = await startWith(ws);
  try {
    const r = await get(url(srv, keyOf(T1, T2, T3)), srv.token);
    assert.equal(r.status, 200, r.body);
    const { samples, occurrences } = JSON.parse(r.body);
    assert.ok(samples.length >= 1 && samples.length <= 3, `1..3 samples, got ${samples.length}`);
    assert.equal(new Set(samples).size, samples.length, 'samples are distinct');
    for (const s of samples) assert.ok([T1, T2, T3].includes(s), `a sample is a real member phrasing: ${s}`);
    assert.ok(occurrences.length >= 1 && occurrences.length <= 3, 'occurrences are capped at three');
    for (const o of occurrences) {
      assert.ok(typeof o.sessionId === 'string' && o.sessionId, 'each occurrence names a session');
      assert.equal(o.day, DAY, 'each occurrence carries its billed day');
    }
    assert.deepEqual([...occurrences.map((o) => o.sessionId)].sort(), ['q-1', 'q-2', 'q-3']);
  } finally {
    await srv.close();
  }
});

// The endpoint is behind the same global token gate as every other /api/ route.
test('the samples route is token-gated like the rest of /api/', async () => {
  const ws = workspace();
  writeCache(ws.cacheFile, {});
  const srv = await startWith(ws);
  try {
    const r = await new Promise((resolve, reject) => {
      http.get(`${srv.url}api/prompts/samples?key=deadbeefdeadbeef&window=14`, (res) => {
        let body = ''; res.setEncoding('utf8');
        res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(r.status, 401, 'no token → unauthorized, never a resolution');
  } finally {
    await srv.close();
  }
});

// ── (g) SEC-1: the masker the endpoint routes attacker text through is linear ─
// This endpoint is the first surface to route attacker-authored prompt text
// through `maskSecrets` BY DEFAULT (masked-shown is the default posture). Rule
// 148 — the quoted secret-key rule — had two UNBOUNDED `[A-Za-z0-9_-]*` classes
// around its secret-word alternation, so a quote followed by a long `token…token`
// run (that never closes the quote) drove O(n^2) catastrophic backtracking:
// measured here 64ms@20KB → 235ms@40KB → 917ms@80KB, extrapolating to minutes on
// a ~1.6MB paste and freezing the single-threaded event loop for every concurrent
// request. Sibling rules 142/154 already bound this with MAX_KEY_NAME_CHARS; 148
// was missed. These pin the fix.

test('SEC-1: rule 148 masks a hostile quote-prefixed run in well under 100ms (ReDoS bound)', () => {
  // The LEADING QUOTE is load-bearing: the pre-existing SEC-3 linearity tests use
  // quote-LESS payloads, which engage rules 142/154 but never enter rule 148 (it
  // requires `["']` first). That blind spot is exactly why 148 stayed unbounded.
  const hostile = '"' + 'token'.repeat(20_000); // ~100 KB; seconds-to-minutes unbounded
  const started = process.hrtime.bigint();
  maskSecrets(hostile);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 100, `rule 148 took ${ms.toFixed(0)}ms on a 100KB quote-prefixed run — the ReDoS bound is gone`);
});

test('SEC-1: the bound preserves rule 148 masking of every real quoted secret key (equivalence)', () => {
  // A real secret's key name never carries more than MAX_KEY_NAME_CHARS of word
  // chars before/after the secret word, so bounding the two classes to {0,64} is
  // behaviour-preserving. These are the shapes rule 148 exists to catch — each
  // must still redact after the bound.
  const redacts = [
    '{"api_key": "sk-ant-supersecretvalue123"}', // the brief's literal case
    '{"apiKey":"abcdefghijklmnop1234"}',         // prefix-free value → rule 148 alone
    "{'client_secret':'sekrit1234567890abcd'}",  // single-quoted, case-insensitive
    '"my_token": "abcdefghij0123456789"',        // quoted `token` key
    '{"private_key": "MIIEpAIBAAKCAQEA1234"}',   // private_key alternation
  ];
  for (const c of redacts) {
    assert.ok(maskSecrets(c).includes('…redacted'), `rule 148 stopped redacting: ${c}`);
  }
  // And the bound must not have widened into prose: a quoted NON-secret key and
  // ordinary token-count talk stay verbatim (no over-masking).
  assert.equal(maskSecrets('{"note": "just a normal value here"}'), '{"note": "just a normal value here"}');
  assert.equal(maskSecrets('we spent 500000 tokens on that run'), 'we spent 500000 tokens on that run');
});
