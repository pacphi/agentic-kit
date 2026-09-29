import { isLocalInferenceProvider } from './usage-local-provider.mjs';

const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const MODEL_LIMIT = 32;
const MODEL_KEY_LIMIT = 100;
// Only a plausible epoch-millisecond value may be compared with transcript ISO
// timestamps. Other numeric units remain malformed diagnostics, not time proof.
const epochMs = (value) => count(value)
  && value >= Date.UTC(2020, 0, 1) && value < Date.UTC(2100, 0, 1);

function checkpointModels(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models)
    || Object.keys(models).length > MODEL_LIMIT) return null;
  const parsed = Object.create(null);
  for (const [model, usage] of Object.entries(models)) {
    if (model.length > MODEL_KEY_LIMIT || !/^[A-Za-z0-9._:/-]+$/u.test(model)
      || !usage || typeof usage !== 'object' || Array.isArray(usage)
      || !['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']
        .every((key) => count(usage[key]))
      || (usage.webSearchRequests !== undefined && !count(usage.webSearchRequests))
      || (usage.costUSD !== undefined && !amount(usage.costUSD))) return null;
    parsed[model] = {
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheCreationInputTokens,
      webSearchRequests: usage.webSearchRequests ?? null,
    };
  }
  return parsed;
}

/** A cost-state line is a cumulative Claude Code checkpoint, never a message charge. */
export function recordClaudeCostState(previous, record, sessionId) {
  const state = previous ?? {
    reportedUsd: null, currency: 'USD', provenance: 'claude-code-cost-state',
    coverage: 'unknown', validSnapshots: 0, malformedSnapshots: 0, unsupportedSnapshots: 0,
    modelUsage: null, hasUnknownModelCost: null, startMs: null, endMs: null,
  };
  if (!Object.hasOwn(record, 'totalCostUSD')) {
    state.unsupportedSnapshots++;
    return state;
  }
  if (typeof record.sessionId === 'string' && record.sessionId !== sessionId) {
    state.unsupportedSnapshots++;
    return state;
  }
  const parsed = checkpointModels(record.modelUsage);
  if (!amount(record.totalCostUSD) || typeof record.sessionId !== 'string'
    || !epochMs(record.startTime) || !parsed
    || (record.hasUnknownModelCost !== undefined && typeof record.hasUnknownModelCost !== 'boolean')) {
    state.malformedSnapshots++;
    return state;
  }
  state.validSnapshots++;
  state.reportedUsd = record.totalCostUSD;
  state.coverage = 'session-cumulative';
  state.modelUsage = parsed;
  state.hasUnknownModelCost = record.hasUnknownModelCost ?? null;
  state.startMs = record.startTime;
  // Observed cost-state records carry no checkpoint-end timestamp.
  state.endMs = null;
  return state;
}

function messageModelTotals(rec) {
  const rows = Object.create(null);
  for (const row of rec.usage ?? []) {
    const summed = rows[row.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) summed[key] += row[key];
    rows[row.model] = summed;
  }
  return rows;
}

function differentModelTotals(observed, rows) {
  return !Object.keys(rows).length || Object.keys(rows).length !== Object.keys(observed).length
    || Object.entries(observed).some(([model, item]) => !rows[model]
      || ['input', 'output', 'cacheRead', 'cacheWrite'].some((key) => rows[model][key] !== item[key]));
}

function servingProviderReason(rec) {
  if (rec.sessionOrigin?.thirdPartyProvider) return 'serving-provider-different';
  if (rec.providerProvenance !== 'observed' || !rec.inferenceProvider) return 'serving-provider-unverified';
  return rec.inferenceProvider === 'anthropic' ? null : 'serving-provider-different';
}

/** Report provable scope differences without treating equal totals as scope proof. */
export function reconcileClaudeCostState(rec) {
  const state = rec.claudeCostState;
  if (!state) return null;
  const base = {
    reportedUsd: state.reportedUsd, currency: state.currency, provenance: state.provenance,
    coverage: state.coverage, validSnapshots: state.validSnapshots,
    malformedSnapshots: state.malformedSnapshots, unsupportedSnapshots: state.unsupportedSnapshots,
    checkpointStartMs: state.startMs ?? null, checkpointEndMs: state.endMs ?? null,
    messageFirstAtMs: rec.claudeMessageCoverage?.firstAtMs ?? null,
    messageLastAtMs: rec.claudeMessageCoverage?.lastAtMs ?? null,
    missingMessageTimestamps: rec.claudeMessageCoverage?.missingTimestampMessages ?? 0,
  };
  if (state.reportedUsd === null || state.coverage !== 'session-cumulative' || !state.modelUsage) {
    return { ...base, status: 'scope-unknown', estimatedUsd: null, scopeReasons: ['valid-checkpoint-unavailable'] };
  }
  const messages = rec.claudeMessageCoverage;
  if (messages?.firstAtMs !== null && messages?.firstAtMs !== undefined
    && state.startMs > messages.firstAtMs) {
    return { ...base, status: 'scope-mismatch', estimatedUsd: null,
      scopeReasons: ['checkpoint-start-after-message'] };
  }
  const observed = state.modelUsage;
  if (differentModelTotals(observed, messageModelTotals(rec))) {
    return { ...base, status: 'scope-mismatch', estimatedUsd: null,
      scopeReasons: ['model-token-totals-differ'] };
  }
  // Equal counters cannot prove an equal interval or serving provider. The
  // observed checkpoint has no end timestamp, and Claude transcript model IDs
  // do not attest which provider served a completion.
  return { ...base, status: 'scope-unknown', estimatedUsd: null,
    scopeReasons: [
      'checkpoint-end-unreported',
      messages?.missingTimestampMessages || messages?.firstAtMs === null ? 'message-time-incomplete' : null,
      servingProviderReason(rec),
      state.hasUnknownModelCost !== false ? 'model-cost-unknown' : null,
      Object.values(observed).some((item) => item.webSearchRequests !== 0) ? 'auxiliary-cost-scope-unknown' : null,
    ].filter(Boolean) };
}

// Price only the missing-cost portion of a coalesced row. OpenCode's
// positive-token reported zero can mean an absent model rate; those responses
// are explicitly unpriced. Missing coverage is an estimate even when zero.
//
// A missing-cost portion served by a LOCAL provider is neither: the pricing
// table has no rate for a model that costs nothing per call, and the
// unknown-model fallback would invent one. Those messages are counted as
// `unpricedMessages` — coverage the reader can see — and contribute no dollars.
export function rowCostEvidence(row, rec, deps) {
  const observed = typeof row.costObserved === 'number' && Number.isFinite(row.costObserved) && row.costObserved >= 0;
  const untrustedMessages = row.costUntrustedMessages ?? 0;
  const missing = row.costMissingUsage ?? (observed || untrustedMessages ? null : row);
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
    unpricedMessages: (unpriced ? missingMessages : 0) + untrustedMessages,
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
