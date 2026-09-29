// usage-index × opencode — the third transcript source through scan(),
// aggregate(), and readSession(). Hermetic: fixture claude/codex corpora and a
// fixture opencode.db, all in tmp; injected pricing/classification stubs so
// the arithmetic is exact. The real stores are never touched (the roots seam
// is also what is under test: overridden roots must NOT read the real db).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const NOW = Date.parse('2026-07-29T12:00:00Z');
const DAY = 86_400_000;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

const { sandboxHome } = await import('./helpers/home-sandbox.mjs');
const testHome = sandboxHome('ak-oc-source');
after(() => rm(testHome));

const { buildIndex, readIndex, readSession, _resetForTest } = await import('../../src/lib/usage-index.mjs');

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

// O9: equal session IDs and stamps in separate stores must never share parses.
test('OpenCode database switches isolate warm and degraded cache entries', async () => {
  const at = NOW - DAY;
  const data = (title, cost) => ({ sessions: [{ id: 'ses_shared', directory: '/x', title, timeCreated: at }],
    messages: [assistantMsg('a1', 'ses_shared', at + 1000, { cost })] });
  const sb = sandbox(data('first', 0.2));
  try {
    await buildIndex(opts(sb));
    const second = buildDb(path.join(sb.dir, 'second.db'), data('second', 0.8));
    const options = opts(sb, { roots: { ...sb.roots, opencode: second } });
    const switched = await buildIndex(options);
    assert.equal(switched.sessions[0].title, 'second');
    assert.equal(switched.totals.cost, 0.8);
    assert.equal((await readSession('ses_shared', options)).meta.title, 'second');
    fs.writeFileSync(sb.dbFile, 'corrupt');
    const degraded = await buildIndex(opts(sb));
    assert.equal(degraded.sessions.length, 0, 'second database cannot supply first database fallback');
  } finally { _resetForTest(); rm(sb.dir); }
});

test('OpenCode legacy source identity reparses and cannot carry through a degraded store', async () => {
  const at = NOW - DAY;
  const sb = sandbox({ sessions: [{ id: 'ses_identity', directory: '/x', title: 'real' }],
    messages: [assistantMsg('a1', 'ses_identity', at, { cost: 0.2 })] });
  try {
    await buildIndex(opts(sb));
    const cache = JSON.parse(fs.readFileSync(sb.cachePath, 'utf8'));
    delete cache.entries['opencode://ses_identity'].sourceIdentity;
    cache.entries['opencode://ses_identity'].session.title = 'old';
    fs.writeFileSync(sb.cachePath, JSON.stringify(cache)); _resetForTest();
    assert.equal((await buildIndex(opts(sb))).sessions[0].title, 'real');
    fs.writeFileSync(sb.cachePath, JSON.stringify(cache));
    fs.writeFileSync(sb.dbFile, 'corrupt'); _resetForTest();
    assert.equal((await buildIndex(opts(sb))).sessions.length, 0);
  } finally { _resetForTest(); rm(sb.dir); }
});

test('ambiguous default stores expose health, drop cache fallback, and agree with selected-session reads', async () => {
  const sb = sandbox({ sessions: [{ id: 'ses_choice', directory: '/x', title: 'chosen' }],
    messages: [assistantMsg('a1', 'ses_choice', NOW - DAY, { cost: 0.4 })] });
  const keys = ['XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_DISABLE_CHANNEL_DB'];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.XDG_DATA_HOME = sb.dir;
    delete process.env.OPENCODE_DB; delete process.env.OPENCODE_DISABLE_CHANNEL_DB;
    const root = path.join(sb.dir, 'opencode'); fs.mkdirSync(root);
    fs.copyFileSync(sb.dbFile, path.join(root, 'opencode-preview.db'));
    const options = opts(sb, { roots: undefined });
    assert.equal((await readIndex(options)).sessions[0].title, 'chosen');
    assert.equal((await readSession('ses_choice', options)).meta.title, 'chosen');
    fs.copyFileSync(sb.dbFile, path.join(root, 'opencode.db'));
    const ambiguous = await readIndex(options);
    assert.equal(ambiguous.sourceHealth.opencode.reason, 'database-selection-ambiguous');
    assert.equal(ambiguous.sessions.length, 0);
    assert.equal(await readSession('ses_choice', options), null);
    const { discoverProjectSources } = await import('../../src/lib/footprint/project-sources.mjs');
    const projects = discoverProjectSources({ claudeRoot: sb.roots.claude, codexRoot: sb.roots.codex });
    assert.equal(projects.sources.opencode.reason, 'database-selection-ambiguous');
    assert.equal(projects.complete, false);
    process.env.OPENCODE_DB = 'opencode-preview.db';
    assert.equal((await readIndex(options)).sessions[0].title, 'chosen');
    assert.equal((await readSession('ses_choice', options)).meta.title, 'chosen');
    process.env.OPENCODE_DB = ':memory:';
    assert.equal((await buildIndex(options)).sourceHealth.opencode.reason, 'database-in-memory');
    assert.equal(await readSession('ses_choice', options), null);
    assert.equal(fs.existsSync(path.join(root, ':memory:')), false);
    assert.equal((await buildIndex(opts(sb))).sessions[0].title, 'chosen', 'explicit roots ignore environment');
    assert.equal((await buildIndex(opts(sb, { roots: {} }))).sessions.length, 0);
  } finally {
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    _resetForTest(); rm(sb.dir);
  }
});
