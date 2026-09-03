import fs from 'node:fs';

import { acquireMaintenanceLock } from './mutation-lock.mjs';
import {
  MAINTENANCE_RECEIPT_SCHEMA,
  createMaintenanceTransaction,
  listMaintenanceReceipts,
  listUnfinishedMaintenanceReceipts,
  readMaintenanceReceipt,
  writeMaintenanceReceipt,
} from './transaction-store.mjs';

const EXECUTABLE_CLASSES = new Set(['safe-automatic', 'approval-required']);
const TERMINAL_OUTCOMES = new Set(['applied', 'success']);
const NOT_APPLIED_OUTCOMES = new Set(['refused', 'unchanged', 'not-applied']);
const RECOVERABLE = new Set(['reversible', 'compensating']);

function safeText(value, max = 500) {
  return Array.from(String(value ?? ''), (character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').slice(0, max);
}

function publicIdentity(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const key of ['kind', 'id', 'name', 'host', 'scope', 'providerRef']) {
    if (source[key] != null) out[key] = safeText(source[key], 160);
  }
  return out;
}

function safeOutcome(outcome) {
  const value = outcome && typeof outcome === 'object' ? outcome : {};
  return {
    status: safeText(value.status || 'unknown', 64),
    ...(value.postFingerprint ? { postFingerprint: safeText(value.postFingerprint, 256) } : {}),
    ...(value.summary ? { summary: safeText(value.summary) } : {}),
    ...(Number.isInteger(value.exitCode) ? { exitCode: value.exitCode } : {}),
    ...(value.timedOut === true ? { timedOut: true } : {}),
  };
}

function selectedActions(plan, actionIds, expectedPlanDigest, providers, now, validatePlan) {
  validatePlan?.(plan, { now: now() });
  if (!plan || plan.planDigest !== expectedPlanDigest) throw new Error('stale or mismatched plan digest');
  const expiry = Date.parse(plan.expiresAt);
  if (!Number.isFinite(expiry) || now() > expiry) throw new Error('maintenance plan expired');
  if (!Array.isArray(actionIds) || actionIds.length === 0) throw new Error('at least one exact action id is required');
  if (new Set(actionIds).size !== actionIds.length) throw new Error('duplicate action ids are not allowed');
  const actions = [...actionIds].sort().map((id) => {
    const item = plan.actions?.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`action is not present in this plan: ${id}`);
    if (item.executable !== true || !EXECUTABLE_CLASSES.has(item.classification)) {
      throw new Error(`action is not executable: ${id}`);
    }
    const implementation = providers?.get?.(item.providerId);
    if (!implementation || implementation.version !== item.providerVersion) {
      throw new Error(`action provider is unavailable or changed: ${item.providerId}`);
    }
    return { action: item, provider: implementation };
  });
  const batchKey = (item) => [
    item.action.providerId, item.action.operation, item.action.classification, item.action.rollback,
  ].join('\0');
  if (new Set(actions.map(batchKey)).size !== 1) {
    throw new Error('selected actions must share provider, operation, safety class, and rollback semantics');
  }
  return actions;
}

function receiptEntry(action, preimageFingerprint = null) {
  return {
    actionId: action.id,
    providerId: action.providerId,
    providerVersion: action.providerVersion,
    operation: safeText(action.operation, 80),
    resourceIdentity: publicIdentity(action.resourceIdentity ?? action.resource),
    classification: action.classification,
    rollback: action.rollback,
    restart: action.restart ?? 'unknown',
    sourceFingerprint: safeText(action.sourceFingerprint, 256),
    ...(preimageFingerprint ? { preimageFingerprint: safeText(preimageFingerprint, 256) } : {}),
    state: 'prepared',
    outcome: null,
    verification: null,
  };
}

function write(transaction, receipt, fsImpl) {
  return writeMaintenanceReceipt(transaction.file, receipt, { fsImpl });
}

