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

/** Incremental candidates: sessions whose latest message lands at/after
 *  cutoffMs. `mtimeMs` (latest message time) + `size` (message count) are the
 *  cache key — a warm refresh re-parses only sessions that gained messages.
 *  @param {{ dbFile: string, cutoffMs?: number }} opts */
export function listSessions({ dbFile, cutoffMs = 0 }) {
  return withDb(dbFile, (db) => db.prepare(`
    SELECT s.id AS id, COALESCE(MAX(m.time_created), s.time_created) AS mtime,
           COUNT(m.id) AS messages
    FROM session s LEFT JOIN message m ON m.session_id = s.id
    GROUP BY s.id
    HAVING mtime >= ?
    ORDER BY mtime DESC
  `).all(cutoffMs).map((r) => ({ id: r.id, mtimeMs: num(r.mtime), size: num(r.messages) })), []);
}

/** Carry-forward existence probe (a session can be deleted between scans). */
export function sessionExists({ dbFile, id }) {
  return withDb(dbFile, (db) => !!db.prepare('SELECT 1 FROM session WHERE id = ?').get(id), false);
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

/** Parse ONE opencode session into the index's per-session record shape.
 *  Returns { session, turns } mirroring parseClaude/parseCodex exactly;
 *  null when the session is gone or unreadable. withTurns emits the
 *  transcript-view turn rows alongside the record.
 *  @param {{ dbFile: string, id: string, withTurns?: boolean }} opts */
export function parseSession({ dbFile, id, withTurns = false }) {
  return withDb(dbFile, (db) => {
    const srow = db.prepare('SELECT * FROM session WHERE id = ?').get(id);
    if (!srow) return null;
    const msgRows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC').all(id);
    const partRows = withTurns
      ? db.prepare(`
          SELECT p.message_id AS message_id, p.data AS data
          FROM part p JOIN message m ON m.id = p.message_id
          WHERE m.session_id = ? ORDER BY p.rowid ASC
        `).all(id)
      : [];
    const partsByMessage = new Map();
    for (const p of partRows) {
      const data = parseJson(p.data);
      if (!data) continue;
      if (!partsByMessage.has(p.message_id)) partsByMessage.set(p.message_id, []);
      partsByMessage.get(p.message_id).push(data);
    }

    const { project, worktree } = projectFromDirectory(srow.directory);
    const rec = {
      id: srow.id, provider: 'opencode', host: 'opencode',
      inferenceProvider: null, providerProvenance: 'unknown',
      title: clip(srow.title) || '(untitled)', project, start: null, end: null,
      prompts: 0, responses: 0, exceptions: 0, sidechain: !!srow.parent_id,
      threadSource: srow.parent_id ? 'subagent' : null,
      models: [], tools: {}, skill: null, plugin: null,
      worktree: worktree ?? null, usage: [], punchcard: {}, active: [], stamps: [],
      reasoningOutput: 0, rateLimits: null,
    };
    if (worktree) rec.worktree = worktree;
    const turns = [];
    let lastProviderId = null;

    for (const row of msgRows) {
      const data = parseJson(row.data);
      if (!data || typeof data.role !== 'string') continue; // malformed row: skipped, never fatal
      const at = num(data.time?.created) || num(row.time_created);
      if (at) { rec.stamps.push(at); if (rec.start === null || at < rec.start) rec.start = at; if (rec.end === null || at > rec.end) rec.end = at; }

      if (data.role === 'user') {
        rec.prompts++;
        if (withTurns) {
          const text = (partsByMessage.get(row.id) ?? [])
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text).join('\n');
          turns.push({ role: 'user', at: new Date(at).toISOString(), text, prompt: true, kind: 'prompt' });
        }
        continue;
      }
      if (data.role !== 'assistant') continue;

      rec.responses++;
      if (at) { const pk = punchKey(at); rec.punchcard[pk] = (rec.punchcard[pk] ?? 0) + 1; }
      const model = typeof data.modelID === 'string' && data.modelID ? data.modelID : 'unknown';
      if (!rec.models.includes(model)) rec.models.push(model);
      if (typeof data.providerID === 'string' && data.providerID) lastProviderId = data.providerID;

      const t = data.tokens ?? {};
      const cache = t.cache ?? {};
      const day = localDay(at || Date.now());
      let usageRow = rec.usage.find((r) => r.day === day && r.model === model);
      if (!usageRow) {
        usageRow = { day, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0, costObserved: null };
        rec.usage.push(usageRow);
      }
      usageRow.input += num(t.input);
      usageRow.output += num(t.output);
      usageRow.cacheRead += num(cache.read);
      usageRow.cacheWrite += num(cache.write);
      usageRow.responses += 1;
      // opencode's OWN metered cost for this message — observed truth, summed
      // per (day, model) row. Rows where NO message carried a cost stay null,
      // so the aggregate falls back to the pricing table rather than
      // misreporting a fabricated $0.
      if (Number.isFinite(Number(data.cost))) usageRow.costObserved = (usageRow.costObserved ?? 0) + Number(data.cost);
      rec.reasoningOutput += num(t.reasoning);

      if (withTurns) {
        const parts = partsByMessage.get(row.id) ?? [];
        const tools = parts.filter((p) => p.type === 'tool' && typeof p.tool === 'string').map((p) => p.tool);
        for (const name of tools) rec.tools[name] = (rec.tools[name] ?? 0) + 1;
        const text = parts
          .filter((p) => (p.type === 'text' || p.type === 'reasoning') && typeof p.text === 'string')
          .map((p) => p.text).join('\n');
        turns.push({ role: 'assistant', at: new Date(at).toISOString(), model, text, tools });
      }
    }

    // Tool counts without the full turn payload: one lean query on the scan path.
    if (!withTurns) {
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

    if (lastProviderId) { rec.inferenceProvider = lastProviderId; rec.providerProvenance = 'observed'; }
    if (!rec.title) rec.title = '(untitled)';
    rec.active = activeIntervals(rec.stamps);
    delete rec.stamps;
    return { session: rec, turns };
  }, null);
}
