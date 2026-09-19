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
import { promptFingerprint } from '../../src/lib/usage-parsers.mjs';

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
// completed: null omits `time.completed` (a turn still in flight, or never finished).
const assistantMsg = (id, sessionId, at, { model = 'kimi-k3', provider = 'opencode', tokens = {}, cost = null, mode = null, error = null, completed = at + 1000 } = {}) => ({
  id, sessionId, at,
  data: {
    role: 'assistant', agent: 'build', path: { cwd: '/x', root: '/' },
    modelID: model, providerID: provider,
    ...(tokens !== null ? { tokens: { total: 0, input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 3 }, ...tokens } } : {}),
    ...(cost != null ? { cost } : {}),
    ...(mode != null ? { mode } : {}),
    ...(error != null ? { error } : {}),
    time: { created: at, ...(completed !== null ? { completed } : {}) }, finish: 'stop',
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
    // output = 2 x (20 text + 5 reasoning): OpenCode stores output NET of reasoning
    { input: 200, output: 50, cacheRead: 80, cacheWrite: 6, responses: 2, costObserved: 0.03 },
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
      // OpenCode inserts the assistant row within ~15 ms of the prompt; the
      // response is DONE at `completed`, which is what latency measures.
      assistantMsg('a1', 'ses_1', T + 15, { completed: T + 4_000, mode: 'build', tokens: { input: 900, cache: { read: 20000, write: 3000 }, output: 10 } }),
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
  assert.equal(session.ctxLastTokens, 23900);
  assert.deepEqual(session.contextEvidence.input, {
    first: 23900, last: 23900, peak: 23900, samples: 1,
  });
  assert.equal(session.contextEvidence.state, 'partial');
  rm(d);
});

test('an error row WITH evidence still records mode/model/usage/cost/ctx — only exceptions++ and no latency sample are error-specific', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [{ id: 'ses_2', directory: '/x', title: 't', timeCreated: T }],
    messages: [
      userMsg('u1', 'ses_2', T, 'deploy the fix'),
      assistantMsg('a1', 'ses_2', T + 15, { completed: T + 3_000,
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

// ── v14 prompt fingerprints ─────────────────────────────────────────────────

// The scan path is the one that matters here: it never loaded message PARTS
// before (only turns did), so a fingerprint over an empty string would look
// exactly like a session of attachment-only prompts. Asserting a real token
// count and a 'human' tag is what makes a silently-broken text read fail loudly
// rather than mislabelling every opencode prompt as 'control'.
test('parseSession fingerprints user messages on the scan path, not only withTurns', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [{ id: 'ses_fp', directory: '/x', title: 't', timeCreated: T }],
    messages: [
      userMsg('u1', 'ses_fp', T),
      userMsg('u2', 'ses_fp', T + 2000),
      assistantMsg('a1', 'ses_fp', T + 3000),
    ],
    parts: [
      { id: 'p1', messageId: 'u1', sessionId: 'ses_fp', at: T, data: { type: 'text', text: 'Run the tests.' } },
      { id: 'p2', messageId: 'u2', sessionId: 'ses_fp', at: T + 2000, data: { type: 'text', text: '<!-- generated-by: agentic-kit -->\n\nYou are an agentic-kit managed OpenCode execution worker.' } },
      { id: 'p3', messageId: 'a1', sessionId: 'ses_fp', at: T + 3000, data: { type: 'text', text: 'done' } },
    ],
  });
  const { session: lean } = parseSession({ dbFile, id: 'ses_fp' });
  assert.deepEqual(lean.promptFPs.map((f) => f.p), ['human', 'adapter']);
  assert.equal(lean.promptFPs[0].t, 3, 'the scan path really read the message text');
  assert.deepEqual(lean.promptFPs[0], { ...promptFingerprint('Run the tests.'), p: 'human',
    i: 'verify', d: 'tests' });
  assert.equal(lean.promptFPOverflow, 0);
  assert.equal(JSON.stringify(lean.promptFPs).includes('Run the tests'), false, 'no prompt text on the record');

  // withTurns must agree with it exactly — one text source, two read paths.
  const { session: full } = parseSession({ dbFile, id: 'ses_fp', withTurns: true });
  assert.deepEqual(full.promptFPs, lean.promptFPs);
  rm(d);
});

test('a user message with no text part fingerprints as an attachment-only control turn', () => {
  const d = tmp();
  const dbFile = buildDb(path.join(d, 'opencode.db'), {
    sessions: [{ id: 'ses_att', directory: '/x', title: 't', timeCreated: T }],
    messages: [userMsg('u1', 'ses_att', T)],
  });
  const { session: rec } = parseSession({ dbFile, id: 'ses_att' });
  assert.equal(rec.prompts, 1, 'it is still a prompt turn');
  assert.deepEqual(rec.promptFPs.map((f) => f.p), ['control']);
  assert.equal(rec.promptFPs[0].t, 0);
  rm(d);
});

test('selected SQLite session is refused before materialization when its byte or row budget is exceeded', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'bounded', directory: '/x', title: 'bounded' }],
      messages: [assistantMsg('m1', 'bounded', T), assistantMsg('m2', 'bounded', T + 1000)],
      parts: [{ id: 'p1', sessionId: 'bounded', messageId: 'm1', at: T, data: { type: 'text', text: 'x'.repeat(4096) } }],
    });
    for (const withTurns of [false, true]) {
      const parsed = parseSession({ dbFile, id: 'bounded', withTurns, maxSessionBytes: 1024 });
      assert.equal(parsed.session.acquisitionCoverage?.complete, false);
      assert.equal(parsed.session.acquisitionCoverage.truncated, true);
      assert.equal(parsed.session.acquisitionCoverage.reason, 'session-byte-limit');
      assert.deepEqual(parsed.session.usage, []);
      assert.deepEqual(parsed.turns, []);
    }
    const rows = parseSession({ dbFile, id: 'bounded', maxSessionRows: 2 });
    assert.equal(rows.session.acquisitionCoverage.reason, 'session-row-limit');
    const complete = parseSession({ dbFile, id: 'bounded' });
    assert.equal(complete.session.acquisitionCoverage.complete, true);
    assert.equal(complete.session.responses, 2);
  } finally { rm(d); }
});