async function compensate(receipt, selected, transaction, { fsImpl }) {
  let complete = true;
  for (const entry of [...receipt.actions].reverse()) {
    if (!['applied', 'verified'].includes(entry.state)) continue;
    const selectedItem = selected.find((item) => item.action.id === entry.actionId);
    if (!selectedItem || !RECOVERABLE.has(entry.rollback)
        || typeof selectedItem.provider.undo !== 'function'
        || typeof selectedItem.provider.verifyUndo !== 'function') {
      entry.state = 'recovery-unavailable';
      complete = false;
      receipt = write(transaction, receipt, fsImpl);
      continue;
    }
    try {
      entry.state = 'rolling-back';
      receipt = write(transaction, receipt, fsImpl);
      const outcome = safeOutcome(await selectedItem.provider.undo(entry));
      if (!['restored', 'success'].includes(outcome.status)) throw new Error('provider did not confirm restoration');
      const verification = await selectedItem.provider.verifyUndo(entry, outcome);
      if (verification?.ok !== true) throw new Error('provider could not verify restoration');
      entry.state = 'rolled-back';
      entry.recovery = { status: outcome.status, verified: true };
    } catch (error) {
      entry.state = 'rollback-failed';
      entry.error = safeText(error?.message ?? error);
      complete = false;
    }
    receipt = write(transaction, receipt, fsImpl);
  }
  receipt.status = complete ? 'rolled-back' : 'partial-recovery-required';
  return write(transaction, receipt, fsImpl);
}

function refused(error) {
  return { ok: false, status: 'preflight-refused', error: safeText(error?.message ?? error) };
}

function assertApplyJournalAvailable(transactionsRoot, expectedPlanDigest, actionIds, fsImpl) {
  const unfinished = listUnfinishedMaintenanceReceipts(transactionsRoot, { fsImpl });
  if (unfinished.length) {
    throw new Error(`unfinished maintenance transaction requires recovery: ${unfinished[0].id}`);
  }
  const selectionKey = [...actionIds].sort().join('\0');
  const replay = listMaintenanceReceipts(transactionsRoot, { fsImpl }).find((receipt) => (
    receipt.planDigest === expectedPlanDigest
    && [...(receipt.authorization?.actionIds ?? [])].sort().join('\0') === selectionKey
  ));
  if (replay) throw new Error(`maintenance plan selection was already consumed by receipt: ${replay.id}`);
}

async function revalidateBeforeMutation(selected, plan, refreshPlan, validatePlan, now) {
  for (const item of selected) {
    if (typeof item.provider.preflight !== 'function') {
      throw new Error(`provider cannot preflight: ${item.action.providerId}`);
    }
    const check = await item.provider.preflight(item.action);
    if (check?.ok !== true || check.sourceFingerprint !== item.action.sourceFingerprint) {
      throw new Error(`source state changed for action: ${item.action.id}`);
    }
    if (typeof item.provider.inspectCurrent === 'function') {
      const current = await item.provider.inspectCurrent(item.action);
      const fingerprint = current?.postFingerprint ?? current?.currentFingerprint;
      if (current?.complete === true && typeof fingerprint === 'string' && fingerprint) {
        item.preimageFingerprint = safeText(fingerprint, 256);
      }
    }
  }
  const livePlan = await refreshPlan();
  validatePlan?.(livePlan, { now: now(), sourceFingerprint: plan.sourceFingerprint });
  if (livePlan?.planDigest !== plan.planDigest
      || livePlan.sourceFingerprint !== plan.sourceFingerprint
      || !selected.every((item) => livePlan.actions?.some((candidate) => candidate.id === item.action.id))) {
    throw new Error('inventory or plan changed after preview');
  }
}

