import { sendJson } from '../loopback-server.mjs';
import {
  ACTION_VERBS, ADMINISTRATIVE_SCOPES, AUDIT_RESULTS, AUDIT_RESULT_LABELS, CARRIER_KINDS, CONFLICT_KINDS,
  CONSUMER_KINDS, CURATED_VIEWS, DEPENDENCY_KINDS, DISPOSITION_INVALIDATIONS, DISPOSITION_KINDS,
  ENVIRONMENT_KINDS, EVIDENCE_FIELDS, EVIDENCE_GRADES, GUIDANCE_LANES, INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS,
  INVENTORY_GROUP_ORDER, LIMITING_REASONS,
  NETWORK_REQUIREMENTS, PLACEMENT_CONDITIONS, PRIVILEGE_REQUIREMENTS, PROVENANCE_KINDS, RECIPE_STATES,
  RECONCILE_OUTCOMES, RECONCILE_OUTCOME_LABELS, RESOURCE_KINDS, SAFETY_CEILINGS, SCAN_STATES, SCOPE_LENSES,
  SHELLS, SORT_ORDERS, SOURCE_COVERAGE_STATES, SOURCE_TYPES, isOpaqueId, isProhibitedLabel,
} from '../maintenance/management/model.mjs';
import { maintenanceReceiptPresentation } from '../maintenance/receipt-presentation.mjs';
import {
  MAINTENANCE_LOCAL_PATH, createMaintenanceCapabilityStore, matchMaintenanceV2Route, readMaintenanceJson,
  validateMaintenanceBody, validateMaintenanceV2Body, validateMaintenanceV2Query,
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
function evidenceText(value, max = 300) {
  const safe = text(value, max);
  if (safe === null) return null;
  const match = MAINTENANCE_LOCAL_PATH.exec(safe);
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
      'restart', 'sourceFingerprint', 'state', 'placementId',
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
  const lastRefresh = value.lastRefresh == null ? undefined : projectNode(LAST_REFRESH, value.lastRefresh);
  return {
    ...picked(value, ['schemaVersion', 'mode', 'asOf', 'sourceFingerprint']),
    ...(lastRefresh ? { lastRefresh } : {}),
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
        'findingClassification', 'rollback', 'restart', 'executable', 'sourceFingerprint', 'placementId',
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

/** v2 confirmations omit absent evidence instead of naming it (MNT-EVD-006). */
function withoutAbsentEvidence(confirmation) {
  const out = { ...confirmation };
  for (const key of ['rollback', 'restart', 'safetyClass']) if (out[key] == null || out[key] === 'unknown') delete out[key];
  return out;
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

/** v2 outcomes never carry an `unknown` word; an unclassified effect is `not-verified`. */
const publicOutcomeV2 = (result) => {
  const outcome = publicOutcome(result);
  return outcome.effect === 'unknown' ? { ...outcome, effect: 'not-verified' } : outcome;
};

const typedPhraseMatches = (body, required) => required == null || body.typedPhrase === required;

// ── v2 projection engine ───────────────────────────────────────────────────
// Every v2 DTO passes through an allowlist schema: keys the schema does not
// name are dropped, lists are bounded, closed vocabularies are enforced, and
// every string is control-character cleaned and LOCAL_PATH guarded unless its
// node is explicitly `owner` — the documented owner-only fields: Discovery's
// configured `root`/`path` values and the reveal endpoint's `exactPath`.
// Missing or invalid evidence omits the key; an explicit `null` survives.
const T = Object.freeze({
  text: (max = 300) => ({ kind: 'text', max }), owner: (max = 1024) => ({ kind: 'owner', max }),
  bool: Object.freeze({ kind: 'bool' }), int: Object.freeze({ kind: 'int' }), num: Object.freeze({ kind: 'num' }),
  oneOf: (values) => ({ kind: 'enum', values: new Set(values) }), list: (item, max) => ({ kind: 'list', item, max }),
  obj: (keys) => ({ kind: 'obj', keys }), dict: (value, max = 64) => ({ kind: 'dict', value, max }),
  /** A dictionary whose keys must be opaque ids with the given prefix (e.g. facet label maps). */
  idDict: (prefix, value, max = 500) => ({ kind: 'dict', value, max, keyPrefix: prefix }),
  either: (...options) => ({ kind: 'either', options }),
  /** ISO timestamp, bounded machine token, and a user-facing label that refuses PROHIBITED_LABELS. */
  iso: Object.freeze({ kind: 'iso' }), token: (max = 64) => ({ kind: 'token', max }), label: (max = 200) => ({ kind: 'label', max }),
});
const [DICT_KEY, MAX_PAGE_ROWS, TOKEN] = [/^[A-Za-z0-9._:-]{1,120}$/, 200, /^[A-Za-z0-9._:-]+$/];

function projectObject(node, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, child] of Object.entries(node.keys)) {
    if (value[key] === undefined) continue;
    const projected = projectNode(child, value[key]);
    if (projected !== undefined) out[key] = projected;
  }
  return out;
}

function projectDict(node, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= node.max) break;
    if (node.keyPrefix ? !isOpaqueId(key, node.keyPrefix) : !DICT_KEY.test(key)) continue;
    const projected = projectNode(node.value, entry);
    if (projected === undefined) continue;
    out[key] = projected;
    count += 1;
  }
  return out;
}

function projectEither(node, value) {
  for (const option of node.options) {
    const projected = projectNode(option, value);
    if (projected !== undefined) return projected;
  }
  return undefined;
}

/** Scalar nodes: each returns the accepted value or `undefined` (omit). */
const SCALARS = Object.freeze({
  text: (node, value) => evidenceText(value, node.max) ?? undefined,
  label: (node, value) => { const safe = evidenceText(value, node.max); return safe && !isProhibitedLabel(safe) ? safe : undefined; },
  token: (node, value) => (typeof value === 'string' && value.length <= node.max && TOKEN.test(value) ? value : undefined),
  iso: (_node, value) => (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined),
  owner: (node, value) => text(value, node.max) ?? undefined,
  bool: (_node, value) => (typeof value === 'boolean' ? value : undefined),
  int: (_node, value) => (Number.isInteger(value) ? value : undefined),
  num: (_node, value) => (Number.isFinite(value) ? value : undefined),
  enum: (node, value) => (node.values.has(value) ? value : undefined),
});
const COMPOSITES = Object.freeze({
  list: (node, value) => (Array.isArray(value)
    ? value.slice(0, node.max).map((item) => projectNode(node.item, item)).filter((item) => item !== undefined) : undefined),
  obj: projectObject, dict: projectDict, either: projectEither,
});

function projectNode(node, value) {
  if (value === null) return null;
  const projector = SCALARS[node.kind] ?? COMPOSITES[node.kind];
  return projector ? projector(node, value) : undefined;
}

