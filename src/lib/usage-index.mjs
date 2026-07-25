// usage-index.mjs — an incremental index over the local Claude Code and Codex
// transcript stores (ADR-0009). I/O module; the arithmetic it exposes is pure.
//
//   ~/.claude/projects/<project>/<sessionId>.jsonl
//   ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<sessionId>.jsonl
//
// The corpus is large (1.3 GB on the reference machine) and a finished
// transcript never changes again, so every file is parsed AT MOST ONCE: the
// derived per-session record is cached in ~/.config/agentic-kit/usage-index.json
// keyed by (path, mtime, size). A warm refresh only stats.
//
// Three rules this module exists to enforce:
//   1. Engaged time is the UNION of ACTIVE intervals, never the sum of spans.
//      Summing claimed 21 h/day on the reference corpus (ADR-0009 §4). Two
//      corrections stack here: sessions that overlap in wall-clock are counted
//      once, and a session that sat idle for hours (11 in-window sessions ran
//      over 6 h, the longest 27.4 h) is split at gaps longer than IDLE_GAP_MS
//      so its idle stretch is not billed as engagement. Three tiers result:
//      engagedSeconds <= spanUnionSeconds <= spanMinutes×60.
//   2. A malformed line is skipped, never fatal. One corrupt line must not cost
//      a whole file, and no input may throw out of here.
//   3. Transcripts are opened READ-ONLY and never rewritten.
//
// Cost and category are deliberately NOT cached: prices drift and classifier
// rules change, and both are cheap to recompute from the cached token rows.
// Only the expensive part — parsing — is cached.
//
// pricing/usage-classify/usage-insights are loaded LAZILY and are injectable as
// `deps`. That seam is what lets the scanner be unit-tested against exact
// arithmetic without importing anyone's pricing table or classification policy.
import fs from 'node:fs';
import path from 'node:path';
import { configDir, claudeDir, codexDir } from './paths.mjs';

/** Bump to invalidate every cached entry wholesale.
 *  v2: cached records carry `active` sub-intervals for the idle-gap split.
 *  v3: project is the REPO, with the worktree kept separately — cached v2
 *      records carry the old worktree-as-project labels and must be re-derived. */
export const SCHEMA_VERSION = 3;

/** Silence longer than this ends a stretch of engagement. A session is split
 *  into active sub-intervals at gaps ABOVE this bound (exactly this much is not
 *  a gap), and `engagedSeconds` unions those. Named rather than inline because
 *  it is a judgement call the numbers depend on, not a magic constant. */
export const IDLE_GAP_MS = 15 * 60 * 1000;

const DAY_MS = 86_400_000;
const MAX_TURN_CHARS = 40_000;
/** Largest single transcript readSession will pull into memory. The corpus's
 *  biggest real file is ~18 MB; JSON expansion runs ~5x, so 64 MB caps the
 *  spike near 320 MB instead of unbounded. Above this the session reads as
 *  unavailable rather than risking the panel's process. */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

// ── pure helpers ────────────────────────────────────────────────────────────

/** Milliseconds from an epoch number, Date, or ISO string; NaN when unusable. */
function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

/**
 * Total seconds covered by a set of intervals, counting overlap ONCE.
 * Accepts `[start, end]` tuples or `{ start, end }` objects; each bound may be
 * an epoch number, a Date, or an ISO string. Degenerate or unparseable
 * intervals are dropped rather than throwing. Pure — exported for test.
 */
export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals)) return 0;
  const spans = [];
  for (const iv of intervals) {
    if (!iv) continue;
    const start = toMs(Array.isArray(iv) ? iv[0] : iv.start);
    const end = toMs(Array.isArray(iv) ? iv[1] : iv.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    spans.push([start, end]);
  }
  if (!spans.length) return 0;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = spans[0];
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i];
    if (s <= curEnd) {           // overlapping OR exactly touching → extend
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s; curEnd = e;
    }
  }
  total += curEnd - curStart;
  return Math.round(total / 1000);
}

// Each replacement keeps the human-readable prefix and drops the payload. The
// replacement text cannot re-match its own pattern (the '…' is outside every
// character class), which is what makes masking idempotent.
/** @type {[RegExp, string][]} */
// Order matters. PEM blocks are matched WHOLE and first: a later pattern that
// nibbled at the base64 body would leave the armour behind, which reads as
// "masked" on screen while the key material is still visible.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY----- …redacted -----END PRIVATE KEY-----'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY----- …redacted'],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-…redacted'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'ghp_…redacted'],
  [/\bAKIA[0-9A-Z]{12,}/g, 'AKIA…redacted'],
  [/\bwhsec_[A-Za-z0-9_-]{16,}/g, 'whsec_…redacted'],
  [/\bASIA[0-9A-Z]{12,}/g, 'ASIA…redacted'],          // STS temporary credential
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_…redacted'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'glpat-…redacted'],
  [/\bhf_[A-Za-z0-9]{20,}/g, 'hf_…redacted'],
  [/\bpypi-[A-Za-z0-9_-]{16,}/g, 'pypi-…redacted'],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g, 'sk_live_…redacted'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, 'SG.…redacted'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, 'npm_…redacted'],
  [/\bxox[baprse]-[A-Za-z0-9-]{10,}/g, 'xox…redacted'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza…redacted'],
  // Slack incoming-webhook URLs are bearer credentials in URL form.
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
    'https://hooks.slack.com/services/…redacted'],
  // JWT — three base64url segments. Masked whole; the payload is the sensitive part.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ…redacted'],
  // Inline credentials in a URI (postgres://user:pass@host, https://u:p@h). The
  // USERNAME is deliberately preserved — it is usually needed to identify which
  // system leaked, and it is not the secret.
  [/\b([a-z][a-z0-9+.-]*):\/\/([^\s:@/]+):[^\s@/]+@/g, '$1://$2:…redacted@'],
  [/\b(Basic)\s+[A-Za-z0-9+/]{16,}={0,2}/g, '$1 …redacted'],
  // Case-insensitive on the SCHEME only — `BEARER`/`bearer`/`Bearer` all appear
  // in the wild. The token body stays case-sensitive, so this cannot widen into
  // prose the way an /i on the assignment rule would.
  [/\b([Bb]earer|BEARER)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 …redacted'],
  // Context-carried secrets: SCREAMING_CASE assignments whose NAME says secret.
  // Deliberately case-SENSITIVE: with /i this matches prose like
  // "tokens used = 10028979467", and these transcripts discuss token counts
  // constantly. Uppercase-only tracks the actual env-var convention instead.
  [/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[:=]\s*)("?)[^\s"']{8,}\3/g,
    '$1$2$3…redacted$3'],
];