function initialReceipt(transaction, plan, selected, now) {
  const timestamp = new Date(now()).toISOString();
  return {
    schemaVersion: MAINTENANCE_RECEIPT_SCHEMA,
    id: transaction.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'prepared',
    planId: safeText(plan.planId, 160),
    planDigest: safeText(plan.planDigest, 256),
    sourceFingerprint: safeText(plan.sourceFingerprint, 256),
    authorization: { mechanism: 'exact-plan-selection', actionIds: selected.map((item) => item.action.id) },
    actions: selected.map((item) => receiptEntry(item.action, item.preimageFingerprint)),
    verification: null,
  };
}

async function applyOne(item, receipt, transaction, { fsImpl, now }) {
  const entry = receipt.actions.find((candidate) => candidate.actionId === item.action.id);
  receipt.status = 'applying';
  entry.state = 'applying';
  receipt.updatedAt = new Date(now()).toISOString();
  receipt = write(transaction, receipt, fsImpl);
  const outcome = safeOutcome(await item.provider.apply(item.action));
  entry.outcome = outcome;
  if (NOT_APPLIED_OUTCOMES.has(outcome.status)) {
    entry.state = 'not-applied';
    write(transaction, receipt, fsImpl);
    throw new Error(`provider refused action without changing state: ${item.action.id}`);
  }
  if (!TERMINAL_OUTCOMES.has(outcome.status)) {
    entry.state = 'outcome-unknown';
    receipt.status = 'partial-recovery-required';
    receipt.error = 'provider outcome was not conclusive; recovery inspection is required';
    receipt = write(transaction, receipt, fsImpl);
    return { receipt, conclusive: false };
  }
  entry.state = 'applied';
  receipt = write(transaction, receipt, fsImpl);
  receipt.status = 'verifying';
  receipt = write(transaction, receipt, fsImpl);
  const verification = await item.provider.verify(item.action, outcome);
  if (verification?.ok !== true || verification.postFingerprint !== outcome.postFingerprint) {
    throw new Error(`provider verification failed for action: ${item.action.id}`);
  }
  entry.verification = { verified: true, postFingerprint: safeText(verification.postFingerprint, 256) };
  entry.state = 'verified';
  return { receipt: write(transaction, receipt, fsImpl), conclusive: true };
}

async function executeSelection(selected, receipt, transaction, options) {
  for (const item of selected) {
    const result = await applyOne(item, receipt, transaction, options);
    receipt = result.receipt;
    if (!result.conclusive) return { receipt, conclusive: false };
  }
  if (typeof options.refreshAffectedCatalog === 'function') {
    receipt.status = 'refreshing-catalog';
    receipt = write(transaction, receipt, options.fsImpl);
    const refreshed = await options.refreshAffectedCatalog(selected.map((item) => item.action.resourceIdentity));
    if (refreshed?.ok === false) throw new Error('affected catalog refresh did not complete');
  }
  receipt.status = 'committed';
  receipt.updatedAt = new Date(options.now()).toISOString();
  receipt.verification = {
    nativeStateVerified: true,
    affectedCatalogRefreshed: typeof options.refreshAffectedCatalog === 'function',
    affectedCatalogRescanRequired: typeof options.refreshAffectedCatalog !== 'function',
  };
  return { receipt: write(transaction, receipt, options.fsImpl), conclusive: true };
}

function recordUnknownDispatch(receipt, transaction, fsImpl, error) {
  for (const entry of receipt.actions) {
    if (entry.state === 'applying') entry.state = 'outcome-unknown';
  }
  receipt.status = 'partial-recovery-required';
  receipt.error = safeText(error?.message ?? error);
  return write(transaction, receipt, fsImpl);
}

