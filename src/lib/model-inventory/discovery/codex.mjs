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

export function discoverCodex({
  cacheRaw, configRaw, capturedAt, scope = {}, scopeKey, now = Date.now(), maxAgeMs = 7 * 86_400_000,
} = /** @type {any} */ ({})) {
  let cache;
  let config;
  try { cache = parseCache(cacheRaw); config = parseConfig(configRaw); } catch (error) {
    const source = sourceRecord({ id: 'codex-cache', owner: 'codex', scope, scopeKey, capturedAt, complete: false, status: 'unsupported-schema', schema: 'codex-model-cache-v1', diagnostics: ['unsupported-schema'] });
    return { status: 'unsupported-schema', source, models: [], diagnostics: [diagnostic('unsupported-schema', error.message)] };
  }
  if (!Array.isArray(cache.models)) {
    const source = sourceRecord({ id: 'codex-cache', owner: 'codex', scope, scopeKey, capturedAt, complete: false, status: 'unsupported-schema', schema: 'codex-model-cache-v1', diagnostics: ['unsupported-schema'] });
    return { status: 'unsupported-schema', source, models: [], diagnostics: [diagnostic('unsupported-schema', 'models must be an array')] };
  }
  const fetchedAt = Date.parse(cache.fetched_at ?? cache.fetchedAt ?? '');
  const stale = Number.isFinite(fetchedAt) && now - fetchedAt > maxAgeMs;
  let complete = cache.models.length <= MAX_MODELS;
  const source = sourceRecord({
    id: 'codex-cache', owner: 'codex', scope, scopeKey, capturedAt: capturedAt ?? (Number.isFinite(fetchedAt) ? new Date(fetchedAt).toISOString() : undefined),
    complete, schema: `codex-model-cache-v1${bounded(cache.client_version, 32) ? `@${cache.client_version}` : ''}`,
    freshness: stale ? 'stale' : 'current',
  });
  const diagnostics = [];
  const models = [];
  for (const [index, raw] of cache.models.slice(0, MAX_MODELS).entries()) {
    const modelId = bounded(raw?.slug ?? raw?.id);
    const visibility = raw?.visibility ?? 'list';
    if (!modelId || !VISIBILITY.has(visibility)) {
      complete = false;
      diagnostics.push(diagnostic('invalid-model-schema', `models[${index}] is invalid`));
      continue;
    }
    const reasoningEfforts = (Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : [])
      .map((entry) => typeof entry === 'string' ? entry : entry?.effort)
      .filter((effort) => REASONING.has(effort));
    const replacementId = bounded(raw.upgrade?.model ?? raw.upgrade?.model_id);
    models.push(modelRecord({
      host: 'codex', provider: null, modelId, scopeId: source.scopeId,
      displayName: bounded(raw.display_name) ?? modelId, source,
      variant: {
        reasoningEfforts: [...new Set(reasoningEfforts)],
        contextWindow: Number.isInteger(raw.context_window) && raw.context_window > 0 ? raw.context_window : null,
      },
      lifecycle: replacementId
        ? { state: 'retiring', replacement: { modelId: replacementId, edge: 'first-party-migration' } }
        : { state: visibility === 'hide' || visibility === 'hidden' ? 'hidden' : 'active', replacement: null },
      states: {
        configured: config.model === modelId ? true : 'unknown',
        effective: config.model === modelId ? true : 'unknown',
        discoverable: visibility === 'list' || visibility === 'visible', entitled: 'unknown',
      },
    }));
  }
  if (bounded(config.model) && !models.some((model) => model.identity.modelId === config.model)) {
    models.push(modelRecord({
      host: 'codex', provider: bounded(config.model_provider), modelId: config.model,
      scopeId: source.scopeId, source,
      variant: { reasoningEffort: REASONING.has(config.model_reasoning_effort) ? config.model_reasoning_effort : null },
      states: { configured: true, effective: true, discoverable: 'unknown', entitled: 'unknown' },
    }));
  }
  if (cache.models.length > MAX_MODELS) diagnostics.push(diagnostic('model-cap', `models exceeds ${MAX_MODELS}`));
  source.complete = complete;
  source.status = complete ? (stale ? 'stale' : 'complete') : 'partial';
  source.diagnostics = diagnostics.map(({ code }) => code);
  for (const model of models) model.evidence[0].completeness = complete ? 'complete' : 'partial';
  return { status: complete ? (stale ? 'stale' : 'complete') : 'partial', source, models, diagnostics };
}
