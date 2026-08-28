// usage-parsers.mjs — the per-vendor transcript parsers for the usage index
// (ADR-0009): `parseClaude`/`parseCodex` turn one raw JSONL transcript into
// the shared per-session record shape (`blankSession`/`addUsage`), consuming
// telemetry-records.mjs's decoded records for wire-format knowledge. Also
// home to the cwd→project resolution (`projectLabel`) those two parsers
// share. Aggregation (turning many parsed records into the Aggregate) is a
// separate concern — see usage-aggregate.mjs, which this module imports
// `toMs`/`maskSecrets` from to keep that dependency one-directional.
//
// A malformed line is skipped, never fatal — one corrupt line must not cost
// a whole file, and no input here may throw.
import { repoRoot } from './paths.mjs';
import { MAX_TELEMETRY_UNKNOWN_KINDS } from './usage-telemetry.mjs';
import { decodeClaudeRecord, decodeCodexRecord } from './telemetry-records.mjs';
import { toMs, maskSecrets } from './usage-aggregate.mjs';
import { normalizeMode } from './usage-modes.mjs';

/** Silence longer than this ends a stretch of engagement. A session is split
 *  into active sub-intervals at gaps ABOVE this bound (exactly this much is not
 *  a gap), and `engagedSeconds` unions those. Named rather than inline because
 *  it is a judgement call the numbers depend on, not a magic constant. */
export const IDLE_GAP_MS = 15 * 60 * 1000;

// ── pure helpers ────────────────────────────────────────────────────────────

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
 * A session run in a SUB-DIRECTORY of a repo is the same problem the worktree
 * markers above solve, reached by a different path shape: `emailibrium/backend`
 * reports a project called `backend`, which then sits beside `emailibrium` as
 * if it were a peer repository. The markers cannot catch it because there is no
 * marker segment to match — only the repository boundary distinguishes them. So
 * the caller may supply `repoRoot`, and when it does, the repo becomes the
 * project and the sub-path takes the worktree slot ("which branch/part of it"),
 * exactly as a real worktree does.
 *
 * `repoRoot` is a PARAMETER rather than a lookup because resolving it is a
 * filesystem walk and this function is pure and called once per session; the
 * index resolves it once per distinct cwd and passes it in.
 *
 * @param {string|null} cwd Absolute path the session ran in.
 * @param {string|null} [dirName] Encoded ~/.claude/projects dir, used only as a
 *   fallback when the transcript carried no cwd.
 * @param {string|null} [repoRoot] The repository root containing `cwd`, when known.
 * @returns {{ project: string, worktree: string|null }}
 */
export function projectLabel(cwd, dirName, repoRoot) {
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

    // A sub-directory of a known repo is that repo, not a peer of it. Compared
    // on split segments rather than string prefixes so `/a/repo-two` is never
    // read as living inside `/a/repo`.
    if (repoRoot && typeof repoRoot === 'string') {
      const rootSegs = repoRoot.split(/[\\/]+/).filter(Boolean);
      const inside = rootSegs.length < segs.length
        && rootSegs.every((seg, i) => segs[i] === seg);
      if (inside) {
        return { project: rootSegs[rootSegs.length - 1], worktree: segs.slice(rootSegs.length).join('/') || null };
      }
    }

    if (base && base !== '.') return { project: base, worktree: null };
  }

  if (!dirName) return { project: 'unknown', worktree: null };
  const parts = String(dirName).replace(/^-+/, '').split('-').filter(Boolean);
  return { project: parts.length ? parts[parts.length - 1] : 'unknown', worktree: null };
}

/** Repo root for a cwd, memoized for the life of one index build.
 *
 *  Indexing walks thousands of sessions but only tens of distinct working
 *  directories, so the filesystem walk is paid once per directory rather than
 *  once per session. A cwd outside any repo memoizes `null` — a miss is as
 *  worth caching as a hit, and `null` then leaves projectLabel on its existing
 *  basename path. */
function repoRootMemo(resolve = repoRoot) {
  const cache = new Map();
  return (cwd) => {
    if (typeof cwd !== 'string' || !cwd) return null;
    if (!cache.has(cwd)) {
      let root;
      try { root = resolve(cwd); } catch { root = null; }
      cache.set(cwd, root ?? null);
    }
    return cache.get(cwd);
  };
}

