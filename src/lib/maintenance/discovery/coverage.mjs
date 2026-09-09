// ADR-0048 source coverage — the SourceCoverage projection every scan record
// reduces to (tests/fixtures/maintenance/management-fixtures.mjs shape), the
// last-good snapshot store (a partial or failed run never replaces the last
// complete one — MNT-PERF-007), and the truthful-progress language helper
// (MNT-DSC-016).
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomic } from '../../file-write.mjs';
import { INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS, SOURCE_COVERAGE_STATES } from '../management/model.mjs';
import { sha256 } from '../evidence.mjs';

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_SCHEMA = 'maintenance-discovery-snapshot/v1';
const PROJECTS_SCHEMA = 'maintenance-discovery-projects/v1';
const PROJECT_ROOTS_SCHEMA = 'maintenance-discovery-project-roots/v1';

/** Map an internal scan-record state to the coarser public SourceCoverage
 *  state vocabulary. `checkpointed`/`queued` are both "scanning" from the
 *  inventory's point of view — the fine machine states live only in the
 *  orchestrator and its checkpoints. `configured` is deliberately its OWN
 *  bucket, `not-scanned`: it means a source's record exists (perhaps only
 *  because something previewed or paused it) but no partition has EVER been
 *  walked for it — QE defect D3 (MNT-DSC-011/016): reporting it as
 *  `scanning` claimed in-progress work that never started. */
const COVERAGE_STATE_BY_SCAN_STATE = Object.freeze({
  configured: 'not-scanned', queued: 'scanning', scanning: 'scanning', checkpointed: 'scanning',
  paused: 'paused', complete: 'complete', published: 'complete', stopped: 'stopped', failed: 'failed',
});

/** Reduce one internal source scan record to the public SourceCoverage shape. */
export function coverageFor(record) {
  const state = COVERAGE_STATE_BY_SCAN_STATE[record.scanState] ?? 'scanning';
  if (!SOURCE_COVERAGE_STATES.includes(state)) throw new TypeError(`unmapped coverage state: ${state}`);
  return {
    sourceId: record.sourceId,
    environmentId: record.environmentId,
    state,
    visited: record.visited ?? 0,
    estimated: record.estimated ?? null,
    completedPartitions: record.completedPartitions ?? 0,
    pendingPartitions: record.pendingPartitions ?? 0,
    limitingReason: record.limitingReason ?? null,
    ...(record.ceiling ? { ceiling: record.ceiling } : {}),
    ...(Array.isArray(record.curatedSkips) && record.curatedSkips.length ? { curatedSkips: [...record.curatedSkips] } : {}),
    ...(record.curatedDepthBounded === true ? { curatedDepthBounded: true } : {}),
    lastCompletedAt: state === 'complete' ? (record.lastCompletedAt ?? null) : null,
    label: record.label,
  };
}

function ensurePrivateDir(dir, fsImpl) {
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

function snapshotKey(entry) { return `${entry.environmentId}:${entry.sourceId}`; }

/**
 * `<controlRoot>/management/discovery-latest.json` — one row per source, kept
 * ONLY while it is `complete`. A partial or failed coverage entry is silently
 * rejected rather than overwriting the last complete evidence for that source.
 */
export function createLastGoodSnapshotStore(dir, { fsImpl = fs, now = Date.now } = {}) {
  const file = path.join(dir, 'discovery-latest.json');

  function read() {
    let raw;
    try { raw = fsImpl.readFileSync(file, 'utf8'); } catch { return { schemaVersion: SNAPSHOT_SCHEMA, sources: {} }; }
    try {
      const parsed = JSON.parse(raw);
      const { integrity, ...base } = parsed ?? {};
      if (parsed?.schemaVersion !== SNAPSHOT_SCHEMA || integrity?.digest !== sha256(base)) {
        return { schemaVersion: SNAPSHOT_SCHEMA, sources: {} };
      }
      return base;
    } catch {
      return { schemaVersion: SNAPSHOT_SCHEMA, sources: {} };
    }
  }

  function persist(store) {
    ensurePrivateDir(dir, fsImpl);
    const { integrity: _drop, ...sealed } = store;
    const envelope = { ...sealed, integrity: { algorithm: 'sha256', digest: sha256(sealed) } };
    const bytes = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(bytes) > MAX_SNAPSHOT_BYTES) throw new Error('discovery snapshot exceeds size limit');
    writePrivateFileAtomic(file, bytes, { fsImpl });
  }

  /** Only a `complete` entry is accepted; anything else is a no-op and
   *  returns `false` so the caller knows the last-good baseline was kept. */
  function write(entry) {
    if (entry.state !== 'complete') return false;
    const store = read();
    store.sources = { ...store.sources, [snapshotKey(entry)]: { ...entry, capturedAt: new Date(now()).toISOString() } };
    persist(store);
    return true;
  }

  function current() { return Object.values(read().sources ?? {}); }

  return { write, current, read };
}

