// Read-only projection of existing model inventory. Refresh/CLI/API discovery
// stays exclusively in the model inventory workflow, never dashboard polling.
import { latestSnapshot, readModelStore } from './model-inventory/store.mjs';

const SOURCES = new Set(['anthropic-docs', 'claude-config', 'codex-cache', 'opencode-models']);
const tokenValue = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const safeId = value => typeof value === 'string' && value.length <= 256
  && /^[A-Za-z0-9][A-Za-z0-9._:/+[\]-]*$/.test(value) ? value : null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
export const MAX_CONTEXT_MODELS = 100;

export function readContextModelSnapshot() {
  try { return latestSnapshot(readModelStore()); } catch { return null; }
}

function fieldValue(model, field, snapshot) {
  const [section, key] = field.split('.');
  const value = tokenValue(model[section]?.[key]);
  if (value === null) return null;
  const evidence = (model.evidence || []).find(entry => entry.field === field && SOURCES.has(entry.source)
    && entry.scopeFingerprint === model.key.scopeId && iso(entry.capturedAt)
    && snapshot.sources?.some(source => source.id === entry.source
      && source.scopeFingerprint === entry.scopeFingerprint));
  return evidence ? { value, evidence } : null;
}

function observationFreshness(evidence, now) {
  const capturedAt = evidence.map(entry => entry.capturedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const age = now - Date.parse(capturedAt);
  const freshness = evidence.some(entry => entry.freshness === 'stale') || age > 7 * 86400000
    ? 'stale' : evidence.every(entry => entry.freshness === 'fresh') && age >= -300000 ? 'fresh' : 'unknown';
  return { capturedAt, freshness };
}

/** Keep model capacity separate from configured/session windows. Even a
 * cached configured variant is only a catalog observation in this report. */
export function cachedContextModels(snapshot, host, { now = Date.now() } = {}) {
  if (!snapshot || !iso(snapshot.capturedAt)) return { models: [], omitted: 0 };
  const rows = new Map();
  for (const model of snapshot.models || []) {
    if (model.key?.host !== host || model.visibility === 'hidden' || !safeId(model.key.modelId)
      || model.key.scopeId !== snapshot.scope?.fingerprint) continue;
    const capacity = fieldValue(model, 'capabilities.contextLimit', snapshot)
      ?? fieldValue(model, 'variant.maximumContextWindow', snapshot);
    const input = fieldValue(model, 'capabilities.inputLimit', snapshot);
    const output = fieldValue(model, 'capabilities.outputLimit', snapshot);
    if (!capacity && !input && !output) continue;
    const evidence = [capacity, input, output].filter(Boolean).map(item => item.evidence);
    const { capturedAt, freshness } = observationFreshness(evidence, now);
    const provider = safeId(model.key.provider);
    const row = { model: model.key.modelId, provider, capacityWindow: capacity?.value ?? null,
      inputLimit: input?.value ?? null, outputLimit: output?.value ?? null, basis: 'catalog',
      capturedAt, scopeId: model.key.scopeId, freshness,
      sources: [...new Set(evidence.map(entry => entry.source))] };
    const key = JSON.stringify([row.model, provider, row.scopeId]);
    if (!rows.has(key)) rows.set(key, row);
  }
  const models = [...rows.values()].sort((a, b) => a.model.localeCompare(b.model) || String(a.provider).localeCompare(String(b.provider)));
  return { models: models.slice(0, MAX_CONTEXT_MODELS), omitted: Math.max(0, models.length - MAX_CONTEXT_MODELS) };
}
