import { canonicalJson, validateSnapshot } from './contract.mjs';
import { COST_FIELDS, LATENCY_BOUNDS_SECONDS, METRIC_FIELDS, RECEIPT_STATES } from './schema.mjs';

export const MAX_INPUT_FILES = 256;
function sum(a, b) {
  const n = a + b;
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) throw new RangeError('Telemetry aggregate exceeds numeric bounds');
  return n;
}
function measure(values, monetary = false) {
  const known = values.filter(value => value !== null);
  const total = known.length ? known.reduce(sum, 0) : null;
  return { value: total === null ? null : monetary ? Number(total.toFixed(6)) : total,
    measured: known.length, missing: values.length - known.length };
}
function latestSnapshots(snapshots, asOf) {
  if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > MAX_INPUT_FILES) {
    throw new TypeError('Telemetry aggregate requires 1..256 snapshots');
  }
  const latest = new Map();
  const revisions = new Map();
  let selection;
  for (const raw of snapshots) {
    const snapshot = validateSnapshot(raw);
    if (snapshot.generatedAt > asOf) throw new TypeError('Telemetry snapshot is in the future');
    const thisSelection = canonicalJson(snapshot.selection);
    if (selection && selection !== thisSelection) throw new TypeError('Telemetry selection mismatch');
    selection = thisSelection;
    const revision = `${snapshot.installationId}:${snapshot.generatedAt}`;
    if (revisions.has(revision) && revisions.get(revision) !== snapshot.snapshotId) {
      throw new TypeError('Conflicting telemetry snapshots at one installation timestamp');
    }
    revisions.set(revision, snapshot.snapshotId);
    const previous = latest.get(snapshot.installationId);
    if (!previous || previous.generatedAt < snapshot.generatedAt) latest.set(snapshot.installationId, snapshot);
  }
  return [...latest.values()].sort((a, b) => a.installationId.localeCompare(b.installationId));
}
function usageTotals(selected) {
  const sessions = selected.flatMap(s => s.usage.sessions);
  const metrics = Object.fromEntries(METRIC_FIELDS.map(key => [key, measure(sessions.map(s => s[key]), COST_FIELDS.includes(key))]));
  const cacheSessions = sessions.filter(s => [s.input, s.cacheRead, s.cacheWrite].every(x => x !== null));
  const numerator = cacheSessions.reduce((n, s) => sum(n, s.cacheRead), 0);
  const denominator = cacheSessions.reduce((n, s) => sum(n, sum(sum(s.input, s.cacheRead), s.cacheWrite)), 0);
  const histograms = sessions.map(s => s.latencyBuckets).filter(h => h !== null);
  return {
    sessionObservations: sessions.length,
    availableInstallations: selected.filter(s => s.usage.state === 'available').length,
    unavailableInstallations: selected.filter(s => s.usage.state === 'unavailable').length,
    incompleteInstallations: selected.filter(s => s.usage.acquisitionComplete !== true).length,
    metrics,
    cacheReadShare: denominator > 0 ? numerator / denominator : null,
    cacheReadShareEvidence: { numerator, denominator, measuredSessions: cacheSessions.length,
      missingSessions: sessions.length - cacheSessions.length },
    latency: { unit: 's', upperBounds: [...LATENCY_BOUNDS_SECONDS],
      bucketCounts: histograms.length ? LATENCY_BOUNDS_SECONDS.concat(Infinity).map((_, i) => histograms.reduce((n, h) => sum(n, h[i]), 0)) : null,
      measuredSessions: histograms.length, missingSessions: sessions.length - histograms.length },
  };
}

/** Latest-per-installation as-of reduction, not an event ledger or time-series rollup. */
export function aggregateSnapshots(snapshots, { asOf = new Date().toISOString(), staleAfterSeconds = 86400 } = {}) {
  if (!Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) throw new TypeError('Invalid telemetry as-of time');
  if (!Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds < 1 || staleAfterSeconds > 31_536_000) {
    throw new TypeError('Invalid telemetry freshness threshold');
  }
  const selected = latestSnapshots(snapshots, asOf);
  const receipts = selected.flatMap(s => s.maintenance.receipts);
  return {
    schemaVersion: 1, kind: 'agentic-kit.telemetry.aggregate', asOf, staleAfterSeconds,
    selection: { ...selected[0].selection },
    installationCount: selected.length,
    installations: selected.map(s => ({ installationId: s.installationId, snapshotId: s.snapshotId,
      generatedAt: s.generatedAt, producerVersion: s.producerVersion,
      ageSeconds: (Date.parse(asOf) - Date.parse(s.generatedAt)) / 1000,
      stale: Date.parse(asOf) - Date.parse(s.generatedAt) > staleAfterSeconds * 1000,
      usageState: s.usage.state, sourceHealth: { ...s.usage.sourceHealth },
      acquisitionComplete: s.usage.acquisitionComplete, pricesAsOf: s.usage.pricesAsOf,
      inventoryState: s.inventory.state, inventoryCapturedAt: s.inventory.capturedAt,
      inventoryAgeSeconds: s.inventory.capturedAt ? (Date.parse(asOf) - Date.parse(s.inventory.capturedAt)) / 1000 : null,
      maintenanceState: s.maintenance.state })),
    usage: usageTotals(selected),
    inventory: { resources: measure(selected.map(s => s.inventory.resources)), placements: measure(selected.map(s => s.inventory.placements)) },
    maintenance: { availableInstallations: selected.filter(s => s.maintenance.state === 'available').length,
      unavailableInstallations: selected.filter(s => s.maintenance.state === 'unavailable').length,
      retainedReceipts: receipts.length,
      byStatus: Object.fromEntries(RECEIPT_STATES.map(status => [status, receipts.filter(r => r.status === status).length])) },
  };
}
