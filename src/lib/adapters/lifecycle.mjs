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
    const plan = request.plan ?? await adapter.plan({ ...request, facts });
    if (dryRun) return { dryRun: true, facts, plan };
    return adapter.apply({ ...request, facts, plan });
  }
  if (action === 'verify') return adapter.verify({ ...request, facts });
  return adapter.undo({ ...request, facts });
}
