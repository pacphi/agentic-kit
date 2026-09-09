// Reclaimable-space ADVISORY orchestration — split out of storage.mjs (2026-08
// complexity program, ADR-0037) by natural seam: everything below is the
// reclaim half of that module's tree (`collectStorage` calls
// `collectReclaimables` exactly as it always has). See storage.mjs's header for
// the full contract this inherits unchanged:
//
// ADVISORY ONLY (invariant 4): there is no delete, prune, or cleanup verb here,
// and none may be added. `ReclaimableCandidate` rows carry a path, a size, and a
// rationale — a `cleanupHint` names the CLI that already owns the removal, and
// that string is documentation, not a command this module runs. npx.mjs's
// pruneNpxStale is deliberately NOT imported; only its read-only scanNpxStale
// is.
//
// SAFETY IS A FIELD, NOT A TONE OF VOICE — see `RECLAIM_SAFETY_TIERS` /
// `RECLAIM_SAFETY_MEANING` below and storage.mjs's header for the full
// 'regenerable' vs 'review' distinction.
//
// The family-specific detectors (superseded snapshots, regenerable caches,
// browser revisions, runtime versions, orphaned transcripts, worktrees) live in
// storage-reclaim-detectors.mjs; this file is the orchestrator plus the shared
// bits every detector composes with: `candidate()` (the row-shape contract) and
// `adoptedConsumerFigures()` (reusing an already-measured figure from the
// ranked-consumers view instead of walking a tree twice).
import path from 'node:path';
import { scanNpxStale } from '../npx.mjs';
import { npxEnvNodes } from './install.mjs';
import { decodeClaudeProjectDir } from './project-sources.mjs';
import { measured, unknown, sumMeasurements, hasValue } from './walk.mjs';
import {
  snapshotFamilies, supersededSnapshotReclaimables,
  regenerableCacheRoots, regenerableCacheReclaimables,
  browserRevisionRoots, browserRevisionReclaimables,
  runtimeVersionRoots, runtimeVersionReclaimables,
  orphanedTranscriptReclaimables, worktreeReclaimables,
} from './storage-reclaim-detectors.mjs';

/** The two safety tiers, in the order a panel should present them. Two and not
 *  three: a "definitely dead" tier would be a claim this module cannot
 *  substantiate from directory metadata alone. */
export const RECLAIM_SAFETY_TIERS = Object.freeze(['regenerable', 'review']);

/** What each tier promises, carried in the payload so no surface has to invent
 *  the wording — and so the difference between the two is impossible to render
 *  as the same thing. */
export const RECLAIM_SAFETY_MEANING = Object.freeze({
  regenerable: 'The owning tool refetches this on demand. Removing it costs download time, '
    + 'not data.',
  review: 'Plausible but not safe to call removable: some of these may be in use. Review them '
    + 'individually — this is not a total to sweep.',
});

/**
 * Advisory rows only — see this module's header. Nothing here removes anything;
 * `cleanupHint` names the CLI that already owns the removal.
 *
 * @typedef {{ value: number|null, status: string, reason: string|null,
 *             asOf: number|null, partial: boolean }} Measurement
 * @typedef {{
 *   id: string, kind: string, label: string, path: string, samplePaths: string[],
 *   matchedCount: number|null, bytes: Measurement, files: Measurement,
 *   safety: 'regenerable'|'review', bytesMeaning: 'candidate'|'installed',
 *   keeps: Array<{ path: string, label: string, bytes: Measurement }>,
 *   rationale: string, cleanupHint: string|null, advisory: true,
 * }} ReclaimableCandidate
 */
