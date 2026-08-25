import { run } from '../../exec.mjs';
import {
  MAX_COMMAND_BYTES, MAX_MODELS, diagnostic, modelRecord, sourceRecord,
} from './index.mjs';

const VARIANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CATALOG_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CATALOG_STATUSES = new Set(['active', 'alpha', 'beta', 'deprecated']);
const MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'];
const MAX_DIAGNOSTICS = 64;
const MAX_OUTPUT_LINES = 8_192;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MODELS_DEV_URL = 'https://models.dev/api.json';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function boundedText(value, max = 256) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const hasControl = [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  return text && text.length <= max && !hasControl ? text : null;
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function releaseDate(value) {
  const text = boundedText(value, 10);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== text ? null : text;
}

function selectorParts(value) {
  const selector = boundedText(value, 576);
  if (!selector || selector.includes('#')) return null;
  const slash = selector.indexOf('/');
  if (slash < 1 || slash > 256 || slash === selector.length - 1) return null;
  const provider = selector.slice(0, slash);
  const modelId = selector.slice(slash + 1);
  if (provider.includes('/') || modelId.length > 512) return null;
  return { selector, provider, modelId };
}

function catalogDocument(raw) {
  if (raw == null || raw === '') return null;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) return null;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
    return plain(value) ? value : null;
  } catch { return null; }
}

function catalogEntry(catalog, provider, modelId) {
  const providerEntry = plain(catalog?.[provider]) ? catalog[provider] : null;
  const entry = plain(providerEntry?.models?.[modelId]) ? providerEntry.models[modelId] : null;
  return providerEntry?.id === provider && entry?.id === modelId ? entry : null;
}

function addDiagnostic(diagnostics, item) {
  if (diagnostics.length < MAX_DIAGNOSTICS - 1) diagnostics.push(item);
  else if (!diagnostics.some(({ code }) => code === 'diagnostics-truncated')) {
    diagnostics.push(diagnostic('diagnostics-truncated', 'additional diagnostics were omitted'));
  }
}

function safeModalities(value) {
  if (!plain(value)) return null;
  const result = {};
  for (const name of MODALITIES) {
    if (typeof value[name] === 'boolean') result[name] = value[name];
  }
  return Object.keys(result).length ? result : null;
}

function safeCapabilities(value, limit) {
  const result = {};
  if (plain(value)) {
    for (const name of ['temperature', 'reasoning', 'attachment', 'toolcall']) {
      if (typeof value[name] === 'boolean') result[name] = value[name];
    }
    const input = safeModalities(value.input);
    const output = safeModalities(value.output);
    if (input) result.input = input;
    if (output) result.output = output;
    if (typeof value.interleaved === 'boolean') result.interleaved = value.interleaved;
    else if (plain(value.interleaved)) result.interleaved = true;
  }
  if (plain(limit)) {
    const context = positiveSafeInteger(limit.context);
    const output = positiveSafeInteger(limit.output);
    if (context !== null) result.contextLimit = context;
    if (output !== null) result.outputLimit = output;
  }
  return result;
}

function catalogCapabilities(value) {
  if (!plain(value)) return {};
  const result = {};
  for (const [source, target] of [
    ['temperature', 'temperature'], ['reasoning', 'reasoning'],
    ['attachment', 'attachment'], ['tool_call', 'toolcall'],
  ]) if (typeof value[source] === 'boolean') result[target] = value[source];
  if (plain(value.modalities)) {
    for (const direction of ['input', 'output']) {
      if (!Array.isArray(value.modalities[direction])) continue;
      const present = new Set(value.modalities[direction]);
      result[direction] = Object.fromEntries(MODALITIES.map((name) => [name, present.has(name)]));
    }
  }
  if (typeof value.interleaved === 'boolean') result.interleaved = value.interleaved;
  else if (plain(value.interleaved)) result.interleaved = true;
  const limits = safeCapabilities(null, value.limit);
  return { ...result, ...limits };
}

function safePricing(value) {
  if (!plain(value)) return null;
  const input = finiteNonNegative(value.input);
  const output = finiteNonNegative(value.output);
  if (input === null && output === null) return null;
  return { basis: 'per-million-tokens', input, output, currency: 'USD', effectiveAt: null };
}

function lifecycleState(status) {
  if (status === 'active') return 'active';
  if (status === 'alpha' || status === 'beta') return 'preview';
  if (status === 'deprecated') return 'deprecated';
  return 'unknown';
}

function jsonBlock(lines, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  const chunks = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    chunks.push(line);
    for (const char of `${line}\n`) {
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') { depth += 1; started = true; }
      else if (char === '}') {
        depth -= 1;
        if (started && depth === 0) return { raw: chunks.join('\n'), end: index };
      }
    }
  }
  return { raw: chunks.join('\n'), end: lines.length - 1 };
}

