// usage-index × opencode — the third transcript source through scan(),
// aggregate(), and readSession(). Hermetic: fixture claude/codex corpora and a
// fixture opencode.db, all in tmp; injected pricing/classification stubs so
// the arithmetic is exact. The real stores are never touched (the roots seam
// is also what is under test: overridden roots must NOT read the real db).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const NOW = Date.parse('2026-07-29T12:00:00Z');
const DAY = 86_400_000;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

const { buildIndex, readSession, SCHEMA_VERSION, _resetForTest } = await import('../../src/lib/usage-index.mjs');

/** Pricing stub: prices EVERY token at 1/1000 — deliberately different from
 *  the fixture's observed costs so the preference is provable. */
const deps = () => ({
  costOf: ({ input, output, cacheRead, cacheWrite }) => (input + output + cacheRead + cacheWrite) / 1000,
  pricesAsOf: '2026-07-01',
  classify: ({ title }) => (title
    ? { category: 'Build', confidence: 0.9, basis: 'title+tools' }
    : { category: 'Unclassified', confidence: 0, basis: 'no signal' }),
  detectInsights: () => [],
});

const userMsg = (id, sessionId, at) => ({
  id, sessionId, at, data: { role: 'user', time: { created: at }, agent: 'build' },
});
const assistantMsg = (id, sessionId, at, { model = 'kimi-k3', provider = 'opencode', cost = null, tokens = {} } = {}) => ({
  id, sessionId, at,
  data: {
    role: 'assistant', agent: 'build', modelID: model, providerID: provider,
    tokens: { input: 1000, output: 100, reasoning: 10, cache: { read: 200, write: 10 }, ...tokens },
    ...(cost != null ? { cost } : {}),
    time: { created: at, completed: at + 1000 }, finish: 'stop',
  },
});

function buildDb(file, { sessions = [], messages = [] } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text,
      parent_id text, slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL,
      version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer,
      summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
      tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
      tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text, agent text,
      model text, time_created integer NOT NULL, time_updated integer NOT NULL,
      time_compacting integer, time_archived integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  const insS = db.prepare('INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insM = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  for (const s of sessions) insS.run(s.id, 'proj-1', s.parentId ?? null, 'slug-x', s.directory, s.title, '1.18.8', s.timeCreated ?? NOW - DAY, s.timeUpdated ?? NOW - DAY);
  for (const m of messages) insM.run(m.id, m.sessionId, m.at, m.at, JSON.stringify(m.data));
  db.close();
  return file;
}

/** A sandbox: empty claude/codex corpora + a fixture opencode.db + cache path. */
function sandbox({ sessions = [], messages = [] } = {}) {
  const dir = tmp('ak-uio-');
  fs.mkdirSync(path.join(dir, 'corpus', 'claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'corpus', 'codex'), { recursive: true });
  const dbFile = buildDb(path.join(dir, 'corpus', 'opencode.db'), { sessions, messages });
  return {
    dir, dbFile,
    roots: {
      claude: path.join(dir, 'corpus', 'claude'),
      codex: path.join(dir, 'corpus', 'codex'),
      opencode: dbFile,
    },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
  };
}

const opts = (sb, extra = {}) => ({ days: 14, now: NOW, roots: sb.roots, cachePath: sb.cachePath, deps: deps(), ...extra });

test('scan aggregates opencode sessions: host bucket, provider bucket, tokens, and OBSERVED cost preferred over the pricing stub', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_oc1', directory: '/home/me/oc-proj', title: 'opencode session', timeCreated: at }],
    messages: [
      userMsg('u1', 'ses_oc1', at),
      assistantMsg('a1', 'ses_oc1', at + 1000, { cost: 0.25 }),
      assistantMsg('a2', 'ses_oc1', at + 2000, { cost: 0.25 }),
    ],
  });
  const agg = await buildIndex(opts(sb));
  const s = agg.sessions.find((x) => x.id === 'ses_oc1');
  assert.ok(s, 'opencode session in the index');
  assert.equal(s.host, 'opencode');
  assert.equal(s.provider, 'opencode', 'providerID observed from the assistant rows');
  assert.equal(s.providerProvenance, 'observed');
  assert.equal(s.project, 'oc-proj');
  assert.equal(s.responses, 2);
  assert.equal(s.input, 2000);
  assert.equal(s.output, 200);
  assert.equal(s.cacheRead, 400);
  assert.equal(s.cacheWrite, 20);
  assert.equal(s.tokens, 2620);
  assert.equal(s.cost, 0.5, 'the transcript\'s own metered cost, not the stub price (would be 2.62)');
  assert.ok(agg.byHost.opencode, 'byHost gains the opencode bucket');
  assert.equal(agg.byHost.opencode.cost, 0.5);
  assert.ok(agg.byProvider.opencode, 'byProvider gains the observed provider bucket');
  assert.equal(agg.totals.cost, 0.5);
  assert.equal(agg.byModel['kimi-k3'].cost, 0.5);
  rm(sb.dir);
});

