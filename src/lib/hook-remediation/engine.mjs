import fs from 'node:fs';
import path from 'node:path';

import {
  assertHookHealingPlanIntegrity, buildHookHealingPlan,
} from './planner.mjs';
import {
  atomicReplaceHookTarget, inspectHookTarget, writeHookBackup,
} from './fs-port.mjs';
import {
  backupFileForReceiptAction, createHookTransactionDir,
  HOOK_HEAL_RECEIPT_SCHEMA, lastHookReceiptId, readHookReceipt,
  writeHookReceipt,
} from './store.mjs';

function actionById(plan, id) {
  return plan.actions.find((action) => action.id === id);
}

function sameMode(snapshot, expected) {
  return snapshot.modeSupported === expected.modeSupported
    && (!snapshot.modeSupported || snapshot.mode === expected.mode);
}

function sameOwnerAndParent(snapshot, expected) {
  return snapshot.uid === (expected.uid ?? snapshot.uid)
    && snapshot.gid === (expected.gid ?? snapshot.gid)
    && snapshot.specialMode === (expected.specialMode ?? 0)
    && snapshot.parent.realPath === (expected.parent?.realPath ?? snapshot.parent.realPath)
    && snapshot.parent.dev === (expected.parent?.dev ?? snapshot.parent.dev)
    && snapshot.parent.ino === (expected.parent?.ino ?? snapshot.parent.ino);
}

function preflight(plan, actionIds, expectedPlanDigest, options) {
  assertHookHealingPlanIntegrity(plan);
  if (expectedPlanDigest !== plan.planDigest) throw new Error('stale or mismatched plan digest');
  if (!Array.isArray(actionIds) || !actionIds.length) throw new Error('at least one exact action id is required');
  if (new Set(actionIds).size !== actionIds.length) throw new Error('duplicate action ids are not allowed');
  const selected = [...actionIds].sort().map((id) => {
    const action = actionById(plan, id);
    if (!action) throw new Error(`action is not present in this plan: ${id}`);
    if (!action.executable || !['safe-automatic', 'approval-required'].includes(action.classification)) {
      throw new Error(`action is not executable: ${id}`);
    }
    return action;
  });
  const targets = new Set();
  return selected.map((action) => {
    const target = action.canonicalTarget.file;
    if (targets.has(target)) throw new Error(`multiple selected actions target the same file: ${target}`);
    targets.add(target);
    const snapshot = inspectHookTarget(target, action.canonicalTarget.containmentRoot, options);
    if (snapshot.sha256 !== action.expectedPreimage.sha256
        || snapshot.size !== action.expectedPreimage.size) {
      throw new Error(`preimage changed for ${target}`);
    }
    if (!sameMode(snapshot, action.expectedPreimage)) throw new Error(`mode changed for ${target}`);
    if (!sameOwnerAndParent(snapshot, action.expectedPreimage)) throw new Error(`owner or parent changed for ${target}`);
    return { action, snapshot };
  });
}

function findingCleared(report, action) {
  const hostReport = report.reports?.[action.host];
  if (!hostReport
      || hostReport.observedVersion !== action.hostVersion
      || hostReport.hostSchema?.confidence !== 'verified'
      || hostReport.hostSchema?.id !== action.exactProfileId) return false;
  const source = hostReport.sources?.find((candidate) => (
    path.resolve(candidate.file) === path.resolve(action.verification.sourceFile)
  ));
  if (!source || source.status !== 'valid' || source.digest !== action.desiredPostimage.sha256) return false;
  return !hostReport.records.some((record) => (
    path.resolve(record.source?.file ?? '') === path.resolve(action.verification.sourceFile)
    && record.diagnostics?.some((diagnostic) => action.verification.diagnosticCodes.includes(diagnostic.code))
  ));
}

function receiptAction(action, snapshot, backup) {
  return {
    id: action.id,
    host: action.host,
    hostVersion: action.hostVersion,
    recipeId: action.recipeId,
    target: action.canonicalTarget.file,
    containmentRoot: action.canonicalTarget.containmentRoot,
    classification: action.classification,
    profileId: action.exactProfileId,
    preimage: {
      sha256: snapshot.sha256, size: snapshot.size,
      mode: snapshot.mode, modeSupported: snapshot.modeSupported,
      uid: snapshot.uid, gid: snapshot.gid, specialMode: snapshot.specialMode,
      parent: snapshot.parent,
    },
    postimage: action.desiredPostimage,
    backup,
    state: 'prepared',
  };
}

