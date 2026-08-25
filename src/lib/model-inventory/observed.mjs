import { readIndex } from '../usage-index.mjs';
import { diagnostic, modelRecord, scopeFingerprint, sourceRecord } from './discovery/index.mjs';

const bounded = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;

export async function collectObservedModels({
  readIndexFn = readIndex, indexOptions = {}, scope = {}, scopeKey, days = 365,
} = /** @type {any} */ ({})) {
  let aggregate;
  try { aggregate = await readIndexFn({ days, ...indexOptions }); } catch (error) {
    const capturedAt = new Date().toISOString();
    return {
      status: 'unavailable', generatedAt: capturedAt, models: [],
      source: sourceRecord({ id: 'usage-index', owner: 'usage', scope, scopeKey, capturedAt,
        complete: false, status: 'unavailable', schema: 'usage-index-v6', diagnostics: ['usage-index-unavailable'] }),
      diagnostics: [diagnostic('usage-index-unavailable', error?.message ?? error)],
    };
  }
  const map = new Map();
  for (const session of Array.isArray(aggregate?.sessions) ? aggregate.sessions : []) {
    const host = bounded(session.host) ?? 'unknown';
    const provider = bounded(session.provider);
    for (const modelId of Array.isArray(session.models) ? session.models : []) {
      if (!bounded(modelId)) continue;
      const key = `${host}\0${provider ?? ''}\0${modelId}`;
      const prior = map.get(key);
      if (prior) { prior.observations++; continue; }
      const source = {
        id: 'usage-index', capturedAt: aggregate.generatedAt ?? new Date().toISOString(),
        complete: true, freshness: 'current',
      };
      const record = modelRecord({
        host, provider, modelId, scopeId: scopeFingerprint(host, scope, scopeKey), source,
        states: { observed: true, entitled: 'unknown' },
      });
      record.observations = 1;
      record.evidence[0].providerProvenance = session.providerProvenance ?? 'unknown';
      map.set(key, record);
    }
  }
  const degraded = Object.values(aggregate?.sourceHealth ?? {}).some((health) => health?.status === 'degraded');
  const capturedAt = aggregate?.generatedAt ?? new Date().toISOString();
  const source = sourceRecord({
    id: 'usage-index', owner: 'usage', scope, scopeKey, capturedAt, complete: !degraded,
    status: degraded ? 'partial' : 'complete', schema: 'usage-index-v6',
    diagnostics: degraded ? ['usage-source-degraded'] : [],
  });
  return {
    status: degraded ? 'partial' : 'complete', generatedAt: capturedAt,
    models: [...map.values()], source, diagnostics: [], sourceHealth: aggregate?.sourceHealth ?? {},
  };
}
