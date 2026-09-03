import fs from 'node:fs';

import { acquireMaintenanceLock } from './mutation-lock.mjs';
import { readMaintenanceReceipt, writeMaintenanceReceipt } from './transaction-store.mjs';

const RECONCILED_STATUSES = new Set([
  'aborted-no-change', 'recovered-no-change', 'committed', 'rolled-back',
]);
const APPLY_RECOVERY_STATUSES = new Set([
  'applying', 'verifying', 'refreshing-catalog', 'failed', 'partial',
  'partial-recovery-required', 'outcome-unknown',
]);

function safeText(value, max = 500) {
  return Array.from(String(value ?? ''), (character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').slice(0, max);
}

function recoveryFingerprint(current) {
  if (current?.complete !== true) return null;
  const value = current?.postFingerprint ?? current?.currentFingerprint;
  return typeof value === 'string' && value ? safeText(value, 256) : null;
}

function verifiedPostimage(entry) {
  const outcome = entry?.outcome?.postFingerprint;
  const verification = entry?.verification?.postFingerprint;
  return entry?.state === 'verified' && entry?.verification?.verified === true && typeof outcome === 'string'
    && outcome && verification === outcome ? safeText(outcome, 256) : null;
}

async function inspectRecoveryEntries(receipt, providers) {
  const images = [];
  for (const entry of receipt.actions ?? []) {
    const implementation = providers?.get?.(entry.providerId);
    if (!implementation || implementation.version !== entry.providerVersion
        || typeof implementation.inspectCurrent !== 'function') {
      return { conclusive: false, reason: 'provider-unavailable-or-changed' };
    }
    let current;
    try { current = await implementation.inspectCurrent(entry); } catch {
      return { conclusive: false, reason: 'inspection-failed' };
    }
    const fingerprint = recoveryFingerprint(current);
    const preimage = typeof entry.preimageFingerprint === 'string' && entry.preimageFingerprint
      ? entry.preimageFingerprint : null;
    const postimage = verifiedPostimage(entry);
    if (preimage && fingerprint === preimage) images.push('preimage');
    else if (postimage && fingerprint === postimage) images.push('postimage');
    else images.push('inconclusive');
  }
  if (!images.length || new Set(images).size !== 1 || images[0] === 'inconclusive') {
    return { conclusive: false, reason: 'mixed-or-inconclusive-state' };
  }
  return { conclusive: true, image: images[0] };
}

function recoveryResult(receipt, file, ok = true) {
  return { ok, status: receipt.status, receiptId: receipt.id, receiptFile: file, receipt };
}

function markRecoveryRequired(receipt, file, interruptedStatus, reason, { fsImpl, now }) {
  receipt.status = 'partial-recovery-required';
  receipt.updatedAt = new Date(now()).toISOString();
  receipt.error = 'Recovery evidence is inconclusive; no action was taken.';
  receipt.recovery = {
    interruptedStatus,
    outcome: 'recovery-required',
    reason: safeText(reason, 120),
    inspectedAt: receipt.updatedAt,
  };
  const sealed = writeMaintenanceReceipt(file, receipt, { fsImpl });
  return { ...recoveryResult(sealed, file, false), error: sealed.error };
}

async function refreshForRecovery(receipt, refreshAffectedCatalog) {
  if (typeof refreshAffectedCatalog !== 'function') return false;
  const refreshed = await refreshAffectedCatalog(receipt.actions.map((entry) => entry.resourceIdentity));
  return refreshed?.ok !== false;
}

function journalProvesNoDispatch(receipt, interruptedStatus) {
  return interruptedStatus === 'prepared'
    && Array.isArray(receipt.actions) && receipt.actions.length > 0
    && receipt.actions.every((entry) => entry.state === 'prepared' && entry.outcome == null);
}

function sealAborted(receipt, file, interruptedStatus, { fsImpl, now }) {
  receipt.status = 'aborted-no-change';
  receipt.updatedAt = new Date(now()).toISOString();
  receipt.recovery = {
    interruptedStatus, outcome: 'journal-proved-no-dispatch', completedAt: receipt.updatedAt,
  };
  return recoveryResult(writeMaintenanceReceipt(file, receipt, { fsImpl }), file);
}

async function sealReconciled(receipt, file, interruptedStatus, inspected, options) {
  const terminal = interruptedStatus === 'undoing'
    ? (inspected.image === 'preimage' ? 'rolled-back' : 'committed')
    : (inspected.image === 'preimage' ? 'recovered-no-change' : 'committed');
  const needsRefresh = inspected.image === 'postimage'
    || (interruptedStatus === 'undoing' && inspected.image === 'preimage');
  const catalogFresh = !needsRefresh
    || await refreshForRecovery(receipt, options.refreshAffectedCatalog);
  if (!catalogFresh) {
    return markRecoveryRequired(receipt, file, interruptedStatus, 'catalog-refresh-incomplete', options);
  }
  receipt.status = terminal;
  receipt.updatedAt = new Date(options.now()).toISOString();
  receipt.error = undefined;
  receipt.recovery = {
    interruptedStatus,
    outcome: interruptedStatus === 'undoing' && inspected.image === 'preimage'
      ? 'restored-preimage-confirmed'
      : `${inspected.image === 'preimage' ? 'observed-preimage' : 'recorded-postimage'}-confirmed`,
    inspectedAt: receipt.updatedAt,
    affectedCatalogRefreshed: needsRefresh,
  };
  return recoveryResult(writeMaintenanceReceipt(file, receipt, { fsImpl: options.fsImpl }), file);
}

async function reconcileLoaded(receipt, file, providers, options) {
  const interruptedStatus = receipt.recovery?.interruptedStatus ?? receipt.status;
  if (journalProvesNoDispatch(receipt, interruptedStatus)) {
    return sealAborted(receipt, file, interruptedStatus, options);
  }
  if (!APPLY_RECOVERY_STATUSES.has(interruptedStatus) && interruptedStatus !== 'undoing') {
    return markRecoveryRequired(receipt, file, interruptedStatus, 'unsupported-interrupted-state', options);
  }
  const inspected = await inspectRecoveryEntries(receipt, providers);
  if (!inspected.conclusive) {
    return markRecoveryRequired(receipt, file, interruptedStatus, inspected.reason, options);
  }
  return sealReconciled(receipt, file, interruptedStatus, inspected, options);
}

/** Reconcile an interrupted transaction using only current provider evidence.
 * This function never retries, rolls back, or otherwise invokes an action.
 * @param {any} options */
export async function recoverMaintenanceReceipt({
  transactionsRoot, receiptId, providers, refreshAffectedCatalog = null,
  fsImpl = fs, now = Date.now,
} = {}) {
  let lock;
  try { lock = acquireMaintenanceLock(transactionsRoot, { fsImpl }); } catch (error) {
    return { ok: false, status: 'receipt-refused', error: safeText(error?.message ?? error) };
  }
  if (!lock) return { ok: false, status: 'busy', error: 'another maintenance mutation is active' };
  try {
    let loaded;
    try { loaded = readMaintenanceReceipt(transactionsRoot, receiptId, { fsImpl }); } catch (error) {
      return { ok: false, status: 'receipt-refused', error: safeText(error?.message ?? error) };
    }
    const receipt = loaded.receipt;
    if (RECONCILED_STATUSES.has(receipt.status)) {
      return { ok: true, status: 'already-reconciled', receiptId, receipt };
    }
    return reconcileLoaded(receipt, loaded.file, providers, {
      fsImpl, now, refreshAffectedCatalog,
    });
  } finally {
    try { lock.release(); } catch { /* retained lock fails closed */ }
  }
}
