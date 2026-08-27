import { run } from '../../exec.mjs';
import {
  MAX_COMMAND_BYTES, MAX_MODELS, diagnostic, modelRecord, sourceRecord,
} from './index.mjs';

const VARIANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CATALOG_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CATALOG_STATUSES = new Set(['active', 'alpha', 'beta', 'deprecated']);
const MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'];
const MAX_DIAGNOSTICS = 64;
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

function isValidCatalogModel(modelId, model) {
  return plain(model) && model.id === modelId;
}

/** -1 signals an invalid model row so the caller can fail the whole document closed. */
function countValidCatalogModels(models) {
  let count = 0;
  for (const [modelId, model] of Object.entries(models)) {
    if (!isValidCatalogModel(modelId, model)) return -1;
    count += 1;
  }
  return count;
}

function isValidCatalogProvider(providerId, provider) {
  return plain(provider) && provider.id === providerId && plain(provider.models);
}

/** -1 (not 0) distinguishes "an entry was invalid" from "zero valid models found". */
function catalogModelCount(providers) {
  let total = 0;
  for (const [providerId, provider] of providers) {
    if (!isValidCatalogProvider(providerId, provider)) return -1;
    const count = countValidCatalogModels(provider.models);
    if (count < 0) return -1;
    total += count;
  }
  return total;
}

function parseCatalogValue(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
}

