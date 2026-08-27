import { createHmac } from 'node:crypto';
import { immutable } from '../adapters/schema.mjs';
import { ACTIVITIES } from '../routing.mjs';
import { PRICES_AS_OF, priceFor } from '../pricing.mjs';
import { normalizeSnapshot } from './contracts.mjs';
import { dashboardModelView } from './dashboard-query.mjs';
import {
  ANTHROPIC_MODELS_URL, ANTHROPIC_OFFICIAL_MODEL_IDS, ANTHROPIC_PRICING_URL,
} from './discovery/anthropic-catalog.mjs';

/** @param {any} snapshotValue @param {{changes?: any[]|{changes?: any[]}}} [options] */
export function createModelReadModel(snapshotValue, options = {}) {
  const { changes } = options;
  const snapshot = normalizeSnapshot(snapshotValue);
  const changeRows = Array.isArray(changes) ? changes
    : Array.isArray(changes?.changes) ? changes.changes : snapshot.changes;
  const configuredBindings = snapshot.bindings.filter(({ configured }) => configured != null);
  const observed = snapshot.models.filter(({ dimensions }) => dimensions.observed.value === true);
  const migrations = snapshot.models.filter((model) => (
    isLocallyRelevant(model) && hasPublishedLifecycleMigration(model)
  ));
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

function isLocallyRelevant(model) {
  return ['configured', 'effective', 'observed']
    .some((name) => model.dimensions?.[name]?.value === true);
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
  'anthropic-docs', 'claude-config', 'codex-cache', 'opencode-models', 'ollama-catalog',
  'usage-index',
]);
const PUBLIC_SOURCE_SCHEMAS = new Set([
  'anthropic-public-models-v1', 'claude-settings-v1', 'codex-model-cache-v1',
  'opencode-models-lines-v1', 'ollama-ls-v1', 'ollama-api-v1', 'usage-models-v1',
  'usage-index-v6',
]);
const PUBLIC_SOURCE_OWNERS = new Set([
  'anthropic', 'claude', 'codex', 'opencode', 'ollama', 'usage',
]);

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
  'vramBytes', 'expiresAt', 'licenseSummary', 'advertisedCapabilities', 'lifecycleScope',
  'availability', 'retirementNotBefore', 'retiredAt',
]);
const OWNER_VISIBLE_VARIANT_TEXT_FIELDS = new Set([
  'modifiedAt', 'format', 'family', 'families', 'parameterSize',
  'quantizationLevel', 'expiresAt', 'licenseSummary', 'advertisedCapabilities',
  'lifecycleScope', 'availability', 'retirementNotBefore', 'retiredAt',
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
const OFFICIAL_CLAUDE_IDS = new Set(ANTHROPIC_OFFICIAL_MODEL_IDS);
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

const BOOLEAN_CAPABILITY_FIELDS = [
  'tools', 'toolcall', 'reasoning', 'structuredOutput', 'temperature', 'attachment', 'interleaved', 'embedding',
];
const LIMIT_CAPABILITY_FIELDS = ['contextLimit', 'outputLimit'];
const MODALITY_FIELDS = ['text', 'audio', 'image', 'video', 'pdf'];

function booleanCapabilityFields(value) {
  const result = {};
  for (const name of BOOLEAN_CAPABILITY_FIELDS) if (typeof value[name] === 'boolean') result[name] = value[name];
  return result;
}

function limitCapabilityFields(value) {
  const result = {};
  for (const name of LIMIT_CAPABILITY_FIELDS) {
    if (Number.isSafeInteger(value[name]) && value[name] > 0) result[name] = value[name];
  }
  return result;
}

function capabilityModalities(directionValue) {
  if (!directionValue || typeof directionValue !== 'object' || Array.isArray(directionValue)) return null;
  const result = {};
  for (const name of MODALITY_FIELDS) if (typeof directionValue[name] === 'boolean') result[name] = directionValue[name];
  return Object.keys(result).length ? result : null;
}

function directionalCapabilityFields(value) {
  const result = {};
  for (const direction of ['input', 'output']) {
    const modalities = capabilityModalities(value[direction]);
    if (modalities) result[direction] = modalities;
  }
  return result;
}

function ownerVisibleCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...booleanCapabilityFields(value), ...limitCapabilityFields(value), ...directionalCapabilityFields(value) };
}