test('sessions with NO observed cost fall back to the pricing table (never a fabricated $0)', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_oc2', directory: '/x', title: 'uncosted', timeCreated: at }],
    messages: [userMsg('u1', 'ses_oc2', at), assistantMsg('a1', 'ses_oc2', at + 1000)], // no cost
  });
  const agg = await buildIndex(opts(sb));
  const s = agg.sessions.find((x) => x.id === 'ses_oc2');
  assert.equal(s.cost, (1000 + 100 + 200 + 10) / 1000, 'pricing stub applies when nothing was observed');
  rm(sb.dir);
});

test('the incremental cache: a warm scan reuses unchanged sessions and picks up new messages', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_oc3', directory: '/x', title: 'cached', timeCreated: at }],
    messages: [userMsg('u1', 'ses_oc3', at), assistantMsg('a1', 'ses_oc3', at + 1000, { cost: 0.1 })],
  });
  const first = await buildIndex(opts(sb));
  assert.equal(first.sessions.find((x) => x.id === 'ses_oc3').cost, 0.1);

  // a new message arrives in the store
  const db = new DatabaseSync(sb.dbFile);
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    .run('a2', 'ses_oc3', at + 2000, at + 2000, JSON.stringify(assistantMsg('a2', 'ses_oc3', at + 2000, { cost: 0.4 }).data));
  db.close();

  const second = await buildIndex(opts(sb));
  const s = second.sessions.find((x) => x.id === 'ses_oc3');
  assert.equal(s.cost, 0.5, 'new message re-parses that session (mtime+count key changed)');
  assert.equal(s.responses, 2);
  rm(sb.dir);
});

test('a corrupt OpenCode store preserves last-good usage and surfaces degraded source health', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_last_good', directory: '/x', title: 'last good', timeCreated: at }],
    messages: [userMsg('u1', 'ses_last_good', at), assistantMsg('a1', 'ses_last_good', at + 1000, { cost: 0.4 })],
  });
  const first = await buildIndex(opts(sb));
  assert.equal(first.sourceHealth.opencode.status, 'ok');
  assert.equal(first.sessions.find((x) => x.id === 'ses_last_good').cost, 0.4);

  fs.rmSync(sb.dbFile);
  fs.writeFileSync(sb.dbFile, 'not a sqlite database');
  _resetForTest();
  const degraded = await buildIndex(opts(sb));
  assert.equal(degraded.sourceHealth.opencode.status, 'degraded');
  assert.equal(degraded.sourceHealth.opencode.reason, 'corrupt');
  assert.equal(degraded.sourceHealth.opencode.diagnostics.common.unitsSeen, 0);
  assert.equal(degraded.sessions.find((x) => x.id === 'ses_last_good').cost, 0.4,
    'a transient source failure must not become an observed zero');
  rm(sb.dir);
});

test('overridden roots WITHOUT an opencode key never read any opencode store (hermeticity)', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_oc4', directory: '/x', title: 'hidden', timeCreated: at }],
    messages: [userMsg('u1', 'ses_oc4', at), assistantMsg('a1', 'ses_oc4', at + 1000, { cost: 9 })],
  });
  const roots = { claude: sb.roots.claude, codex: sb.roots.codex }; // no opencode key
  const agg = await buildIndex({ days: 14, now: NOW, roots, cachePath: sb.cachePath, deps: deps() });
  assert.equal(agg.sessions.find((x) => x.id === 'ses_oc4'), undefined,
    'a scan with overridden roots must not reach the opencode store implicitly');
  rm(sb.dir);
});

