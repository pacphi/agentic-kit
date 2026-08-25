import { modelIdentityKey, normalizeModelEdge, normalizeSnapshot } from './contracts.mjs';

function parseSelector(selector) {
  if (selector && typeof selector === 'object' && !Array.isArray(selector)) return selector;
  if (typeof selector !== 'string' || !selector) throw new TypeError('model selector is required');
  const split = selector.indexOf(':');
  return split < 0 ? { modelId: selector }
    : { host: selector.slice(0, split), modelId: selector.slice(split + 1) };
}

function selectedModels(snapshot, selector) {
  const query = parseSelector(selector);
  if (query.identity) return snapshot.models.filter(({ identity }) => identity === query.identity);
  return snapshot.models.filter((model) =>
    (!query.host || model.key.host === query.host)
    && (!query.provider || model.key.provider === query.provider)
    && (!query.modelId || model.key.modelId === query.modelId)
    && (!query.scopeId || model.key.scopeId === query.scopeId));
}

function bindingReferences(binding, model) {
  if (binding.host && binding.host !== model.key.host) return false;
  if (binding.provider && model.key.provider && binding.provider !== model.key.provider) return false;
  const refs = [binding.configured, binding.effective].filter(Boolean);
  const ids = new Set([
    model.key.modelId,
    model.key.provider ? `${model.key.provider}/${model.key.modelId}` : null,
    ...model.aliases.map(({ name }) => name),
  ].filter(Boolean));
  return refs.some((ref) => ids.has(ref));
}

/** @param {any} snapshotValue @param {{models?: any[]}} [options] */
export function consumerDiagnostics(snapshotValue, options = {}) {
  const { models } = options;
  const snapshot = normalizeSnapshot(snapshotValue);
  const selected = models ?? snapshot.models;
  return snapshot.bindings
    .filter((binding) => selected.some((model) => bindingReferences(binding, model)))
    .filter((binding) => binding.consumer.startsWith('aqe:') || binding.consumer.startsWith('ruflo:'))
    .map((binding) => ({
      bindingId: binding.id,
      consumer: binding.consumer,
      state: binding.consumerState,
      drift: binding.drift,
      configured: binding.configured,
      effective: binding.effective,
      evidenceRefs: binding.evidenceRefs,
      diagnostic: binding.drift
        ? `${binding.consumer} differs from canonical routing`
        : binding.consumerState === 'runtime-proven'
          ? `${binding.consumer} is runtime-proven`
          : `${binding.consumer} is ${binding.consumerState}; runtime availability is not proven`,
    }));
}

export function explainModel(snapshotValue, selector) {
  const snapshot = normalizeSnapshot(snapshotValue);
  const models = selectedModels(snapshot, selector);
  if (models.length === 0) return { found: false, reason: 'model-not-found', matches: [] };
  return {
    found: true,
    ambiguous: models.length > 1,
    matches: models.map((model) => ({
      identity: model.identity,
      key: model.key,
      displayName: model.displayName,
      aliases: model.aliases,
      dimensions: model.dimensions,
      lifecycle: model.lifecycle,
      capabilities: model.capabilities,
      evidence: model.evidence,
      bindings: snapshot.bindings.filter((binding) => bindingReferences(binding, model)),
    })),
    consumers: consumerDiagnostics(snapshot, { models }),
  };
}

function compatibility(source, target) {
  const blockers = [];
  const warnings = [];
  for (const dimension of ['discoverable', 'entitled', 'policyAllowed', 'routable']) {
    const value = target.dimensions[dimension].value;
    if (value === false) blockers.push(`${dimension} is false`);
    else if (value === null) blockers.push(`${dimension} is unknown`);
  }
  if (target.lifecycle.state === 'removed') blockers.push('target lifecycle is removed');
  else if (['deprecated', 'retiring'].includes(target.lifecycle.state)) {
    warnings.push(`target lifecycle is ${target.lifecycle.state}`);
  }
  if (source) {
    for (const [name, required] of Object.entries(source.capabilities)) {
      if (required === true && target.capabilities[name] !== true) {
        blockers.push(`required capability ${name} is not proven on target`);
      }
    }
  }
  return {
    mechanicallyCompatible: blockers.length === 0,
    blockers,
    warnings,
    quality: {
      state: 'unknown',
      claim: null,
      reason: 'model inventory does not establish quality, equivalence, or lower cost',
    },
  };
}

const modelRef = (model) => model.key.provider
  ? `${model.key.provider}/${model.key.modelId}` : model.key.modelId;

