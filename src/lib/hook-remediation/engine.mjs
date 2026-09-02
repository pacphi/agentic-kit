import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from '../hook-audit/common.mjs';
import {
  buildHookHealingPlan, hookHealingPlanDigest, HOOK_HEAL_PLAN_SCHEMA,
} from './planner.mjs';
import {
  assertHookTargetUnchanged, atomicReplaceHookTarget, inspectHookTarget, writeHookBackup,
} from './fs-port.mjs';
import {
  createHookTransactionDir, HOOK_HEAL_RECEIPT_SCHEMA, lastHookReceiptId,
  readHookReceipt, writeHookReceipt,
} from './store.mjs';

function actionById(plan, id) {
  return plan.actions.find((action) => action.id === id);
}

function preflight(plan, actionIds, expectedPlanDigest, options) {
  if (plan?.schemaVersion !== HOOK_HEAL_PLAN_SCHEMA) throw new Error('unsupported hook healing plan schema');
  if (hookHealingPlanDigest(plan) !== plan.planDigest) throw new Error('hook healing plan integrity check failed');
  if (expectedPlanDigest !== plan.planDigest) throw new Error('stale or mismatched plan digest');
  const unique = [...new Set(actionIds ?? [])].sort();
  if (!unique.length) throw new Error('at least one exact action id is required');
  const selected = unique.map((id) => {
    const action = actionById(plan, id);
    if (!action) throw new Error(`action is not present in this plan: ${id}`);
    if (!action.executable || !['automatic-eligible', 'approval-required'].includes(action.classification)) {
      throw new Error(`action is not executable: ${id}`);
    }
    if (!Buffer.isBuffer(action.candidateBytes)
      || action.candidateBytes.length !== action.desiredPostimage?.size
      || sha256(action.candidateBytes) !== action.desiredPostimage?.sha256) {
      throw new Error(`candidate postimage integrity check failed: ${id}`);
    }
    return action;
  });
  const targets = new Set();
  const snapshots = selected.map((action) => {
    const target = action.canonicalTarget.file;
    if (targets.has(target)) throw new Error(`multiple selected actions target the same file: ${target}`);
    targets.add(target);
    const snapshot = inspectHookTarget(target, action.canonicalTarget.containmentRoot, options);
    if (snapshot.sha256 !== action.expectedPreimage.sha256) throw new Error(`preimage changed for ${target}`);
    if (snapshot.modeSupported !== action.expectedPreimage.modeSupported
      || (snapshot.modeSupported && snapshot.mode !== action.expectedPreimage.mode)) {
      throw new Error(`mode changed for ${target}`);
    }
    return { action, snapshot };
  });
  return snapshots;
}

function findingCleared(report, action) {
  const records = report.reports?.[action.host]?.records ?? [];
  return !records.some((record) => (
    record.source?.file === action.verification.sourceFile
    && record.diagnostics?.some((diagnostic) => action.verification.diagnosticCodes.includes(diagnostic.code))
  ));
}

function receiptAction(action, snapshot, backup) {
  return {
    id: action.id,
    host: action.host,
    recipeId: action.recipeId,
    target: action.canonicalTarget.file,
    containmentRoot: action.canonicalTarget.containmentRoot,
    classification: action.classification,
    profileId: action.exactProfileId,
    preimage: {
      sha256: snapshot.sha256, size: snapshot.size,
      mode: snapshot.mode, modeSupported: snapshot.modeSupported,
    },
    postimage: action.desiredPostimage,
    backup,
    state: 'prepared',
  };
}

function safeReceiptWrite(receiptFile, receipt, options) {
  return writeHookReceipt(receiptFile, receipt, options);
}

function rollbackApplied(receipt, transactionDir, prepared, options) {
  let partial = false;
  for (const item of [...prepared].reverse()) {
    const receiptEntry = receipt.actions.find((entry) => entry.id === item.action.id);
    if (!receiptEntry) continue;
    if (!['applied', 'verified'].includes(receiptEntry.state)) continue;
    try {
      const current = inspectHookTarget(item.snapshot.file, item.snapshot.containmentRoot, options);
      if (current.sha256 !== item.action.desiredPostimage.sha256) {
        receiptEntry.state = 'rollback-drift-refused';
        partial = true;
        continue;
      }
      const backupFile = path.join(transactionDir, receiptEntry.backup.relative);
      const backup = inspectHookTarget(backupFile, transactionDir, options);
      if (backup.sha256 !== receiptEntry.preimage.sha256) throw new Error('backup digest mismatch');
      const restored = atomicReplaceHookTarget(current, backup.bytes, receiptEntry.preimage.mode, options);
      if (restored.sha256 !== receiptEntry.preimage.sha256) throw new Error('rollback verification failed');
      receiptEntry.state = 'rolled-back';
    } catch (error) {
      receiptEntry.state = 'rollback-failed';
      receiptEntry.error = error?.message ?? String(error);
      partial = true;
    }
  }
  return partial ? 'partial' : 'rolled-back';
}