const [ID, LABEL, STAMP] = [T.text(128), T.text(200), T.text(40)];
const PROVIDER = T.obj({ id: T.text(80), version: T.text(40) });
const COVERAGE = T.obj({
  sourceId: ID, environmentId: ID, state: T.oneOf(SOURCE_COVERAGE_STATES), label: LABEL, visited: T.int, estimated: T.int,
  limitingReason: T.oneOf(LIMITING_REASONS), ceiling: T.oneOf(SAFETY_CEILINGS), completedPartitions: T.int, pendingPartitions: T.int,
  lastCompletedAt: STAMP, filesystem: T.bool,
});
const ROW = T.obj({
  installationSource: LABEL, description: T.text(1024),
  placementId: ID, projectId: ID, projectKind: T.oneOf(['git','folder','worktree','unknown']), displayName: LABEL, kind: T.oneOf(RESOURCE_KINDS),
  scope: T.obj({ value: T.oneOf(SCOPE_LENSES), label: LABEL, icon: T.text(32) }),
  breadcrumb: T.list(T.text(120), 16), versions: T.dict(T.text(120), 20),
  carrier: T.obj({ value: T.oneOf(CARRIER_KINDS), label: LABEL, icon: T.text(32) }), consumerHosts: T.list(T.text(32), 8),
  guidanceLane: T.obj({ value: T.oneOf(GUIDANCE_LANES), label: LABEL }), rowAction: T.obj({ verb: T.oneOf(ACTION_VERBS), label: LABEL }),
});
const GROUP = T.obj({
  resourceId: ID, presentationKey: ID, knownPlacementCount: T.int, knownHosts: T.list(T.text(32), 8), displayName: LABEL, kind: T.oneOf(RESOURCE_KINDS), placementCount: T.int, consumerCount: T.int, outcome: LABEL,
  placements: T.list(ROW, MAX_PAGE_ROWS),
});
/** Outcome of the last chained inventory rebuild (QE D6b): a failed rebuild is visible on the wire. */
const LAST_REFRESH = T.obj({ status: T.oneOf(['ok', 'failed', 'running']), at: T.iso, code: T.token(64), message: T.label(200) });
/** Structured partial-source disclosure (Q's replacement for the bare list);
 *  the list shape stays accepted during the switch. Labels are source labels. */
const SOURCE_BUCKET = T.obj({
  count: T.int, labels: T.list(T.text(200), 50), visited: T.int, reasons: T.list(T.oneOf([...SAFETY_CEILINGS, ...LIMITING_REASONS]), 50),
});
const PARTIAL_SOURCES = T.either(T.list(COVERAGE, 100), T.obj({
  total: T.int, notScanned: SOURCE_BUCKET, scanning: SOURCE_BUCKET, paused: SOURCE_BUCKET, stopped: SOURCE_BUCKET, failed: SOURCE_BUCKET,
  action: T.oneOf(['remeasure', 'discovery']), narrative: T.label(1000), entries: T.list(COVERAGE, 50),
}));
const INVENTORY_PAGE = T.obj({
  navigation: T.obj({ level: T.oneOf(['scope', 'project', 'kind', 'resource', 'installation']),
    nodes: T.list(T.obj({ value: T.token(128), label: LABEL, installationSource: LABEL, description: T.text(1024), descriptionSource: LABEL, languages: T.list(T.obj({ id: T.token(64), name: LABEL, icon: T.text(8), evidence: T.oneOf(['source','artifact']) }), 100), count: T.int, kind: T.oneOf(RESOURCE_KINDS), projectKind: T.oneOf(['git', 'folder', 'worktree', 'unknown']) }), MAX_PAGE_ROWS),
  }),
  scanRequired: T.bool, lastRefresh: LAST_REFRESH, schema: T.text(80), inventoryId: ID, total: T.int, groups: T.list(GROUP, MAX_PAGE_ROWS),
  facetCounts: T.dict(T.dict(T.int, 500), 16), nextCursor: T.text(512),
  projectKinds: T.idDict('prj', T.oneOf(['git','folder','worktree','unknown']), 500),
  facetLabels: T.obj({ family: T.idDict('res', LABEL, 500), environment: T.idDict('env', LABEL, 500), project: T.idDict('prj', LABEL, 500) }),
  sortGroups: T.list(T.obj({ bucket: T.oneOf(INVENTORY_GROUP_ORDER), label: LABEL, count: T.int }), 8),
  partialSources: PARTIAL_SOURCES, appliedFacets: T.dict(T.list(T.text(64), 64), 16),
});
const CHOICE = T.obj({ choiceId: T.text(64), label: LABEL, changes: T.text(300), keeps: T.text(300), grounded: T.bool, reason: T.text(300) });
const GUIDANCE_ENTRY = T.obj({
  purpose: T.oneOf(['recommendation', 'optional-management']),
  guidanceId: ID, placementId: ID, lane: T.oneOf(GUIDANCE_LANES), outcome: LABEL, verb: T.oneOf(ACTION_VERBS),
  verifiedPremises: T.list(T.text(80), 20),
  impact: T.obj({
    summary: T.text(500), irreversible: T.bool, redownloadRequired: T.bool, bytes: T.num, consumers: T.either(T.int, T.list(T.text(120), 50)),
  }),
  preserved: T.list(T.text(200), 20), providerCapabilityId: T.text(200), procedureId: T.text(128), choices: T.list(CHOICE, 8),
  candidateId: T.text(128), receiptId: T.text(128), dispositionIdentity: T.text(300),
  warning: T.obj({ impact: T.text(500), containmentChoice: T.text(200) }),
});
const DISPOSITION = T.obj({
  dispositionId: ID, guidanceId: ID, placementId: ID, dispositionIdentity: T.text(300), kind: T.oneOf(DISPOSITION_KINDS), kindLabel: LABEL,
  until: STAMP, recordedAt: STAMP, invalidatedAt: STAMP, invalidationReason: T.oneOf(DISPOSITION_INVALIDATIONS),
});
const RELATION_TARGET = T.obj({ placementId: ID, displayName: LABEL, kind: T.oneOf(RESOURCE_KINDS),
  scope: T.oneOf(ADMINISTRATIVE_SCOPES), projectId: ID, consumerHosts: T.list(T.text(32), 8) });
