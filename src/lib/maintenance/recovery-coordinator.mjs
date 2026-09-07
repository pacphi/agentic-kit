import fs from 'node:fs';

import {
  APPLY_RECOVERY_STATUSES, RECONCILED_STATUSES, auditReceiptRecord, journalProvesNoDispatch,
  inspectReceiptEntries as inspectRecoveryEntries,
} from './interruption-audit.mjs';
import { RECONCILE_OUTCOMES } from './management/model.mjs';
import { acquireMaintenanceLock } from './mutation-lock.mjs';
import { readMaintenanceReceipt, writeMaintenanceReceipt } from './transaction-store.mjs';

function safeText(value, max = 500) {
  return Array.from(String(value ?? ''), (character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').slice(0, max);
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

const TERMINAL_STATUS_FOR_OUTCOME = Object.freeze({
  'record-completed': 'committed',
  'record-restored': 'rolled-back',
});

/** `record-no-change` seals `aborted-no-change` when the journal proves no
 *  dispatch ever happened, or `recovered-no-change` when a dispatched action
 *  is observed to have had no effect. */
function terminalStatusFor(interruptedStatus, outcome) {
  if (outcome === 'record-no-change') {
    return interruptedStatus === 'prepared' ? 'aborted-no-change' : 'recovered-no-change';
  }
  return TERMINAL_STATUS_FOR_OUTCOME[outcome];
}

async function sealReconciledOutcome(receipt, file, interruptedStatus, outcome, audit, options) {
  const needsRefresh = outcome !== 'record-no-change';
  const catalogFresh = !needsRefresh || await refreshForRecovery(receipt, options.refreshAffectedCatalog);
  if (!catalogFresh) {
    receipt.status = 'partial-recovery-required';
    receipt.updatedAt = new Date(options.now()).toISOString();
    receipt.error = 'Reconciliation could not confirm the affected catalog refresh.';
    receipt.recovery = {
      interruptedStatus, outcome: 'affected-catalog-refresh-did-not-complete', requestedOutcome: outcome,
      inspectedAt: receipt.updatedAt,
    };
    const sealed = writeMaintenanceReceipt(file, receipt, { fsImpl: options.fsImpl });
    return { ok: false, status: sealed.status, receiptId: sealed.id, receiptFile: file, error: sealed.error, receipt: sealed };
  }
  receipt.status = terminalStatusFor(interruptedStatus, outcome);
  receipt.updatedAt = new Date(options.now()).toISOString();
  receipt.error = undefined;
  receipt.recovery = {
    interruptedStatus, outcome, auditResult: audit.result ?? null,
    inspectedAt: receipt.updatedAt, affectedCatalogRefreshed: needsRefresh,
  };
  const sealed = writeMaintenanceReceipt(file, receipt, { fsImpl: options.fsImpl });
  return recoveryResult(sealed, file);
}

/** Record one conclusive interruption-audit outcome for exactly one receipt
 * (MNT-RCV-006). Refuses unless `confirmed === true`, `outcome` is a
 * RECONCILE_OUTCOMES value, and a fresh audit re-run under the mutation lock
 * enables that exact outcome. Never retries, replays, or undoes an action —
 * it only seals the receipt that the audit already proved.
 * @param {any} options */
export async function reconcileMaintenanceReceipt({
  transactionsRoot, receiptId, outcome, confirmed = false, providers,
  refreshAffectedCatalog = null, fsImpl = fs, now = Date.now,
} = {}) {
  if (confirmed !== true) {
    return { ok: false, status: 'confirmation-required', error: 'Explicit confirmation is required to reconcile a maintenance receipt.' };
  }
  if (!RECONCILE_OUTCOMES.includes(outcome)) {
    return { ok: false, status: 'reconcile-refused', error: `unsupported reconcile outcome: ${outcome}` };
  }
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
    const interruptedStatus = receipt.recovery?.interruptedStatus ?? receipt.status;
    const audit = await auditReceiptRecord(receipt, providers);
    if (!audit.conclusive || audit.enables !== outcome) {
      return {
        ok: false, status: 'reconcile-refused', receiptId,
        error: `the current interruption audit does not enable outcome: ${outcome}`,
      };
    }
    return sealReconciledOutcome(receipt, loaded.file, interruptedStatus, outcome, audit, {
      fsImpl, now, refreshAffectedCatalog,
    });
  } finally {
    try { lock.release(); } catch { /* retained lock fails closed */ }
  }
}
