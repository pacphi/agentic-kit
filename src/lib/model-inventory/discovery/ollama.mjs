import { run } from '../../exec.mjs';
import {
  MAX_COMMAND_BYTES, MAX_MODELS, diagnostic, modelRecord, sourceRecord,
} from './index.mjs';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/;
const DIGEST = /^(?:sha256:)?[a-f0-9]{6,128}$/i;
const MAX_SHOW_MODELS = 128;
const SHOW_CONCURRENCY = 8;
const TEXT_LIMIT = 256;
const CAPABILITIES = new Set(['completion', 'tools', 'thinking', 'vision', 'embedding']);

function text(value, max = TEXT_LIMIT) {
  if (typeof value !== 'string') return null;
  const bounded = value.trim().slice(0, max);
  return bounded && ![...bounded].some((char) => char.codePointAt(0) < 32) ? bounded : null;
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function iso(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function json(value, name) {
  if (value && typeof value === 'object') return value;
  const raw = String(value ?? '');
  if (Buffer.byteLength(raw) > MAX_COMMAND_BYTES) throw new TypeError(`${name}-too-large`);
  try { return JSON.parse(raw); } catch { throw new TypeError(`${name}-invalid`); }
}

function contextWindow(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  for (const [key, value] of Object.entries(info)) {
    if (/(?:^|\.)context_length$/.test(key) && positive(value) != null) return value;
  }
  return null;
}

function licenseSummary(value) {
  if (typeof value !== 'string') return null;
  return text(value.split(/\r?\n/).map((line) => line.trim()).find(Boolean), 160);
}

function runtimeByName(value) {
  const rows = Array.isArray(value?.models) ? value.models : [];
  return new Map(rows.flatMap((row) => {
    const name = text(row?.name ?? row?.model);
    return name && TOKEN.test(name) ? [[name, row]] : [];
  }));
}

/** Normalize bounded /api/tags, /api/show and /api/ps responses. */
export function discoverOllamaApi({
  tagsRaw, psRaw = { models: [] }, showByModel = {}, capturedAt, scope = {}, scopeKey,
} = /** @type {any} */ ({})) {
  const source = sourceRecord({
    id: 'ollama-catalog', owner: 'ollama', ownerType: 'provider', transport: 'http', network: 'local',
    scope, scopeKey, capturedAt, complete: true, schema: 'ollama-api-v1',
  });
  const diagnostics = [];
  let tags;
  let runtime;
  try { tags = json(tagsRaw, 'tags'); } catch (error) {
    source.complete = false; source.status = 'unsupported'; source.diagnostics = [error.message];
    return { status: 'unsupported', source, models: [], diagnostics: [diagnostic(error.message, 'Ollama tags response is invalid')] };
  }
  try { runtime = runtimeByName(json(psRaw, 'ps')); } catch (error) {
    runtime = new Map(); diagnostics.push(diagnostic(error.message, 'Ollama runtime response is invalid'));
  }
  const rows = Array.isArray(tags?.models) ? tags.models : null;
  if (!rows) {
    source.complete = false; source.status = 'unsupported-schema'; source.diagnostics = ['tags-schema-unsupported'];
    return { status: 'unsupported', source, models: [], diagnostics: [diagnostic('tags-schema-unsupported', 'Ollama tags response has no models array')] };
  }
  const models = [];
  for (const [index, row] of rows.entries()) {
    if (models.length >= MAX_MODELS) break;
    const modelId = text(row?.name ?? row?.model);
    const digest = text(row?.digest);
    if (!modelId || !TOKEN.test(modelId) || !digest || !DIGEST.test(digest)) {
      diagnostics.push(diagnostic('invalid-model-row', `Ollama tags row ${index + 1} is invalid`));
      continue;
    }
    const loaded = runtime.get(modelId) ?? null;
    let shown = showByModel instanceof Map ? showByModel.get(modelId) : showByModel?.[modelId];
    try { shown = shown == null ? {} : json(shown, 'show'); } catch (error) {
      shown = {}; diagnostics.push(diagnostic(error.message, `Ollama show response for row ${index + 1} is invalid`));
    }
    const details = row.details && typeof row.details === 'object' ? row.details : {};
    const showDetails = shown.details && typeof shown.details === 'object' ? shown.details : {};
    const families = Array.isArray(details.families) ? details.families.map((item) => text(item, 64)).filter(Boolean).slice(0, 16) : [];
    const advertised = Array.isArray(shown.capabilities)
      ? [...new Set(shown.capabilities.map((item) => text(item, 64)).filter((item) => CAPABILITIES.has(item)))] : [];
    const context = positive(loaded?.context_length) ?? contextWindow(shown.model_info);
    const variant = {
      digest,
      ...(positive(row.size) != null ? { sizeBytes: row.size } : {}),
      ...(iso(row.modified_at) ? { modifiedAt: iso(row.modified_at) } : {}),
      ...(text(details.format, 64) ? { format: text(details.format, 64) } : {}),
      ...(text(details.family ?? showDetails.family, 64) ? { family: text(details.family ?? showDetails.family, 64) } : {}),
      ...(families.length ? { families } : {}),
      ...(text(details.parameter_size ?? showDetails.parameter_size, 64) ? { parameterSize: text(details.parameter_size ?? showDetails.parameter_size, 64) } : {}),
      ...(text(details.quantization_level ?? showDetails.quantization_level, 64) ? { quantizationLevel: text(details.quantization_level ?? showDetails.quantization_level, 64) } : {}),
      loaded: Boolean(loaded),
      ...(positive(loaded?.size) != null ? { memoryBytes: loaded.size } : {}),
      ...(positive(loaded?.size_vram) != null ? { vramBytes: loaded.size_vram } : {}),
      ...(iso(loaded?.expires_at) ? { expiresAt: iso(loaded.expires_at) } : {}),
      ...(context != null ? { contextWindow: context } : {}),
      ...(licenseSummary(shown.license) ? { licenseSummary: licenseSummary(shown.license) } : {}),
      ...(advertised.length ? { advertisedCapabilities: advertised } : {}),
    };
    const capabilities = {
      ...(context != null ? { contextLimit: context } : {}),
      ...(advertised.includes('tools') ? { toolcall: true } : {}),
      ...(advertised.includes('thinking') ? { reasoning: true } : {}),
      ...(advertised.includes('vision') ? { input: { text: true, image: true } } : {}),
      ...(advertised.includes('embedding') ? { embedding: true } : {}),
    };
    const record = modelRecord({
      host: 'ollama', provider: 'ollama', modelId, scopeId: source.scopeId, source,
      displayName: modelId, digest, variant, capabilities,
      pricing: { basis: 'local-compute', input: 0, output: 0, currency: 'USD', effectiveAt: null },
      states: { discoverable: true },
    });
    for (const evidence of record.evidence) {
      if (/^variant\.(?:loaded|memoryBytes|vramBytes|expiresAt|contextWindow)$/.test(evidence.field)) evidence.class = 'runtime';
    }
    models.push(record);
  }
  if (rows.length > MAX_MODELS) diagnostics.push(diagnostic('models-truncated', `Ollama returned more than ${MAX_MODELS} models`));
  const complete = diagnostics.length === 0 && rows.length <= MAX_MODELS;
  source.complete = complete; source.status = complete ? 'complete' : 'partial';
  source.diagnostics = diagnostics.map(({ code }) => code);
  return { status: source.status, source, models, diagnostics };
}

/** Retained parser for bounded CLI-cache compatibility when an injected legacy fixture is supplied. */
export function discoverOllama({ raw, capturedAt, scope = {}, scopeKey } = /** @type {any} */ ({})) {
  const value = String(raw ?? '');
  const source = sourceRecord({ id: 'ollama-catalog', owner: 'ollama', scope, scopeKey, capturedAt, complete: true, schema: 'ollama-ls-v1' });
  if (Buffer.byteLength(value) > MAX_COMMAND_BYTES) {
    source.complete = false; source.status = 'unsupported'; source.diagnostics = ['output-too-large'];
    return { status: 'unsupported', source, models: [], diagnostics: [diagnostic('output-too-large', `output exceeds ${MAX_COMMAND_BYTES}`)] };
  }
  const diagnostics = [];
  const models = [];
  const lines = value.split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    if (index === 0 && /^NAME\s+ID\s+/i.test(line)) continue;
    const [modelId, digest] = line.trim().split(/\s+/);
    if (!TOKEN.test(modelId ?? '') || !DIGEST.test(digest ?? '')) {
      diagnostics.push(diagnostic('invalid-model-row', `line ${index + 1} is invalid`));
      continue;
    }
    if (models.length >= MAX_MODELS) break;
    models.push(modelRecord({
      host: 'ollama', provider: 'ollama', modelId, scopeId: source.scopeId, source,
      digest, variant: { digest }, states: { discoverable: true },
      pricing: { basis: 'local-compute', input: 0, output: 0, currency: 'USD', effectiveAt: null },
    }));
  }
  const complete = diagnostics.length === 0 && models.length < MAX_MODELS;
  source.complete = complete; source.status = complete ? 'complete' : 'partial';
  source.diagnostics = diagnostics.map(({ code }) => code);
  return { status: source.status, source, models, diagnostics };
}

function localBase(value) {
  const url = new URL(value ?? 'http://127.0.0.1:11434');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new TypeError('Ollama endpoint must be loopback HTTP');
  }
  return url;
}

