import { createHmac } from 'node:crypto';
import { immutable } from '../adapters/schema.mjs';
import { ACTIVITIES } from '../routing.mjs';
import { PRICES_AS_OF, priceFor } from '../pricing.mjs';
import { normalizeSnapshot } from './contracts.mjs';
import { dashboardModelView } from './dashboard-query.mjs';

/** @param {any} snapshotValue @param {{changes?: any[]|{changes?: any[]}}} [options] */
export function createModelReadModel(snapshotValue, options = {}) {
  const { changes } = options;
  const snapshot = normalizeSnapshot(snapshotValue);
  const changeRows = Array.isArray(changes) ? changes
    : Array.isArray(changes?.changes) ? changes.changes : snapshot.changes;
  const configuredBindings = snapshot.bindings.filter(({ configured }) => configured != null);
  const observed = snapshot.models.filter(({ dimensions }) => dimensions.observed.value === true);
  const migrations = snapshot.models.filter(hasPublishedLifecycleMigration);
  const aliasChanges = changeRows.filter(({ kind }) => kind === 'alias-target-changed');
  const staleSources = snapshot.sources.filter(({ status }) => status !== 'complete');
  const driftedConsumers = snapshot.bindings.filter(({ drift }) => drift);
  const attention = [
    ...staleSources.map((source) => ({ kind: 'source', severity: 'warn', subject: source.id, reason: source.status })),
    ...migrations.map((model) => ({
      kind: 'migration', severity: 'warn', subject: model.identity,
      reason: `${model.identity.modelId} is ${model.lifecycle.state}; replacement ${model.lifecycle.replacement}`,
    })),
    ...aliasChanges.map((entry) => ({ kind: 'alias', severity: entry.severity, subject: entry.subject, reason: entry.kind })),
    ...driftedConsumers.map((binding) => ({ kind: 'consumer', severity: 'warn', subject: binding.id, reason: 'projection drift' })),
  ];
  return immutable({
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    scope: snapshot.scope,
    counts: {
      models: snapshot.models.length,
      configured: configuredBindings.length,
      observed: observed.length,
      migrations: migrations.length,
      aliasChanges: aliasChanges.length,
      staleSources: staleSources.length,
      driftedConsumers: driftedConsumers.length,
    },
    sources: snapshot.sources,
    models: snapshot.models,
    bindings: snapshot.bindings,
    changes: changeRows,
    attention,
    diagnostics: snapshot.diagnostics,
  });
}

const LIFECYCLE_NOTICE_HOSTS = new Set(['developers.openai.com', 'platform.claude.com']);

function lifecycleNoticeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const notice = new URL(value);
    return notice.protocol === 'https:' && !notice.username && !notice.password && !notice.port
      && LIFECYCLE_NOTICE_HOSTS.has(notice.hostname) ? notice.href : null;
  } catch { return null; }
}

/** A cache hint is never a retirement claim. Require a cited first-party notice. */
function hasPublishedLifecycleMigration(model) {
  if (!['retiring', 'deprecated', 'removed'].includes(model.lifecycle?.state)
    || !model.lifecycle?.replacement || !lifecycleNoticeUrl(model.lifecycle.notice)) return false;
  return model.evidence.some((entry) => entry.field === 'lifecycle' && entry.class === 'first-party');
}

export function summarizeModelHealth(snapshotValue, options = {}) {
  const model = createModelReadModel(snapshotValue, options);
  const level = model.attention.some(({ severity }) => severity === 'fail') ? 'fail'
    : model.attention.length ? 'warn' : 'ok';
  const sourceAt = model.sources.map(({ capturedAt }) => capturedAt).filter(Boolean).sort().at(-1)
    ?? model.capturedAt;
  return immutable({
    level,
    message: `${model.counts.configured} configured · ${model.counts.observed} observed · `
      + `${model.counts.migrations} migrations · ${model.counts.aliasChanges} alias changes · catalog ${sourceAt}`,
    fix: model.counts.staleSources ? 'ak models refresh' : model.counts.migrations || model.counts.aliasChanges
      ? 'ak models diff' : null,
    counts: model.counts,
    capturedAt: model.capturedAt,
  });
}

const PUBLIC_HOSTS = new Set(['claude', 'codex', 'opencode', 'ollama', 'unknown']);
const PUBLIC_ACTIVITIES = new Set(ACTIVITIES);
const PUBLIC_SOURCES = new Set([
  'claude-config', 'codex-cache', 'opencode-models', 'ollama-catalog', 'usage-index',
]);
const PUBLIC_SOURCE_SCHEMAS = new Set([
  'claude-settings-v1', 'codex-model-cache-v1', 'opencode-models-lines-v1',
  'ollama-ls-v1', 'ollama-api-v1', 'usage-models-v1', 'usage-index-v6',
]);
const PUBLIC_SOURCE_OWNERS = new Set(['claude', 'codex', 'opencode', 'ollama', 'usage']);

