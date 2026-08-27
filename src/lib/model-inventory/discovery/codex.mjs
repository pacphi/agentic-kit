import {
  MAX_COMMAND_BYTES, MAX_MODELS, diagnostic, modelRecord, sourceRecord,
} from './index.mjs';

const VISIBILITY = new Set(['list', 'visible', 'hide', 'hidden']);
const REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const bounded = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

function parseCache(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return structuredClone(raw);
  const text = String(raw ?? '');
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) throw new TypeError('cache-too-large');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new TypeError('cache-invalid-json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('cache-schema');
  return parsed;
}

function parseConfig(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  const text = String(raw);
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) throw new TypeError('config-too-large');
  const result = {};
  let topLevel = true;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/\s+#.*$/, '').trim();
    if (!clean) continue;
    if (/^\[/.test(clean)) { topLevel = false; continue; }
    if (!topLevel) continue;
    const match = clean.match(/^(model|model_provider|model_reasoning_effort)\s*=\s*["']([^"']{1,256})["']\s*$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function codexUnsupportedSchemaResult(scopeCtx, message) {
  const source = sourceRecord({
    ...scopeCtx, id: 'codex-cache', owner: 'codex', complete: false,
    status: 'unsupported-schema', schema: 'codex-model-cache-v1', diagnostics: ['unsupported-schema'],
  });
  return { status: 'unsupported-schema', source, models: [], diagnostics: [diagnostic('unsupported-schema', message)] };
}

function codexReasoningEfforts(raw) {
  const levels = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : [];
  const efforts = levels.map((entry) => (typeof entry === 'string' ? entry : entry?.effort))
    .filter((effort) => REASONING.has(effort));
  return [...new Set(efforts)];
}

function codexModelStates(config, modelId, visibility) {
  return {
    configured: config.model === modelId ? true : 'unknown',
    effective: config.model === modelId ? true : 'unknown',
    discoverable: visibility === 'list' || visibility === 'visible', entitled: 'unknown',
  };
}

function codexModelFromCacheEntry(raw, index, config, source) {
  const modelId = bounded(raw?.slug ?? raw?.id);
  const visibility = raw?.visibility ?? 'list';
  if (!modelId || !VISIBILITY.has(visibility)) {
    return { diagnostic: diagnostic('invalid-model-schema', `models[${index}] is invalid`) };
  }
  return {
    model: modelRecord({
      host: 'codex', provider: null, modelId, scopeId: source.scopeId,
      displayName: bounded(raw.display_name) ?? modelId, source,
      variant: {
        reasoningEfforts: codexReasoningEfforts(raw),
        contextWindow: Number.isInteger(raw.context_window) && raw.context_window > 0 ? raw.context_window : null,
      },
      // `upgrade` is a local client hint, not a public retirement notice. It
      // must never promote a target model into a lifecycle warning or cause a
      // route to be treated as retired. A warning needs an explicit first-party
      // notice URL captured by a source that can establish that fact.
      lifecycle: { state: visibility === 'hide' || visibility === 'hidden' ? 'hidden' : 'active', replacement: null },
      states: codexModelStates(config, modelId, visibility),
    }),
  };
}

function codexModelsFromCache(cacheModels, config, source) {
  const models = [];
  const diagnostics = [];
  let complete = true;
  for (const [index, raw] of cacheModels.slice(0, MAX_MODELS).entries()) {
    const { model, diagnostic: rowDiagnostic } = codexModelFromCacheEntry(raw, index, config, source);
    if (model) models.push(model);
    if (rowDiagnostic) { complete = false; diagnostics.push(rowDiagnostic); }
  }
  return { models, diagnostics, complete };
}

function codexOverallStatus(complete, stale) {
  return complete ? (stale ? 'stale' : 'complete') : 'partial';
}

function codexConfiguredFallbackModel(config, source) {
  if (!bounded(config.model)) return null;
  return modelRecord({
    host: 'codex', provider: bounded(config.model_provider), modelId: config.model,
    scopeId: source.scopeId, source,
    variant: { reasoningEffort: REASONING.has(config.model_reasoning_effort) ? config.model_reasoning_effort : null },
    states: { configured: true, effective: true, discoverable: 'unknown', entitled: 'unknown' },
  });
}

export function discoverCodex({
  cacheRaw, configRaw, capturedAt, scope = {}, scopeKey, now = Date.now(), maxAgeMs = 7 * 86_400_000,
} = /** @type {any} */ ({})) {
  const scopeCtx = { scope, scopeKey, capturedAt };
  let cache;
  let config;
  try { cache = parseCache(cacheRaw); config = parseConfig(configRaw); } catch (error) {
    return codexUnsupportedSchemaResult(scopeCtx, error.message);
  }
  if (!Array.isArray(cache.models)) return codexUnsupportedSchemaResult(scopeCtx, 'models must be an array');
  const fetchedAt = Date.parse(cache.fetched_at ?? cache.fetchedAt ?? '');
  const stale = Number.isFinite(fetchedAt) && now - fetchedAt > maxAgeMs;
  const source = sourceRecord({
    id: 'codex-cache', owner: 'codex', scope, scopeKey,
    capturedAt: capturedAt ?? (Number.isFinite(fetchedAt) ? new Date(fetchedAt).toISOString() : undefined),
    complete: cache.models.length <= MAX_MODELS,
    schema: `codex-model-cache-v1${bounded(cache.client_version, 32) ? `@${cache.client_version}` : ''}`,
    freshness: stale ? 'stale' : 'current',
  });
  const { models, diagnostics, complete: rowsComplete } = codexModelsFromCache(cache.models, config, source);
  const complete = cache.models.length <= MAX_MODELS && rowsComplete;
  const fallback = codexConfiguredFallbackModel(config, source);
  if (fallback && !models.some((model) => model.identity.modelId === fallback.identity.modelId)) {
    models.push(fallback);
  }
  if (cache.models.length > MAX_MODELS) diagnostics.push(diagnostic('model-cap', `models exceeds ${MAX_MODELS}`));
  source.complete = complete;
  source.status = codexOverallStatus(complete, stale);
  source.diagnostics = diagnostics.map(({ code }) => code);
  for (const model of models) model.evidence[0].completeness = complete ? 'complete' : 'partial';
  return {
    status: codexOverallStatus(complete, stale), source, models, diagnostics,
  };
}
