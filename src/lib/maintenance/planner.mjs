import {
  MAINTENANCE_CAPABILITIES, MAINTENANCE_SCHEMA_VERSION, PLAN_TTL_MS, ROLLBACK_CLASSES,
  SAFETY_CLASSES, deepFreeze,
} from './model.mjs';
import { sha256 } from './evidence.mjs';

const EXECUTABLE_CAPABILITIES = Object.freeze({ plan: true, apply: true, undo: true });
const EXECUTABLE_CLASSES = new Set(['safe-automatic', 'approval-required']);
const SAFE_VALUE = /^[^\0\r\n/\\]{1,256}$/;
const SAFE_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_OPERATION = /^[a-z][a-z0-9-]{1,47}$/;
const IDENTITY_KEYS = new Set(['id', 'kind', 'name', 'host', 'scope', 'providerRef']);
const ACTION_KEYS = new Set([
  'id', 'providerId', 'providerVersion', 'operation', 'resourceIdentity',
  'classification', 'findingClassification', 'rollback', 'restart', 'executable',
  'sourceFingerprint', 'expectedVersion', 'recommendedVersion', 'impact',
]);
const IMPACT_KEYS = new Set(['summary', 'bytes', 'files', 'dependencies', 'capabilities', 'projects', 'preserved']);

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

function validIdentity(identity) {
  return Boolean(identity) && typeof identity === 'object' && !Array.isArray(identity)
    && Object.keys(identity).every((key) => IDENTITY_KEYS.has(key))
    && SAFE_VALUE.test(String(identity.id ?? ''))
    && Object.values(identity).every((value) => value == null || SAFE_VALUE.test(String(value)));
}

function validExecutableAction(action) {
  if (!action?.id || action.executable !== true
      || Object.keys(action).some((key) => !ACTION_KEYS.has(key))) return false;
  if (!SAFE_VALUE.test(String(action.id)) || !SAFE_VALUE.test(String(action.sourceFingerprint ?? ''))) return false;
  if (!SAFE_PROVIDER.test(action.providerId ?? '') || !SAFE_PROVIDER.test(action.providerVersion ?? '')) return false;
  if (!SAFE_OPERATION.test(action.operation ?? '') || !ROLLBACK_CLASSES.includes(action.rollback)) return false;
  if (!SAFE_VALUE.test(String(action.findingClassification ?? 'unknown'))
      || !['unknown', 'required', 'not-required'].includes(action.restart)) return false;
  if ([action.expectedVersion, action.recommendedVersion]
    .some((value) => value != null && !SAFE_VALUE.test(String(value)))) return false;
  if (action.impact) {
    if (typeof action.impact !== 'object' || Array.isArray(action.impact)
        || Object.keys(action.impact).some((key) => !IMPACT_KEYS.has(key))) return false;
    for (const key of ['capabilities', 'projects', 'preserved']) {
      if (!Array.isArray(action.impact[key]) || action.impact[key].length > 12
          || action.impact[key].some((value) => !SAFE_VALUE.test(String(value)))) return false;
    }
  }
  return validIdentity(action.resourceIdentity);
}

function validExecutableHeader(plan) {
  return Boolean(plan) && plan.schemaVersion === MAINTENANCE_SCHEMA_VERSION && plan.mode === 'executable'
    && plan.capabilities?.plan === true && plan.capabilities?.apply === true
    && plan.capabilities?.undo === true;
}

function validExecutableSelection(plan, actions, findingIds) {
  const classes = new Set(actions.map((action) => action?.classification));
  if (!EXECUTABLE_CLASSES.has(plan.safetyClass) || !actions.length) return false;
  if (classes.size !== 1 || !classes.has(plan.safetyClass)) return false;
  return findingIds.length === actions.length && new Set(findingIds).size === findingIds.length;
}

function executableActions(findings, actions) {
  if (!Array.isArray(actions) || actions.length !== findings.length) {
    throw new TypeError('Every selected finding requires exactly one provider-native action.');
  }
  const findingByResource = new Map(findings.map((finding) => [finding.resource.id, finding]));
  const ids = new Set();
  const resources = new Set();
  return [...actions].sort((a, b) => String(a?.id).localeCompare(String(b?.id))).map((action) => {
    if (!action?.id || ids.has(action.id)) throw new TypeError('Executable action IDs must be present and unique.');
    const identity = action.resourceIdentity;
    if (!validIdentity(identity)) {
      throw new TypeError('Executable action resource identity is invalid.');
    }
    const finding = findingByResource.get(identity.id);
    if (!finding || resources.has(identity.id)) {
      throw new TypeError('Executable actions must map one-to-one to selected findings.');
    }
    if (!validExecutableAction(action) || action.classification !== finding.safetyClass
        || !EXECUTABLE_CLASSES.has(action.classification)
    ) {
      throw new TypeError('Provider-native executable action is invalid.');
    }
    ids.add(action.id);
    resources.add(identity.id);
    return structuredClone(action);
  });
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

/** Build an executable plan only after a service has derived every action from
 * a fresh native provider detection. Browser/client input is never accepted by
 * this builder as an action description.
 * @param {any} options */
export function buildExecutableMaintenancePlan({
  findings, actions, sourceFingerprint, now = Date.now,
} = {}) {
  if (typeof sourceFingerprint !== 'string' || !sourceFingerprint) {
    throw new TypeError('An executable maintenance plan requires a source fingerprint.');
  }
  const selected = selectedFindings(findings);
  const classes = new Set(selected.map((finding) => finding.safetyClass));
  if (classes.size !== 1 || !EXECUTABLE_CLASSES.has(selected[0].safetyClass)) {
    throw new TypeError('An executable maintenance plan requires one executable safety class.');
  }
  const nativeActions = executableActions(selected, actions);
  const generatedAtMs = now();
  if (!Number.isFinite(generatedAtMs)) throw new TypeError('Plan generation time must be finite.');
  const plan = {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    mode: 'executable',
    capabilities: EXECUTABLE_CAPABILITIES,
    sourceFingerprint,
    generatedAt: new Date(generatedAtMs).toISOString(),
    expiresAt: new Date(generatedAtMs + PLAN_TTL_MS).toISOString(),
    safetyClass: selected[0].safetyClass,
    findingIds: selected.map((finding) => finding.id),
    actions: nativeActions,
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

/** Verify an executable plan without weakening the read-only plan assertion. */
export function assertExecutableMaintenancePlanIntegrity(plan, {
  sourceFingerprint = plan?.sourceFingerprint,
  now = Date.now,
} = {}) {
  if (!validExecutableHeader(plan)) {
    throw new TypeError('Executable maintenance plan capability boundary is invalid.');
  }
  if (plan.sourceFingerprint !== sourceFingerprint) throw new Error('Maintenance plan source fingerprint drifted.');
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const findingIds = Array.isArray(plan.findingIds) ? plan.findingIds : [];
  if (!validExecutableSelection(plan, actions, findingIds)) {
    throw new Error('Executable maintenance plan safety class is invalid.');
  }
  for (const action of actions) {
    if (!validExecutableAction(action)) {
      throw new Error('Executable maintenance plan action or identity is invalid.');
    }
  }
  const expected = sha256(digestable(plan));
  if (plan.planDigest !== expected || plan.planId !== `maintenance-plan-${expected.slice(0, 20)}`) {
    throw new Error('Maintenance plan digest does not match its content.');
  }
  const current = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(current) || current > Date.parse(plan.expiresAt)) throw new Error('Maintenance plan expired.');
  return plan;
}