async function fetchJson(fetchFn, url, options, timeout) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  try {
    const response = await fetchFn(url, { ...options, signal: controller.signal });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'failure'}`);
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_COMMAND_BYTES) throw new Error('response-too-large');
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_COMMAND_BYTES) throw new Error('response-too-large');
    return JSON.parse(Buffer.from(body).toString('utf8'));
  } catch (error) {
    if (timedOut) throw new Error('refresh-timeout', { cause: error });
    throw error;
  } finally { clearTimeout(timer); }
}

export async function collectOllama({
  fetchFn = globalThis.fetch, baseUrl, runner = run, capturedAt, scope = {}, scopeKey, timeout = 15_000,
} = /** @type {any} */ ({})) {
  const budget = Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000;
  const deadline = Date.now() + budget;
  const remaining = () => Math.max(0, deadline - Date.now());
  const readApi = (pathname, options, cap = Infinity) => {
    const left = remaining();
    if (left <= 0) throw new Error('refresh-timeout');
    return fetchJson(fetchFn, new URL(pathname, base), options, Math.max(1, Math.min(left, cap)));
  };
  let base;
  try { base = localBase(baseUrl); } catch (error) {
    const source = sourceRecord({ id: 'ollama-catalog', owner: 'ollama', scope, scopeKey, capturedAt, complete: false, status: 'unsupported', schema: 'ollama-api-v1', diagnostics: ['unsafe-endpoint'] });
    return { status: 'unsupported', source, models: [], diagnostics: [diagnostic('unsafe-endpoint', error.message)] };
  }
  try {
    const tags = await readApi('/api/tags', { method: 'GET' });
    let ps = { models: [] };
    const diagnostics = [];
    try { ps = await readApi('/api/ps', { method: 'GET' }); }
    catch (error) { diagnostics.push(diagnostic('runtime-unavailable', error.message)); }
    const rows = Array.isArray(tags?.models) ? tags.models.slice(0, MAX_SHOW_MODELS) : [];
    const showByModel = {};
    let cursor = 0;
    const readShow = async () => {
      while (cursor < rows.length && remaining() > 0) {
        const row = rows[cursor++];
        const name = text(row?.name ?? row?.model);
        if (!name || !TOKEN.test(name)) continue;
        try {
          showByModel[name] = await readApi('/api/show', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }),
          }, 3_000);
        } catch (error) { diagnostics.push(diagnostic('show-unavailable', `${name}: ${error.message}`)); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, rows.length) }, readShow));
    if (cursor < rows.length) diagnostics.push(diagnostic('show-timeout', 'Ollama detail collection exhausted the refresh time budget'));
    const result = discoverOllamaApi({ tagsRaw: tags, psRaw: ps, showByModel, capturedAt, scope, scopeKey });
    if (tags.models?.length > MAX_SHOW_MODELS) diagnostics.push(diagnostic('show-truncated', `details limited to ${MAX_SHOW_MODELS} models`));
    if (!diagnostics.length) return result;
    result.diagnostics.push(...diagnostics);
    result.source.diagnostics.push(...diagnostics.map(({ code }) => code));
    result.source.complete = false; result.source.status = 'partial'; result.status = 'partial';
    return result;
  } catch (apiError) {
    // Compatibility fallback keeps installed names visible when an older daemon exposes
    // only the CLI. It is deliberately partial because runtime facts were not checked.
    const fallbackTimeout = remaining();
    if (apiError.message === 'refresh-timeout' || fallbackTimeout <= 0) {
      const source = sourceRecord({ id: 'ollama-catalog', owner: 'ollama', scope, scopeKey, capturedAt,
        complete: false, status: 'unsupported', schema: 'ollama-api-v1', diagnostics: ['refresh-timeout'] });
      return { status: 'unsupported', source, models: [], diagnostics: [diagnostic('refresh-timeout', 'Ollama refresh exhausted its time budget')] };
    }
    const result = await runner('ollama', ['ls'], { timeout: fallbackTimeout, maxBuffer: MAX_COMMAND_BYTES, shell: false });
    if (result.code === 0) {
      const fallback = discoverOllama({ raw: result.stdout, capturedAt, scope, scopeKey });
      if (fallback.status === 'complete') {
        fallback.status = 'partial'; fallback.source.status = 'partial'; fallback.source.complete = false;
      }
      fallback.source.diagnostics.push('api-unavailable');
      fallback.diagnostics.push(diagnostic('api-unavailable', apiError.message));
      return fallback;
    }
    const source = sourceRecord({ id: 'ollama-catalog', owner: 'ollama', scope, scopeKey, capturedAt, complete: false, status: 'unavailable', schema: 'ollama-api-v1', diagnostics: ['api-unavailable', 'command-failed'] });
    return { status: 'unavailable', source, models: [], diagnostics: [diagnostic('api-unavailable', apiError.message), diagnostic('command-failed', result.stderr || 'ollama list failed')] };
  }
}