function rollbackApplied(receipt, transactionDir, receiptFile, prepared, options) {
  let incomplete = false;
  let journalFailure = null;
  const journal = () => {
    try { receipt = writeHookReceipt(receiptFile, receipt, { fsImpl: options.fsImpl }); }
    catch (error) {
      journalFailure = error?.message ?? String(error);
      incomplete = true;
    }
  };
  receipt.status = 'partial';
  journal();
  for (const item of [...prepared].reverse()) {
    const entry = receipt.actions.find((candidate) => candidate.id === item.action.id);
    if (!entry) { incomplete = true; continue; }
    try {
      const current = inspectHookTarget(item.snapshot.file, item.snapshot.containmentRoot, options);
      const expectedMode = current.sha256 === entry.preimage.sha256 ? entry.preimage : entry.postimage;
      if (!sameOwnerAndParent(current, entry.preimage) || !sameMode(current, expectedMode)) {
        entry.state = 'rollback-drift-refused';
        incomplete = true;
        journal();
        continue;
      }
      if (current.sha256 === entry.preimage.sha256) {
        entry.state = 'rolled-back';
        journal();
        continue;
      }
      if (current.sha256 !== entry.postimage.sha256) {
        entry.state = 'rollback-drift-refused';
        incomplete = true;
        journal();
        continue;
      }
      const backupFile = backupFileForReceiptAction(transactionDir, entry);
      const backup = inspectHookTarget(backupFile, transactionDir, options);
      if (backup.sha256 !== entry.preimage.sha256 || backup.size !== entry.preimage.size) {
        throw new Error('backup digest or size mismatch');
      }
      const restored = atomicReplaceHookTarget(current, backup.bytes, entry.preimage.mode, options);
      if (restored.sha256 !== entry.preimage.sha256) throw new Error('rollback verification failed');
      entry.state = 'rolled-back';
    } catch (error) {
      entry.state = 'rollback-failed';
      entry.error = error?.message ?? String(error);
      incomplete = true;
    }
    journal();
  }
  receipt.status = incomplete ? 'partial-recovery-required' : 'rolled-back';
  journal();
  return { receipt, status: journalFailure ? 'recovery-state-write-failed' : receipt.status, journalFailure };
}