function catalogDocument(raw) {
  if (raw == null || raw === '') return null;
  try {
    const value = parseCatalogValue(raw);
    if (!plain(value)) return null;
    const providers = Object.entries(value);
    if (providers.length === 0) return null;
    return catalogModelCount(providers) > 0 ? value : null;
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

const CAPABILITY_BOOLEAN_FIELDS = ['temperature', 'reasoning', 'attachment', 'toolcall'];

function safeCapabilityBooleans(value) {
  const result = {};
  for (const name of CAPABILITY_BOOLEAN_FIELDS) if (typeof value[name] === 'boolean') result[name] = value[name];
  return result;
}

function safeCapabilityModalities(value) {
  const result = {};
  const input = safeModalities(value.input);
  const output = safeModalities(value.output);
  if (input) result.input = input;
  if (output) result.output = output;
  return result;
}

function safeCapabilityInterleaved(value) {
  if (typeof value.interleaved === 'boolean') return { interleaved: value.interleaved };
  return plain(value.interleaved) ? { interleaved: true } : {};
}

function safeCapabilityLimits(limit) {
  if (!plain(limit)) return {};
  const result = {};
  const context = positiveSafeInteger(limit.context);
  const output = positiveSafeInteger(limit.output);
  if (context !== null) result.contextLimit = context;
  if (output !== null) result.outputLimit = output;
  return result;
}

function safeCapabilities(value, limit) {
  const base = plain(value)
    ? { ...safeCapabilityBooleans(value), ...safeCapabilityModalities(value), ...safeCapabilityInterleaved(value) }
    : {};
  return { ...base, ...safeCapabilityLimits(limit) };
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

/** Advance one character of brace-depth/string-aware JSON scanning. Mutates `state`
 *  in place and returns true once a complete top-level `{...}` block has closed. */
function advanceJsonScan(state, char) {
  if (state.inString) {
    if (state.escaped) state.escaped = false;
    else if (char === '\\') state.escaped = true;
    else if (char === '"') state.inString = false;
    return false;
  }
  if (char === '"') state.inString = true;
  else if (char === '{') { state.depth += 1; state.started = true; }
  else if (char === '}') {
    state.depth -= 1;
    if (state.started && state.depth === 0) return true;
  }
  return false;
}

function jsonBlock(lines, start) {
  const state = {
    depth: 0, inString: false, escaped: false, started: false,
  };
  const chunks = [];
  for (let index = start; index < lines.length; index += 1) {
    chunks.push(lines[index]);
    for (const char of `${lines[index]}\n`) {
      if (advanceJsonScan(state, char)) return { raw: chunks.join('\n'), end: index };
    }
  }
  return { raw: chunks.join('\n'), end: lines.length - 1 };
}

function parseModelMetadataJson(raw) {
  try {
    const value = JSON.parse(raw);
    return plain(value) ? { value } : { error: 'invalid-model-metadata' };
  } catch { return { error: 'invalid-model-metadata' }; }
}

/** Selector-carried providerID/id must echo the line's own selector before any
 *  metadata is trusted; only then is the selector re-parsed into provider/modelId. */
function validatedSelectorParts(value, selector) {
  const providerID = boundedText(value.providerID, 256);
  const id = boundedText(value.id, 512);
  if (!providerID || !id || `${providerID}/${id}` !== selector) return null;
  return selectorParts(selector);
}

function metadataStatus(proof, metadata) {
  const statusValue = proof && metadata.status === undefined
    ? 'active' : boundedText(metadata.status, 32)?.toLowerCase() ?? null;
  return statusValue && CATALOG_STATUSES.has(statusValue) ? statusValue : null;
}

function metadataFamily(metadata) {
  const familyValue = boundedText(metadata.family, 128);
  return familyValue && CATALOG_TOKEN.test(familyValue) ? familyValue : null;
}

function metadataCatalogBlock({
  proof, provider, selector, metadata, status, family,
}) {
  return {
    source: proof ? 'models.dev' : 'opencode', public: !!proof, servingProvider: provider,
    publisher: null, family, selector, releaseDate: releaseDate(metadata.release_date), status,
    ...(proof ? { links: { catalog: 'https://models.dev/' } } : {}),
  };
}

function metadataAvailableVariants(value) {
  return plain(value.variants)
    ? Object.keys(value.variants).filter((name) => VARIANT.test(name)).slice(0, 64).sort() : [];
}

function metadataFor(selector, raw, catalogDocumentValue) {
  const { value, error } = parseModelMetadataJson(raw);
  if (error) return { error };
  const parts = validatedSelectorParts(value, selector);
  if (!parts) return { error: 'metadata-selector-mismatch' };
  const { provider, modelId } = parts;
  const proof = catalogEntry(catalogDocumentValue, provider, modelId);
  const metadata = proof ?? value;
  const status = metadataStatus(proof, metadata);
  const family = metadataFamily(metadata);
  const catalog = metadataCatalogBlock({
    proof, provider, selector, metadata, status, family,
  });
  return {
    metadata: {
      displayName: boundedText(metadata.name, 256) ?? selector,
      catalog,
      availableVariants: metadataAvailableVariants(value),
      capabilities: proof ? catalogCapabilities(proof) : safeCapabilities(value.capabilities, value.limit),
      pricing: safePricing(metadata.cost),
      lifecycle: { state: lifecycleState(status), replacement: null },
    },
  };
}

async function readBoundedCatalogText(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new TypeError('catalog-too-large');
  return text;
}

async function readBoundedCatalogStream(reader) {
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
    if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) throw new TypeError('catalog-too-large');
    return response.body?.getReader
      ? readBoundedCatalogStream(response.body.getReader()) : readBoundedCatalogText(response);
  } finally {
    clearTimeout(timer);
  }
}

function nextNonBlankLineIndex(lines, from) {
  let next = from;
  while (next < lines.length && !lines[next].trim()) next += 1;
  return next;
}

/** A selector line may be followed by a `{...}` metadata block once the next
 *  non-blank line starts one; otherwise the row carries no metadata. */
function readRowMetadata(lines, index, selector, catalog, diagnostics) {
  const next = nextNonBlankLineIndex(lines, index + 1);
  if (next >= lines.length || !lines[next].trimStart().startsWith('{')) return { metadata: null, end: index };
  const block = jsonBlock(lines, next);
  const parsed = metadataFor(selector, block.raw, catalog);
  if (parsed.error) addDiagnostic(diagnostics, diagnostic(parsed.error, `line ${next + 1} metadata is invalid`));
  return { metadata: parsed.error ? null : parsed.metadata, end: block.end };
}

function outputRows(text, diagnostics, catalog) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const selector = lines[index].trim();
    if (!selector) continue;
    if (!selectorParts(selector)) {
      addDiagnostic(diagnostics, diagnostic('invalid-model-id', `line ${index + 1} is invalid`));
      continue;
    }
    const { metadata, end } = readRowMetadata(lines, index, selector, catalog, diagnostics);
    index = end;
    if (!seen.has(selector)) {
      rows.push({ selector, metadata });
      seen.add(selector);
    }
    if (rows.length >= MAX_MODELS) break;
  }
  return rows;
}