/** Module-scoped because the parse functions are called per session from
 *  several entry points and threading a cache through all of them would add a
 *  parameter to each for no behavioural gain. Safe to share: a repository root
 *  does not move while a process runs, and the key space is the machine's
 *  distinct working directories (tens), not its sessions (thousands). */
const repoRootOf = repoRootMemo();

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
 *  and byModel can both be derived without re-reading the transcript. Exported
 *  so other transcript-source parsers (usage-opencode.mjs) build the SAME
 *  record shape instead of hand-mirroring it. */
export function blankSession(id, provider) {
  return {
    id, provider, host: provider, inferenceProvider: null, providerProvenance: 'unknown',
    title: '', project: 'unknown', start: null, end: null,
    prompts: 0, responses: 0, exceptions: 0, sidechain: false, threadSource: null, models: [], tools: {},
    skill: null, plugin: null, worktree: null, usage: [], punchcard: {}, active: [], stamps: [],
    // Codex-only detail (v6): reasoning tokens inside output, and the last
    // rate-limit snapshot the rollout carried. Claude sessions keep the zero
    // and the null — absent, not unknown.
    reasoningOutput: 0, rateLimits: null,
    // v11: cross-host permission posture (usage-modes.normalizeMode), a
    // response-latency histogram, THIS session's own engaged seconds, model
    // context-window detail, and codex's explicit-abort count. Every field
    // here defaults honest-absent (null/0) until a parser observes evidence
    // for it — never a guess.
    mode: null, modeRaw: null,
    latHist: null, latCount: 0,
    lenSeconds: 0,
    ctxWindow: null, ctxLastTokens: null,
    aborts: 0,
  };
}

/** Response-latency histogram edges, in seconds; the 6th bucket (index 5)
 *  catches everything over 60s. */
export const LAT_BUCKET_EDGES = [2, 5, 10, 30, 60];
/** Session-length histogram edges, in seconds; the 5th bucket (index 4)
 *  catches everything over 2h. */
export const LEN_BUCKET_EDGES = [300, 900, 2700, 7200];

/** First bucket `i` whose edge `v` does not exceed, else the overflow bucket
 *  (`edges.length`). Shared by every histogram built from these edges, so a
 *  bucket boundary is defined in exactly one place. */
export function bucketIndex(edges, v) {
  for (let i = 0; i < edges.length; i++) if (v <= edges[i]) return i;
  return edges.length;
}

/** Record one response-latency sample onto `rec.latHist`, allocating the
 *  histogram lazily so a session that never observes a latency (older
 *  transcripts, a source that carries no turn timing) keeps `latHist` null —
 *  absent, not a fabricated all-zero histogram. */
export function noteLatencySample(rec, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  rec.latHist ??= new Array(LAT_BUCKET_EDGES.length + 1).fill(0);
  rec.latHist[bucketIndex(LAT_BUCKET_EDGES, seconds)]++;
  rec.latCount++;
}

/** A prompt-to-response gap longer than this is an idle resume (the person
 *  walked away and came back), not a real wait for a reply — so it is
 *  excluded from latency sampling entirely, rather than merely landing in
 *  noteLatencySample's own overflow bucket alongside genuinely slow turns. */
const MAX_LATENCY_SAMPLE_SECONDS = 3600;

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

/** Finish a parsed record: derive active intervals and this session's own
 *  engaged seconds from them, then drop the raw timestamps (thousands per
 *  session, and never needed again once collapsed). */
function seal(rec) {
  rec.active = activeIntervals(rec.stamps);
  rec.lenSeconds = Math.round(rec.active.reduce((n, [a, b]) => n + (b - a), 0) / 1000);
  delete rec.stamps;
  return rec;
}

/** Add usage to a session's (day, model) bucket, creating it on first touch.
 *  Returns the row so a caller with a per-source extra field (opencode's
 *  observed `costObserved`) can set it without a second find(). Exported for
 *  the same reason as blankSession — one definition of "how a usage row
 *  accumulates", shared across transcript-source parsers. */
export function addUsage(rec, day, model, u) {
  let row = rec.usage.find((r) => r.day === day && r.model === model);
  if (!row) { row = { day, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 }; rec.usage.push(row); }
  row.input += u.input; row.output += u.output;
  row.cacheRead += u.cacheRead; row.cacheWrite += u.cacheWrite;
  row.responses += u.responses ?? 0;
  return row;
}