export function applyHookHealingPlan({
  plan, actionIds, expectedPlanDigest, transactionsRoot, auditFn,
  replanFn = (report) => buildHookHealingPlan({ report }), fsImpl = fs,
  platform = process.platform, faults = {}, now = () => new Date(),
} = /** @type {any} */ ({})) {
  const options = { fsImpl, platform };
  let prepared;
  try {
    prepared = preflight(plan, actionIds, expectedPlanDigest, options);
    if (typeof auditFn !== 'function') throw new Error('a read-only audit function is required for apply');
    const liveAudit = auditFn();
    const livePlan = replanFn(liveAudit);
    assertHookHealingPlanIntegrity(livePlan);
    if (livePlan.planDigest !== plan.planDigest
        || !prepared.every((item) => livePlan.actions.some((action) => action.id === item.action.id))) {
      throw new Error('audit or exact host profile changed after preview');
    }
  } catch (error) {
    return { ok: false, status: 'preflight-refused', error: error?.message ?? String(error) };
  }

  let transaction;
  let receipt;
  try {
    faults.beforeTransaction?.();
    transaction = createHookTransactionDir(transactionsRoot, { fsImpl, now });
    const receiptActions = [];
    for (const [index, item] of prepared.entries()) {
      faults.beforeBackup?.(item.action, index);
      const backup = writeHookBackup(transaction.dir, index, item.snapshot, { fsImpl });
      receiptActions.push(receiptAction(item.action, item.snapshot, backup));
    }
    receipt = {
      schemaVersion: HOOK_HEAL_RECEIPT_SCHEMA,
      id: transaction.id,
      createdAt: now().toISOString(),
      status: 'prepared',
      planDigest: plan.planDigest,
      auditId: plan.auditId,
      runtimeVersions: plan.runtimeVersions,
      authorization: {
        mechanism: 'explicit-action-selection',
        actionIds: prepared.map((item) => item.action.id).sort(),
        trustMutationAuthorized: false,
      },
      actions: receiptActions,
      verification: null,
    };
    faults.beforeReceipt?.('prepared');
    receipt = writeHookReceipt(transaction.receiptFile, receipt, { fsImpl });
    receipt.status = 'applying';
    receipt = writeHookReceipt(transaction.receiptFile, receipt, { fsImpl });

    for (const [index, item] of prepared.entries()) {
      faults.beforeReplace?.(item.action, index);
      const written = atomicReplaceHookTarget(
        item.snapshot, item.action.candidateBytes, item.action.desiredPostimage.mode, options,
      );
      if (written.sha256 !== item.action.desiredPostimage.sha256) {
        throw new Error(`postimage verification failed for ${item.snapshot.file}`);
      }
      const entry = receipt.actions.find((candidate) => candidate.id === item.action.id);
      entry.state = 'applied';
      receipt = writeHookReceipt(transaction.receiptFile, receipt, { fsImpl });
      faults.afterReplace?.(item.action, index);
    }

    receipt.status = 'verifying';
    receipt = writeHookReceipt(transaction.receiptFile, receipt, { fsImpl });
    const secondAudit = auditFn();
    if (!prepared.every((item) => findingCleared(secondAudit, item.action))) {
      throw new Error('second audit did not prove every targeted finding cleared');
    }
    const secondPlan = replanFn(secondAudit);
    if (secondPlan.actions.some((action) => prepared.some((item) => (
      action.executable && action.canonicalTarget?.file === item.action.canonicalTarget.file
    )))) throw new Error('second plan still contains a targeted executable action');
    const beforeThird = prepared.map((item) => (
      inspectHookTarget(item.snapshot.file, item.snapshot.containmentRoot, options)
    ));
    const thirdAudit = auditFn();
    replanFn(thirdAudit);
    const afterThird = prepared.map((item) => (
      inspectHookTarget(item.snapshot.file, item.snapshot.containmentRoot, options)
    ));
    const idempotentNoop = beforeThird.every((before, index) => (
      before.sha256 === afterThird[index].sha256
      && before.size === afterThird[index].size
      && before.mtimeMs === afterThird[index].mtimeMs
      && sameMode(afterThird[index], before)
    ));
    if (!idempotentNoop) throw new Error('repeat audit/plan changed target bytes, mode, or mtime');
    for (const entry of receipt.actions) entry.state = 'verified';
    receipt.status = 'committed';
    receipt.verification = {
      targetedFindingsCleared: true,
      exactProfilesReverified: true,
      idempotentNoop: true,
      trustMutationPerformed: false,
    };
    faults.beforeReceipt?.('committed');
    receipt = writeHookReceipt(transaction.receiptFile, receipt, { fsImpl });
    return {
      ok: true, status: 'committed', receiptId: receipt.id,
      receiptFile: transaction.receiptFile, receipt,
    };
  } catch (error) {
    if (!transaction) return { ok: false, status: 'backup-refused', error: error?.message ?? String(error) };
    if (!receipt) {
      const failure = {
        schemaVersion: HOOK_HEAL_RECEIPT_SCHEMA, id: transaction.id, createdAt: now().toISOString(),
        status: 'failed-before-write', planDigest: plan.planDigest, auditId: plan.auditId,
        runtimeVersions: plan.runtimeVersions,
        authorization: { actionIds: [], requestedActionIds: [...actionIds].sort() },
        actions: [], verification: null, error: error?.message ?? String(error),
      };
      try {
        const saved = writeHookReceipt(transaction.receiptFile, failure, { fsImpl });
        return {
          ok: false, status: saved.status, error: saved.error,
          receiptId: saved.id, receiptFile: transaction.receiptFile,
        };
      } catch (receiptError) {
        return {
          ok: false, status: 'failure-receipt-write-failed',
          error: `${failure.error}; recovery receipt failed: ${receiptError?.message ?? String(receiptError)}`,
          receiptId: transaction.id, receiptFile: transaction.receiptFile,
        };
      }
    }
    receipt.error = error?.message ?? String(error);
    const rollback = rollbackApplied(receipt, transaction.dir, transaction.receiptFile, prepared, options);
    receipt = rollback.receipt;
    return {
      ok: false, status: rollback.status,
      error: rollback.journalFailure ? `${receipt.error}; recovery journal failed: ${rollback.journalFailure}` : receipt.error,
      receiptId: receipt.id, receiptFile: transaction.receiptFile,
    };
  }
}

