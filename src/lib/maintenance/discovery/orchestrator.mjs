// ADR-0048 scan orchestrator — the resumable, checkpointed state machine that
// turns a discovery source into published SourceCoverage, built as an
// orchestration layer OVER ADR-0047's streaming observation forest rather
// than a competing crawler (docs/MAINTENANCE.md "Work slices and safety ceilings").
//
// A PARTITION (see partitions.mjs) is the atomic unit of resumable work: the
// injected `walk` primitive (walkTree) has no external resume cursor, so the
// smallest safely-checkpointable boundary is "one bounded partition finished."
// `workSlice` bounds how many partitions run before yielding control back to
// the event loop for responsiveness — it never ends a valid scan (MNT-DSC-011).
import fs from 'node:fs';
import path from 'node:path';

import { observeWalkForest } from '../../footprint/observation-forest.mjs';
import { walkTree, WALK_LIMITS } from '../../footprint/walk.mjs';
import { opaqueId, SCAN_TRANSITIONS } from '../management/model.mjs';
import { exclusionAppliesTo } from './configuration.mjs';
import {
  contextDigest, validateForResume,
} from './checkpoint.mjs';
import { coverageFor } from './coverage.mjs';
import { mergeWalkResults, partitionDrifted, partitionSpecs, planPartitions } from './partitions.mjs';
import {
  describeProjects, isRootItselfAProject, projectDetectionSpec, projectIdentity,
} from './project-detection.mjs';

const DEFAULT_WORK_SLICE = Object.freeze({ entries: 20_000, ms: 250 });
const DEFAULT_CEILINGS = Object.freeze({ entries: Infinity, depth: WALK_LIMITS.maxDepth });
const DEFAULT_RETRY_POLICY = Object.freeze({ maxRestarts: 3 });
const TERMINAL_STATES = new Set(['published', 'stopped']);
const PAUSABLE_STATES = new Set(['queued', 'scanning', 'checkpointed']);

function defaultYield(callback) { setImmediate(callback); }
function onceYielded(yieldFn) { return new Promise((resolve) => yieldFn(resolve)); }

const HALTED_STATES = new Set(['paused', 'stopped', 'failed']);

/** Drop the top-level directories a source's curated policy never walks —
 *  by NAME, before any I/O — and record them as coverage evidence. A grouped
 *  partition keeps its remaining targets; an emptied partition disappears. */
function applyCuratedSkips(record, partitions) {
  if (!record.skipDirs.length) return partitions;
  const skipped = new Set();
  const kept = [];
  for (const partition of partitions) {
    if (partition.kind === 'root-files') { kept.push(partition); continue; }
    const targets = partition.targets.filter((target) => {
      const name = path.basename(target);
      if (!record.skipDirs.includes(name)) return true;
      skipped.add(name);
      return false;
    });
    if (targets.length) kept.push({ ...partition, targets });
  }
  record.curatedSkips = [...skipped].sort();
  return kept;
}

/** Depth is bounded per partition: a child partition already sits one level
 *  below the source root, so a source-level `maxDepth` shrinks by one there. */
function partitionDepthLimit(record, partition, ceilingDepth) {
  if (!Number.isFinite(record.maxDepth)) return ceilingDepth;
  const offset = partition.kind === 'root-files' ? 0 : 1;
  return Math.max(0, Math.min(ceilingDepth, record.maxDepth - offset));
}

function initRecord(source) {
  return {
    sourceId: source.sourceId, environmentId: source.environmentId, root: source.root,
    kind: source.kind, label: source.label,
    // Curated, source-level traversal policy (MNT-DSC exclusions are part of
    // coverage evidence): top-level directory NAMES this source never walks
    // (transcripts, caches, session state) and a per-source depth bound.
    skipDirs: Array.isArray(source.skipDirs) ? [...source.skipDirs] : [],
    maxDepth: Number.isFinite(source.maxDepth) ? source.maxDepth : null,
    curatedSkips: [],
    scanState: 'configured', scanId: null, scanEpoch: 0, restarts: 0, createdAt: null,
    completedPartitions: [], pendingPartitions: [],
    visited: 0, estimated: null, limitingReason: null, ceiling: null, lastCompletedAt: null,
    // Bounded project sightings for THIS source, deduped by resolved absolute
    // root — see `addProjectSighting`. Never exposed as-is: `projects()`/
    // `projectRoots()` post-process this into the public/private shapes.
    projects: [],
  };
}

