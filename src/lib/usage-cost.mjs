import { isLocalInferenceProvider } from './usage-local-provider.mjs';

// Price only the missing-cost portion of a coalesced row. Reported zero is
// evidence; missing coverage is an estimate even when that estimate is zero.
//
// A missing-cost portion served by a LOCAL provider is neither: the pricing
// table has no rate for a model that costs nothing per call, and the
// unknown-model fallback would invent one. Those messages are counted as
// `unpricedMessages` — coverage the reader can see — and contribute no dollars.
export function rowCostEvidence(row, rec, deps) {
  const observed = typeof row.costObserved === 'number' && Number.isFinite(row.costObserved) && row.costObserved >= 0;
  const missing = row.costMissingUsage ?? (observed ? null : row);
  const unpriced = !!missing && isLocalInferenceProvider(row.provider);
  const estimatedUsd = missing && !unpriced ? (deps.costOf({
    model: row.model, provider: row.provider ?? rec.provider, day: row.day,
    input: missing.input, output: missing.output,
    cacheRead: missing.cacheRead, cacheWrite: missing.cacheWrite, cacheWrite1h: missing.cacheWrite1h,
  }) || 0) : 0;
  const missingMessages = missing?.responses ?? 0;
  return {
    observedUsd: observed ? row.costObserved : 0,
    estimatedUsd,
    observedMessages: observed ? (row.costObservedMessages ?? row.responses ?? 0) : 0,
    estimatedMessages: unpriced ? 0 : missingMessages,
    unpricedMessages: unpriced ? missingMessages : 0,
  };
}

export function sessionCostEvidence(rec, deps) {
  const total = { observedUsd: 0, estimatedUsd: 0, observedMessages: 0, estimatedMessages: 0, unpricedMessages: 0 };
  for (const row of rec.usage ?? []) {
    const evidence = rowCostEvidence(row, rec, deps);
    for (const key of Object.keys(total)) total[key] += evidence[key];
  }
  total.observedUsd = Math.round(total.observedUsd * 1e6) / 1e6;
  total.estimatedUsd = Math.round(total.estimatedUsd * 1e6) / 1e6;
  return total;
}


export function acquisitionSummary(records, cutoff) {
  const incomplete = records.filter(rec => rec?.acquisitionCoverage?.complete === false
    && (rec.end == null || rec.end >= cutoff));
  return { complete: incomplete.length === 0, omittedSessions: incomplete.length,
    reasons: [...new Set(incomplete.map(rec => rec.acquisitionCoverage.reason))] };
}
