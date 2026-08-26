import { createHash } from 'node:crypto';

const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
const bindingId = (parts) => `binding:${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)}`;

function record({ consumer, source, host = null, provider = null, modelRef = null, activity = null,
  provenance = 'configured', variant = {}, index = null }) {
  const evidenceClass = provenance === 'observed' ? 'observed' : 'configured';
  const consumerState = consumer.startsWith('aqe:') || consumer.startsWith('ruflo:') ? 'reported'
    : provenance === 'observed' ? 'runtime-proven' : 'configured';
  return {
    id: bindingId([consumer, source, host, provider, modelRef, activity, index].map(String)),
    consumer, source, host, provider, modelRef, activity, variant,
    configured: modelRef, effective: consumer.startsWith('route:') ? modelRef : null,
    consumerState, drift: false, evidenceRefs: [],
    evidenceClass, provenance: evidenceClass,
  };
}

export function collectModelBindings({
  config = {}, aqeConfig, rufloConfig,
} = /** @type {any} */ ({})) {
  const bindings = [];
  const diagnostics = [];
  const routes = config?.routing?.routes;
  if (routes !== undefined && !plain(routes)) diagnostics.push({ code: 'invalid-routing-schema' });
  for (const [activity, route] of Object.entries(plain(routes) ? routes : {})) {
    if (!plain(route) || !bounded(route.host)) {
      diagnostics.push({ code: 'invalid-route', activity });
      continue;
    }
    bindings.push(record({
      consumer: `route:${activity}`, source: 'kit.json', host: route.host, modelRef: bounded(route.model),
      activity, provenance: route.provenance, variant: { reasoningEffort: bounded(route.reasoningEffort) },
    }));
    for (const [index, rung] of (Array.isArray(route.escalation) ? route.escalation : []).entries()) {
      if (!plain(rung) || !bounded(rung.host)) {
        diagnostics.push({ code: 'invalid-escalation', activity, index });
        continue;
      }
      bindings.push(record({
        consumer: `route:${activity}:escalation:${index}`, source: 'kit.json', host: rung.host,
        modelRef: bounded(rung.model), activity, provenance: route.provenance, index,
        variant: { reasoningEffort: bounded(rung.reasoningEffort) },
      }));
    }
  }
  for (const [index, binding] of (Array.isArray(config?.integrations?.bindings)
    ? config.integrations.bindings : []).entries()) {
    if (!plain(binding) || !bounded(binding.host)) {
      diagnostics.push({ code: 'invalid-integration-binding', index });
      continue;
    }
    bindings.push(record({
      consumer: `integration:${index}`, source: 'kit.json', host: binding.host,
      provider: bounded(binding.provider), modelRef: bounded(binding.model), index,
      variant: { reasoningEffort: bounded(binding.reasoningEffort) },
    }));
  }
  if (plain(aqeConfig)) {
    if (bounded(aqeConfig.defaultProvider)) bindings.push(record({
      consumer: 'aqe:default', source: '.agentic-qe/llm-config.json', provider: aqeConfig.defaultProvider,
    }));
    const fallbackEntries = Array.isArray(aqeConfig.fallbackChain) ? aqeConfig.fallbackChain
      : Array.isArray(aqeConfig.fallbackChain?.entries) ? aqeConfig.fallbackChain.entries : [];
    for (const [index, item] of fallbackEntries.entries()) {
      const entry = typeof item === 'string' ? { provider: item } : item;
      if (plain(entry) && bounded(entry.provider)) bindings.push(record({
        consumer: `aqe:fallback:${index}`, source: '.agentic-qe/llm-config.json', provider: entry.provider,
        modelRef: bounded(entry.model) ?? (Array.isArray(entry.models) ? bounded(entry.models[0]) : null), index,
      }));
    }
    for (const [agent, entry] of Object.entries(plain(aqeConfig.agentOverrides) ? aqeConfig.agentOverrides : {})) {
      if (plain(entry) && bounded(entry.provider)) bindings.push(record({
        consumer: `aqe:agent:${agent}`, source: '.agentic-qe/llm-config.json', provider: entry.provider,
        modelRef: bounded(entry.model), activity: agent,
      }));
    }
  }
  const rufloCandidates = Array.isArray(rufloConfig?.candidates) ? rufloConfig.candidates
    : Array.isArray(rufloConfig?.providers?.models) ? rufloConfig.providers.models : [];
  for (const [index, candidate] of rufloCandidates.entries()) {
    if (plain(candidate) && (bounded(candidate.provider) || bounded(candidate.model))) bindings.push(record({
      consumer: `ruflo:candidate:${index}`, source: 'ruflo', provider: bounded(candidate.provider) ?? bounded(candidate.id),
      modelRef: bounded(candidate.model) ?? bounded(candidate.id), index,
    }));
  }
  return { status: diagnostics.length ? 'partial' : 'complete', bindings, diagnostics };
}
