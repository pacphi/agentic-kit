// usage-opencode.mjs — the opencode transcript source for the usage scorecard
// (ADR-0009's index, third source alongside the claude/codex JSONL roots).
//
// opencode persists sessions in a single SQLite store:
//   ~/.local/share/opencode/opencode.db
//     session(id, project_id, parent_id, slug, directory, title, cost,
//             tokens_input/output/reasoning/cache_read/cache_write, time_*)
//     message(id, session_id, time_created, data JSON)   — role/tokens/cost/model
//     part(id, message_id, data JSON)                    — text/tool/reasoning
//
// The store is opened READ-ONLY (node:sqlite via sqlite.mjs) and never
// rewritten; a malformed row is skipped, never fatal; and nothing here throws
// on bad input — an absent/corrupt db simply reads as "no opencode source".
//
// Two attribution rules, grounded in the store itself:
//   - COST is opencode's own metered figure on each assistant message
//     (data.cost). That is OBSERVED truth, so usage rows carry it as
//     `costObserved` and the aggregate prefers it over the pricing table —
//     never re-priced from a guessed rate (kimi/openrouter/local rates are
//     exactly what ak does not know and must not invent).
//   - INFERENCE PROVIDER is the assistant row's providerID when observed
//     (provenance 'observed'), never the host. A bare `opencode` host id says
//     nothing about who served the model.
// Subagent sessions (parent_id set) keep their tokens: opencode child sessions
// record their OWN messages, not a replay of the parent's — the codex
// double-count rule does not apply (different storage semantics).
import { withDb } from './sqlite.mjs';
// Shared record shape/accumulator with parseClaude/parseCodex — see their
// definitions in usage-parsers.mjs. usage-index.mjs imports FROM this module
// (defaultOpencodeDbPath, parseSession, …), but that is no longer a cycle:
// this module depends only on usage-parsers.mjs, not on usage-index.mjs.
import { addUsage, blankSession, noteLatencySample, notePromptFingerprint } from './usage-parsers.mjs';
import { normalizeMode } from './usage-modes.mjs';

/** The live opencode store. Overridable via roots in tests. */
export function defaultOpencodeDbPath() {
  const home = process.env.XDG_DATA_HOME ?? null;
  return home
    ? `${home}/opencode/opencode.db`
    : `${process.env.HOME ?? process.env.USERPROFILE}/.local/share/opencode/opencode.db`;
}

/** YYYY-MM-DD in LOCAL time (same convention as usage-index's localDay). */
function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Punchcard key: day-of-week (0=Mon) + hour (same convention as punchKey). */
function punchKey(ms) {
  const d = new Date(ms);
  return `${(d.getDay() + 6) % 7}-${d.getHours()}`;
}

const clip = (text, max = 100) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Split activity timestamps into engaged intervals at the same 15-min gap
 *  the index uses (kept in lockstep with usage-index.IDLE_GAP_MS). */
const IDLE_GAP_MS = 15 * 60 * 1000;
function activeIntervals(stamps) {
  const ts = stamps.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ts.length) return [];
  const out = [];
  let start = ts[0];
  let prev = ts[0];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - prev > IDLE_GAP_MS) { out.push([start, prev]); start = ts[i]; }
    prev = ts[i];
  }
  out.push([start, prev]);
  return out;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const parseJson = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

/** A prompt-to-response gap longer than this is an idle resume, not a real
 *  wait for a reply — excluded from latency sampling (mirrors usage-parsers'
 *  own MAX_LATENCY_SAMPLE_SECONDS, private there, so redeclared here rather
 *  than exported cross-module for a single constant). */
const MAX_LATENCY_SAMPLE_SECONDS = 3600;

/** Incremental candidates: sessions whose latest message lands at/after
 *  cutoffMs. `mtimeMs` (latest message time) + `size` (message count) are the
 *  cache key — a warm refresh re-parses only sessions that gained messages.
 *  @param {{ dbFile: string, cutoffMs?: number }} opts */