test('SQLite acquisition bounds cover single message and metadata bytes, including UTF-8', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [
        { id: 'message-large', directory: '/x', title: 'message' },
        { id: 'metadata-large', directory: '/x', title: 'é'.repeat(600) },
      ],
      messages: [{ id: 'm1', sessionId: 'message-large', at: T, data: { role: 'user', text: 'é'.repeat(600) } }],
    });
    for (const id of ['message-large', 'metadata-large']) {
      const parsed = parseSession({ dbFile, id, maxSessionBytes: 1024 });
      assert.equal(parsed.session.acquisitionCoverage.reason, 'session-byte-limit');
      assert.ok(parsed.session.acquisitionCoverage.sourceBytes > 1024);
      assert.deepEqual(parsed.session.usage, []);
    }
  } finally { rm(d); }
});

// ── O-2: in-place row updates are part of the session's cache key ───────────

test('listSessions exposes the latest time_updated so an in-place message write changes the key', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_u', directory: '/x', title: 'u', timeCreated: T, timeUpdated: T }],
      messages: [userMsg('u1', 'ses_u', T), assistantMsg('a1', 'ses_u', T + 1000)],
    });
    const before = listSessions({ dbFile })[0];
    assert.equal(before.updatedMs, T + 1000, 'the newest message time_updated seeds the key');

    // OpenCode finishes a step by REWRITING the assistant row: same id, same
    // time_created, same message count — only time_updated (and data) move.
    const db = new DatabaseSync(dbFile);
    db.prepare('UPDATE message SET time_updated = ?, data = ? WHERE id = ?')
      .run(T + 9000, JSON.stringify(assistantMsg('a1', 'ses_u', T + 1000, { cost: 0.5 }).data), 'a1');
    db.close();
    const after = listSessions({ dbFile })[0];
    assert.equal(after.mtimeMs, before.mtimeMs, 'created-time and count are blind to the rewrite');
    assert.equal(after.size, before.size);
    assert.equal(after.updatedMs, T + 9000, 'time_updated is not');
  } finally { rm(d); }
});

test('a session-row-only change (auto title) also moves the key', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_t', directory: '/x', title: 'New session', timeCreated: T, timeUpdated: T }],
      messages: [userMsg('u1', 'ses_t', T)],
    });
    const before = listSessions({ dbFile })[0].updatedMs;
    const db = new DatabaseSync(dbFile);
    db.prepare('UPDATE session SET title = ?, time_updated = ? WHERE id = ?').run('Real title', T + 5000, 'ses_t');
    db.close();
    assert.ok(listSessions({ dbFile })[0].updatedMs > before);
  } finally { rm(d); }
});

// ── O-3: latency ends when the response COMPLETES ───────────────────────────

