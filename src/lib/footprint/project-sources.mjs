// Project sources — every project this machine has EVER had a Claude, Codex or
// OpenCode session with, de-duplicated across hosts by resolved real path.
//
// This deliberately does NOT reuse `discoverRuvfloProjects()`. That function
// answers a different question — "which projects carry ruflo learning state" —
// by requiring a `.claude-flow/neural/` directory and by reading only the 150
// most-recently-modified transcripts per host. Both narrowings are correct
// there and wrong here: on this machine they collapse 48 projects to 5. The
// Intelligence panel still depends on that meaning, so it keeps it, and the
// System area gets its own source with its own contract.
//
// Two figures come out of this and they are NOT the same number:
//   everSeen  every distinct project any host ever recorded a session in,
//             including the ones that have since been deleted or moved — the
//             deletions are the point, so they are never dropped;
//   onDisk    the subset that still resolves to a directory, i.e. the only
//             ones a byte/LOC measurement can be taken of at all.
//
// Content boundary. This is DISCOVERY, invariant 9's candidate-path source, not
// a measurement: it reads a session's cwd and explicit launch-origin declaration
// from bounded head metadata (and bounded import continuation windows). The read `native-transcript-discovery.mjs` already
// performs for Observability at the same trust boundary. No message, prompt or
// tool payload is retained or emitted; every figure the System area
// renders is measured downstream by walk.mjs-backed collectors from the paths
// this module returns.
//
// Cost. Ordinary files use HEAD_BYTES and HEAD_MAX_LINES. Import-marked
// heads additionally use codex-import-discovery's bounded head/tail windows,
// record cap and shared byte budget. Missing ranges remain explicitly unknown.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, codexDir } from '../paths.mjs';
import { resolveProjectLabel } from '../live/index.mjs';
import { withDb } from '../sqlite.mjs';
import { selectOpencodeSource } from '../usage-opencode.mjs';
import { presenceOf, statNode, UNKNOWN, walkTree } from './walk.mjs';
import { inspectProjectIdentity } from './project-identity.mjs';
import { mergeSessionSurfaces, sessionSurfaceSighting } from './session-surfaces.mjs';
import { transcriptSessionOrigin } from './session-origin.mjs';
import { isImportedCodexRollout } from '../codex-import-marker.mjs';
import { inspectCodexImport, IMPORT_SCAN_BYTES } from './codex-import-discovery.mjs';

/** Hosts in the order every payload lists them. */
export const PROJECT_SOURCE_HOSTS = Object.freeze(['claude', 'codex', 'opencode']);

/** How much of a transcript is read looking for its cwd, and how many of its
 *  leading non-blank lines are JSON-parsed. Both are budgets, not guesses: a
 *  head that carries no cwd is reported as such rather than searched further. */
export const HEAD_BYTES = 256 * 1024;
export const HEAD_MAX_LINES = 40;

/** `~/.claude/projects/<encoded>/<file>.jsonl` is 2 deep; codex rollouts are
 *  `sessions/YYYY/MM/DD/<file>.jsonl`, 4 deep. 8 leaves room for either root
 *  gaining a level without letting an unexpected tree run away. */
const TRANSCRIPT_MAX_DEPTH = 8;
const CLAUDE_NON_CONVERSATION_TYPES = new Set([
  'bridge-session', 'cost-state', 'file-history-snapshot', 'queue-operation',
  'ai-title', 'atis-latch', 'last-prompt', 'attachment', 'mode',
  'permission-mode', 'agent-name', 'agent-setting', 'system', 'progress', 'summary',
]);

/** lstat budget for one encoded-directory decode. The decode is a bounded
 *  search (below), so it needs a ceiling of its own; 512 covers a deep path
 *  with several ambiguous segments. */
const DECODE_STAT_BUDGET = 512;

/** The one-line statement of what was counted and how, so no surface can render
 *  these numbers without being able to say where they came from. */
