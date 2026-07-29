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
  'readiness', 'prepare', 'launch', 'observe', 'interpret', 'cancel', 'cleanup',
]);

/** Validate the host-neutral execution-adapter shape without invoking it. */
export function validateExecutionAdapter(value) {
  assertRecord(value, 'executionAdapter');
  assertId(value.id, 'executionAdapter.id');
  for (const method of REQUIRED_METHODS) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`executionAdapter.${method} must be a function`);
    }
  }
  return immutable({ id: value.id, ...Object.fromEntries(REQUIRED_METHODS.map((method) => [method, value[method]])) });
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
  return immutable(structuredClone(value));
}