function metadataFor(selector, raw, catalogDocumentValue) {
  let value;
  try { value = JSON.parse(raw); } catch { return { error: 'invalid-model-metadata' }; }
  if (!plain(value)) return { error: 'invalid-model-metadata' };
  const providerID = boundedText(value.providerID, 256);
  const id = boundedText(value.id, 512);
  if (!providerID || !id || `${providerID}/${id}` !== selector) {
    return { error: 'metadata-selector-mismatch' };
  }
  const parts = selectorParts(selector);
  if (!parts) return { error: 'metadata-selector-mismatch' };
  const { provider, modelId } = parts;
  const proof = catalogEntry(catalogDocumentValue, provider, modelId);
  const metadata = proof ?? value;
  const statusValue = boundedText(metadata.status, 32)?.toLowerCase() ?? null;
  const status = statusValue && CATALOG_STATUSES.has(statusValue) ? statusValue : null;
  const familyValue = boundedText(metadata.family, 128);
  const family = familyValue && CATALOG_TOKEN.test(familyValue) ? familyValue : null;
  const catalog = {
    source: proof ? 'models.dev' : 'opencode', public: !!proof, servingProvider: provider,
    publisher: null, family, selector, releaseDate: releaseDate(metadata.release_date), status,
    ...(proof ? { links: { catalog: 'https://models.dev/' } } : {}),
  };
  const availableVariants = plain(value.variants)
    ? Object.keys(value.variants).filter((name) => VARIANT.test(name)).slice(0, 64).sort() : [];
  return {
    metadata: {
      displayName: boundedText(metadata.name, 256) ?? selector,
      catalog,
      availableVariants,
      capabilities: proof ? catalogCapabilities(proof) : safeCapabilities(value.capabilities, value.limit),
      pricing: safePricing(metadata.cost),
      lifecycle: { state: lifecycleState(status), replacement: null },
    },
  };
}

async function fetchCatalog(fetchFn, timeout) {
  if (typeof fetchFn !== 'function') throw new TypeError('catalog-fetch-unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchFn(MODELS_DEV_URL, {
      signal: controller.signal, headers: { accept: 'application/json' },
    });
    if (!response?.ok) throw new TypeError('catalog-fetch-failed');
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
      throw new TypeError('catalog-too-large');
    }
    if (!response.body?.getReader) {
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new TypeError('catalog-too-large');
      return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new TypeError('catalog-too-large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((value) => Buffer.from(value))).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function outputRows(text, diagnostics, catalog) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const seen = new Set();
  if (lines.length > MAX_OUTPUT_LINES) {
    addDiagnostic(diagnostics, diagnostic('output-lines-truncated', `output exceeds ${MAX_OUTPUT_LINES} lines`));
  }
  for (let index = 0; index < Math.min(lines.length, MAX_OUTPUT_LINES); index += 1) {
    const selector = lines[index].trim();
    if (!selector) continue;
    if (!selectorParts(selector)) {
      addDiagnostic(diagnostics, diagnostic('invalid-model-id', `line ${index + 1} is invalid`));
      continue;
    }
    let metadata = null;
    let next = index + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next < lines.length && lines[next].trimStart().startsWith('{')) {
      const block = jsonBlock(lines, next);
      const parsed = metadataFor(selector, block.raw, catalog);
      if (parsed.error) addDiagnostic(diagnostics, diagnostic(parsed.error, `line ${next + 1} metadata is invalid`));
      else metadata = parsed.metadata;
      index = block.end;
    }
    if (!seen.has(selector)) {
      rows.push({ selector, metadata });
      seen.add(selector);
    }
    if (rows.length >= MAX_MODELS) break;
  }
  return rows;
}

function selection(value) {
  let ref = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    ref = typeof value.providerID === 'string' && typeof value.model === 'string'
      ? `${value.providerID}/${value.model}` : null;
  }
  if (typeof ref !== 'string' || ref.length > 576) return null;
  const hash = ref.lastIndexOf('#');
  const id = hash > 0 ? ref.slice(0, hash) : ref;
  const variant = hash > 0 ? ref.slice(hash + 1) : null;
  return selectorParts(id) && (!variant || VARIANT.test(variant)) ? { id, variant } : null;
}