export const PROJECT_SOURCE_METHOD =
  'eligible Claude and Codex bounded transcript cwd evidence, plus every OpenCode session '
  + 'directory, de-duplicated by resolved real path; Claude sessions use declared sessionId';

// ── transcript heads ──────────────────────────────────────────────────────────

/** Leading non-blank lines of a file's head. `null` means the file could not be
 *  read at all — distinct from an empty file, which is a real, readable zero
 *  lines. The buffer is parsed and discarded; nothing from it is retained. */
function readHeadLines(file, { fsImpl = fs, headBytes = HEAD_BYTES, maxLines = HEAD_MAX_LINES } = {}) {
  let fd;
  try { fd = fsImpl.openSync(file, 'r'); } catch { return null; }
  try {
    const size = Math.min(fsImpl.fstatSync(fd).size, headBytes);
    if (size === 0) return [];
    const buffer = Buffer.allocUnsafe(size);
    const read = fsImpl.readSync(fd, buffer, 0, size, 0);
    const lines = [];
    for (const line of buffer.toString('utf8', 0, read).split('\n')) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length >= maxLines) break;
    }
    return lines;
  } catch { return null; }
  finally { try { fsImpl.closeSync(fd); } catch { /* fd already gone */ } }
}

/**
 * The first session cwd a transcript head declares, or null.
 *
 * Claude writes a flat `record.cwd` on its own records; Codex writes
 * `record.payload.cwd` on the `session_meta` / `turn_context` records that open
 * a rollout. A line that does not parse is skipped — a truncated final line in
 * a head window is expected, not a failure.
 */
export function firstCwd(lines, host) {
  return firstSessionMetadata(lines, host).cwd;
}

const normalizedInstant = (value) => {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

function* parsedHeadRecords(lines) {
  for (const line of lines ?? []) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record && typeof record === 'object') yield record;
  }
}

function firstClaudeSessionMetadata(lines) {
  let cwd = null;
  let nativeId = null;
  let startedAt = null;
  for (const record of parsedHeadRecords(lines)) {
    if (!cwd && typeof record.cwd === 'string' && record.cwd) cwd = record.cwd;
    if (!nativeId && typeof record.sessionId === 'string' && /^\S+$/.test(record.sessionId)) nativeId = record.sessionId;
    if (!startedAt) startedAt = normalizedInstant(record.timestamp);
    if (cwd && nativeId && startedAt) break;
  }
  return { cwd, nativeId, startedAt, timeBasis: startedAt ? 'first-event' : null };
}

function firstCodexSessionMetadata(lines) {
  let cwd = null;
  let nativeId = null;
  let startedAt = null;
  let metaSeen = false;
  for (const record of parsedHeadRecords(lines)) {
    if (!cwd && ['session_meta', 'turn_context'].includes(record.type)
      && typeof record.payload?.cwd === 'string' && record.payload.cwd) cwd = record.payload.cwd;
    if (record.type === 'session_meta' && !metaSeen) {
      metaSeen = true;
      if (typeof record.payload?.id === 'string' && record.payload.id) nativeId = record.payload.id;
      startedAt = normalizedInstant(record.payload?.timestamp ?? record.timestamp);
    }
    if (cwd && nativeId && startedAt) break;
  }
  return { cwd, nativeId, startedAt, timeBasis: startedAt ? 'started' : null };
}

/**
 * Normalize privacy-safe identity fields from one bounded transcript head.
 * Native ids stay opaque; prompt text and generated titles are never retained.
 */
export function firstSessionMetadata(lines, host) {
  if (host === 'claude') return firstClaudeSessionMetadata(lines);
  if (host === 'codex') return firstCodexSessionMetadata(lines);
  return { cwd: null, nativeId: null, startedAt: null, timeBasis: null };
}

/** Read only the bounded transcript head and return its declared cwd. */
export function transcriptCwd(file, host, options = {}) {
  return firstCwd(readHeadLines(file, options), host);
}

/** Read identity, start time, and cwd from the same bounded transcript head. */
export function transcriptMetadata(file, host, options = {}) {
  return firstSessionMetadata(readHeadLines(file, options), host);
}