function isValidPricingRecord(pricing) {
  return Boolean(pricing) && ['per-token', 'per-million-tokens', 'zero', 'local-compute'].includes(pricing.basis)
    && (Number.isFinite(pricing.input) || Number.isFinite(pricing.output))
    && /^[A-Z]{3}$/.test(pricing.currency ?? '');
}

function evidencedPricing(model) {
  const pricing = model.pricing;
  if (!isValidPricingRecord(pricing)) return null;
  const refs = new Set(pricing.evidenceRefs ?? []);
  const anthropicDocs = model.evidence.some((entry) => refs.has(entry.id)
    && entry.source === 'anthropic-docs' && entry.class === 'first-party');
  return {
    basis: pricing.basis, input: pricing.input, output: pricing.output, currency: pricing.currency,
    effectiveAt: pricing.effectiveAt,
    source: pricing.basis === 'local-compute' ? 'local installation evidence'
      : anthropicDocs ? 'Anthropic Models and pricing' : 'catalogue evidence',
    sourceUrl: anthropicDocs ? ANTHROPIC_PRICING_URL : null,
    asOf: anthropicDocs ? PRICES_AS_OF : null, matched: true,
  };
}

function publishedPricing(model) {
  const published = priceFor(model.key.modelId, model.key.provider);
  if (!published.matched) return null;
  const sourceUrl = published.provider === 'openai' ? openAiModelDocumentation(model.key.modelId) : null;
  return {
    basis: 'per-million-tokens', input: published.in, output: published.out, currency: 'USD',
    effectiveAt: null, source: sourceUrl ? 'OpenAI API model documentation' : 'published API list-price table',
    sourceUrl, asOf: PRICES_AS_OF, matched: true,
  };
}

function ownerVisiblePricing(model) {
  return evidencedPricing(model) ?? publishedPricing(model);
}

function trustedModelLink(entry, labels) {
  if (!entry || typeof entry !== 'object') return null;
  const kind = boundedPublicText(entry.kind, 64);
  const label = labels[kind] ?? null;
  const raw = boundedPublicText(entry.url, 2_048);
  if (!kind || !label || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !TRUSTED_MODEL_LINK_HOSTS.has(url.hostname)) return null;
    return { kind, label, url: url.href };
  } catch { return null; }
}

function trustedModelLinks(value) {
  const labels = {
    catalog: 'Models.dev', documentation: 'Documentation', provider: 'Provider',
    weights: 'Hugging Face', library: 'Model library',
  };
  const entries = Array.isArray(value) ? value : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([kind, url]) => labels[kind] && typeof url === 'string'
      ? [{ kind, label: labels[kind], url }] : []) : [];
  return entries.slice(0, 16).map((entry) => trustedModelLink(entry, labels)).filter(Boolean);
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

function codexPublicIdentity(model) {
  if (model.key.host !== 'codex' || !hasCatalogDiscovery(model, 'codex-cache')) return null;
  const modelDocumentation = openAiModelDocumentation(model.key.modelId);
  return {
    humanName: boundedPublicText(model.displayName) ?? model.key.modelId,
    selector: model.key.modelId, servingProvider: 'openai', publisher: 'OpenAI',
    family: boundedPublicText(model.variant?.family),
    links: [{ kind: 'documentation', label: modelDocumentation ? 'OpenAI API model page' : 'Codex models',
      url: modelDocumentation ?? 'https://developers.openai.com/codex/models/' }],
  };
}

function isOfficialClaudeIdentity(model) {
  return model.key.host === 'claude' && OFFICIAL_CLAUDE_IDS.has(model.key.modelId)
    && hasEvidence(model, (entry) => (entry.source === 'anthropic-docs'
      && entry.class === 'first-party') || (entry.source === 'claude-config'
      && ['configured', 'first-party'].includes(entry.class))
      || (entry.source === 'usage-index' && entry.class === 'observed'));
}

