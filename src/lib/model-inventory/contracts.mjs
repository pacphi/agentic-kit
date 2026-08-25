import { immutable } from '../adapters/schema.mjs';

export const MODEL_INVENTORY_SCHEMA_VERSION = 1;
export const MODEL_DIMENSIONS = Object.freeze([
  'configured', 'effective', 'observed', 'discoverable',
  'entitled', 'policyAllowed', 'routable', 'recommended',
]);
export const SOURCE_STATUSES = Object.freeze([
  'complete', 'partial', 'stale', 'unavailable', 'unsupported', 'unsupported-schema',
]);
export const EVIDENCE_CLASSES = Object.freeze([
  'configured', 'observed', 'catalog', 'runtime', 'first-party', 'inferred', 'unknown',
]);
export const LIFECYCLE_STATES = Object.freeze([
  'active', 'preview', 'hidden', 'deprecated', 'retiring', 'removed', 'unknown',
]);
export const CONSUMER_STATES = Object.freeze([
  'configured', 'reported', 'runtime-proven', 'unknown',
]);
export const MODEL_EDGE_KINDS = Object.freeze([
  'resolves-to', 'first-party-migration', 'same-family-newer',
  'mechanically-compatible', 'tier-up', 'tier-down', 'specialized-alternative',
]);

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, field, { nullable = false, max = 512 } = {}) => {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string${nullable ? ' or null' : ''}`);
  }
  return value;
};
const iso = (value, field, { nullable = true } = {}) => {
  if (nullable && value == null) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${field} must be an ISO timestamp${nullable ? ' or null' : ''}`);
  return new Date(ms).toISOString();
};
const enumValue = (value, allowed, field) => {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
};
const strings = (value, field) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
};

export function modelIdentityKey({ host, provider = null, modelId, scopeId, digest = null }) {
  return [
    text(host, 'model.key.host', { max: 128 }),
    provider == null ? '' : text(provider, 'model.key.provider', { max: 256 }),
    text(modelId, 'model.key.modelId', { max: 256 }),
    text(scopeId, 'model.key.scopeId', { max: 256 }),
    digest == null ? '' : text(digest, 'model.key.digest', { max: 256 }),
  ].map((part) => encodeURIComponent(part)).join('|');
}

export function normalizeEvidence(value, index = 0) {
  if (!plain(value)) throw new TypeError(`evidence[${index}] must be an object`);
  const id = text(value.id ?? `evidence-${index}`, `evidence[${index}].id`, { max: 256 });
  const completeness = value.completeness ?? 'unknown';
  if (!['complete', 'partial', 'unknown'].includes(completeness)) {
    throw new TypeError(`evidence[${index}].completeness must be complete, partial, or unknown`);
  }
  const freshness = value.freshness ?? 'unknown';
  if (!['fresh', 'stale', 'unknown'].includes(freshness)) {
    throw new TypeError(`evidence[${index}].freshness must be fresh, stale, or unknown`);
  }
  return immutable({
    id,
    field: text(value.field, `evidence[${index}].field`, { max: 256 }),
    source: text(value.source, `evidence[${index}].source`, { max: 256 }),
    class: enumValue(value.class ?? 'unknown', EVIDENCE_CLASSES, `evidence[${index}].class`),
    capturedAt: iso(value.capturedAt, `evidence[${index}].capturedAt`),
    freshness,
    completeness,
    scopeFingerprint: value.scopeFingerprint == null
      ? null : text(value.scopeFingerprint, `evidence[${index}].scopeFingerprint`, { max: 256 }),
    refs: strings(value.refs, `evidence[${index}].refs`),
  });
}

function normalizeDimension(value, field) {
  const input = plain(value) ? value : { value };
  if (input.value !== true && input.value !== false && input.value !== null && input.value !== undefined) {
    throw new TypeError(`${field}.value must be true, false, or null`);
  }
  return immutable({
    value: input.value ?? null,
    evidenceRefs: strings(input.evidenceRefs, `${field}.evidenceRefs`),
  });
}

