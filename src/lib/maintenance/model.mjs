/** Domain vocabulary for the read-only Maintenance bounded context. */
export const MAINTENANCE_SCHEMA_VERSION = 1;
export const PLAN_TTL_MS = 5 * 60_000;

export const MAINTENANCE_CAPABILITIES = Object.freeze({
  plan: true,
  apply: false,
  undo: false,
});

export const SUMMARY_BUCKETS = Object.freeze([
  'updatesReady',
  'safeCleanup',
  'needsReview',
  'unsupportedOrBlocked',
  'recentChanges',
]);

export const FINDING_STATES = Object.freeze([
  'current-healthy',
  'update-available',
  'stale-configuration',
  'orphaned-cache',
  'superseded-version',
  'unsupported-incompatible',
  'modified',
  'ambiguous',
  'unreadable-partial',
]);

export const VERSION_AXES = Object.freeze([
  'installed',
  'recommended',
  'producer',
  'sourceRevision',
  'cacheGeneration',
  'contentDigest',
]);

export const SAFETY_CLASSES = Object.freeze([
  'safe-automatic',
  'approval-required',
  'upstream-required',
  'never-automatic',
]);

export const ROLLBACK_CLASSES = Object.freeze([
  'reversible',
  'compensating',
  'irreversible',
]);

/** Recursively freeze a JSON-shaped contract object. */
export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function emptySummary() {
  return Object.fromEntries(SUMMARY_BUCKETS.map((bucket) => [bucket, 0]));
}
