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
import { sessionAcquisitionCoverage } from './usage-opencode-bounds.mjs';
// Shared record shape/accumulator with parseClaude/parseCodex — see their
// definitions in usage-parsers.mjs. usage-index.mjs imports FROM this module
// (defaultOpencodeDbPath, parseSession, …), but that is no longer a cycle:
// this module depends only on usage-parsers.mjs, not on usage-index.mjs.
import {
  addUsage, blankSession, noteContextSample, noteLatencySample, notePromptFingerprint,
} from './usage-parsers.mjs';
import { normalizeMode } from './usage-modes.mjs';
import { observeUsageProject } from './usage-project-evidence.mjs';

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
function stampIntervals(stamps) {
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

/** Engaged intervals: the gap-split stamps, unioned with each assistant row's
 *  own [created, completed] span. A generation is continuous work however long
 *  it ran, so a single response longer than the idle gap must not be cut in two
 *  by the created-stamp heuristic. */
function activeIntervals(stamps, spans = []) {
  const base = stampIntervals(stamps);
  const own = spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a);
  if (!own.length) return base;
  const merged = [];
  for (const iv of [...base, ...own].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const parseJson = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

/** A prompt-to-response gap longer than this is an idle resume, not a real
 *  wait for a reply — excluded from latency sampling (mirrors usage-parsers'
 *  own MAX_LATENCY_SAMPLE_SECONDS, private there, so redeclared here rather
 *  than exported cross-module for a single constant). */
const MAX_LATENCY_SAMPLE_SECONDS = 3600;

/** Incremental candidates: sessions whose latest message lands at/after
 *  cutoffMs. The cache key is `mtimeMs` (latest message time) + `size`
 *  (message count) + `updatedMs` (latest `time_updated` over the session's
 *  messages and the session row itself). The last one is what makes a warm
 *  refresh notice an IN-PLACE rewrite: OpenCode inserts the assistant row when
 *  a turn starts (zero tokens, no `time.completed`) and writes the step's
 *  tokens, cost and completed stamp into that same row later, so neither the
 *  created-time nor the row count moves when the turn finishes — only
 *  `time_updated` does. The session row's own stamp covers a title/summary
 *  change that no message carries.
 *  @param {{ dbFile: string, cutoffMs?: number }} opts */
export function listSessions({ dbFile, cutoffMs = 0 }) {
  const result = listSessionsResult({ dbFile, cutoffMs });
  return result.ok ? result.value : [];
}

export function listSessionsResult({ dbFile, cutoffMs = 0 }) {
  return withDb(dbFile, (db) => db.prepare(`
    SELECT s.id AS id, COALESCE(MAX(m.time_created), s.time_created) AS mtime,
           COUNT(m.id) AS messages,
           MAX(COALESCE(MAX(m.time_updated), 0), COALESCE(s.time_updated, 0)) AS updated
    FROM session s LEFT JOIN message m ON m.session_id = s.id
    GROUP BY s.id
    HAVING mtime >= ?
    ORDER BY mtime DESC
  `).all(cutoffMs).map((r) => ({
    id: r.id, mtimeMs: num(r.mtime), size: num(r.messages), updatedMs: num(r.updated),
  })));
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
  // I1: that makes this the WIDEST of the three fingerprinted populations —
  // claude gates on userTurnKind, codex additionally on
  // CODEX_MACHINE_ENVELOPE_RE, opencode on nothing. Compare per provenance tag,
  // never in total.
  const text = messagePartsText(partsByMessage, rowId, ['text']);
  notePromptFingerprint(rec, text, 'prompt');
  if (!withTurns) return;
  turns.push({ role: 'user', at: new Date(at).toISOString(), text, prompt: true, kind: 'prompt' });
}

/** A message's output tokens INCLUDING reasoning. OpenCode (its `getUsage`,
 *  verified against the installed 1.18.31 binary) stores
 *  `output = max(0, outputTokens - reasoningTokens)` and `reasoning` as a
 *  separate field, and prices reasoning at the output rate — so the real output
 *  is their sum, and recording `output` alone under-counts every reasoning
 *  model in both tokens and estimated cost.
 *
 *  One guard against double counting: builds that predate that split stored
 *  reasoning INSIDE `output`. The message's own `tokens.total` (the provider's
 *  input + output) tells the two apart when it is present: a total equal to
 *  the sum of the non-reasoning fields means output already contained the
 *  reasoning, so nothing is added. No total, or one that fits neither shape,
 *  falls to the verified current convention (additive). */
function outputWithReasoning(t, cache) {
  const output = num(t.output);
  const reasoning = num(t.reasoning);
  if (reasoning <= 0) return output;
  const total = num(t.total);
  const gross = num(t.input) + num(cache.read) + num(cache.write) + output;
  if (total > 0 && total === gross) return output;
  return output + reasoning;
}

/** A completed, error-free assistant message whose every token field is zero
 *  or absent. */
function isUnreportedUsage(data, t, cache) {
  if (data.error != null || !(num(data.time?.completed) > 0)) return false;
  return [t.input, t.output, t.reasoning, cache.read, cache.write].every((v) => num(v) === 0);
}

/** The one usage-health warning for a set of parsed OpenCode sessions, or
 *  none: how many completed responses the providers gave no token counts for.
 *  Informational — the responses are still counted, just with unknown usage.
 *  @param {Array<{usage?: Array<{tokensUnreported?: number}>}>} sessions
 *  @returns {string[]} */
export function usageNotReportedWarnings(sessions) {
  let n = 0;
  for (const rec of sessions) for (const row of rec.usage ?? []) n += Number(row.tokensUnreported) || 0;
  return n > 0 ? [`usage-not-reported:${n}`] : [];
}

/** Model/provider/token-usage bookkeeping for one assistant message. Returns
 *  the model id, for the caller's turn row. */
function recordAssistantUsage(rec, data, at) {
  const model = typeof data.modelID === 'string' && data.modelID ? data.modelID : 'unknown';
  if (!rec.models.includes(model)) rec.models.push(model);
  const provider = typeof data.providerID === 'string' && data.providerID ? data.providerID : null;
  if (provider) {
    rec.inferenceProvider = provider;
    rec.providerProvenance = 'observed';
  }
  const t = data.tokens ?? {};
  const cache = t.cache ?? {};
  const day = localDay(at || Date.now());
  const output = outputWithReasoning(t, cache);
  const usageRow = addUsage(rec, day, model, {
    input: num(t.input), output,
    cacheRead: num(cache.read), cacheWrite: num(cache.write), responses: 1, provider,
  });
  // A response that FINISHED cleanly yet carries no token counts at all did not
  // use zero tokens — the provider never reported them (a local model server,
  // typically; the same rows also record a cost of 0). Counted on the row so
  // "usage not reported" stays distinguishable from a measured zero; the scan
  // raises one health warning from these counts. An in-flight, failed or
  // aborted row is not judged: it has no completed response to have reported.
  if (isUnreportedUsage(data, t, cache)) usageRow.tokensUnreported = (usageRow.tokensUnreported ?? 0) + 1;
  // Retain missing-cost tokens separately before coalescing by day/model.
  usageRow.costObserved ??= null;
  if (typeof data.cost === 'number' && Number.isFinite(data.cost) && data.cost >= 0) {
    usageRow.costObserved = (usageRow.costObserved ?? 0) + data.cost;
    usageRow.costObservedMessages = (usageRow.costObservedMessages ?? 0) + 1;
  } else {
    usageRow.costMissingUsage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 };
    const missing = usageRow.costMissingUsage;
    missing.input += num(t.input); missing.output += output;
    missing.cacheRead += num(cache.read); missing.cacheWrite += num(cache.write);
    missing.responses++;
  }
  rec.reasoningOutput += num(t.reasoning);
  // Context pressure for THIS turn, evidence-gated: only a row that actually
  // carries a tokens object can claim one — a token-less row (error or not)
  // must never overwrite a real prior value with a fabricated 0 (mirrors
  // parseClaude, which only ever reaches this line for a real usage entry).
  // Overwritten every qualifying message so the field reflects the LAST
  // completion, not a running total.
  if (data.tokens !== null && typeof data.tokens === 'object') {
    noteContextSample(rec, num(t.input) + num(cache.read) + num(cache.write));
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

/** OpenCode's own error name for a turn the user stopped (its
 *  `MessageAbortedError`, written together with a `time.completed` stamp). */
const ABORT_ERROR_NAME = 'MessageAbortedError';

/** Close the open prompt→response latency window for one assistant message.
 *  A response is measured from the user's prompt to the assistant row's
 *  `time.completed`: OpenCode inserts the assistant row ~10-20 ms after the
 *  prompt and fills it in as it generates, so its `time.created` says nothing
 *  about how long the answer took. A row with no completed stamp (still in
 *  flight, or never finished) has no measured response time and yields no
 *  sample. The prompt is consumed either way, so a later step of the same turn
 *  is never sampled against a stale prompt. */
function closeLatencyWindow(rec, completedAt) {
  const promptAt = rec.pendingPromptMs;
  rec.pendingPromptMs = null;
  if (promptAt === null || promptAt === undefined || !completedAt) return;
  const seconds = (completedAt - promptAt) / 1000;
  if (seconds <= MAX_LATENCY_SAMPLE_SECONDS) noteLatencySample(rec, seconds);
}

function recordAssistantMessage(rec, turns, { data, rowId, at, withTurns, partsByMessage }) {
  rec.responses++;
  if (at) { const pk = punchKey(at); rec.punchcard[pk] = (rec.punchcard[pk] ?? 0) + 1; }
  const completedAt = num(data.time?.completed);
  // The completion is activity too: without it the last generation of a turn
  // (often minutes long) is excluded from engaged time, and a long single
  // generation is split by the created-gap heuristic.
  noteStamp(rec, completedAt);
  if (completedAt > at) rec.spans.push([at, completedAt]);
  // A provider/auth/network failure is a REAL logged row here — unlike
  // parseClaude's synthetic all-zero placeholder, it still carries whatever
  // mode/model/usage/cost evidence it has, and that evidence is kept. Only
  // two effects are error-specific: it counts (as an exception, or as an
  // abort when the user stopped the turn — a choice, not a failure), and it
  // can never BE a latency sample (an unanswered prompt is not a measured
  // response time) — though the pending prompt is still consumed here so a
  // later, unrelated assistant message is never mis-sampled against a stale
  // prompt.
  if (data.error != null) {
    if (data.error?.name === ABORT_ERROR_NAME) rec.aborts++;
    else rec.exceptions++;
    rec.pendingPromptMs = null;
  } else {
    closeLatencyWindow(rec, completedAt);
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
 *  looked at there.
 *
 *  This is the one place the scan path reads message BODIES at all, so its cost
 *  was measured rather than assumed. The live store on this machine is too
 *  small to time (2 sessions, 2 parts; ~5 µs/session, where the two
 *  `json_extract` predicates cannot pay for themselves because there is nothing
 *  to exclude). Benchmarked instead against a synthetic store at realistic scale
 *  — 300 sessions, 18k messages, 63k parts, 75 MB — the filtered query runs
 *  **45 µs/session and materializes 0.6 MB**, against 125 µs/session and 61 MB
 *  for the unfiltered join the reader path uses: 2.8x faster, and ~100x less
 *  text pulled into memory. Only the fingerprints are retained; the text itself
 *  is discarded with the row. */
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
  rec.projectEvidence = observeUsageProject(srow.directory);
  rec.title = clip(srow.title) || '(untitled)';
  rec.project = project;
  rec.sidechain = !!srow.parent_id;
  rec.threadSource = srow.parent_id ? 'subagent' : null;
  if (worktree) rec.worktree = worktree;
  // Transient parse-time state (the open prompt→assistant latency window,
  // see recordUserMessage/recordAssistantMessage) — deleted before return in
  // parseSession, never part of the returned session shape.
  rec.pendingPromptMs = null;
  // Transient too: each assistant row's [created, completed] generation span.
  rec.spans = [];
  return rec;
}

/** Parse ONE opencode session into the index's per-session record shape,
 *  built from the SAME blankSession/addUsage parseClaude and parseCodex use.
 *  Returns { session, turns }; null when the session is gone or unreadable.
 *  withTurns emits the transcript-view turn rows alongside the record.
 *  @param {{ dbFile: string, id: string, withTurns?: boolean, maxSessionBytes?: number, maxSessionRows?: number }} opts */
export function parseSession({ dbFile, id, withTurns = false, maxSessionBytes, maxSessionRows }) {
  const result = withDb(dbFile, (db) => {
    // Pin preflight and payload queries to one snapshot: concurrent growth cannot
    // bypass the budget between measurement and acquisition. Closing rolls back
    // this read-only transaction, including on malformed rows/query errors.
    db.exec('BEGIN');
    const acquisitionCoverage = sessionAcquisitionCoverage(db, id, { maxSessionBytes, maxSessionRows });
    if (!acquisitionCoverage.complete) {
      const rec = blankSession(id, 'opencode');
      Object.assign(rec, { acquisitionCoverage });
      rec.end = acquisitionCoverage.latestMessageAt;
      delete rec.stamps;
      return { session: rec, turns: [] };
    }
    const srow = db.prepare('SELECT id, parent_id, directory, title FROM session WHERE id = ?').get(id);
    if (!srow) return null;
    const msgRows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC').all(id);
    const partsByMessage = buildPartsIndex(loadTextParts(db, id, withTurns));

    const rec = initSessionRecord(srow);
    Object.assign(rec, { acquisitionCoverage });
    const turns = [];
    for (const row of msgRows) processMessageRow(rec, turns, row, { withTurns, partsByMessage });
    if (!withTurns) collectScanToolCounts(db, id, rec);

    if (!rec.title) rec.title = '(untitled)';
    rec.active = activeIntervals(rec.stamps, rec.spans);
    rec.lenSeconds = Math.round(rec.active.reduce((n, [a, b]) => n + (b - a), 0) / 1000);
    delete rec.stamps;
    delete rec.pendingPromptMs;
    delete rec.spans;
    return { session: rec, turns };
  });
  return result.ok ? result.value : null;
}