function selectedReceipt(transactionsRoot, receiptId, last, fsImpl) {
  const selectedId = last ? lastHookReceiptId(transactionsRoot, { fsImpl }) : receiptId;
  if (!selectedId) throw new Error('no hook receipt found');
  return { selectedId, ...readHookReceipt(transactionsRoot, selectedId, { fsImpl }) };
}

export function undoHookHealing({
  transactionsRoot, receiptId, last = false, fsImpl = fs, platform = process.platform,
  now = () => new Date(),
} = /** @type {any} */ ({})) {
  let loaded;
  try { loaded = selectedReceipt(transactionsRoot, receiptId, last, fsImpl); } catch (error) {
    return { ok: false, status: 'receipt-refused', error: error?.message ?? String(error) };
  }
  return performReceiptRollback(loaded, {
    allowedStatuses: ['committed', 'rolled-back'], mode: 'undo', fsImpl, platform, now,
  });
}

function preflightReceiptRollback(receipt, dir, options) {
  return receipt.actions.map((action) => {
    const current = inspectHookTarget(action.target, action.containmentRoot, options);
    const backupFile = backupFileForReceiptAction(dir, action);
    const backup = inspectHookTarget(backupFile, dir, options);
    if (backup.sha256 !== action.preimage.sha256 || backup.size !== action.preimage.size) {
      throw new Error(`backup integrity failed for ${action.target}`);
    }
    if (!sameOwnerAndParent(current, action.preimage)) throw new Error(`owner or parent drift at ${action.target}`);
    if (current.sha256 === action.preimage.sha256) {
      if (!sameMode(current, action.preimage)) throw new Error(`preimage mode drift at ${action.target}`);
      return { action, current, backup, status: 'already-restored' };
    }
    if (current.sha256 !== action.postimage.sha256 || !sameMode(current, action.postimage)) {
      throw new Error(`postimage drift at ${action.target}`);
    }
    return { action, current, backup, status: 'ready' };
  });
}

function performReceiptRollback(loaded, {
  allowedStatuses, mode, fsImpl, platform, now,
}) {
  const { receipt, dir, file, selectedId } = loaded;
  if (!allowedStatuses.includes(receipt.status)) {
    return { ok: false, status: 'receipt-refused', error: `receipt status is not eligible for ${mode}: ${receipt.status}` };
  }
  if (receipt.status === 'rolled-back') return { ok: true, status: 'already-rolled-back', receiptId: selectedId };
  const options = { fsImpl, platform };
  let restorations;
  try {
    restorations = preflightReceiptRollback(receipt, dir, options);
  } catch (error) {
    return { ok: false, status: 'drift-refused', error: error?.message ?? String(error) };
  }
  receipt.status = 'undoing';
  receipt.recovery = { mode, startedAt: now().toISOString(), guardedByImageDigests: true };
  try { writeHookReceipt(file, receipt, { fsImpl }); } catch (error) {
    return { ok: false, status: 'recovery-state-write-failed', error: error?.message ?? String(error), receiptId: selectedId };
  }
  try {
    for (const restoration of restorations) {
      const { action, current, backup } = restoration;
      if (restoration.status === 'ready') {
        const rechecked = inspectHookTarget(action.target, action.containmentRoot, options);
        if (rechecked.sha256 !== current.sha256 || !sameMode(rechecked, current)
            || !sameOwnerAndParent(rechecked, current)) {
          throw new Error(`postimage changed before restore: ${action.target}`);
        }
        const restored = atomicReplaceHookTarget(rechecked, backup.bytes, action.preimage.mode, options);
        if (restored.sha256 !== action.preimage.sha256 || !sameMode(restored, action.preimage)) {
          throw new Error(`restore verification failed for ${action.target}`);
        }
      }
      action.state = 'rolled-back';
      writeHookReceipt(file, receipt, { fsImpl });
    }
    receipt.status = 'rolled-back';
    receipt.recovery.completedAt = now().toISOString();
    if (mode === 'undo') receipt.undo = { completedAt: receipt.recovery.completedAt, guardedByPostimage: true };
    writeHookReceipt(file, receipt, { fsImpl });
    return { ok: true, status: 'rolled-back', receiptId: selectedId, receiptFile: file };
  } catch (error) {
    receipt.status = 'partial-recovery-required';
    receipt.recovery.error = error?.message ?? String(error);
    try { writeHookReceipt(file, receipt, { fsImpl }); } catch (writeError) {
      return {
        ok: false, status: 'recovery-state-write-failed', receiptId: selectedId,
        error: `${receipt.recovery.error}; recovery journal failed: ${writeError?.message ?? String(writeError)}`,
      };
    }
    return { ok: false, status: 'partial-recovery-required', error: receipt.recovery.error, receiptId: selectedId };
  }
}