// ── the encoded Claude project directory ──────────────────────────────────────

/**
 * Best-effort decode of a `~/.claude/projects/` directory name back to the path
 * it encodes, used ONLY as a fallback for a project directory whose transcripts
 * carry no cwd record.
 *
 * The encoding is LOSSY: `/`, `.` and a literal `-` all become `-`, so
 * `-Users-me-ai-agentic-kit` is equally readable as `/Users/me/ai/agentic/kit`
 * and `/Users/me/ai/agentic-kit`. There is therefore no safe pure-string
 * decode, and this does not attempt one — it walks the candidate segments
 * against the real filesystem and returns a path only when the filesystem
 * confirms it. The consequence is stated rather than hidden: a project whose
 * directory is GONE cannot be recovered this way, so those groups are counted
 * as `unresolved` and make `everSeen` a lower bound instead of being guessed at.
 *
 * @param {string} name the encoded directory name
 * @param {{ fsImpl?: typeof fs, budget?: number }} [options]
 * @returns {string|null}
 */
export function decodeClaudeProjectDir(name, { fsImpl = fs, budget = DECODE_STAT_BUDGET } = {}) {
  const tokens = String(name ?? '').split('-');
  // A leading empty token is the leading `/`. Anything else (a Windows drive
  // prefix, a relative name) is not decodable here and says so by returning null.
  if (tokens[0] !== '' || tokens.length < 2) return null;
  const rest = tokens.slice(1);
  let stats = 0;
  const isDir = (target) => {
    stats += 1;
    const node = statNode(target, { fsImpl });
    return node.status !== UNKNOWN && node.kind === 'dir';
  };

  const advance = (base, index) => {
    if (stats > budget) return null;
    if (index >= rest.length) return base;
    let joined = '';
    for (let end = index; end < rest.length; end++) {
      // The separator swallowed by the encoding was either a literal `-` or a
      // `.` (a dotted directory such as `.claude`); both are tried, shortest
      // segment first, and the filesystem decides.
      for (const separator of end === index ? [''] : ['-', '.']) {
        const candidate = end === index ? rest[end] : `${joined}${separator}${rest[end]}`;
        const next = path.join(base, candidate);
        if (!isDir(next)) continue;
        const resolved = advance(next, end + 1);
        if (resolved) return resolved;
      }
      joined = joined === '' ? rest[end] : `${joined}-${rest[end]}`;
    }
    return null;
  };
  return advance(path.sep, 0);
}

// ── per-host scans ────────────────────────────────────────────────────────────

/** A walk root's health in the same vocabulary the storage collector uses: a
 *  root that does not exist is an ABSENCE (that host was never used here), not
 *  a failed measurement. */
function rootStatus(walkResult) {
  const presence = presenceOf(walkResult);
  return presence === 'present' ? 'ok' : presence;
}

function completeSessionScan(result, unreadable, unknown, imports) {
  return result.complete !== false && unreadable === 0 && unknown === 0 && imports === 0;
}

function hasCodexImports(host, lines) { return host === 'codex' && isImportedCodexRollout(lines); }

/**
 * Every cwd named by the transcripts under `root`, plus the counts a liner note
 * needs to state what was and was not recoverable.
 *
 * @param {string} root
 * @param {'claude'|'codex'} host
 * @param {{ walk?: Function, fsImpl?: typeof fs, headBytes?: number, maxLines?: number,
 *           decodeDir?: ((name: string) => string|null)|null, readHead?: Function }} [options]
 *   `decodeDir` enables the encoded-directory fallback (Claude only — Codex
 *   rollout directories are dated, not project-scoped, so there is nothing to
 *   decode).
 */