/**
 * Harness-output envelopes: user-role entries whose text the HARNESS wrote —
 * background-task notifications, command stdout/stderr dumps, local-command
 * caveats. They carry neither `isMeta` nor a tool_result block, so text shape
 * is the only signal. Measured on the real corpus (envelope at start of user
 * text): task-notification 550, bash-stdout 85, local-command-stdout 60,
 * local-command-caveat 183; the stderr variants are the symmetric error-path
 * siblings. NOT here: bash-input (the person typed that `! cmd`) and the
 * command-name/-message/-args triple (the person invoked that slash command).
 */
const HARNESS_OUTPUT_RE = /^\s*<(task-notification|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat)>/;

function entryText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const t = content.find((b) => b?.type === 'text' && typeof b.text === 'string');
  return t ? t.text : '';
}

/** Is this `user` entry a human prompt, or harness output being fed back? */
function isHumanPrompt(entry) {
  if (entry.isMeta) return false;
  if (HARNESS_OUTPUT_RE.test(entryText(entry))) return false;
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  const hasResult = content.some((b) => b?.type === 'tool_result');
  const hasText = content.some((b) => b?.type === 'text' && String(b.text ?? '').trim());
  return hasText && !hasResult;
}

/**
 * What KIND of `user`-role turn is this, for transcript attribution? The
 * Messages API records tool results and harness context injections under
 * `role: "user"`, so role alone must never be read as "the human typed this":
 *   'tool-result' — carries a tool_result block: output the HARNESS fed back
 *                   to the model after a tool call.
 *   'context'     — isMeta OR a harness-output envelope (task notifications,
 *                   command stdout/stderr, caveats): harness-injected, not
 *                   typed by the person — and not the model either.
 *   'prompt'      — the human. Deliberately broader than isHumanPrompt():
 *                   an image-only paste has no text block (so it is not
 *                   COUNTED as a prompt) but it IS the person acting, and
 *                   labeling it "tool result" would misattribute it. Also
 *                   covers bash-input (`! cmd`) and slash-command records —
 *                   the person initiated those.
 */
function userTurnKind(entry) {
  const content = entry?.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return 'tool-result';
  if (entry.isMeta || HARNESS_OUTPUT_RE.test(entryText(entry))) return 'context';
  return 'prompt';
}

/** A `user`-role Claude entry: span/prompt-count bookkeeping, plus its turn
 *  row when withTurns. `titleState.firstPrompt` is set from the first HUMAN
 *  prompt whose text is non-empty (mutated in place: later entries only fill
 *  it in while it is still empty). A human prompt also opens the latency
 *  window (`latState.pendingMs`, closed by the next real assistant turn) and
 *  is the only place `permissionMode` is read — a tool-result or harness-
 *  injected "user" entry never carries the human's own posture. */
function recordClaudeUserTurn(rec, turns, titleState, latState, e, ms, decoded, withTurns) {
  noteSpan(rec, ms);
  const human = isHumanPrompt(e);
  if (human) {
    rec.prompts++;
    if (!titleState.firstPrompt) titleState.firstPrompt = decoded.text;
    latState.pendingMs = ms;
    const m = normalizeMode({ host: 'claude', permissionMode: e.permissionMode });
    if (m.raw) { rec.mode = m.mode; rec.modeRaw = m.raw; }
  }
  if (withTurns && decoded.text) {
    turns.push({ role: 'user', at: new Date(ms).toISOString(), text: decoded.text, prompt: human, kind: userTurnKind(e) });
  }
}

/** tool_use blocks → their names, both as a turn-row list and tallied onto
 *  `rec.tools`. */
function collectClaudeToolNames(rec, toolUses) {
  const tools = [];
  for (const use of toolUses) {
    if (typeof use.name === 'string') {
      tools.push(use.name);
      rec.tools[use.name] = (rec.tools[use.name] ?? 0) + 1;
    }
  }
  return tools;
}

/** An `assistant`-role Claude entry (caller has already confirmed `e.message`
 *  exists): span/response-count bookkeeping, the API-error placeholder path,
 *  and otherwise latency/model/usage/tool accounting plus its turn row. */
