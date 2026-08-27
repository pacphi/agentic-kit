import { createHash, createHmac } from 'node:crypto';

export const MAX_CONFIG_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
export const MAX_MODELS = 2048;

/** Non-identifying, stable scope key. Raw account/project/profile values never leave this function. */
export function scopeFingerprint(owner, scope = {}, key) {
  if (typeof key !== 'string' || key.length < 16) throw new TypeError('scope fingerprint key is required');
  const stable = Object.entries(scope ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n');
  return `scope:${createHmac('sha256', key).update(`${owner}\n${stable || 'default'}`).digest('hex').slice(0, 16)}`;
}

export function sourceRecord({
  id, owner, ownerType = null, transport = null, network = null, mode = 'local', scope, scopeKey,
  capturedAt, complete, schema, sourceVersion = null, freshness = 'current', status = null,
  diagnostics = [], evidenceClass = null, refs = [],
}) {
  const fingerprint = scopeFingerprint(owner, scope, scopeKey);
  return {
    id, owner, ownerType, transport, network, mode, schema, schemaVersion: schema, sourceVersion,
    capturedAt: capturedAt ?? new Date().toISOString(),
    scopeId: fingerprint, scopeFingerprint: fingerprint,
    complete: Boolean(complete), freshness,
    status: status ?? (complete ? (freshness === 'stale' ? 'stale' : 'complete') : 'partial'),
    diagnostics, evidenceClass, refs,
  };
}

export function diagnostic(code, message) {
  return { code, message: String(message ?? code).slice(0, 240) };
}

function resolveEvidenceClass(source) {
  return source.evidenceClass ?? (source.id === 'usage-index' ? 'observed'
    : source.id.includes('config') ? 'configured' : 'catalog');
}

function normalizedModelStates(states) {
  return {
    configured: 'unknown', effective: 'unknown', observed: 'unknown', discoverable: 'unknown',
    entitled: 'unknown', policyAllowed: 'unknown', routable: 'unknown', recommended: 'unknown',
    ...states,
  };
}

function makeEvidenceFor({
  source, safeHost, provider, modelId, scopeId, evidenceClass, evidence,
}) {
  return (field, klass = evidenceClass) => {
    const id = `evidence:${createHash('sha256').update([
      source.id, safeHost, provider ?? '', modelId, scopeId, field, source.capturedAt,
    ].join('\n')).digest('hex').slice(0, 24)}`;
    evidence.push({
      id, field, source: source.id, class: klass, capturedAt: source.capturedAt,
      freshness: source.freshness === 'stale' ? 'stale' : 'fresh',
      completeness: source.complete ? 'complete' : 'partial', scopeFingerprint: scopeId,
      refs: Array.isArray(source.refs) ? source.refs : [],
    });
    return id;
  };
}

function stateDimensions(normalizedStates, evidenceFor) {
  return Object.fromEntries(Object.entries(normalizedStates).map(([name, value]) => [name, {
    value: value === 'unknown' ? null : Boolean(value),
    evidenceRefs: value === 'unknown' ? [] : [evidenceFor(`dimensions.${name}`)],
  }]));
}

function resolveReplacement(lifecycle) {
  return lifecycle?.replacement && typeof lifecycle.replacement === 'object'
    ? lifecycle.replacement.modelId : lifecycle?.replacement ?? null;
}

function normalizedModelAliases(aliases, evidenceFor) {
  return aliases.map((alias) => ({
    name: alias.name, resolvesTo: alias.resolvesTo ?? null, observedAt: alias.observedAt ?? null,
    evidenceRefs: [evidenceFor(`aliases.${alias.name}`)],
  }));
}

function lifecycleEvidenceRefs(lifecycle, replacement, evidenceClass, evidenceFor) {
  const lifecycleKnown = lifecycle?.state && lifecycle.state !== 'unknown';
  return lifecycleKnown || replacement
    ? [evidenceFor('lifecycle', replacement ? 'first-party' : evidenceClass)] : [];
}

function normalizedModelPricing(pricing, evidenceFor) {
  return pricing == null ? null : {
    ...pricing,
    evidenceRefs: pricing.evidenceRefs?.length ? pricing.evidenceRefs : [evidenceFor('pricing')],
  };
}

function modelEdges({
  normalizedAliases, replacement, modelId, scopeId, evidenceClass, lifecycleEvidence,
}) {
  return [
    ...normalizedAliases.filter(({ resolvesTo }) => resolvesTo).map((alias) => ({
      kind: 'resolves-to', from: alias.name, to: alias.resolvesTo,
      provenance: evidenceClass === 'first-party' ? 'first-party' : 'configured',
      scopeFingerprint: scopeId, evidenceRefs: alias.evidenceRefs,
    })),
    ...(replacement ? [{
      kind: 'first-party-migration', from: modelId, to: replacement,
      provenance: 'first-party', scopeFingerprint: scopeId, evidenceRefs: lifecycleEvidence,
    }] : []),
  ];
}

export function modelRecord({
  host, provider = null, modelId, scopeId, displayName = null, aliases = [],
  variant = {}, lifecycle = /** @type {any} */ ({ state: 'unknown', replacement: null }),
  states = /** @type {any} */ ({}), capabilities = {}, pricing = null, digest = null, source,
}) {
  const safeHost = host || 'unknown';
  const evidenceClass = resolveEvidenceClass(source);
  const normalizedStates = normalizedModelStates(states);
  const evidence = [];
  const evidenceFor = makeEvidenceFor({
    source, safeHost, provider, modelId, scopeId, evidenceClass, evidence,
  });
  // Call order below is load-bearing: dimensions, then aliases, then lifecycle,
  // then digest, then variant fields, then capability fields, then pricing —
  // each evidenceFor() call appends to `evidence` in this exact sequence, and
  // at least one caller (Codex's discoverCodex) indexes evidence[0] positionally.
  const dimensions = stateDimensions(normalizedStates, evidenceFor);
  const replacement = resolveReplacement(lifecycle);
  const normalizedAliases = normalizedModelAliases(aliases, evidenceFor);
  const lifecycleEvidence = lifecycleEvidenceRefs(lifecycle, replacement, evidenceClass, evidenceFor);
  if (digest) evidenceFor('key.digest');
  for (const field of Object.keys(variant)) evidenceFor(`variant.${field}`);
  for (const field of Object.keys(capabilities)) evidenceFor(`capabilities.${field}`);
  const normalizedPricing = normalizedModelPricing(pricing, evidenceFor);
  const edges = modelEdges({
    normalizedAliases, replacement, modelId, scopeId, evidenceClass, lifecycleEvidence,
  });
  return {
    key: { host: safeHost, provider, modelId, scopeId, digest },
    identity: { host: safeHost, provider, modelId, scopeId, digest },
    displayName: displayName || modelId,
    aliases: normalizedAliases,
    visibility: states.discoverable === true ? 'visible' : states.discoverable === false ? 'hidden' : 'unknown',
    variant,
    lifecycle: {
      state: lifecycle?.state ?? 'unknown', replacement, notice: lifecycle?.notice ?? null,
      effectiveAt: lifecycle?.effectiveAt ?? null, evidenceRefs: lifecycleEvidence,
    },
    capabilities, pricing: normalizedPricing, edges, dimensions,
    states: normalizedStates,
    evidence,
  };
}

// Executable dispatch is intentionally separate from adapters/registries.mjs's
// immutable metadata. Dynamic imports keep the pure parser modules independently testable.
export const DISCOVERY_DISPATCH = Object.freeze({
  claude: async (options) => (await import('./claude.mjs')).discoverClaude(options),
  codex: async (options) => (await import('./codex.mjs')).discoverCodex(options),
  opencode: async (options) => options?.raw !== undefined
    ? (await import('./opencode.mjs')).discoverOpenCode(options)
    : (await import('./opencode.mjs')).collectOpenCode(options),
  ollama: async (options) => options?.raw !== undefined
    ? (await import('./ollama.mjs')).discoverOllama(options)
    : (await import('./ollama.mjs')).collectOllama(options),
});

export async function discoverModels(owner, options = {}) {
  const collector = DISCOVERY_DISPATCH[owner];
  if (!collector) throw new TypeError(`unsupported model discovery owner: ${String(owner)}`);
  return collector(options);
}
