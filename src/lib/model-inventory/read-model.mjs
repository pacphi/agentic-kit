import { createHmac } from 'node:crypto';
import { immutable } from '../adapters/schema.mjs';
import { ACTIVITIES } from '../routing.mjs';
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
  const migrations = snapshot.models.filter(({ lifecycle }) => lifecycle.replacement != null);
  const aliasChanges = changeRows.filter(({ kind }) => kind === 'alias-target-changed');
  const staleSources = snapshot.sources.filter(({ status }) => status !== 'complete');
  const driftedConsumers = snapshot.bindings.filter(({ drift }) => drift);
  const attention = [
    ...staleSources.map((source) => ({ kind: 'source', severity: 'warn', subject: source.id, reason: source.status })),
    ...migrations.map((model) => ({
      kind: 'migration', severity: 'warn', subject: model.identity,
      reason: `${model.lifecycle.state} → ${model.lifecycle.replacement}`,
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
  'ollama-ls-v1', 'usage-models-v1', 'usage-index-v6',
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
  'text', 'audio', 'image', 'video', 'pdf',
]);

function sanitizeVariant(value, key, field = '', depth = 0) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeVariant(entry, key, field, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? privateLabel('variant', value, key) : value;
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

function boundedPublicText(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && ![...value].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
    ? value : null;
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
    return {
      humanName: boundedPublicText(model.displayName) ?? model.key.modelId,
      selector: model.key.modelId, servingProvider: null, publisher: 'OpenAI',
      family: boundedPublicText(model.variant?.family),
      links: [{ kind: 'documentation', label: 'Codex models', url: 'https://developers.openai.com/codex/models/' }],
    };
  }
  if (model.key.host === 'claude' && OFFICIAL_CLAUDE_IDS.has(model.key.modelId)
    && hasEvidence(model, (entry) => entry.source === 'claude-config'
      && ['configured', 'first-party'].includes(entry.class))) {
    return {
      humanName: claudeHumanName(model.key.modelId), selector: model.key.modelId,
      servingProvider: model.key.provider === 'anthropic' ? 'anthropic' : null,
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

function sanitizeModel(model, key, publicModels = new Map()) {
  const evidenceIds = new Map(model.evidence.map(({ id }) => [id, privateLabel('evidence', id, key)]));
  const evidenceRefs = (refs = []) => refs.map((ref) => evidenceIds.get(ref)
    ?? privateLabel('evidence', ref, key));
  const modelLabel = privateLabel('model', model.key.modelId, key);
  const publicIdentity = publicModelIdentity(model);
  const lifecycleEvidence = new Set(model.lifecycle.evidenceRefs ?? []);
  const replacementIdentity = model.lifecycle.replacement
    && hasEvidence(model, (entry) => lifecycleEvidence.has(entry.id) && entry.class === 'first-party')
    ? publicModels.get(`${model.key.host}\0${model.lifecycle.replacement}`) ?? null : null;
  const { catalog: _catalog, ...privateVariant } = model.variant ?? {};
  return {
    ...model,
    key: {
      host: publicHost(model.key.host, key),
      provider: privateLabel('provider', model.key.provider, key),
      modelId: modelLabel,
      scopeId: privateLabel('scope', model.key.scopeId, key),
      digest: privateLabel('digest', model.key.digest, key),
    },
    identity: privateLabel('identity', model.identity, key),
    displayName: publicIdentity?.humanName ?? modelLabel,
    humanName: publicIdentity?.humanName ?? null,
    host: publicHost(model.key.host, key),
    servingProvider: publicIdentity?.servingProvider ?? null,
    publisher: publicIdentity?.publisher ?? null,
    family: publicIdentity?.family ?? null,
    selector: publicIdentity?.selector ?? null,
    privacyClass: publicIdentity ? 'public-catalog' : 'private',
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
      replacement: replacementIdentity?.selector
        ?? privateLabel('model', model.lifecycle.replacement, key),
      replacementName: replacementIdentity?.humanName ?? null,
      replacementSelector: replacementIdentity?.selector ?? null,
      notice: model.lifecycle.notice ? 'Lifecycle notice available in explicit CLI evidence.' : null,
      evidenceRefs: evidenceRefs(model.lifecycle.evidenceRefs),
    },
    pricing: (() => {
      if (!model.pricing) return null;
      const refs = new Set(model.pricing.evidenceRefs ?? []);
      const safe = model.evidence.some((entry) => refs.has(entry.id)
        && PUBLIC_SOURCES.has(entry.source)
        && ['catalog', 'first-party'].includes(entry.class));
      if (!safe) return null;
      return {
        basis: ['per-token', 'per-million-tokens', 'zero'].includes(model.pricing.basis)
          ? model.pricing.basis : null,
        input: model.pricing.input,
        output: model.pricing.output,
        currency: /^[A-Z]{3}$/.test(model.pricing.currency ?? '') ? model.pricing.currency : null,
        effectiveAt: model.pricing.effectiveAt,
        evidenceRefs: evidenceRefs(model.pricing.evidenceRefs),
      };
    })(),
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
  const family = text.startsWith('route:') ? 'route'
    : text.startsWith('escalation:') ? 'escalation'
      : text.startsWith('aqe:') ? 'agentic-qe'
        : text.startsWith('ruflo:') ? 'ruflo'
          : text.startsWith('integration:') ? 'integration' : 'consumer';
  return `${family} · ${privateLabel('binding', text, key)}`;
}

function sanitizeBinding(binding, key) {
  return {
    ...binding,
    id: privateLabel('binding', binding.id, key),
    consumer: consumerLabel(binding.consumer, key),
    activity: publicActivity(binding.activity, key),
    host: publicHost(binding.host, key),
    provider: privateLabel('provider', binding.provider, key),
    configured: privateLabel('model', binding.configured, key),
    effective: privateLabel('model', binding.effective, key),
    evidenceRefs: (binding.evidenceRefs ?? []).map((ref) => privateLabel('evidence', ref, key)),
  };
}

function sanitizeChangeValue(value, key, field = '') {
  if (Array.isArray(value)) return value.map((entry) => sanitizeChangeValue(entry, key, field));
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    if (field === 'host') return publicHost(value, key);
    if (['state', 'visibility', 'severity', 'kind', 'field'].includes(field)) return value;
    return privateLabel(field === 'name' ? 'alias' : field === 'provider' ? 'provider' : 'model', value, key);
  }
  return Object.fromEntries(Object.entries(value)
    .map(([name, entry]) => [name, sanitizeChangeValue(entry, key, name)]));
}

function sanitizeChange(change, key) {
  return {
    ...change,
    subject: privateLabel('identity', change.subject, key),
    before: sanitizeChangeValue(change.before, key),
    after: sanitizeChangeValue(change.after, key),
    evidenceRefs: (change.evidenceRefs ?? []).map((ref) => privateLabel('evidence', ref, key)),
  };
}

/**
 * Project exact CLI evidence into a keyed, pseudonymous Dashboard contract.
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
  const publicModels = new Map();
  const ambiguousPublicModels = new Set();
  for (const model of exact.models) {
    const identity = publicModelIdentity(model);
    if (!identity) continue;
    const indexKey = `${model.key.host}\0${model.key.modelId}`;
    if (publicModels.has(indexKey)) ambiguousPublicModels.add(indexKey);
    else publicModels.set(indexKey, identity);
  }
  for (const indexKey of ambiguousPublicModels) publicModels.delete(indexKey);
  const models = exact.models.map((model) => sanitizeModel(model, key, publicModels));
  const bindings = exact.bindings.map((binding) => sanitizeBinding(binding, key));
  const changes = exact.changes.map((change) => sanitizeChange(change, key));
  const modelByIdentity = new Map(exact.models.map((model, index) => [model.identity, models[index]]));
  const bindingById = new Map(exact.bindings.map((binding, index) => [binding.id, bindings[index]]));
  const sourceById = new Map(exact.sources.map((source, index) => [source.id, sources[index]]));
  const changeBySubject = new Map(exact.changes.map((change, index) => [change.subject, changes[index]]));
  const attention = exact.attention.map((item) => {
    if (item.kind === 'source') {
      return { ...item, subject: sourceById.get(item.subject)?.id ?? privateLabel('source', item.subject, key) };
    }
    if (item.kind === 'migration') {
      const model = modelByIdentity.get(item.subject);
      return { ...item, subject: model?.identity ?? privateLabel('identity', item.subject, key),
        reason: `${model?.lifecycle.state ?? 'unknown'} → ${model?.lifecycle.replacement ?? 'private target'}` };
    }
    if (item.kind === 'consumer') {
      return { ...item, subject: bindingById.get(item.subject)?.id ?? privateLabel('binding', item.subject, key) };
    }
    return { ...item, subject: changeBySubject.get(item.subject)?.subject
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
    privacy: { projection: 'keyed-v1', exactIdentifiers: false },
  });
}

/**
 * Sanitize a complete `/api/models` payload, including history identifiers.
 * @param {any} value
 * @param {{key?: string}} [options]
 */
export function createDashboardModelPayload(value, { key } = {}) {
  if (!value || value.status === 'empty' || !value.snapshot) return immutable({
    status: 'empty', snapshot: null, history: [], hint: 'ak models refresh',
  });
  const privateKey = dashboardKey(key);
  const changes = value.snapshot.changes ?? [];
  const snapshot = createDashboardModelReadModel(value.snapshot, { key, changes });
  const timestamp = (entry) => {
    if (typeof entry !== 'string') return null;
    const parsed = Date.parse(entry);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };
  return immutable({
    status: ['cached', 'complete', 'partial', 'stale'].includes(value.status) ? value.status : 'cached',
    snapshot, history: (Array.isArray(value.history) ? value.history : []).slice(0, 32)
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
/** @param {any} value @param {{key?: string, query?: URLSearchParams|string}} [options] */
export function createDashboardModelViewPayload(value, { key, query } = {}) {
  return dashboardModelView(createDashboardModelPayload(value, { key }), query);
}