/** Add a discovered project, deduping by its resolved absolute path so a
 *  root re-found via more than one detection path (e.g. a linked worktree
 *  whose `.git` file is also caught by the one-time root-itself check) is
 *  recorded once. */
function addProjectSighting(record, sighting) {
  const absoluteRoot = path.resolve(sighting.absoluteRoot);
  if (record.projects.some((entry) => entry.absoluteRoot === absoluteRoot)) return;
  record.projects.push({ ...sighting, absoluteRoot });
}

function transition(record, next) {
  const allowed = SCAN_TRANSITIONS[record.scanState] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`illegal scan transition for ${record.sourceId}: ${record.scanState} -> ${next}`);
  }
  record.scanState = next;
}

function sourceIdentityDigest(record) {
  return contextDigest({ sourceId: record.sourceId, root: record.root, kind: record.kind });
}

function toCoverageRecord(record) {
  return {
    curatedSkips: record.curatedSkips,
    curatedDepthBounded: record.curatedDepthBounded === true,
    sourceId: record.sourceId, environmentId: record.environmentId, scanState: record.scanState,
    visited: record.visited, estimated: record.estimated,
    completedPartitions: record.completedPartitions.length, pendingPartitions: record.pendingPartitions.length,
    limitingReason: record.limitingReason, ceiling: record.ceiling, lastCompletedAt: record.lastCompletedAt,
    label: record.label,
  };
}

function toSummary(record, now) {
  return {
    scanId: record.scanId, sourceId: record.sourceId, environmentId: record.environmentId,
    state: record.scanState, startedAt: record.createdAt, completedAt: new Date(now()).toISOString(),
    visited: record.visited, limitingReason: record.limitingReason, ceiling: record.ceiling ?? null,
  };
}

function findCheckpointForSource(checkpointStore, sourceId) {
  let best = null;
  for (const scanId of checkpointStore.list()) {
    const checkpoint = checkpointStore.read(scanId);
    if (checkpoint?.sourceId === sourceId && (!best || checkpoint.scanEpoch > best.scanEpoch)) best = checkpoint;
  }
  return best;
}

/** Run one partition's bounded walk(s), decrementing a shared entry budget
 *  across a grouped partition's targets so the GLOBAL ceiling is never
 *  overshot by a multi-target group. Returns the merged WalkResult counters
 *  plus `limitingReason` when the budget (or a depth cap) cut it short.
 *
 * The project-detection query rides the SAME physical traversal as the
 * generic entry-counting one (one `observeWalkForest` call, two virtual
 * queries) — the real scan can find repositories at zero extra I/O cost,
 * using the identical skipDir-based detector preview.mjs uses. */
function walkPartition(partition, {
  walk, fsImpl, budget, maxDepth, skipDir, exclusions, includeSubmodules, onProject,
}) {
  const mapped = partitionSpecs(partition, [
    { maxDepth, fsImpl, skipDir },
    projectDetectionSpec({
      fsImpl, exclusions, includeSubmodules, onProject,
    }),
  ]);
  const results = [];
  let remaining = budget;
  let budgetExhausted = false;
  for (const { target, specs } of mapped) {
    if (remaining <= 0) { budgetExhausted = true; break; }
    const bounded = specs.map((spec) => ({ ...spec, maxEntries: remaining }));
    const [result] = observeWalkForest(target, bounded, { walk, fsImpl });
    results.push(result);
    remaining -= result.entriesSeen;
    if (result.truncated && result.truncatedBy === 'entries') { budgetExhausted = true; break; }
  }
  const merged = mergeWalkResults(results);
  const depthCapped = results.some((result) => result.truncatedBy === 'depth');
  const limitingReason = budgetExhausted ? 'entries' : (depthCapped ? 'depth' : null);
  return { ...merged, complete: merged.complete && !limitingReason, limitingReason };
}

function remainingEntryBudget(ceilingEntries, visited) {
  if (!Number.isFinite(ceilingEntries)) return WALK_LIMITS.maxEntries;
  return Math.max(0, ceilingEntries - visited);
}