test('latency is user.created to assistant.completed, not the ~15 ms row-insert gap', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_l', directory: '/x', title: 't', timeCreated: T }],
      messages: [
        userMsg('u1', 'ses_l', T, 'explain the module'),
        assistantMsg('a1', 'ses_l', T + 15, { completed: T + 12_000 }),
      ],
    });
    const { session } = parseSession({ dbFile, id: 'ses_l' });
    assert.equal(session.latCount, 1);
    assert.equal(session.latHist[3], 1, '12 s lands in the 10-30 s bucket (the created-gap read it as ~0.015 s)');
  } finally { rm(d); }
});

test('an assistant row with no completed stamp yields no latency sample, and consumes the prompt', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_n', directory: '/x', title: 't', timeCreated: T }],
      messages: [
        userMsg('u1', 'ses_n', T, 'go'),
        assistantMsg('a1', 'ses_n', T + 15, { completed: null }),
        // a later step of the same turn must not be sampled against the stale prompt
        assistantMsg('a2', 'ses_n', T + 20_000, { completed: T + 30_000 }),
      ],
    });
    const { session } = parseSession({ dbFile, id: 'ses_n' });
    assert.equal(session.latCount, 0);
    assert.equal(session.latHist, null);
  } finally { rm(d); }
});

test('the completed stamp joins activity, so one long generation is one interval and the last generation counts', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_long', directory: '/x', title: 't', timeCreated: T }],
      messages: [
        userMsg('u1', 'ses_long', T, 'refactor everything'),
        // a 20-minute generation: created-only stamps read it as an instant
        assistantMsg('a1', 'ses_long', T + 15, { completed: T + 20 * 60_000 }),
      ],
    });
    const { session } = parseSession({ dbFile, id: 'ses_long' });
    assert.equal(session.active.length, 1);
    assert.equal(session.lenSeconds, 1200);
    assert.equal(session.end, T + 20 * 60_000, 'the session span reaches the last completion');
  } finally { rm(d); }
});

// ── O-4: a user abort is an abort, not an exception ─────────────────────────

test('MessageAbortedError counts as an abort, keeps its usage, and is never an exception or a latency sample', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_ab', directory: '/x', title: 't', timeCreated: T }],
      messages: [
        userMsg('u1', 'ses_ab', T, 'stop me'),
        assistantMsg('a1', 'ses_ab', T + 15, { completed: T + 3_000, cost: 0.2, error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } }),
        userMsg('u2', 'ses_ab', T + 10_000, 'again'),
        assistantMsg('a2', 'ses_ab', T + 10_015, { completed: T + 10_500, error: { name: 'APIError', data: { message: 'boom' } } }),
      ],
    });
    const { session } = parseSession({ dbFile, id: 'ses_ab' });
    assert.equal(session.aborts, 1);
    assert.equal(session.exceptions, 1, 'only the genuine provider failure is an exception');
    assert.equal(session.latHist, null, 'neither an aborted nor a failed turn is a latency sample');
    assert.equal(session.usage[0].costObserved, 0.2, 'the aborted turn still spent tokens and cost');
    assert.equal(session.responses, 2);
  } finally { rm(d); }
});

// ── O-1: reasoning tokens are output ────────────────────────────────────────
// OpenCode (installed 1.18.31 getUsage, read from the shipped binary) stores
// `output: max(0, outputTokens - reasoningTokens)` and `reasoning` as a SEPARATE
// field, and prices reasoning at the output rate. So a message's real output is
// output + reasoning; the row must carry both or totals and estimates run low.

test('reasoning is added to the usage row output, priced with it, and kept as detail', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_r', directory: '/x', title: 't', timeCreated: T }],
      messages: [
        // total = input + cache + output + reasoning: the additive convention
        assistantMsg('a1', 'ses_r', T, { tokens: { input: 100, output: 20, reasoning: 30, cache: { read: 40, write: 3 }, total: 193 } }),
        assistantMsg('a2', 'ses_r', T + 1000, { cost: 0.5, tokens: { input: 10, output: 2, reasoning: 8, cache: { read: 0, write: 0 }, total: 20 } }),
      ],
    });
    const { session } = parseSession({ dbFile, id: 'ses_r' });
    const row = session.usage[0];
    assert.equal(row.output, 20 + 30 + 2 + 8, 'text + reasoning output, both messages');
    assert.deepEqual(row.costMissingUsage, { input: 100, output: 50, cacheRead: 40, cacheWrite: 3, responses: 1 },
      'the message with no recorded cost is estimated on its full output, reasoning included');
    assert.equal(row.costObserved, 0.5, 'a recorded cost is untouched — it already includes reasoning');
    assert.equal(session.reasoningOutput, 38, 'reasoning stays visible as the part of output that was thinking');
  } finally { rm(d); }
});

