// ADR-0048 §10 / provider-and-action-policy.md "Interruption audit and
// reconciliation". This module is the read-only half of that split: it never
// acquires the mutation lock, never writes a receipt, and never calls a
// provider's apply/undo/verify. It only reads a receipt, discloses what it is
// about to check, calls the recorded provider's `inspectCurrent`, and compares
// the observed fingerprint with the recorded preimage or verified postimage.
//
// `recovery-coordinator.mjs` imports the low-level comparison primitives from
// here so the confirmed reconciliation write (MNT-RCV-006) re-runs exactly
// this logic under the mutation lock rather than a parallel reimplementation.
import fs from 'node:fs';

import { AUDIT_RESULTS, NO_CORRECTIVE_ACTION, RECONCILE_OUTCOMES } from './management/model.mjs';
import { UNFINISHED_MAINTENANCE_STATUSES, readMaintenanceReceipt } from './transaction-store.mjs';

/** Statuses an unfinished apply-side journal can be interrupted in — every
 * unfinished status except `prepared` (handled by `journalProvesNoDispatch`)
 * and `undoing` (handled as its own branch), derived from the one shared set
 * in transaction-store.mjs rather than duplicated. */
export const APPLY_RECOVERY_STATUSES = Object.freeze(new Set(
  [...UNFINISHED_MAINTENANCE_STATUSES].filter((status) => status !== 'prepared' && status !== 'undoing'),
));

/** Statuses that already carry a conclusive, sealed reconciliation. */
export const RECONCILED_STATUSES = Object.freeze(new Set([
  'aborted-no-change', 'recovered-no-change', 'committed', 'rolled-back',
]));

/** What the audit discloses before it inspects anything (MNT-RCV-002). This is
 *  static and receipt-independent, so it is safe to return even when the
 *  receipt itself cannot be read. */
export const AUDIT_DISCLOSURE = Object.freeze({
  checks: Object.freeze([
    'receipt-integrity', 'last-durable-phase', 'recorded-provider-version', 'current-state-inspection',
  ]),
  executableProbePolicy: 'read-only-provider-inspector-only',
  networkPolicy: 'no-network-unless-the-recorded-provider-inspector-requires-it',
});

