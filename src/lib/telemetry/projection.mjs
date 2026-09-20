import { createHmac } from 'node:crypto';
import { sealSnapshot } from './contract.mjs';
import { HOSTS, RECEIPT_STATES, TOKEN_FIELDS } from './schema.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function reference(identity, domain, parts) {
  return createHmac('sha256', Buffer.from(identity.key, 'hex')).update(JSON.stringify([domain, ...parts])).digest('hex');
}
function health(value) {
  return ['ok', 'absent', 'degraded', 'unavailable'].includes(value) ? value : 'unknown';
}
function sessionProjection(s, identity) {
  if (!HOSTS.includes(s.host) || typeof s.id !== 'string' || !s.id || s.id.length > 4096) {
    throw new TypeError('Unsupported telemetry session identity');
  }
  const cost = s.costEvidence ?? {};
  const observed = count(cost.observedMessages);
  const estimated = count(cost.estimatedMessages);
  const unpriced = count(cost.unpricedMessages);
  const hasUsage = (observed ?? 0) + (estimated ?? 0) + (unpriced ?? 0) > 0;
  const buckets = Array.isArray(s.latHist) && s.latHist.length === 6
    && s.latHist.every(x => count(x) !== null) ? [...s.latHist] : null;
  return {
    sessionId: reference(identity, 'session', [s.host, s.id]), host: s.host,
    ...Object.fromEntries(TOKEN_FIELDS.map(key => [key, hasUsage ? count(s[key]) : null])),
    prompts: count(s.prompts), responses: count(s.responses), exceptions: count(s.exceptions), aborts: count(s.aborts),
    observedCostUsd: observed > 0 ? money(cost.observedUsd) : null,
    estimatedCostUsd: estimated > 0 ? money(cost.estimatedUsd) : null,
    observedCostMessages: observed, estimatedCostMessages: estimated, unpricedMessages: unpriced,
    latencyBuckets: buckets,
  };
}

/** Pure anti-corruption layer: construct each field, never spread source records. */
export function createSnapshot({ identity, generatedAt, producerVersion, days, usage, inventory, receipts }) {
  if (!/^[a-f0-9]{64}$/.test(identity?.key ?? '')) throw new TypeError('Invalid telemetry identity');
  const sessions = (usage?.sessions ?? []).map(s => sessionProjection(s, identity))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const capturedAt = iso(inventory?.capturedAt);
  const inventoryAvailable = capturedAt !== null && Array.isArray(inventory?.resources) && Array.isArray(inventory?.placements);
  return sealSnapshot({
    schemaVersion: 1, kind: 'agentic-kit.telemetry.snapshot', installationId: identity.installationId,
    generatedAt, producerVersion,
    selection: { days, scope: 'whole-retained-sessions-selected-by-end' },
    usage: {
      state: usage ? 'available' : 'unavailable',
      acquisitionComplete: typeof usage?.acquisitionCoverage?.complete === 'boolean' ? usage.acquisitionCoverage.complete : null,
      pricesAsOf: /^\d{4}-\d{2}-\d{2}$/.test(usage?.pricesAsOf ?? '') ? usage.pricesAsOf : null,
      sourceHealth: Object.fromEntries([...HOSTS, 'codexLedger'].map(host => [host, health(usage?.sourceHealth?.[host]?.status)])),
      sessions,
    },
    inventory: { state: inventoryAvailable ? 'available' : 'unavailable',
      capturedAt: inventoryAvailable ? capturedAt : null,
      resources: inventoryAvailable ? inventory.resources.length : null,
      placements: inventoryAvailable ? inventory.placements.length : null },
    maintenance: { state: receipts ? 'available' : 'unavailable',
      receipts: (receipts ?? []).map(r => {
        if (typeof r.id !== 'string' || !r.id || r.id.length > 4096) throw new TypeError('Invalid telemetry receipt identity');
        return { receiptId: reference(identity, 'receipt', [r.id]),
          status: RECEIPT_STATES.includes(r.status) ? r.status : 'unknown', updatedAt: iso(r.updatedAt) };
      }).sort((a, b) => a.receiptId.localeCompare(b.receiptId)),
    },
  });
}