test('readSession returns the meta + turns payload for an opencode session', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_oc5', directory: '/x', title: 'transcript view', timeCreated: at }],
    messages: [
      userMsg('u1', 'ses_oc5', at),
      assistantMsg('a1', 'ses_oc5', at + 1000, { cost: 0.25 }),
    ],
  });
  const db = new DatabaseSync(sb.dbFile);
  const insP = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
  insP.run('p1', 'u1', 'ses_oc5', at, at, JSON.stringify({ type: 'text', text: 'build the widget' }));
  insP.run('p2', 'a1', 'ses_oc5', at + 1000, at + 1000, JSON.stringify({ type: 'tool', tool: 'edit', callID: 'e1', state: {} }));
  insP.run('p3', 'a1', 'ses_oc5', at + 1001, at + 1001, JSON.stringify({ type: 'text', text: 'widget built' }));
  db.close();

  const out = await readSession('ses_oc5', { roots: sb.roots });
  assert.ok(out, 'payload returned');
  assert.equal(out.meta.host, 'opencode');
  assert.equal(out.meta.title, 'transcript view');
  assert.equal(out.meta.cost, 0.25, 'transcript header prices from the observed row');
  assert.equal(out.meta.tools.edit, 1);
  assert.equal(out.turns.length, 2);
  assert.match(out.turns[0].text, /build the widget/);
  assert.deepEqual(out.turns[1].tools, ['edit']);
  rm(sb.dir);
});

// The state the pricing fallback exists FOR: opencode's usageRow.costObserved
// stays null when no assistant message carried a `cost` field (a local model
// opencode does not price, an interrupted session). sessionCost must then reach
// the pricer — so readSession's opencode branch has to hand one down, exactly
// as its claude/codex branch does. Omitting it threw TypeError (costOf of
// undefined) and surfaced as a 500 with the internal shape in the body.
test('readSession prices an opencode session whose rows carry NO observed cost', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_oc7', directory: '/x', title: 'uncosted transcript', timeCreated: at }],
    messages: [
      userMsg('u1', 'ses_oc7', at),
      assistantMsg('a1', 'ses_oc7', at + 1000), // no `cost` field at all → costObserved stays null
    ],
  });
  const db = new DatabaseSync(sb.dbFile);
  const insP = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
  insP.run('p1', 'u1', 'ses_oc7', at, at, JSON.stringify({ type: 'text', text: 'run it locally' }));
  insP.run('p2', 'a1', 'ses_oc7', at + 1000, at + 1000, JSON.stringify({ type: 'text', text: 'done' }));
  db.close();

  const out = await readSession('ses_oc7', { roots: sb.roots, deps: deps() });
  assert.ok(out, 'payload returned rather than throwing');
  assert.equal(out.meta.cost, (1000 + 100 + 200 + 10) / 1000,
    'the injected pricer priced the row the transcript never costed');
  rm(sb.dir);
});

// Same data state with NO injected deps: readSession must load the real pricer
// rather than handing sessionCost `undefined`.
test('readSession loads the default pricer for an uncosted opencode session', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_oc8', directory: '/x', title: 'uncosted, real pricer', timeCreated: at }],
    messages: [userMsg('u1', 'ses_oc8', at), assistantMsg('a1', 'ses_oc8', at + 1000)],
  });
  const out = await readSession('ses_oc8', { roots: sb.roots });
  assert.ok(out, 'payload returned rather than throwing');
  assert.equal(typeof out.meta.cost, 'number', 'a real number, from the real pricing table');
  rm(sb.dir);
});

test('an opencode session with zero assistant responses never reaches the aggregate', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_oc6', directory: '/x', title: 'empty', timeCreated: at }],
    messages: [userMsg('u1', 'ses_oc6', at)],
  });
  const agg = await buildIndex(opts(sb));
  assert.equal(agg.sessions.find((x) => x.id === 'ses_oc6'), undefined);
  rm(sb.dir);
});

