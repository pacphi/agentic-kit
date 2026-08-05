// intel-history.mjs — readers for the "learning intelligence" history the
// dashboard's intel views chart: the neural pattern store, the reasoning
// graph's point-in-time snapshots, the machine-health ring, and the neural
// global stats counters. All four sources are files this project's own
// ruflo/agentic-qe tooling already writes under .claude-flow/ — this module
// only reads (and, for the health ring, appends to) them; it invents nothing.
//
// IMPORTANT — two metrics that look alike but are NOT the same thing:
//   - readNeuralPatternStoreHistory() counts ENTRIES actually present in
//     .claude-flow/neural/patterns.json (the pattern store on disk right now).
//   - readGlobalStats().patternsLearned is a cumulative COUNTER persisted in
//     .claude-flow/neural/stats.json (patterns learned over the store's whole
//     lifetime, including ones since pruned/compacted/replaced).
// These can legitimately diverge — the store can be pruned while the counter
// keeps climbing — and that divergence is not a bug. Do not conflate the two,
// and do not treat one as a substitute display for the other.
import path from 'node:path';
import { readJson, writeJsonWithBackup } from '../settings.mjs';

const HEALTH_RING_CAP = 500;

/** Coerce a raw createdAt value (epoch-ms number, ISO/parseable string) to an
 *  ISO-8601 string for day-bucketing by the caller. Returns null when the
 *  value can't be resolved to a real instant, so malformed entries are
 *  dropped rather than corrupting a bucket. */
function toIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Read .claude-flow/neural/patterns.json — a top-level JSON ARRAY of pattern
 * entries (NOT an object with a `patterns` key). Returns [] if the file is
 * missing, unreadable, or not shaped as an array; individual entries lacking
 * a resolvable createdAt are skipped rather than throwing.
 * @returns {Array<{ createdAt: string, type: string|null }>}
 */
export function readNeuralPatternStoreHistory(cwd) {
  const data = readJson(path.join(cwd, '.claude-flow', 'neural', 'patterns.json'));
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const createdAt = toIsoTimestamp(entry.createdAt);
    if (createdAt == null) continue;
    out.push({ createdAt, type: typeof entry.type === 'string' ? entry.type : null });
  }
  return out;
}

/**
 * Read .claude-flow/data/intelligence-snapshot.json — already a JSON array of
 * point-in-time graph samples on disk. Projects each sample down to the four
 * scalar fields the dashboard charts. Returns null if missing, unreadable, or
 * not shaped as an array, matching the null-on-absent convention readJsonSafe
 * already uses elsewhere in dashboard-server.mjs.
 * @returns {Array<{ timestamp: number, nodes: number, edges: number, pageRankSum: number }>|null}
 */
export function readGraphHistory(cwd) {
  const data = readJson(path.join(cwd, '.claude-flow', 'data', 'intelligence-snapshot.json'));
  if (!Array.isArray(data)) return null;
  return data.map((entry) => ({
    timestamp: Number(entry?.timestamp) || 0,
    nodes: Number(entry?.nodes) || 0,
    edges: Number(entry?.edges) || 0,
    pageRankSum: Number(entry?.pageRankSum) || 0,
  }));
}

/**
 * Read .claude-flow/neural/stats.json — the SAME file src/commands/status.mjs
 * reads for its 'learning' status row. Uses the shared readJson helper (the
 * same one status.mjs imports from ./settings.mjs) and the same `?? 0`
 * default logic, so the two call sites cannot drift apart.
 * @returns {{ patternsLearned: number, trajectoriesRecorded: number, signalsProcessed: number, lastAdaptation: number }|null}
 */
export function readGlobalStats(cwd) {
  const stats = readJson(path.join(cwd, '.claude-flow', 'neural', 'stats.json'));
  if (!stats) return null;
  return {
    patternsLearned: stats.patternsLearned ?? 0,
    trajectoriesRecorded: stats.trajectoriesRecorded ?? 0,
    signalsProcessed: stats.signalsProcessed ?? 0,
    lastAdaptation: stats.lastAdaptation ?? 0,
  };
}

/** The health-history ring: an array of point samples over time. Accepts
 *  either a bare array or `{ samples: [...] }`. Returns null when absent,
 *  empty, or unreadable. Moved verbatim from dashboard-server.mjs (formerly
 *  a private function there) — behavior is unchanged. */
export function readHealthRing(cwd) {
  const raw = readJson(path.join(cwd, '.claude-flow', 'health-history.json'));
  if (!raw) return null;
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw.samples) ? raw.samples : null;
  return arr && arr.length ? arr : null;
}

/** Deep-equal on plain JSON-shaped values (objects/arrays/primitives) —
 *  key-order independent, unlike a naive JSON.stringify comparison. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** Two snapshots are "the same" for dedup purposes when every field except
 *  `ts` matches. */
function sameSnapshot(a, b) {
  const { ts: _tsA, ...restA } = a ?? {};
  const { ts: _tsB, ...restB } = b ?? {};
  return deepEqual(restA, restB);
}

/**
 * Append `snapshot` to .claude-flow/health-history.json's samples ring,
 * creating the file (seeded with just this snapshot) if it doesn't exist yet.
 * A no-op — nothing is written — when `snapshot` is identical to the last
 * stored row on every field except `ts` (dedup: repeated polling of unchanged
 * stats must not grow the ring). The ring is capped at 500 entries, oldest
 * dropped first. Writes via settings.mjs's writeJsonWithBackup, which reuses
 * file-write.mjs's atomic backup-first replace rather than hand-rolling a
 * tmp-file-then-rename.
 * @returns {void}
 */
export function appendHealthSnapshot(cwd, snapshot) {
  const file = path.join(cwd, '.claude-flow', 'health-history.json');
  const raw = readJson(file);
  const existing = Array.isArray(raw) ? raw : Array.isArray(raw?.samples) ? raw.samples : [];
  const last = existing.length ? existing[existing.length - 1] : null;
  if (last && sameSnapshot(last, snapshot)) return;
  const next = [...existing, snapshot];
  const capped = next.length > HEALTH_RING_CAP ? next.slice(next.length - HEALTH_RING_CAP) : next;
  writeJsonWithBackup(file, { samples: capped });
}

/**
 * Convenience combinator — everything collectData() needs for the intel
 * history views in one call.
 */
export function readIntelHistory(cwd) {
  return {
    patternStore: readNeuralPatternStoreHistory(cwd),
    graph: readGraphHistory(cwd),
    healthRing: readHealthRing(cwd),
    globalStats: readGlobalStats(cwd),
  };
}