test('when the provider total shows output already included reasoning, it is not added twice', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_old', directory: '/x', title: 't', timeCreated: T }],
      messages: [
        // total = input + cache + output (NO reasoning add-on): output is gross of reasoning
        assistantMsg('a1', 'ses_old', T, { tokens: { input: 100, output: 50, reasoning: 30, cache: { read: 40, write: 3 }, total: 193 } }),
      ],
    });
    const { session } = parseSession({ dbFile, id: 'ses_old' });
    assert.equal(session.usage[0].output, 50, 'the recorded output already contains the 30 reasoning tokens');
    assert.equal(session.reasoningOutput, 30);
  } finally { rm(d); }
});

test('a message with no reasoning, or no usable total, keeps its output as recorded', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_z', directory: '/x', title: 't', timeCreated: T }],
      messages: [assistantMsg('a1', 'ses_z', T, { tokens: { output: 20, reasoning: 0 } })],
    });
    const { session } = parseSession({ dbFile, id: 'ses_z' });
    assert.equal(session.usage[0].output, 20);
    assert.equal(session.reasoningOutput, 0);
  } finally { rm(d); }
});

// ── O-7: rows carry the provider that served them ───────────────────────────

test('the same modelID under two providers stays two usage rows, each carrying its provider', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_p', directory: '/x', title: 't', timeCreated: T }],
      messages: [
        assistantMsg('a1', 'ses_p', T, { model: 'qwen3-coder', provider: 'lmstudio', tokens: { input: 10 } }),
        assistantMsg('a2', 'ses_p', T + 1000, { model: 'qwen3-coder', provider: 'openrouter', cost: 0.2, tokens: { input: 70 } }),
        assistantMsg('a3', 'ses_p', T + 2000, { model: 'qwen3-coder', provider: 'openrouter', cost: 0.1, tokens: { input: 5 } }),
      ],
    });
    const { session } = parseSession({ dbFile, id: 'ses_p' });
    assert.equal(session.usage.length, 2, 'rows are (day, model, provider), not (day, model)');
    const local = session.usage.find((r) => r.provider === 'lmstudio');
    const cloud = session.usage.find((r) => r.provider === 'openrouter');
    assert.equal(local.input, 10);
    assert.equal(local.costObserved, null, 'the local turn recorded no cost and is not charged with the cloud turn\'s');
    assert.equal(cloud.input, 75);
    assert.ok(Math.abs(cloud.costObserved - 0.3) < 1e-9);
    assert.equal(session.inferenceProvider, 'openrouter', 'the session-level provider stays the last observed one');
  } finally { rm(d); }
});

test('a row with no providerID carries no provider key and still merges with its own kind', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_np', directory: '/x', title: 't', timeCreated: T }],
      messages: [
        { ...assistantMsg('a1', 'ses_np', T), data: { ...assistantMsg('a1', 'ses_np', T).data, providerID: undefined } },
        { ...assistantMsg('a2', 'ses_np', T + 1000), data: { ...assistantMsg('a2', 'ses_np', T + 1000).data, providerID: undefined } },
      ],
    });
    const { session } = parseSession({ dbFile, id: 'ses_np' });
    assert.equal(session.usage.length, 1);
    assert.equal('provider' in session.usage[0], false);
    assert.equal(session.usage[0].responses, 2);
  } finally { rm(d); }
});

// Verified-correct behaviour, pinned: OpenCode also writes a `step-finish`
// part carrying the same tokens/cost as its message. Parts are never read for
// usage, so a message with one is counted exactly once.
test('a step-finish part with tokens and cost never double counts its message', () => {
  const d = tmp();
  try {
    const dbFile = buildDb(path.join(d, 'opencode.db'), {
      sessions: [{ id: 'ses_sf', directory: '/x', title: 't', timeCreated: T }],
      messages: [
        userMsg('u1', 'ses_sf', T, 'go'),
        assistantMsg('a1', 'ses_sf', T + 10, { cost: 0.5, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
      ],
      parts: [{
        id: 'p1', messageId: 'a1', sessionId: 'ses_sf', at: T + 900,
        data: { type: 'step-finish', reason: 'stop', cost: 0.5, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } },
      }],
    });
    for (const withTurns of [false, true]) {
      const { session } = parseSession({ dbFile, id: 'ses_sf', withTurns });
      assert.equal(session.usage[0].input, 100);
      assert.equal(session.usage[0].output, 20);
      assert.equal(session.usage[0].costObserved, 0.5);
      assert.equal(session.usage[0].responses, 1);
    }
  } finally { rm(d); }
});
