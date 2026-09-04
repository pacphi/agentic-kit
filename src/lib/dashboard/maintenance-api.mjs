import { sendJson } from '../loopback-server.mjs';
import { maintenanceReceiptPresentation } from '../maintenance/receipt-presentation.mjs';
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
const RELATIONSHIP_KINDS = new Set([
  'redundant-project-override', 'same-name-different-definition',
  'tracked-source-copy', 'legacy-equivalent-transport',
]);
const RELATIONSHIP_BASES = new Set(['same-definition', 'different-definition', 'provider-equivalent', 'unknown']);
const RELATIONSHIP_ROLES = new Set(['project-copy', 'shared-copy', 'canonical', 'legacy', 'candidate', 'preserved']);
const OWNERSHIP = new Set(['receipt-owned', 'plugin-owned', 'user-owned', 'unknown']);
const TRACKING = new Set(['tracked', 'untracked', 'unknown']);
const WORKING_TREE = new Set(['clean', 'changed', 'unknown']);
const CONSUMER_HOSTS = new Set(['claude', 'codex', 'opencode']);
const ACTIVITY_STATUSES = new Set(['idle', 'running', 'complete', 'failed']);
const ACTIVITY_PHASES = new Set(['idle', 'system', 'providers', 'persist', 'done', 'failed']);

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