/** @param {any} options */
export async function applyMaintenancePlan({
  plan, actionIds, expectedPlanDigest, providers, transactionsRoot, refreshPlan,
  refreshAffectedCatalog = null, validatePlan = null, fsImpl = fs, now = Date.now, nonce,
} = {}) {
  let selected;
  try {
    selected = selectedActions(plan, actionIds, expectedPlanDigest, providers, now, validatePlan);
    if (typeof refreshPlan !== 'function') throw new Error('fresh maintenance planning is required');
  } catch (error) {
    return refused(error);
  }

  let lock;
  try { lock = acquireMaintenanceLock(transactionsRoot, { fsImpl }); } catch (error) {
    return refused(error);
  }
  if (!lock) return { ok: false, status: 'busy', error: 'another maintenance mutation is active' };
  let transaction = null;
  let receipt = null;
  try {
    assertApplyJournalAvailable(transactionsRoot, expectedPlanDigest, actionIds, fsImpl);
    await revalidateBeforeMutation(selected, plan, refreshPlan, validatePlan, now);
    transaction = createMaintenanceTransaction(transactionsRoot, {
      fsImpl, now: () => new Date(now()), ...(nonce ? { nonce } : {}),
    });
    receipt = write(transaction, initialReceipt(transaction, plan, selected, now), fsImpl);
    const result = await executeSelection(selected, receipt, transaction, {
      fsImpl, now, refreshAffectedCatalog,
    });
    receipt = result.receipt;
    if (!result.conclusive) {
      return { ok: false, status: receipt.status, receiptId: receipt.id, receiptFile: transaction.file };
    }
    return { ok: true, status: receipt.status, receiptId: receipt.id, receiptFile: transaction.file, receipt };
  } catch (error) {
    if (!transaction || !receipt) return refused(error);
    if (receipt.actions.some((entry) => entry.state === 'applying')) {
      receipt = recordUnknownDispatch(receipt, transaction, fsImpl, error);
      return { ok: false, status: receipt.status, error: receipt.error, receiptId: receipt.id, receiptFile: transaction.file };
    }
    receipt.error = safeText(error?.message ?? error);
    try {
      receipt = await compensate(receipt, selected, transaction, { fsImpl });
      return { ok: false, status: receipt.status, error: receipt.error, receiptId: receipt.id, receiptFile: transaction.file };
    } catch (journalError) {
      return {
        ok: false, status: 'partial-recovery-required', receiptId: receipt.id, receiptFile: transaction.file,
        error: `${receipt.error}; recovery journal failed: ${safeText(journalError?.message ?? journalError)}`,
      };
    }
  } finally {
    try { lock.release(); } catch { /* a retained lock is safer than hiding a mutation failure */ }
  }
}

function undoError(status, message) {
  return Object.assign(new Error(message), { maintenanceStatus: status });
}

function providerForUndo(entry, providers) {
  const implementation = providers?.get?.(entry.providerId);
  const eligible = implementation
    && implementation.version === entry.providerVersion
    && RECOVERABLE.has(entry.rollback)
    && typeof implementation.undo === 'function'
    && typeof implementation.verifyUndo === 'function';
  if (!eligible) throw undoError('preflight-refused', `undo provider is unavailable for action: ${entry.actionId}`);
  return implementation;
}

async function prepareUndo(receipt, providers, inspectCurrent) {
  const prepared = [];
  for (const entry of [...receipt.actions].reverse()) {
    const implementation = providerForUndo(entry, providers);
    const current = await inspectCurrent(entry, implementation);
    if (current?.postFingerprint !== entry.outcome?.postFingerprint) {
      throw undoError('drift-refused', `post-action state changed for: ${entry.actionId}`);
    }
    prepared.push({ entry, provider: implementation });
  }
  return prepared;
}

async function executeUndo(prepared, receipt, file, { fsImpl }) {
  for (const item of prepared) {
    const outcome = safeOutcome(await item.provider.undo(item.entry));
    if (!['restored', 'success'].includes(outcome.status)) {
      throw new Error(`undo outcome unknown for: ${item.entry.actionId}`);
    }
    const verification = await item.provider.verifyUndo(item.entry, outcome);
    if (verification?.ok !== true || verification.sourceFingerprint !== item.entry.sourceFingerprint) {
      throw new Error(`undo verification failed for: ${item.entry.actionId}`);
    }
    item.entry.state = 'rolled-back';
    item.entry.recovery = { status: outcome.status, verified: true };
    receipt = writeMaintenanceReceipt(file, receipt, { fsImpl });
  }
  return receipt;
}