// NOT masked, deliberately: a bare 40-char base64-ish AWS secret with no prefix
// and no assignment context. It is indistinguishable from a hash, a checksum, or
// a base64 blob in ordinary prose, and masking it would corrupt real transcript
// content. It is caught when it appears as AWS_SECRET_ACCESS_KEY=… above.

/**
 * Mask secret-shaped strings in transcript text (ADR-0009 §8). Idempotent, and
 * a no-op on ordinary prose. Pure — exported for test.
 */
export function maskSecrets(text) {
  if (text === null || text === undefined) return '';
  let out = typeof text === 'string' ? text : String(text);
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
  return out;
}

/** Local calendar day, `YYYY-MM-DD`. Local because "what did I spend today" is
 *  a question about the user's clock, not UTC's. */
function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `dow-hour` punchcard key, local, with Monday as 0. */
function punchKey(ms) {
  const d = new Date(ms);
  return `${(d.getDay() + 6) % 7}-${d.getHours()}`;
}

function clip(text, max = 100) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Directory names that mean "the thing below me is a WORKTREE of the repo above
 * me", not a project of its own. `path.basename(cwd)` on a worktree yields the
 * branch/phase name — so `keel/.autopilot/worktrees/agent-runtime/phase-1`
 * reported a project called `phase-1`, and eight such rows sat beside `keel` in
 * the tree as if they were peer repositories. Every project total was wrong by
 * however much work happened in a worktree.
 */
const WORKTREE_MARKERS = ['.autopilot', '.claude', '.git'];

/**
 * Resolve a session's cwd to `{ project, worktree }`.
 *
 * The worktree name is KEPT, not discarded: "which repo" and "which branch of
 * it" are different questions, and collapsing the second into the first would
 * trade one wrong answer for a lossy one. Pure — exported for test.
 *
 * @param {string|null} cwd Absolute path the session ran in.
 * @param {string|null} [dirName] Encoded ~/.claude/projects dir, used only as a
 *   fallback when the transcript carried no cwd.
 * @returns {{ project: string, worktree: string|null }}
 */
export function projectLabel(cwd, dirName) {
  if (cwd && typeof cwd === 'string') {
    // Split on BOTH separators, not path.sep. On Windows path.sep is '\\', but a
    // transcript's recorded cwd may be POSIX-style (WSL, a synced dotfile, a
    // fixture) — splitting on the host separator alone yields one segment and
    // silently disables worktree detection on that platform.
    const segs = cwd.split(/[\\/]+/).filter(Boolean);

    // <repo>/<marker>/worktrees/<...rest>  →  repo = <repo>, worktree = rest
    for (let i = 1; i < segs.length - 1; i++) {
      if (WORKTREE_MARKERS.includes(segs[i]) && segs[i + 1] === 'worktrees') {
        const rest = segs.slice(i + 2).join('/');
        return { project: segs[i - 1], worktree: rest || null };
      }
    }

    // Claude Code's per-session scratchpad lives under the OS temp dir, not in
    // any repo. It is genuinely not a project, so it gets its own bucket rather
    // than a guessed one — the embedded path segment is `/`-encoded and cannot
    // be decoded unambiguously (a `-` may be a separator or part of a name).
    // Positional indexing is wrong here — the temp root varies (`/tmp/...` vs
    // `/private/tmp/...`), so match the marker segment wherever it lands.
    // `segs` already holds the trailing component, and unlike path.basename() it
    // is separator-agnostic — basename('/a/b') is 'b' on POSIX but the whole
    // string on Windows, which would have made every project label wrong there.
    const base = segs[segs.length - 1];

    if (segs.includes('scratchpad') && segs.some((seg) => /^claude-\d+$/.test(seg))) {
      return { project: 'scratchpad', worktree: base || null };
    }

    if (base && base !== '.') return { project: base, worktree: null };
  }

  if (!dirName) return { project: 'unknown', worktree: null };
  const parts = String(dirName).replace(/^-+/, '').split('-').filter(Boolean);
  return { project: parts.length ? parts[parts.length - 1] : 'unknown', worktree: null };
}