// Evidence labels often prefix an absolute path with a useful surface and
// category (for example, "catalog:degraded:claude-project-skills:"). Keep
// that diagnosis while failing closed at the first local path. URLs are not
// local paths and remain useful evidence sources.
const LOCAL_PATH = /(^|[\s"'([{=:])(?:file:\/\/\/?|~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u;

function evidenceText(value, max = 300) {
  const safe = text(value, max);
  if (safe === null) return null;
  const match = LOCAL_PATH.exec(safe);
  if (!match) return safe;
  const boundary = match.index + match[1].length;
  return `${safe.slice(0, boundary)}[local path omitted]`;
}

function evidenceTextList(value, maxItems = 100) {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((item) => evidenceText(item)).filter(Boolean)
    : [];
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

function publicConsumerHosts(value) {
  if (!value || typeof value !== 'object' || value.basis !== 'catalog-presence') {
    return { basis: 'not-measured', hosts: [], count: 0, truncated: false };
  }
  const raw = Array.isArray(value.hosts) ? value.hosts : [];
  const hosts = [...new Set(raw.filter((host) => CONSUMER_HOSTS.has(host)))].sort();
  const supplied = Number.isFinite(value.count) ? Math.max(0, Math.round(value.count)) : raw.length;
  const count = Math.max(hosts.length, supplied);
  return {
    basis: 'catalog-presence', hosts, count,
    truncated: value.truncated === true || count > hosts.length || raw.length !== hosts.length,
  };
}

function publicScanActivity(value) {
  const activity = value && typeof value === 'object' ? value : {};
  const status = ACTIVITY_STATUSES.has(activity.status) ? activity.status : 'idle';
  const phase = ACTIVITY_PHASES.has(activity.phase) ? activity.phase : 'idle';
  const progress = activity.progress && typeof activity.progress === 'object'
    && Number.isFinite(activity.progress.done) && Number.isFinite(activity.progress.total)
    && activity.progress.unit === 'providers'
    ? {
      done: Math.max(0, Math.round(activity.progress.done)),
      total: Math.max(0, Math.round(activity.progress.total)), unit: 'providers',
    } : null;
  return {
    kind: 'provider', status, phase,
    startedAt: text(activity.startedAt, 40), updatedAt: text(activity.updatedAt, 40),
    finishedAt: text(activity.finishedAt, 40), progress,
  };
}

function publicRelationship(value) {
  if (!value || typeof value !== 'object' || !RELATIONSHIP_KINDS.has(value.kind)) return null;
  const rawMembers = Array.isArray(value.members) ? value.members : [];
  const members = rawMembers.slice(0, 8).flatMap((member) => {
    if (!member || typeof member !== 'object' || !RELATIONSHIP_ROLES.has(member.role)) return [];
    const projected = picked(member, ['label', 'host', 'scope', 'providerRef', 'projectRef', 'projectLabel'], 200);
    return [{
      role: member.role, ...projected,
      consumerHosts: publicConsumerHosts({
        basis: 'catalog-presence', hosts: member.consumerHosts,
        count: Array.isArray(member.consumerHosts) ? member.consumerHosts.length : 0,
      }),
      ownership: OWNERSHIP.has(member.ownership) ? member.ownership : 'unknown',
      tracking: TRACKING.has(member.tracking) ? member.tracking : 'unknown',
      workingTree: WORKING_TREE.has(member.workingTree) ? member.workingTree : 'unknown',
    }];
  });
  const memberCount = Number.isFinite(value.memberCount)
    ? Math.max(members.length, Math.round(value.memberCount)) : rawMembers.length;
  return {
    kind: value.kind,
    basis: RELATIONSHIP_BASES.has(value.basis) ? value.basis : 'unknown',
    resolution: value.resolution === 'provider-observed' ? 'provider-observed' : 'not-reported',
    memberCount, truncated: value.truncated === true || rawMembers.length > members.length,
    members,
  };
}

function publicFinding(finding) {
  const value = finding && typeof finding === 'object' ? finding : {};
  const evidence = value.evidence && typeof value.evidence === 'object' ? value.evidence : {};
  const impact = value.impact && typeof value.impact === 'object' ? value.impact : {};
  const next = value.nextAction && typeof value.nextAction === 'object' ? value.nextAction : {};
  const gaps = evidenceTextList(evidence.gaps);
  const reasons = evidenceTextList(evidence.reasons);
  const sources = evidenceTextList(evidence.sources);
  const source = evidenceText(evidence.source);
  const owner = text(value.owner) ?? text(value.ownership?.owner);
  const relationship = publicRelationship(value.relationship);
  return {
    ...picked(value, ['id', 'state', 'bucket', 'classification', 'safetyClass', 'statusLabel', 'headline', 'explanation', 'owner']),
    ...(owner ? { owner } : {}),
    resource: publicResource(value.resource),
    versions: picked(value.versions, VERSION_KEYS),
    ownership: picked(value.ownership, ['owner', 'authority', 'managed']),
    evidence: {
      ...picked(evidence, ['asOf', 'freshness', 'completeness', 'status', 'authority', 'health']),
      ...(source ? { source } : {}),
      sources,
      gaps,
      reasons: reasons.length ? reasons : gaps,
      ...(!source && sources.length ? { source: sources.join(', ') } : {}),
      ...(!evidence.health && evidence.freshness ? { health: text(evidence.freshness, 100) } : {}),
    },
    observedUsage: picked(value.observedUsage, ['status', 'statement']),
    consumerHosts: publicConsumerHosts(value.consumerHosts),
    impact: {
      ...picked(impact, ['summary', 'bytes', 'files', 'dependencies', 'capabilities', 'projects', 'preserved']),
      capabilities: textList(impact.capabilities, 12),
      projects: textList(impact.projects, 12),
      preserved: textList(impact.preserved, 12),
    },
    nextAction: {
      ...picked(next, [
      'operation', 'label', 'providerId', 'providerVersion', 'safetyClass', 'rollback',
      'restart', 'executable', 'summary', 'guidance', 'recommendation', 'blockedReason',
      ]),
      steps: textList(next.steps, 6), preserved: textList(next.preserved, 8),
    },
    ...(relationship ? { relationship } : {}),
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
  const actionCount = Number.isFinite(value.actionCount) ? Math.max(0, Math.round(value.actionCount)) : actions.length;
  const presentation = maintenanceReceiptPresentation(value.status, actionCount);
  const projected = /** @type {Record<string, any>} */ ({
    ...picked(value, [
      'id', 'planId', 'planDigest', 'sourceFingerprint', 'createdAt', 'updatedAt', 'at',
      'completedAt', 'headline', 'label', 'undoStatus',
    ]),
    ...presentation,
    actionCount,
    summary: text(value.summary) ?? presentation.summary,
    actions,
    verification: picked(value.verification, [
      'nativeStateVerified', 'affectedCatalogRefreshed', 'affectedCatalogRescanned', 'affectedCatalogRescanRequired',
    ]),
    undo: picked(value.undo, ['completedAt', 'guardedByPostimage', 'eligible', 'status', 'summary']),
  });
  if (!projected.completedAt && ['committed', 'rolled-back'].includes(projected.status)) {
    projected.completedAt = projected.updatedAt ?? projected.createdAt;
  }
  projected.undoEligible = projected.status === 'committed' && value.undoEligible === true;
  if (Object.keys(projected.undo).length) {
    projected.undo.eligible = projected.undoEligible && value.undo?.eligible === true;
  }
  return projected;
}

export function publicMaintenanceModel(model) {
  const value = model && typeof model === 'object' ? model : {};
  const findings = Array.isArray(value.findings) ? value.findings.slice(0, 5_000).map(publicFinding) : [];
  const receipts = Array.isArray(value.receipts) ? value.receipts.slice(0, 100).map(publicReceipt) : [];
  const suppliedSummary = picked(value.summary, SUMMARY_KEYS);
  const activity = publicScanActivity(value.activity);
  const capabilities = picked(value.capabilities, ['plan', 'apply', 'undo']);
  if (activity.status === 'running') {
    capabilities.plan = false;
    capabilities.apply = false;
    capabilities.undo = false;
  }
  const incompleteSources = findings.filter((finding) => finding.evidence?.completeness !== 'complete').length;
  const unsupportedOrBlocked = suppliedSummary.unsupportedOrBlocked ?? suppliedSummary.blocked ?? 0;
  return {
    ...picked(value, ['schemaVersion', 'mode', 'asOf', 'sourceFingerprint']),
    scan: picked(value.scan, [
      'status', 'checkedAt', 'deep', 'coverage', 'providersChecked', 'providersComplete', 'providersTotal',
    ]),
    activity,
    capabilities,
    freshness: {
      ...picked(value.freshness, ['asOf', 'ageMs', 'status', 'completeness']),
      gaps: evidenceTextList(value.freshness?.gaps),
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
      ...picked(provider, ['id', 'version', 'host', 'status', 'reason']),
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
      impact: {
        capabilities: textList(action.impact?.capabilities, 12),
        projects: textList(action.impact?.projects, 12),
        preserved: textList(action.impact?.preserved, 12),
      },
    })) : [],
  };
}

function confirmationForPlan(plan) {
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const rollback = [...new Set(actions.map((action) => action.rollback).filter(Boolean))];
  const operations = [...new Set(actions.map((action) => text(action.operation, 80)).filter(Boolean))];
  const typedPhrase = actions.length > 1 || plan.safetyClass === 'approval-required'
    || rollback.includes('irreversible') ? `APPLY ${actions.length}` : null;
  return {
    title: actions.length === 1 ? 'Confirm maintenance action' : `Confirm ${actions.length} maintenance actions`,
    summary: 'The server will recheck native inventory and the exact plan before changing anything.',
    actionCount: actions.length,
    actionLabel: operations.length === 1 ? `Apply ${operations[0]}` : 'Apply changes',
    willChange: actions.flatMap((action) => {
      const identity = publicResource(action.resourceIdentity);
      const resource = `${text(action.operation, 80) ?? 'change'} ${identity.name ?? identity.id ?? 'selected resource'}`;
      return [resource, ...textList(action.impact?.capabilities, 12).map((capability) => `Affected: ${capability}`)];
    }),
    preserved: [...new Set(actions.flatMap((action) => textList(action.impact?.preserved, 12)).concat([
      'Resources outside this exact plan remain unchanged.',
      'Plugin cache children and unreceipted user content are never direct targets.',
    ]))],
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
  const status = text(value.status, 100) ?? (value.ok === true ? 'complete' : 'refused');
  const hasReceipt = Boolean(value.receipt || value.receiptId);
  const noMutationStatuses = new Set([
    'busy', 'drift-refused', 'preflight-refused', 'receipt-refused',
  ]);
  const effect = value.ok === true ? 'verified'
    : status === 'rolled-back' ? 'rolled-back'
      : noMutationStatuses.has(status) ? 'not-started'
        : hasReceipt || /recovery-required|outcome-unknown/.test(status) ? 'recovery-required'
          : 'unknown';
  return {
    ok: value.ok === true,
    status,
    effect,
    ...(hasReceipt ? {
      receipt: publicReceipt(value.receipt ?? { id: value.receiptId, status: value.status }),
    } : {}),
  };
}

function typedPhraseMatches(body, required) {
  return required == null || body.typedPhrase === required;
}

/** Dashboard transport adapter. The application service owns plans and
 * provider execution; this boundary owns browser authority and projections.
 * @param {{
 *   service?: any,
 *   sessionToken?: string,
 *   now?: () => number,
 *   capabilities?: ReturnType<typeof createMaintenanceCapabilityStore>,
 * }} options
 */
export function createMaintenanceDashboardApi({ service, sessionToken, now = Date.now, capabilities } = {}) {
  if (!service || typeof service.report !== 'function' || typeof service.scan !== 'function'
      || typeof service.plan !== 'function') {
    throw new TypeError('maintenance dashboard service must implement report, scan, and plan');
  }
  const store = capabilities ?? createMaintenanceCapabilityStore({ now });

  const withActivity = (model) => ({
    ...model,
    activity: typeof service.scanState === 'function' ? service.scanState() : null,
  });

  async function report(_req, res, { refresh = false } = {}) {
    try {
      const model = await (refresh ? service.scan() : service.report());
      sendJson(res, 200, publicMaintenanceModel(withActivity(model)));
    }
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
      sendJson(res, 409, {
        error: 'confirmation phrase did not match the preview', effect: 'not-started',
      });
      return;
    }
    if (typeof service.apply !== 'function') throw new Error('maintenance apply is unavailable');
    let result = await service.apply({
      plan: authority.plan,
      actionIds: authority.actionIds,
      expectedPlanDigest: authority.expectedPlanDigest,
      confirmed: true,
    });
    const receiptId = result?.receipt?.id ?? result?.receiptId;
    if (result?.ok === true && receiptId && typeof service.prepareUndo === 'function') {
      const preview = await service.prepareUndo({ receiptId });
      const receipt = result.receipt ?? { id: receiptId, status: result.status };
      result = {
        ...result,
        receipt: {
          ...receipt,
          undoEligible: preview?.undoable === true,
          undo: {
            eligible: preview?.undoable === true,
            status: preview?.undoable === true ? 'Eligible' : 'Unavailable',
            ...(preview?.summary ? { summary: preview.summary } : {}),
          },
        },
      };
    }
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
        effect: 'not-started',
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
      sendJson(res, 409, {
        error: 'confirmation phrase did not match the preview', effect: 'not-started',
      });
      return;
    }
    if (typeof service.undo !== 'function') throw new Error('maintenance undo is unavailable');
    const result = await service.undo({ receiptId: authority.receiptId, confirmed: true });
    const payload = publicOutcome(result);
    sendJson(res, payload.ok ? 200 : 409, payload);
  }

  async function mutate(route, req, res) {
    try {
      const body = /** @type {Record<string, any>} */ (
        validateMaintenanceBody(route, await readMaintenanceJson(req))
      );
      if (route === '/api/maintenance/plans') await createPlan(body, res);
      else if (route === '/api/maintenance/apply') await apply(body, res);
      else if (body.preview) await previewUndo(body, res);
      else await undo(body, res);
    } catch (error) {
      if (error?.code === 'MAINTENANCE_SCAN_IN_PROGRESS') {
        sendJson(res, 409, {
          error: 'maintenance provider check is in progress',
          code: 'MAINTENANCE_SCAN_IN_PROGRESS', effect: 'not-started',
        });
        return;
      }
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

  return Object.freeze({ report, mutate, capabilityCount: store.size });
}
