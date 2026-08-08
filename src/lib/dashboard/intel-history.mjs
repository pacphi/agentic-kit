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

/**
 * Machine-wide rollup — folds readIntelHistory() across every project on this
 * machine that carries learning state into one totals/perProject view.
 *
 * `projects` is the learning scope of the shared census (ADR-0027,
 * src/lib/project-census.mjs): Array<{ path: string, label: string, ... }>.
 * Only `path` and `label` are read here; the census's other fields ride along
 * unread. One row per project IDENTITY, not per directory — the census folds a
 * repo's sub-directories and its ephemeral agent worktrees onto the repo root,
 * so a project is summed once here rather than two or three times.
 *
 * `path` is the directory whose .claude-flow/ tree is read, and the census
 * anchors a merged row on the path that actually carries the learning state
 * (the repo root in the ordinary case) precisely so this read lands on it.
 *
 * A project with no readable history degrades to nulls/zeros rather than
 * throwing, so widening the census can never make this scan fail — it can only
 * add rows that report nothing.
 *
 * Like readIntelHistory()'s own patternsLearned-vs-patternStore distinction,
 * this rollup keeps two DIFFERENT sums distinct at machine scope:
 *   - totals.patternsLearnedLifetime sums each project's globalStats
 *     .patternsLearned — a cumulative counter, includes patterns since
 *     pruned/compacted/replaced.
 *   - totals.patternStoreEntries sums each project's patternStore.length —
 *     entries actually present on disk right now, a smaller number for the
 *     exact same reason. Do not conflate the two.
 *
 * A project whose readIntelHistory() call turns up missing/malformed data
 * degrades that project's row to nulls/zeros (matching readIntelHistory's
 * own null-on-absent conventions) rather than throwing — one bad project
 * never aborts the whole machine-wide scan. mostActiveProject is the label
 * of whichever project has the highest globalStats.lastAdaptation among
 * projects that actually have one (a positive timestamp; 0/absent is
 * "never adapted", matching readGlobalStats' own `?? 0` default), or null
 * when no project has adaptation data. This is a plain on-demand scan with
 * no caching/TTL of its own — a later caller adds that at the server layer.
 * @param {Array<{ path: string, label: string, learningState?: string[] }>} projects
 * @returns {{
 *   totals: { patternsLearnedLifetime: number, patternStoreEntries: number,
 *     trajectoriesRecorded: number, projectCount: number,
 *     mostActiveProject: string|null },
 *   perProject: Array<{ path: string, label: string,
 *     patternsLearned: number|null, patternStoreCount: number,
 *     trajectoriesRecorded: number|null,
 *     graphLatest: { nodes: number, edges: number }|null,
 *     lastAdaptation: number|null }>
 * }}
 */
export function readMachineWideIntel(projects) {
  const list = Array.isArray(projects) ? projects : [];
  const perProject = [];
  let patternsLearnedLifetime = 0;
  let patternStoreEntries = 0;
  let trajectoriesRecorded = 0;
  let mostActiveProject = null;
  let mostActiveAdaptation = 0;

  for (const entry of list) {
    const cwd = typeof entry?.path === 'string' && entry.path ? entry.path : null;
    const label = typeof entry?.label === 'string' && entry.label.trim()
      ? entry.label
      : cwd
        ? path.basename(cwd)
        : 'unknown';

    let history = null;
    if (cwd) {
      try {
        history = readIntelHistory(cwd);
      } catch {
        history = null;
      }
    }

    const globalStats = history?.globalStats ?? null;
    const patternStore = Array.isArray(history?.patternStore) ? history.patternStore : [];
    const graph = Array.isArray(history?.graph) ? history.graph : null;

    const patternsLearned = globalStats ? globalStats.patternsLearned : null;
    const trajectories = globalStats ? globalStats.trajectoriesRecorded : null;
    const lastAdaptation = globalStats ? globalStats.lastAdaptation : null;
    const graphLatest = graph && graph.length
      ? { nodes: graph[graph.length - 1].nodes, edges: graph[graph.length - 1].edges }
      : null;

    patternsLearnedLifetime += patternsLearned ?? 0;
    patternStoreEntries += patternStore.length;
    trajectoriesRecorded += trajectories ?? 0;

    if (lastAdaptation != null && lastAdaptation > mostActiveAdaptation) {
      mostActiveAdaptation = lastAdaptation;
      mostActiveProject = label;
    }

    perProject.push({
      path: cwd,
      label,
      patternsLearned,
      patternStoreCount: patternStore.length,
      trajectoriesRecorded: trajectories,
      graphLatest,
      lastAdaptation,
      // Which learning stores the census found, carried through unread so a row
      // reading 0/0/— can say WHY: a project with .agentic-qe but no
      // .claude-flow has genuinely activated intelligence and genuinely has no
      // ruflo pattern counters, and without this the two are indistinguishable
      // from a project where the read simply failed.
      learningState: Array.isArray(entry?.learningState) ? entry.learningState : [],
    });
  }

  return {
    totals: {
      patternsLearnedLifetime,
      patternStoreEntries,
      trajectoriesRecorded,
      projectCount: list.length,
      mostActiveProject,
    },
    perProject,
  };
}
