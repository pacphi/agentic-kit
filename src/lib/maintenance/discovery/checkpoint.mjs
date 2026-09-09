// ADR-0048 scan checkpoints — the bounded, owner-private, integrity-sealed
// continuation record a resumable discovery scan writes after every partition
// or work slice (docs/MAINTENANCE.md
// "Work slices and safety ceilings"). It never persists a per-file index: only partition
// ids, bounded cursors, and stamps small enough to stay well under the size
// ceiling (MNT-PERF-005).
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomic } from '../../file-write.mjs';
import { canonicalJson, SCAN_CHECKPOINT_SCHEMA, SCAN_HISTORY_RETENTION } from '../management/model.mjs';
import { sha256 } from '../evidence.mjs';

export const MAX_CHECKPOINT_BYTES = 256 * 1024;

function ensurePrivateDir(dir, fsImpl) {
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(dir, 0o700); } catch { /* best effort on exotic filesystems */ }
}

function integrityOf(checkpoint) {
  const { integrity: _drop, ...base } = checkpoint;
  return { algorithm: 'sha256', digest: sha256(base) };
}

function checkpointFile(dir, scanId) {
  if (typeof scanId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(scanId)) {
    throw new TypeError('invalid scanId for a checkpoint filename');
  }
  return path.join(dir, `${scanId}.json`);
}

/** @param {{updatedAt?: string}} checkpoint @param {{now: () => number, maxAgeDays?: number}} options */
function isExpired(checkpoint, { now, maxAgeDays = SCAN_HISTORY_RETENTION.checkpointDays }) {
  const updatedAt = Date.parse(checkpoint?.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return now() - updatedAt > maxAgeDays * 86_400_000;
}

/** Structural validation the store enforces on every write, independent of
 *  the resume-drift checks in `validateForResume`. */
function assertShape(checkpoint) {
  // `updatedAt` is deliberately absent here: `write()` computes it itself below.
  const required = [
    'scanId', 'sourceId', 'environmentId', 'scanEpoch', 'completedPartitions',
    'pendingPartitions', 'workCounts', 'sourceStamps', 'createdAt',
  ];
  for (const field of required) {
    if (checkpoint[field] === undefined) throw new TypeError(`checkpoint missing required field: ${field}`);
  }
  if (!Array.isArray(checkpoint.completedPartitions) || !Array.isArray(checkpoint.pendingPartitions)) {
    throw new TypeError('checkpoint partitions must be arrays');
  }
}

/** @param {string} root a dedicated `<controlRoot>/management/checkpoints` dir */
export function createCheckpointStore(root, { fsImpl = fs, now = Date.now } = {}) {
  ensurePrivateDir(root, fsImpl);

  function write(checkpoint) {
    assertShape(checkpoint);
    const sealed = {
      schemaVersion: SCAN_CHECKPOINT_SCHEMA,
      ...checkpoint,
      updatedAt: new Date(now()).toISOString(),
    };
    sealed.integrity = integrityOf(sealed);
    const bytes = `${JSON.stringify(sealed)}\n`;
    if (Buffer.byteLength(bytes) > MAX_CHECKPOINT_BYTES) {
      throw new Error(`checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
    }
    writePrivateFileAtomic(checkpointFile(root, checkpoint.scanId), bytes, { fsImpl });
    return sealed;
  }

  function read(scanId) {
    const file = checkpointFile(root, scanId);
    let raw;
    try { raw = fsImpl.readFileSync(file, 'utf8'); }
    catch { return null; }
    let checkpoint;
    try { checkpoint = JSON.parse(raw); } catch { return null; }
    const { integrity, ...base } = checkpoint ?? {};
    if (checkpoint?.schemaVersion !== SCAN_CHECKPOINT_SCHEMA
      || integrity?.algorithm !== 'sha256' || integrity.digest !== sha256(base)) {
      return null;
    }
    if (isExpired(checkpoint, { now })) {
      remove(scanId);
      return null;
    }
    return checkpoint;
  }

  function remove(scanId) {
    try { fsImpl.rmSync(checkpointFile(root, scanId), { force: true }); } catch { /* already gone */ }
  }

  function list() {
    let names;
    try { names = fsImpl.readdirSync(root); } catch { return []; }
    return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
  }

  return { write, read, remove, list };
}

/** A stable digest of the arbitrary identity material a checkpoint must match
 *  to resume (source identity, exclusions, safety policy). Kept as one helper
 *  so orchestrator.mjs and this module always hash the same way. */
export function contextDigest(material) {
  return sha256(material);
}

/**
 * Reject resume on any drift, naming the exact cause. `contractVersions` is
 * compared as canonical JSON so key order never causes a false rejection.
 *
 * @param {{ environmentId?: string, sourceIdentityDigest?: string, exclusionsDigest?: string,
 *   safetyPolicyDigest?: string, observationContractVersions?: object }|null} checkpoint
 * @param {{ sourceIdentityDigest?: string, environmentId?: string,
 *   exclusionsDigest?: string, contractVersions?: object, safetyPolicyDigest?: string }} context
 */
export function validateForResume(checkpoint, {
  sourceIdentityDigest, environmentId, exclusionsDigest, contractVersions, safetyPolicyDigest,
}) {
  if (!checkpoint) return { valid: false, reason: 'no checkpoint to resume' };
  if (checkpoint.environmentId !== environmentId) return { valid: false, reason: 'environment changed since the checkpoint' };
  if (checkpoint.sourceIdentityDigest !== sourceIdentityDigest) {
    return { valid: false, reason: 'source identity changed since the checkpoint' };
  }
  if (checkpoint.exclusionsDigest !== exclusionsDigest) {
    return { valid: false, reason: 'exclusions changed since the checkpoint' };
  }
  if (checkpoint.safetyPolicyDigest !== safetyPolicyDigest) {
    return { valid: false, reason: 'safety policy changed since the checkpoint' };
  }
  if (canonicalJson(checkpoint.observationContractVersions ?? {}) !== canonicalJson(contractVersions ?? {})) {
    return { valid: false, reason: 'observation contract changed since the checkpoint' };
  }
  return { valid: true, reason: null };
}
