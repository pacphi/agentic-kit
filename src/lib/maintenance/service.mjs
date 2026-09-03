import fs from 'node:fs';
import path from 'node:path';

import { createSystemCollector } from '../footprint/index.mjs';
import { maintenanceControlDir } from '../paths.mjs';
import { applyMaintenancePlan, undoMaintenanceReceipt } from './coordinator.mjs';
import { projectReference } from './evidence.mjs';
import { deepFreeze } from './model.mjs';
import {
  ensurePrivateMaintenanceRoot, readMaintenancePlanEnvelope, writeMaintenancePlanEnvelope,
} from './plan-store.mjs';
import {
  assertExecutableMaintenancePlanIntegrity, buildExecutableMaintenancePlan, buildMaintenancePlan,
} from './planner.mjs';
import {
  createDefaultMaintenanceProviderRegistry, publicMaintenanceProviders,
} from './provider-registry.mjs';
import { buildMaintenanceReadModel } from './read-model.mjs';
import { readMaintenanceReceipt } from './transaction-store.mjs';

const EXECUTABLE_CLASSES = new Set(['safe-automatic', 'approval-required']);

function exactFindings(model, { findingIds = null, safetyClass = null, project = null } = {}) {
  const requested = findingIds ? new Set(findingIds) : null;
  const selectedProject = projectReference(project);
  const findings = model.findings.filter((finding) => (
    (!requested || requested.has(finding.id))
    && (!safetyClass || finding.safetyClass === safetyClass)
    && (!selectedProject || finding.resource.projectRef === selectedProject)
  ));
  if (requested) {
    const missing = [...requested].filter((id) => !findings.some((finding) => finding.id === id));
    if (missing.length) throw new Error(`Maintenance findings are absent or drifted: ${missing.join(', ')}`);
  }
  return findings;
}

async function providerActions(findings, providers) {
  const detections = new Map();
  const actions = [];
  for (const finding of findings) {
    if (!EXECUTABLE_CLASSES.has(finding.safetyClass)) {
      throw new Error(`Finding is not executable under its safety classification: ${finding.id}`);
    }
    const candidates = [...providers.values()].filter((provider) => (
      provider.resourceKinds.includes(finding.resource.kind)
      && provider.operations.includes(finding.nextAction?.operation)
      && (!provider.host || provider.host === finding.resource.host)
    ));
    const derived = [];
    for (const provider of candidates) {
      if (!detections.has(provider.id)) {
        let facts;
        try { facts = await provider.detect(); } catch { facts = null; }
        detections.set(provider.id, facts);
      }
      const facts = detections.get(provider.id);
      if (facts?.status !== 'available' || facts.complete !== true
          || facts.authority !== 'native-inventory') continue;
      let action;
      try { action = provider.actionFor(finding, facts); } catch { action = null; }
      if (action) derived.push(action);
    }
    if (derived.length > 1) throw new Error(`Native provider resolution is ambiguous for finding: ${finding.id}`);
    if (!derived.length) throw new Error(`No executable native provider is available for finding: ${finding.id}`);
    actions.push(derived[0]);
  }
  return actions;
}

function publicResult(result) {
  if (!result || typeof result !== 'object') return result;
  const { receiptFile: _receiptFile, ...safe } = result;
  return deepFreeze(structuredClone(safe));
}

function undoPreview(receiptId, undoable, actionCount, summary, reason = null) {
  return deepFreeze({
    receiptId: String(receiptId ?? ''), undoable, actionCount, summary,
    ...(reason ? { reason } : {}),
  });
}

/** Application service shared by CLI and dashboard adapters. Read operations
 * remain side-effect free; mutation requires a provider-derived plan plus an
 * exact, explicit confirmation at the adapter boundary.
 * @param {any} options */