function normalizeAlias(value, index) {
  if (!plain(value)) throw new TypeError(`aliases[${index}] must be an object`);
  return immutable({
    name: text(value.name, `aliases[${index}].name`, { max: 256 }),
    resolvesTo: value.resolvesTo == null
      ? null : text(value.resolvesTo, `aliases[${index}].resolvesTo`, { max: 256 }),
    observedAt: iso(value.observedAt, `aliases[${index}].observedAt`),
    evidenceRefs: strings(value.evidenceRefs, `aliases[${index}].evidenceRefs`),
  });
}

export function normalizeModelEdge(value, index = 0) {
  if (!plain(value)) throw new TypeError(`edges[${index}] must be an object`);
  return immutable({
    kind: enumValue(value.kind, MODEL_EDGE_KINDS, `edges[${index}].kind`),
    from: text(value.from, `edges[${index}].from`, { max: 512 }),
    to: text(value.to, `edges[${index}].to`, { max: 512 }),
    provenance: enumValue(value.provenance ?? 'unknown',
      ['configured', 'first-party', 'observed', 'derived', 'unknown'], `edges[${index}].provenance`),
    scopeFingerprint: text(value.scopeFingerprint, `edges[${index}].scopeFingerprint`, { max: 256 }),
    evidenceRefs: strings(value.evidenceRefs, `edges[${index}].evidenceRefs`),
  });
}

function normalizePricing(value) {
  if (value == null) return null;
  if (!plain(value)) throw new TypeError('model.pricing must be an object or null');
  const amount = (name) => {
    const entry = value[name];
    if (entry == null) return null;
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
      throw new TypeError(`model.pricing.${name} must be a non-negative finite number or null`);
    }
    return entry;
  };
  return immutable({
    basis: value.basis == null ? null : text(value.basis, 'model.pricing.basis', { max: 128 }),
    input: amount('input'), output: amount('output'),
    currency: value.currency == null ? null : text(value.currency, 'model.pricing.currency', { max: 16 }),
    effectiveAt: iso(value.effectiveAt, 'model.pricing.effectiveAt'),
    evidenceRefs: strings(value.evidenceRefs, 'model.pricing.evidenceRefs'),
  });
}