function claudePublicIdentity(model) {
  if (!isOfficialClaudeIdentity(model)) return null;
  const catalogPublic = hasEvidence(model, (entry) => entry.source === 'anthropic-docs'
    && entry.class === 'first-party');
  return {
    humanName: catalogPublic
      ? boundedPublicText(model.displayName) ?? claudeHumanName(model.key.modelId)
      : claudeHumanName(model.key.modelId),
    selector: model.key.modelId,
    servingProvider: 'anthropic',
    publisher: 'Anthropic', family: model.key.modelId.split('-')[1],
    links: [{ kind: 'documentation', label: 'Anthropic Models', url: ANTHROPIC_MODELS_URL }],
  };
}

function catalogPublicIdentity(model) {
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

/** Public identity is fail-closed: local/custom rows need an explicit catalog-public marker. */
function publicModelIdentity(model) {
  return codexPublicIdentity(model) ?? claudePublicIdentity(model) ?? catalogPublicIdentity(model);
}

function sanitizedIdentity(model, publicIdentity) {
  return {
    displayName: publicIdentity?.humanName
      ?? ownerVisibleModelText(model.displayName) ?? ownerVisibleModelText(model.key.modelId) ?? 'Model not recorded',
    humanName: publicIdentity?.humanName
      ?? ownerVisibleModelText(model.displayName) ?? ownerVisibleModelText(model.key.modelId),
    servingProvider: ownerVisibleModelText(model.key.provider) ?? publicIdentity?.servingProvider ?? null,
    publisher: publicIdentity?.publisher ?? null,
    family: publicIdentity?.family ?? null,
    selector: ownerVisibleModelText(model.key.modelId) ?? publicIdentity?.selector ?? null,
    privacyClass: publicIdentity ? 'public-catalog' : 'owner-visible',
    links: publicIdentity?.links ?? [],
  };
}

function sanitizedAliases(model, key, evidenceRefs) {
  return model.aliases.map((alias) => ({
    ...alias,
    name: privateLabel('alias', alias.name, key),
    resolvesTo: privateLabel('model', alias.resolvesTo, key),
    evidenceRefs: evidenceRefs(alias.evidenceRefs),
  }));
}

function sanitizedVariantBlock(model, key, publicIdentity, privateVariant) {
  return {
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
  };
}

function sanitizedLifecycle(model, evidenceRefs) {
  return {
    ...model.lifecycle,
    replacement: ownerVisibleModelText(model.lifecycle.replacement),
    replacementName: ownerVisibleModelText(model.lifecycle.replacement),
    replacementSelector: ownerVisibleModelText(model.lifecycle.replacement),
    notice: model.lifecycle.notice ? 'Lifecycle notice available in explicit CLI evidence.' : null,
    evidenceRefs: evidenceRefs(model.lifecycle.evidenceRefs),
  };
}

function sanitizedEdges(model, key, evidenceRefs) {
  return (model.edges ?? []).map((edge) => ({
    ...edge,
    from: privateLabel(edge.kind === 'resolves-to' ? 'alias' : 'model', edge.from, key),
    to: privateLabel('model', edge.to, key),
    scopeFingerprint: privateLabel('scope', edge.scopeFingerprint, key),
    evidenceRefs: evidenceRefs(edge.evidenceRefs),
  }));
}

function sanitizedDimensions(model, evidenceRefs) {
  return Object.fromEntries(Object.entries(model.dimensions).map(([name, dimension]) => [name, {
    ...dimension, evidenceRefs: evidenceRefs(dimension.evidenceRefs),
  }]));
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
    ...sanitizedIdentity(model, publicIdentity),
    host: publicHost(model.key.host, key),
    aliases: sanitizedAliases(model, key, evidenceRefs),
    variant: sanitizedVariantBlock(model, key, publicIdentity, privateVariant),
    lifecycle: sanitizedLifecycle(model, evidenceRefs),
    capabilities: ownerVisibleCapabilities(model.capabilities),
    pricing: ownerVisiblePricing(model),
    edges: sanitizedEdges(model, key, evidenceRefs),
    dimensions: sanitizedDimensions(model, evidenceRefs),
    evidence: model.evidence.map((entry) => sanitizeEvidence(entry, key)),
  };
}

function routeConsumerLabel(text, key) {
  const route = /^route:([^:]+)(?::escalation:(\d+))?$/.exec(text);
  if (!route) return null;
  return `${publicActivity(route[1], key) ?? 'Route'} · ${route[2] == null ? 'primary' : `fallback ${Number(route[2]) + 1}`}`;
}

