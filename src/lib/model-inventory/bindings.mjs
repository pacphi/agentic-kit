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

function escalationBindings(route, activity, diagnostics) {
  const bindings = [];
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
  return bindings;
}

/** Routes and their escalation rungs from `kit.json`'s `routing.routes` table. */
function routeBindings(routes, diagnostics) {
  if (routes !== undefined && !plain(routes)) diagnostics.push({ code: 'invalid-routing-schema' });
  const bindings = [];
  for (const [activity, route] of Object.entries(plain(routes) ? routes : {})) {
    if (!plain(route) || !bounded(route.host)) {
      diagnostics.push({ code: 'invalid-route', activity });
      continue;
    }
    bindings.push(record({
      consumer: `route:${activity}`, source: 'kit.json', host: route.host, modelRef: bounded(route.model),
      activity, provenance: route.provenance, variant: { reasoningEffort: bounded(route.reasoningEffort) },
    }));
    bindings.push(...escalationBindings(route, activity, diagnostics));
  }
  return bindings;
}

/** Ad-hoc host/provider bindings from `kit.json`'s `integrations.bindings` array. */
function integrationBindings(config, diagnostics) {
  const bindings = [];
  const entries = Array.isArray(config?.integrations?.bindings) ? config.integrations.bindings : [];
  for (const [index, binding] of entries.entries()) {
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
  return bindings;
}

function aqeFallbackBindings(aqeConfig) {
  const entries = Array.isArray(aqeConfig.fallbackChain) ? aqeConfig.fallbackChain
    : Array.isArray(aqeConfig.fallbackChain?.entries) ? aqeConfig.fallbackChain.entries : [];
  const bindings = [];
  for (const [index, item] of entries.entries()) {
    const entry = typeof item === 'string' ? { provider: item } : item;
    if (plain(entry) && bounded(entry.provider)) bindings.push(record({
      consumer: `aqe:fallback:${index}`, source: '.agentic-qe/llm-config.json', provider: entry.provider,
      modelRef: bounded(entry.model) ?? (Array.isArray(entry.models) ? bounded(entry.models[0]) : null), index,
    }));
  }
  return bindings;
}

function aqeAgentOverrideBindings(aqeConfig) {
  const overrides = plain(aqeConfig.agentOverrides) ? aqeConfig.agentOverrides : {};
  const bindings = [];
  for (const [agent, entry] of Object.entries(overrides)) {
    if (plain(entry) && bounded(entry.provider)) bindings.push(record({
      consumer: `aqe:agent:${agent}`, source: '.agentic-qe/llm-config.json', provider: entry.provider,
      modelRef: bounded(entry.model), activity: agent,
    }));
  }
  return bindings;
}

/** Agentic-QE's own resolved config (`.agentic-qe/llm-config.json`): default provider,
 *  ordered fallback chain, and per-agent overrides — each an independently sourced consumer. */
function aqeBindings(aqeConfig) {
  if (!plain(aqeConfig)) return [];
  const defaultBinding = bounded(aqeConfig.defaultProvider) ? [record({
    consumer: 'aqe:default', source: '.agentic-qe/llm-config.json', provider: aqeConfig.defaultProvider,
  })] : [];
  return [...defaultBinding, ...aqeFallbackBindings(aqeConfig), ...aqeAgentOverrideBindings(aqeConfig)];
}

/** Ruflo's candidate provider/model list, wherever it currently lives in its config shape. */
function rufloBindings(rufloConfig) {
  const candidates = Array.isArray(rufloConfig?.candidates) ? rufloConfig.candidates
    : Array.isArray(rufloConfig?.providers?.models) ? rufloConfig.providers.models : [];
  const bindings = [];
  for (const [index, candidate] of candidates.entries()) {
    if (plain(candidate) && (bounded(candidate.provider) || bounded(candidate.model))) bindings.push(record({
      consumer: `ruflo:candidate:${index}`, source: 'ruflo', provider: bounded(candidate.provider) ?? bounded(candidate.id),
      modelRef: bounded(candidate.model) ?? bounded(candidate.id), index,
    }));
  }
  return bindings;
}

export function collectModelBindings({
  config = {}, aqeConfig, rufloConfig,
} = /** @type {any} */ ({})) {
  const diagnostics = [];
  const bindings = [
    ...routeBindings(config?.routing?.routes, diagnostics),
    ...integrationBindings(config, diagnostics),
    ...aqeBindings(aqeConfig),
    ...rufloBindings(rufloConfig),
  ];
  return { status: diagnostics.length ? 'partial' : 'complete', bindings, diagnostics };
}
