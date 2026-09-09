// Price only the missing-cost portion of a coalesced row. Reported zero is
// evidence; missing coverage is an estimate even when that estimate is zero.
export function rowCostEvidence(row, rec, deps) {
  const observed = typeof row.costObserved === 'number' && Number.isFinite(row.costObserved) && row.costObserved >= 0;
  const missing = row.costMissingUsage ?? (observed ? null : row);
  const estimatedUsd = missing ? (deps.costOf({
    model: row.model, provider: rec.provider, day: row.day,
    input: missing.input, output: missing.output,
    cacheRead: missing.cacheRead, cacheWrite: missing.cacheWrite,
  }) || 0) : 0;
  return {
    observedUsd: observed ? row.costObserved : 0,
    estimatedUsd,
    observedMessages: observed ? (row.costObservedMessages ?? row.responses ?? 0) : 0,
    estimatedMessages: missing?.responses ?? 0,
  };
}

export function sessionCostEvidence(rec, deps) {
  const total = { observedUsd: 0, estimatedUsd: 0, observedMessages: 0, estimatedMessages: 0 };
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