/**
 * @typedef {{ write: (checkpoint: object) => object, read: (scanId: string) => object|null,
 *   remove: (scanId: string) => void, list: () => string[] }} CheckpointStore
 * @typedef {{ recordSummary: (summary: object) => any }} HistoryStore
 * @typedef {{ write: (entry: object) => boolean,
 *   current: () => Array<{sourceId: string, environmentId: string}> }} LastGoodStore
 * @typedef {{ writeProjects: (sourceId: string, projects: object[]) => void,
 *   readProjects: (sourceId: string) => object[]|null,
 *   writeRoots: (sourceId: string, entries: Array<{projectId:string, root:string}>) => void,
 *   readRoots: (sourceId: string) => Map<string,string> }} ProjectEvidenceStore
 *
 * @param {{ configuration: { listSources: () => Array<{sourceId: string, kind: string,
 *   root: string, environmentId: string, label: string}> }, checkpointStore: CheckpointStore,
 *   historyStore?: HistoryStore|null, lastGoodStore?: LastGoodStore|null,
 *   projectStore?: ProjectEvidenceStore|null, walk?: Function,
 *   fsImpl?: typeof fs, now?: () => number, yieldFn?: (cb: Function) => void,
 *   workSlice?: {entries:number, ms:number}, ceilings?: {entries:number, depth:number},
 *   retryPolicy?: {maxRestarts:number}, installationKey: string,
 *   exclusions?: Array<{path:string, recursive:boolean}>, observationContractVersions?: object,
 *   maxFanout?: number, includeSubmodules?: boolean, onEvent?: (event: object) => void }} options
 */
