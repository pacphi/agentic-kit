import { sendJson } from '../loopback-server.mjs';
import {
  createMaintenanceCapabilityStore, readMaintenanceJson, validateMaintenanceBody,
} from './maintenance-security.mjs';

const SUMMARY_KEYS = [
  'total', 'actionable', 'incompleteSources', 'updatesReady', 'safeCleanup',
  'needsReview', 'unsupportedOrBlocked', 'blocked', 'recentChanges',
];
const VERSION_KEYS = [
  'installed', 'installedVersion', 'effective', 'effectiveVersion', 'recommended',
  'recommendedVersion', 'producer', 'producerVersion', 'marketplaceRevision',
  'sourceRevision', 'cacheGeneration', 'contentDigest',
];
const RESOURCE_KEYS = ['kind', 'id', 'name', 'host', 'scope', 'providerId', 'providerRef', 'projectRef'];

function text(value, max = 500) {
  return typeof value === 'string'
    ? Array.from(value, (character) => {
      const point = character.codePointAt(0);
      return point <= 31 || point === 127 ? ' ' : character;
    }).join('').slice(0, max)
    : null;
}

function textList(value, maxItems = 100) {
  return Array.isArray(value) ? value.slice(0, maxItems).map((item) => text(item, 300)).filter(Boolean) : [];
}

function picked(source, keys, max = 300) {
  const value = source && typeof source === 'object' ? source : {};
  return Object.fromEntries(keys.flatMap((key) => {
    const item = value[key];
    if (typeof item === 'boolean' || Number.isFinite(item)) return [[key, item]];
    const safe = text(item, max);
    return safe === null ? [] : [[key, safe]];
  }));
}

function publicResource(value) {
  return picked(value, RESOURCE_KEYS, 200);
}

function publicFinding(finding) {
  const value = finding && typeof finding === 'object' ? finding : {};
  const evidence = value.evidence && typeof value.evidence === 'object' ? value.evidence : {};
  const impact = value.impact && typeof value.impact === 'object' ? value.impact : {};
  const next = value.nextAction && typeof value.nextAction === 'object' ? value.nextAction : {};
  return {
    ...picked(value, ['id', 'state', 'bucket', 'classification', 'safetyClass', 'headline', 'explanation', 'owner']),
    resource: publicResource(value.resource),
    versions: picked(value.versions, VERSION_KEYS),
    ownership: picked(value.ownership, ['owner', 'authority', 'managed']),
    evidence: {
      ...picked(evidence, ['asOf', 'freshness', 'completeness', 'status', 'source', 'authority', 'health']),
      sources: textList(evidence.sources), gaps: textList(evidence.gaps), reasons: textList(evidence.reasons),
    },
    observedUsage: picked(value.observedUsage, ['status', 'statement']),
    impact: {
      ...picked(impact, ['summary', 'bytes', 'files', 'dependencies', 'capabilities', 'projects', 'preserved']),
    },
    nextAction: picked(next, [
      'operation', 'label', 'providerId', 'providerVersion', 'safetyClass', 'rollback',
      'restart', 'executable', 'summary', 'guidance',
    ]),
  };
}

function publicReceipt(receipt) {
  const value = receipt && typeof receipt === 'object' ? receipt : {};
  const actions = Array.isArray(value.actions) ? value.actions.slice(0, 100).map((action) => ({
    ...picked(action, [
      'actionId', 'providerId', 'providerVersion', 'operation', 'classification', 'rollback',
      'restart', 'sourceFingerprint', 'state',
    ]),
    resourceIdentity: publicResource(action.resourceIdentity),
    outcome: picked(action.outcome, ['status', 'postFingerprint', 'summary', 'exitCode', 'timedOut']),
    verification: picked(action.verification, ['verified', 'postFingerprint']),
    recovery: picked(action.recovery, ['status', 'verified']),
  })) : [];
  return {
    ...picked(value, [
      'id', 'status', 'planId', 'planDigest', 'sourceFingerprint', 'createdAt', 'updatedAt',
      'completedAt', 'headline', 'label', 'summary', 'statusLabel', 'undoStatus',
    ]),
    actions,
    verification: picked(value.verification, [
      'nativeStateVerified', 'affectedCatalogRescanned', 'affectedCatalogRescanRequired',
    ]),
    undo: picked(value.undo, ['completedAt', 'guardedByPostimage']),
  };
}