/** @param {any} options */
export function applyHookHealingPlan({
  plan, actionIds, expectedPlanDigest, transactionsRoot, auditFn,
  replanFn = (report) => buildHookHealingPlan({ report }), fsImpl = fs,
  platform = process.platform, faults = {}, now = () => new Date(),
} = {}) {
  const options = { fsImpl, platform };
  let prepared;
  try {
    prepared = preflight(plan, actionIds, expectedPlanDigest, options);
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
    for (const item of prepared) assertHookTargetUnchanged(item.snapshot, options);
    receipt = {
      schemaVersion: HOOK_HEAL_RECEIPT_SCHEMA,
      id: transaction.id,
      createdAt: now().toISOString(),
      status: 'prepared',
      planDigest: plan.planDigest,
      auditId: plan.auditId,
      runtimeVersions: plan.runtimeVersions,
      actions: receiptActions,
      verification: null,
    };
    faults.beforeReceipt?.('prepared');
    receipt = safeReceiptWrite(transaction.receiptFile, receipt, { fsImpl });
    receipt.status = 'applying';
    receipt = safeReceiptWrite(transaction.receiptFile, receipt, { fsImpl });

    for (const [index, item] of prepared.entries()) {
      faults.beforeReplace?.(item.action, index);
      const written = atomicReplaceHookTarget(
        item.snapshot, item.action.candidateBytes, item.action.desiredPostimage.mode, options,
      );
      if (written.sha256 !== item.action.desiredPostimage.sha256) throw new Error(`postimage verification failed for ${item.snapshot.file}`);
      const entry = receipt.actions.find((candidate) => candidate.id === item.action.id);
      entry.state = 'applied';
      receipt = safeReceiptWrite(transaction.receiptFile, receipt, { fsImpl });
      faults.afterReplace?.(item.action, index);
    }

    receipt.status = 'verifying';
    receipt = safeReceiptWrite(transaction.receiptFile, receipt, { fsImpl });
    const secondAudit = auditFn();
    if (!prepared.every((item) => findingCleared(secondAudit, item.action))) {
      throw new Error('second audit did not clear every targeted finding');
    }
    const secondPlan = replanFn(secondAudit);
    if (secondPlan.actions.some((action) => prepared.some((item) => (
      action.executable && action.canonicalTarget?.file === item.action.canonicalTarget.file
    )))) throw new Error('second plan still contains a targeted executable action');
    const beforeThird = prepared.map((item) => inspectHookTarget(item.snapshot.file, item.snapshot.containmentRoot, options));
    const thirdAudit = auditFn();
    replanFn(thirdAudit);
    const afterThird = prepared.map((item) => inspectHookTarget(item.snapshot.file, item.snapshot.containmentRoot, options));
    const idempotentNoop = beforeThird.every((before, index) => (
      before.sha256 === afterThird[index].sha256 && before.mtimeMs === afterThird[index].mtimeMs
    ));
    if (!idempotentNoop) throw new Error('third audit/plan changed target bytes or mtimes');
    for (const entry of receipt.actions) entry.state = 'verified';
    receipt.status = 'committed';
    receipt.verification = { targetedFindingsCleared: true, idempotentNoop: true };
    faults.beforeReceipt?.('committed');
    receipt = safeReceiptWrite(transaction.receiptFile, receipt, { fsImpl });
    return {
      ok: true, status: 'committed', receiptId: receipt.id,
      receiptFile: transaction.receiptFile, receipt,
    };
  } catch (error) {
    if (!transaction) return { ok: false, status: 'backup-refused', error: error?.message ?? String(error) };
    receipt ??= {
      schemaVersion: HOOK_HEAL_RECEIPT_SCHEMA, id: transaction.id, createdAt: now().toISOString(),
      status: 'failed', planDigest: plan.planDigest, auditId: plan.auditId,
      runtimeVersions: plan.runtimeVersions, actions: [], verification: null,
    };
    receipt.error = error?.message ?? String(error);
    receipt.status = rollbackApplied(receipt, transaction.dir, prepared, options);
    try { receipt = safeReceiptWrite(transaction.receiptFile, receipt, { fsImpl }); } catch { /* preserve original result */ }
    return {
      ok: false, status: receipt.status, error: receipt.error,
      receiptId: receipt.id, receiptFile: transaction.receiptFile,
    };
  }
}