function readSealed(file, schema, fallback, fsImpl) {
  let raw;
  try { raw = fsImpl.readFileSync(file, 'utf8'); } catch { return fallback; }
  try {
    const parsed = JSON.parse(raw);
    const { integrity, ...base } = parsed ?? {};
    if (parsed?.schemaVersion !== schema || integrity?.digest !== sha256(base)) return fallback;
    return base;
  } catch {
    return fallback;
  }
}

function writeSealed(dir, file, base, fsImpl) {
  ensurePrivateDir(dir, fsImpl);
  const envelope = { ...base, integrity: { algorithm: 'sha256', digest: sha256(base) } };
  writePrivateFileAtomic(file, `${JSON.stringify(envelope)}\n`, { fsImpl });
}

/**
 * `<controlRoot>/management/discovery-projects.json` (path-free, may
 * eventually be surfaced) and `discovery-project-roots.json` (owner-private,
 * absolute paths, NEVER read by anything but `readRoots` — never merged into
 * progress/coverage/public output). Both are written only when the
 * orchestrator PUBLISHES a source, matching the last-good snapshot's
 * "a partial run never replaces the last complete evidence" rule (MNT-DSC-014).
 */
export function createProjectEvidenceStore(dir, { fsImpl = fs, now = Date.now } = {}) {
  const projectsFile = path.join(dir, 'discovery-projects.json');
  const rootsFile = path.join(dir, 'discovery-project-roots.json');

  function writeProjects(sourceId, projects) {
    const store = readSealed(projectsFile, PROJECTS_SCHEMA, { schemaVersion: PROJECTS_SCHEMA, bySource: {} }, fsImpl);
    store.bySource = { ...store.bySource, [sourceId]: { projects, capturedAt: new Date(now()).toISOString() } };
    writeSealed(dir, projectsFile, store, fsImpl);
  }
  function readProjects(sourceId) {
    const store = readSealed(projectsFile, PROJECTS_SCHEMA, { bySource: {} }, fsImpl);
    return store.bySource?.[sourceId]?.projects ?? null;
  }
  /** @param {string} sourceId @param {Array<{projectId: string, root: string}>} entries */
  function writeRoots(sourceId, entries) {
    const store = readSealed(rootsFile, PROJECT_ROOTS_SCHEMA, { schemaVersion: PROJECT_ROOTS_SCHEMA, bySource: {} }, fsImpl);
    store.bySource = { ...store.bySource, [sourceId]: entries };
    writeSealed(dir, rootsFile, store, fsImpl);
  }
  /** @returns {Map<string,string>} */
  function readRoots(sourceId) {
    const store = readSealed(rootsFile, PROJECT_ROOTS_SCHEMA, { bySource: {} }, fsImpl);
    const entries = store.bySource?.[sourceId] ?? [];
    return new Map(entries.map((entry) => [entry.projectId, entry.root]));
  }

  return {
    writeProjects, readProjects, writeRoots, readRoots,
  };
}

/** Which of INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS are off-limits given this
 *  coverage set (MNT-DSC-014). Every source complete → nothing is forbidden. */
export function claimsAllowed(coverage) {
  const list = Array.isArray(coverage) ? coverage : [];
  const allComplete = list.length > 0 && list.every((entry) => entry.state === 'complete');
  return allComplete ? [] : [...INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS];
}

function fmt(n) { return Number(n ?? 0).toLocaleString('en-US'); }

/** A factual, non-alarming progress sentence for one source's coverage
 *  (MNT-DSC-016): visited work, how many configured sources are complete, and
 *  this source's own pause/resume state — never a lower bound presented as a
 *  total.
 *
 * @param {Array<{state?: string, visited?: number, label?: string,
 *   limitingReason?: string, ceiling?: string}>} coverage
 * @param {{ totalSources?: number }} [options]
 */
export function progressNarrative(coverage, { totalSources } = {}) {
  const list = Array.isArray(coverage) ? coverage : [];
  const completeCount = list.filter((entry) => entry.state === 'complete').length;
  const notScannedCount = list.filter((entry) => entry.state === 'not-scanned').length;
  const total = totalSources ?? list.length;
  const visited = list.reduce((sum, entry) => sum + (entry.visited ?? 0), 0);
  const sentences = [`Scanned ${fmt(visited)} entries.`];
  if (total > 0) sentences.push(`${completeCount} of ${total} sources are complete.`);
  // A never-run source contributed no visited work at all — it must never be
  // folded into "scanning" language, which would claim in-progress work that
  // never started (QE defect D3).
  if (notScannedCount > 0) sentences.push(`${notScannedCount} sources have not been scanned yet.`);
  for (const entry of list) {
    if (entry.state === 'paused') sentences.push(`${entry.label} is paused and will resume; its inventory is not yet complete.`);
    if (entry.state === 'stopped' && entry.limitingReason === 'safety-ceiling') {
      sentences.push(`${entry.label} stopped at its ${entry.ceiling} limit after ${fmt(entry.visited)} entries.`);
    }
    if (entry.state === 'stopped' && entry.limitingReason === 'source-changed') {
      sentences.push(`${entry.label} stopped because the source changed during measurement.`);
    }
  }
  return sentences.join(' ');
}
