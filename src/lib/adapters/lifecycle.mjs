import { OWNERSHIP_TYPES, assertEnum, immutable } from './schema.mjs';

export const LIFECYCLE_OPERATIONS = Object.freeze(['detect', 'plan', 'apply', 'verify', 'undo']);

export function validateLifecycleAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('lifecycle adapter must be an object');
  if (typeof adapter.id !== 'string' || !adapter.id) throw new TypeError('lifecycle adapter.id is required');
  for (const operation of LIFECYCLE_OPERATIONS) {
    if (typeof adapter[operation] !== 'function') throw new TypeError(`${adapter.id}.${operation} must be a function`);
  }
  return adapter;
}

export function ownership({ owner = 'unknown', prior = null, written = null, surface = null } = {}) {
  assertEnum(owner, OWNERSHIP_TYPES, 'ownership.owner');
  return immutable({ owner, prior, written, surface });
}

export function mayUndo(current, record) {
  if (!record || record.owner !== 'agentic-kit') return false;
  return Object.is(current, record.written);
}

export function lifecycleResult({
  ok = true, changed = false, facts = null, actions = [], ownership: records = [],
  warnings = [], errors = [],
} = {}) {
  for (const list of [actions, records, warnings, errors]) {
    if (!Array.isArray(list)) throw new TypeError('lifecycle result collections must be arrays');
  }
  return immutable({ ok: !!ok, changed: !!changed, facts, actions, ownership: records, warnings, errors });
}

async function runLifecycleLegacy(adapter, operation, context = {}) {
  validateLifecycleAdapter(adapter);
  if (!LIFECYCLE_OPERATIONS.includes(operation)) throw new TypeError(`unknown lifecycle operation: ${operation}`);
  if (context.dryRun && operation === 'apply') {
    const plan = await adapter.plan({ ...context, dryRun: true });
    return lifecycleResult({ ...plan, changed: false });
  }
  return lifecycleResult(await adapter[operation](context));
}

export async function runLifecycle(adapterOrRequest, operation, context = {}) {
  if (typeof operation === 'string') return runLifecycleLegacy(adapterOrRequest, operation, context);
  const request = adapterOrRequest;
  const { adapter, action, dryRun = false } = request;
  validateLifecycleAdapter(adapter);
  if (!LIFECYCLE_OPERATIONS.includes(action)) throw new TypeError(`unknown lifecycle operation: ${action}`);
  if (action === 'detect') return adapter.detect(request);
  const facts = request.facts ?? await adapter.detect(request);
  if (action === 'plan') return adapter.plan({ ...request, facts });
  if (action === 'apply') {
    // F8 (security-review follow-up): fail closed when detect (or plan)
    // signals a hook failure — never let apply run against facts/a plan the
    // adapter itself refused to produce. The gate fires on ANY truthy
    // `.error` on the detect-facts/plan object — an ADMITTED host's hook
    // failure is reported this way ({observed:null, error} from
    // detect/verify, {changed:false, operations:[], error} from plan —
    // lifecycle-registry.mjs's hookFailureResult/unanchoredResult), but a
    // SUCCESSFUL hook's own JSON payload is returned verbatim too (same
    // file's buildAdmittedLifecycleAdapter, `return payload`), so `error` is
    // effectively RESERVED in the detect/plan payload contract: a hook must
    // never use it for a non-fatal note, only genuine failure. opencode's own
    // detect()/plan() (see opencode.mjs's createOpencodeLifecycleAdapter)
    // never set an `.error` key on any path, so this check is a strict no-op
    // for opencode regardless.
    if (facts?.error) {
      return lifecycleResult({ ok: false, changed: false, errors: [facts.error] });
    }
    const plan = request.plan ?? await adapter.plan({ ...request, facts });
    if (plan?.error) {
      return lifecycleResult({ ok: false, changed: false, errors: [plan.error] });
    }
    // The abort above intentionally precedes the dryRun preview below: a
    // failed detect/plan has no valid plan to preview, so dryRun on a hook
    // failure returns this lifecycleResult (no `.dryRun` field) rather than a
    // fabricated {dryRun:true, facts, plan}.
    if (dryRun) return { dryRun: true, facts, plan };
    return adapter.apply({ ...request, facts, plan });
  }
  if (action === 'verify') return adapter.verify({ ...request, facts });
  if (dryRun) {
    const plan = request.plan ?? await adapter.plan({ ...request, facts });
    return { dryRun: true, facts, plan };
  }
  return adapter.undo({ ...request, facts });
}