function ordinalConsumerLabel(text, pattern, prefix) {
  return pattern.test(text) ? `${prefix} ${Number(text.split(':').at(-1)) + 1}` : null;
}

function agentOverrideConsumerLabel(text, key) {
  return text.startsWith('aqe:agent:')
    ? `Agentic QE · ${publicActivity(text.slice('aqe:agent:'.length), key) ?? 'override'}` : null;
}

function consumerLabel(value, key) {
  const text = String(value ?? 'consumer');
  return routeConsumerLabel(text, key)
    ?? (text === 'aqe:default' ? 'Agentic QE · default' : null)
    ?? ordinalConsumerLabel(text, /^aqe:fallback:\d+$/, 'Agentic QE · fallback')
    ?? agentOverrideConsumerLabel(text, key)
    ?? ordinalConsumerLabel(text, /^ruflo:candidate:\d+$/, 'Ruflo · candidate')
    ?? ordinalConsumerLabel(text, /^integration:\d+$/, 'Integration · binding')
    ?? 'Configured consumer';
}

function bindingRole(consumer) {
  const route = /^route:[^:]+(?::escalation:(\d+))?$/.exec(consumer);
  if (!route) return 'Configured consumer';
  return route[1] == null ? 'primary' : `fallback ${Number(route[1]) + 1}`;
}

function bindingPublishedPricing(configured, effective, provider, linkedModel) {
  if (linkedModel || !(configured || effective)) return null;
  const published = priceFor(configured ?? effective, provider);
  if (!published.matched) return null;
  const sourceUrl = published.provider === 'openai' ? openAiModelDocumentation(configured ?? effective) : null;
  return {
    basis: 'per-million-tokens', input: published.in, output: published.out, currency: 'USD',
    effectiveAt: null, source: sourceUrl ? 'OpenAI API model documentation' : 'published API list-price table',
    sourceUrl, asOf: PRICES_AS_OF, matched: true,
  };
}