export function publicMaintenanceModel(model) {
  const value = model && typeof model === 'object' ? model : {};
  const findings = Array.isArray(value.findings) ? value.findings.slice(0, 5_000).map(publicFinding) : [];
  const receipts = Array.isArray(value.receipts) ? value.receipts.slice(0, 100).map(publicReceipt) : [];
  const suppliedSummary = picked(value.summary, SUMMARY_KEYS);
  const incompleteSources = findings.filter((finding) => finding.evidence?.completeness !== 'complete').length;
  const unsupportedOrBlocked = suppliedSummary.unsupportedOrBlocked ?? suppliedSummary.blocked ?? 0;
  return {
    ...picked(value, ['schemaVersion', 'mode', 'asOf', 'sourceFingerprint']),
    capabilities: picked(value.capabilities, ['plan', 'apply', 'undo']),
    freshness: {
      ...picked(value.freshness, ['asOf', 'ageMs', 'status', 'completeness']),
      gaps: textList(value.freshness?.gaps),
    },
    summary: {
      ...suppliedSummary,
      total: suppliedSummary.total ?? findings.length,
      actionable: suppliedSummary.actionable
        ?? findings.filter((finding) => finding.nextAction?.executable === true).length,
      incompleteSources: suppliedSummary.incompleteSources ?? incompleteSources,
      unsupportedOrBlocked,
      blocked: unsupportedOrBlocked,
      recentChanges: suppliedSummary.recentChanges ?? receipts.length,
    },
    findings,
    receipts,
    providers: Array.isArray(value.providers) ? value.providers.slice(0, 100).map((provider) => ({
      ...picked(provider, ['id', 'version', 'status', 'reason']),
      resourceKinds: textList(provider.resourceKinds), operations: textList(provider.operations),
      rollback: textList(provider.rollback),
    })) : [],
  };
}

function publicPlan(plan) {
  const value = plan && typeof plan === 'object' ? plan : {};
  return {
    ...picked(value, [
      'schemaVersion', 'mode', 'planId', 'planDigest', 'sourceFingerprint', 'generatedAt',
      'expiresAt', 'safetyClass',
    ]),
    capabilities: picked(value.capabilities, ['plan', 'apply', 'undo']),
    findingIds: textList(value.findingIds),
    actions: Array.isArray(value.actions) ? value.actions.slice(0, 100).map((action) => ({
      ...picked(action, [
        'id', 'providerId', 'providerVersion', 'operation', 'classification',
        'findingClassification', 'rollback', 'restart', 'executable', 'sourceFingerprint',
      ]),
      resourceIdentity: publicResource(action.resourceIdentity),
    })) : [],
  };
}

function confirmationForPlan(plan) {
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const rollback = [...new Set(actions.map((action) => action.rollback).filter(Boolean))];
  const typedPhrase = actions.length > 1 || plan.safetyClass === 'approval-required'
    || rollback.includes('irreversible') ? `APPLY ${actions.length}` : null;
  return {
    title: actions.length === 1 ? 'Confirm maintenance action' : `Confirm ${actions.length} maintenance actions`,
    summary: 'The server will recheck native inventory and the exact plan before changing anything.',
    actionCount: actions.length,
    safetyClass: text(plan.safetyClass, 80),
    rollback: rollback.join(', ') || 'unknown',
    restart: [...new Set(actions.map((action) => action.restart).filter(Boolean))].join(', ') || 'unknown',
    typedPhrase,
    expiresAt: text(plan.expiresAt, 80),
  };
}

function assertExecutablePlan(plan) {
  if (!plan?.planId || !plan?.planDigest || !plan?.sourceFingerprint
      || !Array.isArray(plan.actions) || plan.actions.length < 1
      || plan.actions.length > 100 || plan.actions.some((action) => action?.executable !== true)) {
    throw new Error('selected findings do not have an executable provider plan');
  }
}

function publicOutcome(result) {
  const value = result && typeof result === 'object' ? result : {};
  return {
    ok: value.ok === true,
    status: text(value.status, 100) ?? (value.ok === true ? 'complete' : 'refused'),
    ...(value.receipt || value.receiptId ? {
      receipt: publicReceipt(value.receipt ?? { id: value.receiptId, status: value.status }),
    } : {}),
  };
}

function typedPhraseMatches(body, required) {
  return required == null || body.typedPhrase === required;
}

/** Dashboard transport adapter. The application service owns plans and
 * provider execution; this boundary owns browser authority and projections. */
