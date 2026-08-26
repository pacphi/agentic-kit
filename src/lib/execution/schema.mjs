// Host-worker execution contract — deliberately separate from host configuration
// lifecycle. This first slice defines the capability boundary; it does not make a
// host runnable or change routing eligibility.
import { assertEnum, assertId, assertRecord, immutable } from '../adapters/schema.mjs';

export const WORKER_STATUSES = Object.freeze([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'blocked',
]);

export const EXIT_CATEGORIES = Object.freeze([
  'success', 'cancelled', 'timeout', 'permission_required', 'auth_required',
  'model_unavailable', 'cli_unavailable', 'protocol_error', 'worker_error',
  'orphaned', 'unknown',
]);

const REQUIRED_METHODS = Object.freeze([
  'readiness', 'prepare', 'launch', 'observe', 'interpret', 'summarize', 'cancel', 'cleanup',
]);

// Optional per-adapter hooks (ADR-0034). `handoffRequestFor(worker)` lets an
// adapter supply the handoff instruction matching its transport (schema-native
// hosts ask for the bare JSON object); absent, the runner appends the generic
// tagged-block request. Optional and validated only when present, so existing
// adapters — including externally-admitted ones — keep their exact shape.
const OPTIONAL_METHODS = Object.freeze(['handoffRequestFor']);

/** Validate the host-neutral execution-adapter shape without invoking it. */
export function validateExecutionAdapter(value) {
  assertRecord(value, 'executionAdapter');
  assertId(value.id, 'executionAdapter.id');
  for (const method of REQUIRED_METHODS) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`executionAdapter.${method} must be a function`);
    }
  }
  const optional = {};
  for (const method of OPTIONAL_METHODS) {
    if (value[method] === undefined) continue;
    if (typeof value[method] !== 'function') {
      throw new TypeError(`executionAdapter.${method} must be a function when present`);
    }
    optional[method] = value[method];
  }
  return immutable({
    id: value.id,
    ...Object.fromEntries(REQUIRED_METHODS.map((method) => [method, value[method]])),
    ...optional,
  });
}

/** Validate the privacy-safe, normalized terminal result every adapter returns. */
export function validateWorkerResult(value) {
  assertRecord(value, 'workerResult');
  assertId(value.workerId, 'workerResult.workerId');
  assertId(value.activity, 'workerResult.activity');
  assertId(value.role, 'workerResult.role');
  assertId(value.host, 'workerResult.host');
  assertEnum(value.status, WORKER_STATUSES, 'workerResult.status');
  assertEnum(value.exitCategory, EXIT_CATEGORIES, 'workerResult.exitCategory');
  if (typeof value.startedAt !== 'string' || typeof value.endedAt !== 'string'
    || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
    throw new TypeError('workerResult requires ISO timestamps and a non-negative durationMs');
  }
  if (value.provider !== null && typeof value.provider !== 'string') throw new TypeError('workerResult.provider must be string|null');
  if (value.configuredModel !== null && typeof value.configuredModel !== 'string') throw new TypeError('workerResult.configuredModel must be string|null');
  if (value.observedModel !== null && typeof value.observedModel !== 'string') throw new TypeError('workerResult.observedModel must be string|null');
  if (value.sessionId !== null && typeof value.sessionId !== 'string') throw new TypeError('workerResult.sessionId must be string|null');
  if (!Array.isArray(value.transcriptRefs) || value.transcriptRefs.some((ref) => typeof ref !== 'string')) {
    throw new TypeError('workerResult.transcriptRefs must be an array of strings');
  }
  if (value.failure !== null && (typeof value.failure !== 'object' || Array.isArray(value.failure))) {
    throw new TypeError('workerResult.failure must be object|null');
  }
  if (value.usage !== null && (typeof value.usage !== 'object' || Array.isArray(value.usage))) {
    throw new TypeError('workerResult.usage must be object|null');
  }
  assertEnum(value.providerProvenance, ['observed', 'configured', 'inferred', 'unknown'], 'workerResult.providerProvenance');
  if (value.provider === null && value.providerProvenance !== 'unknown') {
    throw new TypeError('workerResult.providerProvenance must be unknown without a provider');
  }
  // attempts (ADR-0019): the escalation trail — present only when a worker
  // actually advanced rungs. Each entry is one executed attempt's compact
  // verdict, never a fabricated one.
  if (value.attempts !== undefined) {
    if (!Array.isArray(value.attempts)) throw new TypeError('workerResult.attempts must be an array when present');
    for (const [i, a] of value.attempts.entries()) {
      assertRecord(a, `workerResult.attempts[${i}]`);
      if (typeof a.host !== 'string' || !a.host) throw new TypeError(`workerResult.attempts[${i}].host must be a non-empty string`);
      if (a.model !== null && typeof a.model !== 'string') throw new TypeError(`workerResult.attempts[${i}].model must be string|null`);
      assertEnum(a.status, WORKER_STATUSES, `workerResult.attempts[${i}].status`);
      assertEnum(a.exitCategory, EXIT_CATEGORIES, `workerResult.attempts[${i}].exitCategory`);
      if (!Number.isFinite(a.durationMs) || a.durationMs < 0) throw new TypeError(`workerResult.attempts[${i}].durationMs must be a non-negative number`);
      if (a.reason !== undefined && typeof a.reason !== 'string') throw new TypeError(`workerResult.attempts[${i}].reason must be a string when present`);
    }
  }
  return immutable(structuredClone(value));
}