function referenceString(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value.providerID === 'string' && typeof value.model === 'string'
    ? `${value.providerID}/${value.model}` : null;
}

function splitSelectorVariant(ref) {
  const hash = ref.lastIndexOf('#');
  return hash > 0 ? { id: ref.slice(0, hash), variant: ref.slice(hash + 1) } : { id: ref, variant: null };
}

function selection(value) {
  const ref = referenceString(value);
  if (typeof ref !== 'string' || ref.length > 576) return null;
  const { id, variant } = splitSelectorVariant(ref);
  return selectorParts(id) && (!variant || VARIANT.test(variant)) ? { id, variant } : null;
}

function parseOpenCodeConfig(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) throw new TypeError('config-too-large');
  let config;
  try { config = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw); } catch { throw new TypeError('config-invalid-json'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config-schema');
  return config;
}

function modelRefsFromGroup(group) {
  const refs = [];
  for (const entry of Object.values(group && typeof group === 'object' ? group : {})) {
    if (entry && typeof entry === 'object') refs.push(entry.model);
  }
  return refs;
}

function dedupeSelections(entries) {
  return entries.filter((entry, index, all) => all
    .findIndex(({ id, variant }) => id === entry.id && variant === entry.variant) === index);
}

function configuredRefs(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const config = parseOpenCodeConfig(raw);
  const refs = [config.model, ...modelRefsFromGroup(config.agent), ...modelRefsFromGroup(config.command)];
  return dedupeSelections(refs.map(selection).filter(Boolean));
}

function openCodeSourceUnsupportedResult(source, online) {
  source.complete = false;
  source.status = 'unsupported';
  source.diagnostics = ['output-too-large'];
  return {
    status: 'unsupported', source, models: [],
    diagnostics: [diagnostic('output-too-large', `output exceeds ${MAX_COMMAND_BYTES}`)], networkUsed: online,
  };
}

function openCodeModelStates(qualified, {
  configuredIds, configured, configRaw, ids,
}) {
  return {
    configured: configuredIds.includes(qualified) ? true : 'unknown',
    effective: configRaw !== undefined && configured[0]?.id === qualified ? true : 'unknown',
    discoverable: ids.includes(qualified) ? true : 'unknown', entitled: 'unknown',
  };
}

function openCodeModelVariant(qualified, configured, metadata) {
  return {
    configuredVariants: configured.filter(({ id }) => id === qualified)
      .map(({ variant }) => variant).filter(Boolean),
    ...(metadata ? { catalog: metadata.catalog, availableVariants: metadata.availableVariants } : {}),
  };
}

function openCodeModelFromId(qualified, ctx) {
  const {
    rows, configured, configuredIds, ids, configRaw, source,
  } = ctx;
  const slash = qualified.indexOf('/');
  const provider = slash > 0 ? qualified.slice(0, slash) : null;
  const modelId = slash > 0 ? qualified.slice(slash + 1) : qualified;
  const metadata = rows.find(({ selector }) => selector === qualified)?.metadata ?? null;
  return modelRecord({
    host: 'opencode', provider, modelId, scopeId: source.scopeId,
    displayName: metadata?.displayName ?? qualified, source,
    states: openCodeModelStates(qualified, {
      configuredIds, configured, configRaw, ids,
    }),
    variant: openCodeModelVariant(qualified, configured, metadata),
    capabilities: metadata?.capabilities ?? {},
    pricing: metadata?.pricing ?? null,
    lifecycle: metadata?.lifecycle,
  });
}

export function discoverOpenCode({
  raw, configRaw, catalogRaw, initialDiagnostics = [], capturedAt, scope = {}, scopeKey, online = false,
} = /** @type {any} */ ({})) {
  const text = String(raw ?? '');
  const source = sourceRecord({ id: 'opencode-models', owner: 'opencode', scope, scopeKey, capturedAt, complete: true, schema: 'opencode-models-lines-v1' });
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) return openCodeSourceUnsupportedResult(source, online);
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
  const models = allIds.map((qualified) => openCodeModelFromId(qualified, {
    rows, configured, configuredIds, ids, configRaw, source,
  }));
  return { status: complete ? 'complete' : 'partial', source, models, diagnostics, networkUsed: online };
}