export function scanTranscriptCwds(root, host, {
  walk = walkTree, fsImpl = fs, headBytes = HEAD_BYTES, maxLines = HEAD_MAX_LINES,
  decodeDir = null, readHead = readHeadLines,
} = {}) {
  const files = [];
  const result = walk(root, {
    maxDepth: TRANSCRIPT_MAX_DEPTH,
    fsImpl,
    acceptFile: (name) => name.endsWith('.jsonl'),
    onFile: ({ file, mtimeMs }) => { files.push({ file, mtimeMs }); },
  });
  const status = rootStatus(result);
  const base = {
    host,
    root,
    status,
    reason: status === 'ok' ? null : (result.reason ?? null),
    files: 0,
    withCwd: 0,
    withoutCwd: 0,
    empty: 0,
    unreadable: 0,
    unresolved: 0,
    recoveredFromDirName: 0,
    importedExcluded: 0,
    importedMixed: 0,
    importedUnresolved: 0,
    sessions: 0,
    duplicateSessionFiles: 0,
    subagentExcluded: 0,
    nonConversationExcluded: 0,
    unknownSessionFiles: 0,
    sessionCountComplete: status === 'absent' || (status === 'ok' && result.complete !== false),
    sightings: [],
    truncated: Boolean(result.truncated),
    truncatedBy: result.truncatedBy ?? null,
    degraded: result.degraded ?? [],
    complete: result.complete !== false,
  };
  if (status !== 'ok') return { ...base, complete: status === 'absent' };

  const sightings = [];
  // Grouped by the encoded project directory so the fallback can be applied to
  // a directory as a whole: one transcript without a cwd is irrelevant while a
  // sibling has one, and only a group with NO cwd anywhere is a lost project.
  const groups = new Map();
  let withCwd = 0;
  let withoutCwd = 0;
  let empty = 0;
  let unreadable = 0;
  let importedExcluded = 0;
  let importedMixed = 0;
  let importedUnresolved = 0;
  const importBudget = { remaining: IMPORT_SCAN_BYTES };
  let duplicateSessionFiles = 0;
  let subagentExcluded = 0;
  let nonConversationExcluded = 0;
  let unknownSessionFiles = 0;
  const seenClaudeIds = new Set();
  // The walk's order is an implementation detail. File path order makes the
  // first declaration the stable owner when an id appears in multiple files.
  files.sort((a, b) => a.file.localeCompare(b.file));

  for (const { file, mtimeMs } of files) {
    const relativeParts = path.relative(root, file).split(path.sep);
    if (host === 'claude' && relativeParts.includes('subagents')) {
      subagentExcluded += 1;
      continue;
    }
    const lines = readHead(file, { fsImpl, headBytes, maxLines });
    if (lines === null) { unreadable += 1; continue; }
    if (lines.length === 0) { empty += 1; continue; }
    // Imported turns do not establish project/origin evidence. Look for own
    // activity within fixed read budgets before excluding a whole file.
    let genuineCwd = null;
    if (hasCodexImports(host, lines)) {
      const imported = inspectCodexImport(file, { fsImpl, headBytes, budget: importBudget });
      if (imported.kind === 'imported') { importedExcluded++; continue; }
      if (imported.kind === 'unresolved') { importedUnresolved++; continue; }
      importedMixed++;
      genuineCwd = imported.cwd;
    }
    let weight = 1;
    if (host === 'claude') {
      const records = [...parsedHeadRecords(lines)];
      const hasConversation = records.some((record) => record.type === 'user' || record.type === 'assistant');
      // A sideband-only head excludes a file only when the read reached EOF.
      // A later conversation may exist beyond either bounded limit.
      let fullyRead = false;
      try { fullyRead = fsImpl.statSync(file).size <= headBytes && lines.length < maxLines; }
      catch { /* the head alone does not establish an end-of-file */ }
      if (!hasConversation && (fullyRead && records.length > 0
        && records.every((record) => CLAUDE_NON_CONVERSATION_TYPES.has(record.type)))) {
        nonConversationExcluded += 1;
        continue;
      }
      const { nativeId } = firstClaudeSessionMetadata(lines);
      if (!nativeId || !hasConversation) {
        unknownSessionFiles += 1;
        weight = 0;
      } else if (seenClaudeIds.has(nativeId)) {
        duplicateSessionFiles += 1;
        continue;
      } else {
        seenClaudeIds.add(nativeId);
      }
    }
    let group = null;
    if (decodeDir) {
      const key = relativeParts[0];
      group = groups.get(key);
      if (!group) { group = { key, withCwd: false, newestMtimeMs: null }; groups.set(key, group); }
      if (Number.isFinite(mtimeMs) && (group.newestMtimeMs === null || mtimeMs > group.newestMtimeMs)) {
        group.newestMtimeMs = mtimeMs;
      }
    }
    const cwd = genuineCwd || firstCwd(lines, host);
    if (!cwd) { withoutCwd += 1; continue; }
    withCwd += 1;
    sightings.push({ cwd, mtimeMs, origin: 'cwd', weight,
      sessionOrigin: transcriptSessionOrigin(lines, host) });
    if (group) group.withCwd = true;
  }

  let unresolved = 0;
  let recoveredFromDirName = 0;
  for (const group of groups.values()) {
    if (group.withCwd) continue;
    const decoded = decodeDir(group.key);
    if (decoded) {
      recoveredFromDirName += 1;
      sightings.push({ cwd: decoded, mtimeMs: group.newestMtimeMs, origin: 'encoded-dir', weight: 0 });
    } else {
      unresolved += 1;
    }
  }

  return {
    ...base,
    files: files.length,
    withCwd,
    withoutCwd,
    empty,
    unreadable,
    unresolved,
    recoveredFromDirName,
    importedExcluded,
    importedMixed,
    importedUnresolved,
    sessions: host === 'claude' ? seenClaudeIds.size : undefined,
    duplicateSessionFiles,
    subagentExcluded,
    nonConversationExcluded,
    unknownSessionFiles,
    sessionCountComplete: completeSessionScan(result, unreadable, unknownSessionFiles, importedUnresolved),
    sightings,
    // Transcripts we could not read, and project directories whose path could
    // not be recovered, both mean the project list is a floor.
    complete: completeSessionScan(result, unreadable, unresolved, importedUnresolved),
  };
}