const RELATION_EDGE = T.obj({ edgeId: ID, kind: T.oneOf(DEPENDENCY_KINDS), requirement: LABEL, satisfied: T.bool, target: RELATION_TARGET });
const INSPECTOR = T.obj({
  relationships: T.obj({
    consumers: T.list(T.obj({ label: LABEL, kind: T.oneOf(CONSUMER_KINDS), enabled: T.bool }), 200),
    providedBy: T.list(RELATION_TARGET, 200), includes: T.list(RELATION_TARGET, 200),
    dependencies: T.list(RELATION_EDGE, 200), dependents: T.list(RELATION_EDGE, 200),
    otherInstallations: T.list(RELATION_TARGET, 200), originStatus: T.oneOf(['recorded', 'not-established']), truncated: T.bool,
  }),
  scanRequired: T.bool,
  whatIsThis: T.obj({
    displayName: LABEL, kind: T.oneOf(RESOURCE_KINDS), kindLabel: LABEL, placementId: ID, environmentId: ID,
    conditions: T.list(T.oneOf(PLACEMENT_CONDITIONS), 12), conditionLabels: T.list(LABEL, 12),
  }),
  whereIsIt: T.obj({
    scope: T.oneOf(ADMINISTRATIVE_SCOPES), revealAvailable: T.bool, locationNote: LABEL, breadcrumb: T.list(T.text(120), 16), carrier: T.obj({ value: T.oneOf(CARRIER_KINDS), label: LABEL }),
  }),
  whereDidItComeFrom: T.obj({ kind: T.oneOf(PROVENANCE_KINDS), label: LABEL, authority: T.text(200), grade: T.oneOf(EVIDENCE_GRADES) }),
  whatVersionIsHere: T.dict(T.text(120), 20),
  whoUsesIt: T.obj({
    consumers: T.list(T.obj({ consumerKind: T.oneOf(CONSUMER_KINDS), consumerLabel: LABEL, enabled: T.bool }), 100),
    reverseDependencies: T.list(T.obj({ fromPlacementId: ID, kind: T.oneOf(DEPENDENCY_KINDS) }), 100),
  }),
  whatChangedOrConflicts: T.list(T.obj({
    kind: T.oneOf(CONFLICT_KINDS), label: LABEL, proves: T.text(300), doesNotProve: T.text(300), placementIds: T.list(ID, 50),
  }), 50),
  whatCanIAccomplish: T.either(T.list(GUIDANCE_ENTRY, 20), T.obj({ detail: T.text(500) })),
  whatProvesThis: T.obj({
    evidenceScorecard: T.obj(Object.fromEntries(EVIDENCE_FIELDS.map((field) => [field, T.oneOf(EVIDENCE_GRADES)]))),
    technicalDetails: T.list(T.text(300), 50),
  }),
  whatHappenedBefore: T.obj({
    receipts: T.list(T.obj({ id: ID, status: T.text(60) }), 50), dispositions: T.list(DISPOSITION, 50), coverage: T.list(COVERAGE, 50),
  }),
});
const GUIDANCE = T.obj({
  coverage: T.list(T.obj({ host: T.text(80), label: LABEL, placements: T.int, recommendations: T.int, optionalActions: T.int,
    actionKinds: T.list(LABEL, 30),
    actionStatus: T.oneOf(['checked', 'incomplete', 'unavailable', 'not-checked', 'unsupported']), actionStatusLabel: LABEL }), 50),
  scanRequired: T.bool, lastRefresh: LAST_REFRESH,
  lanes: T.obj(Object.fromEntries(GUIDANCE_LANES.map((lane) => [lane, T.list(GUIDANCE_ENTRY, 200)]))),
  counts: T.obj(Object.fromEntries([...GUIDANCE_LANES, 'total'].map((lane) => [lane, T.int]))),
  entries: T.list(GUIDANCE_ENTRY, 500),
});
const SHELL_TEXT = T.obj({ shell: T.oneOf(SHELLS), shellLabel: LABEL, text: T.text(2000) });
const PROCEDURE = T.obj({
  guidanceId: ID, recipeId: T.text(120), recipeVersion: T.text(40), outcome: T.text(500),
  source: T.obj({ authority: T.text(200), publisher: T.text(120), recipeVersion: T.text(40) }),
  compatibility: T.obj({
    osAndVersionRange: T.text(120), architecture: T.text(40), hostAndVersionRange: T.text(120), resourceKind: T.oneOf(RESOURCE_KINDS),
    packageManagerAndRange: T.text(120), shells: T.list(T.oneOf(SHELLS), 5), environmentId: ID,
  }),
  privilege: T.oneOf(PRIVILEGE_REQUIREMENTS), network: T.oneOf(NETWORK_REQUIREMENTS), effect: T.text(500),
  preserved: T.list(T.text(200), 20), command: SHELL_TEXT, verification: SHELL_TEXT,
  checklist: T.list(T.obj({ stepId: T.text(64), label: T.text(300), done: T.bool }), 20),
  checklistState: T.obj({ done: T.dict(T.bool, 20), updatedAt: STAMP }), nextStepLabel: LABEL, preferredShell: T.oneOf(SHELLS),
});
const CHECKLIST_STATE = T.obj({ guidanceId: ID, done: T.dict(T.bool, 20), updatedAt: STAMP });
const EXCLUSION = T.obj({ exclusionId: ID, path: T.owner(1024), recursive: T.bool });
const PROJECT_FOUND = T.obj({ projectId: ID, breadcrumb: T.list(T.text(120), 32), worktree: T.text(120), label: LABEL });
const PROGRESS_ENTRY = T.obj({
  sourceId: ID, environmentId: ID, state: T.oneOf(SCAN_STATES), visited: T.int, label: LABEL, limitingReason: T.oneOf(LIMITING_REASONS),
  ceiling: T.oneOf(SAFETY_CEILINGS), phase: T.text(40), completedPartitions: T.int, pendingPartitions: T.int,
});
const PROGRESS = T.either(T.list(PROGRESS_ENTRY, 200), T.obj({
  coverage: T.list(COVERAGE, 200), progress: T.list(PROGRESS_ENTRY, 200), sources: T.list(PROGRESS_ENTRY, 200),
  narrative: T.text(1000), running: T.bool, forbiddenClaims: T.list(T.oneOf(INCOMPLETE_SOURCE_FORBIDDEN_CLAIMS), 8),
}));
const CONFIGURED_SOURCE = T.obj({
  sourceId: ID, kind: T.oneOf(SOURCE_TYPES), root: T.owner(1024), label: LABEL, maxDepth: T.int, includeNetwork: T.bool, present: T.bool,
});
const SCAN_SUMMARY = T.obj({
  scanId: ID, sourceId: ID, environmentId: ID, state: T.oneOf(SCAN_STATES), startedAt: STAMP, completedAt: STAMP, visited: T.int,
  limitingReason: T.oneOf(LIMITING_REASONS), ceiling: T.oneOf(SAFETY_CEILINGS), label: LABEL,
});
const DISCOVERY = T.obj({
  automaticSources: T.list(T.obj({
    id: T.text(64), sourceId: T.text(128), label: LABEL, enabled: T.bool, defaultEnabled: T.bool, inspects: T.text(300),
    environmentKinds: T.list(T.oneOf(ENVIRONMENT_KINDS), 4), present: T.bool, filesystem: T.bool, root: T.owner(1024),
  }), 32),
  exactProjects: T.list(CONFIGURED_SOURCE, 200), collectionRoots: T.list(CONFIGURED_SOURCE, 200), exclusions: T.list(EXCLUSION, 500),
  coverage: T.list(COVERAGE, 200), progress: PROGRESS, history: T.list(SCAN_SUMMARY, 200), narrative: T.text(1000),
});
const DISCOVERY_PREVIEW = T.obj({
  previewId: ID, kind: T.oneOf(SOURCE_TYPES), root: T.owner(1024), boundary: T.text(40), projectsFound: T.list(PROJECT_FOUND, 500),
  exclusions: T.obj({ automatic: T.list(T.text(120), 100), exact: T.list(EXCLUSION, 200), recursive: T.list(EXCLUSION, 200) }),
  depth: T.int, symlinksSkipped: T.int, boundaries: T.list(T.text(40), 8), estimate: T.obj({ entries: T.int, bytes: T.num, timeRange: T.text(80) }),
  estimateReason: T.text(300), permissions: T.obj({ denied: T.int }), ceilings: T.obj({ maxDepth: T.int, maxEntries: T.int }),
  valid: T.bool, reason: T.text(300), requiresOptIn: T.bool,
});
const STOP_PREVIEW = T.obj({
  sourceId: ID, label: LABEL, visited: T.int, completedPartitions: T.int, affectedCount: T.int,
  affectedPlacements: T.list(T.obj({ placementId: ID, displayName: LABEL, kind: T.oneOf(RESOURCE_KINDS) }), 200),
});
/** The user's `kit.json` discovery intent block, as the facade's write
 *  methods return it (owner-only: configured roots and exclusion paths). */