test('oversized SQLite session coverage survives scan and selected-session payloads', async () => {
  const sb = sandbox({ sessions: [{ id: 'ses_bounded', directory: '/x', title: 'bounded' }] });
  try {
    // Many small native rows exercise the production row ceiling without a
    // resource-exhaustion fixture or a multi-megabyte JavaScript payload.
    const db = new DatabaseSync(sb.dbFile);
    db.prepare(`WITH RECURSIVE n(value) AS (
      VALUES(1) UNION ALL SELECT value + 1 FROM n WHERE value < 100000
    ) INSERT INTO message (id, session_id, time_created, time_updated, data)
      SELECT 'm' || value, 'ses_bounded', ?, ?, '{}' FROM n`).run(NOW - DAY, NOW - DAY);
    db.close();
    const index = await buildIndex(opts(sb));
    assert.equal(index.acquisitionCoverage.complete, false);
    assert.equal(index.sessions.length, 0, 'refused sources are not zero-cost normal sessions');
    const selected = await readSession('ses_bounded', opts(sb));
    assert.equal(selected.meta.acquisitionCoverage.truncated, true);
    assert.equal(selected.meta.acquisitionCoverage.reason, 'session-row-limit');
    assert.deepEqual(selected.turns, []);
  } finally { _resetForTest(); rm(sb.dir); }
});

// O-2: OpenCode writes a step's tokens, cost and completed stamp into the SAME
// assistant row it inserted at turn start. A scan taken mid-turn (zero tokens)
// must not stay cached after the turn finishes.
test('a message row rewritten in place re-parses the session (mid-turn scan does not stay cached)', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_mid', directory: '/x', title: 'mid turn', timeCreated: at }],
    messages: [
      userMsg('u1', 'ses_mid', at),
      { id: 'a1', sessionId: 'ses_mid', at: at + 10, data: {
        role: 'assistant', agent: 'build', modelID: 'kimi-k3', providerID: 'opencode',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, time: { created: at + 10 },
      } },
    ],
  });
  const first = await buildIndex(opts(sb));
  assert.equal(first.sessions.find((x) => x.id === 'ses_mid').input, 0);

  const db = new DatabaseSync(sb.dbFile);
  db.prepare('UPDATE message SET time_updated = ?, data = ? WHERE id = ?').run(
    at + 30_000,
    JSON.stringify(assistantMsg('a1', 'ses_mid', at + 10, { cost: 0.4 }).data),
    'a1',
  );
  db.close();

  const second = await buildIndex(opts(sb));
  const s = second.sessions.find((x) => x.id === 'ses_mid');
  assert.equal(s.input, 1000, 'the finished turn replaces the cached mid-turn zero');
  assert.equal(s.cost, 0.4);
  rm(sb.dir);
});

// O-4: OpenCode records a user stop as assistant error MessageAbortedError. It
// reaches the aggregate as an abort — per host, so a reader can divide by the
// responses of the hosts that CAN record one — and not as an exception.
test('an OpenCode user abort lands in byHost.opencode.aborts and totals.aborts, not exceptions', async () => {
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_abort', directory: '/x', title: 'aborted', timeCreated: at }],
    messages: [
      userMsg('u1', 'ses_abort', at),
      { id: 'a1', sessionId: 'ses_abort', at: at + 10, data: {
        ...assistantMsg('a1', 'ses_abort', at + 10, { cost: 0.1 }).data,
        error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } },
      } },
    ],
  });
  try {
    const agg = await buildIndex(opts(sb));
    assert.equal(agg.totals.aborts, 1);
    assert.equal(agg.totals.exceptions, 0);
    assert.equal(agg.byHost.opencode.aborts, 1);
    assert.equal(agg.sessions.find((x) => x.id === 'ses_abort').aborts, 1);
  } finally { rm(sb.dir); }
});

test('SCHEMA_VERSION is at least 25 and a forged v24 OpenCode cache is discarded and re-parsed', async () => {
  assert.ok(SCHEMA_VERSION >= 25, 'OpenCode row semantics changed (reasoning, latency, aborts, keys)');
  const at = NOW - DAY;
  const sb = sandbox({
    sessions: [{ id: 'ses_forged', directory: '/x', title: 'real title', timeCreated: at }],
    messages: [userMsg('u1', 'ses_forged', at), assistantMsg('a1', 'ses_forged', at + 1000, { cost: 0.25 })],
  });
  try {
    await buildIndex(opts(sb));
    const cache = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
    cache.schemaVersion = 24;
    for (const e of Object.values(cache.entries)) { e.session.title = 'FORGED-V24'; e.session.responses = 99; }
    fs.writeFileSync(sb.cachePath, JSON.stringify(cache));
    _resetForTest();
    const agg = await buildIndex(opts(sb));
    const s = agg.sessions.find((x) => x.id === 'ses_forged');
    assert.notEqual(s.title, 'FORGED-V24');
    assert.equal(s.responses, 1);
  } finally { _resetForTest(); rm(sb.dir); }
});