export function collectReclaimables({
  asOf, agedTranscripts, transcriptProjects = new Map(), projects, opts, walk, limits,
  detectWorktrees, detectCaches = true, detectOrphanedTranscripts = true,
  consumers = null, install = null, projectFootprints = null,
  env = process.env, decodeDir = decodeClaudeProjectDir, fsImpl,
}) {
  const rows = [];
  const days = (ms) => Math.floor((asOf - ms) / 86_400_000);
  const ctx = {
    asOf, opts, walk, limits, fsImpl, adopt: adoptedConsumerFigures(consumers),
  };

  for (const acc of agedTranscripts.values()) {
    rows.push(candidate({
      id: `aged-transcripts:${acc.host}`,
      kind: 'aged-transcripts',
      label: `${acc.host} transcripts older than ${opts.transcriptAgeDays}d`,
      path: acc.root,
      samplePaths: acc.samples,
      matchedCount: acc.files,
      bytes: measured(acc.bytes, { asOf }),
      files: measured(acc.files, { asOf }),
      // Not regenerable in any sense: a transcript is the only copy of the
      // session it records, and Historical usage is denominated in them.
      safety: 'review',
      rationale: `${acc.files} file(s) untouched for ${opts.transcriptAgeDays}d or more; `
        + `oldest ${days(acc.oldestMtimeMs)}d. Historical usage reads these — removing them `
        + 'removes that history too.',
      cleanupHint: null,
    }));
  }

  rows.push(...npxReclaimables({ asOf, opts, walk, limits, fsImpl, install }));
  if (detectOrphanedTranscripts) {
    rows.push(...orphanedTranscriptReclaimables({
      asOf, opts, transcriptProjects, decodeDir, fsImpl,
    }));
  }
  if (detectCaches) {
    rows.push(...supersededSnapshotReclaimables(ctx, snapshotFamilies({ env })));
    rows.push(...regenerableCacheReclaimables(ctx, regenerableCacheRoots({ env })));
    rows.push(...browserRevisionReclaimables(ctx, browserRevisionRoots({ env })));
    rows.push(...runtimeVersionReclaimables(ctx, runtimeVersionRoots({ env })));
  }
  if (detectWorktrees && Array.isArray(projects)) {
    rows.push(...worktreeReclaimables({
      asOf, projects, opts, walk, limits, fsImpl, projectFootprints,
    }));
  }
  return rows.sort((a, b) => (b.bytes.value ?? 0) - (a.bytes.value ?? 0));
}

// APFS and NTFS are case-insensitive, so an adopted figure keyed by an
// exact-case path would silently miss on macOS and Windows.
const foldCase = process.platform !== 'linux';
const pathKey = (target) => {
  const abs = path.resolve(target);
  return foldCase ? abs.toLowerCase() : abs;
};

/** Do any two of these rows describe the same path, or one inside another? Two
 *  such rows cover some of the same bytes — an aged transcript can also sit in a
 *  project that no longer exists — and adding them would report space twice. */
function rowsOverlap(rows) {
  const keys = rows.map((row) => (row.path ? pathKey(row.path) : null)).filter(Boolean);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (keys[i] === keys[j]) return true;
      const rel = path.relative(keys[i], keys[j]);
      const nested = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      const inverse = path.relative(keys[j], keys[i]);
      if (nested || (inverse && !inverse.startsWith('..') && !path.isAbsolute(inverse))) return true;
    }
  }
  return false;
}

/**
 * Per-tier totals, and deliberately NO combined figure. Summing a regenerable
 * cache with a runtime tree that may be live would produce the one number a
 * reader would act on and the one number this module cannot stand behind.
 *
 * A tier whose own rows overlap reports its total as unknown-with-reason rather
 * than as a sum that counts the same bytes twice — the rowCount still stands,
 * and each row still carries its own measured figure.
 */
export function summarizeReclaimables(rows, { asOf = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    tiers: RECLAIM_SAFETY_TIERS.map((safety) => {
      const tier = list.filter((row) => row.safety === safety);
      // Only 'candidate' bytes are summable: an 'installed' figure is context on
      // a review row, not space the row claims is available.
      const members = tier.filter((row) => row.bytesMeaning === 'candidate');
      const overlapping = rowsOverlap(members);
      return {
        safety,
        meaning: RECLAIM_SAFETY_MEANING[safety],
        rowCount: tier.length,
        bytes: overlapping
          ? unknown('rows in this tier describe overlapping paths, so a sum would count the '
            + 'same bytes twice')
          : sumMeasurements(members.map((row) => row.bytes), { asOf }),
        summedRows: overlapping ? 0 : members.length,
        contextOnlyRows: tier.length - members.length,
      };
    }),
    combined: null,
    combinedNote: 'The tiers are reported separately and never added: only the regenerable '
      + 'total is space a tool would rebuild by itself.',
  };
}

/** Fill in the fields every row carries, so no detector can ship a candidate
 *  without a safety tier or a statement of what its bytes mean. Exported so
 *  storage-reclaim-detectors.mjs's family detectors build to the same shape. */
export function candidate(row) {
  return {
    samplePaths: [],
    matchedCount: null,
    keeps: [],
    bytesMeaning: 'candidate',
    cleanupHint: null,
    ...row,
    advisory: true,
  };
}

/** Stale npx cache envs. Two independent rationales, both read-only: a cached
 *  copy strictly older than its installed global baseline (npx.mjs's version
 *  verdict — the bug that kept a machine running a retired ruflo), and an env
 *  untouched for longer than the idle threshold. */
function measurementMatchesScan(value, asOf) {
  return Boolean(value) && (value.status === 'unknown' || value.asOf === asOf);
}