export function normalizeModelRecord(value) {
  if (!plain(value)) throw new TypeError('model must be an object');
  if (!plain(value.key)) throw new TypeError('model.key must be an object');
  const key = {
    host: text(value.key.host, 'model.key.host', { max: 128 }),
    provider: value.key.provider == null
      ? null : text(value.key.provider, 'model.key.provider', { max: 256 }),
    modelId: text(value.key.modelId, 'model.key.modelId', { max: 256 }),
    scopeId: text(value.key.scopeId, 'model.key.scopeId', { max: 256 }),
    digest: value.key.digest == null ? null : text(value.key.digest, 'model.key.digest', { max: 256 }),
  };
  const evidence = (value.evidence ?? []).map(normalizeEvidence);
  const evidenceIds = new Set(evidence.map(({ id }) => id));
  if (evidenceIds.size !== evidence.length) throw new TypeError('model.evidence contains duplicate ids');
  const dimensions = Object.fromEntries(MODEL_DIMENSIONS.map((name) => [
    name, normalizeDimension(value.dimensions?.[name], `model.dimensions.${name}`),
  ]));
  for (const [name, dimension] of Object.entries(dimensions)) {
    for (const ref of dimension.evidenceRefs) {
      if (!evidenceIds.has(ref)) throw new TypeError(`model.dimensions.${name} references unknown evidence ${ref}`);
    }
  }
  const lifecycle = plain(value.lifecycle) ? value.lifecycle : {};
  const aliases = (value.aliases ?? []).map(normalizeAlias);
  const edges = (value.edges ?? []).map(normalizeModelEdge);
  const pricing = normalizePricing(value.pricing);
  for (const [field, refs] of [
    ['lifecycle', lifecycle.evidenceRefs], ['pricing', pricing?.evidenceRefs],
    ...aliases.map((alias, index) => [`aliases[${index}]`, alias.evidenceRefs]),
    ...edges.map((edge, index) => [`edges[${index}]`, edge.evidenceRefs]),
  ]) {
    for (const ref of refs ?? []) {
      if (!evidenceIds.has(ref)) throw new TypeError(`model.${field} references unknown evidence ${ref}`);
    }
  }
  return immutable({
    key: immutable(key),
    identity: modelIdentityKey(key),
    displayName: value.displayName == null ? key.modelId
      : text(value.displayName, 'model.displayName', { max: 256 }),
    aliases,
    visibility: value.visibility == null ? 'unknown'
      : text(value.visibility, 'model.visibility', { max: 64 }),
    variant: immutable(structuredClone(plain(value.variant) ? value.variant : {})),
    lifecycle: immutable({
      state: enumValue(lifecycle.state ?? 'unknown', LIFECYCLE_STATES, 'model.lifecycle.state'),
      replacement: lifecycle.replacement == null ? null
        : text(lifecycle.replacement, 'model.lifecycle.replacement', { max: 256 }),
      notice: lifecycle.notice == null ? null
        : text(lifecycle.notice, 'model.lifecycle.notice', { max: 1_024 }),
      effectiveAt: iso(lifecycle.effectiveAt, 'model.lifecycle.effectiveAt'),
      evidenceRefs: strings(lifecycle.evidenceRefs, 'model.lifecycle.evidenceRefs'),
    }),
    capabilities: immutable(structuredClone(plain(value.capabilities) ? value.capabilities : {})),
    pricing,
    edges,
    dimensions: immutable(dimensions),
    evidence,
  });
}

export function normalizeBindingRecord(value, index = 0) {
  if (!plain(value)) throw new TypeError(`bindings[${index}] must be an object`);
  const consumerState = value.consumerState ?? 'unknown';
  return immutable({
    id: text(value.id ?? `binding-${index}`, `bindings[${index}].id`, { max: 256 }),
    consumer: text(value.consumer, `bindings[${index}].consumer`, { max: 256 }),
    consumerState: enumValue(consumerState, CONSUMER_STATES, `bindings[${index}].consumerState`),
    activity: value.activity == null ? null
      : text(value.activity, `bindings[${index}].activity`, { max: 128 }),
    host: value.host == null ? null : text(value.host, `bindings[${index}].host`, { max: 128 }),
    provider: value.provider == null ? null
      : text(value.provider, `bindings[${index}].provider`, { max: 256 }),
    configured: value.configured == null ? null
      : text(value.configured, `bindings[${index}].configured`, { max: 256 }),
    effective: value.effective == null ? null
      : text(value.effective, `bindings[${index}].effective`, { max: 256 }),
    provenance: enumValue(value.provenance ?? 'unknown',
      ['observed', 'configured', 'inferred', 'unknown'], `bindings[${index}].provenance`),
    drift: value.drift === true,
    evidenceRefs: strings(value.evidenceRefs, `bindings[${index}].evidenceRefs`),
  });
}

