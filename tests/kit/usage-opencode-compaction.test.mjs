import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './helpers/temp-dir.mjs';
import { parseSession } from '../../src/lib/usage-opencode.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const TOKENS = { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 3 } };
const assistant = (extra = {}) => ({ role: 'assistant', summary: true, parentID: 'u', finish: 'stop',
  providerID: 'openrouter', modelID: 'test', tokens: TOKENS, cost: 0.25,
  time: { created: NOW - 2000, completed: NOW - 1000 }, ...extra });
function fixture(t, { messages = [['u', { role: 'user' }], ['a', assistant()]],
  parts = [['u', { type: 'compaction' }], ['a', { type: 'step-finish', tokens: TOKENS, cost: 0.25 }]],
  metadata = {} } = {}) {
  const dir = tempDir('ak-oc-compaction-');
  t.after(() => { _resetForTest(); fs.rmSync(dir, { recursive: true, force: true }); });
  const dbFile = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
    version TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER,
    cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);`);
  db.prepare('INSERT INTO session VALUES (?,NULL,?,?,?,?,?,NULL,?,?,?,?,?,?)')
    .run('s', dir, 'fixture', '1.18.33', NOW - 3000, NOW, 0.25, 100, 20, 5, 40, 3);
  for (const [key, value] of Object.entries(metadata)) db.prepare(`UPDATE session SET ${key} = ?`).run(value);
  for (const [id, data] of messages) db.prepare('INSERT INTO message VALUES (?,?,?,?,?)')
    .run(id, 's', NOW - 2000, NOW, JSON.stringify(data));
  parts.forEach(([id, data], i) => db.prepare('INSERT INTO part VALUES (?,?,?,?)').run(`p${i}`, id, 's', JSON.stringify(data)));
  db.close();
  const roots = { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex'), opencode: dbFile };
  fs.mkdirSync(roots.claude); fs.mkdirSync(roots.codex);
  return { dbFile, id: 's', roots, cachePath: path.join(dir, 'cache.json'), days: 14, now: NOW,
    deps: { costOf: () => 99, classify: () => ({ category: 'Build', confidence: 1 }), detectInsights: () => [] } };
}

test('linked completed compaction counts once on scan/detail without charging its parts', t => {
  const opts = fixture(t, { parts: [['u', { type: 'compaction' }], ['u', { type: 'compaction' }],
    ['a', { type: 'step-finish', tokens: TOKENS, cost: 0.25 }]] });
  for (const withTurns of [false, true]) {
    const { session } = parseSession({ ...opts, withTurns });
    assert.equal(session.compactions, 1);
    assert.deepEqual(session.compactionEvidence, { lowerBound: 1, upperBound: 1 });
    assert.equal(session.usage[0].input, 100);
    assert.equal(session.usage[0].output, 25);
    assert.equal(session.usage[0].costObserved, 0.25);
    assert.equal(session.opencodeReconciliation.state, 'matched');
  }
});

for (const [name, data, parts, meta, bounds] of [
  ['failed', assistant({ error: { name: 'APIError' } }), [['u', { type: 'compaction' }]], {}, [0, 0]],
  ['aborted', assistant({ error: { name: 'MessageAbortedError' } }), [['u', { type: 'compaction' }]], {}, [0, 0]],
  ['inflight', assistant({ finish: undefined, time: { created: NOW - 2000 } }), [['u', { type: 'compaction' }]], { time_compacting: NOW }, [0, 1]],
  ['orphan summary', assistant({ parentID: 'absent' }), [], {}, [0, 1]],
  ['request only', { role: 'user' }, [['u', { type: 'compaction' }]], {}, [0, 1]],
]) test(`${name} cannot claim a completed compaction`, t => {
  const { session } = parseSession(fixture(t, { messages: [['u', { role: 'user' }], ['a', data]], parts, metadata: meta }));
  assert.equal(session.compactions, bounds[0]);
  assert.deepEqual(session.compactionEvidence, { lowerBound: bounds[0], upperBound: bounds[1] });
});

test('time_compacting alone is incomplete evidence, never completion', t => {
  const { session } = parseSession(fixture(t, { parts: [], messages: [], metadata: { time_compacting: NOW } }));
  assert.equal(session.compactions, 0);
  assert.deepEqual(session.compactionEvidence, { lowerBound: 0, upperBound: null });
});

for (const [name, changes, state, reason] of [
  ['mismatch', { metadata: { tokens_input: 101 } }, 'mismatch', null],
  ['default zero', { metadata: { cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0 } }, 'unknown', 'unpopulated-session-counters'],
  ['malformed session', { metadata: { tokens_input: -1 } }, 'unknown', 'invalid-session-counters'],
  ['partial session counters', { metadata: { tokens_reasoning: null } }, 'unknown', 'invalid-session-counters'],
  ['unsupported inclusive token basis', { messages: [['a', assistant({ tokens: { ...TOKENS, total: 163 } })]] }, 'unknown', 'invalid-message-counters'],
  ['unsupported version', { metadata: { version: '0.9.10' } }, 'unknown', 'unsupported-version'],
  ['compacting', { metadata: { time_compacting: NOW } }, 'unknown', 'incomplete-messages'],
  ['missing steps', { parts: [] }, 'unknown', 'unproved-step-scope'],
  ['multiple steps', { parts: [['a', { type: 'step-finish', tokens: TOKENS, cost: 0.25 }], ['a', { type: 'step-finish', tokens: TOKENS, cost: 0.25 }]] }, 'unknown', 'unproved-step-scope'],
  ['inflight message', { messages: [['a', assistant({ time: { created: NOW - 2000 } })]] }, 'unknown', 'incomplete-messages'],
  ['invalid message counters', { messages: [['a', assistant({ tokens: { ...TOKENS, input: '100' } })]] }, 'unknown', 'invalid-message-counters'],
]) test(`reconciliation ${name} preserves message usage`, t => {
  const { session } = parseSession(fixture(t, changes));
  assert.equal(session.opencodeReconciliation.state, state);
  if (reason) assert.equal(session.opencodeReconciliation.reason, reason);
  assert.equal(session.usage[0].input, 100);
  assert.equal(session.usage[0].costObserved, 0.25);
});

test('aggregate current/previous, warm cache and old parse marker retain observations', async t => {
  const opts = fixture(t);
  const cold = await buildIndex(opts);
  assert.equal(cold.sessions[0].compactions, 1);
  assert.equal(cold.totals.compactions, 1);
  assert.equal(cold.sessions[0].opencodeReconciliation.state, 'matched');
  _resetForTest();
  const warm = await buildIndex(opts);
  assert.equal(warm.totals.compactions, 1);
  const cache = JSON.parse(fs.readFileSync(opts.cachePath, 'utf8'));
  const entry = Object.values(cache.entries).find(e => e.session?.host === 'opencode');
  entry.parseSemantics = 'cost-trust-v2'; entry.session.compactions = 0;
  fs.writeFileSync(opts.cachePath, JSON.stringify(cache)); _resetForTest();
  assert.equal((await buildIndex(opts)).totals.compactions, 1);
  _resetForTest();
  const later = await buildIndex({ ...opts, now: NOW + 15 * 86400000, previous: true, lookbackDays: 28 });
  assert.equal(later.totals.compactions, 0);
  assert.equal(later.previous.totals.compactions, 1);
});


test('untrusted zero cost and unsupported V2 scope cannot claim matched reconciliation', t => {
  const opts = fixture(t, { messages: [['a', assistant({ cost: 0 })]],
    parts: [['a', { type: 'step-finish', tokens: TOKENS, cost: 0 }]], metadata: { cost: 0 } });
  assert.equal(parseSession(opts).session.opencodeReconciliation.reason, 'untrusted-message-cost');
  const db = new DatabaseSync(opts.dbFile);
  db.exec("CREATE TABLE session_message (session_id TEXT); INSERT INTO session_message VALUES ('s')"); db.close();
  assert.equal(parseSession(opts).session.opencodeReconciliation.reason, 'unsupported-v2-scope');
});

test('oversized selected metadata is bounded before acquisition', t => {
  const opts = fixture(t, { metadata: { version: 'x'.repeat(5000) } });
  const { session } = parseSession({ ...opts, maxSessionBytes: 4000 });
  assert.equal(session.acquisitionCoverage.reason, 'session-byte-limit');
});


test('duplicate summary evidence is counted once per actual request parent', t => {
  const opts = fixture(t, { messages: [['u', { role: 'user' }], ['a', assistant()], ['b', assistant()]],
    parts: [['u', { type: 'compaction' }], ['u', { type: 'compaction' }]] });
  const { session } = parseSession(opts);
  assert.equal(session.compactions, 1);
  assert.deepEqual(session.compactionEvidence, { lowerBound: 1, upperBound: 1 });
  assert.equal(session.responses, 2, 'distinct assistant rows keep their recorded usage');
  assert.equal(session.usage[0].costObserved, 0.5);
});


function mutateDb(opts, action) {
  const db = new DatabaseSync(opts.dbFile);
  try { action(db); } finally { db.close(); }
  _resetForTest();
}

for (const [name, mutation, reason] of [
  ['upstream part removal and counter subtraction', db => db.exec(`DELETE FROM part WHERE id = 'p1';
    UPDATE session SET cost = 0, tokens_input = 0, tokens_output = 0, tokens_reasoning = 0,
      tokens_cache_read = 0, tokens_cache_write = 0`), 'unpopulated-session-counters'],
  ['same-count step rewrite', db => db.prepare('UPDATE part SET data = ? WHERE id = ?')
    .run(JSON.stringify({ type: 'step-finish', tokens: { ...TOKENS, input: 101 }, cost: 0.25 }), 'p1'), 'unproved-step-scope'],
  ['part addition', db => db.exec("INSERT INTO part SELECT 'extra', message_id, session_id, data FROM part WHERE id = 'p1'"), 'unproved-step-scope'],
  ['metadata-only rewrite', db => db.exec("UPDATE session SET time_compacting = 123"), 'incomplete-messages'],
  ['new V2 scope', db => db.exec("CREATE TABLE session_message (session_id TEXT); INSERT INTO session_message VALUES ('s')"), 'unsupported-v2-scope'],
]) test(`warm observation cache invalidates after ${name} without timestamp changes`, async t => {
  const opts = fixture(t);
  assert.equal((await buildIndex(opts)).sessions[0].opencodeReconciliation.state, 'matched');
  mutateDb(opts, mutation);
  const warm = await buildIndex(opts);
  assert.equal(warm.sessions[0].opencodeReconciliation.reason, reason);
  assert.deepEqual(warm.sessions[0].opencodeReconciliation, parseSession(opts).session.opencodeReconciliation);
  assert.equal(warm.totals.responses, 1);
  assert.equal(warm.totals.cost, 0.25);
});

test('same-size compaction part rewrite invalidates a current marker while unchanged evidence reuses it', async t => {
  const opts = fixture(t);
  await buildIndex(opts);
  const cache = JSON.parse(fs.readFileSync(opts.cachePath, 'utf8'));
  cache.entries['opencode://s'].session.title = 'cache reuse sentinel';
  fs.writeFileSync(opts.cachePath, JSON.stringify(cache)); _resetForTest();
  assert.equal((await buildIndex(opts)).sessions[0].title, 'cache reuse sentinel', 'unchanged source reuses the parse');
  mutateDb(opts, db => db.prepare('UPDATE part SET data = ? WHERE id = ?')
    .run(JSON.stringify({ type: 'xxxxxxxxxx' }), 'p0'));
  const warm = await buildIndex(opts);
  assert.equal(warm.sessions[0].title, 'fixture');
  assert.equal(warm.totals.compactions, 0);
  assert.deepEqual(warm.totals.compactionEvidence, { lowerBound: 0, upperBound: 1 });
});

for (const [name, maxSessionBytes, upperBound] of [
  ['request-only', undefined, 1], ['acquisition-incomplete', 64, null],
]) test(`${name} observation uncertainty survives current and previous aggregate windows`, t => {
  const opts = fixture(t, { messages: [['u', { role: 'user' }]], parts: [['u', { type: 'compaction' }]] });
  const { session } = parseSession({ ...opts, maxSessionBytes });
  for (const offset of [0, 15]) {
    const now = NOW + offset * 86400000;
    const result = aggregate([session], { days: 14, now, cutoff: now - 14 * 86400000, previous: true, deps: opts.deps });
    const totals = offset ? result.previous.totals : result.totals;
    assert.deepEqual(totals.compactionEvidence, { lowerBound: 0, upperBound });
    assert.equal(totals.sessions, maxSessionBytes ? 0 : 1, 'refused acquisition is not a normal session');
    assert.equal(totals.responses, 0);
    assert.equal(totals.tokens, 0);
    assert.equal(totals.cost, 0);
    if (offset) assert.equal(result.totals.sessions, 0);
  }
});

test('a tighter acquisition budget cannot reuse a cached full observation', async t => {
  const opts = fixture(t);
  await buildIndex(opts); _resetForTest();
  const restricted = await buildIndex({ ...opts, readLimits: { maxSessionBytes: 64 } });
  assert.equal(restricted.totals.responses, 0);
  assert.deepEqual(restricted.totals.compactionEvidence, { lowerBound: 0, upperBound: null });
  assert.equal(restricted.totals.cost, 0);
});


test('unknown V2 schema preserves V1 usage and refuses a matched reconciliation', async t => {
  const opts = fixture(t);
  await buildIndex(opts);
  mutateDb(opts, db => db.exec('CREATE TABLE session_message (payload TEXT)'));
  const warm = await buildIndex(opts);
  assert.equal(warm.totals.responses, 1);
  assert.equal(warm.totals.cost, 0.25);
  assert.equal(warm.sessions[0].opencodeReconciliation.reason, 'unsupported-v2-scope');
});

test('an observation entry without its input digest reparses rather than laundering stale evidence', async t => {
  const opts = fixture(t);
  await buildIndex(opts);
  const cache = JSON.parse(fs.readFileSync(opts.cachePath, 'utf8'));
  delete cache.entries['opencode://s'].observationFingerprint;
  cache.entries['opencode://s'].session.title = 'unbound cache';
  fs.writeFileSync(opts.cachePath, JSON.stringify(cache)); _resetForTest();
  assert.equal((await buildIndex(opts)).sessions[0].title, 'fixture');
});

test('read-limit controls cannot override the explicitly selected database', async t => {
  const opts = fixture(t);
  const unrelated = fixture(t, { metadata: { title: 'other source' } });
  const result = await buildIndex({ ...opts, readLimits: { dbFile: unrelated.dbFile, id: unrelated.id } });
  assert.equal(result.sessions[0].title, 'fixture');
});