function dashboardKey(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) {
    throw new TypeError('model dashboard privacy key unavailable');
  }
  return Buffer.from(key, 'hex');
}

function privateLabel(kind, value, key) {
  if (value == null || value === '') return null;
  const digest = createHmac('sha256', key).update(`${kind}\0${String(value)}`).digest('hex').slice(0, 12);
  return `${kind}-${digest}`;
}

const publicHost = (value, key) => PUBLIC_HOSTS.has(value) ? value : privateLabel('host', value, key);
const publicActivity = (value, key) => value == null ? null
  : PUBLIC_ACTIVITIES.has(value) ? value : privateLabel('activity', value, key);
const publicSource = (value, key) => PUBLIC_SOURCES.has(value) ? value : privateLabel('source', value, key);
const publicDiagnostic = (value, key) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value ?? ''))
  ? value : privateLabel('diagnostic', value, key);
const publicSchema = (value) => PUBLIC_SOURCE_SCHEMAS.has(value)
  || /^codex-model-cache-v1@v?\d+(?:\.\d+){0,3}(?:-[a-z0-9.-]+)?$/i.test(String(value ?? ''))
  ? value : null;

const SAFE_VARIANT_FIELDS = new Set([
  'digest', 'reasoningEffort', 'reasoningEfforts', 'serviceTier', 'contextWindow',
  'configuredVariants', 'availableVariants', 'modalities', 'input', 'output',
  'text', 'audio', 'image', 'video', 'pdf', 'sizeBytes', 'modifiedAt', 'format',
  'family', 'families', 'parameterSize', 'quantizationLevel', 'loaded', 'memoryBytes',
  'vramBytes', 'expiresAt', 'licenseSummary', 'advertisedCapabilities',
]);
const OWNER_VISIBLE_VARIANT_TEXT_FIELDS = new Set([
  'modifiedAt', 'format', 'family', 'families', 'parameterSize',
  'quantizationLevel', 'expiresAt', 'licenseSummary', 'advertisedCapabilities',
]);

function sanitizeVariant(value, key, field = '', depth = 0) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeVariant(entry, key, field, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    return OWNER_VISIBLE_VARIANT_TEXT_FIELDS.has(field)
      ? boundedPublicText(value, 256) : privateLabel('variant', value, key);
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => SAFE_VARIANT_FIELDS.has(name))
    .map(([name, entry]) => [name, sanitizeVariant(entry, key, name, depth + 1)]));
}

function sanitizeEvidence(entry, key) {
  return {
    ...entry,
    id: privateLabel('evidence', entry.id, key),
    source: publicSource(entry.source, key),
    scopeFingerprint: privateLabel('scope', entry.scopeFingerprint, key),
    refs: (entry.refs ?? []).map((ref) => privateLabel('reference', ref, key)),
  };
}

const TRUSTED_MODEL_LINK_HOSTS = new Set([
  'developers.openai.com', 'huggingface.co', 'models.dev', 'ollama.com',
  'opencode.ai', 'openrouter.ai', 'platform.claude.com',
]);
const PUBLIC_CATALOG_METADATA_SOURCES = new Set(['models.dev']);
// Maintained from Anthropic's Models overview and Model deprecations tables.
// IDs and pre-4.6 aliases are exact: the documented grammar is not publication proof.
const OFFICIAL_CLAUDE_IDS = new Set([
  'claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview',
  'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-opus-4-5', 'claude-opus-4-5-20251101',
  'claude-opus-4-1', 'claude-opus-4-1-20250805',
  'claude-opus-4-0', 'claude-opus-4-20250514',
  'claude-sonnet-5', 'claude-sonnet-4-6',
  'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-0', 'claude-sonnet-4-20250514',
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
]);
const OPENAI_MODEL_DOCUMENTATION = new Map([
  ['gpt-5.6-sol', 'https://developers.openai.com/api/docs/models/gpt-5.6-sol'],
  ['gpt-5.6-terra', 'https://developers.openai.com/api/docs/models/gpt-5.6-terra'],
  ['gpt-5.6-luna', 'https://developers.openai.com/api/docs/models/gpt-5.6-luna'],
]);
const openAiModelDocumentation = (modelId) => OPENAI_MODEL_DOCUMENTATION.get(modelId) ?? null;