function validNpxEnvFact(env, root, asOf) {
  if (!env || typeof env.id !== 'string' || !env.id || !path.isAbsolute(env.path ?? '')) return false;
  if (path.resolve(path.dirname(env.path)) !== path.resolve(root)) return false;
  if (path.basename(env.path) !== env.id || !Array.isArray(env.packages)) return false;
  if (env.packages.some((pkg) => typeof pkg !== 'string')) return false;
  if (!measurementMatchesScan(env.bytes, asOf) || !measurementMatchesScan(env.files, asOf)) return false;
  return env.newestMtimeMs === null || Number.isFinite(env.newestMtimeMs);
}

function sameScanNpxFacts(install, asOf) {
  if (!install || install.asOf !== asOf) return null;
  const nodes = install.npxEnvs;
  if (!nodes || typeof nodes !== 'object' || !path.isAbsolute(nodes.root ?? '')
      || !['present', 'absent', 'degraded'].includes(nodes.presence)
      || !Array.isArray(nodes.envs)) return null;
  if (nodes.presence !== 'present') return nodes.envs.length === 0 ? nodes : null;
  if (nodes.envs.some((env) => !validNpxEnvFact(env, nodes.root, asOf))) return null;
  return nodes;
}

export function npxReclaimables({ asOf, opts, walk, limits, fsImpl, install = null }) {
  // Install runs earlier in the same deep scan and already measures every npx
  // environment. Reuse only an exact, same-asOf, immediate-child inventory;
  // malformed or older evidence falls back to the original bounded walk.
  const nodes = sameScanNpxFacts(install, asOf)
    ?? npxEnvNodes({ walk, limits, asOf, fsImpl });
  if (nodes.presence !== 'present') return [];
  let staleByVersion = new Map();
  try {
    staleByVersion = new Map(scanNpxStale({ root: nodes.root }).map((entry) => [entry.dir, entry.stale]));
  } catch { /* an unreadable cache simply yields no version verdict */ }
  const idleCutoff = asOf - opts.npxEnvIdleDays * 86_400_000;
  const rows = [];
  for (const env of nodes.envs) {
    const stale = staleByVersion.get(env.path);
    const idle = env.newestMtimeMs !== null && env.newestMtimeMs < idleCutoff;
    const versionStale = Array.isArray(stale) && stale.length > 0;
    if (!versionStale && !idle) continue;
    const idleDays = idle ? Math.floor((asOf - env.newestMtimeMs) / 86_400_000) : null;
    const why = [];
    if (versionStale) {
      why.push(`cached ${stale.map((s) => `${s.pkg}@${s.cached}`).join(', ')} `
        + `older than installed ${stale.map((s) => s.installed).join(', ')}`);
    }
    if (idle) why.push(`untouched for ${idleDays}d`);
    rows.push(candidate({
      id: `stale-npx-env:${env.id}`,
      kind: 'stale-npx-env',
      label: `npx cache env (${env.packages.join(', ') || 'unkeyed'})`,
      path: env.path,
      bytes: env.bytes,
      files: env.files,
      safety: 'regenerable',
      basis: { versionStale, idle, idleDays },
      rationale: `${why.join('; ')}. npx re-fetches on demand, so the cache is reproducible.`,
      cleanupHint: versionStale ? 'ak sync prunes version-stale envs (npx.pruneNpxStale)' : null,
    }));
  }
  return rows;
}

/**
 * A lookup from absolute path to a figure the ranked-consumers view already
 * measured, or a function that always misses when no such view was supplied.
 * Exact paths only: a consumers row for a glob FAMILY carries one total for the
 * whole family and cannot answer for an individual member.
 *
 * @param {{ asOf?: number, rows?: any[] }|null} consumers a collectConsumers payload
 * @returns {(target: string) => ({ presence: string, bytes: Measurement,
 *   files: Measurement, newestMtimeMs: number|null })|null}
 */
export function adoptedConsumerFigures(consumers) {
  const index = new Map();
  for (const row of consumers?.rows ?? []) {
    const sameScan = Number.isFinite(consumers?.asOf)
      && row?.bytes?.asOf === consumers.asOf
      && row?.files?.asOf === consumers.asOf;
    if (!row?.path || row.residual || row.presence !== 'present'
      || row.complete !== true || row.bytes?.partial === true || row.files?.partial === true
      || !hasValue(row.bytes) || !hasValue(row.files) || !sameScan) continue;
    index.set(pathKey(row.path), {
      presence: 'present',
      bytes: row.bytes,
      files: row.files,
      newestMtimeMs: row.newestMtimeMs ?? null,
      complete: true,
    });
  }
  return (target) => (target ? index.get(pathKey(target)) ?? null : null);
}