export function createMaintenanceService({
  collector = createSystemCollector(),
  now = Date.now,
  providers = createDefaultMaintenanceProviderRegistry(),
  controlRoot = maintenanceControlDir(),
  fsImpl = fs,
  nonce,
} = {}) {
  const plansRoot = path.join(controlRoot, 'plans');
  const transactionsRoot = path.join(controlRoot, 'transactions');

  async function scan({ deep = false } = {}) {
    if (deep) await collector.refreshDeep();
    const footprint = await collector.read();
    const model = buildMaintenanceReadModel({ footprint, now });
    return deepFreeze({
      ...model,
      providers: publicMaintenanceProviders(providers, { includeUnsupported: true }),
    });
  }

  async function createPlan({
    findingIds = null, safetyClass = null, project = null, deep = false,
    executable = false, persist = false, generatedAt = null,
  } = {}) {
    const model = await scan({ deep });
    const findings = exactFindings(model, { findingIds, safetyClass, project });
    if (!executable) {
      if (persist) throw new Error('Only executable maintenance plans may be persisted.');
      return buildMaintenancePlan({ findings, sourceFingerprint: model.sourceFingerprint, now });
    }
    const actions = await providerActions(findings, providers);
    const result = buildExecutableMaintenancePlan({
      findings,
      actions,
      sourceFingerprint: model.sourceFingerprint,
      now: generatedAt == null ? now : () => generatedAt,
    });
    if (persist) {
      ensurePrivateMaintenanceRoot(controlRoot, { fsImpl });
      writeMaintenancePlanEnvelope(plansRoot, result, { fsImpl, now });
    }
    return result;
  }

  async function plan(options = {}) {
    return createPlan(options);
  }

  function loadPlan(planId) {
    ensurePrivateMaintenanceRoot(controlRoot, { fsImpl });
    return readMaintenancePlanEnvelope(plansRoot, planId, { fsImpl, now }).plan;
  }

  /** @param {any} input */
  async function apply({
    plan: suppliedPlan = null, planId = null, actionIds, expectedPlanDigest, confirmed = false,
  } = {}) {
    if (confirmed !== true) throw new Error('Explicit confirmation is required for maintenance apply.');
    if (typeof expectedPlanDigest !== 'string' || !expectedPlanDigest) {
      throw new Error('Exact maintenance plan digest is required.');
    }
    if (!Array.isArray(actionIds) || !actionIds.length) throw new Error('Exact maintenance action IDs are required.');
    ensurePrivateMaintenanceRoot(controlRoot, { fsImpl });
    const selectedPlan = suppliedPlan ?? loadPlan(planId);
    if (planId && selectedPlan.planId !== planId) throw new Error('Maintenance plan ID does not match the supplied plan.');
    assertExecutableMaintenancePlanIntegrity(selectedPlan, { now });
    const generatedAt = Date.parse(selectedPlan.generatedAt);
    const result = await applyMaintenancePlan({
      plan: selectedPlan,
      actionIds,
      expectedPlanDigest,
      providers,
      transactionsRoot,
      refreshPlan: () => createPlan({
        findingIds: selectedPlan.findingIds,
        executable: true,
        generatedAt,
      }),
      refreshAffectedCatalog: async () => collector.refreshDeep(),
      validatePlan: (candidate, options = {}) => assertExecutableMaintenancePlanIntegrity(candidate, {
        ...options,
        now: typeof options.now === 'number' ? () => options.now : (options.now ?? now),
      }),
      fsImpl,
      now,
      ...(nonce ? { nonce } : {}),
    });
    return publicResult(result);
  }

  /** @param {any} input */
  async function prepareUndo({ receiptId } = {}) {
    ensurePrivateMaintenanceRoot(controlRoot, { fsImpl });
    let receipt;
    try { ({ receipt } = readMaintenanceReceipt(transactionsRoot, receiptId, { fsImpl })); } catch {
      return undoPreview(receiptId, false, 0, 'Undo is unavailable.', 'receipt-refused');
    }
    if (receipt.status === 'rolled-back') {
      return undoPreview(receiptId, false, 0, 'This maintenance change was already undone.', 'already-rolled-back');
    }
    if (receipt.status !== 'committed') {
      return undoPreview(receiptId, false, 0, 'This maintenance change is not undoable.', 'receipt-refused');
    }
    const actions = [];
    for (const entry of [...receipt.actions].reverse()) {
      const provider = providers.get(entry.providerId);
      if (!provider || provider.version !== entry.providerVersion
          || !['reversible', 'compensating'].includes(entry.rollback)
          || typeof provider.inspectCurrent !== 'function'
          || typeof provider.undo !== 'function' || typeof provider.verifyUndo !== 'function') {
        return undoPreview(receiptId, false, 0, 'The owning provider cannot safely undo this change.', 'provider-unavailable');
      }
      const current = await provider.inspectCurrent(entry);
      if (current?.postFingerprint !== entry.outcome?.postFingerprint) {
        return undoPreview(receiptId, false, 0, 'The resource changed after maintenance; undo is blocked.', 'drift-refused');
      }
      actions.push({
        actionId: entry.actionId,
        operation: entry.operation,
        resourceIdentity: entry.resourceIdentity,
        rollback: entry.rollback,
      });
    }
    return undoPreview(receiptId, true, actions.length, `${actions.length} maintenance action(s) can be safely undone.`);
  }

  /** @param {any} input */
  async function undo({ receiptId, confirmed = false } = {}) {
    if (confirmed !== true) throw new Error('Explicit confirmation is required for maintenance undo.');
    ensurePrivateMaintenanceRoot(controlRoot, { fsImpl });
    const result = await undoMaintenanceReceipt({
      transactionsRoot,
      receiptId,
      providers,
      inspectCurrent: (entry, provider) => provider.inspectCurrent(entry),
      fsImpl,
      now,
    });
    if (result.ok) await collector.refreshDeep();
    return publicResult(result);
  }

  return Object.freeze({ scan, plan, apply, prepareUndo, undo });
}