/** Sum a record's per-model usage rows into one API-equivalent cost. */
function sessionCost(rec, deps) {
  let cost = 0;
  for (const row of rec.usage ?? []) {
    cost += deps.costOf({
      model: row.model, provider: rec.provider,
      input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    }) || 0;
  }
  return round(cost);
}

/** Write a projectLabel() result onto a record without losing the worktree. */
function applyProject(rec, res) {
  rec.project = res.project;
  if (res.worktree) rec.worktree = res.worktree;
}

// ── transcript parsing ──────────────────────────────────────────────────────

/** Split JSONL into parsed objects, skipping anything that will not parse. */
function* jsonLines(raw) {
  for (const line of raw.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj && typeof obj === 'object') yield obj;
  }
}

/** A blank per-session record; `usage` rows are (day, model) buckets so byDay
 *  and byModel can both be derived without re-reading the transcript. */
function blankSession(id, provider) {
  return {
    id, provider, title: '', project: 'unknown', start: null, end: null,
    prompts: 0, responses: 0, sidechain: false, models: [], tools: {},
    skill: null, plugin: null, worktree: null, usage: [], punchcard: {}, active: [], stamps: [],
  };
}

function noteSpan(rec, ms) {
  if (!Number.isFinite(ms)) return;
  if (rec.start === null || ms < rec.start) rec.start = ms;
  if (rec.end === null || ms > rec.end) rec.end = ms;
  rec.stamps.push(ms);
}

/**
 * Collapse a session's activity timestamps into the intervals it was actually
 * working, splitting wherever the transcript went quiet for longer than
 * IDLE_GAP_MS. A run of one timestamp yields a zero-length interval and so
 * contributes nothing — an instant has no duration to claim.
 */
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

/** Finish a parsed record: derive active intervals, drop the raw timestamps
 *  (thousands per session, and never needed again once collapsed). */
function seal(rec) {
  rec.active = activeIntervals(rec.stamps);
  delete rec.stamps;
  return rec;
}

function addUsage(rec, day, model, u) {
  let row = rec.usage.find((r) => r.day === day && r.model === model);
  if (!row) { row = { day, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 }; rec.usage.push(row); }
  row.input += u.input; row.output += u.output;
  row.cacheRead += u.cacheRead; row.cacheWrite += u.cacheWrite;
  row.responses += u.responses ?? 0;
}

/** Flatten a Claude content array into display text, dropping binary payloads
 *  (a pasted screenshot is megabytes of base64 nobody wants to render). */
function claudeText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'image') out.push('[image]');
    else if (b.type === 'thinking' && typeof b.thinking === 'string') out.push(b.thinking);
    else if (b.type === 'tool_result') {
      const c = b.content;
      out.push(`[tool result] ${typeof c === 'string' ? c : claudeText(c)}`);
    } else if (b.type === 'tool_use') {
      out.push(`[tool: ${b.name}]`);
    }
  }
  return out.join('\n');
}

/** Is this `user` entry a human prompt, or a tool result being fed back? */
function isHumanPrompt(entry) {
  if (entry.isMeta) return false;
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  const hasResult = content.some((b) => b?.type === 'tool_result');
  const hasText = content.some((b) => b?.type === 'text' && String(b.text ?? '').trim());
  return hasText && !hasResult;
}

/**
 * Parse one Claude transcript. Returns `{ session, turns }`; `turns` is only
 * populated when `withTurns` (the reader path) — the scan path does not need
 * message bodies and holding them would balloon memory over 3,000 files.
 */
function parseClaude(raw, { id, dirName, withTurns = false }) {
  const rec = blankSession(id, 'claude');
  const turns = [];
  let firstPrompt = '';
  let aiTitle = '';

  for (const e of jsonLines(raw)) {
    const ms = toMs(e.timestamp);
    if (e.type === 'ai-title') { if (typeof e.aiTitle === 'string') aiTitle = e.aiTitle; continue; }
    if (typeof e.attributionSkill === 'string' && !rec.skill) rec.skill = e.attributionSkill;
    if (typeof e.attributionPlugin === 'string' && !rec.plugin) rec.plugin = e.attributionPlugin;
    if (e.isSidechain === true) rec.sidechain = true;
    if (rec.project === 'unknown' && typeof e.cwd === 'string') applyProject(rec, projectLabel(e.cwd, dirName));

    if (e.type === 'user') {
      noteSpan(rec, ms);
      const human = isHumanPrompt(e);
      if (human) {
        rec.prompts++;
        if (!firstPrompt) firstPrompt = claudeText(e.message?.content);
      }
      if (withTurns) {
        const text = claudeText(e.message?.content);
        if (text) turns.push({ role: 'user', at: new Date(ms).toISOString(), text, prompt: human });
      }
      continue;
    }

    if (e.type !== 'assistant' || !e.message) continue;
    noteSpan(rec, ms);
    rec.responses++;
    const model = typeof e.message.model === 'string' ? e.message.model : 'unknown';
    if (!rec.models.includes(model)) rec.models.push(model);

    const u = e.message.usage ?? {};
    const at = Number.isFinite(ms) ? ms : (rec.start ?? Date.now());
    addUsage(rec, localDay(at), model, {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheWrite: Number(u.cache_creation_input_tokens) || 0,
      responses: 1,
    });
    const pk = punchKey(at);
    rec.punchcard[pk] = (rec.punchcard[pk] ?? 0) + 1;

    const tools = [];
    for (const b of Array.isArray(e.message.content) ? e.message.content : []) {
      if (b?.type === 'tool_use' && typeof b.name === 'string') {
        tools.push(b.name);
        rec.tools[b.name] = (rec.tools[b.name] ?? 0) + 1;
      }
    }
    if (withTurns) {
      turns.push({
        role: 'assistant', at: new Date(at).toISOString(), model,
        text: claudeText(e.message.content), tools,
      });
    }
  }

  rec.title = maskSecrets(aiTitle || clip(firstPrompt)) || '(untitled)';
  if (rec.project === 'unknown') applyProject(rec, projectLabel(null, dirName));
  return { session: seal(rec), turns };
}