function boundedPublicText(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && ![...value].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
    ? value : null;
}

/**
 * The Dashboard is loopback/token protected and is an owner operator surface.
 * A concrete model selector and provider are operational facts, not a secret:
 * without them the routes table cannot answer which version is actually used.
 * Keep credentials, endpoints, scopes, digests, evidence refs, and aliases out.
 */
function ownerVisibleModelText(value, max = 512) {
  return boundedPublicText(value, max);
}

function ownerVisibleCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const name of ['tools', 'toolcall', 'reasoning', 'structuredOutput', 'temperature', 'attachment', 'interleaved', 'embedding']) {
    if (typeof value[name] === 'boolean') result[name] = value[name];
  }
  for (const name of ['contextLimit', 'outputLimit']) {
    if (Number.isSafeInteger(value[name]) && value[name] > 0) result[name] = value[name];
  }
  for (const direction of ['input', 'output']) {
    if (!value[direction] || typeof value[direction] !== 'object' || Array.isArray(value[direction])) continue;
    const modalities = {};
    for (const name of ['text', 'audio', 'image', 'video', 'pdf']) {
      if (typeof value[direction][name] === 'boolean') modalities[name] = value[direction][name];
    }
    if (Object.keys(modalities).length) result[direction] = modalities;
  }
  return result;
}

function ownerVisiblePricing(model) {
  const pricing = model.pricing;
  if (pricing && ['per-token', 'per-million-tokens', 'zero', 'local-compute'].includes(pricing.basis)
    && (Number.isFinite(pricing.input) || Number.isFinite(pricing.output))
    && /^[A-Z]{3}$/.test(pricing.currency ?? '')) {
    return {
      basis: pricing.basis, input: pricing.input, output: pricing.output, currency: pricing.currency,
      effectiveAt: pricing.effectiveAt,
      source: pricing.basis === 'local-compute' ? 'local installation evidence' : 'catalogue evidence',
      asOf: null, matched: true,
    };
  }
  const published = priceFor(model.key.modelId, model.key.provider);
  if (!published.matched) return null;
  const sourceUrl = published.provider === 'openai' ? openAiModelDocumentation(model.key.modelId) : null;
  return {
    basis: 'per-million-tokens', input: published.in, output: published.out, currency: 'USD',
    effectiveAt: null, source: sourceUrl ? 'OpenAI API model documentation' : 'published API list-price table',
    sourceUrl, asOf: PRICES_AS_OF, matched: true,
  };
}

function trustedModelLinks(value) {
  const labels = {
    catalog: 'Models.dev', documentation: 'Documentation', provider: 'Provider',
    weights: 'Hugging Face', library: 'Model library',
  };
  const entries = Array.isArray(value) ? value : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([kind, url]) => labels[kind] && typeof url === 'string'
      ? [{ kind, label: labels[kind], url }] : []) : [];
  return entries.slice(0, 16).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const kind = boundedPublicText(entry.kind, 64);
    const label = labels[kind] ?? null;
    const raw = boundedPublicText(entry.url, 2_048);
    if (!kind || !label || !raw) return [];
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !TRUSTED_MODEL_LINK_HOSTS.has(url.hostname)) return [];
      return [{ kind, label, url: url.href }];
    } catch { return []; }
  });
}

function hasEvidence(model, predicate) {
  return model.evidence.some((entry) => predicate(entry));
}

function hasCatalogDiscovery(model, source) {
  const refs = new Set(model.dimensions.discoverable?.evidenceRefs ?? []);
  return model.dimensions.discoverable?.value === true && hasEvidence(model, (entry) => (
    refs.has(entry.id) && entry.source === source && ['catalog', 'first-party'].includes(entry.class)
  ));
}

