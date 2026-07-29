import { BILLING_TYPES, PROVENANCE_TYPES, assertEnum, immutable } from './schema.mjs';

const RANK = Object.freeze({ unknown: 0, inferred: 1, configured: 2, observed: 3 });

export function provenance(value = 'unknown', evidence = []) {
  assertEnum(value, PROVENANCE_TYPES, 'provenance');
  if (!Array.isArray(evidence) || evidence.some((item) => typeof item !== 'string')) {
    throw new TypeError('provenance evidence must be an array of strings');
  }
  return immutable({ value, evidence: [...new Set(evidence)] });
}

export function mergeProvenance(...values) {
  const normalized = values.filter(Boolean).map((item) =>
    typeof item === 'string' ? provenance(item) : provenance(item.value, item.evidence));
  if (!normalized.length) return provenance();
  const strongest = normalized.reduce((best, item) => RANK[item.value] > RANK[best.value] ? item : best);
  return provenance(strongest.value, normalized.flatMap(({ evidence }) => evidence));
}

export function normalizedFacts({
  hosts = {}, providers = {}, bindings = [], executions = [], observedAt = null,
} = {}) {
  const cleanHosts = Object.fromEntries(Object.entries(hosts).map(([id, fact]) => [id, {
    present: fact?.present ?? null, enabled: fact?.enabled ?? null,
    version: fact?.version ?? null, installMethod: fact?.installMethod ?? 'unknown',
    authenticated: fact?.authenticated ?? 'unknown', wired: fact?.wired ?? null,
    provenance: mergeProvenance(fact?.provenance),
  }]));
  const cleanProviders = Object.fromEntries(Object.entries(providers).map(([id, fact]) => {
    const billing = fact?.billing ?? 'unknown';
    assertEnum(billing, BILLING_TYPES, `providers.${id}.billing`);
    return [id, {
      configured: fact?.configured ?? null, reachable: fact?.reachable ?? null,
      billing, credential: fact?.credential ?? 'unknown',
      provenance: mergeProvenance(fact?.provenance),
    }];
  }));
  const cleanBindings = bindings.map((fact) => ({
    id: fact.id ?? null, host: fact.host, provider: fact.provider,
    model: fact.model ?? null, transport: fact.transport ?? null,
    endpoint: fact.endpoint ?? null, reachable: fact.reachable ?? null,
    provenance: mergeProvenance(fact.provenance),
  }));
  const cleanExecutions = executions.map((fact) => ({
    host: fact.host ?? null, provider: fact.provider ?? null,
    model: fact.model ?? null, transport: fact.transport ?? null,
    endpoint: fact.endpoint ?? null, billing: fact.billing ?? 'unknown',
    provenance: mergeProvenance(fact.provenance),
  }));
  for (const fact of cleanExecutions) assertEnum(fact.billing, BILLING_TYPES, 'execution.billing');
  return immutable({
    schemaVersion: 1, observedAt,
    hosts: cleanHosts, providers: cleanProviders,
    bindings: cleanBindings, executions: cleanExecutions,
  });
}

export function mergeFacts(...sets) {
  const hosts = {}, providers = {}, bindingMap = new Map(), executions = [];
  let observedAt = null;
  for (const set of sets.filter(Boolean)) {
    observedAt = set.observedAt ?? observedAt;
    for (const [id, fact] of Object.entries(set.hosts ?? {})) {
      const prior = hosts[id] ?? {};
      hosts[id] = { ...prior, ...fact, provenance: mergeProvenance(prior.provenance, fact.provenance) };
    }
    for (const [id, fact] of Object.entries(set.providers ?? {})) {
      const prior = providers[id] ?? {};
      providers[id] = { ...prior, ...fact, provenance: mergeProvenance(prior.provenance, fact.provenance) };
    }
    for (const fact of set.bindings ?? []) {
      const key = fact.id ?? `${fact.host}|${fact.provider}|${fact.transport ?? ''}|${fact.endpoint ?? ''}`;
      const prior = bindingMap.get(key) ?? {};
      bindingMap.set(key, { ...prior, ...fact, provenance: mergeProvenance(prior.provenance, fact.provenance) });
    }
    executions.push(...(set.executions ?? []));
  }
  return normalizedFacts({ hosts, providers, bindings: [...bindingMap.values()], executions, observedAt });
}

export function normalizeIntegrationFacts(input = {}) {
  const providers = Object.fromEntries(Object.entries(input.providers ?? {}).map(([id, fact]) => [id, {
    ...structuredClone(fact),
    // Credential material is never a fact. Preserve only an explicit boolean
    // presence signal across collection, JSON output and renderers.
    keyPresent: fact?.keyPresent === true,
    credentialPresent: fact?.keyPresent === true || fact?.credentialPresent === true,
  }]));
  const bindings = (input.bindings ?? []).map((binding) => {
    let strength = binding.provenance ?? 'unknown';
    for (const evidence of binding.evidence ?? []) {
      if (evidence?.kind === 'provider-response' && evidence.provider === binding.provider
        && RANK[evidence.provenance] > RANK[strength]) strength = evidence.provenance;
    }
    const provider = binding.provider ?? null;
    const providerFact = provider ? providers[provider] : null;
    const billing = providerFact?.billing ?? 'unknown';
    return {
      host: binding.host ?? null,
      provider,
      model: binding.model ?? null,
      billing,
      provenance: strength,
      reachable: binding.reachable ?? providerFact?.reachable ?? null,
      pricing: billing === 'local' ? 0 : null,
      quota: null,
      cacheAccounting: null,
    };
  });
  return immutable({
    hosts: structuredClone(input.hosts ?? {}),
    providers: structuredClone(providers),
    bindings,
  });
}

export function groupUsageByIntegrationAxes(rows = []) {
  const byHost = {}, byProvider = {};
  const add = (map, key, row) => {
    const bucket = map[key] ?? (map[key] = { sessions: 0, tokens: 0, cost: 0 });
    bucket.sessions++;
    bucket.tokens += Number(row.tokens) || 0;
    if (row.cost == null || bucket.cost == null) bucket.cost = null;
    else bucket.cost += Number(row.cost) || 0;
  };
  for (const row of rows) {
    add(byHost, row.host ?? 'unknown', row);
    add(byProvider, row.provider ?? 'unknown', row);
  }
  return immutable({ byHost, byProvider });
}
