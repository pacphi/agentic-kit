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
//
// This file owns index I/O (file discovery, the on-disk cache, single-session
// resolution) and the build/scan orchestration. The per-vendor transcript
// parsers live in usage-parsers.mjs; the pure aggregation/session-shape
// arithmetic lives in usage-aggregate.mjs. Both are re-exported below where a
// consumer's existing import path expects them from here.
import fs from 'node:fs';
import path from 'node:path';
import { configDir, claudeDir, codexDir } from './paths.mjs';
import { writePrivateFileAtomic } from './file-write.mjs';
import { readCodexStateResult } from './codex-state.mjs';
import {
  defaultOpencodeDbPath, listSessionsResult as listOpencodeSessionsResult,
  parseSession as parseOpencodeSession, sessionExistsResult as opencodeSessionExistsResult,
} from './usage-opencode.mjs';
import {
  addTelemetryDiagnostics, emptyTelemetryDiagnostics, finalizeTelemetryDiagnostics,
  MAX_TELEMETRY_UNKNOWN_KINDS, recordTelemetryUnit,
} from './usage-telemetry.mjs';
import { parseClaude, parseCodex } from './usage-parsers.mjs';
import { maskSecrets, applyCodexLedger, aggregate, sessionPayload } from './usage-aggregate.mjs';

export { IDLE_GAP_MS, projectLabel } from './usage-parsers.mjs';
export { MAX_TURN_CHARS, mergeIntervals, maskSecrets, normalizeSessionIdentity, applyCodexLedger } from './usage-aggregate.mjs';

/** Bump to invalidate every cached entry wholesale.
 *  v2: cached records carry `active` sub-intervals for the idle-gap split.
 *  v3: project is the REPO, with the worktree kept separately — cached v2
 *      records carry the old worktree-as-project labels and must be re-derived.
 *  v4: `exceptions` (dropped-connection/rate-limit/auth-failure placeholder
 *      turns) is a new required field on every session record. Without this
 *      bump, a v3-cached session has `exceptions: undefined`, and summing
 *      that into `totals.exceptions` silently produces NaN (serialized as
 *      `null` over JSON) instead of a real count — caught by querying a real
 *      cached index during verification, not by the unit tests, which only
 *      ever exercise a fresh parse.
 *  v5: harness-output envelopes (task-notification, bash-stdout,
 *      local-command-stdout, …) no longer count as human prompts, so the
 *      cached `prompts` figure on every session parsed before this rule is
 *      inflated and must be re-derived.
 *  v6: Codex sessions grow `reasoningOutput` (reasoning tokens inside output)
 *      and `rateLimits` (the LAST rate-limit snapshot embedded in the
 *      rollout's token_count events). A v5-cached Codex session carries
 *      neither and must be re-derived, or the Limits history reads as empty
 *      for exactly the sessions that have data.
 *  v7: the opencode transcript source (usage-opencode.mjs) joins the index —
 *      SQLite-backed session/message/part rows mapped to the same record
 *      shape, with opencode's OWN metered cost carried as observed truth
 *      (`costObserved` on usage rows, preferred over the pricing table).
 *  v8: Codex `session_meta.model_provider` is retained as observed inference
 *      provider evidence. v7 caches discarded that field, so every Codex
 *      record must be re-derived rather than continuing to display an
 *      avoidable "provider not recorded".
 *  v9: the dropped-connection/API-error placeholder turn is now recognized by
 *      its literal `model: "<synthetic>"` marker as well as
 *      `isApiErrorMessage: true` — some builds emit the placeholder without
 *      that flag set. A v8-cached session parsed from such a transcript still
 *      carries `"<synthetic>"` in `models` and a $0 usage row, so it must be
 *      re-derived or the placeholder keeps showing as a real "model in play".
 *  v10: Codex rollout messages can arrive in the `item_completed` envelope;
 *       v9-cached records parsed from those files have token rows but zero
 *       prompts/responses, so every Codex record must be re-derived.
 *  v11: session records grow `mode`/`modeRaw` (cross-host permission
 *       posture), `latHist`/`latCount` (response-latency histogram),
 *       `lenSeconds` (this session's own engaged seconds), `ctxWindow`/
 *       `ctxLastTokens` (model context-window detail), and `aborts`
 *       (codex's explicit user-abort count). A v10-cached record carries
 *       none of these, so every session must be re-derived or the new
 *       fields silently read as undefined.
 *  v12: Codex writes `sandbox_policy` as an object keyed `.type`, so v11
 *       records persisted `modeRaw: "never/[object Object]"` and a null
 *       `mode` for every Codex session — the taxonomy's plan/auto-edit/
 *       unrestricted arms could not fire at all. The parser now extracts
 *       `.type`, so every Codex record must be re-derived rather than left
 *       carrying the failed stringification and its missing posture.
 *  v13: two parseCodex defects corrected together, both inflating persisted
 *       counts/identities. (a) `session_meta` was last-wins; a subagent
 *       rollout replays its parent thread's history, including the parent's
 *       OWN session_meta line, so a later meta relabeled `threadSource`
 *       subagent→user and re-keyed `id` to the parent's — letting up to 155
 *       of 318 observed subagent rollouts escape the finalizeCodexUsage
 *       guard and double-bill the parent. The FIRST session_meta now wins
 *       for identity (id/threadSource/cwd). (b) every `user_message`/
 *       `UserMessage` counted toward `prompts` regardless of origin; Codex
 *       carried no equivalent of the harness/mirror gate v5 already applies
 *       to Claude, so harness output and mirrored cross-host envelopes
 *       (task notifications, command stdout, teammate-message/cross-session
 *       deliveries) inflated Codex prompt counts. A v12-cached Codex record
 *       carries the old (possibly relabeled, possibly inflated) figures and
 *       must be re-derived rather than trusted as-is.
 *  v14: every session record grows `promptFPs` (one privacy-preserving
 *       fingerprint per prompt-kind turn — normalized-text hash, token count,
 *       bounded token-hash sketch, and a provenance tag saying who WROTE it) and
 *       `promptFPOverflow`. A v13-cached record carries neither, so the
 *       Prompts view would read an empty corpus for exactly the sessions
 *       already on disk. Prompt TEXT is not part of this (or any) bump — see
 *       usage-parsers.promptFingerprint.
 *  v15: `in-app-browser-context` joins HARNESS_OUTPUT_RE. Measured: 33 such
 *       turns reached kind 'prompt', so a v14 record counts them in `prompts`
 *       (the harness writing in the operator's name) AND carries a `human`
 *       fingerprint for each. Both figures change for an affected session, so
 *       every record must be re-derived rather than corrected in place. The
 *       provenance rules move with it — session-continuation prose is now
 *       `control`, and the unevidenced `<command-args>` opener is gone — which
 *       also re-tags cached fingerprints.
 *  v16: fingerprints grow two optional SHAPE flags — `q` (question-shaped) and
 *       `o` (persona opener) — decided from the text at fingerprint time, the
 *       last moment it exists. A v15 record cannot be corrected in place
 *       because the text is gone by then; the flags are only derivable on a
 *       re-parse. Absent keys mean "not that shape" and are omitted rather
 *       than stored as 0 — see usage-parsers.promptShape. */