function claudeHumanName(modelId) {
  const parts = modelId.split('-').slice(1);
  const family = parts.shift();
  let date = null;
  if (/^\d{8}$/.test(parts.at(-1) ?? '')) {
    const raw = parts.pop();
    const candidate = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const parsed = new Date(`${candidate}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === candidate) date = candidate;
  }
  const version = /^\d{1,2}$/.test(parts[0] ?? '') && /^\d{1,2}$/.test(parts[1] ?? '')
    ? `${parts.shift()}.${parts.shift()}` : null;
  const title = (value) => value ? `${value[0].toUpperCase()}${value.slice(1)}` : '';
  return ['Claude', title(family), version, ...parts.map(title)].filter(Boolean).join(' ')
    + (date ? ` (${date})` : '');
}

/** Public identity is fail-closed: local/custom rows need an explicit catalog-public marker. */
function publicModelIdentity(model) {
  if (model.key.host === 'codex' && hasCatalogDiscovery(model, 'codex-cache')) {
    const modelDocumentation = openAiModelDocumentation(model.key.modelId);
    return {
      humanName: boundedPublicText(model.displayName) ?? model.key.modelId,
      selector: model.key.modelId, servingProvider: 'openai', publisher: 'OpenAI',
      family: boundedPublicText(model.variant?.family),
      links: [{ kind: 'documentation', label: modelDocumentation ? 'OpenAI API model page' : 'Codex models',
        url: modelDocumentation ?? 'https://developers.openai.com/codex/models/' }],
    };
  }
  if (model.key.host === 'claude' && OFFICIAL_CLAUDE_IDS.has(model.key.modelId)
    && hasEvidence(model, (entry) => (entry.source === 'claude-config'
      && ['configured', 'first-party'].includes(entry.class))
      || (entry.source === 'usage-index' && entry.class === 'observed'))) {
    return {
      humanName: claudeHumanName(model.key.modelId), selector: model.key.modelId,
      servingProvider: 'anthropic',
      publisher: 'Anthropic', family: model.key.modelId.split('-')[1],
      links: [{ kind: 'documentation', label: 'Claude models', url: 'https://platform.claude.com/docs/en/about-claude/models/overview' }],
    };
  }
  const catalog = model.variant?.catalog;
  if (!catalog || catalog.public !== true || !PUBLIC_CATALOG_METADATA_SOURCES.has(catalog.source)
    || !hasEvidence(model, (entry) => entry.field === 'variant.catalog'
      && entry.source === 'opencode-models'
      && ['catalog', 'first-party'].includes(entry.class))) return null;
  const humanName = boundedPublicText(model.displayName);
  const selector = boundedPublicText(catalog.selector);
  if (!humanName || !selector) return null;
  return {
    humanName, selector,
    servingProvider: boundedPublicText(catalog.servingProvider),
    publisher: boundedPublicText(catalog.publisher), family: boundedPublicText(catalog.family),
    links: trustedModelLinks(catalog.links),
  };
}

function sanitizeModel(model, key) {
  const evidenceIds = new Map(model.evidence.map(({ id }) => [id, privateLabel('evidence', id, key)]));
  const evidenceRefs = (refs = []) => refs.map((ref) => evidenceIds.get(ref)
    ?? privateLabel('evidence', ref, key));
  const publicIdentity = publicModelIdentity(model);
  const { catalog: _catalog, ...privateVariant } = model.variant ?? {};
  return {
    ...model,
    key: {
      host: publicHost(model.key.host, key),
      provider: ownerVisibleModelText(model.key.provider),
      modelId: ownerVisibleModelText(model.key.modelId),
      scopeId: privateLabel('scope', model.key.scopeId, key),
      digest: privateLabel('digest', model.key.digest, key),
    },
    identity: privateLabel('identity', model.identity, key),
    displayName: publicIdentity?.humanName
      ?? ownerVisibleModelText(model.displayName) ?? ownerVisibleModelText(model.key.modelId) ?? 'Model not recorded',
    humanName: publicIdentity?.humanName
      ?? ownerVisibleModelText(model.displayName) ?? ownerVisibleModelText(model.key.modelId),
    host: publicHost(model.key.host, key),
    servingProvider: ownerVisibleModelText(model.key.provider) ?? publicIdentity?.servingProvider ?? null,
    publisher: publicIdentity?.publisher ?? null,
    family: publicIdentity?.family ?? null,
    selector: ownerVisibleModelText(model.key.modelId) ?? publicIdentity?.selector ?? null,
    privacyClass: publicIdentity ? 'public-catalog' : 'owner-visible',
    links: publicIdentity?.links ?? [],
    aliases: model.aliases.map((alias) => ({
      ...alias,
      name: privateLabel('alias', alias.name, key),
      resolvesTo: privateLabel('model', alias.resolvesTo, key),
      evidenceRefs: evidenceRefs(alias.evidenceRefs),
    })),
    variant: {
      ...sanitizeVariant(privateVariant, key),
      ...(publicIdentity && model.variant?.catalog ? { catalog: {
        source: model.variant.catalog.source,
        public: true,
        servingProvider: publicIdentity.servingProvider,
        publisher: publicIdentity.publisher,
        family: publicIdentity.family,
        selector: publicIdentity.selector,
        links: publicIdentity.links,
      } } : {}),
    },
    lifecycle: {
      ...model.lifecycle,
      replacement: ownerVisibleModelText(model.lifecycle.replacement),
      replacementName: ownerVisibleModelText(model.lifecycle.replacement),
      replacementSelector: ownerVisibleModelText(model.lifecycle.replacement),
      notice: model.lifecycle.notice ? 'Lifecycle notice available in explicit CLI evidence.' : null,
      evidenceRefs: evidenceRefs(model.lifecycle.evidenceRefs),
    },
    capabilities: ownerVisibleCapabilities(model.capabilities),
    pricing: ownerVisiblePricing(model),
    edges: (model.edges ?? []).map((edge) => ({
      ...edge,
      from: privateLabel(edge.kind === 'resolves-to' ? 'alias' : 'model', edge.from, key),
      to: privateLabel('model', edge.to, key),
      scopeFingerprint: privateLabel('scope', edge.scopeFingerprint, key),
      evidenceRefs: evidenceRefs(edge.evidenceRefs),
    })),
    dimensions: Object.fromEntries(Object.entries(model.dimensions).map(([name, dimension]) => [name, {
      ...dimension, evidenceRefs: evidenceRefs(dimension.evidenceRefs),
    }])),
    evidence: model.evidence.map((entry) => sanitizeEvidence(entry, key)),
  };
}

function consumerLabel(value, key) {
  const text = String(value ?? 'consumer');
  const route = /^route:([^:]+)(?::escalation:(\d+))?$/.exec(text);
  if (route) return `${publicActivity(route[1], key) ?? 'Route'} · ${route[2] == null ? 'primary' : `fallback ${Number(route[2]) + 1}`}`;
  if (text === 'aqe:default') return 'Agentic QE · default';
  if (/^aqe:fallback:\d+$/.test(text)) return `Agentic QE · fallback ${Number(text.split(':').at(-1)) + 1}`;
  if (text.startsWith('aqe:agent:')) return `Agentic QE · ${publicActivity(text.slice('aqe:agent:'.length), key) ?? 'override'}`;
  if (/^ruflo:candidate:\d+$/.test(text)) return `Ruflo · candidate ${Number(text.split(':').at(-1)) + 1}`;
  if (/^integration:\d+$/.test(text)) return `Integration · binding ${Number(text.split(':').at(-1)) + 1}`;
  return 'Configured consumer';
}

function bindingRole(consumer) {
  const route = /^route:[^:]+(?::escalation:(\d+))?$/.exec(consumer);
  if (!route) return 'Configured consumer';
  return route[1] == null ? 'primary' : `fallback ${Number(route[1]) + 1}`;
}

function sanitizeBinding(binding, key, linkedModel) {
  const configured = ownerVisibleModelText(binding.configured);
  const effective = ownerVisibleModelText(binding.effective);
  const modelName = linkedModel?.displayName ?? configured ?? effective ?? 'Model not pinned';
  const provider = linkedModel?.servingProvider ?? ownerVisibleModelText(binding.provider);
  const published = !linkedModel && (configured || effective)
    ? priceFor(configured ?? effective, provider) : null;
  const publishedModel = configured ?? effective;
  const sourceUrl = published?.provider === 'openai' ? openAiModelDocumentation(publishedModel) : null;
  return {
    ...binding,
    id: privateLabel('binding', binding.id, key),
    consumer: consumerLabel(binding.consumer, key),
    activity: publicActivity(binding.activity, key),
    host: publicHost(binding.host, key),
    provider,
    configured,
    effective,
    evidenceRefs: (binding.evidenceRefs ?? []).map((ref) => privateLabel('evidence', ref, key)),
    modelName,
    selector: linkedModel?.selector ?? configured ?? effective,
    modelProvider: provider,
    role: bindingRole(binding.consumer),
    lifecycle: linkedModel?.lifecycle?.state ?? 'unknown',
    capabilities: linkedModel?.capabilities ?? {},
    pricing: linkedModel?.pricing ?? (published?.matched ? {
      basis: 'per-million-tokens', input: published.in, output: published.out, currency: 'USD',
      effectiveAt: null, source: sourceUrl ? 'OpenAI API model documentation' : 'published API list-price table',
      sourceUrl, asOf: PRICES_AS_OF, matched: true,
    } : null),
    // Snapshot evidence says that use was observed, but its capturedAt is the
    // refresh time—not the invocation time. Windowed usage joins the actual
    // session timestamp onto summary bindings below.
    lastUsed: null,
  };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sessionRange(session) {
  const raw = session?.start;
  const startMs = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
  if (!Number.isFinite(startMs)) return { firstUsed: null, lastUsed: null };
  const minutes = Math.max(0, finite(session?.minutes));
  return {
    firstUsed: new Date(startMs).toISOString(),
    lastUsed: new Date(startMs + minutes * 60_000).toISOString(),
  };
}

/** Project only aggregate model-use facts; session ids, titles and projects never cross this boundary. */
function observedWindow(exact, projected, usage, days) {
  const sessions = Array.isArray(usage?.sessions) ? usage.sessions : [];
  const groups = new Map();
  for (const session of sessions) {
    const host = boundedPublicText(session?.host, 64);
    const provider = boundedPublicText(session?.provider, 128);
    if (!host || !Array.isArray(session?.models)) continue;
    const range = sessionRange(session);
    for (const rawModelId of session.models) {
      const modelId = ownerVisibleModelText(rawModelId);
      if (!modelId) continue;
      const groupKey = `${host}\0${provider ?? ''}\0${modelId}`;
      let row = groups.get(groupKey);
      if (!row) {
        const candidates = exact.models.map((model, index) => ({ model, projected: projected.models[index] }))
          .filter(({ model }) => model.key.host === host && model.key.modelId === modelId);
        const match = candidates.find(({ projected: item }) => item?.privacyClass === 'public-catalog')
          ?? candidates.find(({ model }) => model.key.provider === provider)
          ?? candidates[0];
        const visible = match?.projected;
        row = {
          host: PUBLIC_HOSTS.has(host) ? host : 'unknown',
          modelName: visible?.humanName ?? visible?.displayName ?? modelId,
          selector: visible?.selector ?? modelId,
          modelProvider: provider ?? visible?.servingProvider ?? visible?.publisher ?? null,
          sessions: 0, responses: 0, tokens: 0, apiEquivalentCost: 0,
          firstUsed: null, lastUsed: null,
        };
        groups.set(groupKey, row);
      }
      row.sessions++;
      row.responses += finite(session.responses);
      row.tokens += finite(session.tokens);
      row.apiEquivalentCost += finite(session.cost);
      if (range.firstUsed && (!row.firstUsed || range.firstUsed < row.firstUsed)) row.firstUsed = range.firstUsed;
      if (range.lastUsed && (!row.lastUsed || range.lastUsed > row.lastUsed)) row.lastUsed = range.lastUsed;
    }
  }
  return {
    days, status: usage?.unavailable === true ? 'unavailable' : 'complete',
    generatedAt: typeof usage?.generatedAt === 'string' ? usage.generatedAt : null,
    models: [...groups.values()].sort((a, b) => (
      String(b.lastUsed ?? '').localeCompare(String(a.lastUsed ?? ''))
      || String(a.modelName).localeCompare(String(b.modelName), 'en-US', { sensitivity: 'base' })
    )),
  };
}

function joinWindowedRouteUse(snapshot, window) {
  const bindings = snapshot.bindings.map((binding) => {
    const selector = binding.selector ?? binding.effective ?? binding.configured;
    const matches = window.models.filter((model) => model.host === binding.host && model.selector === selector)
      .sort((a, b) => String(b.lastUsed ?? '').localeCompare(String(a.lastUsed ?? '')));
    const observed = matches[0];
    return observed ? {
      ...binding, modelProvider: observed.modelProvider ?? binding.modelProvider,
      lastUsed: observed.lastUsed, observedSessions: observed.sessions,
    } : binding;
  });
  return { ...snapshot, bindings };
}

const CHANGE_LABELS = Object.freeze({
  'model-added': 'Model added',
  'model-missing': 'Model not reported',
  'model-removed': 'Model removed',
  'lifecycle-changed': 'Lifecycle changed',
  'visibility-changed': 'Catalog visibility changed',
  'alias-target-changed': 'Alias changed',
  'capability-changed': 'Capability changed',
  'reasoning-changed': 'Reasoning options changed',
  'context-changed': 'Context window changed',
  'variant-changed': 'Model metadata changed',
  'digest-changed': 'Installed build changed',
  'pricing-changed': 'API pricing changed',
  'edges-changed': 'Compatibility guidance changed',
});

function changeLabel(kind) {
  return CHANGE_LABELS[kind] ?? String(kind ?? 'Model changed')
    .replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function safeState(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/i.test(value) ? value : 'unknown';
}

function humanField(value) {
  return safeState(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('-', ' ').toLowerCase();
}

function changeDetail(change) {
  if (change.kind === 'model-added') return 'Appeared in the latest inventory.';
  if (change.kind === 'model-missing') return 'Not reported by the latest complete source; confirmation is pending.';
  if (change.kind === 'model-removed') return 'No longer reported after repeated complete refreshes.';
  if (change.kind === 'lifecycle-changed') {
    const before = safeState(change.before?.state);
    const after = safeState(change.after?.state);
    const replacement = ownerVisibleModelText(change.after?.replacement);
    return `Lifecycle ${before} → ${after}${replacement ? `; replacement ${replacement}` : ''}.`;
  }
  if (change.kind === 'visibility-changed') {
    return `Catalog visibility ${safeState(change.before)} → ${safeState(change.after)}.`;
  }
  if (change.kind === 'alias-target-changed') return 'A configured alias now resolves to a different model.';
  if (change.kind === 'capability-changed') {
    const field = humanField(change.after?.field ?? change.before?.field);
    return `${field === 'unknown' ? 'A reported capability' : `Reported ${field} support`} changed.`;
  }
  if (change.kind === 'reasoning-changed') return 'The reported reasoning options changed.';
  if (change.kind === 'context-changed') return 'The reported context window changed.';
  if (change.kind === 'variant-changed') {
    const field = humanField(change.after?.field ?? change.before?.field);
    return `${field === 'unknown' ? 'Reported model metadata' : `Reported ${field}`} changed.`;
  }
  if (change.kind === 'digest-changed') return 'The installed model build changed; private digests remain hidden.';
  if (change.kind === 'pricing-changed') return 'The published API rate changed.';
  if (change.kind === 'edges-changed') return 'Compatibility or migration guidance changed.';
  return 'A model inventory fact changed.';
}

function sanitizeChange(change, key, linkedModel, detectedAt) {
  const rawKey = [change.after, change.before].find((value) => value && typeof value === 'object'
    && typeof value.modelId === 'string');
  const selector = linkedModel?.selector ?? ownerVisibleModelText(rawKey?.modelId);
  const modelName = linkedModel?.displayName ?? selector ?? 'Model not recorded';
  return {
    kind: change.kind,
    label: changeLabel(change.kind),
    modelName,
    selector,
    modelProvider: linkedModel?.servingProvider ?? ownerVisibleModelText(rawKey?.provider),
    host: linkedModel?.host ?? publicHost(rawKey?.host, key),
    detail: changeDetail(change),
    severity: change.severity,
    provisional: change.provisional === true,
    detectedAt,
  };
}

/**
 * Project exact CLI evidence into an owner-visible Dashboard contract.
 * The caller must supply the already-existing per-install key; this function
 * never creates state and throws closed when the key is unavailable.
 */
export function createDashboardModelReadModel(snapshotValue, options = {}) {
  const key = dashboardKey(options.key);
  const exact = createModelReadModel(snapshotValue, options);
  const sources = exact.sources.map((source) => ({
    ...source,
    id: publicSource(source.id, key),
    owner: source.owner == null ? null
      : PUBLIC_SOURCE_OWNERS.has(source.owner) ? source.owner : privateLabel('owner', source.owner, key),
    schema: publicSchema(source.schema),
    schemaVersion: typeof source.schemaVersion === 'string' ? publicSchema(source.schemaVersion) : null,
    sourceVersion: typeof source.sourceVersion === 'string' && /^v?\d+(?:\.\d+){0,3}$/.test(source.sourceVersion)
      ? source.sourceVersion : null,
    scopeFingerprint: privateLabel('scope', source.scopeFingerprint, key),
    diagnostics: source.diagnostics.map((item) => publicDiagnostic(item, key)),
  }));
  const models = exact.models.map((model) => sanitizeModel(model, key));
  const bindings = exact.bindings.map((binding) => {
    const index = exact.models.findIndex((model) => model.key.host === binding.host
      && [binding.effective, binding.configured].includes(model.key.modelId));
    return sanitizeBinding(binding, key, index < 0 ? null : models[index]);
  });
  const exactModelByIdentity = new Map(exact.models.map((model) => [model.identity, model]));
  const modelByIdentity = new Map(exact.models.map((model, index) => [model.identity, models[index]]));
  const changes = exact.changes.map((change) => sanitizeChange(
    change, key, modelByIdentity.get(change.subject), exact.capturedAt,
  ));
  const bindingById = new Map(exact.bindings.map((binding, index) => [binding.id, bindings[index]]));
  const sourceById = new Map(exact.sources.map((source, index) => [source.id, sources[index]]));
  const changeBySubject = new Map(exact.changes.map((change, index) => [change.subject, changes[index]]));
  const attention = exact.attention.map((item) => {
    if (item.kind === 'source') {
      return { ...item, subject: sourceById.get(item.subject)?.id ?? privateLabel('source', item.subject, key) };
    }
    if (item.kind === 'migration') {
      const model = modelByIdentity.get(item.subject);
      const exactModel = exactModelByIdentity.get(item.subject);
      const affectedRoutes = exact.bindings.filter((binding) => exactModel
        && binding.host === exactModel.key.host
        && [binding.effective, binding.configured].includes(exactModel.key.modelId))
        .map((binding) => bindingById.get(binding.id)).filter(Boolean)
        .map((binding) => ({
          activity: binding.activity, consumer: binding.consumer, role: binding.role,
        }));
      const activity = affectedRoutes[0]?.activity;
      const replacement = model?.lifecycle.replacementName ?? 'replacement not recorded';
      const host = model?.host;
      return {
        ...item,
        subject: model?.identity ?? privateLabel('identity', item.subject, key),
        currentModel: model?.displayName ?? model?.selector ?? 'Model not recorded',
        replacementModel: replacement,
        affectedRoutes,
        documentationUrl: lifecycleNoticeUrl(exactModel?.lifecycle.notice),
        action: activity && PUBLIC_ACTIVITIES.has(activity) && PUBLIC_HOSTS.has(host)
          ? `ak models plan --activity ${activity} --to ${host}:${replacement}` : 'ak models plan',
        reason: `${model?.displayName ?? model?.selector ?? 'Model'} is ${model?.lifecycle.state ?? 'unknown'}; recommended replacement ${replacement}`,
      };
    }
    if (item.kind === 'consumer') {
      return { ...item, subject: bindingById.get(item.subject)?.id ?? privateLabel('binding', item.subject, key) };
    }
    return { ...item, subject: changeBySubject.get(item.subject)?.modelName
      ?? privateLabel('identity', item.subject, key) };
  });
  return immutable({
    ...exact,
    snapshotId: privateLabel('snapshot', exact.snapshotId, key),
    scope: {
      ...exact.scope,
      fingerprint: privateLabel('scope', exact.scope.fingerprint, key),
      machine: null,
      project: null,
      profileFingerprints: Object.fromEntries(Object.entries(exact.scope.profileFingerprints)
        .map(([host, value]) => [publicHost(host, key), privateLabel('scope', value, key)])),
    },
    sources, models, bindings, changes, attention,
    diagnostics: exact.diagnostics.map((item) => privateLabel('diagnostic', item, key)),
    privacy: { projection: 'owner-visible-v2', exactModelIdentity: true },
  });
}

/**
 * Sanitize a complete `/api/models` payload, including history identifiers.
 * @param {any} value
 * @param {{key?: string, usage?: any, days?: number}} [options]
 */
export function createDashboardModelPayload(value, { key, usage, days = 14 } = {}) {
  if (!value || value.status === 'empty' || !value.snapshot) return immutable({
    status: 'empty', snapshot: null, history: [], hint: 'ak models refresh',
  });
  const privateKey = dashboardKey(key);
  const changes = value.snapshot.changes ?? [];
  const exact = createModelReadModel(value.snapshot, { changes });
  let snapshot = createDashboardModelReadModel(exact, { key, changes });
  const window = observedWindow(exact, snapshot, usage, days);
  if (usage) snapshot = joinWindowedRouteUse(snapshot, window);
  const timestamp = (entry) => {
    if (typeof entry !== 'string') return null;
    const parsed = Date.parse(entry);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };
  return immutable({
    status: ['cached', 'complete', 'partial', 'stale'].includes(value.status) ? value.status : 'cached',
    snapshot, ...(usage ? { observedWindow: window } : {}),
    history: (Array.isArray(value.history) ? value.history : []).slice(0, 32)
      .flatMap((entry) => {
        const capturedAt = timestamp(entry?.capturedAt);
        const snapshotId = privateLabel('snapshot', entry?.snapshotId, privateKey);
        return capturedAt && snapshotId ? [{ snapshotId, capturedAt }] : [];
      }),
    comparison: value.comparison ? {
      baseline: privateLabel('snapshot', value.comparison.baseline, privateKey),
      latest: privateLabel('snapshot', value.comparison.latest, privateKey),
      comparable: value.comparison.comparable === true,
      diagnostics: (Array.isArray(value.comparison.diagnostics) ? value.comparison.diagnostics : [])
        .slice(0, 32).map((item) => privateLabel('diagnostic', item, privateKey)),
    } : undefined,
  });
}

/**
 * Additive Dashboard query views. The legacy/default view retains the complete
 * `/api/models` contract; summary and inventory make the large model list lazy.
 */
/** @param {any} value @param {{key?: string, query?: URLSearchParams|string, usage?: any, days?: number}} [options] */
export function createDashboardModelViewPayload(value, { key, query, usage, days } = {}) {
  return dashboardModelView(createDashboardModelPayload(value, { key, usage, days }), query);
}