function compatibilityEvidence(model) {
  return [...new Set([
    ...['discoverable', 'entitled', 'policyAllowed', 'routable']
      .flatMap((name) => model.dimensions[name]?.evidenceRefs ?? []),
    ...(model.lifecycle.evidenceRefs ?? []),
  ])];
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

/**
 * @param {any} snapshotValue
 * @param {{activity: string, from?: any, to: any}} options
 */
export function planModelChange(snapshotValue, options) {
  const { activity, from = null, to } = options ?? /** @type {any} */ ({});
  if (typeof activity !== 'string' || !activity) throw new TypeError('activity is required');
  const snapshot = normalizeSnapshot(snapshotValue);
  const targets = selectedModels(snapshot, to);
  if (targets.length !== 1) {
    return {
      plannable: false,
      reason: targets.length ? 'target-ambiguous' : 'target-not-found',
      matches: targets.map(({ identity }) => identity),
    };
  }
  const target = targets[0];
  const sources = from == null ? [] : selectedModels(snapshot, from);
  if (from != null && sources.length !== 1) {
    return {
      plannable: false,
      reason: sources.length ? 'source-ambiguous' : 'source-not-found',
      matches: sources.map(({ identity }) => identity),
    };
  }
  const source = sources[0] ?? null;
  const affectedBindings = snapshot.bindings.filter((binding) =>
    binding.activity === activity && (!source || bindingReferences(binding, source)));
  const assessment = compatibility(source, target);
  const routeModel = target.key.host === 'opencode' ? modelRef(target) : target.key.modelId;
  const routeSpec = `${activity}:${target.key.host}:${routeModel}`;
  const warnings = [...assessment.warnings];
  if (!affectedBindings.length) warnings.push(`no canonical binding for activity ${activity} matched the source`);
  if (target.key.provider == null) warnings.push('target inference provider is unknown');
  const invalidationMarkers = affectedBindings.map((binding) => ({
    kind: 'route-intelligence-stale',
    consumer: '#109',
    bindingId: binding.id,
    reason: 'concrete model identity changes',
    retainHistory: true,
    evidenceRefs: binding.evidenceRefs,
  }));
  const compatibilityEdges = assessment.mechanicallyCompatible ? [normalizeModelEdge({
    kind: 'mechanically-compatible',
    from: source ? `${source.key.host}:${modelRef(source)}` : `activity:${activity}`,
    to: `${target.key.host}:${modelRef(target)}`,
    provenance: 'derived', scopeFingerprint: target.key.scopeId,
    evidenceRefs: compatibilityEvidence(target),
  })] : [];
  return {
    plannable: assessment.mechanicallyCompatible,
    readOnly: true,
    activity,
    from: source?.key ?? null,
    to: target.key,
    affectedBindings,
    consumerDiagnostics: consumerDiagnostics(snapshot, {
      models: source ? [source] : [target],
    }),
    compatibility: { ...assessment, warnings },
    edges: compatibilityEdges,
    invalidationMarkers,
    action: assessment.mechanicallyCompatible ? {
      command: `ak host pick --route ${shellQuote(routeSpec)}`,
      executed: false,
      commandMutates: true,
      mutationSurface: 'canonical-routing-policy',
      requiresExplicitUserAction: true,
      note: 'copyable canonical-policy action; this plan does not execute it',
    } : null,
  };
}

/**
 * Pure handoff contract for Route Intelligence (#109). This inventory feed
 * establishes mechanical eligibility and lifecycle invalidation only; it never
 * claims quality, cost equivalence, or premium value.
 */
export function routeIntelligenceFeed(snapshotValue, { changes = [] } = {}) {
  const snapshot = normalizeSnapshot(snapshotValue);
  const required = ['discoverable', 'entitled', 'policyAllowed', 'routable'];
  const candidates = snapshot.models.filter((model) => required.every((name) =>
    model.dimensions[name].value === true)
    && !['hidden', 'removed'].includes(model.lifecycle.state)).map((model) => ({
    identity: model.identity,
    key: model.key,
    variant: model.variant,
    capabilities: model.capabilities,
    pricing: model.pricing,
    lifecycle: model.lifecycle,
    evidenceRefs: compatibilityEvidence(model),
    quality: 'unknown',
  }));
  const invalidatingKinds = new Set([
    'alias-target-changed', 'lifecycle-changed', 'model-removed', 'capability-changed',
    'digest-changed', 'reasoning-changed', 'context-changed', 'variant-changed', 'pricing-changed',
  ]);
  const invalidations = changes.filter(({ kind }) => invalidatingKinds.has(kind)).map((entry) => ({
    kind: 'route-intelligence-stale', subject: entry.subject, reason: entry.kind,
    evidenceRefs: [...new Set(entry.evidenceRefs ?? [])], retainHistory: true,
  }));
  for (const model of snapshot.models.filter(({ lifecycle }) =>
    lifecycle.replacement || ['deprecated', 'retiring', 'removed'].includes(lifecycle.state))) {
    invalidations.push({
      kind: 'route-intelligence-stale', subject: model.identity,
      reason: model.lifecycle.replacement ? 'first-party-migration' : `lifecycle-${model.lifecycle.state}`,
      evidenceRefs: [...model.lifecycle.evidenceRefs], retainHistory: true,
    });
  }
  return {
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    scopeFingerprint: snapshot.scope.fingerprint,
    candidates,
    invalidations: invalidations.filter((entry, index, all) => all.findIndex((candidate) =>
      candidate.subject === entry.subject && candidate.reason === entry.reason) === index),
    claims: { quality: false, economics: false },
  };
}

export function impactGraph(snapshotValue) {
  const snapshot = normalizeSnapshot(snapshotValue);
  return {
    nodes: snapshot.models.map((model) => ({ id: model.identity, kind: 'model', key: model.key }))
      .concat(snapshot.bindings.map((binding) => ({ id: binding.id, kind: 'consumer', consumer: binding.consumer }))),
    edges: snapshot.bindings.flatMap((binding) => snapshot.models
      .filter((model) => bindingReferences(binding, model))
      .map((model) => ({
        from: binding.id,
        to: modelIdentityKey(model.key),
        kind: 'consumes',
        evidenceRefs: binding.evidenceRefs,
      }))),
  };
}
