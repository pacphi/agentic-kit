import { readIndex } from '../usage-index.mjs';
import { diagnostic, modelRecord, scopeFingerprint, sourceRecord } from './discovery/index.mjs';

const bounded = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;

function unavailableObservedResult(scope, scopeKey, error) {
  const capturedAt = new Date().toISOString();
  return {
    status: 'unavailable', generatedAt: capturedAt, models: [],
    source: sourceRecord({
      id: 'usage-index', owner: 'usage', scope, scopeKey, capturedAt,
      ownerType: 'usage', transport: 'index', network: 'never', mode: 'local',
      complete: false, status: 'unavailable', schema: 'usage-index-v6', diagnostics: ['usage-index-unavailable'],
    }),
    diagnostics: [diagnostic('usage-index-unavailable', error?.message ?? error)],
  };
}

function observedModelRecord({
  host, provider, modelId, scope, scopeKey, generatedAt,
}) {
  const source = {
    id: 'usage-index', capturedAt: generatedAt ?? new Date().toISOString(),
    complete: true, freshness: 'current',
  };
  const record = modelRecord({
    host, provider, modelId, scopeId: scopeFingerprint(host, scope, scopeKey), source,
    // A successful structured invocation proves this exact observed path was
    // entitled, policy-allowed, and routable at capture time. It says
    // nothing about catalog completeness or other profiles/projects.
    states: { observed: true, entitled: true, policyAllowed: true, routable: true },
  });
  record.observations = 1;
  return record;
}

function foldSessionModels(map, session, scope, scopeKey, generatedAt) {
  const host = bounded(session.host) ?? 'unknown';
  const provider = bounded(session.provider);
  for (const modelId of Array.isArray(session.models) ? session.models : []) {
    if (!bounded(modelId)) continue;
    const key = `${host}\0${provider ?? ''}\0${modelId}`;
    const prior = map.get(key);
    if (prior) { prior.observations++; continue; }
    const record = observedModelRecord({
      host, provider, modelId, scope, scopeKey, generatedAt,
    });
    record.evidence[0].providerProvenance = session.providerProvenance ?? 'unknown';
    map.set(key, record);
  }
}

function observedModelsMap(sessions, scope, scopeKey, generatedAt) {
  const map = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    foldSessionModels(map, session, scope, scopeKey, generatedAt);
  }
  return map;
}

function observedResultStatus(degraded) {
  return degraded ? 'partial' : 'complete';
}

function finalizeObservedResult({
  aggregate, scope, scopeKey, map,
}) {
  const degraded = Object.values(aggregate?.sourceHealth ?? {}).some((health) => health?.status === 'degraded');
  const capturedAt = aggregate?.generatedAt ?? new Date().toISOString();
  const source = sourceRecord({
    id: 'usage-index', owner: 'usage', scope, scopeKey, capturedAt, complete: !degraded,
    ownerType: 'usage', transport: 'index', network: 'never', mode: 'local',
    status: observedResultStatus(degraded), schema: 'usage-index-v6',
    diagnostics: degraded ? ['usage-source-degraded'] : [],
  });
  return {
    status: observedResultStatus(degraded), generatedAt: capturedAt,
    models: [...map.values()], source, diagnostics: [], sourceHealth: aggregate?.sourceHealth ?? {},
  };
}

export async function collectObservedModels({
  readIndexFn = readIndex, indexOptions = {}, scope = {}, scopeKey, days = 365,
} = /** @type {any} */ ({})) {
  let aggregate;
  try { aggregate = await readIndexFn({ days, ...indexOptions }); } catch (error) {
    return unavailableObservedResult(scope, scopeKey, error);
  }
  const map = observedModelsMap(aggregate?.sessions, scope, scopeKey, aggregate?.generatedAt);
  return finalizeObservedResult({
    aggregate, scope, scopeKey, map,
  });
}
