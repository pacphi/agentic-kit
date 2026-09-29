import { isLocalInferenceProvider } from './usage-local-provider.mjs';
import { priceFor } from './pricing.mjs';

const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const MODEL_LIMIT = 32;

/** A cost-state line is a cumulative Claude Code checkpoint, never a message charge. */
export function recordClaudeCostState(previous, record, sessionId) {
  const state = previous ?? {
    reportedUsd: null, currency: 'USD', provenance: 'claude-code-cost-state',
    coverage: 'unknown', validSnapshots: 0, malformedSnapshots: 0, unsupportedSnapshots: 0,
    modelUsage: null, hasUnknownModelCost: null,
  };
  if (!Object.hasOwn(record, 'totalCostUSD')) {
    state.unsupportedSnapshots++;
    return state;
  }
  if (typeof record.sessionId === 'string' && record.sessionId !== sessionId) {
    state.unsupportedSnapshots++;
    return state;
  }
  const models = record.modelUsage;
  if (!amount(record.totalCostUSD) || typeof record.sessionId !== 'string'
    || !models || typeof models !== 'object' || Array.isArray(models)
    || Object.keys(models).length > MODEL_LIMIT
    || (record.hasUnknownModelCost !== undefined && typeof record.hasUnknownModelCost !== 'boolean')) {
    state.malformedSnapshots++;
    return state;
  }
  const parsed = Object.create(null);
  for (const [model, usage] of Object.entries(models)) {
    if (!/^[A-Za-z0-9._:/-]+$/u.test(model) || !usage || typeof usage !== 'object' || Array.isArray(usage)
      || !['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']
        .every((key) => count(usage[key]))
      || (usage.webSearchRequests !== undefined && !count(usage.webSearchRequests))
      || (usage.costUSD !== undefined && !amount(usage.costUSD))) {
      state.malformedSnapshots++;
      return state;
    }
    parsed[model] = {
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheCreationInputTokens,
      webSearchRequests: usage.webSearchRequests ?? null,
    };
  }
  state.validSnapshots++;
  state.reportedUsd = record.totalCostUSD;
  state.coverage = 'session-cumulative';
  state.modelUsage = parsed;
  state.hasUnknownModelCost = record.hasUnknownModelCost ?? null;
  return state;
}

/** Compare only identical token/model populations; the reported sum never enters cost totals. */
export function reconcileClaudeCostState(rec, deps) {
  const state = rec.claudeCostState;
  if (!state) return null;
  const base = {
    reportedUsd: state.reportedUsd, currency: state.currency, provenance: state.provenance,
    coverage: state.coverage, validSnapshots: state.validSnapshots,
    malformedSnapshots: state.malformedSnapshots, unsupportedSnapshots: state.unsupportedSnapshots,
  };
  if (state.reportedUsd === null || state.coverage !== 'session-cumulative'
    || rec.sessionOrigin?.thirdPartyProvider
    || state.hasUnknownModelCost !== false || !state.modelUsage) {
    return { ...base, status: 'scope-unknown', estimatedUsd: null };
  }
  const observed = state.modelUsage;
  const rows = Object.create(null);
  for (const row of rec.usage ?? []) {
    const price = priceFor(row.model, row.provider ?? rec.inferenceProvider, row.day);
    if (price.provider !== 'anthropic' || !price.matched) {
      return { ...base, status: 'scope-unknown', estimatedUsd: null };
    }
    const summed = rows[row.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) summed[key] += row[key];
    rows[row.model] = summed;
  }
  if (!Object.keys(rows).length || Object.keys(rows).length !== Object.keys(observed).length
    || Object.entries(observed).some(([model, item]) => !rows[model]
      || item.webSearchRequests !== 0
      || ['input', 'output', 'cacheRead', 'cacheWrite'].some((key) => rows[model][key] !== item[key]))) {
    return { ...base, status: 'scope-mismatch', estimatedUsd: null };
  }
  const estimatedUsd = sessionCostEvidence(rec, deps).estimatedUsd;
  return { ...base, status: Math.abs(state.reportedUsd - estimatedUsd) <= 1e-6 ? 'matched' : 'mismatch', estimatedUsd };
}

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
  const unpriced = !!missing && (isLocalInferenceProvider(row.provider) || row.model === 'codex-auto-review');
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
