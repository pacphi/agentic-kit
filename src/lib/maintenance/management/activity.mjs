// ADR-0048 Activity aggregation and receipt sanitization (MNT-RCV-011/012).
//
// Pure and read-only: `buildActivity` shapes already-loaded data (receipts,
// dispositions, recipe events, scan history) into the six Activity groups.
// It never reads a store or a receipt directly — the facade composes those.
import {
  AUDIT_ACTION_LABEL, DISPOSITION_LABELS, RESOURCE_KIND_LABELS, SCAN_STATES,
} from './model.mjs';
import { maintenanceReceiptPresentation } from '../receipt-presentation.mjs';
import { UNFINISHED_MAINTENANCE_STATUSES } from '../transaction-store.mjs';

// `unknown-recovery-required` is a separate sentinel (an unreadable/corrupt
// receipt row from listMaintenanceReceipts, not one of the mid-flight
// statuses transaction-store.mjs enumerates) that must still surface here.
function isUnfinishedStatus(status) {
  return UNFINISHED_MAINTENANCE_STATUSES.has(status) || status === 'unknown-recovery-required';
}

const REVERSIBLE_ROLLBACKS = new Set(['reversible', 'compensating']);

function primaryAction(receipt) {
  return receipt?.actions?.[0] ?? null;
}

function isUnfinished(receipt) {
  return isUnfinishedStatus(receipt?.status);
}

function eligibleForUndo(receipt) {
  const action = primaryAction(receipt);
  return !isUnfinished(receipt) && receipt?.status === 'committed'
    && REVERSIBLE_ROLLBACKS.has(action?.rollback);
}

function receiptSummary(receipt) {
  const action = primaryAction(receipt);
  const presentation = maintenanceReceiptPresentation(receipt?.status, receipt?.actions?.length ?? 0);
  return {
    receiptId: receipt?.id,
    statusLabel: presentation.statusLabel,
    statusTone: presentation.statusTone,
    summary: presentation.summary,
    provider: action ? { id: action.providerId, version: action.providerVersion } : null,
    operation: action?.operation ?? null,
    resourceKind: action?.resourceIdentity?.kind ? (RESOURCE_KIND_LABELS[action.resourceIdentity.kind] ?? action.resourceIdentity.kind) : null,
    createdAt: receipt?.createdAt ?? null,
    updatedAt: receipt?.updatedAt ?? null,
    eligibleUndo: eligibleForUndo(receipt),
    recoveryRequired: presentation.recoveryRequired,
  };
}

function recoveryEntry(receipt) {
  return { ...receiptSummary(receipt), primaryActionLabel: AUDIT_ACTION_LABEL };
}

function dispositionSummary(record) {
  return {
    guidanceId: record.guidanceId,
    dispositionIdentity: record.dispositionIdentity,
    kind: record.kind,
    kindLabel: DISPOSITION_LABELS[record.kind] ?? record.kind,
    until: record.until ?? null,
    recordedAt: record.recordedAt,
    invalidatedAt: record.invalidatedAt ?? null,
    invalidationReason: record.invalidationReason ?? null,
  };
}

function recipeEventSummary(event) {
  return { kind: event.kind, recipeId: event.recipeId ?? null, recipeVersion: event.recipeVersion ?? null, at: event.at, pendingIds: event.pendingIds ?? undefined };
}

function scanSummary(entry) {
  if (!SCAN_STATES.includes(entry.state)) throw new TypeError(`unknown scan state: ${entry.state}`);
  return { sourceId: entry.sourceId, environmentId: entry.environmentId, state: entry.state, label: entry.label, visited: entry.visited, limitingReason: entry.limitingReason ?? null, completedAt: entry.completedAt ?? null };
}

/**
 * Shape already-loaded evidence into the six Activity groups. `receipts` are
 * ALL known receipts (recovery is derived from the unfinished subset, not a
 * separate input); `inProgress` is caller-supplied (in-flight scans/writes
 * the facade already tracks); `dispositions`/`recipeEvents`/`scanHistory`
 * pass through their respective stores' `list*` output.
 */
export function buildActivity({
  receipts = [], dispositions = [], recipeEvents = [], scanHistory = [], inProgress = [],
} = {}) {
  return {
    recovery: receipts.filter(isUnfinished).map(recoveryEntry),
    inProgress: [...inProgress],
    receipts: receipts.map(receiptSummary),
    dispositions: dispositions.map(dispositionSummary),
    recipes: recipeEvents.map(recipeEventSummary),
    scans: scanHistory.map(scanSummary),
  };
}

function receiptProvider(action) {
  return action ? { id: action.providerId, version: action.providerVersion } : null;
}

function receiptTimestamps(receipt) {
  return { createdAt: receipt?.createdAt ?? null, updatedAt: receipt?.updatedAt ?? null };
}

function receiptEvidence(receipt, action) {
  return { sourceFingerprint: receipt?.sourceFingerprint ?? null, preimageFingerprint: action?.preimageFingerprint ?? null };
}

/** Sanitized, in-app authenticated detail for one receipt (owner view, not
 *  export — `exportReceipt` below applies the stricter default redaction). */
export function receiptDetail(receipt) {
  const action = primaryAction(receipt);
  const presentation = maintenanceReceiptPresentation(receipt?.status, receipt?.actions?.length ?? 0);
  return {
    receiptId: receipt?.id,
    intent: action?.operation ?? null,
    provider: receiptProvider(action),
    operation: action?.operation ?? null,
    timestamps: receiptTimestamps(receipt),
    evidence: receiptEvidence(receipt, action),
    before: action?.preimageFingerprint ?? null,
    after: action?.outcome?.postFingerprint ?? null,
    result: presentation.statusLabel,
    verification: action?.verification ?? null,
    restart: action?.restart ?? null,
    rollback: action?.rollback ?? null,
    preserved: [...(action?.preserved ?? [])],
  };
}

// ── Export redaction (MNT-RCV-011/012) ─────────────────────────────────────

const LOCAL_PATH_PATTERN = /(?:^|[\s"'([{=:])(?:file:\/\/\/?|~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u;
const SECRET_KEY_PATTERN = /secret|credential|token|password|registryurl|rawconfig|apikey/iu;

function redactValue(value, includeLocalPaths) {
  if (typeof value === 'string') {
    if (!includeLocalPaths && LOCAL_PATH_PATTERN.test(value)) return '[path redacted]';
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, includeLocalPaths));
  if (value && typeof value === 'object') return redactObject(value, includeLocalPaths);
  return value;
}

function redactObject(source, includeLocalPaths) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    out[key] = redactValue(value, includeLocalPaths);
  }
  return out;
}

/**
 * Sanitized export of a receipt. Secrets, private registry URLs, raw
 * configuration, rollback material, and absolute paths are omitted by
 * default. Including local paths requires BOTH `includeLocalPaths: true` and
 * `acknowledgedWarning: true`; the default never changes (MNT-RCV-012).
 *
 * `rollback` here is the classification enum (reversible/compensating/
 * irreversible), not restoration material — this receipt schema carries no
 * raw rollback payload, only fingerprints, so the classification is kept.
 * A future field literally holding rollback material must be added to
 * `SECRET_KEY_PATTERN` (or an equivalent explicit strip) alongside it.
 */
export function exportReceipt(receipt, { includeLocalPaths = false, acknowledgedWarning = false } = {}) {
  const allowPaths = includeLocalPaths === true && acknowledgedWarning === true;
  const sanitized = redactObject(receiptDetail(receipt), allowPaths);
  return { ...sanitized, pathsIncluded: allowPaths };
}