function recordClaudeAssistantTurn(rec, turns, latState, ms, decoded, withTurns) {
  noteSpan(rec, ms);
  rec.responses++;
  const at = Number.isFinite(ms) ? ms : (rec.start ?? Date.now());
  const pk = punchKey(at);
  rec.punchcard[pk] = (rec.punchcard[pk] ?? 0) + 1;

  // A dropped connection, rate limit, or auth failure makes Claude Code
  // synthesize a local placeholder turn (model: "<synthetic>",
  // isApiErrorMessage: true) with no real completion behind it — usage is
  // always zero. It IS real engaged time (counted above), but it is not a
  // model attempt: excluded from `models`/cost attribution so it can never
  // appear as a $0 "model in play," and counted instead as an EXCEPTION so
  // it stays visible rather than silently vanishing. isApiErrorMessage isn't
  // reliably set on every build that emits this placeholder, so the literal
  // model marker is checked directly too — it's the one part of the shape
  // that's never varied in observed transcripts. A dropped request is also
  // never a latency SAMPLE — `latState.pendingMs` is deliberately left set so
  // the FIRST real completion that eventually follows is what gets timed.
  if (decoded.isApiError) {
    rec.exceptions++;
    if (withTurns) {
      turns.push({
        role: 'assistant', at: new Date(at).toISOString(), model: 'exception',
        text: decoded.text, tools: [], exception: true,
      });
    }
    return;
  }

  if (latState.pendingMs !== null) {
    const gapSeconds = (ms - latState.pendingMs) / 1000;
    if (gapSeconds <= MAX_LATENCY_SAMPLE_SECONDS) noteLatencySample(rec, gapSeconds);
    latState.pendingMs = null;
  }

  const model = typeof decoded.model === 'string' ? decoded.model : 'unknown';
  if (!rec.models.includes(model)) rec.models.push(model);

  addUsage(rec, localDay(at), model, { ...decoded.usage, responses: 1 });
  // Context pressure: the tokens actually IN the model's window for this
  // turn (fresh input plus what got served from cache) — overwritten every
  // turn so the field always reflects the LAST completion, not a running
  // total across the session.
  rec.ctxLastTokens = decoded.usage.input + decoded.usage.cacheRead;

  const tools = collectClaudeToolNames(rec, decoded.toolUses);
  if (withTurns) {
    turns.push({
      role: 'assistant', at: new Date(at).toISOString(), model,
      text: decoded.text, tools,
    });
  }
}

/**
 * Parse one Claude transcript. Returns `{ session, turns }`; `turns` is only
 * populated when `withTurns` (the reader path) — the scan path does not need
 * message bodies and holding them would balloon memory over 3,000 files.
 */
export function parseClaude(raw, { id, dirName, withTurns = false }) {
  const rec = blankSession(id, 'claude');
  const turns = [];
  const titleState = { firstPrompt: '', aiTitle: '' };
  // Open by the most recent human prompt, closed by the first real assistant
  // turn that follows it — see recordClaudeUserTurn/recordClaudeAssistantTurn.
  const latState = { pendingMs: null };

  for (const e of jsonLines(raw)) {
    const ms = toMs(e.timestamp);
    if (e.type === 'ai-title') { if (typeof e.aiTitle === 'string') titleState.aiTitle = e.aiTitle; continue; }
    if (typeof e.attributionSkill === 'string' && !rec.skill) rec.skill = e.attributionSkill;
    if (typeof e.attributionPlugin === 'string' && !rec.plugin) rec.plugin = e.attributionPlugin;
    const decoded = decodeClaudeRecord(e);
    if (decoded.isSidechain) rec.sidechain = true;
    if (rec.project === 'unknown' && typeof e.cwd === 'string') applyProject(rec, projectLabel(e.cwd, dirName, repoRootOf(e.cwd)));

    if (decoded.role === 'user') {
      recordClaudeUserTurn(rec, turns, titleState, latState, e, ms, decoded, withTurns);
      continue;
    }

    if (decoded.role !== 'assistant' || !e.message) continue;
    recordClaudeAssistantTurn(rec, turns, latState, ms, decoded, withTurns);
  }

  rec.title = maskSecrets(titleState.aiTitle || clip(titleState.firstPrompt)) || '(untitled)';
  if (rec.project === 'unknown') applyProject(rec, projectLabel(null, dirName));
  return { session: seal(rec), turns };
}

function codexParseStats() {
  return {
    legacyEvents: 0, itemCompletedEvents: 0, tokenCountEvents: 0,
    prompts: 0, responses: 0, unknownItemTypes: {}, unknownItemTypeOverflow: 0,
  };
}

function recordCodexUnknownType(stats, type) {
  if (Object.hasOwn(stats.unknownItemTypes, type)) {
    stats.unknownItemTypes[type]++;
  } else if (Object.keys(stats.unknownItemTypes).length < MAX_TELEMETRY_UNKNOWN_KINDS) {
    stats.unknownItemTypes[type] = 1;
  } else {
    stats.unknownItemTypeOverflow++;
  }
}