function sanitizeBinding(binding, key, linkedModel) {
  const configured = ownerVisibleModelText(binding.configured);
  const effective = ownerVisibleModelText(binding.effective);
  const provider = linkedModel?.servingProvider ?? ownerVisibleModelText(binding.provider);
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
    modelName: linkedModel?.displayName ?? configured ?? effective ?? 'Model not pinned',
    selector: linkedModel?.selector ?? configured ?? effective,
    modelProvider: provider,
    role: bindingRole(binding.consumer),
    lifecycle: linkedModel?.lifecycle?.state ?? 'unknown',
    capabilities: linkedModel?.capabilities ?? {},
    pricing: linkedModel?.pricing ?? bindingPublishedPricing(configured, effective, provider, linkedModel),
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

function matchModelForSession(exact, projected, host, modelId, provider) {
  const candidates = exact.models.map((model, index) => ({ model, projected: projected.models[index] }))
    .filter(({ model }) => model.key.host === host && model.key.modelId === modelId);
  return candidates.find(({ projected: item }) => item?.privacyClass === 'public-catalog')
    ?? candidates.find(({ model }) => model.key.provider === provider)
    ?? candidates[0];
}

function newObservedGroupRow(host, provider, modelId, visible) {
  return {
    host: PUBLIC_HOSTS.has(host) ? host : 'unknown',
    modelName: visible?.humanName ?? visible?.displayName ?? modelId,
    selector: visible?.selector ?? modelId,
    modelProvider: provider ?? visible?.servingProvider ?? visible?.publisher ?? null,
    sessions: 0, responses: 0, tokens: 0, apiEquivalentCost: 0,
    firstUsed: null, lastUsed: null,
  };
}

function observedGroupRow(groups, exact, projected, host, provider, modelId) {
  const groupKey = `${host}\0${provider ?? ''}\0${modelId}`;
  let row = groups.get(groupKey);
  if (!row) {
    const match = matchModelForSession(exact, projected, host, modelId, provider);
    row = newObservedGroupRow(host, provider, modelId, match?.projected);
    groups.set(groupKey, row);
  }
  return row;
}

function accumulateSession(row, session, range) {
  row.sessions++;
  row.responses += finite(session.responses);
  row.tokens += finite(session.tokens);
  row.apiEquivalentCost += finite(session.cost);
  if (range.firstUsed && (!row.firstUsed || range.firstUsed < row.firstUsed)) row.firstUsed = range.firstUsed;
  if (range.lastUsed && (!row.lastUsed || range.lastUsed > row.lastUsed)) row.lastUsed = range.lastUsed;
}

function foldSessionIntoGroups(groups, exact, projected, session) {
  const host = boundedPublicText(session?.host, 64);
  const provider = boundedPublicText(session?.provider, 128);
  if (!host || !Array.isArray(session?.models)) return;
  const range = sessionRange(session);
  for (const rawModelId of session.models) {
    const modelId = ownerVisibleModelText(rawModelId);
    if (!modelId) continue;
    accumulateSession(observedGroupRow(groups, exact, projected, host, provider, modelId), session, range);
  }
}

function sortObservedGroups(a, b) {
  return String(b.lastUsed ?? '').localeCompare(String(a.lastUsed ?? ''))
    || String(a.modelName).localeCompare(String(b.modelName), 'en-US', { sensitivity: 'base' });
}

/** Project only aggregate model-use facts; session ids, titles and projects never cross this boundary. */
function observedWindow(exact, projected, usage, days) {
  const sessions = Array.isArray(usage?.sessions) ? usage.sessions : [];
  const groups = new Map();
  for (const session of sessions) foldSessionIntoGroups(groups, exact, projected, session);
  return {
    days, status: usage?.unavailable === true ? 'unavailable' : 'complete',
    generatedAt: typeof usage?.generatedAt === 'string' ? usage.generatedAt : null,
    models: [...groups.values()].sort(sortObservedGroups),
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

function changeDetailLifecycle(change) {
  const before = safeState(change.before?.state);
  const after = safeState(change.after?.state);
  const replacement = ownerVisibleModelText(change.after?.replacement);
  return `Lifecycle ${before} → ${after}${replacement ? `; replacement ${replacement}` : ''}.`;
}

function changeDetailVisibility(change) {
  return `Catalog visibility ${safeState(change.before)} → ${safeState(change.after)}.`;
}

function changeDetailCapability(change) {
  const field = humanField(change.after?.field ?? change.before?.field);
  return `${field === 'unknown' ? 'A reported capability' : `Reported ${field} support`} changed.`;
}

function changeDetailVariant(change) {
  const field = humanField(change.after?.field ?? change.before?.field);
  return `${field === 'unknown' ? 'Reported model metadata' : `Reported ${field}`} changed.`;
}

/** One formatter per change `kind`, mirroring CHANGE_LABELS' lookup-table shape above. */
const CHANGE_DETAIL_BY_KIND = Object.freeze({
  'model-added': () => 'Appeared in the latest inventory.',
  'model-missing': () => 'Not reported by the latest complete source; confirmation is pending.',
  'model-removed': () => 'No longer reported after repeated complete refreshes.',
  'lifecycle-changed': changeDetailLifecycle,
  'visibility-changed': changeDetailVisibility,
  'alias-target-changed': () => 'A configured alias now resolves to a different model.',
  'capability-changed': changeDetailCapability,
  'reasoning-changed': () => 'The reported reasoning options changed.',
  'context-changed': () => 'The reported context window changed.',
  'variant-changed': changeDetailVariant,
  'digest-changed': () => 'The installed model build changed; private digests remain hidden.',
  'pricing-changed': () => 'The published API rate changed.',
  'edges-changed': () => 'Compatibility or migration guidance changed.',
});

function changeDetail(change) {
  const formatter = CHANGE_DETAIL_BY_KIND[change.kind];
  return formatter ? formatter(change) : 'A model inventory fact changed.';
}

function changeRawSubject(change) {
  return [change.after, change.before].find((value) => value && typeof value === 'object'
    && typeof value.modelId === 'string');
}

function sanitizeChange(change, key, linkedModel, detectedAt) {
  const rawSubject = changeRawSubject(change);
  const selector = linkedModel?.selector ?? ownerVisibleModelText(rawSubject?.modelId);
  return {
    kind: change.kind,
    label: changeLabel(change.kind),
    modelName: linkedModel?.displayName ?? selector ?? 'Model not recorded',
    selector,
    modelProvider: linkedModel?.servingProvider ?? ownerVisibleModelText(rawSubject?.provider),
    host: linkedModel?.host ?? publicHost(rawSubject?.host, key),
    detail: changeDetail(change),
    severity: change.severity,
    provisional: change.provisional === true,
    detectedAt,
  };
}

function sanitizedSourceAttention(item, sourceById, key) {
  return { ...item, subject: sourceById.get(item.subject)?.id ?? privateLabel('source', item.subject, key) };
}

function affectedRoutesFor(exactModel, exactBindings, bindingById) {
  if (!exactModel) return [];
  return exactBindings.filter((binding) => binding.host === exactModel.key.host
    && [binding.effective, binding.configured].includes(exactModel.key.modelId))
    .map((binding) => bindingById.get(binding.id)).filter(Boolean)
    .map((binding) => ({ activity: binding.activity, consumer: binding.consumer, role: binding.role }));
}

function migrationAction(activity, host, replacement) {
  return activity && PUBLIC_ACTIVITIES.has(activity) && PUBLIC_HOSTS.has(host)
    ? `ak models plan --activity ${activity} --to ${host}:${replacement}` : 'ak models plan';
}

function sanitizedMigrationAttention(item, ctx) {
  const {
    modelByIdentity, exactModelByIdentity, exact, bindingById, key,
  } = ctx;
  const model = modelByIdentity.get(item.subject);
  const exactModel = exactModelByIdentity.get(item.subject);
  const affectedRoutes = affectedRoutesFor(exactModel, exact.bindings, bindingById);
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
    action: migrationAction(activity, host, replacement),
    reason: `${model?.displayName ?? model?.selector ?? 'Model'} is ${model?.lifecycle.state ?? 'unknown'}; recommended replacement ${replacement}`,
  };
}

function sanitizedConsumerAttention(item, bindingById, key) {
  return { ...item, subject: bindingById.get(item.subject)?.id ?? privateLabel('binding', item.subject, key) };
}

function sanitizedAliasAttention(item, changeBySubject, key) {
  return { ...item, subject: changeBySubject.get(item.subject)?.modelName ?? privateLabel('identity', item.subject, key) };
}

function sanitizeAttentionItem(item, ctx) {
  if (item.kind === 'source') return sanitizedSourceAttention(item, ctx.sourceById, ctx.key);
  if (item.kind === 'migration') return sanitizedMigrationAttention(item, ctx);
  if (item.kind === 'consumer') return sanitizedConsumerAttention(item, ctx.bindingById, ctx.key);
  return sanitizedAliasAttention(item, ctx.changeBySubject, ctx.key);
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
    sourceVersion: typeof source.sourceVersion === 'string'
      && /^(?:v?\d+(?:\.\d+){0,3}|20\d{2}-\d{2}-\d{2})$/.test(source.sourceVersion)
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
  const attentionCtx = {
    modelByIdentity, exactModelByIdentity, exact, bindingById, sourceById, changeBySubject, key,
  };
  const attention = exact.attention.map((item) => sanitizeAttentionItem(item, attentionCtx));
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

function timestampIso(entry) {
  if (typeof entry !== 'string') return null;
  const parsed = Date.parse(entry);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function dashboardHistoryEntries(history, privateKey) {
  return (Array.isArray(history) ? history : []).slice(0, 32).flatMap((entry) => {
    const capturedAt = timestampIso(entry?.capturedAt);
    const snapshotId = privateLabel('snapshot', entry?.snapshotId, privateKey);
    return capturedAt && snapshotId ? [{ snapshotId, capturedAt }] : [];
  });
}

function dashboardComparisonBlock(comparison, privateKey) {
  if (!comparison) return undefined;
  return {
    baseline: privateLabel('snapshot', comparison.baseline, privateKey),
    latest: privateLabel('snapshot', comparison.latest, privateKey),
    comparable: comparison.comparable === true,
    diagnostics: (Array.isArray(comparison.diagnostics) ? comparison.diagnostics : [])
      .slice(0, 32).map((item) => privateLabel('diagnostic', item, privateKey)),
  };
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
  return immutable({
    status: ['cached', 'complete', 'partial', 'stale'].includes(value.status) ? value.status : 'cached',
    snapshot, ...(usage ? { observedWindow: window } : {}),
    history: dashboardHistoryEntries(value.history, privateKey),
    comparison: dashboardComparisonBlock(value.comparison, privateKey),
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