function unavailableOpenCodeResult({ scope, scopeKey, capturedAt }, message, networkUsed) {
  const source = sourceRecord({
    id: 'opencode-models', owner: 'opencode', scope, scopeKey, capturedAt,
    complete: false, status: 'unavailable', schema: 'opencode-models-lines-v1', diagnostics: ['command-failed'],
  });
  return {
    status: 'unavailable', source, models: [], diagnostics: [diagnostic('command-failed', message)], networkUsed,
  };
}

async function resolveOpenCodeConfigRaw(runner, timeout, initialDiagnostics) {
  const configured = await runner('opencode', ['debug', 'config'], {
    timeout, maxBuffer: MAX_COMMAND_BYTES, shell: false,
  });
  if (configured.code === 0) return configured.stdout;
  addDiagnostic(initialDiagnostics, diagnostic('config-unavailable', 'opencode resolved config unavailable'));
  return undefined;
}

async function resolveModelsDevCatalogRaw(fetchFn, timeout, initialDiagnostics) {
  try {
    const catalogRaw = await fetchCatalog(fetchFn, timeout);
    if (!catalogDocument(catalogRaw)) throw new TypeError('catalog-invalid');
    return catalogRaw;
  } catch (error) {
    const invalid = error instanceof TypeError && error.message === 'catalog-invalid';
    addDiagnostic(initialDiagnostics,
      diagnostic(invalid ? 'catalog-proof-invalid' : 'catalog-proof-unavailable',
        invalid ? 'Models.dev identity proof is malformed or unsupported'
          : 'Models.dev identity proof unavailable'));
    return undefined;
  }
}

/** Returns `{ error }` (an unavailable result) on a failed --refresh, otherwise
 *  `{ catalogRaw }` — fetching Models.dev proof only when the caller didn't supply one. */
async function refreshOpenCodeOnline({
  runner, baseArgs, timeout, fetchFn, catalogRaw, initialDiagnostics, scopeCtx,
}) {
  const refreshed = await runner('opencode', [...baseArgs, '--refresh'], {
    timeout, maxBuffer: MAX_COMMAND_BYTES, shell: false,
  });
  if (refreshed.code !== 0) {
    return { error: unavailableOpenCodeResult(scopeCtx, refreshed.stderr || 'opencode models refresh failed', true) };
  }
  const resolvedCatalogRaw = catalogRaw === undefined
    ? await resolveModelsDevCatalogRaw(fetchFn, timeout, initialDiagnostics) : catalogRaw;
  return { catalogRaw: resolvedCatalogRaw };
}

export async function collectOpenCode({
  runner = run, fetchFn = globalThis.fetch, online = false, provider, configRaw, catalogRaw,
  capturedAt, scope = {}, scopeKey, timeout = 30_000,
} = /** @type {any} */ ({})) {
  const providerArg = typeof provider === 'string' && provider.length <= 256 ? provider : null;
  const baseArgs = ['models', ...(providerArg ? [providerArg] : [])];
  const initialDiagnostics = [];
  const scopeCtx = { scope, scopeKey, capturedAt };
  if (configRaw === undefined) configRaw = await resolveOpenCodeConfigRaw(runner, timeout, initialDiagnostics);
  if (online) {
    const refresh = await refreshOpenCodeOnline({
      runner, baseArgs, timeout, fetchFn, catalogRaw, initialDiagnostics, scopeCtx,
    });
    if (refresh.error) return refresh.error;
    catalogRaw = refresh.catalogRaw;
  }
  const result = await runner('opencode', [...baseArgs, '--verbose'], {
    timeout, maxBuffer: MAX_COMMAND_BYTES, shell: false,
  });
  if (result.code !== 0) return unavailableOpenCodeResult(scopeCtx, result.stderr || 'opencode models failed', online);
  return discoverOpenCode({
    raw: result.stdout, configRaw, catalogRaw, initialDiagnostics, capturedAt, scope, scopeKey, online,
  });
}
