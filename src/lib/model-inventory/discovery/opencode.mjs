import { run } from '../../exec.mjs';
import {
  MAX_COMMAND_BYTES, MAX_MODELS, diagnostic, modelRecord, sourceRecord,
} from './index.mjs';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+@-]*(?:\/~?[A-Za-z0-9][A-Za-z0-9._:+@/-]*)?$/;
const VARIANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CATALOG_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CATALOG_STATUSES = new Set(['active', 'alpha', 'beta', 'deprecated']);
const MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'];

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

function publicCatalogIdentity(provider, modelId) {
  if (provider !== 'openrouter') return { public: false, publisher: null, links: null };
  const segments = modelId.replace(/^~/, '').split('/');
  if (segments.length < 2 || !CATALOG_TOKEN.test(segments[0])
    || segments.slice(1).some((part) => !part || part.length > 256)) {
    return { public: false, publisher: null, links: null };
  }
  const publisher = segments[0];
  const modelPath = segments.slice(1).map(encodeURIComponent).join('/');
  return {
    public: true,
    publisher,
    links: { catalog: `https://models.dev/models/${encodeURIComponent(publisher)}/${modelPath}/` },
  };
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

function metadataFor(selector, raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return { error: 'invalid-model-metadata' }; }
  if (!plain(value)) return { error: 'invalid-model-metadata' };
  const providerID = boundedText(value.providerID, 256);
  const id = boundedText(value.id, 512);
  if (!providerID || !id || `${providerID}/${id}` !== selector) {
    return { error: 'metadata-selector-mismatch' };
  }
  const slash = selector.indexOf('/');
  const provider = selector.slice(0, slash);
  const modelId = selector.slice(slash + 1);
  const statusValue = boundedText(value.status, 32)?.toLowerCase() ?? null;
  const status = statusValue && CATALOG_STATUSES.has(statusValue) ? statusValue : null;
  const familyValue = boundedText(value.family, 128);
  const family = familyValue && CATALOG_TOKEN.test(familyValue) ? familyValue : null;
  const identity = publicCatalogIdentity(provider, modelId);
  const catalog = {
    source: 'opencode', public: identity.public, servingProvider: provider,
    publisher: identity.publisher, family, selector, releaseDate: releaseDate(value.release_date), status,
    ...(identity.links ? { links: identity.links } : {}),
  };
  const availableVariants = plain(value.variants)
    ? Object.keys(value.variants).filter((name) => VARIANT.test(name)).slice(0, 64).sort() : [];
  return {
    metadata: {
      displayName: boundedText(value.name, 256) ?? selector,
      catalog,
      availableVariants,
      capabilities: safeCapabilities(value.capabilities, value.limit),
      pricing: safePricing(value.cost),
      lifecycle: { state: lifecycleState(status), replacement: null },
    },
  };
}

function outputRows(text, diagnostics) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const selector = lines[index].trim();
    if (!selector) continue;
    if (!MODEL_ID.test(selector) || selector.length > 512) {
      diagnostics.push(diagnostic('invalid-model-id', `line ${index + 1} is invalid`));
      continue;
    }
    let metadata = null;
    let next = index + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next < lines.length && lines[next].trimStart().startsWith('{')) {
      const block = jsonBlock(lines, next);
      const parsed = metadataFor(selector, block.raw);
      if (parsed.error) diagnostics.push(diagnostic(parsed.error, `line ${next + 1} metadata is invalid`));
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
  return MODEL_ID.test(id) && (!variant || VARIANT.test(variant)) ? { id, variant } : null;
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
  return refs.map(selection).filter(Boolean)
    .filter((entry, index, all) => all.findIndex(({ id, variant }) => id === entry.id && variant === entry.variant) === index);
}

export function discoverOpenCode({ raw, configRaw, capturedAt, scope = {}, scopeKey, online = false } = /** @type {any} */ ({})) {
  const text = String(raw ?? '');
  const source = sourceRecord({ id: 'opencode-models', owner: 'opencode', scope, scopeKey, capturedAt, complete: true, schema: 'opencode-models-lines-v1' });
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) {
    source.complete = false;
    source.status = 'unsupported';
    source.diagnostics = ['output-too-large'];
    return { status: 'unsupported', source, models: [], diagnostics: [diagnostic('output-too-large', `output exceeds ${MAX_COMMAND_BYTES}`)], networkUsed: online };
  }
  const diagnostics = [];
  let configured = [];
  try { configured = configuredRefs(configRaw); } catch (error) {
    source.complete = false;
    source.status = 'partial';
    diagnostics.push(diagnostic('unsupported-config-schema', error.message));
  }
  const rows = outputRows(text, diagnostics);
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
  runner = run, online = false, provider, configRaw, capturedAt, scope = {}, scopeKey, timeout = 30_000,
} = /** @type {any} */ ({})) {
  const providerArg = typeof provider === 'string' && provider.length <= 256 ? provider : null;
  const args = ['models', ...(providerArg ? [providerArg] : []), '--verbose', ...(online ? ['--refresh'] : [])];
  const result = await runner('opencode', args, { timeout, maxBuffer: MAX_COMMAND_BYTES, shell: false });
  if (result.code !== 0) {
    const source = sourceRecord({ id: 'opencode-models', owner: 'opencode', scope, scopeKey, capturedAt, complete: false, status: 'unavailable', schema: 'opencode-models-lines-v1', diagnostics: ['command-failed'] });
    return { status: 'unavailable', source, models: [], diagnostics: [diagnostic('command-failed', result.stderr || 'opencode models failed')], networkUsed: online };
  }
  return discoverOpenCode({ raw: result.stdout, configRaw, capturedAt, scope, scopeKey, online });
}