const RECOVERABLE_STATUSES = [
  'prepared', 'applying', 'verifying', 'undoing', 'failed', 'failed-before-write',
  'failed-before-prepared-receipt', 'partial', 'partial-recovery-required',
];

function previewReceiptRollback(loaded, { allowedStatuses, fsImpl, platform, mode }) {
  if (!allowedStatuses.includes(loaded.receipt.status)) {
    return { ok: false, status: 'receipt-refused', error: `receipt status is not eligible for ${mode}: ${loaded.receipt.status}` };
  }
  try {
    const actions = preflightReceiptRollback(loaded.receipt, loaded.dir, { fsImpl, platform }).map((item) => ({
      id: item.action.id, target: item.action.target, status: item.status,
      backupVerified: true, expectedPostimage: item.action.postimage.sha256,
      restorePreimage: item.action.preimage.sha256,
    }));
    return { ok: true, status: 'dry-run', mode, receiptId: loaded.selectedId, actions };
  } catch (error) {
    return { ok: false, status: 'drift-refused', error: error?.message ?? String(error) };
  }
}

export function previewHookHealingUndo({
  transactionsRoot, receiptId, last = false, fsImpl = fs, platform = process.platform,
} = /** @type {any} */ ({})) {
  let loaded;
  try { loaded = selectedReceipt(transactionsRoot, receiptId, last, fsImpl); } catch (error) {
    return { ok: false, status: 'receipt-refused', error: error?.message ?? String(error) };
  }
  return previewReceiptRollback(loaded, {
    allowedStatuses: ['committed', 'rolled-back'], fsImpl, platform, mode: 'undo',
  });
}

export function recoverHookHealing({
  transactionsRoot, receiptId, fsImpl = fs, platform = process.platform, now = () => new Date(),
} = /** @type {any} */ ({})) {
  let loaded;
  try { loaded = selectedReceipt(transactionsRoot, receiptId, false, fsImpl); } catch (error) {
    return { ok: false, status: 'receipt-refused', error: error?.message ?? String(error) };
  }
  return performReceiptRollback(loaded, {
    allowedStatuses: RECOVERABLE_STATUSES, mode: 'interrupted-transaction-recovery', fsImpl, platform, now,
  });
}

export function previewHookHealingRecovery({
  transactionsRoot, receiptId, fsImpl = fs, platform = process.platform,
} = /** @type {any} */ ({})) {
  let loaded;
  try { loaded = selectedReceipt(transactionsRoot, receiptId, false, fsImpl); } catch (error) {
    return { ok: false, status: 'receipt-refused', error: error?.message ?? String(error) };
  }
  return previewReceiptRollback(loaded, {
    allowedStatuses: RECOVERABLE_STATUSES, fsImpl, platform, mode: 'interrupted-transaction-recovery',
  });
}