export const SCHEMA_VERSION = 16;

const DAY_MS = 86_400_000;
// One day of slack past dashboard-server.mjs's 365-day clampDays ceiling —
// see the carry-forward pruning comment in scan() below.
const KEEP_MS = 366 * DAY_MS;
/** Largest single transcript readSession will pull into memory. The corpus's
 *  biggest real file is ~18 MB; JSON expansion runs ~5x, so 64 MB caps the
 *  spike near 320 MB instead of unbounded. Above this the session reads as
 *  unavailable rather than risking the panel's process. */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** A nested Claude subagent transcript's id: EXACTLY `<parentId>/<stem>`,
 *  one slash. The parent segment reuses VALID_ID's own charset (capture
 *  group 1) — a namespaced id's parent half can never be more permissive
 *  than a plain id already is. The child segment (group 2) matches the REAL
 *  on-disk shape Claude Code writes every subagent transcript with:
 *  `agent-<hex>` when the Task tool call carried no name, or
 *  `agent-<name>-<hex>` when it did (the name is the Agent tool's own
 *  `name` parameter, charset [A-Za-z0-9_-]). Surveyed on this machine's real
 *  corpus (404 files, 2026-08-28): most stems carry a name — a hex-only
 *  pattern would leave most subagent sessions still unopenable, defeating
 *  the point of this fix.
 *
 *  This regex is NOT the whole grammar: '.' IS in the parent charset, so
 *  `.` and `..` match it. Use matchSubagentId(), never this constant
 *  directly. */
const VALID_SUBAGENT_ID = /^([A-Za-z0-9._-]{1,128})\/(agent-[A-Za-z0-9_-]{1,100})$/;

/** The namespaced-id grammar, complete: VALID_SUBAGENT_ID's charsets PLUS
 *  the dot-segment rejection, so this is character-for-character the rule
 *  session-security.mjs's parseNamespacedSessionId applies at the HTTP tier
 *  (PLAIN_ID_RE + `parentId === '.' || parentId === '..'` + SUBAGENT_STEM_RE).
 *  The two tiers are kept as separate functions on purpose — the route's also
 *  owns percent-decoding, which a library caller passing an already-decoded
 *  id must not get — but they now accept exactly the same id set.
 *
 *  The dot check is what the charset cannot do and what matters most here:
 *  the parent is the only place in this module where caller-shaped text
 *  becomes a path SEGMENT rather than a filename stem, and path.join
 *  collapses `..`. `readSession('../agent-x')` used to probe
 *  `<claudeRoot>/subagents/agent-x.jsonl` — still inside the transcript root,
 *  so the realpath containment check below could not catch it: containment
 *  answers "did we leave the root?", not "did we leave the shape?".
 *
 *  @returns {{ parentId: string, stem: string }|null} */
function matchSubagentId(id) {
  const m = typeof id === 'string' ? VALID_SUBAGENT_ID.exec(id) : null;
  if (!m) return null;
  const [, parentId, stem] = m;
  if (parentId === '.' || parentId === '..') return null;
  return { parentId, stem };
}

// ── file discovery ──────────────────────────────────────────────────────────

function readDirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

/** ok/absent/degraded for a primary transcript root (Claude/Codex): distinguishes
 *  a directory that simply doesn't exist yet (host never used on this machine)
 *  from one that exists but can't be read (permissions, not-a-directory, I/O) —
 *  the same vocabulary sourceHealth already uses for the opencode/codexLedger
 *  sources, so an unreadable root cannot be mistaken for "zero sessions in
 *  this window". listClaude/listCodex still swallow readdir errors per
 *  subdirectory (a bad nested entry must not abort the whole scan); this is
 *  the one root-level check that turns that silence into visible evidence. */
