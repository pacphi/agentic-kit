// ADR-0054: the public contract is independent of internal cache schemas.
export const MAX_SESSIONS = 100_000;
export const MAX_RECEIPTS = 100_000;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const HOSTS = ['claude', 'codex', 'opencode'];
export const LATENCY_BOUNDS_SECONDS = [2, 5, 10, 30, 60];
export const RECEIPT_STATES = ['prepared', 'applying', 'verifying', 'refreshing-catalog', 'undoing',
  'failed', 'partial', 'partial-recovery-required', 'outcome-unknown', 'committed', 'rolled-back',
  'undone', 'aborted-no-change', 'unknown-recovery-required', 'unknown'];
export const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
export const COUNT_FIELDS = ['prompts', 'responses', 'exceptions', 'aborts',
  'observedCostMessages', 'estimatedCostMessages', 'unpricedMessages'];
export const COST_FIELDS = ['observedCostUsd', 'estimatedCostUsd'];
export const METRIC_FIELDS = [...TOKEN_FIELDS, ...COUNT_FIELDS, ...COST_FIELDS];

const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const enumeration = (values) => ({ enum: values });
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableInteger = { ...integer, type: ['integer', 'null'] };
const money = { type: ['number', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$', maxLength: 64 };
const timestamp = { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$', maxLength: 24 };
const nullableTimestamp = { ...timestamp, type: ['string', 'null'] };
const available = enumeration(['available', 'unavailable']);
const hostHealth = enumeration(['ok', 'absent', 'degraded', 'unavailable', 'unknown']);
const session = object({
  sessionId: digest, host: enumeration(HOSTS),
  ...Object.fromEntries([...TOKEN_FIELDS, ...COUNT_FIELDS].map(key => [key, nullableInteger])),
  ...Object.fromEntries(COST_FIELDS.map(key => [key, money])),
  latencyBuckets: { type: ['array', 'null'], items: integer, minItems: 6, maxItems: 6 },
});

export const SNAPSHOT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Agentic-kit telemetry snapshot v1',
  ...object({
    schemaVersion: { const: 1 }, kind: { const: 'agentic-kit.telemetry.snapshot' }, snapshotId: digest,
    installationId: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$', maxLength: 36 },
    generatedAt: timestamp,
    producerVersion: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?$', maxLength: 80 },
    selection: object({ days: { type: 'integer', minimum: 1, maximum: 365 }, scope: { const: 'whole-retained-sessions-selected-by-end' } }),
    usage: object({ state: available, acquisitionComplete: { type: ['boolean', 'null'] },
      pricesAsOf: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', maxLength: 10 },
      sourceHealth: object(Object.fromEntries([...HOSTS, 'codexLedger'].map(host => [host, hostHealth]))),
      sessions: { type: 'array', items: session, maxItems: MAX_SESSIONS },
    }),
    inventory: object({ state: available, capturedAt: nullableTimestamp, resources: nullableInteger, placements: nullableInteger }),
    maintenance: object({ state: available, receipts: { type: 'array', maxItems: MAX_RECEIPTS,
      items: object({ receiptId: digest, status: enumeration(RECEIPT_STATES), updatedAt: nullableTimestamp }),
    } }),
  }),
};

/** Machine-readable metric semantics; every measure uses snapshot replacement before folding. */
export const METRIC_CATALOG = Object.fromEntries(METRIC_FIELDS.map(name => [name, {
  unit: TOKEN_FIELDS.includes(name) ? 'token' : COST_FIELDS.includes(name) ? 'USD' : 'count',
  aggregation: 'sum-known-values-after-latest-installation-snapshot',
  missing: 'null; measured and missing contribution counts accompany every aggregate',
  basis: name === 'estimatedCostUsd' ? 'API-equivalent estimate, not billing'
    : name === 'observedCostUsd' ? 'source-reported cost, not reconciled billing' : 'normalized retained session observation',
}]));

export const DERIVED_METRICS = {
  cacheReadShare: { unit: 'ratio', numerator: 'sum(cacheRead)',
    denominator: 'sum(input + cacheRead + cacheWrite)',
    eligibility: 'only sessions with all three known counts', zeroDenominator: null },
  latency: { unit: 's', upperBounds: LATENCY_BOUNDS_SECONDS,
    buckets: 'six non-cumulative counts; upper bounds inclusive; final bucket above 60s',
    aggregation: 'sum corresponding buckets; never average percentiles', missing: null },
  inventoryResources: { unit: 'count', aggregation: 'sum known resource counts from latest installation snapshots' },
  inventoryPlacements: { unit: 'count', aggregation: 'sum known placement counts from latest installation snapshots' },
  retainedReceipts: { unit: 'count', aggregation: 'count retained receipt observations by controlled status' },
  sessionObservations: { unit: 'count', aggregation: 'count retained sessions across installation snapshots; not unique people or tasks' },
};
