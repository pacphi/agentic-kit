import {
  MAINTENANCE_CAPABILITIES, MAINTENANCE_SCHEMA_VERSION, PLAN_TTL_MS, SAFETY_CLASSES, deepFreeze,
} from './model.mjs';
import { sha256 } from './evidence.mjs';

function selectedFindings(findings) {
  if (!Array.isArray(findings) || !findings.length) {
    throw new TypeError('A maintenance plan requires at least one exact finding ID.');
  }
  const ids = new Set();
  const selected = [...findings].sort((a, b) => String(a?.id).localeCompare(String(b?.id)));
  for (const finding of selected) {
    if (!finding?.id || !finding?.resource?.id) throw new TypeError('Every finding requires an exact resource identity.');
    if (ids.has(finding.id)) throw new TypeError(`Duplicate maintenance finding ID: ${finding.id}`);
    if (!SAFETY_CLASSES.includes(finding.safetyClass)) throw new TypeError('Finding safety class is invalid.');
    ids.add(finding.id);
  }
  return selected;
}

function actionFromFinding(finding) {
  const action = {
    providerId: finding.nextAction?.providerId ?? 'maintenance.read-only',
    providerVersion: finding.nextAction?.providerVersion ?? '1',
    operation: finding.nextAction?.operation ?? 'review',
    resourceIdentity: finding.resource,
    classification: finding.safetyClass,
    findingClassification: finding.classification,
    rollback: finding.nextAction?.rollback ?? 'irreversible',
    restart: finding.nextAction?.restart ?? 'unknown',
    executable: false,
  };
  return {
    id: `maintenance-action-${sha256({ findingId: finding.id, ...action }).slice(0, 20)}`,
    ...action,
  };
}

function digestable(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    capabilities: plan.capabilities,
    sourceFingerprint: plan.sourceFingerprint,
    generatedAt: plan.generatedAt,
    expiresAt: plan.expiresAt,
    safetyClass: plan.safetyClass,
    findingIds: plan.findingIds,
    actions: plan.actions,
  };
}

/** Build an immutable, non-executable selection bound to current source state.
 * @param {{ findings?: any[], sourceFingerprint?: string, now?: () => number }} [options] */
export function buildMaintenancePlan({ findings, sourceFingerprint, now = Date.now } = {}) {
  if (typeof sourceFingerprint !== 'string' || !sourceFingerprint) {
    throw new TypeError('A maintenance plan requires a source fingerprint.');
  }
  const selected = selectedFindings(findings);
  const classes = new Set(selected.map((finding) => finding.safetyClass));
  if (classes.size !== 1) throw new TypeError('A maintenance plan may contain only one safety class.');
  const generatedAtMs = now();
  if (!Number.isFinite(generatedAtMs)) throw new TypeError('Plan generation time must be finite.');
  const plan = {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    mode: 'read-only',
    capabilities: MAINTENANCE_CAPABILITIES,
    sourceFingerprint,
    generatedAt: new Date(generatedAtMs).toISOString(),
    expiresAt: new Date(generatedAtMs + PLAN_TTL_MS).toISOString(),
    safetyClass: selected[0].safetyClass,
    findingIds: selected.map((finding) => finding.id),
    actions: selected.map(actionFromFinding),
  };
  const planDigest = sha256(digestable(plan));
  return deepFreeze({
    ...plan,
    planId: `maintenance-plan-${planDigest.slice(0, 20)}`,
    planDigest,
  });
}

/** Verify digest, source binding, safety-class isolation, and expiry. */
export function assertMaintenancePlanIntegrity(plan, {
  sourceFingerprint = plan?.sourceFingerprint,
  now = Date.now,
} = {}) {
  if (!plan || plan.schemaVersion !== MAINTENANCE_SCHEMA_VERSION) {
    throw new TypeError('Maintenance plan schema is invalid.');
  }
  if (plan.mode !== 'read-only' || plan.capabilities?.apply !== false || plan.capabilities?.undo !== false) {
    throw new TypeError('Maintenance plan capability boundary is invalid.');
  }
  if (plan.sourceFingerprint !== sourceFingerprint) throw new Error('Maintenance plan source fingerprint drifted.');
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const classes = new Set(actions.map((action) => action?.classification));
  const executable = actions.some((action) => action?.executable !== false);
  if (!SAFETY_CLASSES.includes(plan.safetyClass)
      || classes.size !== 1
      || !classes.has(plan.safetyClass)
      || executable
      || !actions.length) {
    throw new Error('Maintenance plan safety class is invalid.');
  }
  const expected = sha256(digestable(plan));
  if (plan.planDigest !== expected || plan.planId !== `maintenance-plan-${expected.slice(0, 20)}`) {
    throw new Error('Maintenance plan digest does not match its content.');
  }
  if (now() > Date.parse(plan.expiresAt)) throw new Error('Maintenance plan expired.');
  return plan;
}