function rootHealth(dir) {
  try {
    fs.readdirSync(dir);
    return { status: 'ok', reason: null };
  } catch (err) {
    return err?.code === 'ENOENT'
      ? { status: 'absent', reason: null }
      : { status: 'degraded', reason: err?.code || 'io' };
  }
}

function emptyCodexDiagnostics() {
  return {
    files: 0, cachedFiles: 0, parsedFiles: 0, unparsedFiles: 0,
    filesWithTokens: 0, filesWithResponses: 0,
    legacyEvents: 0, itemCompletedEvents: 0, tokenCountEvents: 0,
    prompts: 0, responses: 0, unknownItemTypes: {}, unknownItemTypeOverflow: 0, warnings: [],
  };
}

function addCodexParseDiagnostics(target, stats) {
  if (!stats) return;
  target.parsedFiles++;
  if (stats.tokenCountEvents > 0) target.filesWithTokens++;
  if (stats.responses > 0) target.filesWithResponses++;
  target.legacyEvents += stats.legacyEvents;
  target.itemCompletedEvents += stats.itemCompletedEvents;
  target.tokenCountEvents += stats.tokenCountEvents;
  target.prompts += stats.prompts;
  target.responses += stats.responses;
  for (const [type, count] of Object.entries(stats.unknownItemTypes ?? {})) {
    if (Object.hasOwn(target.unknownItemTypes, type)) {
      target.unknownItemTypes[type] += count;
    } else if (Object.keys(target.unknownItemTypes).length < MAX_TELEMETRY_UNKNOWN_KINDS) {
      target.unknownItemTypes[type] = count;
    } else {
      target.unknownItemTypeOverflow += count;
    }
  }
  target.unknownItemTypeOverflow += stats.unknownItemTypeOverflow ?? 0;
}

function finalizeCodexHealth(root, diagnostics) {
  const warnings = [];
  const tokenFiles = diagnostics.filesWithTokens;
  const responseFiles = diagnostics.filesWithResponses;
  if (tokenFiles > 0 && responseFiles === 0) warnings.push('zero-response-yield');
  else if (tokenFiles > responseFiles) warnings.push('partial-response-yield');
  if (Object.keys(diagnostics.unknownItemTypes).length || diagnostics.unknownItemTypeOverflow > 0) {
    warnings.push('unknown-item-types');
  }
  diagnostics.warnings = warnings;
  const hasYieldWarning = warnings.includes('zero-response-yield') || warnings.includes('partial-response-yield');
  const status = root.status === 'ok' && hasYieldWarning
    ? 'degraded' : root.status;
  const reason = status === 'degraded' && root.status === 'ok'
    ? (warnings.includes('zero-response-yield') ? 'parse-yield-zero' : 'parse-yield-partial') : root.reason;
  return { ...root, status, reason, diagnostics };
}

/** Attach the additive host-neutral telemetry counters to source health.
 * Existing status/reason and Codex diagnostic keys remain where consumers
 * already find them; `diagnostics.common` is the cross-host surface. It
 * reports what was read — never a per-host claim about what could be read. */
function attachTelemetryHealth(health, common, diagnostics = health.diagnostics) {
  return {
    ...health,
    diagnostics: {
      ...(diagnostics ?? {}),
      common: finalizeTelemetryDiagnostics(common),
    },
  };
}

function defaultRoots() {
  return {
    claude: path.join(claudeDir(), 'projects'),
    codex: path.join(codexDir(), 'sessions'),
  };
}

/** `<projectDir>/<sessionId>/subagents/*.jsonl` — a session's own subagent
 *  (sidechain) transcripts, real cost-bearing Claude work that otherwise
 *  never enters the index: parseClaude already prices these bytes and marks
 *  them `sidechain` from their own entries (isSidechain), so discovery was
 *  the entire gap. Bounded to exactly this one nested shape — not a generic
 *  recursive walk — so a directory entry that ISN'T a session-id dir with a
 *  subagents child (e.g. Claude Code's own `memory` dir) just contributes
 *  nothing, harmlessly.
 *
 *  The id is namespaced `<sessionId>/<stem>`: Claude Code names every
 *  subagent file `agent-<hash>.jsonl`, and that stem is NOT guaranteed
 *  unique across two different parent sessions, so an unnamespaced id could
 *  silently collide two unrelated subagent records into one.
 *
 *  An unreadable (or absent — most sessions have none) subagents dir
 *  degrades silently via readDirSafe, exactly like every other per-directory
 *  read in this file: one bad nested entry must not abort the whole scan,
 *  and this draws no new health signal — same convention, not a new one. */
