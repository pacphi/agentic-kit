import { createHash } from 'node:crypto';
import { SNAPSHOT_SCHEMA, TOKEN_FIELDS } from './schema.mjs';

/** Deterministic JSON; object order never changes the content identity. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function snapshotDigest(snapshot) {
  const { snapshotId: _id, ...body } = snapshot;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function invalid() { throw new TypeError('Invalid telemetry contract'); }
function hasType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

function checkString(value, schema) {
  if (value.length > schema.maxLength || (schema.pattern && !new RegExp(schema.pattern).test(value))) invalid();
  if (schema.format === 'date-time' && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) invalid();
}

// Deliberately limited to the keywords used by the published schema, not a general schema engine.
function check(value, schema) {
  if (Object.hasOwn(schema, 'const') && value !== schema.const) invalid();
  if (schema.enum && !schema.enum.includes(value)) invalid();
  if (schema.type && ![schema.type].flat().some(type => hasType(value, type))) invalid();
  if (value === null) return;
  if (typeof value === 'number' && (value < schema.minimum || value > schema.maximum)) invalid();
  if (typeof value === 'string') checkString(value, schema);
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > schema.maxItems) invalid();
    value.forEach(item => check(item, schema.items));
  } else if (schema.properties) {
    if (Object.keys(value).length !== schema.required.length || schema.required.some(key => !Object.hasOwn(value, key))) invalid();
    for (const key of schema.required) check(value[key], schema.properties[key]);
  }
}

function unique(rows, key) {
  if (new Set(rows.map(row => row[key])).size !== rows.length) invalid();
}

/** Admit an untrusted snapshot. Error messages never repeat supplied data. */
export function validateSnapshot(snapshot) {
  check(snapshot, SNAPSHOT_SCHEMA);
  unique(snapshot.usage.sessions, 'sessionId');
  unique(snapshot.maintenance.receipts, 'receiptId');
  if (snapshot.usage.state === 'unavailable' && (snapshot.usage.sessions.length || snapshot.usage.acquisitionComplete !== null)) invalid();
  if (snapshot.maintenance.state === 'unavailable' && snapshot.maintenance.receipts.length) invalid();
  const inv = snapshot.inventory;
  if (inv.state === 'unavailable' && [inv.capturedAt, inv.resources, inv.placements].some(x => x !== null)) invalid();
  if (inv.state === 'available' && [inv.capturedAt, inv.resources, inv.placements].some(x => x === null)) invalid();
  if (inv.capturedAt && inv.capturedAt > snapshot.generatedAt) invalid();
  for (const s of snapshot.usage.sessions) {
    const messages = s.observedCostMessages + s.estimatedCostMessages + s.unpricedMessages;
    if (!messages && TOKEN_FIELDS.some(key => s[key] !== null)) invalid();
    if (s.observedCostMessages === 0 && s.observedCostUsd !== null) invalid();
    if (s.estimatedCostMessages === 0 && s.estimatedCostUsd !== null) invalid();
  }
  if (snapshotDigest(snapshot) !== snapshot.snapshotId) throw new TypeError('Telemetry digest mismatch');
  return snapshot;
}

export function sealSnapshot(body) {
  return validateSnapshot({ ...body, snapshotId: snapshotDigest(body) });
}