export function createMaintenanceDashboardApi({ service, sessionToken, now = Date.now, capabilities } = {}) {
  if (!service || typeof service.scan !== 'function' || typeof service.plan !== 'function') {
    throw new TypeError('maintenance dashboard service must implement scan and plan');
  }
  const store = capabilities ?? createMaintenanceCapabilityStore({ now });

  async function scan(_req, res) {
    try { sendJson(res, 200, publicMaintenanceModel(await service.scan())); }
    catch { sendJson(res, 503, { error: 'maintenance evidence unavailable' }); }
  }

  async function createPlan(body, res) {
    const plan = await service.plan({ findingIds: body.findingIds, executable: true });
    assertExecutablePlan(plan);
    const confirmation = confirmationForPlan(plan);
    const actionIds = plan.actions.map((action) => action.id);
    const capability = store.mint({
      sessionToken, verb: 'apply', expiresAt: Date.parse(plan.expiresAt),
      authority: { plan, actionIds, expectedPlanDigest: plan.planDigest, confirmation },
    });
    sendJson(res, 200, { plan: publicPlan(plan), capability, confirmation });
  }

  async function apply(body, res) {
    const authority = store.consume({ capability: body.capability, sessionToken, verb: 'apply' });
    if (!typedPhraseMatches(body, authority.confirmation.typedPhrase)) {
      sendJson(res, 409, { error: 'confirmation phrase did not match the preview' });
      return;
    }
    if (typeof service.apply !== 'function') throw new Error('maintenance apply is unavailable');
    const result = await service.apply({
      plan: authority.plan,
      actionIds: authority.actionIds,
      expectedPlanDigest: authority.expectedPlanDigest,
    });
    const payload = publicOutcome(result);
    sendJson(res, payload.ok ? 200 : 409, payload);
  }

  async function previewUndo(body, res) {
    const prepare = service.prepareUndo ?? service.undoPreview;
    if (typeof prepare !== 'function') throw new Error('maintenance undo preview is unavailable');
    const preview = await prepare.call(service, { receiptId: body.receiptId });
    if (!preview || preview.undoable !== true) {
      sendJson(res, 409, {
        error: 'maintenance receipt is not currently undoable',
        preview: picked(preview, ['receiptId', 'status', 'summary', 'reason', 'undoable', 'actionCount']),
      });
      return;
    }
    const confirmation = {
      title: 'Confirm guarded undo',
      summary: text(preview.summary) ?? 'Current native state will be compared with the recorded postimage before undo.',
      actionCount: Number.isFinite(preview.actionCount) ? preview.actionCount : 1,
      typedPhrase: 'UNDO',
      expiresAt: new Date(now() + 5 * 60_000).toISOString(),
    };
    const capability = store.mint({
      sessionToken, verb: 'undo', expiresAt: Date.parse(confirmation.expiresAt),
      authority: { receiptId: body.receiptId, confirmation },
    });
    sendJson(res, 200, { capability, confirmation });
  }

  async function undo(body, res) {
    const authority = store.consume({ capability: body.capability, sessionToken, verb: 'undo' });
    if (!typedPhraseMatches(body, authority.confirmation.typedPhrase)) {
      sendJson(res, 409, { error: 'confirmation phrase did not match the preview' });
      return;
    }
    if (typeof service.undo !== 'function') throw new Error('maintenance undo is unavailable');
    const result = await service.undo({ receiptId: authority.receiptId });
    const payload = publicOutcome(result);
    sendJson(res, payload.ok ? 200 : 409, payload);
  }

  async function mutate(route, req, res) {
    try {
      const body = validateMaintenanceBody(route, await readMaintenanceJson(req));
      if (route === '/api/maintenance/plans') await createPlan(body, res);
      else if (route === '/api/maintenance/apply') await apply(body, res);
      else if (body.preview) await previewUndo(body, res);
      else await undo(body, res);
    } catch (error) {
      const status = error?.statusCode ?? (error instanceof TypeError ? 400
        : (/capability|expired|plan|confirmation|undoable/.test(error?.message ?? '') ? 409 : 503));
      sendJson(res, status, {
        error: status === 413 ? 'maintenance request body is too large'
          : status === 415 ? 'maintenance requests require application/json'
            : status === 400 ? 'invalid maintenance request'
              : status === 409 ? 'maintenance request is stale or no longer authorized'
                : 'maintenance operation unavailable',
      });
    }
  }

  return Object.freeze({ scan, mutate, capabilityCount: store.size });
}