function configuredRefs(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) throw new TypeError('config-too-large');
  let config;
  try { config = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw); } catch { throw new TypeError('config-invalid-json'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config-schema');
  const refs = [config.model];
  for (const agent of Object.values(config.agent && typeof config.agent === 'object' ? config.agent : {})) {
    if (agent && typeof agent === 'object') refs.push(agent.model);
  }
  for (const command of Object.values(config.command && typeof config.command === 'object' ? config.command : {})) {
    if (command && typeof command === 'object') refs.push(command.model);
  }
  return refs.map(selection).filter(Boolean)
    .filter((entry, index, all) => all.findIndex(({ id, variant }) => id === entry.id && variant === entry.variant) === index);
}

export function discoverOpenCode({ raw, configRaw, catalogRaw, initialDiagnostics = [], capturedAt,
  scope = {}, scopeKey, online = false } = /** @type {any} */ ({})) {
  const text = String(raw ?? '');
  const source = sourceRecord({ id: 'opencode-models', owner: 'opencode', scope, scopeKey, capturedAt, complete: true, schema: 'opencode-models-lines-v1' });
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) {
    source.complete = false;
    source.status = 'unsupported';
    source.diagnostics = ['output-too-large'];
    return { status: 'unsupported', source, models: [], diagnostics: [diagnostic('output-too-large', `output exceeds ${MAX_COMMAND_BYTES}`)], networkUsed: online };
  }
  const diagnostics = [];
  for (const item of initialDiagnostics) addDiagnostic(diagnostics, item);
  let configured = [];
  try { configured = configuredRefs(configRaw); } catch (error) {
    source.complete = false;
    source.status = 'partial';
    addDiagnostic(diagnostics, diagnostic('unsupported-config-schema', error.message));
  }
  const rows = outputRows(text, diagnostics, catalogDocument(catalogRaw));
  const ids = rows.map(({ selector }) => selector);
  const complete = diagnostics.length === 0 && ids.length < MAX_MODELS;
  source.complete = complete;
  source.status = complete ? 'complete' : 'partial';
  source.diagnostics = diagnostics.map(({ code }) => code);
  const configuredIds = configured.map(({ id }) => id);
  const allIds = [...new Set([...ids, ...configuredIds])];
  const models = allIds.map((qualified) => {
    const slash = qualified.indexOf('/');
    const provider = slash > 0 ? qualified.slice(0, slash) : null;
    const modelId = slash > 0 ? qualified.slice(slash + 1) : qualified;
    const metadata = rows.find(({ selector }) => selector === qualified)?.metadata ?? null;
    return modelRecord({
      host: 'opencode', provider, modelId, scopeId: source.scopeId,
      displayName: metadata?.displayName ?? qualified, source,
      states: {
        configured: configuredIds.includes(qualified) ? true : 'unknown',
        effective: configRaw !== undefined && configured[0]?.id === qualified ? true : 'unknown',
        discoverable: ids.includes(qualified) ? true : 'unknown', entitled: 'unknown',
      },
      variant: {
        configuredVariants: configured.filter(({ id }) => id === qualified)
          .map(({ variant }) => variant).filter(Boolean),
        ...(metadata ? { catalog: metadata.catalog, availableVariants: metadata.availableVariants } : {}),
      },
      capabilities: metadata?.capabilities ?? {},
      pricing: metadata?.pricing ?? null,
      lifecycle: metadata?.lifecycle,
    });
  });
  return { status: complete ? 'complete' : 'partial', source, models, diagnostics, networkUsed: online };
}

export async function collectOpenCode({
  runner = run, fetchFn = globalThis.fetch, online = false, provider, configRaw, catalogRaw,
  capturedAt, scope = {}, scopeKey, timeout = 30_000,
} = /** @type {any} */ ({})) {
  const providerArg = typeof provider === 'string' && provider.length <= 256 ? provider : null;
  const baseArgs = ['models', ...(providerArg ? [providerArg] : [])];
  const initialDiagnostics = [];
  if (configRaw === undefined) {
    const configured = await runner('opencode', ['debug', 'config'], {
      timeout, maxBuffer: MAX_COMMAND_BYTES, shell: false,
    });
    if (configured.code === 0) configRaw = configured.stdout;
    else addDiagnostic(initialDiagnostics, diagnostic('config-unavailable', 'opencode resolved config unavailable'));
  }
  if (online) {
    const refreshed = await runner('opencode', [...baseArgs, '--refresh'], {
      timeout, maxBuffer: MAX_COMMAND_BYTES, shell: false,
    });
    if (refreshed.code !== 0) {
      const source = sourceRecord({ id: 'opencode-models', owner: 'opencode', scope, scopeKey,
        capturedAt, complete: false, status: 'unavailable', schema: 'opencode-models-lines-v1',
        diagnostics: ['command-failed'] });
      return { status: 'unavailable', source, models: [],
        diagnostics: [diagnostic('command-failed', refreshed.stderr || 'opencode models refresh failed')],
        networkUsed: true };
    }
    if (catalogRaw === undefined) {
      try {
        catalogRaw = await fetchCatalog(fetchFn, timeout);
      } catch {
        addDiagnostic(initialDiagnostics,
          diagnostic('catalog-proof-unavailable', 'Models.dev identity proof unavailable'));
      }
    }
  }
  const result = await runner('opencode', [...baseArgs, '--verbose'], {
    timeout, maxBuffer: MAX_COMMAND_BYTES, shell: false,
  });
  if (result.code !== 0) {
    const source = sourceRecord({ id: 'opencode-models', owner: 'opencode', scope, scopeKey, capturedAt, complete: false, status: 'unavailable', schema: 'opencode-models-lines-v1', diagnostics: ['command-failed'] });
    return { status: 'unavailable', source, models: [], diagnostics: [diagnostic('command-failed', result.stderr || 'opencode models failed')], networkUsed: online };
  }
  return discoverOpenCode({ raw: result.stdout, configRaw, catalogRaw, initialDiagnostics,
    capturedAt, scope, scopeKey, online });
}