const DISCOVERY_INTENT = {
  automaticSources: T.dict(T.bool, 32), exactProjects: T.list(CONFIGURED_SOURCE, 200),
  collectionRoots: T.list(CONFIGURED_SOURCE, 200), exclusions: T.list(EXCLUSION, 500),
};
const DISCOVERY_CHANGE = T.obj({
  ...DISCOVERY_INTENT, confirmed: T.bool, saved: T.bool, removed: T.bool, enabled: T.bool, sourceId: ID, kind: T.oneOf(SOURCE_TYPES),
  root: T.owner(1024), label: LABEL, discovery: DISCOVERY,
  preview: T.either(STOP_PREVIEW, T.obj({ before: T.obj(DISCOVERY_INTENT), after: T.obj(DISCOVERY_INTENT) })),
});
const EXCLUSION_RESULT = T.obj({
  ...DISCOVERY_INTENT, exclusionId: ID, path: T.owner(1024), recursive: T.bool, affectedProjects: T.list(PROJECT_FOUND, 500),
  valid: T.bool, reason: T.text(300), saved: T.bool, removed: T.bool,
});
const SCAN_CONTROL = T.obj({
  action: T.oneOf(['start', 'pause', 'resume', 'stop']), accepted: T.bool, completed: T.bool, confirmed: T.bool, removed: T.bool,
  preview: STOP_PREVIEW, progress: PROGRESS,
});
const RECEIPT_SUMMARY = T.obj({
  receiptId: ID, statusLabel: LABEL, statusTone: T.text(20), summary: T.text(500), provider: PROVIDER, operation: T.text(80),
  resourceKind: LABEL, createdAt: STAMP, updatedAt: STAMP, eligibleUndo: T.bool, recoveryRequired: T.bool, primaryActionLabel: LABEL, placementId: ID,
});
const ACTIVITY = T.obj({
  recovery: T.list(RECEIPT_SUMMARY, 100),
  inProgress: T.list(T.obj({
    kind: T.text(40), label: LABEL, sourceId: ID, environmentId: ID, receiptId: ID, placementId: ID, state: T.text(40), status: T.text(40),
    phase: T.text(40), visited: T.int, limitingReason: T.oneOf(LIMITING_REASONS), ceiling: T.oneOf(SAFETY_CEILINGS),
    startedAt: STAMP, updatedAt: STAMP, finishedAt: STAMP, progress: T.obj({ done: T.int, total: T.int, unit: T.text(20) }),
  }), 50),
  receipts: T.list(RECEIPT_SUMMARY, 200), dispositions: T.list(DISPOSITION, 200),
  recipes: T.list(T.obj({
    kind: T.text(40), recipeId: T.text(120), recipeVersion: T.text(40), at: STAMP, pendingIds: T.list(T.text(120), 100),
  }), 100),
  scans: T.list(SCAN_SUMMARY, 200), scanHistory: T.list(SCAN_SUMMARY, 200),
});
function receiptDetailSchema(str) {
  return T.obj({
    receiptId: ID, intent: str(80), provider: PROVIDER, operation: str(80),
    timestamps: T.obj({ createdAt: str(40), updatedAt: str(40) }),
    evidence: T.obj({ sourceFingerprint: str(256), preimageFingerprint: str(256) }),
    before: str(256), after: str(256), result: str(120),
    verification: T.obj({ verified: T.bool, postFingerprint: str(256) }),
    restart: str(40), rollback: str(40), preserved: T.list(str(200), 20), statusLabel: str(120), statusTone: str(20),
    summary: str(500), pathsIncluded: T.bool,
  });
}
const RECEIPT_DETAIL = receiptDetailSchema(T.text);
const RECEIPT_EXPORT_WITH_PATHS = receiptDetailSchema(T.owner);
const AUDIT_CORE = {
  receiptId: ID, result: T.oneOf(AUDIT_RESULTS), conclusive: T.bool, enables: T.oneOf(RECONCILE_OUTCOMES),
  lastDurablePhase: T.text(60), provider: PROVIDER, checks: T.list(T.obj({ name: T.text(60), status: T.text(40) }), 20),
  failedComparisons: T.list(T.text(80), 20), nextSteps: T.list(T.text(300), 20),
  disclosure: T.obj({ checks: T.list(T.text(60), 20), executableProbePolicy: T.text(120), networkPolicy: T.text(200), checkedAt: STAMP }),
};
const AUDIT_RESULT = T.obj({
  ...AUDIT_CORE, integrity: T.oneOf(['valid', 'failed']), alreadyReconciled: T.bool, error: T.text(200),
  exportable: T.obj(AUDIT_CORE),
});
const PREFERENCES = T.obj({
  lastView: T.obj({
    scope: T.oneOf(SCOPE_LENSES), view: T.oneOf(CURATED_VIEWS), sort: T.oneOf(SORT_ORDERS),
    facets: T.dict(T.list(T.text(64), 64), 16), search: T.text(200),
  }),
  preferredShellByEnvironment: T.dict(T.oneOf(SHELLS), 64),
  retention: T.obj({ maxSummaries: T.int, maxAgeDays: T.int }),
});
const REVEAL = T.obj({
  placementId: ID, breadcrumb: T.list(T.text(120), 16), exactPath: T.owner(4096), selector: T.owner(512), file: T.owner(1024),
});
const RECIPE_VERSION_FACTS = {
  recipeVersion: T.text(40), privilegeRequirement: T.oneOf(PRIVILEGE_REQUIREMENTS), networkRequirement: T.oneOf(NETWORK_REQUIREMENTS),
  operation: T.text(80),
};
const RECIPE = T.obj({
  ...RECIPE_VERSION_FACTS, recipeId: T.text(120), publisher: T.text(120), state: T.oneOf(RECIPE_STATES), sourceAuthority: T.text(200),
  osAndVersionRange: T.text(120), architecture: T.text(40), hostAndVersionRange: T.text(120), resourceKind: T.oneOf(RESOURCE_KINDS),
  packageManagerAndRange: T.text(120), shell: T.oneOf(SHELLS), triggerCondition: T.text(80), dependencyRequirement: T.text(120),
  expectedEffect: T.text(500), preservedResources: T.list(T.text(200), 20), verification: T.text(500), invalidation: T.text(300),
});
const RECIPE_REFRESH = T.obj({
  diff: T.list(T.obj({
    recipeId: T.text(120), from: T.obj(RECIPE_VERSION_FACTS), to: T.obj(RECIPE_VERSION_FACTS),
    addsPrivilege: T.bool, addsNetwork: T.bool, addsOperation: T.bool,
  }), 200),
  pending: T.list(RECIPE, 200),
});

