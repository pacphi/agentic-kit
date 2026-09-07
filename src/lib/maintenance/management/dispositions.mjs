// ADR-0048 recommendation-disposition ledger (MNT-GUD-009..011).
//
// An owner-private, integrity-sealed, append-only ledger of Acknowledge /
// Snooze / Ignore-exact-candidate decisions. It never removes a resource from
// Inventory; it only suppresses a matching Guidance entry until invalidated.
// `admitGuidance` (guidance.mjs) consumes `activeDispositions()`'s output as
// plain data — this module owns persistence only.
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomic } from '../../file-write.mjs';
import { DISPOSITION_INVALIDATIONS, DISPOSITION_KINDS } from './model.mjs';

const DISPOSITION_STORE_SCHEMA = 'maintenance-disposition-ledger/v1';
const MAX_STORE_BYTES = 2 * 1024 * 1024;

function storeFile(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('disposition store root must be a dedicated absolute directory');
  }
  return path.join(path.normalize(root), 'dispositions.json');
}

function readAll(root, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(storeFile(root), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const envelope = JSON.parse(raw);
  if (envelope.schemaVersion !== DISPOSITION_STORE_SCHEMA || !Array.isArray(envelope.records)) {
    throw new Error('disposition ledger schema mismatch');
  }
  return envelope.records;
}

function writeAll(root, records, fsImpl) {
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const envelope = { schemaVersion: DISPOSITION_STORE_SCHEMA, records };
  const bytes = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw new Error('disposition ledger exceeds size limit');
  writePrivateFileAtomic(storeFile(root), bytes, { fsImpl });
}

function assertRecordInput({ guidanceId, dispositionIdentity, kind, until }) {
  if (typeof guidanceId !== 'string' || !guidanceId) throw new TypeError('guidanceId is required');
  if (typeof dispositionIdentity !== 'string' || !dispositionIdentity) throw new TypeError('dispositionIdentity is required');
  if (!DISPOSITION_KINDS.includes(kind)) throw new TypeError(`kind must be one of ${DISPOSITION_KINDS.join(', ')}`);
  if (kind === 'snoozed') {
    if (typeof until !== 'string' || !Number.isFinite(Date.parse(until))) {
      throw new TypeError('snoozed dispositions require a valid ISO `until` expiry');
    }
  } else if (until != null) {
    throw new TypeError(`${kind} dispositions do not take an expiry`);
  }
}

function isExpired(record, atMs) {
  return record.kind === 'snoozed' && record.until != null && Date.parse(record.until) <= atMs;
}

/**
 * An owner-private ledger rooted at `root` (the facade passes
 * `<maintenanceControlDir()>/management`). Every write reads, mutates, and
 * atomically rewrites the whole ledger — dispositions are small (one record
 * per user decision), so this stays well under the size ceiling.
 * @param {{ root: string, fsImpl?: any, now?: () => Date }} options
 */
export function createDispositionStore({ root, fsImpl = fs, now = () => new Date() } = /** @type {any} */ ({})) {
  function listDispositions() {
    return readAll(root, fsImpl);
  }

  /** Records one disposition. Returns the explanation text MNT-GUD-011
   *  requires be shown before confirmation, alongside the stored record. */
  function recordDisposition({ guidanceId, dispositionIdentity, kind, until = null, invalidationInputs = {} }) {
    assertRecordInput({ guidanceId, dispositionIdentity, kind, until });
    const records = readAll(root, fsImpl);
    const record = {
      guidanceId, dispositionIdentity, kind, until,
      invalidationInputs: { ...invalidationInputs },
      recordedAt: now().toISOString(), invalidatedAt: null, invalidationReason: null,
    };
    records.push(record);
    writeAll(root, records, fsImpl);
    return { record, explanation: explanationFor(kind) };
  }

  function activeDispositions(atTime = now()) {
    const atMs = atTime instanceof Date ? atTime.getTime() : Date.parse(atTime);
    return readAll(root, fsImpl).filter((record) => !record.invalidatedAt && !isExpired(record, atMs));
  }

  /** Re-check every active disposition against current inventory facts and
   *  mark newly-invalid ones. `inventory` is the freshly projected snapshot;
   *  invalidation compares each record's `invalidationInputs` snapshot with
   *  the current placement/version/dependency/source facts it names.
   *  `severityOf(placementId)` is optional and supplied fresh at call time
   *  (never stored) since a function cannot survive JSON persistence. */
  function invalidateDispositions({ inventory, now: atTime = now(), severityOf = null }) {
    const records = readAll(root, fsImpl);
    const atMs = atTime instanceof Date ? atTime.getTime() : Date.parse(atTime);
    let changed = false;
    for (const record of records) {
      if (record.invalidatedAt) continue;
      const reason = invalidationReasonFor(record, inventory, atMs, severityOf);
      if (reason) {
        record.invalidatedAt = new Date(atMs).toISOString();
        record.invalidationReason = reason;
        changed = true;
      }
    }
    if (changed) writeAll(root, records, fsImpl);
    return records;
  }

  return { listDispositions, recordDisposition, activeDispositions, invalidateDispositions };
}

function explanationFor(kind) {
  if (kind === 'acknowledged') {
    return 'Acknowledging records that you saw this condition. The resource stays visible and no Guidance entry is hidden.';
  }
  if (kind === 'snoozed') {
    return 'Snoozing hides this one Guidance entry until the expiry you set. A version, dependency, or source change before then resurfaces it early.';
  }
  return 'Ignoring applies only to this exact candidate. A different candidate, or a change to the underlying version or dependency, resurfaces Guidance.';
}

function placementIdFromIdentity(dispositionIdentity) {
  const [placementId] = String(dispositionIdentity ?? '').split(':');
  return placementId;
}

function findPlacement(inventory, placementId) {
  return (inventory?.placements ?? []).find((placement) => placement.placementId === placementId) ?? null;
}

function candidateOf(inventory, placementId) {
  return (inventory?.versionObservations ?? [])
    .find((observation) => observation.subjectId === placementId && observation.axis === 'candidate')?.value ?? null;
}

function dependencyFingerprint(inventory, placementId) {
  const edges = (inventory?.dependencyEdges ?? [])
    .filter((edge) => edge.fromPlacementId === placementId)
    .map((edge) => `${edge.kind}:${edge.toId}:${edge.satisfied}`)
    .sort();
  return edges.join('|');
}

/** Returns one of DISPOSITION_INVALIDATIONS, or null when still valid. */
function invalidationReasonFor(record, inventory, atMs, severityOf) {
  if (isExpired(record, atMs)) return 'expiry';
  if (!inventory) return null;
  const placementId = placementIdFromIdentity(record.dispositionIdentity);
  const placement = findPlacement(inventory, placementId);
  if (!placement) return null;
  const inputs = record.invalidationInputs ?? {};
  if ('candidate' in inputs && candidateOf(inventory, placementId) !== inputs.candidate) return 'candidate-change';
  if ('installedVersion' in inputs && placement.versions?.installed !== inputs.installedVersion) return 'installed-version-change';
  if ('dependencyFingerprint' in inputs
      && dependencyFingerprint(inventory, placementId) !== inputs.dependencyFingerprint) return 'dependency-change';
  if ('sourceFingerprint' in inputs && inventory.sourceFingerprint !== inputs.sourceFingerprint) return 'source-fingerprint-drift';
  if ('securitySeverity' in inputs && typeof severityOf === 'function'
      && severityOf(placementId) > inputs.securitySeverity) return 'security-severity-increase';
  return null;
}

export const KNOWN_DISPOSITION_INVALIDATIONS = DISPOSITION_INVALIDATIONS;