function undoEligibility(receipt, receiptId, inspectCurrent, refreshAffectedCatalog) {
  if (receipt.status === 'rolled-back') {
    return { ok: true, status: 'already-rolled-back', receiptId };
  }
  if (receipt.status !== 'committed') {
    return { ok: false, status: 'receipt-refused', error: `receipt is not undoable: ${receipt.status}` };
  }
  if (typeof inspectCurrent !== 'function') {
    return { ok: false, status: 'preflight-refused', error: 'current-state inspection is required for undo' };
  }
  if (typeof refreshAffectedCatalog !== 'function') {
    return { ok: false, status: 'preflight-refused', error: 'affected Catalog refresh is required for undo' };
  }
  return null;
}

/** @param {any} options */
export async function undoMaintenanceReceipt({
  transactionsRoot, receiptId, providers, inspectCurrent, refreshAffectedCatalog = null,
  fsImpl = fs, now = Date.now,
} = {}) {
  let lock;
  try { lock = acquireMaintenanceLock(transactionsRoot, { fsImpl }); } catch (error) {
    return refused(error);
  }
  if (!lock) return { ok: false, status: 'busy', error: 'another maintenance mutation is active' };
  let loaded;
  let receipt = null;
  let mutationStarted = false;
  try {
    try { loaded = readMaintenanceReceipt(transactionsRoot, receiptId, { fsImpl }); } catch (error) {
      return { ok: false, status: 'receipt-refused', error: safeText(error?.message ?? error) };
    }
    const ineligible = undoEligibility(
      loaded.receipt, receiptId, inspectCurrent, refreshAffectedCatalog,
    );
    if (ineligible) return ineligible;
    receipt = loaded.receipt;
    const prepared = await prepareUndo(receipt, providers, inspectCurrent);
    receipt.status = 'undoing';
    receipt.updatedAt = new Date(now()).toISOString();
    receipt = writeMaintenanceReceipt(loaded.file, receipt, { fsImpl });
    mutationStarted = true;
    receipt = await executeUndo(prepared, receipt, loaded.file, { fsImpl });
    const refreshed = await refreshAffectedCatalog(receipt.actions.map((entry) => entry.resourceIdentity));
    if (refreshed === false || refreshed?.ok === false) {
      throw new Error('affected Catalog refresh did not complete after undo');
    }
    receipt.status = 'rolled-back';
    receipt.updatedAt = new Date(now()).toISOString();
    receipt.undo = {
      completedAt: receipt.updatedAt, guardedByPostimage: true, affectedCatalogRefreshed: true,
    };
    receipt = writeMaintenanceReceipt(loaded.file, receipt, { fsImpl });
    return { ok: true, status: receipt.status, receiptId, receiptFile: loaded.file, receipt };
  } catch (error) {
    if (!mutationStarted) {
      return { ok: false, status: error.maintenanceStatus ?? 'preflight-refused', error: safeText(error.message) };
    }
    receipt.status = 'partial-recovery-required';
    receipt.error = safeText(error?.message ?? error);
    receipt.recovery = {
      interruptedStatus: 'undoing',
      outcome: 'recovery-required',
      reason: 'undo-or-catalog-outcome-requires-reconciliation',
      inspectedAt: new Date(now()).toISOString(),
    };
    try {
      receipt = writeMaintenanceReceipt(loaded.file, receipt, { fsImpl });
    } catch (journalError) {
      return {
        ok: false,
        status: receipt.status,
        receiptId,
        error: `${receipt.error}; recovery journal failed: ${safeText(journalError?.message ?? journalError)}`,
      };
    }
    return { ok: false, status: receipt.status, receiptId, error: receipt.error };
  } finally {
    try { lock.release(); } catch { /* fail closed */ }
  }
}

export { recoverMaintenanceReceipt } from './recovery-coordinator.mjs';
