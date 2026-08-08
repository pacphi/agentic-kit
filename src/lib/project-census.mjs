// project-census.mjs — the ONE answer to "what projects does this machine have",
// shared by Overview, Usage, Observability and System (ADR-0027).
//
// ── Why this module exists ──────────────────────────────────────────────────
// Four surfaces used to answer that question four different ways, from four
// different sources, with four different naming rules, and reported four
// different numbers for the same machine: Intelligence said 4, Observability
// said 14, the Usage scorecard said 14 (of a different 14), and System measured
// ~48. Nothing was wrong with any single number; what was wrong is that a user
// had no way to know which question each was answering.
//
// This module does not make those numbers identical, because they are answers
// to genuinely different questions and forcing them together would replace an
// honest inconsistency with a dishonest consistency. It makes them all derive
// from ONE census with ONE identity rule, and it names the filter each surface
// applies, so every count can say what it counted and why it differs.
//
// ── The census ──────────────────────────────────────────────────────────────
// The census itself is discoverProjectSources() (footprint/project-sources.mjs),
// reused verbatim rather than reimplemented. It is already the widest and most
// carefully bounded of the four: it reads exactly one field (the session `cwd`)
// out of the head of every Claude and Codex transcript plus the OpenCode session
// store, dedupes by resolved real path, and reports three deliberately distinct
// figures — everSeen / onDisk / gitRepos — instead of one lossy total.
//
// ── The filters ─────────────────────────────────────────────────────────────
// Each surface names its scope rather than hardcoding a predicate:
//
//   everSeen  every project any host ever recorded a session in, including ones
//             since deleted. The System area's lifetime census.
//   onDisk    the subset that still resolves — the only projects a byte or
//             line measurement can be taken of at all.
//   gitRepos  the on-disk subset under version control.
//   learning  the on-disk subset with memory/intelligence state on disk (see
//             hasLearningState). What the Intelligence panel aggregates.
//
// A count is always reported with its scope, via describeScope() — that string
// is the whole point of this module and no surface should render a project
// count without one.
import fs from 'node:fs';
import path from 'node:path';
import { discoverProjectSources } from './footprint/project-sources.mjs';
import { resolveProjectIdentity } from './live/project-label.mjs';

/** Directories that mean "memory/intelligence has been activated in this
 *  project". Deliberately the SAME list storage.mjs already treats as a
 *  project's learning stores (defaultStorageRoots), so the Intelligence panel
 *  and the Storage panel cannot disagree about what a learning store is.
 *  Order is the order they are reported in. */
export const LEARNING_MARKERS = Object.freeze([
  { dir: '.claude-flow', what: 'ruflo learning state' },
  { dir: '.agentic-qe', what: 'agentic-qe state' },
  { dir: '.swarm', what: 'swarm memory' },
]);

export const CENSUS_SCOPES = Object.freeze(['everSeen', 'onDisk', 'gitRepos', 'learning']);

/**
 * Which learning stores a project actually carries. Returns the marker dirs
 * present, so a caller can say WHICH kind of state was found rather than only
 * that some was.
 *
 * This is deliberately broader than the `.claude-flow/neural/` check it
 * replaces. That check answered "has ruflo trained here", which silently
 * excluded every project whose memory came from agentic-qe or swarm storage,
 * and every project driven by a host other than Claude — so the Intelligence
 * panel under-reported the machine by roughly an order of magnitude. The
 * question the panel actually asks is "has memory/intelligence been activated
 * here, by anything", and that is what this answers.
 */
export function learningStateOf(projectPath, { fsImpl = fs } = {}) {
  if (typeof projectPath !== 'string' || !projectPath) return [];
  return LEARNING_MARKERS
    .filter((m) => {
      try { return fsImpl.statSync(path.join(projectPath, m.dir)).isDirectory(); }
      catch { return false; }
    })
    .map((m) => m.dir);
}

/** True when a project carries any learning state at all. */
export function hasLearningState(projectPath, opts) {
  return learningStateOf(projectPath, opts).length > 0;
}

/**
 * The machine census, with each project annotated by the scopes it belongs to.
 *
 * `discover` is injectable so tests (and callers that already hold a census)
 * need not re-walk the transcript corpus; everything else is a pass-through to
 * discoverProjectSources.
 *
 * @returns the discoverProjectSources payload, plus `learning` (a count) and a
 *   `learningState` array on every project row.
 */