function boundRows(groups, max) {
  let remaining = max;
  return groups.flatMap((group) => {
    const placements = (group.placements ?? []).slice(0, Math.max(0, remaining));
    remaining -= placements.length;
    return placements.length || remaining > 0 ? [{ ...group, placements }] : [];
  });
}

/** Public projection of a `runInventoryQuery` page: ≤ 200 placement rows,
 *  ≤ 500 values per facet, every string path-guarded. */
export function publicInventoryPage(page) {
  const projected = projectNode(INVENTORY_PAGE, page) ?? {};
  return { ...projected, groups: boundRows(projected.groups ?? [], MAX_PAGE_ROWS) };
}

export function publicInspector(inspector) { return projectNode(INSPECTOR, inspector) ?? {}; }
export function publicGuidance(guidance) { return projectNode(GUIDANCE, guidance) ?? {}; }
export function publicProcedure(procedure) { return projectNode(PROCEDURE, procedure) ?? {}; }
export function publicChecklistState(state) { return projectNode(CHECKLIST_STATE, state) ?? {}; }
/** Owner-only: configured `root`/`path` values are the ONLY strings that skip the local-path guard.
 *  Fixed wire shape: `narrative` is always the progress sentence; `progress` only carries structured rows. */
export function publicDiscovery(discovery) {
  const value = discovery && typeof discovery === 'object' ? discovery : {};
  const narrativeProgress = typeof value.progress === 'string';
  const narrative = narrativeProgress ? value.progress : (value.narrative ?? value.progress?.narrative);
  return projectNode(DISCOVERY, { ...value, narrative, ...(narrativeProgress ? { progress: undefined } : {}) }) ?? {};
}
export function publicDiscoveryPreview(preview) { return projectNode(DISCOVERY_PREVIEW, preview) ?? {}; }
export function publicDiscoveryChange(result) { return projectNode(DISCOVERY_CHANGE, result) ?? {}; }
export function publicExclusionResult(result) { return projectNode(EXCLUSION_RESULT, result) ?? {}; }
export function publicScanProgress(progress) { return projectNode(PROGRESS, progress) ?? []; }
export function publicScanControl(result) { return projectNode(SCAN_CONTROL, result) ?? {}; }
export function publicActivity(activity) { return projectNode(ACTIVITY, activity) ?? {}; }
export function publicReceiptDetail(detail) { return projectNode(RECEIPT_DETAIL, detail) ?? {}; }
export function publicDispositionRecord(record) { return projectNode(DISPOSITION, record) ?? {}; }
export function publicPreferences(preferences) { return projectNode(PREFERENCES, preferences) ?? {}; }
/** The ONLY projection that returns an exact path (MNT-PRV-005). */
export function publicReveal(locator) { return projectNode(REVEAL, locator) ?? {}; }
export function publicRecipe(recipe) { return projectNode(RECIPE, recipe) ?? {}; }
export function publicRecipeRefresh(result) { return projectNode(RECIPE_REFRESH, result) ?? {}; }

/** Sanitized export: paths survive ONLY when the facade confirms the warned
 *  choice through `pathsIncluded: true` (MNT-RCV-011/012). */
export function publicReceiptExport(result) {
  const allowPaths = result?.pathsIncluded === true;
  return { ...(projectNode(allowPaths ? RECEIPT_EXPORT_WITH_PATHS : RECEIPT_DETAIL, result) ?? {}), pathsIncluded: allowPaths };
}

export function publicAuditResult(audit) {
  const projected = projectNode(AUDIT_RESULT, audit) ?? {};
  const labels = Object.entries({ resultLabel: AUDIT_RESULT_LABELS[projected.result], enablesLabel: RECONCILE_OUTCOME_LABELS[projected.enables] });
  return { ...projected, ...Object.fromEntries(labels.filter(([, label]) => label)) };
}

export function publicAuditResults(results) {
  return Array.isArray(results) ? results.slice(0, 20).map(publicAuditResult) : [];
}