export function listSessions({ dbFile, cutoffMs = 0 }) {
  const result = listSessionsResult({ dbFile, cutoffMs });
  return result.ok ? result.value : [];
}

export function listSessionsResult({ dbFile, cutoffMs = 0 }) {
  return withDb(dbFile, (db) => db.prepare(`
    SELECT s.id AS id, COALESCE(MAX(m.time_created), s.time_created) AS mtime,
           COUNT(m.id) AS messages
    FROM session s LEFT JOIN message m ON m.session_id = s.id
    GROUP BY s.id
    HAVING mtime >= ?
    ORDER BY mtime DESC
  `).all(cutoffMs).map((r) => ({ id: r.id, mtimeMs: num(r.mtime), size: num(r.messages) })));
}

/** Carry-forward existence probe (a session can be deleted between scans). */
export function sessionExists({ dbFile, id }) {
  const result = sessionExistsResult({ dbFile, id });
  return result.ok ? result.value : false;
}

export function sessionExistsResult({ dbFile, id }) {
  return withDb(dbFile, (db) => !!db.prepare('SELECT 1 FROM session WHERE id = ?').get(id));
}

/** Project label from the session's working directory: basename, with the
 *  worktree marker convention (…/<repo>/worktrees/<rest>) preserved. */
function projectFromDirectory(directory) {
  const segs = String(directory ?? '').split(/[\\/]+/).filter(Boolean);
  for (let i = 1; i < segs.length - 1; i++) {
    if (['.git'].includes(segs[i]) && segs[i + 1] === 'worktrees') {
      return { project: segs[i - 1] ?? 'unknown', worktree: segs.slice(i + 2).join('/') || null };
    }
  }
  const base = segs[segs.length - 1];
  return { project: base && base !== '.' ? base : 'unknown', worktree: null };
}

/** Group a session's `part` rows by their owning message id. */
function buildPartsIndex(partRows) {
  const partsByMessage = new Map();
  for (const p of partRows) {
    const data = parseJson(p.data);
    if (!data) continue;
    if (!partsByMessage.has(p.message_id)) partsByMessage.set(p.message_id, []);
    partsByMessage.get(p.message_id).push(data);
  }
  return partsByMessage;
}

/** Joined text of a message's parts whose `type` is one of `types`. */
function messagePartsText(partsByMessage, rowId, types) {
  return (partsByMessage.get(rowId) ?? [])
    .filter((p) => types.includes(p.type) && typeof p.text === 'string')
    .map((p) => p.text).join('\n');
}

/** Extend a session record's span/stamps with one message's timestamp. */
function noteStamp(rec, at) {
  if (!at) return;
  rec.stamps.push(at);
  if (rec.start === null || at < rec.start) rec.start = at;
  if (rec.end === null || at > rec.end) rec.end = at;
}

function recordUserMessage(rec, turns, { rowId, at, withTurns, partsByMessage }) {
  rec.prompts++;
  // Opens the prompt→assistant-message latency window; closed by the next
  // recordAssistantMessage (mirrors parseClaude/parseCodex's latState).
  rec.pendingPromptMs = at;
  // Every opencode user message IS a prompt-kind turn (this source carries no
  // harness-injected user rows), so it always fingerprints — on BOTH paths,
  // which is why the scan path now loads user text parts (see loadTextParts).
  const text = messagePartsText(partsByMessage, rowId, ['text']);
  notePromptFingerprint(rec, text, 'prompt');
  if (!withTurns) return;
  turns.push({ role: 'user', at: new Date(at).toISOString(), text, prompt: true, kind: 'prompt' });
}

/** Model/provider/token-usage bookkeeping for one assistant message. Returns
 *  the model id, for the caller's turn row. */