function listClaudeSubagents(projectDir, sessionId, projectDirName) {
  const out = [];
  const subDir = path.join(projectDir, sessionId, 'subagents');
  for (const f of readDirSafe(subDir)) {
    if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
    const id = `${sessionId}/${f.name.slice(0, -6)}`;
    // Discovery and resolution share ONE grammar. Without this, any other
    // file appearing in a subagents/ dir (a summary, an index, a renamed
    // stem) — or a parent dir name outside the plain-id charset — became a
    // session row that answers 400 when clicked: a row disclosing title,
    // project, tokens, cost and timing for a transcript the id grammar has
    // decided is not addressable. Surveyed 2026-08-28: 411 files, 0 rejected,
    // so this drops nothing today; it keeps the two sides from disagreeing
    // when the on-disk shape next changes, at the point of discovery rather
    // than as a 400 far from its cause.
    if (!matchSubagentId(id)) continue;
    out.push({
      file: path.join(subDir, f.name), provider: 'claude', dirName: projectDirName, id,
    });
  }
  return out;
}

/** Claude transcripts: one level of project directories, plus each session's
 *  own nested subagents/ (see listClaudeSubagents). */
function listClaude(root) {
  const out = [];
  for (const d of readDirSafe(root)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    for (const f of readDirSafe(dir)) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        out.push({ file: path.join(dir, f.name), provider: 'claude', dirName: d.name, id: f.name.slice(0, -6) });
      } else if (f.isDirectory()) {
        out.push(...listClaudeSubagents(dir, f.name, d.name));
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

// Truthfulness policy: dispatch explicitly on the three known providers. A
// codex/claude 2-way ternary silently mis-files anything unrecognized as
// claude; an entry this module doesn't know how to parse must be declined
// (same contract as a parse failure), never mis-labeled.
function parseFile(entry) {
  if (entry.provider === 'opencode') {
    try {
      const parsed = parseOpencodeSession({ dbFile: entry.dbFile, id: entry.id });
      // Title hygiene matches the JSONL parsers: the cached index lands on
      // disk, so the same secrets mask applies here.
      if (parsed?.session) parsed.session.title = maskSecrets(parsed.session.title);
      return parsed;
    } catch { return null; } // a parser bug must not cost the user their whole index
  }
  if (entry.provider !== 'codex' && entry.provider !== 'claude') return null;
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

// code-quality Finding 5: /api/session/:id used to call readCache() (a
// synchronous JSON.parse of the whole index — several MB on the module's own
// stated reference corpus) on EVERY request, on the Node event loop, to
// answer an O(1) "one record" question. Memoized on the cache file's own
// mtime: a request between writes reuses the parsed object instead of
// reparsing it; a write (which always renames a fresh file into place, so
// mtime always changes) is still picked up on the very next read.
let _cacheMemo = null;

function readCache(file) {
  const st = statSafe(file);
  if (_cacheMemo && _cacheMemo.file === file && st && _cacheMemo.mtime === st.mtimeMs) {
    return _cacheMemo.value;
  }
  let value = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.schemaVersion === SCHEMA_VERSION && raw.entries && typeof raw.entries === 'object') value = raw;
  } catch { /* corrupt/missing cache → null, same as before */ }
  if (st) _cacheMemo = { file, mtime: st.mtimeMs, value };
  else _cacheMemo = null; // file vanished between statSafe and here — don't memo a stale mtime
  return value;
}

// Companion id→file index, memoized the same way — locate() used to
// Object.entries().find() the WHOLE cache for a single id on every call.
// Rebuilt only when the underlying cache object identity changes (the memo
// above already guarantees that happens exactly once per file mutation).
let _idIndexMemo = null; // { forCache, map: Map<id, file> }

function idIndexFor(cache) {
  if (_idIndexMemo && _idIndexMemo.forCache === cache) return _idIndexMemo.map;
  const map = new Map();
  for (const [file, e] of Object.entries(cache?.entries ?? {})) {
    if (e?.session?.id) map.set(e.session.id, file);
  }
  _idIndexMemo = { forCache: cache, map };
  return map;
}

function writeCache(file, cache) {
  try {
    // 0600, matching the 0600 transcripts this content derives from. `title` is
    // the ai-title, or the first 100 chars of the user's first prompt when there
    // is none — writing that world-readable downgrades the source's permissions.
    writePrivateFileAtomic(file, JSON.stringify(cache));
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

// ── build ───────────────────────────────────────────────────────────────────

// Single-flight is keyed by the options that change the RESULT, not global.
// A bare `if (_inflight) return _inflight` handed a ?days=365 caller whatever
// scan happened to be running — usually the 14-day one — and readIndex then
// memoised that answer under the 365 key. Coalescing is only sound between
// callers who asked the same question.
/** @type {Map<string, Promise<any>>} */
const _inflight = new Map();
let _memo = null;

/** Identity of a scan: two calls sharing it must produce the same aggregate.
 *  Roots are folded in as sorted [key, value] pairs rather than a hardcoded
 *  claude/codex/opencode triple, so a root this module doesn't (yet) special-
 *  case still changes the key instead of colliding with every other scan. */
function scanKey(o = {}) {
  const roots = Object.entries(o.roots || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // lookbackDays, previous and prompts all change the RESULT — lookbackDays
  // widens what scan() parses/returns, previous turns on aggregate's
  // previous-window projection (agg.previous), prompts turns on the repetition
  // projection (agg.promptPatterns) — exactly like days/force/roots/cachePath
  // already do, so every one must be folded into the single-flight/memo
  // identity too: two calls differing only by one of these must never coalesce
  // into one answer (a {previous:true} caller must never be served a memoized
  // {previous:false} answer, or vice versa; likewise {prompts:true}).
  return JSON.stringify([
    Number(o.days) || 14, Number(o.lookbackDays) || 0,
    !!o.previous, !!o.prompts, !!o.force, roots, o.cachePath || '',
  ]);
}

/** Drop process-level state (single-flight promises, read memo, lazy deps). */
export function _resetForTest() { _inflight.clear(); _memo = null; _deps = null; _cacheMemo = null; _idIndexMemo = null; }

function notify(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(payload); } catch { /* the UI's problem, not the scan's */ }
}

/**
 * @typedef {object} IndexOptions
 * @property {number} [days]        window size in days (default 14)
 * @property {number} [lookbackDays] widen the discovery/parse/cache cutoff to
 *           this many days back instead of `days`, so records older than the
 *           DISPLAYED window are still read off disk and handed to
 *           `aggregate`. The `aggregate` call itself always filters the
 *           CURRENT window's `sessions`/`totals` at the display cutoff
 *           (`now - days * DAY_MS`), never the widened one — a caller must
 *           pair this with `previous: true` (below) to actually get the
 *           older records back out, via `previous.totals`/`previous.rhythm`,
 *           rather than by hand-splitting a widened `sessions[]`. Undefined
 *           (default) behaves exactly as `days` alone: no widening.
 * @property {boolean} [previous]   also have `aggregate` project the
 *           equal-length window immediately before the displayed one (see
 *           usage-aggregate.mjs's `previousWindow`); needs `lookbackDays` set
 *           wide enough for those older records to have been read at all.
 *           Forwarded to `aggregate`'s own `previous` option unchanged.
 * @property {boolean} [prompts]    also have `aggregate` build the prompt
 *           repetition projection (`agg.promptPatterns` — recurring clusters,
 *           intra-session re-asks, exact repeats; see
 *           usage-aggregate.mjs's `buildPromptPatterns`). Off by default
 *           because clustering the corpus costs real time on every scan and
 *           no default consumer reads it; `agg.promptPatterns` is `null` when
 *           not requested. Forwarded to `aggregate`'s own `prompts` option
 *           unchanged, and folded into `scanKey` like `previous` is.
 * @property {boolean} [force]      ignore cached per-file entries
 * @property {Function} [onProgress] called with { scanned, total, phase }
 * @property {{claude?: string, codex?: string, opencode?: string}} [roots] override transcript roots (tests; opencode = the SQLite store path)
 * @property {string} [cachePath]   override the index cache location (tests)
 * @property {number} [now]         override "now" (tests)
 * @property {number} [maxAgeMs]    readIndex only: memo TTL
 * @property {object|null} [codexState] override the Codex SQLite thread ledger
 *           (tests); null skips the read entirely, undefined reads the real db
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

/** opencode transcript source (one SQLite store, per-session cache keys).
 *  Same hermeticity rule as the codex ledger below: overridden roots imply
 *  the REAL store is the wrong one — only default-root scans (or an explicit
 *  roots.opencode path) read it. Unlike the claude/codex file-tree sources,
 *  opencode's health is a BYPRODUCT of listing (a single SQLite read can fail
 *  in ways a directory walk cannot), so discovery and health are resolved
 *  together here rather than the rootHealth()-then-list() order the other
 *  two sources use. `rawRoots` is the caller's OWN `roots` option, unmerged
 *  with defaults — its mere presence (vs `undefined`) is what makes an
 *  override hermetic; see the codex ledger comment below. */
function discoverOpencodeSource(rawRoots, cutoff) {
  const ocDb = rawRoots === undefined ? defaultOpencodeDbPath() : (rawRoots?.opencode ?? null);
  if (!ocDb || !fs.existsSync(ocDb)) return { health: { status: 'absent', reason: null }, candidates: [], ocDb };
  const listed = listOpencodeSessionsResult({ dbFile: ocDb, cutoffMs: cutoff });
  if (!listed.ok) {
    const health = listed.error.kind === 'absent'
      ? { status: 'absent', reason: 'absent' } : { status: 'degraded', reason: listed.error.kind };
    return { health, candidates: [], ocDb };
  }
  const candidates = listed.value.map((e) => ({
    file: `opencode://${e.id}`, provider: 'opencode', id: e.id, dbFile: ocDb,
    stat: { mtimeMs: e.mtimeMs, size: e.size },
  }));
  return { health: { status: 'ok', reason: null }, candidates, ocDb };
}

/** Parse (or reuse the cached parse of) one scan candidate, updating the
 *  common cross-host telemetry diagnostics and codex's extra per-file
 *  diagnostics as side effects. Pulled out of scan()'s loop so the per-file
 *  bookkeeping — which is genuinely provider-specific (codex tracks file
 *  counts and yield diagnostics no other source has) — is not inlined into
 *  the generic scan loop's own complexity. */
function processCandidate(c, cache, commonDiagnostics, codexDiagnostics) {
  const key = { mtime: c.stat.mtimeMs, size: c.stat.size };
  const hit = cache?.entries?.[c.file];
  const cacheHit = !!(hit && hit.mtime === key.mtime && hit.size === key.size
    && (c.provider !== 'codex' || hit.parseStats));
  let session = cacheHit ? hit.session : null;
  let parseStats = cacheHit ? hit.parseStats : null;
  if (!session) {
    const parsed = parseFile(c);
    session = parsed ? parsed.session : null;
    parseStats = parsed?.parseStats ?? null;
  }
  if (commonDiagnostics[c.provider]) {
    recordTelemetryUnit(commonDiagnostics[c.provider], session);
    if (c.provider === 'codex') {
      addTelemetryDiagnostics(commonDiagnostics.codex, {
        unknownKinds: parseStats?.unknownItemTypes,
        unknownKindOverflow: parseStats?.unknownItemTypeOverflow,
      });
    }
  }
  if (c.provider === 'codex') {
    codexDiagnostics.files++;
    if (cacheHit) codexDiagnostics.cachedFiles++;
    if (session) addCodexParseDiagnostics(codexDiagnostics, parseStats);
    else codexDiagnostics.unparsedFiles++;
  }
  return { key, session, parseStats };
}

/** Carry forward cached entries outside the window whose source still exists,
 *  so widening the window later does not force a full re-parse. Bounded at
 *  KEEP_MS: dashboard-server.mjs's clampDays caps every queryable window at
 *  365 days, so an entry whose last activity is older than that can never be
 *  reached by ANY query — carrying it forever was pure dead weight the cache
 *  (and readCache's now-memoized parse) paid for on every scan.
 *
 *  claude/codex existence is a plain file stat; opencode pseudo-keys are not
 *  files, so existence means "row still in the store" — checked against the
 *  SQLite source directly. A degraded opencode store can't tell existence
 *  apart from absence, so every carried opencode entry is kept rather than
 *  guessed away, and (unlike claude/codex, whose carried entries stay
 *  cache-only) is pushed back into `records` when still within the window,
 *  since a store read that regains health later has no other way to notice.
 *
 *  Mutates `entries` and `records` in place; returns the possibly-updated
 *  opencode health (a degraded existence check discovered mid-loop must
 *  still be visible to the NEXT entry's check and to the final report). */
function carryForwardCachedEntries(cache, entries, records, { now, cutoff, ocDb, opencodeHealth }) {
  if (!cache?.entries) return opencodeHealth;
  for (const [file, e] of Object.entries(cache.entries)) {
    if (entries[file] || !e?.session) continue;
    const lastActivity = e.session.end ?? e.session.start;
    // No timestamp at all → can't judge age; keep it rather than guess.
    if (lastActivity != null && now - lastActivity > KEEP_MS) continue;
    if (!file.startsWith('opencode://')) {
      if (statSafe(file)) entries[file] = e;
      continue;
    }
    const result = carryForwardOpencodeEntry(file, e, opencodeHealth, ocDb);
    if (!result) continue;
    entries[file] = result.entry;
    opencodeHealth = result.health;
    if (result.pushRecord && (lastActivity == null || lastActivity >= cutoff)) records.push(e.session);
  }
  return opencodeHealth;
}

/** The opencode half of carryForwardCachedEntries — split out to keep both
 *  functions individually under the project's complexity threshold. Returns
 *  `null` to drop the entry, or `{ entry, health, pushRecord }` for the
 *  caller to apply; see carryForwardCachedEntries for why a kept entry is
 *  pushed back into `records` (unlike claude/codex's carry-forward). */
function carryForwardOpencodeEntry(file, e, opencodeHealth, ocDb) {
  const dbFile = e.dbFile ?? ocDb;
  const exists = opencodeHealth.status === 'degraded'
    ? null
    : (dbFile ? opencodeSessionExistsResult({ dbFile, id: file.slice('opencode://'.length) }) : null);
  if (opencodeHealth.status === 'degraded' || (exists?.ok && exists.value)) {
    return { entry: { ...e, dbFile }, health: opencodeHealth, pushRecord: true };
  }
  if (exists && !exists.ok && exists.error.kind !== 'absent') {
    return {
      entry: { ...e, dbFile },
      health: { status: 'degraded', reason: exists.error.kind },
      pushRecord: true,
    };
  }
  return null;
}

/** Codex's own thread ledger outranks the rollout heuristic (`undefined` →
 *  read the real db; tests pass an object, or null to skip). Overridden roots
 *  (tests, sandboxes) imply the REAL ~/.codex ledger is the wrong ledger for
 *  these records — reading it would break test hermeticity and mis-attribute
 *  fixture sessions. Only default roots read the real db. `rawRoots` is the
 *  caller's OWN `roots` option, unmerged with defaults (same reason as
 *  discoverOpencodeSource's).
 *  @param {IndexOptions} o */
function resolveCodexLedger(o, rawRoots) {
  if (o.codexState !== undefined) {
    return { ledger: o.codexState, health: { status: o.codexState ? 'ok' : 'absent', reason: null } };
  }
  if (rawRoots?.codex) {
    return { ledger: null, health: { status: 'not-read', reason: 'sandboxed-roots' } };
  }
  const observed = readCodexStateResult();
  const ledger = observed.ok ? observed.value : null;
  const health = observed.ok
    ? (observed.value ? { status: 'ok', reason: null } : { status: 'degraded', reason: 'schema' })
    : { status: observed.error.kind === 'absent' ? 'absent' : 'degraded', reason: observed.error.kind };
  return { ledger, health };
}

/** @param {IndexOptions} [o] */
async function scan(o = {}) {
  const {
    days = 14, lookbackDays, force = false, onProgress, roots, cachePath, now = Date.now(), deps: injected,
    previous = false, prompts = false,
  } = o;
  const deps = await loadDeps(injected);
  const r = { ...defaultRoots(), ...(roots ?? {}) };
  const cacheFile = cachePath ?? defaultCachePath();
  // Widened when the caller passes lookbackDays (a server wanting a
  // `previous`-window projection, e.g.) — every DISCOVERY/parse use below
  // (candidates, opencode listing, carry-forward) shares this ONE value, so
  // widening it here is the entire discovery-side effect. It does NOT reach
  // `aggregate`'s own cutoff below — see displayCutoff — so the CURRENT
  // window's `sessions`/`totals` never silently widen with it; only
  // `aggregate`'s `previous` projection (when requested) reads the extra
  // records this pulls in. Unset, `lookbackDays ?? days` is exactly `days` —
  // today's behavior, unchanged.
  const cutoff = now - (lookbackDays ?? days) * DAY_MS;

  // Primary transcript roots: read once at root level (cheap — not the
  // recursive per-file walk listClaude/listCodex still do below).
  const claudeHealth = rootHealth(r.claude);
  const codexHealth = rootHealth(r.codex);
  const candidates = [...listClaude(r.claude), ...listCodex(r.codex)]
    .map((e) => ({ ...e, stat: statSafe(e.file) }))
    .filter((e) => e.stat && e.stat.mtimeMs >= cutoff);

  const opencodeSource = discoverOpencodeSource(roots, cutoff);
  let opencodeHealth = opencodeSource.health;
  const ocDb = opencodeSource.ocDb;
  candidates.push(...opencodeSource.candidates);

  const cache = force ? null : readCache(cacheFile);
  const entries = {};
  const records = [];
  const codexDiagnostics = emptyCodexDiagnostics();
  const commonDiagnostics = {
    claude: emptyTelemetryDiagnostics(),
    codex: emptyTelemetryDiagnostics(),
    opencode: emptyTelemetryDiagnostics(),
  };
  const total = candidates.length;
  let scanned = 0;

  notify(onProgress, { scanned: 0, total, phase: 'scan' });
  for (const c of candidates) {
    const { key, session, parseStats } = processCandidate(c, cache, commonDiagnostics, codexDiagnostics);
    if (session) {
      entries[c.file] = {
        ...key, session,
        ...(parseStats ? { parseStats } : {}),
        ...(c.dbFile ? { dbFile: c.dbFile } : {}),
      };
      records.push(session);
    }
    scanned++;
    if (scanned % 100 === 0) notify(onProgress, { scanned, total, phase: 'scan' });
  }

  opencodeHealth = carryForwardCachedEntries(cache, entries, records, {
    now, cutoff, ocDb, opencodeHealth,
  });
  writeCache(cacheFile, { schemaVersion: SCHEMA_VERSION, updatedAt: new Date(now).toISOString(), entries });
  notify(onProgress, { scanned: total, total, phase: 'aggregate' });

  // Applied AFTER the cache write, on copies: the cache stores what the FILE
  // said, the aggregate reflects what Codex's ledger knows — a ledger that
  // arrives later (or gets repaired) corrects old sessions without a cache
  // invalidation.
  const { ledger, health: codexLedgerHealth } = resolveCodexLedger(o, roots);
  // DISPLAY cutoff, deliberately distinct from the (possibly lookback-
  // widened) discovery `cutoff` above: `records` may span further back than
  // `days` so `previous` below has something to project from, but the
  // CURRENT window's own sessions/totals must stay exactly `days` wide, or a
  // `previous: true` caller would find its "current" totals silently
  // absorbing what should have been the previous window (the bug this fixes).
  const displayCutoff = now - days * DAY_MS;
  const result = aggregate(applyCodexLedger(records, ledger), {
    days, now, cutoff: displayCutoff, deps, previous, prompts,
  });
  const codexSourceHealth = finalizeCodexHealth(codexHealth, codexDiagnostics);
  addTelemetryDiagnostics(commonDiagnostics.codex, {
    warnings: codexSourceHealth.diagnostics.warnings,
  });
  result.sourceHealth = {
    claude: attachTelemetryHealth(claudeHealth, commonDiagnostics.claude),
    codex: attachTelemetryHealth(codexSourceHealth, commonDiagnostics.codex),
    opencode: attachTelemetryHealth(opencodeHealth, commonDiagnostics.opencode),
    codexLedger: codexLedgerHealth,
  };
  return result;
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
  // code-quality Finding 7: this used to hand-roll a SECOND "what counts as
  // the same question" key that omitted `force` — the exact mistake
  // buildIndex's _inflight keying (scanKey, above) was written to prevent one
  // layer up. readIndex({ force: true }) within maxAgeMs of a normal read
  // would silently return the stale memoized aggregate and never reach
  // buildIndex. Reusing scanKey means there is exactly one definition of
  // "same question" for both the single-flight map and this memo.
  //
  // scanKey deliberately does NOT fold in `deps` or `codexState`, and this
  // comment says so rather than implying otherwise: both hold live objects
  // (functions, Maps) that do not serialize, so keying on them would mean
  // minting identity tokens through a WeakMap. Two calls differing ONLY by an
  // injected pricer or ledger would therefore coalesce — a latent trap, not a
  // live bug: production never injects `deps`, and tests sandbox `roots` and
  // `cachePath` per test so their keys already differ. Ruled parked with that
  // reason rather than left implied.
  const key = scanKey({ ...o, days });
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

/** The project directory name for a resolved claude FILE — one level up for
 *  a plain `<project>/<id>.jsonl`, three levels up for a nested subagent
 *  transcript `<project>/<parentId>/subagents/<stem>.jsonl` (the extra
 *  `subagents` and `<parentId>` levels a namespaced id resolves through).
 *  Shared by locate()'s cache-hit path and its own nested-id fallback scan
 *  below, so both agree on what "the project" means for the same file
 *  shape — a cache-hit that instead reported the literal `subagents`
 *  directory as the project would only ever surface when a transcript
 *  carries no `cwd` at all (parseClaude's fallback path), but it would still
 *  be wrong, so this file shape is resolved to the real project everywhere
 *  a dirName is derived from a FILE, not just on the fresh-parse path. */
function claudeDirNameFor(file) {
  const parentDir = path.dirname(file);
  return path.basename(parentDir) === 'subagents'
    ? path.basename(path.dirname(path.dirname(parentDir)))
    : path.basename(parentDir);
}

/** locate()'s namespaced-id branch, pulled out to keep locate() itself under
 *  the project's complexity ceiling — the same reason listClaudeSubagents was
 *  split out of listClaude on the discovery side. Resolves ONLY to a nested
 *  Claude subagent transcript, constructing the candidate path from the two
 *  VALIDATED capture groups `locate` already extracted — never by joining raw
 *  request input. Returns `null` (not "fall through") on a miss: a namespaced
 *  id is never a plain id too, so there is nothing else for locate to try. */
function locateSubagent(parentId, stem, claudeRoot, id) {
  for (const d of readDirSafe(claudeRoot)) {
    if (!d.isDirectory()) continue;
    const file = path.join(claudeRoot, d.name, parentId, 'subagents', `${stem}.jsonl`);
    if (statSafe(file)) return { file, provider: 'claude', id, dirName: d.name };
  }
  return null;
}

/** Resolve an id to exactly one transcript file. Consults the index cache
 *  first; otherwise matches on FILE NAMES only — never opens a transcript it is
 *  not going to return. A namespaced id (VALID_SUBAGENT_ID) resolves via
 *  locateSubagent only — see there. */
function locate(id, r, cacheFile) {
  const cache = readCache(cacheFile);
  const hitFile = idIndexFor(cache).get(id);
  if (hitFile) {
    const e = cache.entries[hitFile];
    // locate() only ever resolves a claude or codex FILE — opencode sessions
    // are resolved upstream via the SQLite store before locate is called. A
    // cache entry whose provider is neither is not this function's to answer;
    // falling through to the scan loops below reports "not found here"
    // instead of silently rewriting the provider to claude.
    const provider = e?.session?.provider;
    if ((provider === 'claude' || provider === 'codex') && e.session.id === id && statSafe(hitFile)) {
      return { file: hitFile, provider, id, dirName: provider === 'claude' ? claudeDirNameFor(hitFile) : null };
    }
  }

  const nested = matchSubagentId(id);
  if (nested) return locateSubagent(nested.parentId, nested.stem, r.claude, id);

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
 * Throws `ERR_INVALID_SESSION_ID` for an id that fails EITHER id grammar — a
 * plain id (VALID_ID) or a namespaced Claude subagent id (matchSubagentId,
 * `<parentId>/<stem>`) — before any filesystem access.
 *
 * The namespaced grammar accepts exactly the id set session-security.mjs's
 * parseNamespacedSessionId accepts at the HTTP tier, dot-segment rejection
 * included — so this guard is sound on its own and a caller reaching
 * readSession from outside the route (a CLI, an MCP tool) inherits the same
 * protection. That parity is enforced by matchSubagentId, not by these two
 * grammars being kept in step by hand: the parity claim that used to stand
 * here was false, because '.' is inside the parent charset.
 *
 * The plain grammar is deliberately NOT identical to parseSessionId's: it
 * has no '.'/'..' exclusion, because a plain id is only ever used as a
 * filename STEM (`${id}.jsonl`), where '..' yields the literal '...jsonl'.
 * Only the namespaced parent becomes a path segment, which is why only it
 * needs the check.
 *
 * @param {string} id
 * @param {IndexOptions} [o]
 */
export async function readSession(id, o = {}) {
  if (typeof id !== 'string' || (!VALID_ID.test(id) && !matchSubagentId(id))) throw invalidId(id);
  const r = { ...defaultRoots(), ...(o.roots ?? {}) };

  // opencode sessions live in the SQLite store, not a JSONL file — resolve
  // them before the file-locating path (pseudo-key opencode://<id>).
  const ocDb = o.roots === undefined ? defaultOpencodeDbPath() : (o.roots?.opencode ?? null);
  const ocExists = ocDb && fs.existsSync(ocDb)
    ? opencodeSessionExistsResult({ dbFile: ocDb, id }) : null;
  if (ocExists?.ok && ocExists.value) {
    const parsed = parseOpencodeSession({ dbFile: ocDb, id, withTurns: true });
    if (parsed) {
      const rec = parsed.session;
      rec.title = maskSecrets(rec.title);
      // deps is not optional here: an opencode row whose messages carried no
      // `cost` field keeps costObserved null by design, and sessionCost then
      // falls back to the pricer. Omitting it threw on exactly the data state
      // the null is there to represent.
      return sessionPayload(rec, parsed.turns, await loadDeps(o.deps));
    }
  }

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

  return sessionPayload(parsed.session, parsed.turns, await loadDeps(o.deps));
}
