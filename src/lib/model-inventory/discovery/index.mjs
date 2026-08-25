import { createHmac } from 'node:crypto';

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
  id, owner, scope, scopeKey, capturedAt, complete, schema, freshness = 'current', status = null, diagnostics = [],
}) {
  const fingerprint = scopeFingerprint(owner, scope, scopeKey);
  return {
    id, owner, schema, schemaVersion: schema, sourceVersion: null,
    capturedAt: capturedAt ?? new Date().toISOString(),
    scopeId: fingerprint, scopeFingerprint: fingerprint,
    complete: Boolean(complete), freshness,
    status: status ?? (complete ? (freshness === 'stale' ? 'stale' : 'complete') : 'partial'),
    diagnostics,
  };
}

export function diagnostic(code, message) {
  return { code, message: String(message ?? code).slice(0, 240) };
}

export function modelRecord({ host, provider = null, modelId, scopeId, displayName = null, aliases = [],
  variant = {}, lifecycle = /** @type {any} */ ({ state: 'unknown', replacement: null }),
  states = /** @type {any} */ ({}), source }) {
  const safeHost = host || 'unknown';
  const evidenceId = `${source.id}:${modelId}:${source.capturedAt}`.slice(0, 256);
  const evidenceClass = source.id === 'usage-index' ? 'observed'
    : source.id.includes('config') ? 'configured' : 'catalog';
  const normalizedStates = {
    configured: false, effective: false, observed: false, discoverable: false,
    entitled: 'unknown', policyAllowed: 'unknown', routable: 'unknown', recommended: false,
    ...states,
  };
  const dimensions = Object.fromEntries(Object.entries(normalizedStates).map(([name, value]) => [name, {
    value: value === 'unknown' ? null : Boolean(value),
    evidenceRefs: value === 'unknown' ? [] : [evidenceId],
  }]));
  const replacement = lifecycle?.replacement && typeof lifecycle.replacement === 'object'
    ? lifecycle.replacement.modelId : lifecycle?.replacement ?? null;
  return {
    key: { host: safeHost, provider, modelId, scopeId },
    identity: { host: safeHost, provider, modelId, scopeId },
    displayName: displayName || modelId,
    aliases: aliases.map((alias) => ({
      name: alias.name, resolvesTo: alias.resolvesTo ?? null, observedAt: alias.observedAt ?? null,
      evidenceRefs: alias.evidenceRefs ?? [evidenceId],
    })),
    visibility: states.discoverable === true ? 'visible' : states.discoverable === false ? 'hidden' : 'unknown',
    variant,
    lifecycle: { state: lifecycle?.state ?? 'unknown', replacement, notice: lifecycle?.notice ?? null,
      effectiveAt: lifecycle?.effectiveAt ?? null, evidenceRefs: [evidenceId] },
    capabilities: {}, dimensions,
    states: normalizedStates,
    evidence: [{
      id: evidenceId, field: 'catalog', source: source.id, class: evidenceClass,
      capturedAt: source.capturedAt, freshness: source.freshness === 'stale' ? 'stale' : 'fresh',
      completeness: source.complete ? 'complete' : 'partial', scopeFingerprint: scopeId, refs: [],
    }],
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