// ── v2 error mapping (MNT-EVD-008: `code` is a machine field; `error` is a
// factual sentence that never carries a prohibited label) ─────────────────
const GENERATION_MISMATCH = 'The inventory changed since this page was requested. Reload the inventory to continue paging.';
const V2_ERRORS = Object.freeze({
  MAINTENANCE_PERSISTENCE_UNAVAILABLE: { status: 503, error: 'Native Windows maintenance mutations require verified private, durable storage. Inventory and guided procedures remain available.', effect: 'not-started' },
  ONE_ACTION_PER_PLAN: { status: 409, error: 'A maintenance plan carries exactly one action for one placement.', effect: 'not-started' },
  'inventory-generation-mismatch': { status: 409, code: 'INVENTORY_GENERATION_MISMATCH', error: GENERATION_MISMATCH },
  INVENTORY_GENERATION_MISMATCH: { status: 409, error: GENERATION_MISMATCH },
  PLACEMENT_FINDING_UNRESOLVED: { status: 409, error: 'This placement is not currently bound to an executable finding.', effect: 'not-started' },
  MAINTENANCE_SCAN_IN_PROGRESS: { status: 409, error: 'maintenance provider check is in progress', effect: 'not-started' },
  SYSTEM_SCAN_IN_PROGRESS: { status: 409, error: 'full System scan is in progress', effect: 'not-started' },
  RECONCILE_OUTCOME_NOT_ENABLED: { status: 409, error: 'The interruption audit does not enable this outcome for this receipt.', effect: 'not-started' },
  SCAN_REQUIRED: { status: 409, error: 'No inventory has been built yet. Run a Maintenance scan first.', effect: 'not-started' },
  SOURCE_NOT_SCANNABLE: { status: 409, error: 'This source is covered by the provider check and machine measurement, not by a discovery scan.', effect: 'not-started' },
});
const V2_STATUS_TEXT = Object.freeze({
  400: 'invalid maintenance request', 404: 'The requested maintenance item is not in the current inventory.',
  409: 'maintenance request is stale or no longer authorized', 413: 'maintenance request body is too large',
  415: 'maintenance requests require application/json', 503: 'maintenance operation unavailable',
});
const NOT_FOUND_MESSAGE = /\b(?:not found|no such|no (?:active |pending )?recipe found|no revealable locator|unknown (?:placement|guidance|receipt|discovery source|source|exclusion|recipe|automatic source))/iu;
const SCAN_REQUIRED_MESSAGE = /no management inventory has been built/iu;
const STALE_MESSAGE = /capability|expired|plan|confirmation|undoable/;

function v2ErrorPayload(error) {
  const code = error?.code ?? (SCAN_REQUIRED_MESSAGE.test(String(error?.message ?? '')) ? 'SCAN_REQUIRED' : undefined);
  const known = V2_ERRORS[code];
  if (known) {
    return [known.status, { error: known.error, code: known.code ?? code, ...(known.effect ? { effect: known.effect } : {}) }];
  }
  const message = String(error?.message ?? '');
  const status = Number.isInteger(error?.statusCode) ? error.statusCode
    : error?.code === 'NOT_FOUND' || NOT_FOUND_MESSAGE.test(message) ? 404
      : error instanceof TypeError ? 400
        : STALE_MESSAGE.test(message) ? 409 : 503;
  return [status, { error: V2_STATUS_TEXT[status] ?? V2_STATUS_TEXT[503] }];
}

/** Await an operation for at most `ms`; a scan that keeps running is never
 *  awaited by the request (MNT-PERF-004). Rejections after the window are
 *  absorbed here and remain visible through scan progress state. */
function settleWithin(operation, ms) {
  if (!operation || typeof operation.then !== 'function') return Promise.resolve({ settled: true, value: operation });
  const tracked = Promise.resolve(operation).then((value) => ({ settled: true, value }), (error) => ({ settled: true, error }));
  // The acknowledgement is pending work even when the scan has no active handles.
  let timer;
  const window = new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), ms); });
  return Promise.race([tracked, window]).finally(() => clearTimeout(timer));
}

async function runScanControl(facade, body, scanAckMs) {
  const { action, sourceId } = body;
  if (action === 'pause') {
    await facade.pauseScan({ sourceId });
    return { action, accepted: true, completed: true };
  }
  if (action === 'stop') {
    const result = await facade.stopScan({ sourceId, confirmed: body.confirm === true });
    return { action, ...(result && typeof result === 'object' ? result : {}) };
  }
  const operation = action === 'start'
    ? facade.startScan(sourceId ? { sourceIds: [sourceId] } : {})
    : facade.resumeScan({ sourceIds: [sourceId] });
  const outcome = await settleWithin(operation, scanAckMs);
  if (outcome.settled && outcome.error) throw outcome.error;
  return { action, accepted: true, completed: outcome.settled };
}

function reconcileConfirmation({ receiptId, outcome, audit, now }) {
  const outcomeLabel = RECONCILE_OUTCOME_LABELS[outcome];
  return {
    title: 'Confirm receipt reconciliation',
    summary: 'The server will rerun the interruption audit under the mutation lock before recording anything.',
    receiptId, outcome, outcomeLabel, actionLabel: outcomeLabel,
    auditResult: audit.result, auditResultLabel: AUDIT_RESULT_LABELS[audit.result],
    willChange: [`Record this receipt as "${outcomeLabel}".`],
    preserved: ['The resource itself is not retried, replayed, undone, or completed.', 'Every other receipt remains unchanged.'],
    typedPhrase: 'RECORD', expiresAt: new Date(now() + 5 * 60_000).toISOString(),
  };
}

/** Dashboard transport adapter. The application service owns plans and
 * provider execution; the management facade owns the ADR-0048 inventory;
 * this boundary owns browser authority and projections.
 * @param {{
 *   service?: any,
 *   management?: any,
 *   sessionToken?: string,
 *   now?: () => number,
 *   capabilities?: ReturnType<typeof createMaintenanceCapabilityStore>,
 *   scanAckMs?: number,
 *   afterScan?: () => any,
 * }} options `afterScan` runs (never awaited) after a successful `?refresh=scan`
 *   provider scan so the server can chain the inventory rebuild.
 */