export function createScanOrchestrator({
  configuration, checkpointStore, historyStore = null, lastGoodStore = null, projectStore = null,
  walk = walkTree, fsImpl = fs, now = Date.now, yieldFn = defaultYield,
  workSlice = DEFAULT_WORK_SLICE, ceilings = DEFAULT_CEILINGS, retryPolicy = DEFAULT_RETRY_POLICY,
  installationKey, exclusions = [], observationContractVersions = { walk: 1, observationForest: 1 },
  maxFanout = 64, includeSubmodules = false, onEvent = () => {},
}) {
  if (typeof installationKey !== 'string' || installationKey.length < 16) {
    throw new TypeError('createScanOrchestrator requires an installationKey');
  }
  const records = new Map();
  const exclusionsDigest = contextDigest(exclusions);
  const safetyPolicyDigest = contextDigest({ ceilings, retryPolicy, workSlice });
  const skipDir = (dir) => exclusionAppliesTo({ exclusions }, dir);

  function loadOrInitRecord(source) {
    let record = records.get(source.sourceId);
    if (record) return record;
    record = initRecord(source);
    const checkpoint = findCheckpointForSource(checkpointStore, source.sourceId);
    if (checkpoint) applyCheckpoint(record, checkpoint);
    records.set(source.sourceId, record);
    return record;
  }

  function applyCheckpoint(record, checkpoint) {
    const validation = validateForResume(checkpoint, {
      sourceIdentityDigest: sourceIdentityDigest(record),
      environmentId: record.environmentId,
      exclusionsDigest,
      contractVersions: observationContractVersions,
      safetyPolicyDigest,
    });
    onEvent({ type: 'ScanProgressCheckpointed', sourceId: record.sourceId, resumed: validation.valid, reason: validation.reason });
    if (!validation.valid) return;
    record.scanId = checkpoint.scanId;
    record.scanEpoch = checkpoint.scanEpoch;
    record.completedPartitions = checkpoint.completedPartitions;
    record.pendingPartitions = checkpoint.pendingPartitions;
    record.visited = checkpoint.workCounts?.visited ?? 0;
    record.createdAt = checkpoint.createdAt;
    record.projects = Array.isArray(checkpoint.discoveredProjects) ? checkpoint.discoveredProjects : [];
    record.scanState = 'checkpointed';
  }

  /** A partitioned scan never re-visits the source root's OWN directory entry
   *  with detection active (the root-files partition forces skipDir off — see
   *  partitions.mjs), so an exact-project source whose root IS itself a git
   *  checkout would otherwise never be recorded. Idempotent: safe to call on
   *  every drive, deduped by `addProjectSighting`. */
  function detectRootProject(record) {
    const { isProject, worktree, submodule, mainRepoRoot } = isRootItselfAProject(record.root, { fsImpl, includeSubmodules });
    if (isProject) addProjectSighting(record, { absoluteRoot: record.root, worktree, submodule, mainRepoRoot });
  }

  function ensurePlanned(record) {
    // A `failed` record is REPLANNED exactly like a fresh `configured` one —
    // the whole point of retrying (SCAN_TRANSITIONS.failed -> ['queued']) is
    // that whatever made the root unlistable may no longer be true, so the
    // stale `planReadFailure` from the earlier attempt must never survive
    // unexamined into this drive.
    if (record.scanState === 'configured' || record.scanState === 'failed') {
      const plan = planPartitions(record.root, { fsImpl, maxFanout });
      record.pendingPartitions = applyCuratedSkips(record, plan.partitions);
      record.completedPartitions = [];
      record.scanEpoch += 1;
      record.scanId = opaqueId('scn', { sourceId: record.sourceId, scanEpoch: record.scanEpoch }, installationKey);
      record.createdAt = new Date(now()).toISOString();
      // `plan.partitions` is empty ONLY when the root itself could not be
      // listed (ENOENT/EACCES/…) — an empty-but-readable root still yields a
      // root-files partition and reaches `complete` normally. Recorded here,
      // not thrown, so `driveSource` can finalize it as a real terminal state
      // instead of leaving the record stuck in `scanning` forever (the exact
      // stalled-scan failure mode this orchestrator exists to remove).
      record.planReadFailure = plan.partitions.length === 0 ? (plan.reason ?? 'io') : null;
      transition(record, 'queued');
    }
    if (['queued', 'paused', 'checkpointed'].includes(record.scanState)) transition(record, 'scanning');
    detectRootProject(record);
  }

  /** @param {string} reason */
  function finalizeFailed(record, reason) {
    const limitingReason = reason === 'EACCES' || reason === 'EPERM' ? 'permission-denied' : 'io-failure';
    transition(record, 'failed');
    record.limitingReason = limitingReason;
    record.ceiling = null;
    historyStore?.recordSummary(toSummary(record, now));
    if (record.scanId) checkpointStore.remove(record.scanId);
    onEvent({
      type: 'DiscoverySourceStopped', sourceId: record.sourceId, state: 'failed', limitingReason,
    });
  }

  function persistCheckpoint(record) {
    checkpointStore.write({
      scanId: record.scanId, sourceId: record.sourceId, environmentId: record.environmentId,
      scanEpoch: record.scanEpoch, observationContractVersions,
      completedPartitions: record.completedPartitions, pendingPartitions: record.pendingPartitions,
      boundedTraversalCursors: [], workCounts: { visited: record.visited },
      sourceStamps: record.completedPartitions.flatMap((partition) => partition.sourceStamps),
      discoveredProjects: record.projects,
      sourceIdentityDigest: sourceIdentityDigest(record), exclusionsDigest, safetyPolicyDigest,
      createdAt: record.createdAt,
    });
  }

  function finalizeStopped(record, limitingReason, ceiling) {
    transition(record, 'stopped');
    record.limitingReason = limitingReason;
    record.ceiling = ceiling;
    historyStore?.recordSummary(toSummary(record, now));
    if (record.scanId) checkpointStore.remove(record.scanId);
    onEvent({ type: 'DiscoverySourceStopped', sourceId: record.sourceId, limitingReason, ceiling });
  }

  /** Final validation before publishing: re-stat every completed partition.
   *  A drifted one is requeued (smallest first) up to `retryPolicy.maxRestarts`,
   *  after which the source stops with a factual changing-source result. */
  function finalizeIfComplete(record) {
    const drifted = record.completedPartitions.filter((partition) => partitionDrifted(partition, { fsImpl }));
    if (drifted.length) {
      if (record.restarts >= retryPolicy.maxRestarts) { finalizeStopped(record, 'source-changed', null); return 'stopped'; }
      const [smallest] = [...drifted].sort((a, b) => a.targets.length - b.targets.length);
      record.completedPartitions = record.completedPartitions.filter((partition) => partition !== smallest);
      record.pendingPartitions = [smallest, ...record.pendingPartitions];
      record.restarts += 1;
      return 'requeued';
    }
    transition(record, 'complete');
    transition(record, 'published');
    record.lastCompletedAt = new Date(now()).toISOString();
    record.limitingReason = null;
    record.ceiling = null;
    lastGoodStore?.write(coverageFor(toCoverageRecord(record)));
    historyStore?.recordSummary(toSummary(record, now));
    persistProjectEvidence(record, true);
    checkpointStore.remove(record.scanId);
    onEvent({ type: 'ScanCompleted', sourceId: record.sourceId });
    return 'published';
  }

  /** Only ever called with `complete: true` (the last-good-snapshot rule): a
   *  partial or failed run is never persisted, so it can never overwrite the
   *  last complete project evidence for this source. */
  function persistProjectEvidence(record, complete) {
    if (!projectStore) return;
    const publicList = describeProjects(record.projects, { sourceRoot: record.root, installationKey, complete, fsImpl });
    projectStore.writeProjects(record.sourceId, publicList);
    const roots = record.projects.map((entry) => ({
      projectId: projectIdentity(entry.absoluteRoot, installationKey), root: entry.absoluteRoot,
    }));
    projectStore.writeRoots(record.sourceId, roots);
  }

  /** Process partitions for one source until it reaches a terminal state,
   *  the pending queue empties, or `maxSlices` partitions have run in this
   *  call (a test seam for simulating a crash mid-scan — see J4). */
  async function driveSource(record, { maxSlices }) {
    ensurePlanned(record);
    if (!record.pendingPartitions.length) {
      if (record.planReadFailure) { finalizeFailed(record, record.planReadFailure); return record; }
      // Nothing to walk (an empty-but-readable root already produces a
      // root-files partition, so reaching here with zero partitions and no
      // read failure means the plan itself was legitimately empty): publish
      // complete with visited 0 rather than leaving the record in `scanning`.
      finalizeIfComplete(record);
      return record;
    }
    let slicesRun = 0;
    let sliceEntries = 0;
    const sliceStart = now();
    while (record.pendingPartitions.length) {
      if (slicesRun >= maxSlices) return record;
      // A pause or stop requested while this drive was yielding is honoured
      // at the next partition boundary (cooperative cancellation): the loop
      // never re-enters `scanning` on its own.
      if (HALTED_STATES.has(record.scanState)) return record;
      const [partition] = record.pendingPartitions;
      const budget = remainingEntryBudget(ceilings.entries, record.visited);
      if (budget <= 0) { finalizeStopped(record, 'safety-ceiling', 'entries'); return record; }
      const result = walkPartition(partition, {
        walk, fsImpl, budget, maxDepth: partitionDepthLimit(record, partition, ceilings.depth), skipDir,
        exclusions, includeSubmodules,
        onProject: (sighting) => addProjectSighting(record, sighting),
      });
      record.visited += result.entriesSeen;
      sliceEntries += result.entriesSeen;
      slicesRun += 1;
      if (result.limitingReason === 'depth' && partitionDepthLimit(record, partition, ceilings.depth) < ceilings.depth) {
        // The walk stopped at this source's OWN curated depth bound, not at
        // the global safety ceiling: that is coverage evidence, not a stop.
        record.curatedDepthBounded = true;
      } else if (result.limitingReason) { finalizeStopped(record, 'safety-ceiling', result.limitingReason); return record; }
      record.pendingPartitions = record.pendingPartitions.slice(1);
      record.completedPartitions = [...record.completedPartitions, partition];
      if (!record.pendingPartitions.length) {
        if (finalizeIfComplete(record) !== 'requeued') return record;
        continue;
      }
      if (sliceEntries >= workSlice.entries || (now() - sliceStart) >= workSlice.ms) {
        transition(record, 'checkpointed');
        persistCheckpoint(record);
        if (slicesRun >= maxSlices) return record;
        await onceYielded(yieldFn);
        if (HALTED_STATES.has(record.scanState)) return record;
        transition(record, 'scanning');
        sliceEntries = 0;
      }
    }
    return record;
  }

  function resolveSources(sourceIds) {
    const all = configuration.listSources();
    if (!sourceIds) return all;
    const wanted = new Set(sourceIds);
    return all.filter((source) => wanted.has(source.sourceId));
  }

  /** @param {{sourceIds?: string[], maxSlices?: number}} [options] */
  async function runSources({ sourceIds, maxSlices = Infinity } = {}) {
    const targets = resolveSources(sourceIds);
    for (const source of targets) {
      const record = loadOrInitRecord(source);
      if (!TERMINAL_STATES.has(record.scanState)) await driveSource(record, { maxSlices });
    }
    return targets.map((source) => records.get(source.sourceId));
  }

  function requireRecord(sourceId) {
    const existing = records.get(sourceId);
    if (existing) return existing;
    const [source] = resolveSources([sourceId]);
    if (!source) throw new TypeError(`unknown discovery source: ${sourceId}`);
    return loadOrInitRecord(source);
  }

  function pause({ sourceId }) {
    const record = requireRecord(sourceId);
    if (!PAUSABLE_STATES.has(record.scanState)) {
      const error = /** @type {Error & { code: string }} */ (
        new Error(`cannot pause source ${sourceId} while it is ${record.scanState}`)
      );
      error.code = 'SOURCE_NOT_PAUSABLE';
      throw error;
    }
    transition(record, 'paused');
    return coverageFor(toCoverageRecord(record));
  }

  function stop({ sourceId, confirmed = false }) {
    const record = requireRecord(sourceId);
    if (!confirmed) {
      return {
        confirmed: false,
        preview: {
          sourceId, label: record.label, visited: record.visited,
          completedPartitions: record.completedPartitions.length,
        },
      };
    }
    // Stopping is legal from every state: a source that already reached a
    // terminal state (published/complete/failed) is simply removed from the
    // active configuration while its bounded history and receipts remain.
    if (record.scanState !== 'stopped') {
      if ((SCAN_TRANSITIONS[record.scanState] ?? []).includes('stopped')) transition(record, 'stopped');
      else record.scanState = 'stopped';
    }
    record.limitingReason = 'stopped-by-user';
    record.ceiling = null;
    historyStore?.recordSummary(toSummary(record, now));
    if (record.scanId) checkpointStore.remove(record.scanId);
    onEvent({ type: 'DiscoverySourceStopped', sourceId, limitingReason: 'stopped-by-user' });
    return { confirmed: true, removed: true };
  }

  function progress() {
    return [...records.values()].map((record) => ({
      sourceId: record.sourceId, environmentId: record.environmentId, state: record.scanState,
      visited: record.visited, label: record.label,
      limitingReason: record.limitingReason, ceiling: record.ceiling,
    }));
  }

  /** A configured source with no live record — never started, paused, or
   *  stopped in this process — falls back to its last PUBLISHED evidence, or
   *  else a zeroed `not-scanned` row (QE defect D3): coverage() must report
   *  EVERY configured source, never silently omit one that has not run yet. */
  function coverageForSource(source) {
    const record = records.get(source.sourceId);
    if (record) return coverageFor(toCoverageRecord(record));
    const persisted = lastGoodStore?.current()
      .find((entry) => entry.sourceId === source.sourceId && entry.environmentId === source.environmentId);
    if (persisted) return persisted;
    return coverageFor(toCoverageRecord(initRecord(source)));
  }

  function coverage() {
    return resolveSources().map((source) => coverageForSource(source));
  }

  /** Path-free discovered projects for one source (MNT-DSC repository
   *  identity + MNT-INV-010/011 shortest-distinguishing breadcrumbs). Reflects
   *  the LIVE in-memory record when one exists — `complete:false` while the
   *  source is still scanning, per "the projection must not treat the list as
   *  exhaustive" — and falls back to the last PUBLISHED evidence otherwise. */
  function projects({ sourceId }) {
    const record = records.get(sourceId);
    if (!record) return projectStore?.readProjects(sourceId) ?? [];
    const complete = coverageFor(toCoverageRecord(record)).state === 'complete';
    return describeProjects(record.projects, { sourceRoot: record.root, installationKey, complete, fsImpl });
  }

  /** Owner-private `projectId -> absolute root` map. NEVER folded into
   *  `progress()`, `coverage()`, or `projects()` — this is the one place a
   *  caller with private-store authority (the facade's reveal-style path) may
   *  read a real filesystem path back out of discovery. */
  function projectRoots({ sourceId }) {
    const record = records.get(sourceId);
    if (!record) return projectStore?.readRoots(sourceId) ?? new Map();
    return new Map(record.projects.map((entry) => [projectIdentity(entry.absoluteRoot, installationKey), entry.absoluteRoot]));
  }

  return {
    start: (options) => runSources(options),
    resume: (options) => runSources(options),
    pause,
    stop,
    progress,
    coverage,
    projects,
    projectRoots,
  };
}