/** @param {any} options */
export function undoHookHealing({
  transactionsRoot, receiptId, last = false, fsImpl = fs, platform = process.platform,
  now = () => new Date(),
} = {}) {
  const selectedId = last ? lastHookReceiptId(transactionsRoot, { fsImpl }) : receiptId;
  if (!selectedId) return { ok: false, status: 'not-found', error: 'no hook receipt found' };
  let loaded;
  try { loaded = readHookReceipt(transactionsRoot, selectedId, { fsImpl }); } catch (error) {
    return { ok: false, status: 'receipt-refused', error: error?.message ?? String(error) };
  }
  const { receipt, dir, file } = loaded;
  const options = { fsImpl, platform };
  const restorations = [];
  try {
    for (const action of receipt.actions) {
      const current = inspectHookTarget(action.target, action.containmentRoot, options);
      if (current.sha256 === action.preimage.sha256) continue;
      if (current.sha256 !== action.postimage.sha256) throw new Error(`postimage drift at ${action.target}`);
      const backupFile = path.join(dir, action.backup.relative);
      const backup = inspectHookTarget(backupFile, dir, options);
      if (backup.sha256 !== action.preimage.sha256) throw new Error(`backup integrity failed for ${action.target}`);
      restorations.push({ action, current, backup });
    }
  } catch (error) {
    return { ok: false, status: 'drift-refused', error: error?.message ?? String(error) };
  }
  if (!restorations.length) return { ok: true, status: 'already-rolled-back', receiptId: selectedId };
  try {
    receipt.status = 'undoing';
    writeHookReceipt(file, receipt, { fsImpl });
    for (const { action, current, backup } of restorations) {
      const restored = atomicReplaceHookTarget(current, backup.bytes, action.preimage.mode, options);
      if (restored.sha256 !== action.preimage.sha256) throw new Error(`restore verification failed for ${action.target}`);
      action.state = 'rolled-back';
      writeHookReceipt(file, receipt, { fsImpl });
    }
    receipt.status = 'rolled-back';
    receipt.undo = { completedAt: now().toISOString(), guardedByPostimage: true };
    writeHookReceipt(file, receipt, { fsImpl });
    return { ok: true, status: 'rolled-back', receiptId: selectedId, receiptFile: file };
  } catch (error) {
    receipt.status = 'partial';
    receipt.undo = { failedAt: now().toISOString(), error: error?.message ?? String(error) };
    try { writeHookReceipt(file, receipt, { fsImpl }); } catch { /* preserve the restore failure */ }
    return { ok: false, status: 'partial', error: error?.message ?? String(error), receiptId: selectedId };
  }
}

/** @param {any} options */
export function previewHookHealingUndo({
  transactionsRoot, receiptId, last = false, fsImpl = fs, platform = process.platform,
} = {}) {
  const selectedId = last ? lastHookReceiptId(transactionsRoot, { fsImpl }) : receiptId;
  if (!selectedId) return { ok: false, status: 'not-found', error: 'no hook receipt found' };
  try {
    const { receipt, dir } = readHookReceipt(transactionsRoot, selectedId, { fsImpl });
    const options = { fsImpl, platform };
    const actions = receipt.actions.map((action) => {
      const current = inspectHookTarget(action.target, action.containmentRoot, options);
      if (current.sha256 === action.preimage.sha256) {
        return { id: action.id, target: action.target, status: 'already-restored' };
      }
      if (current.sha256 !== action.postimage.sha256) {
        throw new Error(`postimage drift at ${action.target}`);
      }
      const backup = inspectHookTarget(path.join(dir, action.backup.relative), dir, options);
      if (backup.sha256 !== action.preimage.sha256) {
        throw new Error(`backup integrity failed for ${action.target}`);
      }
      return {
        id: action.id, target: action.target, status: 'ready',
        expectedPostimage: action.postimage.sha256,
        restorePreimage: action.preimage.sha256,
      };
    });
    return { ok: true, status: 'dry-run', receiptId: selectedId, actions };
  } catch (error) {
    return { ok: false, status: 'drift-refused', error: error?.message ?? String(error) };
  }
}