/**
 * OpenCode session directories. Unlike the JSONL hosts, OpenCode keeps sessions
 * in a single SQLite store whose `session` table carries the session's own
 * `directory` — an absolute path — so its projects ARE recoverable and are read
 * from there rather than guessed at. The store is opened READ-ONLY and only
 * that one column is selected.
 *
 * An absent selected store contributes no observed projects;
 * a store that will not open, or an older schema without `directory`, is
 * reported degraded with its reason rather than silently contributing nothing.
 */
export function scanOpencodeDirectories({ dbFile = undefined, selection = selectOpencodeSource(dbFile === undefined ? {} : { roots: { opencode: dbFile } }), withDb: withDbImpl = withDb } = {}) {
  dbFile = selection.dbFile;
  const base = { host: 'opencode', root: dbFile, status: 'ok', reason: null, sessions: 0, sightings: [], complete: true };
  if (!dbFile) return { ...base, ...selection.health, complete: selection.health.status === 'absent' };
  const result = withDbImpl(dbFile, (db) => db.prepare(
    'SELECT directory, COUNT(*) AS sessions, MAX(COALESCE(time_updated, time_created)) AS lastMs'
    + " FROM session WHERE directory IS NOT NULL AND directory <> '' GROUP BY directory",
  ).all());
  if (!result.ok) {
    const absent = result.error?.kind === 'absent';
    return {
      ...base,
      status: absent ? 'absent' : 'degraded',
      reason: absent ? null : (result.error?.kind ?? 'store-unreadable'),
      complete: absent,
    };
  }
  const sightings = [];
  let sessions = 0;
  for (const row of result.value ?? []) {
    const count = Number(row?.sessions) || 0;
    sessions += count;
    const lastMs = Number(row?.lastMs);
    sightings.push({
      cwd: row?.directory,
      mtimeMs: Number.isFinite(lastMs) ? lastMs : null,
      origin: 'cwd',
      weight: count,
    });
  }
  return { ...base, sessions, sightings };
}

