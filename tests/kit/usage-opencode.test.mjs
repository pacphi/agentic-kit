// usage-opencode — the opencode transcript source for the usage scorecard.
// Hermetic: a fixture opencode.db is built per test in a tmp dir via
// node:sqlite (same engine as production). The real ~/.local/share/opencode
// store is NEVER touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listSessions, parseSession, sessionExists } from '../../src/lib/usage-opencode.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-uo-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const T = 1_785_000_000_000; // fixture epoch base
const DAY = 86_400_000;

function buildDb(file, { sessions = [], messages = [], parts = [] } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL, workspace_id text,
      parent_id text, slug text NOT NULL, directory text NOT NULL, path text,
      title text NOT NULL, version text NOT NULL, share_url text,
      summary_additions integer, summary_deletions integer, summary_files integer,
      summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
      tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
      tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text,
      agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL,
      time_compacting integer, time_archived integer
    );
    CREATE TABLE message (
      id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
  `);
  const insS = db.prepare('INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insM = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  const insP = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
  for (const s of sessions) insS.run(s.id, 'proj-1', s.parentId ?? null, s.slug ?? 'eager-test', s.directory, s.title, '1.18.8', s.timeCreated ?? T, s.timeUpdated ?? T);
  for (const m of messages) insM.run(m.id, m.sessionId, m.at, m.at, JSON.stringify(m.data));
  for (const p of parts) insP.run(p.id, p.messageId, p.sessionId, p.at, p.at, JSON.stringify(p.data));
  db.close();
  return file;
}

const userMsg = (id, sessionId, at, text = null) => ({
  id, sessionId, at,
  data: { role: 'user', time: { created: at }, agent: 'build', ...(text ? { text } : {}) },
});
// tokens: null (an explicit, not-default, override) omits the `tokens` key
// entirely — a token-LESS row, distinct from `tokens: {}` which still merges
// onto the hardcoded defaults below. Same conditional-spread convention as
// mode/error.
const assistantMsg = (id, sessionId, at, { model = 'kimi-k3', provider = 'opencode', tokens = {}, cost = null, mode = null, error = null } = {}) => ({
  id, sessionId, at,
  data: {
    role: 'assistant', agent: 'build', path: { cwd: '/x', root: '/' },
    modelID: model, providerID: provider,
    ...(tokens !== null ? { tokens: { total: 0, input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 3 }, ...tokens } } : {}),
    ...(cost != null ? { cost } : {}),
    ...(mode != null ? { mode } : {}),
    ...(error != null ? { error } : {}),
    time: { created: at, completed: at + 1000 }, finish: 'stop',
  },
});

test('listSessions filters by the latest message time and keys on mtime+count', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [
      { id: 'ses_old', directory: '/x', title: 'old', timeCreated: T - 30 * DAY, timeUpdated: T - 30 * DAY },
      { id: 'ses_new', directory: '/x', title: 'new', timeCreated: T, timeUpdated: T },
    ],
    messages: [
      assistantMsg('m1', 'ses_old', T - 30 * DAY),
      assistantMsg('m2', 'ses_new', T + 1000),
      assistantMsg('m3', 'ses_new', T + 2000),
    ],
  });
  const all = listSessions({ dbFile });
  assert.deepEqual(all.map((s) => s.id), ['ses_new', 'ses_old'], 'latest first');
  const fresh = listSessions({ dbFile, cutoffMs: T - DAY });
  assert.deepEqual(fresh.map((s) => s.id), ['ses_new'], 'window cutoff applies to the latest message, not the session row');
  assert.equal(fresh[0].mtimeMs, T + 2000);
  assert.equal(fresh[0].size, 2);
  rm(d);
});

test('parseSession maps a session to the index record: identity, usage rows with observed cost, punchcard, active intervals', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [{ id: 'ses_1', directory: '/home/me/myrepo', title: 'Add a hello util', timeCreated: T }],
    messages: [
      userMsg('u1', 'ses_1', T, 'add a hello util'),
      assistantMsg('a1', 'ses_1', T + 60_000, { cost: 0.01 }),
      assistantMsg('a2', 'ses_1', T + 120_000, { cost: 0.02 }),
      // a second model on a later day, and an idle split (> 15 min)
      assistantMsg('a3', 'ses_1', T + DAY, { model: 'moonshotai/kimi-k3', provider: 'openrouter', cost: 0.03, tokens: { input: 5, output: 1, cache: { read: 0, write: 0 } } }),
    ],
  });
  const { session: rec } = parseSession({ dbFile, id: 'ses_1' });
  assert.equal(rec.provider, 'opencode');
  assert.equal(rec.host, 'opencode');
  assert.equal(rec.title, 'Add a hello util');
  assert.equal(rec.project, 'myrepo');
  assert.equal(rec.prompts, 1);
  assert.equal(rec.responses, 3);
  assert.equal(rec.exceptions, 0);
  assert.equal(rec.sidechain, false);
  assert.equal(rec.threadSource, null);
  // provider is the LAST observed assistant providerID — never the host
  assert.equal(rec.inferenceProvider, 'openrouter');
  assert.equal(rec.providerProvenance, 'observed');
  // usage rows per (day, model) with summed observed cost
  const day1 = rec.usage.find((r) => r.model === 'kimi-k3');
  assert.deepEqual(
    { input: day1.input, output: day1.output, cacheRead: day1.cacheRead, cacheWrite: day1.cacheWrite, responses: day1.responses, costObserved: day1.costObserved },
    { input: 200, output: 40, cacheRead: 80, cacheWrite: 6, responses: 2, costObserved: 0.03 },
  );
  const day2 = rec.usage.find((r) => r.model === 'moonshotai/kimi-k3');
  assert.equal(day2.costObserved, 0.03);
  assert.equal(day2.day !== day1.day, true, 'rows keyed by day');
  assert.deepEqual(rec.models, ['kimi-k3', 'moonshotai/kimi-k3']);
  assert.equal(rec.reasoningOutput, 15);
  // engaged-time: the >15-min gap splits active intervals into two
  assert.equal(rec.active.length, 2);
  rm(d);
});

test('a parent_id marks a subagent session WITHOUT stripping its own tokens', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [
      { id: 'ses_p', directory: '/x', title: 'parent', timeCreated: T },
      { id: 'ses_c', directory: '/x', title: 'child', parentId: 'ses_p', timeCreated: T },
    ],
    messages: [assistantMsg('a1', 'ses_c', T, { cost: 0.5 })],
  });
  const { session: rec } = parseSession({ dbFile, id: 'ses_c' });
  assert.equal(rec.sidechain, true);
  assert.equal(rec.threadSource, 'subagent');
  assert.equal(rec.usage[0].costObserved, 0.5, 'child sessions keep their own metered usage (not a parent replay)');
  rm(d);
});

test('rows with NO observed cost stay null so the pricing table applies (never a fabricated $0)', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [{ id: 'ses_1', directory: '/x', title: 'uncosted', timeCreated: T }],
    messages: [assistantMsg('a1', 'ses_1', T)], // no cost field
  });
  const { session: rec } = parseSession({ dbFile, id: 'ses_1' });
  assert.equal(rec.usage[0].costObserved, null);
  rm(d);
});

test('malformed rows are skipped, never fatal — the session still parses', () => {
  const d = tmp();
  const file = path.join(d, 'opencode.db');
  buildDb(file, { sessions: [{ id: 'ses_1', directory: '/x', title: 't', timeCreated: T }] });
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    .run('bad', 'ses_1', T, T, '{not json');
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    .run('good', 'ses_1', T + 1, T + 1, JSON.stringify({ role: 'assistant', modelID: 'kimi-k3', tokens: { input: 1, output: 1, cache: {} }, time: { created: T + 1 } }));
  db.close();
  const { session: rec } = parseSession({ dbFile: file, id: 'ses_1' });
  assert.equal(rec.responses, 1, 'the good row survives the corrupt one');
  rm(d);
});

test('withTurns emits user/assistant turn rows with text and tool names; tool counts land without turns too', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [{ id: 'ses_1', directory: '/x', title: 't', timeCreated: T }],
    messages: [
      userMsg('u1', 'ses_1', T, 'do the thing'),
      assistantMsg('a1', 'ses_1', T + 1000),
    ],
    parts: [
      { id: 'p1', messageId: 'u1', sessionId: 'ses_1', at: T, data: { type: 'text', text: 'do the thing' } },
      { id: 'p2', messageId: 'a1', sessionId: 'ses_1', at: T + 1000, data: { type: 'tool', tool: 'bash', callID: 'b1', state: { status: 'completed' } } },
      { id: 'p3', messageId: 'a1', sessionId: 'ses_1', at: T + 1001, data: { type: 'text', text: 'done' } },
    ],
  });
  const { turns, session: rec } = parseSession({ dbFile, id: 'ses_1', withTurns: true });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'user');
  assert.match(turns[0].text, /do the thing/);
  assert.equal(turns[1].role, 'assistant');
  assert.deepEqual(turns[1].tools, ['bash']);
  assert.equal(rec.tools.bash, 1, 'tool usage counted for classification');
  // and without turns, tool counts still land
  const lean = parseSession({ dbFile, id: 'ses_1' });
  assert.equal(lean.session.tools.bash, 1);
  rm(d);
});

test('assistant messages: mode (last wins), user→assistant latency gap, error → exception, ctxLastTokens', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [{ id: 'ses_1', directory: '/x', title: 't', timeCreated: T }],
    messages: [
      userMsg('u1', 'ses_1', T, 'fix the auth flow'),
      assistantMsg('a1', 'ses_1', T + 4_000, { mode: 'build', tokens: { input: 900, cache: { read: 20000 }, output: 10 } }),
      // token-LESS: the error row must never overwrite ctxLastTokens with a
      // fabricated 0 (evidence-gated — see recordAssistantUsage).
      assistantMsg('a2', 'ses_1', T + 8_000, { error: { name: 'ProviderAuthError' }, tokens: null }),
    ],
  });
  const { session } = parseSession({ dbFile, id: 'ses_1' });
  assert.equal(session.mode, 'auto-edit');
  assert.equal(session.modeRaw, 'build');
  assert.equal(session.latHist[1], 1);        // 4s → 2-5s bucket
  assert.equal(session.exceptions, 1);
  assert.equal(session.ctxLastTokens, 20900);
  rm(d);
});

test('an error row WITH evidence still records mode/model/usage/cost/ctx — only exceptions++ and no latency sample are error-specific', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [{ id: 'ses_2', directory: '/x', title: 't', timeCreated: T }],
    messages: [
      userMsg('u1', 'ses_2', T, 'deploy the fix'),
      assistantMsg('a1', 'ses_2', T + 3_000, {
        model: 'claude-opus-5', mode: 'plan', cost: 0.5, error: { name: 'ProviderAuthError' },
        tokens: { input: 10, cache: { read: 5 } },
      }),
    ],
  });
  const { session } = parseSession({ dbFile, id: 'ses_2' });
  assert.equal(session.mode, 'plan', 'mode is recorded even on an error row');
  assert.equal(session.modeRaw, 'plan');
  const row = session.usage.find((r) => r.model === 'claude-opus-5');
  assert.equal(row.costObserved, 0.5, 'cost is recorded even on an error row');
  assert.deepEqual(session.models, ['claude-opus-5'], 'modelID is recorded even on an error row');
  assert.equal(session.ctxLastTokens, 15, 'ctx is recorded even on an error row, when it carries tokens');
  assert.equal(session.latHist, null, 'an error row never produces a latency sample');
  assert.equal(session.exceptions, 1);
  rm(d);
});

test('sessionExists tracks row presence', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [{ id: 'ses_1', directory: '/x', title: 't', timeCreated: T }],
  });
  assert.equal(sessionExists({ dbFile, id: 'ses_1' }), true);
  assert.equal(sessionExists({ dbFile, id: 'ses_nope' }), false);
  rm(d);
});

test('an absent db reads as no source, never a throw', () => {
  const d = tmp();
  const missing = path.join(d, 'nope.db');
  assert.deepEqual(listSessions({ dbFile: missing }), []);
  assert.equal(parseSession({ dbFile: missing, id: 'x' }), null);
  assert.equal(sessionExists({ dbFile: missing, id: 'x' }), false);
  rm(d);
});