function handleCodexMeta(rec, decoded) {
  if (typeof decoded.sessionId === 'string' && decoded.sessionId) rec.id = decoded.sessionId;
  if (typeof decoded.cwd === 'string') applyProject(rec, projectLabel(decoded.cwd, null, repoRootOf(decoded.cwd)));
  if (typeof decoded.threadSource === 'string') rec.threadSource = decoded.threadSource;
  if (decoded.provider) {
    rec.inferenceProvider = decoded.provider;
    rec.providerProvenance = 'observed';
  }
}

function handleCodexTurnContext(rec, decoded) {
  if (typeof decoded.model === 'string' && !rec.models.includes(decoded.model)) rec.models.push(decoded.model);
  if (decoded.provider) {
    rec.inferenceProvider = decoded.provider;
    rec.providerProvenance = 'observed';
  }
  if (rec.project === 'unknown' && typeof decoded.cwd === 'string') applyProject(rec, projectLabel(decoded.cwd, null, repoRootOf(decoded.cwd)));
}

/** Normalize one token_count event's rate-limit windows (primary/secondary),
 *  dropping any window whose numeric fields don't parse. Field names are a
 *  trap upstream: `primary` is whichever window the server listed first, NOT
 *  reliably the 5-hour one (observed live: primary = the 10080-minute
 *  weekly) — so windows are kept as a flat list keyed by window_minutes and
 *  never by field name. */
function codexRateLimitWindows(rl) {
  const windows = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w !== 'object') continue;
    const usedPercent = Number(w.used_percent);
    const windowMinutes = Number(w.window_minutes);
    if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes)) continue;
    windows.push({
      usedPercent, windowMinutes,
      resetsAt: Number.isFinite(Number(w.resets_at)) ? Number(w.resets_at) : null,
    });
  }
  return windows;
}

function applyCodexRateLimit(rec, rl, ms) {
  const windows = codexRateLimitWindows(rl);
  if (!windows.length) return;
  rec.rateLimits = {
    at: Number.isFinite(ms) ? ms : null,
    limitId: typeof rl.limit_id === 'string' ? rl.limit_id : null,
    planType: typeof rl.plan_type === 'string' ? rl.plan_type : null,
    windows,
  };
}

/** `event_msg` → `token_count`: keep the LAST cumulative snapshot (see
 *  parseCodex's own doc comment for why last-only), plus its rate limits. */
function handleCodexTokenCount(rec, stats, usageState, decoded, ms) {
  stats.tokenCountEvents++;
  const t = decoded.usage.total;
  if (t) { usageState.lastUsage = t; usageState.lastUsageAt = ms; }
  const rl = decoded.usage.rateLimits;
  if (rl) applyCodexRateLimit(rec, rl, ms);
}

/** `event_msg` → a `user_message`/`item_completed` user turn. Codex rollouts
 *  record only real prompts as user_message events — tool output travels in
 *  other event types that are not surfaced as turns — so every normalized
 *  Codex user turn is kind 'prompt' by construction. */
function handleCodexUserMessage(rec, turns, stats, titleState, decoded, ms, withTurns) {
  rec.prompts++;
  stats.prompts++;
  const text = decoded.text;
  if (!titleState.firstPrompt) titleState.firstPrompt = text;
  if (withTurns && text) turns.push({ role: 'user', at: new Date(ms).toISOString(), text, prompt: true, kind: 'prompt' });
}

function handleCodexAssistantMessage(rec, turns, stats, decoded, ms, withTurns) {
  rec.responses++;
  stats.responses++;
  const at = Number.isFinite(ms) ? ms : (rec.start ?? Date.now());
  const pk = punchKey(at);
  rec.punchcard[pk] = (rec.punchcard[pk] ?? 0) + 1;
  if (withTurns) {
    turns.push({
      role: 'assistant', at: new Date(at).toISOString(),
      model: rec.models[rec.models.length - 1] ?? 'unknown',
      text: decoded.text, tools: [],
    });
  }
}

/** `event_msg` → a decoded `message` (user or assistant), after generation/
 *  unknown-type bookkeeping already ran in handleCodexEventMsg. */