function safeText(value, max = 500) {
  return Array.from(String(value ?? ''), (character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').slice(0, max);
}

/** Only a `complete: true` inspection result may supply a comparable fingerprint. */
export function recoveryFingerprint(current) {
  if (current?.complete !== true) return null;
  const value = current?.postFingerprint ?? current?.currentFingerprint;
  return typeof value === 'string' && value ? safeText(value, 256) : null;
}

/** Only a receipt-sealed, provider-verified postimage counts as "verified". */
export function verifiedPostimage(entry) {
  const outcome = entry?.outcome?.postFingerprint;
  const verification = entry?.verification?.postFingerprint;
  return entry?.state === 'verified' && entry?.verification?.verified === true && typeof outcome === 'string'
    && outcome && verification === outcome ? safeText(outcome, 256) : null;
}

/** A prepared journal with no dispatched entry proves no effect without
 *  calling any provider (MNT-RCV-006: "Record no change ... proves no dispatch"). */
export function journalProvesNoDispatch(receipt, interruptedStatus) {
  return interruptedStatus === 'prepared'
    && Array.isArray(receipt.actions) && receipt.actions.length > 0
    && receipt.actions.every((entry) => entry.state === 'prepared' && entry.outcome == null);
}

async function inspectOneEntry(entry, providers, checks, failedComparisons) {
  const implementation = providers?.get?.(entry.providerId);
  if (!implementation || implementation.version !== entry.providerVersion) {
    checks.push({ name: 'recorded-provider-version', status: 'missing-or-changed' });
    return 'provider-unavailable';
  }
  checks.push({ name: 'recorded-provider-version', status: 'matched' });
  if (typeof implementation.inspectCurrent !== 'function') {
    checks.push({ name: 'current-state-inspection', status: 'unsupported' });
    return 'provider-unavailable';
  }
  let current;
  try {
    current = await implementation.inspectCurrent(entry);
  } catch {
    checks.push({ name: 'current-state-inspection', status: 'failed' });
    failedComparisons.push('current-state-inspection');
    return 'inconclusive';
  }
  checks.push({ name: 'current-state-inspection', status: 'completed' });
  const fingerprint = recoveryFingerprint(current);
  const preimage = typeof entry.preimageFingerprint === 'string' && entry.preimageFingerprint
    ? entry.preimageFingerprint : null;
  const postimage = verifiedPostimage(entry);
  if (preimage && fingerprint === preimage) {
    checks.push({ name: 'preimage-comparison', status: 'matched' });
    return 'preimage';
  }
  failedComparisons.push('preimage-comparison');
  if (postimage && fingerprint === postimage) {
    checks.push({ name: 'postimage-comparison', status: 'matched' });
    return 'postimage';
  }
  failedComparisons.push('postimage-comparison');
  return 'inconclusive';
}

/** Inspect every action entry of one receipt and classify the uniform image
 *  they agree on, or report why they do not conclusively agree. Never writes,
 *  never touches the mutation lock, never calls apply/undo/verify. */
export async function inspectReceiptEntries(receipt, providers, checks = [], failedComparisons = []) {
  const images = [];
  for (const entry of receipt.actions ?? []) {
    images.push(await inspectOneEntry(entry, providers, checks, failedComparisons));
  }
  if (!images.length) return { conclusive: false, reason: 'no-recorded-actions' };
  if (images.some((image) => image === 'provider-unavailable')) {
    return { conclusive: false, reason: 'provider-unavailable-or-changed' };
  }
  const unique = new Set(images);
  if (unique.size !== 1 || unique.has('inconclusive')) {
    return { conclusive: false, reason: 'mixed-or-inconclusive-state' };
  }
  return { conclusive: true, image: images[0] };
}

function noDispatchResult() {
  return {
    result: 'no-action-started', conclusive: true, enables: 'record-no-change',
    checks: [{ name: 'last-durable-phase', status: 'no-dispatch-recorded' }], failedComparisons: [],
  };
}

function inconclusiveResult(reason, checks, failedComparisons) {
  const result = reason === 'provider-unavailable-or-changed'
    ? 'matching-inspection-provider-not-present'
    : 'differs-from-both-recorded-states';
  return {
    result, conclusive: false, enables: null, checks, failedComparisons,
  };
}

function conclusiveResult(interruptedStatus, image, checks, failedComparisons) {
  if (interruptedStatus === 'undoing') {
    return image === 'preimage'
      ? { result: 'matches-recorded-before-state', conclusive: true, enables: 'record-restored', checks, failedComparisons }
      : { result: 'matches-verified-after-state', conclusive: true, enables: 'record-completed', checks, failedComparisons };
  }
  return image === 'preimage'
    ? { result: 'matches-recorded-before-state', conclusive: true, enables: 'record-no-change', checks, failedComparisons }
    : { result: 'matches-verified-after-state', conclusive: true, enables: 'record-completed', checks, failedComparisons };
}

function singleProvider(receipt) {
  const entries = Array.isArray(receipt.actions) ? receipt.actions : [];
  if (entries.length !== 1) return null;
  return { id: entries[0].providerId, version: entries[0].providerVersion };
}

/** Read-only single-receipt audit core. Reused, unmodified, by both the
 *  batch `auditInterruptions` below and `recovery-coordinator.mjs`'s
 *  confirmed reconciliation write, which re-runs it under the mutation lock. */
export async function auditReceiptRecord(receipt, providers) {
  const interruptedStatus = receipt.recovery?.interruptedStatus ?? receipt.status;
  const checks = [{ name: 'receipt-integrity', status: 'passed' }];
  if (RECONCILED_STATUSES.has(receipt.status)) {
    return {
      lastDurablePhase: interruptedStatus, provider: singleProvider(receipt), alreadyReconciled: true,
      conclusive: true, enables: null, checks, failedComparisons: [], nextSteps: [],
    };
  }
  if (journalProvesNoDispatch(receipt, interruptedStatus)) {
    const { checks: dispatchChecks, ...rest } = noDispatchResult();
    return {
      lastDurablePhase: interruptedStatus, provider: singleProvider(receipt),
      ...rest, checks: [...checks, ...dispatchChecks], nextSteps: [],
    };
  }
  if (!APPLY_RECOVERY_STATUSES.has(interruptedStatus) && interruptedStatus !== 'undoing') {
    return {
      lastDurablePhase: interruptedStatus, provider: singleProvider(receipt),
      result: 'differs-from-both-recorded-states', conclusive: false, enables: null,
      checks: [...checks, { name: 'last-durable-phase', status: 'unsupported' }],
      failedComparisons: ['last-durable-phase'], nextSteps: [NO_CORRECTIVE_ACTION],
    };
  }
  const failedComparisons = [];
  const entryChecks = [];
  const inspected = await inspectReceiptEntries(receipt, providers, entryChecks, failedComparisons);
  const combinedChecks = [...checks, ...entryChecks];
  const classified = inspected.conclusive
    ? conclusiveResult(interruptedStatus, inspected.image, combinedChecks, failedComparisons)
    : inconclusiveResult(inspected.reason, combinedChecks, failedComparisons);
  return {
    lastDurablePhase: interruptedStatus, provider: singleProvider(receipt), ...classified,
    nextSteps: classified.conclusive ? [] : [NO_CORRECTIVE_ACTION],
  };
}

function exportableAudit(receiptId, disclosure, audit) {
  return Object.freeze({
    receiptId,
    result: audit.result ?? null,
    conclusive: audit.conclusive,
    enables: audit.enables,
    lastDurablePhase: audit.lastDurablePhase,
    provider: audit.provider,
    checks: [...audit.checks],
    failedComparisons: [...audit.failedComparisons],
    nextSteps: [...audit.nextSteps],
    disclosure,
  });
}

function integrityFailureAudit(receiptId, disclosure, error) {
  const audit = {
    lastDurablePhase: null, provider: null, result: 'receipt-integrity-check-failed',
    conclusive: false, enables: null,
    checks: [{ name: 'receipt-integrity', status: 'failed' }],
    failedComparisons: ['receipt-integrity'], nextSteps: [NO_CORRECTIVE_ACTION],
  };
  return {
    receiptId, disclosure, integrity: 'failed', ...audit,
    error: safeText(error?.message ?? error, 200),
    exportable: exportableAudit(receiptId, disclosure, audit),
  };
}

function assertAuditVocabulary(audit) {
  if (audit.result != null && !AUDIT_RESULTS.includes(audit.result)) {
    throw new TypeError(`interruption audit produced an unknown result: ${audit.result}`);
  }
  if (audit.enables != null && !RECONCILE_OUTCOMES.includes(audit.enables)) {
    throw new TypeError(`interruption audit produced an unknown reconcile outcome: ${audit.enables}`);
  }
}

/** Audit one or more receipts. Read-only, batchable, ephemeral: it never
 *  acquires the mutation lock and never writes a file. A caller-supplied
 *  `refreshAffectedCatalog` is intentionally never invoked — audits never
 *  refresh, apply, undo, or verify anything; only confirmed reconciliation
 *  (`reconcile-coordinator.mjs#reconcileMaintenanceReceipt`) does that, under
 *  the lock, after the audit it re-runs enables the requested outcome.
 * @param {any} options `{ transactionsRoot: string, receiptIds: string[], providers: Map<string, any>, fsImpl?: any, now?: () => number }` */
export async function auditInterruptions({
  transactionsRoot, receiptIds, providers, fsImpl = fs, now = Date.now,
} = {}) {
  if (!Array.isArray(receiptIds) || receiptIds.length === 0) {
    throw new TypeError('an interruption audit requires at least one exact receipt id');
  }
  const disclosure = { ...AUDIT_DISCLOSURE, checkedAt: new Date(now()).toISOString() };
  const results = [];
  for (const receiptId of receiptIds) {
    let loaded;
    try {
      loaded = readMaintenanceReceipt(transactionsRoot, receiptId, { fsImpl });
    } catch (error) {
      results.push(integrityFailureAudit(receiptId, disclosure, error));
      continue;
    }
    const audit = await auditReceiptRecord(loaded.receipt, providers);
    assertAuditVocabulary(audit);
    results.push({
      receiptId, disclosure, integrity: 'valid', ...audit,
      exportable: exportableAudit(receiptId, disclosure, audit),
    });
  }
  return results;
}