function recordAssistantUsage(rec, data, at) {
  const model = typeof data.modelID === 'string' && data.modelID ? data.modelID : 'unknown';
  if (!rec.models.includes(model)) rec.models.push(model);
  if (typeof data.providerID === 'string' && data.providerID) {
    rec.inferenceProvider = data.providerID;
    rec.providerProvenance = 'observed';
  }
  const t = data.tokens ?? {};
  const cache = t.cache ?? {};
  const day = localDay(at || Date.now());
  const usageRow = addUsage(rec, day, model, {
    input: num(t.input), output: num(t.output),
    cacheRead: num(cache.read), cacheWrite: num(cache.write), responses: 1,
  });
  // opencode's OWN metered cost for this message — observed truth, summed
  // per (day, model) row. Rows where NO message carried a cost stay null
  // (the field is always present, unlike an absent key, so a consumer
  // checking `costObserved != null` never needs to guess whether this row
  // was ever priced), so the aggregate falls back to the pricing table
  // rather than misreporting a fabricated $0.
  usageRow.costObserved ??= null;
  if (Number.isFinite(Number(data.cost))) usageRow.costObserved = (usageRow.costObserved ?? 0) + Number(data.cost);
  rec.reasoningOutput += num(t.reasoning);
  // Context pressure for THIS turn, evidence-gated: only a row that actually
  // carries a tokens object can claim one — a token-less row (error or not)
  // must never overwrite a real prior value with a fabricated 0 (mirrors
  // parseClaude, which only ever reaches this line for a real usage entry).
  // Overwritten every qualifying message so the field reflects the LAST
  // completion, not a running total.
  if (data.tokens !== null && typeof data.tokens === 'object') {
    rec.ctxLastTokens = num(t.input) + num(cache.read);
  }
  return model;
}

/** Turn row + tool tally for one assistant message, when withTurns. */
function recordAssistantTurn(rec, turns, { rowId, at, model, partsByMessage }) {
  const parts = partsByMessage.get(rowId) ?? [];
  const tools = parts.filter((p) => p.type === 'tool' && typeof p.tool === 'string').map((p) => p.tool);
  for (const name of tools) rec.tools[name] = (rec.tools[name] ?? 0) + 1;
  const text = messagePartsText(partsByMessage, rowId, ['text', 'reasoning']);
  turns.push({ role: 'assistant', at: new Date(at).toISOString(), model, text, tools });
}

function recordAssistantMessage(rec, turns, { data, rowId, at, withTurns, partsByMessage }) {
  rec.responses++;
  if (at) { const pk = punchKey(at); rec.punchcard[pk] = (rec.punchcard[pk] ?? 0) + 1; }
  // A provider/auth/network failure is a REAL logged row here — unlike
  // parseClaude's synthetic all-zero placeholder, it still carries whatever
  // mode/model/usage/cost evidence it has, and that evidence is kept. Only
  // two effects are error-specific: it counts as an exception, and it can
  // never BE a latency sample (an unanswered prompt is not a measured
  // response time) — though the pending prompt is still consumed here so a
  // later, unrelated assistant message is never mis-sampled against a stale
  // prompt.
  if (data.error != null) {
    rec.exceptions++;
    rec.pendingPromptMs = null;
  } else if (rec.pendingPromptMs !== null && rec.pendingPromptMs !== undefined) {
    const gapSeconds = (at - rec.pendingPromptMs) / 1000;
    if (gapSeconds <= MAX_LATENCY_SAMPLE_SECONDS) noteLatencySample(rec, gapSeconds);
    rec.pendingPromptMs = null;
  }
  const m = normalizeMode({ host: 'opencode', opencodeMode: data.mode });
  if (m.raw) { rec.mode = m.mode; rec.modeRaw = m.raw; }
  const model = recordAssistantUsage(rec, data, at);
  if (withTurns) recordAssistantTurn(rec, turns, { rowId, at, model, partsByMessage });
}