export function projectCensus({ discover = discoverProjectSources, fsImpl = fs, ...opts } = {}) {
  const census = discover({ fsImpl, ...opts });
  const projects = census.projects.map((p) => {
    // A path that is gone cannot be probed; [] is the only honest reading, and
    // `exists` sits beside it so no consumer can confuse "no learning state"
    // with "could not look".
    const learningState = p.exists ? learningStateOf(p.path, { fsImpl }) : [];
    // The identity key groups every DIRECTORY that belongs to one project — a
    // sub-directory a session happened to run in, and an agent worktree under
    // .claude/worktrees/, are the same project as the repo root.
    return { ...p, learningState, identityKey: identityKeyOf(p.path) };
  });
  return {
    ...census,
    projects,
    // Counted over identities, not directories, so it agrees with the length of
    // projectsInScope(census, 'learning'). The directory-level everSeen/onDisk/
    // gitRepos above are left exactly as discoverProjectSources reports them —
    // the System area measures directories on purpose (ADR-0025).
    learning: mergeByIdentity(projects.filter((p) => p.learningState.length > 0)).length,
  };
}

function identityKeyOf(projectPath) {
  try { return resolveProjectIdentity(projectPath).key; }
  catch { return `path:${projectPath}`; }
}

/**
 * Collapse directory rows onto one row per project identity.
 *
 * This is the whole reason identity is shared. Three of this machine's projects
 * are recorded at three paths each — the repo root, a sub-directory a session
 * ran in, and an ephemeral `.claude/worktrees/agent-*` — and a picker keyed by
 * identity would silently make two of every three unreachable, because they all
 * resolve to the same key. Directories are what the census discovers; projects
 * are what a user picks.
 *
 * The surviving row is anchored on the path that actually carries the learning
 * state (the repo root in the ordinary case), because that is the path
 * readIntelHistory() will read. `paths` keeps every contributing directory so a
 * surface can show what was folded together rather than hiding it.
 */
function mergeByIdentity(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const existing = byKey.get(row.identityKey);
    if (!existing) { byKey.set(row.identityKey, { ...row, paths: [row.path] }); continue; }
    existing.paths.push(row.path);
    existing.hosts = [...new Set([...(existing.hosts ?? []), ...(row.hosts ?? [])])];
    existing.learningState = [...new Set([...(existing.learningState ?? []), ...(row.learningState ?? [])])];
    existing.sessions = (existing.sessions ?? 0) + (row.sessions ?? 0);
    if ((row.lastSeenMs ?? -1) > (existing.lastSeenMs ?? -1)) existing.lastSeenMs = row.lastSeenMs;
    // Prefer the shallowest path that carries learning state: a repo root over
    // one of its sub-directories, and never an ephemeral agent worktree when a
    // real root is available.
    const better = row.learningState.length > 0 && row.path.length < existing.path.length;
    if (better) { existing.path = row.path; existing.label = row.label; existing.isGitRepo = row.isGitRepo; }
  }
  for (const row of byKey.values()) row.paths.sort();
  return [...byKey.values()];
}

/** Projects in one scope, most-recently-seen first.
 *
 *  `everSeen`/`onDisk`/`gitRepos` are DIRECTORY scopes — they are what the
 *  System area measures, and folding them would destroy the per-directory byte
 *  and line figures that area exists to report. `learning` is a PROJECT scope,
 *  because the Intelligence panel aggregates a project's learning wherever it
 *  was recorded and offers it as one pickable thing. */
export function projectsInScope(census, scope) {
  const rows = census?.projects ?? [];
  if (scope === 'everSeen') return rows;
  if (scope === 'onDisk') return rows.filter((p) => p.exists);
  if (scope === 'gitRepos') return rows.filter((p) => p.isGitRepo);
  if (scope === 'learning') {
    const merged = mergeByIdentity(rows.filter((p) => p.learningState?.length > 0));
    return merged.sort((a, b) => (b.lastSeenMs ?? -1) - (a.lastSeenMs ?? -1) || a.path.localeCompare(b.path));
  }
  return [];
}

// How each scope narrows the census, in the user's words. Rendered next to
// every project count so two different numbers on two different tabs read as
// two different questions instead of a bug.
const SCOPE_NOTE = {
  everSeen: 'every project any host has ever recorded a session in, including ones since deleted',
  onDisk: 'the projects that still exist on disk — the only ones that can be measured',
  gitRepos: 'the projects on disk that are git repositories',
  learning: 'the projects on disk with memory or intelligence state (.claude-flow, .agentic-qe or .swarm), whichever host created it',
};

/**
 * One sentence explaining a count: what was counted, and how it narrows the
 * census. `windowLabel` names a time window when the surface applies one — the
 * remaining honest reason two counts can differ once identity is shared.
 */
export function describeScope(scope, { windowLabel = null } = {}) {
  const note = SCOPE_NOTE[scope];
  if (!note) return '';
  return windowLabel ? `${note}, active in the last ${windowLabel}` : note;
}
