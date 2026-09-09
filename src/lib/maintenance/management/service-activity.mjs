// ADR-0048 facade activity/audit/disposition methods. `auditInterruption`
// and `reconcile` are pure pass-throughs to the existing transaction engine
// (T owns their real behavior); this module's job is composing the read-only
// evidence `buildActivity` needs and translating a guidanceId into the exact
// disposition identity Q's ledger requires.
import { buildActivity, exportReceipt as qExportReceipt, receiptDetail } from './activity.mjs';
import { readMaintenanceReceipt, listMaintenanceReceiptsReadOnly } from '../transaction-store.mjs';
import { loadLastGoodInventory } from './service-inventory.mjs';

const IN_PROGRESS_SCAN_STATES = new Set(['queued', 'scanning', 'checkpointed', 'paused']);

function scanInProgressEntries(ctx) {
  const orchestratorProgress = ctx.orchestrator().progress()
    .filter((entry) => IN_PROGRESS_SCAN_STATES.has(entry.state))
    .map((entry) => ({ kind: 'discovery-scan', ...entry }));
  const maintenanceScan = ctx.maintenance.scanState();
  const maintenanceEntry = maintenanceScan?.status === 'running'
    ? [{ kind: 'maintenance-scan', ...maintenanceScan }] : [];
  return [...maintenanceEntry, ...orchestratorProgress];
}

/** `activity()` — the six Activity groups over already-loaded evidence
 * (MNT-ACT-001..012). Read-only; never runs a collector or a provider. */
export function activity(ctx) {
  return function activityCall() {
    const receipts = listMaintenanceReceiptsReadOnly(ctx.transactionsRoot, { fsImpl: ctx.fsImpl });
    return buildActivity({
      receipts,
      dispositions: ctx.dispositionStore.listDispositions(),
      recipeEvents: ctx.recipeStore.listRecipeEvents(),
      scanHistory: ctx.scanHistoryStore.list().map((entry) => ({
        ...entry, label: entry.label || ctx.listSources().find((source) => source.sourceId === entry.sourceId)?.label || 'Source no longer configured',
      })),
      inProgress: scanInProgressEntries(ctx),
    });
  };
}

/** `receipt({ receiptId })` — the owner's in-app receipt detail (never the
 * export's stricter default redaction). */
export function receipt(ctx) {
  return function receiptCall({ receiptId }) {
    const { receipt: loaded } = readMaintenanceReceipt(ctx.transactionsRoot, receiptId, { fsImpl: ctx.fsImpl });
    return receiptDetail(loaded);
  };
}

/** `exportReceipt({ receiptId, includeLocalPaths })` — the stricter
 * export-safe redaction. Reaching this facade method with
 * `includeLocalPaths: true` at all IS the acknowledgment: the dashboard API
 * layer (agent A) gates the request behind its own confirmed, same-origin,
 * owner-only route before it ever reaches here. */
export function exportReceiptMethod(ctx) {
  return function exportReceiptCall({ receiptId, includeLocalPaths = false }) {
    const { receipt: loaded } = readMaintenanceReceipt(ctx.transactionsRoot, receiptId, { fsImpl: ctx.fsImpl });
    return qExportReceipt(loaded, { includeLocalPaths, acknowledgedWarning: includeLocalPaths === true });
  };
}

export function auditInterruption(ctx) {
  return function auditInterruptionCall({ receiptIds }) {
    return ctx.maintenance.auditInterruption({ receiptIds });
  };
}

export function reconcile(ctx) {
  return function reconcileCall({ receiptId, outcome, confirmed = false }) {
    return ctx.maintenance.reconcile({ receiptId, outcome, confirmed });
  };
}

function findGuidanceEntry(inventory, guidanceId) {
  const entry = (inventory?.guidanceEntries ?? []).find((candidate) => candidate.guidanceId === guidanceId);
  if (!entry) throw new TypeError(`unknown guidanceId: ${guidanceId}`);
  return entry;
}

function candidateVersionOf(inventory, placementId) {
  return (inventory?.versionObservations ?? [])
    .find((observation) => observation.subjectId === placementId && observation.axis === 'candidate')?.value ?? null;
}

/** What Q's `invalidateDispositions` (dispositions.mjs) compares against on
 * every future refresh: the exact evidence this disposition was granted
 * against, so a later change to any of it resurfaces the guidance early
 * (DISPOSITION_INVALIDATIONS: candidate-change, installed-version-change,
 * source-fingerprint-drift). Only fields the placement/inventory actually
 * carry are captured — an absent field is never invented as `null`. */
function invalidationInputsFor(inventory, placementId) {
  const placement = (inventory?.placements ?? []).find((entry) => entry.placementId === placementId);
  const inputs = { sourceFingerprint: inventory.sourceFingerprint };
  if (placement?.versions?.installed != null) inputs.installedVersion = placement.versions.installed;
  const candidate = candidateVersionOf(inventory, placementId);
  if (candidate != null) inputs.candidate = candidate;
  return inputs;
}

/** `recordDisposition({ guidanceId, kind, until?, confirmed })` — requires
 * explicit confirmation (ADR-0048 §11); resolves `guidanceId` to its exact
 * `dispositionIdentity` from the last-good inventory and captures the
 * evidence Q's invalidation logic needs to resurface it on drift. */
export function recordDisposition(ctx) {
  return function recordDispositionCall({
    guidanceId, kind, until = null, confirmed = false,
  }) {
    if (confirmed !== true) throw new Error('Explicit confirmation is required to record a disposition.');
    const inventory = loadLastGoodInventory(ctx);
    const entry = findGuidanceEntry(inventory, guidanceId);
    return ctx.dispositionStore.recordDisposition({
      guidanceId,
      dispositionIdentity: entry.dispositionIdentity,
      kind,
      until,
      invalidationInputs: invalidationInputsFor(inventory, entry.placementId),
    });
  };
}

export function dispositions(ctx) {
  return function dispositionsCall() {
    return ctx.dispositionStore.listDispositions();
  };
}