/**
 * Parse one Codex rollout. `total_token_usage` is CUMULATIVE, so the LAST
 * token_count event is the session total — summing them would multiply the
 * figure by the number of turns. `input_tokens` there INCLUDES
 * `cached_input_tokens`, which bill as cache reads, so the two are separated.
 */
function parseCodex(raw, { id, withTurns = false }) {
  const rec = blankSession(id, 'codex');
  const turns = [];
  let lastUsage = null;
  let lastUsageAt = null;
  let firstPrompt = '';

  for (const e of jsonLines(raw)) {
    const ms = toMs(e.timestamp);
    noteSpan(rec, ms);
    const p = e.payload ?? {};

    if (e.type === 'session_meta') {
      if (typeof p.id === 'string' && p.id) rec.id = p.id;
      if (typeof p.cwd === 'string') applyProject(rec, projectLabel(p.cwd, null));
      continue;
    }
    if (e.type === 'turn_context') {
      if (typeof p.model === 'string' && !rec.models.includes(p.model)) rec.models.push(p.model);
      if (rec.project === 'unknown' && typeof p.cwd === 'string') applyProject(rec, projectLabel(p.cwd, null));
      continue;
    }
    if (e.type !== 'event_msg') continue;

    if (p.type === 'token_count') {
      const t = p.info?.total_token_usage;
      if (t && typeof t === 'object') { lastUsage = t; lastUsageAt = ms; }
      continue;
    }
    if (p.type === 'user_message') {
      rec.prompts++;
      const text = typeof p.message === 'string' ? p.message : '';
      if (!firstPrompt) firstPrompt = text;
      if (withTurns && text) turns.push({ role: 'user', at: new Date(ms).toISOString(), text, prompt: true });
      continue;
    }
    if (p.type === 'agent_message') {
      rec.responses++;
      const at = Number.isFinite(ms) ? ms : (rec.start ?? Date.now());
      const pk = punchKey(at);
      rec.punchcard[pk] = (rec.punchcard[pk] ?? 0) + 1;
      if (withTurns) {
        turns.push({
          role: 'assistant', at: new Date(at).toISOString(),
          model: rec.models[rec.models.length - 1] ?? 'unknown',
          text: typeof p.message === 'string' ? p.message : '', tools: [],
        });
      }
    }
  }

  if (lastUsage) {
    const cacheRead = Number(lastUsage.cached_input_tokens) || 0;
    const gross = Number(lastUsage.input_tokens) || 0;
    const at = Number.isFinite(lastUsageAt) ? lastUsageAt : (rec.end ?? rec.start ?? Date.now());
    addUsage(rec, localDay(at), rec.models[rec.models.length - 1] ?? 'unknown', {
      input: Math.max(0, gross - cacheRead),
      output: Number(lastUsage.output_tokens) || 0,
      cacheRead,
      cacheWrite: 0,
    });
  }

  rec.title = maskSecrets(clip(firstPrompt)) || '(untitled)';
  return { session: seal(rec), turns };
}

// ── file discovery ──────────────────────────────────────────────────────────

function readDirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function defaultRoots() {
  return {
    claude: path.join(claudeDir(), 'projects'),
    codex: path.join(codexDir(), 'sessions'),
  };
}

/** Claude transcripts: exactly one level of project directories. */
function listClaude(root) {
  const out = [];
  for (const d of readDirSafe(root)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    for (const f of readDirSafe(dir)) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        out.push({ file: path.join(dir, f.name), provider: 'claude', dirName: d.name, id: f.name.slice(0, -6) });
      }
    }
  }
  return out;
}

/** Codex rollouts: yyyy/mm/dd/rollout-<ts>-<uuid>.jsonl. */
function listCodex(root) {
  const out = [];
  for (const y of readDirSafe(root)) {
    if (!y.isDirectory()) continue;
    for (const m of readDirSafe(path.join(root, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of readDirSafe(path.join(root, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        const dir = path.join(root, y.name, m.name, d.name);
        for (const f of readDirSafe(dir)) {
          if (!f.isFile() || !f.name.startsWith('rollout-') || !f.name.endsWith('.jsonl')) continue;
          out.push({
            file: path.join(dir, f.name), provider: 'codex', dirName: null,
            id: codexIdFromName(f.name),
          });
        }
      }
    }
  }
  return out;
}

/** The id in `rollout-<iso-ts>-<uuid>.jsonl`. The timestamp is itself
 *  dash-separated, so strip it by shape rather than splitting on '-'.
 *  A fallback only: `session_meta.payload.id` is authoritative once parsed. */
function codexIdFromName(name) {
  const stem = name.replace(/^rollout-/, '').replace(/\.jsonl$/, '');
  return stem.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');
}

function parseFile(entry) {
  let raw;
  try { raw = fs.readFileSync(entry.file, 'utf8'); } catch { return null; }
  try {
    return entry.provider === 'codex'
      ? parseCodex(raw, { id: entry.id })
      : parseClaude(raw, { id: entry.id, dirName: entry.dirName });
  } catch {
    return null; // a parser bug must not cost the user their whole index
  }
}

// ── cache ───────────────────────────────────────────────────────────────────

function defaultCachePath() { return path.join(configDir(), 'usage-index.json'); }

function readCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.schemaVersion !== SCHEMA_VERSION || !raw.entries || typeof raw.entries !== 'object') return null;
    return raw;
  } catch { return null; }
}

function writeCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    // 0600, matching the 0600 transcripts this content derives from. `title` is
    // the ai-title, or the first 100 chars of the user's first prompt when there
    // is none — writing that world-readable downgrades the source's permissions.
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on exotic filesystems */ }
  } catch { /* an unwritable cache costs a re-scan, not a failed panel */ }
}

// ── dependency seam ─────────────────────────────────────────────────────────

let _deps = null;
async function loadDeps(override) {
  if (override) return override;
  if (!_deps) {
    const [pricing, classifier, insights] = await Promise.all([
      import('./pricing.mjs'), import('./usage-classify.mjs'), import('./usage-insights.mjs'),
    ]);
    _deps = {
      costOf: pricing.costOf,
      pricesAsOf: pricing.PRICES_AS_OF,
      classify: classifier.classify,
      detectInsights: insights.detectInsights,
    };
  }
  return _deps;
}

// ── aggregation ─────────────────────────────────────────────────────────────

// Buckets are keyed by transcript-derived strings (model ids, project names), so
// a session naming itself `__proto__` would hit Object.prototype's setter: the
// bucket never becomes an own property and vanishes from JSON.stringify, silently
// losing that model's spend. Callers build these maps with Object.create(null);
// this guard keeps the invariant local even if one forgets.
function bucket(map, key) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    map[key] = {
      sessions: 0, responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      tokens: 0, cost: 0,
      // `minutes` and `confidence` are NOT decoration. Three consumers read them
      // and every one of them silently rendered a zero before they existed:
      // project rows showed "0m", every category showed "confidence 0.00" (which
      // ADR-0009 §5 requires be DISPLAYED — a constant 0.00 is worse than
      // omitting it), and high-volume-automation printed "0.0 minutes each"
      // while its evidence asserted "short duration" — a duration claim it never
      // measured, i.e. fabricated evidence under ADR-0009 §6 rule 1.
      minutes: 0,
      confidence: 0,   // session-weighted mean, finalised by sealBuckets()
    };
  }
  return map[key];
}

function addTo(b, s) {
  b.sessions++; b.responses += s.responses;
  b.input += s.input; b.output += s.output;
  b.cacheRead += s.cacheRead; b.cacheWrite += s.cacheWrite;
  b.tokens += s.tokens; b.cost += s.cost;
  b.minutes += Number(s.minutes) || 0;
  // Accumulated as a SUM here and divided by `sessions` in sealBuckets, so the
  // result is a true mean rather than a running average that drifts with order.
  b.confidence += Number(s.confidence) || 0;
}

/** Turn accumulated confidence sums into means. Must run after every addTo. */
function sealBuckets(...maps) {
  for (const map of maps) {
    for (const k of Object.keys(map)) {
      const b = map[k];
      b.confidence = b.sessions ? round(b.confidence / b.sessions, 3) : 0;
      b.minutes = round(b.minutes, 2);
    }
  }
}

const round = (n, p = 6) => Math.round(n * 10 ** p) / 10 ** p;