export function normalizeSourceResult(value, index = 0) {
  if (!plain(value)) throw new TypeError(`sources[${index}] must be an object`);
  const status = enumValue(value.status, SOURCE_STATUSES, `sources[${index}].status`);
  return immutable({
    id: text(value.id, `sources[${index}].id`, { max: 256 }),
    owner: value.owner == null ? null : text(value.owner, `sources[${index}].owner`, { max: 128 }),
    ownerType: value.ownerType == null ? null
      : enumValue(value.ownerType, ['host', 'provider', 'usage'], `sources[${index}].ownerType`),
    transport: value.transport == null ? null
      : enumValue(value.transport, ['file', 'command', 'http', 'index'], `sources[${index}].transport`),
    network: value.network == null ? null
      : enumValue(value.network, ['never', 'local', 'explicit'], `sources[${index}].network`),
    mode: enumValue(value.mode ?? 'local', ['local', 'online'], `sources[${index}].mode`),
    status,
    complete: status === 'complete' && value.complete !== false,
    capturedAt: iso(value.capturedAt, `sources[${index}].capturedAt`),
    sourceVersion: value.sourceVersion == null ? null
      : text(value.sourceVersion, `sources[${index}].sourceVersion`, { max: 256 }),
    schemaVersion: value.schemaVersion ?? null,
    schema: value.schema == null ? null : text(value.schema, `sources[${index}].schema`, { max: 256 }),
    scopeFingerprint: value.scopeFingerprint == null ? null
      : text(value.scopeFingerprint, `sources[${index}].scopeFingerprint`, { max: 256 }),
    diagnostics: strings(value.diagnostics, `sources[${index}].diagnostics`),
  });
}

export function normalizeScope(value) {
  if (!plain(value)) throw new TypeError('snapshot.scope must be an object');
  const profiles = plain(value.profileFingerprints) ? value.profileFingerprints : {};
  return immutable({
    fingerprint: text(value.fingerprint, 'snapshot.scope.fingerprint', { max: 256 }),
    machine: value.machine == null ? null : text(value.machine, 'snapshot.scope.machine', { max: 256 }),
    project: value.project == null ? null : text(value.project, 'snapshot.scope.project', { max: 256 }),
    hosts: strings(value.hosts, 'snapshot.scope.hosts'),
    profileFingerprints: immutable(Object.fromEntries(Object.entries(profiles).map(([host, fingerprint]) => [
      text(host, 'snapshot.scope.profileFingerprints host', { max: 128 }),
      text(fingerprint, `snapshot.scope.profileFingerprints.${host}`, { max: 256 }),
    ]))),
  });
}

export function normalizeSnapshot(value) {
  if (!plain(value)) throw new TypeError('snapshot must be an object');
  if (value.schemaVersion !== MODEL_INVENTORY_SCHEMA_VERSION) {
    throw new TypeError(`unsupported model inventory schemaVersion ${String(value.schemaVersion)}`);
  }
  const models = (value.models ?? []).map(normalizeModelRecord);
  if (new Set(models.map(({ identity }) => identity)).size !== models.length) {
    throw new TypeError('snapshot.models contains duplicate identities');
  }
  const bindings = (value.bindings ?? []).map(normalizeBindingRecord);
  if (new Set(bindings.map(({ id }) => id)).size !== bindings.length) {
    throw new TypeError('snapshot.bindings contains duplicate ids');
  }
  return immutable({
    schemaVersion: MODEL_INVENTORY_SCHEMA_VERSION,
    snapshotId: text(value.snapshotId, 'snapshot.snapshotId', { max: 256 }),
    capturedAt: iso(value.capturedAt, 'snapshot.capturedAt', { nullable: false }),
    scope: normalizeScope(value.scope),
    sources: (value.sources ?? []).map(normalizeSourceResult),
    models,
    bindings,
    changes: immutable(structuredClone(Array.isArray(value.changes) ? value.changes : [])),
    opportunities: immutable(structuredClone(Array.isArray(value.opportunities) ? value.opportunities : [])),
    diagnostics: strings(value.diagnostics, 'snapshot.diagnostics'),
  });
}

export function isCompleteStableSnapshot(value) {
  let snapshot;
  try { snapshot = normalizeSnapshot(value); } catch { return false; }
  return snapshot.sources.length > 0 && snapshot.sources.every((source) =>
    source.status === 'complete' && source.complete
    && source.scopeFingerprint === snapshot.scope.fingerprint);
}