// ── assembly ──────────────────────────────────────────────────────────────────

/** Canonicalize for de-dup so one project touched by two hosts, or reached
 *  through a symlink, is ONE project. Falls back to path.resolve when the target
 *  cannot be realpath'd — a deleted project has no real path, and it must still
 *  be counted. */
function resolvePath(candidate, fsImpl) {
  try { return (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(candidate); }
  catch { return path.resolve(candidate); }
}

/** Observability's label for the same path, so a project reads identically in
 *  both areas; the bare directory name when that cannot be derived. */
function labelFor(resolveLabel, resolved) {
  try {
    const label = resolveLabel(resolved);
    if (typeof label === 'string' && label && label !== 'unknown') return label;
  } catch { /* fall through to the basename */ }
  return path.basename(resolved) || resolved;
}

/** A `.git` DIRECTORY is a repository; a `.git` FILE is a linked worktree, which
 *  is equally a repository. Checking only for a directory would undercount every
 *  worktree on the machine. */
function gitPresence(projectPath, fsImpl) {
  const node = statNode(path.join(projectPath, '.git'), { fsImpl });
  return node.status !== UNKNOWN && (node.kind === 'dir' || node.kind === 'file');
}

/**
 * Every project any host has ever recorded a session in.
 *
 * @param {{ claudeRoot?: string, codexRoot?: string, opencodeDbFile?: string,
 *           walk?: Function, fsImpl?: typeof fs, now?: () => number,
 *           resolveLabel?: Function, scanTranscripts?: Function,
 *           scanOpencode?: Function, headBytes?: number, maxLines?: number,
 *           decodeEncodedDirs?: boolean }} [options]
 * @returns {{
 *   asOf: number,
 *   projects: Array<{ path: string, label: string, hosts: string[], origins: string[],
 *                     exists: boolean, isGitRepo: boolean, lastSeenMs: number|null,
 *                     sessions: number }>,
 *   everSeen: number, onDisk: number, gitRepos: number, unresolved: number,
 *   importedExcluded: number, importedMixed: number, importedUnresolved: number,
 *   complete: boolean, method: string,
 *   sources: Record<'claude'|'codex'|'opencode', object>,
 * }} `everSeen` counts projects INCLUDING vanished ones; `onDisk` counts the
 *   measurable subset. `complete: false` means at least one transcript or
 *   project directory could not be resolved, so both counts are lower bounds.
 *   `importedExcluded` counts Codex rollouts that are imported copies of Claude
 *   Code transcripts, which name no project.
 */
export function discoverProjectSources({
  claudeRoot = path.join(claudeDir(), 'projects'),
  codexRoot = path.join(codexDir(), 'sessions'),
  opencodeDbFile,
  walk = walkTree,
  fsImpl = fs,
  now = Date.now,
  resolveLabel = resolveProjectLabel,
  scanTranscripts = scanTranscriptCwds,
  scanOpencode = scanOpencodeDirectories,
  headBytes = HEAD_BYTES,
  maxLines = HEAD_MAX_LINES,
  decodeEncodedDirs = true,
} = {}) {
  const asOf = now();
  const transcriptOpts = { walk, fsImpl, headBytes, maxLines };
  const sources = {
    claude: scanTranscripts(claudeRoot, 'claude', {
      ...transcriptOpts,
      decodeDir: decodeEncodedDirs ? (name) => decodeClaudeProjectDir(name, { fsImpl }) : null,
    }),
    codex: scanTranscripts(codexRoot, 'codex', transcriptOpts),
    opencode: scanOpencode({ dbFile: opencodeDbFile }),
  };

  const byPath = new Map();
  for (const host of PROJECT_SOURCE_HOSTS) {
    for (const sighting of sources[host]?.sightings ?? []) {
      const cwd = sighting?.cwd;
      if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) continue;
      const resolved = resolvePath(cwd, fsImpl);
      let row = byPath.get(resolved);
      if (!row) {
        row = { path: resolved, hosts: new Set(), origins: new Set(), sessionOrigins: new Map(), sessionSurfaces: [], sessions: 0, lastSeenMs: null };
        byPath.set(resolved, row);
      }
      row.hosts.add(host);
      row.origins.add(sighting.origin ?? 'cwd');
      const weight = sighting.origin === 'encoded-dir' ? 0
        : Number.isFinite(sighting.weight) ? sighting.weight : 1;
      row.sessions += weight;
      const declared = sighting.sessionOrigin;
      const origin = ['claude-desktop', 'codex-desktop'].includes(declared?.origin)
        && declared.origin.startsWith(`${host}-`) ? declared.origin : 'unknown';
      let membership = row.sessionOrigins.get(origin);
      if (!membership) {
        membership = { origin, sessions: 0, evidence: new Set(), countBases: new Set() };
        row.sessionOrigins.set(origin, membership);
      }
      membership.sessions += weight;
      row.sessionSurfaces.push(sessionSurfaceSighting(sighting, host, weight));
      membership.countBases.add(sighting.origin === 'encoded-dir' ? 'recovered-project-sighting'
        : host === 'opencode' ? 'database-sessions' : host === 'claude' ? 'declared-session-ids' : 'transcript-files');
      membership.evidence.add(origin === 'unknown' ? 'desktop-origin-not-declared' : declared.evidence);
      const at = sighting.mtimeMs;
      if (Number.isFinite(at) && (row.lastSeenMs === null || at > row.lastSeenMs)) row.lastSeenMs = at;
    }
  }

  const projects = [...byPath.values()].map((row) => {
    const node = statNode(row.path, { fsImpl });
    const exists = node.status !== UNKNOWN && node.kind === 'dir';
    return {
      path: row.path,
      label: labelFor(resolveLabel, row.path),
      hosts: PROJECT_SOURCE_HOSTS.filter((host) => row.hosts.has(host)),
      origins: [...row.origins].sort(),
      exists,
      // A path that is gone is not a repository and is not "not a repository"
      // either — but `false` is the only honest reading available, and `exists`
      // sits next to it so no consumer can mistake the two.
      isGitRepo: exists && gitPresence(row.path, fsImpl),
      lastSeenMs: row.lastSeenMs,
      sessions: row.sessions,
      sessionSurfaces: mergeSessionSurfaces(row.sessionSurfaces),
      sessionOrigins: [...row.sessionOrigins.values()].map((entry) => ({
        origin: entry.origin, sessions: entry.sessions, evidence: [...entry.evidence].filter(Boolean).sort(),
        countBasis: entry.countBases.size === 1 ? [...entry.countBases][0] : 'mixed-observations',
      })).sort((a, b) => a.origin.localeCompare(b.origin)),
      repository: inspectProjectIdentity(row.path, { fsImpl, observedAt: asOf }),
    };
  });
  // Most-recently-seen first; a project with no usable timestamp sorts last but
  // is never dropped, and the path tiebreak keeps the order stable.
  projects.sort((a, b) => (b.lastSeenMs ?? -1) - (a.lastSeenMs ?? -1) || a.path.localeCompare(b.path));

  const unresolved = PROJECT_SOURCE_HOSTS
    .reduce((total, host) => total + (sources[host]?.unresolved ?? 0), 0);
  const importedExcluded = PROJECT_SOURCE_HOSTS
    .reduce((total, host) => total + (sources[host]?.importedExcluded ?? 0), 0);
  return {
    asOf,
    projects,
    everSeen: projects.length,
    onDisk: projects.filter((project) => project.exists).length,
    gitRepos: projects.filter((project) => project.isGitRepo).length,
    unresolved,
    importedExcluded,
    importedMixed: sources.codex?.importedMixed ?? 0,
    importedUnresolved: sources.codex?.importedUnresolved ?? 0,
    complete: PROJECT_SOURCE_HOSTS.every((host) => sources[host]?.complete !== false),
    method: PROJECT_SOURCE_METHOD,
    sources,
  };
}