/** Turn cached per-file records into the Aggregate the UI and detectors read. */
function aggregate(records, { days, now, cutoff, deps }) {
  const sessions = [];
  // Null-prototype: these are keyed by transcript-derived strings (day, model id,
  // provider, project, category), so `__proto__` as a key must be an ordinary
  // bucket, not a prototype write that silently discards the data.
  const byDay = Object.create(null);
  const byModel = Object.create(null);

  for (const rec of records) {
    if (!rec || !rec.responses) continue;                 // no assistant turn → not a session
    if (rec.end === null || rec.end < cutoff) continue;    // outside the window

    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let firstDay = null;
    for (const row of rec.usage) {
      if (firstDay === null || row.day < firstDay) firstDay = row.day;
      const rowCost = deps.costOf({
        model: row.model, provider: rec.provider,
        input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
      }) || 0;
      input += row.input; output += row.output;
      cacheRead += row.cacheRead; cacheWrite += row.cacheWrite;
      cost += rowCost;

      const rowTokens = row.input + row.output + row.cacheRead + row.cacheWrite;
      if (!byDay[row.day]) byDay[row.day] = { tokens: 0, cost: 0, sessions: 0 };
      byDay[row.day].tokens += rowTokens;
      byDay[row.day].cost = round(byDay[row.day].cost + rowCost);
      const m = bucket(byModel, row.model);
      m.responses += row.responses; m.input += row.input; m.output += row.output;
      m.cacheRead += row.cacheRead; m.cacheWrite += row.cacheWrite;
      m.tokens += rowTokens; m.cost = round(m.cost + rowCost);
    }

    const verdict = deps.classify({
      title: rec.title, skill: rec.skill, plugin: rec.plugin,
      tools: rec.tools, prompts: rec.prompts, responses: rec.responses,
    }) ?? {};

    sessions.push({
      id: rec.id, provider: rec.provider, title: rec.title, project: rec.project,
      worktree: rec.worktree ?? null,
      start: new Date(rec.start ?? rec.end).toISOString(),
      minutes: Math.round(((rec.end - (rec.start ?? rec.end)) / 60_000) * 10) / 10,
      prompts: rec.prompts, responses: rec.responses, sidechain: rec.sidechain,
      models: rec.models.slice(),
      input, output, cacheRead, cacheWrite,
      tokens: input + output + cacheRead + cacheWrite,
      cost: round(cost),
      tools: { ...rec.tools },
      category: verdict.category ?? 'Unclassified',
      confidence: verdict.confidence ?? 0,
      basis: verdict.basis ?? 'no signal',
      skill: rec.skill, plugin: rec.plugin,
      _span: [rec.start ?? rec.end, rec.end],
      // Pre-v2 cache entries have no `active`; fall back to the whole span so a
      // stale record degrades to the old figure instead of vanishing.
      _active: Array.isArray(rec.active) && rec.active.length ? rec.active : [[rec.start ?? rec.end, rec.end]],
      _punchcard: rec.punchcard,
      // The day this session's tokens FIRST landed on — always a key of byDay,
      // which keeps sum(byDay.sessions) === totals.sessions. Its start day is
      // not usable: a session can open at 23:58 and only bill after midnight.
      _day: firstDay,
    });
  }

  sessions.sort((a, b) => b.cost - a.cost || Date.parse(b.start) - Date.parse(a.start));

  const totals = {
    sessions: sessions.length, responses: 0, input: 0, output: 0,
    cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0,
    spanMinutes: 0, spanUnionSeconds: 0, engagedSeconds: 0,
  };
  const byProvider = Object.create(null), byProject = Object.create(null);
  const byCategory = Object.create(null), punchcard = Object.create(null);
  const tree = new Map();
  let spanMs = 0;

  for (const s of sessions) {
    totals.responses += s.responses; totals.input += s.input; totals.output += s.output;
    totals.cacheRead += s.cacheRead; totals.cacheWrite += s.cacheWrite;
    totals.tokens += s.tokens; totals.cost += s.cost;
    spanMs += s._span[1] - s._span[0];

    addTo(bucket(byProvider, s.provider), s);
    addTo(bucket(byProject, s.project), s);
    addTo(bucket(byCategory, s.category), s);
    // A session that used two models counts once under EACH — the token and
    // cost columns already partition cleanly, session counts cannot.
    // byModel previously got a bare sessions++ while the other three ran addTo,
    // so it was the same TYPE with different FIELDS filled — the shape looked
    // uniform and was not. Accumulate minutes/confidence here too.
    for (const model of s.models) {
      const b = bucket(byModel, model);
      b.sessions++;
      b.minutes += Number(s.minutes) || 0;
      b.confidence += Number(s.confidence) || 0;
    }
    if (s._day && byDay[s._day]) byDay[s._day].sessions++;
    for (const [k, n] of Object.entries(s._punchcard)) punchcard[k] = (punchcard[k] ?? 0) + n;

    if (!tree.has(s.project)) tree.set(s.project, { project: s.project, sessions: 0, cost: 0, tokens: 0, minutes: 0, cats: new Map(), rows: [] });
    const node = tree.get(s.project);
    node.sessions++; node.cost = round(node.cost + s.cost); node.tokens += s.tokens;
    node.minutes = Math.round((node.minutes + s.minutes) * 10) / 10;
    const cat = node.cats.get(s.category) ?? { category: s.category, sessions: 0, cost: 0 };
    cat.sessions++; cat.cost = round(cat.cost + s.cost);
    node.cats.set(s.category, cat);
    node.rows.push(s);
  }

  totals.cost = round(totals.cost);
  // Three tiers, each honest about a different thing:
  //   engagedSeconds   — union of ACTIVE intervals: time actually worked
  //   spanUnionSeconds — union of whole spans: wall-clock with a session open
  //   spanMinutes      — sum of spans: the double-counting figure, kept as the
  //                      clearly-labelled secondary the ADR asks the UI to show
  sealBuckets(byProvider, byProject, byCategory, byModel);

  totals.spanMinutes = Math.round((spanMs / 60_000) * 10) / 10;
  totals.spanUnionSeconds = mergeIntervals(sessions.map((s) => s._span));
  totals.engagedSeconds = mergeIntervals(sessions.flatMap((s) => s._active));

  const projectTree = [...tree.values()]
    .map((n) => ({
      project: n.project, sessions: n.sessions, cost: n.cost, tokens: n.tokens, minutes: n.minutes,
      categories: [...n.cats.values()].sort((a, b) => b.cost - a.cost || b.sessions - a.sessions),
      rows: n.rows,
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  for (const s of sessions) { delete s._span; delete s._active; delete s._punchcard; delete s._day; }

  const agg = {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    pricesAsOf: deps.pricesAsOf ?? null,
    totals, byDay, byModel, byProvider, byProject, byCategory,
    punchcard, projectTree, sessions, insights: [],
  };
  agg.insights = deps.detectInsights(agg) ?? [];
  return agg;
}

// ── build ───────────────────────────────────────────────────────────────────

// Single-flight is keyed by the options that change the RESULT, not global.
// A bare `if (_inflight) return _inflight` handed a ?days=365 caller whatever
// scan happened to be running — usually the 14-day one — and readIndex then
// memoised that answer under the 365 key. Coalescing is only sound between
// callers who asked the same question.
/** @type {Map<string, Promise<any>>} */
const _inflight = new Map();
let _memo = null;

/** Identity of a scan: two calls sharing it must produce the same aggregate. */
function scanKey(o = {}) {
  const r = o.roots || {};
  return JSON.stringify([Number(o.days) || 14, !!o.force, r.claude || '', r.codex || '', o.cachePath || '']);
}

/** Drop process-level state (single-flight promises, read memo, lazy deps). */
export function _resetForTest() { _inflight.clear(); _memo = null; _deps = null; }

function notify(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(payload); } catch { /* the UI's problem, not the scan's */ }
}

/**
 * @typedef {object} IndexOptions
 * @property {number} [days]        window size in days (default 14)
 * @property {boolean} [force]      ignore cached per-file entries
 * @property {Function} [onProgress] called with { scanned, total, phase }
 * @property {{claude?: string, codex?: string}} [roots] override transcript roots (tests)
 * @property {string} [cachePath]   override the index cache location (tests)
 * @property {number} [now]         override "now" (tests)
 * @property {number} [maxAgeMs]    readIndex only: memo TTL
 * @property {{costOf: Function, pricesAsOf?: string, classify: Function, detectInsights: Function}} [deps]
 *           inject the pricing/classification/insights seam (tests)
 */

/**
 * Scan both transcript stores and return the Aggregate for the last `days`.
 * Single-flight: a call made while a scan is running joins that scan.
 *
 * @param {IndexOptions} [o]
 */
export async function buildIndex(o = {}) {
  const key = scanKey(o);
  const running = _inflight.get(key);
  if (running) return running;
  const p = (async () => scan(o))();
  _inflight.set(key, p);
  try { return await p; } finally { _inflight.delete(key); }
}

/** @param {IndexOptions} [o] */
async function scan(o = {}) {
  const {
    days = 14, force = false, onProgress, roots, cachePath, now = Date.now(), deps: injected,
  } = o;
  const deps = await loadDeps(injected);
  const r = { ...defaultRoots(), ...(roots ?? {}) };
  const cacheFile = cachePath ?? defaultCachePath();
  const cutoff = now - days * DAY_MS;

  const candidates = [...listClaude(r.claude), ...listCodex(r.codex)]
    .map((e) => ({ ...e, stat: statSafe(e.file) }))
    .filter((e) => e.stat && e.stat.mtimeMs >= cutoff);

  const cache = force ? null : readCache(cacheFile);
  const entries = {};
  const records = [];
  const total = candidates.length;
  let scanned = 0;

  notify(onProgress, { scanned: 0, total, phase: 'scan' });
  for (const c of candidates) {
    const key = { mtime: c.stat.mtimeMs, size: c.stat.size };
    const hit = cache?.entries?.[c.file];
    let session = (hit && hit.mtime === key.mtime && hit.size === key.size) ? hit.session : null;
    if (!session) {
      const parsed = parseFile(c);
      session = parsed ? parsed.session : null;
    }
    if (session) {
      entries[c.file] = { ...key, session };
      records.push(session);
    }
    scanned++;
    if (scanned % 100 === 0) notify(onProgress, { scanned, total, phase: 'scan' });
  }

  // Carry forward cached entries outside the window whose file still exists, so
  // widening the window later does not force a full re-parse.
  if (cache?.entries) {
    for (const [file, e] of Object.entries(cache.entries)) {
      if (entries[file] || !e?.session) continue;
      if (statSafe(file)) entries[file] = e;
    }
  }
  writeCache(cacheFile, { schemaVersion: SCHEMA_VERSION, updatedAt: new Date(now).toISOString(), entries });
  notify(onProgress, { scanned: total, total, phase: 'aggregate' });

  return aggregate(records, { days, now, cutoff, deps });
}

/**
 * The Aggregate, memoized in-process and refreshed when stale. This is the
 * dashboard's read path — `maxAgeMs` (default 15 s) bounds how often a poll can
 * trigger a re-stat of the corpus.
 *
 * @param {IndexOptions} [o]
 */
export async function readIndex(o = {}) {
  const { days = 14, maxAgeMs = 15_000, now = Date.now() } = o;
  const key = JSON.stringify([days, o.roots ?? null, o.cachePath ?? null]);
  if (_memo && _memo.key === key && now - _memo.at < maxAgeMs) return _memo.agg;
  const agg = await buildIndex({ ...o, days });
  _memo = { key, at: now, agg };
  return agg;
}

// ── single-session read ─────────────────────────────────────────────────────

function invalidId(id) {
  const err = new Error(`invalid session id: ${JSON.stringify(String(id))}`);
  // @ts-expect-error — a code tag is how the server maps this to a 400
  err.code = 'ERR_INVALID_SESSION_ID';
  return err;
}

/** Resolve an id to exactly one transcript file. Consults the index cache
 *  first; otherwise matches on FILE NAMES only — never opens a transcript it is
 *  not going to return. */
function locate(id, r, cacheFile) {
  const cache = readCache(cacheFile);
  for (const [file, e] of Object.entries(cache?.entries ?? {})) {
    if (e?.session?.id !== id) continue;
    if (!statSafe(file)) continue;
    const provider = e.session.provider === 'codex' ? 'codex' : 'claude';
    return { file, provider, id, dirName: provider === 'claude' ? path.basename(path.dirname(file)) : null };
  }

  for (const d of readDirSafe(r.claude)) {
    if (!d.isDirectory()) continue;
    const file = path.join(r.claude, d.name, `${id}.jsonl`);
    if (statSafe(file)) return { file, provider: 'claude', id, dirName: d.name };
  }

  for (const y of readDirSafe(r.codex)) {
    if (!y.isDirectory()) continue;
    for (const m of readDirSafe(path.join(r.codex, y.name))) {
      if (!m.isDirectory()) continue;
      for (const day of readDirSafe(path.join(r.codex, y.name, m.name))) {
        if (!day.isDirectory()) continue;
        const dir = path.join(r.codex, y.name, m.name, day.name);
        for (const f of readDirSafe(dir)) {
          if (!f.isFile() || !f.name.startsWith('rollout-') || !f.name.endsWith('.jsonl')) continue;
          if (codexIdFromName(f.name) === id) return { file: path.join(dir, f.name), provider: 'codex', id, dirName: null };
        }
      }
    }
  }
  return null;
}

/**
 * Read ONE session by id — never a corpus scan. Returns `{ meta, turns }` with
 * every text body run through `maskSecrets`, or `null` when no such session.
 * Throws `ERR_INVALID_SESSION_ID` for an id that fails the id grammar (the
 * path-traversal guard), before any filesystem access.
 *
 * @param {string} id
 * @param {IndexOptions} [o]
 */
export async function readSession(id, o = {}) {
  if (typeof id !== 'string' || !VALID_ID.test(id)) throw invalidId(id);
  const r = { ...defaultRoots(), ...(o.roots ?? {}) };
  const found = locate(id, r, o.cachePath ?? defaultCachePath());
  if (!found) return null;

  // Belt and braces: the resolved file must live under a transcript root.
  // Containment must be checked against the REAL path, not the lexical one.
  // path.resolve() does not follow symlinks, so a symlink planted inside a
  // transcript root (`ln -s /etc/anything ~/.claude/projects/p/x.jsonl`) passes
  // a startsWith() test while reading a file outside both roots. realpathSync
  // collapses the link first; the roots are realpath'd too so a symlinked root
  // (a common dotfiles setup) still matches rather than locking the user out.
  let real;
  try { real = fs.realpathSync(found.file); } catch { return null; }
  const inRoot = [r.claude, r.codex].some((root) => {
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
    return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
  });
  if (!inRoot) return null;

  // Refuse absurd files rather than pulling them into memory. A transcript is
  // read whole and JSON-expanded at roughly 5x, so an unbounded read is a
  // memory-amplification primitive — especially combined with a symlink.
  try {
    const { size } = fs.statSync(real);
    if (size > MAX_SESSION_BYTES) return null;
  } catch { return null; }

  let raw;
  try { raw = fs.readFileSync(real, 'utf8'); } catch { return null; }

  let parsed;
  try {
    parsed = found.provider === 'codex'
      ? parseCodex(raw, { id, withTurns: true })
      : parseClaude(raw, { id, dirName: found.dirName, withTurns: true });
  } catch { return null; }

  const rec = parsed.session;
  const usage = rec.usage.reduce((a, row) => ({
    input: a.input + row.input, output: a.output + row.output,
    cacheRead: a.cacheRead + row.cacheRead, cacheWrite: a.cacheWrite + row.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  return {
    meta: {
      id: rec.id, provider: rec.provider, title: rec.title, project: rec.project,
      worktree: rec.worktree ?? null,
      start: rec.start === null ? null : new Date(rec.start).toISOString(),
      end: rec.end === null ? null : new Date(rec.end).toISOString(),
      minutes: rec.start === null ? 0 : Math.round(((rec.end - rec.start) / 60_000) * 10) / 10,
      prompts: rec.prompts, responses: rec.responses, sidechain: rec.sidechain,
      models: rec.models.slice(), tools: { ...rec.tools },
      skill: rec.skill, plugin: rec.plugin,
      // Priced here from the same per-model rows aggregate() uses, rather than
      // left undefined: the transcript header rendered a hardcoded "$0.00" on a
      // panel whose whole subject is cost. `.filter(Boolean)` could not drop it
      // because fmtUsd(undefined) is the truthy string "$0.00".
      cost: sessionCost(rec, await loadDeps(o.deps)),
      ...usage, tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    },
    // ADR-0009 §8: truncation is the other way content is withheld, and it used
    // to be silent — `truncated` was set and the renderer ignored it, so an
    // abridged turn read as a complete one. Both keys are emitted only when the
    // slice actually fired, so the field's *presence* is the signal and a whole
    // turn cannot be misread as an abridged one. `originalChars` is measured
    // after `maskSecrets`, so it describes loss due to truncation alone — it is
    // not a raw-file length, and must not be rendered as one.
    turns: parsed.turns.map((t) => {
      const text = maskSecrets(t.text);
      const originalChars = text.length;
      if (originalChars <= MAX_TURN_CHARS) return { ...t, text };
      return {
        ...t,
        text: `${text.slice(0, MAX_TURN_CHARS)}\n…[truncated]`,
        truncated: true,
        originalChars,
      };
    }),
  };
}
