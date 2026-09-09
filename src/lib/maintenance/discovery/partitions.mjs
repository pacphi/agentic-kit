// ADR-0048 Discovery partitioning — bounds a source root to a fixed-size list
// of resumable units so the orchestrator can checkpoint after each one without
// retaining a per-file index (MNT-PERF-005). This is orchestration OVER
// ADR-0047's streaming observation forest, not a competing crawler: every
// partition is executed as one or more `observeWalkForest` calls.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_FANOUT = 64;

function stampFor(target, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(target);
    return {
      target, mtimeMs: stat.mtimeMs, ino: Number(stat.ino) || null, size: stat.isFile() ? stat.size : null,
    };
  } catch (error) {
    return { target, mtimeMs: null, ino: null, size: null, reason: error?.code ?? 'io' };
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * A bounded, stable partition plan for one discovery root: partition 0 covers
 * the root's own direct files, and every direct child directory becomes its
 * own partition unless the child count exceeds `maxFanout`, in which case
 * children are grouped into `maxFanout` partitions so the partition LIST
 * stays bounded (the traversal underneath each partition is not).
 *
 * @param {string} root
 * @param {{ fsImpl?: typeof fs, maxFanout?: number }} [options]
 */
export function planPartitions(root, { fsImpl = fs, maxFanout = DEFAULT_MAX_FANOUT } = {}) {
  let entries;
  try { entries = fsImpl.readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    return { root, partitions: [], reason: error?.code ?? 'io' };
  }
  const dirNames = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();

  const partitions = [{
    partitionId: 'root-files', kind: 'root-files', targets: [root], sourceStamps: [stampFor(root, fsImpl)],
  }];

  if (dirNames.length <= maxFanout) {
    for (const name of dirNames) {
      const target = path.join(root, name);
      partitions.push({
        partitionId: `dir:${name}`, kind: 'directory', targets: [target], sourceStamps: [stampFor(target, fsImpl)],
      });
    }
  } else {
    const groupSize = Math.ceil(dirNames.length / maxFanout);
    chunk(dirNames, groupSize).forEach((names, index) => {
      const targets = names.map((name) => path.join(root, name));
      partitions.push({
        partitionId: `group:${index}`, kind: 'directory-group', targets,
        sourceStamps: targets.map((target) => stampFor(target, fsImpl)),
      });
    });
  }
  return { root, partitions, reason: null };
}

/**
 * Map ADR-0047 ObservationSpec option objects (the same shape passed to
 * `observeWalkForest`) onto one partition's targets. A `root-files` partition
 * never descends — its only job is the root's own direct files — every other
 * partition kind walks its target directories with the specs unchanged.
 *
 * @returns {Array<{ target: string, specs: object[] }>} one entry per target
 *   directory in the partition, ready for `observeWalkForest(target, specs, …)`.
 */
export function partitionSpecs(partition, observationSpecs) {
  if (partition.kind === 'root-files') {
    const neverDescend = observationSpecs.map((spec) => ({ ...spec, skipDir: () => true }));
    return [{ target: partition.targets[0], specs: neverDescend }];
  }
  return partition.targets.map((target) => ({ target, specs: observationSpecs }));
}

/** Aggregate several WalkResult-shaped results (one virtual query, several
 *  physical targets) into one summary: entries visited, bytes, and whether
 *  every constituent walk completed without truncation or degradation. */
export function mergeWalkResults(results) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  return list.reduce((acc, result) => ({
    entriesSeen: acc.entriesSeen + (result.entriesSeen ?? 0),
    bytes: acc.bytes + (result.bytes ?? 0),
    files: acc.files + (result.files ?? 0),
    dirs: acc.dirs + (result.dirs ?? 0),
    symlinksSkipped: acc.symlinksSkipped + (result.symlinksSkipped ?? 0),
    degradedCount: acc.degradedCount + (result.degradedCount ?? 0),
    complete: acc.complete && result.complete !== false,
  }), {
    entriesSeen: 0, bytes: 0, files: 0, dirs: 0, symlinksSkipped: 0, degradedCount: 0, complete: true,
  });
}

/** True when every target's current stamp still matches the partition's
 *  recorded stamps (same mtime/ino/size) — a mismatch is source drift. */
export function partitionDrifted(partition, { fsImpl = fs } = {}) {
  return partition.sourceStamps.some((recorded) => {
    const current = stampFor(recorded.target, fsImpl);
    return current.mtimeMs !== recorded.mtimeMs || current.ino !== recorded.ino || current.size !== recorded.size;
  });
}