export function createMaintenanceDashboardApi({
  service, management = null, sessionToken, now = Date.now, capabilities, scanAckMs = 250, afterScan = null,
} = {}) {
  if (!service || typeof service.report !== 'function' || typeof service.scan !== 'function'
      || typeof service.plan !== 'function') {
    throw new TypeError('maintenance dashboard service must implement report, scan, and plan');
  }
  const store = capabilities ?? createMaintenanceCapabilityStore({ now });
  let managementPromise = null;
  /** `management` may be the facade itself or a lazy async provider so the
   *  facade (and its owner-private stores) is only constructed on first use. */
  const resolveManagement = async () => {
    if (!management) return null;
    if (typeof management !== 'function') return management;
    try { return await (managementPromise ||= Promise.resolve().then(management)); } catch { managementPromise = null; return null; }
  };

  const withActivity = (model) => ({ ...model, activity: typeof service.scanState === 'function' ? service.scanState() : null });

  async function report(_req, res, { refresh = false } = {}) {
    try {
      const model = await (refresh ? service.scan() : service.report());
      // The chained inventory rebuild is fire-and-forget: the scan response stands on its own.
      if (refresh && typeof afterScan === 'function') { try { Promise.resolve(afterScan()).catch(() => {}); } catch { /* ignored */ } }
      sendJson(res, 200, publicMaintenanceModel(withActivity(model)));
    }
    catch (error) {
      if (error?.code === 'SYSTEM_SCAN_IN_PROGRESS') {
        sendJson(res, 409, { error: 'full System scan is in progress', code: 'SYSTEM_SCAN_IN_PROGRESS', effect: 'not-started' });
      } else sendJson(res, 503, { error: 'maintenance evidence unavailable' });
    }
  }

  function mintApply({ plan, confirmation, surface, extra = {} }) {
    return store.mint({
      sessionToken, verb: 'apply', expiresAt: Date.parse(plan.expiresAt),
      authority: { plan, actionIds: plan.actions.map((action) => action.id), expectedPlanDigest: plan.planDigest, confirmation, surface, ...extra },
    });
  }

  async function createPlan(body) {
    const plan = await service.plan({ findingIds: body.findingIds, executable: true });
    assertExecutablePlan(plan);
    const confirmation = confirmationForPlan(plan);
    const capability = mintApply({ plan, confirmation, surface: 'v1' });
    return [200, { plan: publicPlan(plan), capability, confirmation }];
  }

  /** ADR-0048: one placement, one guidance entry, one action (MNT-ACT-001). */
  async function createPlanV2(facade, body) {
    const plan = await facade.planAction({ placementId: body.placementId, guidanceId: body.guidanceId });
    if (!Array.isArray(plan?.actions) || plan.actions.length !== 1) {
      throw Object.assign(new Error('A maintenance plan carries exactly one action.'), { code: 'ONE_ACTION_PER_PLAN' });
    }
    assertExecutablePlan(plan);
    const confirmation = withoutAbsentEvidence(confirmationForPlan(plan));
    const capability = mintApply({
      plan, confirmation, surface: 'v2', extra: { placementId: body.placementId, guidanceId: body.guidanceId },
    });
    return [200, { plan: publicPlan(plan), capability, confirmation }];
  }

  const phraseRefusal = [409, { error: 'confirmation phrase did not match the preview', effect: 'not-started' }];

  function consumeFor(body, verb, surface) {
    const authority = store.consume({ capability: body.capability, sessionToken, verb });
    if ((authority.surface ?? 'v1') !== surface) {
      throw new Error('maintenance capability belongs to another maintenance surface');
    }
    return authority;
  }

  async function withUndoPreview(target, result) {
    const receiptId = result?.receipt?.id ?? result?.receiptId;
    if (result?.ok !== true || !receiptId || typeof target.prepareUndo !== 'function') return result;
    const preview = await target.prepareUndo({ receiptId });
    const receipt = result.receipt ?? { id: receiptId, status: result.status };
    const eligible = preview?.undoable === true;
    return {
      ...result,
      receipt: {
        ...receipt, undoEligible: eligible,
        undo: { eligible, status: eligible ? 'Eligible' : 'Unavailable', ...(preview?.summary ? { summary: preview.summary } : {}) },
      },
    };
  }

  async function applyWith(target, body, surface) {
    const authority = consumeFor(body, 'apply', surface);
    if (!typedPhraseMatches(body, authority.confirmation.typedPhrase)) return phraseRefusal;
    if (typeof target.apply !== 'function') throw new Error('maintenance apply is unavailable');
    const result = await withUndoPreview(target, await target.apply({
      plan: authority.plan, actionIds: authority.actionIds, expectedPlanDigest: authority.expectedPlanDigest, confirmed: true,
    }));
    const payload = surface === 'v2' ? publicOutcomeV2(result) : publicOutcome(result);
    return [payload.ok ? 200 : 409, payload];
  }

  async function previewUndoWith(target, body, surface) {
    const prepare = target.prepareUndo ?? target.undoPreview;
    if (typeof prepare !== 'function') throw new Error('maintenance undo preview is unavailable');
    const preview = await prepare.call(target, { receiptId: body.receiptId });
    if (!preview || preview.undoable !== true) {
      return [409, {
        error: 'maintenance receipt is not currently undoable', effect: 'not-started',
        preview: picked(preview, ['receiptId', 'status', 'summary', 'reason', 'undoable', 'actionCount']),
      }];
    }
    const confirmation = {
      title: 'Confirm guarded undo',
      summary: text(preview.summary) ?? 'Current native state will be compared with the recorded postimage before undo.',
      actionCount: Number.isFinite(preview.actionCount) ? preview.actionCount : 1,
      typedPhrase: 'UNDO', expiresAt: new Date(now() + 5 * 60_000).toISOString(),
    };
    const capability = store.mint({
      sessionToken, verb: 'undo', expiresAt: Date.parse(confirmation.expiresAt),
      authority: { receiptId: body.receiptId, confirmation, surface },
    });
    return [200, { capability, confirmation }];
  }

  async function undoWith(target, body, surface) {
    const authority = consumeFor(body, 'undo', surface);
    if (!typedPhraseMatches(body, authority.confirmation.typedPhrase)) return phraseRefusal;
    if (typeof target.undo !== 'function') throw new Error('maintenance undo is unavailable');
    const result = await target.undo({ receiptId: authority.receiptId, confirmed: true });
    const payload = surface === 'v2' ? publicOutcomeV2(result) : publicOutcome(result);
    return [payload.ok ? 200 : 409, payload];
  }

  async function previewReconcile(facade, body) {
    const [audit] = await facade.auditInterruption({ receiptIds: [body.receiptId] });
    const projected = publicAuditResult(audit);
    if (!audit || audit.conclusive !== true || audit.enables !== body.outcome) {
      const [status, payload] = v2ErrorPayload({ code: 'RECONCILE_OUTCOME_NOT_ENABLED' });
      return [status, { ...payload, audit: projected }];
    }
    const confirmation = reconcileConfirmation({ receiptId: body.receiptId, outcome: body.outcome, audit, now });
    const capability = store.mint({
      sessionToken, verb: 'reconcile', expiresAt: Date.parse(confirmation.expiresAt),
      authority: { receiptId: body.receiptId, outcome: body.outcome, confirmation, surface: 'v2' },
    });
    return [200, { capability, confirmation, audit: projected }];
  }

  async function reconcile(facade, body) {
    const authority = consumeFor(body, 'reconcile', 'v2');
    if (!typedPhraseMatches(body, authority.confirmation.typedPhrase)) return phraseRefusal;
    const result = await facade.reconcile({ receiptId: authority.receiptId, outcome: authority.outcome, confirmed: true });
    const payload = publicOutcomeV2(result);
    return [payload.ok ? 200 : 409, payload];
  }

  async function controlScan(facade, body) {
    const result = await runScanControl(facade, body, scanAckMs);
    const progress = await facade.scanProgress();
    const accepted = result.accepted === true && result.completed !== true;
    return [accepted ? 202 : 200, publicScanControl({ ...result, progress })];
  }

  const READ_HANDLERS = Object.freeze({
    inventory: async (facade, { query }) => [200, publicInventoryPage(await facade.inventory(query))],
    placement: async (facade, { params }) => [200, publicInspector(await facade.placement({ placementId: params.placementId }))],
    guidance: async (facade, { query }) => [200, publicGuidance(await facade.guidance(query.lane ? { lane: query.lane } : {}))],
    procedure: async (facade, { params, query }) => [200, publicProcedure(await facade.procedure({
      guidanceId: params.guidanceId, ...(query.shell ? { shell: query.shell } : {}),
    }))],
    discovery: async (facade) => [200, publicDiscovery(await facade.discovery())],
    scans: async (facade) => [200, publicScanProgress(await facade.scanProgress())],
    activity: async (facade) => [200, publicActivity(await facade.activity())],
    receipt: async (facade, { params }) => [200, publicReceiptDetail(await facade.receipt({ receiptId: params.receiptId }))],
    preferences: async (facade) => [200, publicPreferences(await facade.preferences())],
  });

  const MUTATION_HANDLERS = Object.freeze({
    reveal: async (facade, body) => {
      const locator = await facade.revealLocator({ placementId: body.placementId }) ?? {};
      return [200, publicReveal({ ...locator, placementId: body.placementId, exactPath: locator.exactPath ?? locator.path })];
    },
    checklist: async (facade, body) => [200, publicChecklistState({
      guidanceId: body.guidanceId,
      ...(await facade.checklist({ guidanceId: body.guidanceId, stepId: body.stepId, done: body.done })),
    })],
    discoveryPreview: async (facade, body) => [200, publicDiscoveryPreview(await facade.previewSource({ kind: body.kind, root: body.root }))],
    discoverySources: async (facade, body) => [200, publicDiscoveryChange(await facade.saveSource({ previewId: body.previewId, confirmed: true }))],
    discoverySourcesRemove: async (facade, body) => [200, publicDiscoveryChange(await facade.removeSource({
      sourceId: body.sourceId, confirmed: body.confirm,
    }))],
    discoveryAutomatic: async (facade, body) => [200, publicDiscoveryChange(await facade.setAutomaticSource({
      sourceId: body.sourceId, enabled: body.enabled,
    }))],
    discoveryExclusions: async (facade, body) => [200, publicExclusionResult(await facade.addExclusion({ path: body.path, recursive: body.recursive }))],
    discoveryExclusionsRemove: async (facade, body) => [200, publicExclusionResult(await facade.removeExclusion({ exclusionId: body.exclusionId }))],
    scanControl: controlScan,
    receiptExport: async (facade, body) => [200, publicReceiptExport(await facade.exportReceipt({
      receiptId: body.receiptId, includeLocalPaths: body.includeLocalPaths, acknowledgedWarning: body.acknowledgedWarning,
    }))],
    dispositions: async (facade, body) => [200, publicDispositionRecord(await facade.recordDisposition({
      guidanceId: body.guidanceId, kind: body.kind, ...(body.until ? { until: body.until } : {}), confirmed: true,
    }))],
    audit: async (facade, body) => [200, { results: publicAuditResults(await facade.auditInterruption({ receiptIds: body.receiptIds })) }],
    reconcilePreview: previewReconcile,
    reconcile,
    plans: createPlanV2,
    apply: (facade, body) => applyWith(facade, body, 'v2'),
    undo: (facade, body) => (body.preview ? previewUndoWith(facade, body, 'v2') : undoWith(facade, body, 'v2')),
    recipesRefresh: async (facade) => [200, publicRecipeRefresh(await facade.refreshRecipes({ confirmed: true }))],
    recipesAccept: async (facade, body) => [200, { recipe: publicRecipe(await facade.acceptRecipe({
      recipeId: body.recipeId, recipeVersion: body.recipeVersion, confirmed: true,
    })) }],
    recipesWithdraw: async (facade, body) => [200, { recipe: publicRecipe(await facade.withdrawRecipe({
      recipeId: body.recipeId, ...(body.recipeVersion ? { recipeVersion: body.recipeVersion } : {}), confirmed: true,
    })) }],
    savePreferences: async (facade, body) => [200, publicPreferences(await facade.savePreferences(body))],
  });

  /** GET /api/maintenance/v2/* — `url` is a URL or a request path with query. */
  async function readV2(req, res, url) {
    const target = url instanceof URL ? url : new URL(String(url ?? req?.url ?? '/'), 'http://127.0.0.1');
    const route = matchMaintenanceV2Route('GET', target.pathname);
    if (!route) {
      sendJson(res, 404, { error: 'maintenance route not found' });
      return;
    }
    try {
      const query = validateMaintenanceV2Query(route.name, target.searchParams);
      const facade = await resolveManagement();
      if (!facade) {
        sendJson(res, 503, { error: 'maintenance management unavailable' });
        return;
      }
      const [status, payload] = await READ_HANDLERS[route.name](facade, { params: route.params, query });
      sendJson(res, status, payload);
    } catch (error) {
      const [status, payload] = v2ErrorPayload(error);
      sendJson(res, status, payload);
    }
  }

  async function mutateV2(name, req, res) {
    const facade = await resolveManagement();
    if (!facade) {
      req.resume?.();
      sendJson(res, 503, { error: 'maintenance management unavailable' });
      return;
    }
    try {
      const body = validateMaintenanceV2Body(name, await readMaintenanceJson(req), { now });
      const [status, payload] = await MUTATION_HANDLERS[name](facade, body);
      sendJson(res, status, payload);
    } catch (error) {
      const [status, payload] = v2ErrorPayload(error);
      sendJson(res, status, payload);
    }
  }

  async function mutateV1(route, req, res) {
    try {
      const body = /** @type {Record<string, any>} */ (
        validateMaintenanceBody(route, await readMaintenanceJson(req))
      );
      const [status, payload] = route === '/api/maintenance/plans' ? await createPlan(body)
        : route === '/api/maintenance/apply' ? await applyWith(service, body, 'v1')
          : body.preview ? await previewUndoWith(service, body, 'v1') : await undoWith(service, body, 'v1');
      sendJson(res, status, payload);
    } catch (error) {
      if (error?.code === 'MAINTENANCE_SCAN_IN_PROGRESS'
          || error?.code === 'SYSTEM_SCAN_IN_PROGRESS') {
        const system = error.code === 'SYSTEM_SCAN_IN_PROGRESS';
        sendJson(res, 409, {
          error: system ? 'full System scan is in progress' : 'maintenance provider check is in progress',
          code: error.code, effect: 'not-started',
        });
        return;
      }
      const status = error?.statusCode ?? (error instanceof TypeError ? 400
        : (STALE_MESSAGE.test(error?.message ?? '') ? 409 : 503));
      sendJson(res, status, { error: V2_STATUS_TEXT[status] ?? V2_STATUS_TEXT[503] });
    }
  }

  async function mutate(route, req, res) {
    const v2 = matchMaintenanceV2Route('POST', route);
    if (v2) await mutateV2(v2.name, req, res);
    else await mutateV1(route, req, res);
  }

  return Object.freeze({ report, readV2, mutate, capabilityCount: store.size });
}