function handleCodexEventMessage(rec, turns, stats, titleState, decoded, ms, withTurns) {
  if (decoded.role === 'user') {
    handleCodexUserMessage(rec, turns, stats, titleState, decoded, ms, withTurns);
    return;
  }
  handleCodexAssistantMessage(rec, turns, stats, decoded, ms, withTurns);
}

/** One `event_msg` record: token_count, a message, or lifecycle/unknown
 *  (generation/unknown-item-type diagnostics apply to every non-token_count
 *  shape, so they run before the message/non-message split). */
function handleCodexEventMsg(rec, turns, stats, titleState, usageState, decoded, ms, withTurns) {
  if (decoded.type === 'tokenCount') { handleCodexTokenCount(rec, stats, usageState, decoded, ms); return; }
  if (decoded.generation === 'legacy') stats.legacyEvents++;
  else if (decoded.generation === 'item') stats.itemCompletedEvents++;
  if (decoded.unknownItemType) recordCodexUnknownType(stats, decoded.unknownItemType);
  if (decoded.type !== 'message') return;
  handleCodexEventMessage(rec, turns, stats, titleState, decoded, ms, withTurns);
}

/** One line of a Codex rollout, dispatched on its decoded type. */
function processCodexLine(rec, turns, stats, titleState, usageState, e, ms, withTurns) {
  const decoded = decodeCodexRecord(e);
  if (decoded.type === 'meta') { handleCodexMeta(rec, decoded); return; }
  if (decoded.type === 'turnContext') { handleCodexTurnContext(rec, decoded); return; }
  if (e.type !== 'event_msg') return;
  handleCodexEventMsg(rec, turns, stats, titleState, usageState, decoded, ms, withTurns);
}

/** The session-total usage row, derived from the LAST token_count event seen
 *  (see parseCodex's doc comment). A no-op for a subagent thread (its
 *  cumulative total double-counts the parent's already-billed tokens) or a
 *  rollout that never carried a token_count at all. */
function finalizeCodexUsage(rec, usageState) {
  const { lastUsage, lastUsageAt } = usageState;
  if (!lastUsage || rec.threadSource === 'subagent') return;
  const cacheRead = Number(lastUsage.cached_input_tokens) || 0;
  const gross = Number(lastUsage.input_tokens) || 0;
  const at = Number.isFinite(lastUsageAt) ? lastUsageAt : (rec.end ?? rec.start ?? Date.now());
  addUsage(rec, localDay(at), rec.models[rec.models.length - 1] ?? 'unknown', {
    input: Math.max(0, gross - cacheRead),
    output: Number(lastUsage.output_tokens) || 0,
    cacheRead,
    cacheWrite: 0,
    responses: rec.responses,
  });
  // Reasoning tokens are a SUBSET of output_tokens (they bill as output) —
  // recorded as detail, never added into any token sum, or the total would
  // double-count exactly the reasoning share.
  rec.reasoningOutput = Number(lastUsage.reasoning_output_tokens) || 0;
}

/**
 * Parse one Codex rollout. `total_token_usage` is CUMULATIVE, so the LAST
 * token_count event is the session total — summing them would multiply the
 * figure by the number of turns. `input_tokens` there INCLUDES
 * `cached_input_tokens`, which bill as cache reads, so the two are separated.
 *
 * A rollout whose `session_meta.thread_source` is `subagent` is a delegated
 * thread whose file replays its parent thread's ENTIRE prior token history
 * as duplicate events before its own new turns (openai/codex thread_spawn
 * behavior — see ccusage/ccusage#950, which measured up to 91x cost
 * inflation from exactly this). Its cumulative `total_token_usage` therefore
 * double-counts tokens the parent session already billed, so it is excluded
 * from cost/token aggregation here; the session record itself is kept
 * (`threadSource` is surfaced on it) so it stays visible/auditable.
 */
export function parseCodex(raw, { id, withTurns = false }) {
  const rec = blankSession(id, 'codex');
  const turns = [];
  const stats = codexParseStats();
  const usageState = { lastUsage: null, lastUsageAt: null };
  const titleState = { firstPrompt: '' };

  for (const e of jsonLines(raw)) {
    const ms = toMs(e.timestamp);
    noteSpan(rec, ms);
    processCodexLine(rec, turns, stats, titleState, usageState, e, ms, withTurns);
  }

  finalizeCodexUsage(rec, usageState);
  rec.title = maskSecrets(clip(titleState.firstPrompt)) || '(untitled)';
  return { session: seal(rec), turns, parseStats: stats };
}