/** One `message` row: malformed rows are skipped, never fatal. */
function processMessageRow(rec, turns, row, { withTurns, partsByMessage }) {
  const data = parseJson(row.data);
  if (!data || typeof data.role !== 'string') return;
  const at = num(data.time?.created) || num(row.time_created);
  noteStamp(rec, at);
  if (data.role === 'user') {
    recordUserMessage(rec, turns, { rowId: row.id, at, withTurns, partsByMessage });
    return;
  }
  if (data.role !== 'assistant') return;
  recordAssistantMessage(rec, turns, { data, rowId: row.id, at, withTurns, partsByMessage });
}

/** The `part` rows a parse needs. `withTurns` wants every part (text, tool and
 *  reasoning, for both roles) to build turn rows; the scan path wants only the
 *  USER text parts, which is all a prompt fingerprint reads — the assistant
 *  bodies it would otherwise pull in are the bulk of the store and are never
 *  looked at there. */
function loadTextParts(db, id, withTurns) {
  if (withTurns) {
    return db.prepare(`
      SELECT p.message_id AS message_id, p.data AS data
      FROM part p JOIN message m ON m.id = p.message_id
      WHERE m.session_id = ? ORDER BY p.rowid ASC
    `).all(id);
  }
  return db.prepare(`
    SELECT p.message_id AS message_id, p.data AS data
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE m.session_id = ?
      AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
    ORDER BY p.rowid ASC
  `).all(id);
}

/** Tool counts without the full turn payload: one lean query on the scan path. */
function collectScanToolCounts(db, id, rec) {
  const toolRows = db.prepare(`
    SELECT p.data AS data FROM part p JOIN message m ON m.id = p.message_id
    WHERE m.session_id = ? AND json_extract(p.data, '$.type') = 'tool'
  `).all(id);
  for (const p of toolRows) {
    const data = parseJson(p.data);
    const name = typeof data?.tool === 'string' ? data.tool : null;
    if (name) rec.tools[name] = (rec.tools[name] ?? 0) + 1;
  }
}

/** The session record's opencode-specific fields, before its messages are walked. */
function initSessionRecord(srow) {
  const { project, worktree } = projectFromDirectory(srow.directory);
  // blankSession's default host/provider ('opencode' for both) already
  // matches this source; only the opencode-specific fields are overridden.
  const rec = blankSession(srow.id, 'opencode');
  rec.title = clip(srow.title) || '(untitled)';
  rec.project = project;
  rec.sidechain = !!srow.parent_id;
  rec.threadSource = srow.parent_id ? 'subagent' : null;
  if (worktree) rec.worktree = worktree;
  // Transient parse-time state (the open prompt→assistant latency window,
  // see recordUserMessage/recordAssistantMessage) — deleted before return in
  // parseSession, never part of the returned session shape.
  rec.pendingPromptMs = null;
  return rec;
}

/** Parse ONE opencode session into the index's per-session record shape,
 *  built from the SAME blankSession/addUsage parseClaude and parseCodex use.
 *  Returns { session, turns }; null when the session is gone or unreadable.
 *  withTurns emits the transcript-view turn rows alongside the record.
 *  @param {{ dbFile: string, id: string, withTurns?: boolean }} opts */
export function parseSession({ dbFile, id, withTurns = false }) {
  const result = withDb(dbFile, (db) => {
    const srow = db.prepare('SELECT * FROM session WHERE id = ?').get(id);
    if (!srow) return null;
    const msgRows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC').all(id);
    const partsByMessage = buildPartsIndex(loadTextParts(db, id, withTurns));

    const rec = initSessionRecord(srow);
    const turns = [];
    for (const row of msgRows) processMessageRow(rec, turns, row, { withTurns, partsByMessage });
    if (!withTurns) collectScanToolCounts(db, id, rec);

    if (!rec.title) rec.title = '(untitled)';
    rec.active = activeIntervals(rec.stamps);
    rec.lenSeconds = Math.round(rec.active.reduce((n, [a, b]) => n + (b - a), 0) / 1000);
    delete rec.stamps;
    delete rec.pendingPromptMs;
    return { session: rec, turns };
  });
  return result.ok ? result.value : null;
}
