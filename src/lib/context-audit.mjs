// Pure projection for `ak audit context`. Acquisition stays outside this
// module: callers pass bounded evidence and this file emits only aggregate,
// allowlisted facts. Raw prompts, file paths, commands, skill contents, and
// configuration values can never cross this boundary by object spreading.
import {
  CONTEXT_BUDGET_POLICY, evaluateContextBudget, resolveEffectiveContextCeiling,
} from './context-budget.mjs';

export const CONTEXT_AUDIT_HOSTS = Object.freeze(['claude', 'codex', 'opencode', 'external']);
const HEALTH = new Set(['complete', 'partial', 'unavailable', 'not-recorded', 'unsupported']);
const PROVENANCE = new Set([
  'runtime-observed', 'host-configured', 'provider-catalog',
  'adapter-declared', 'configured-fallback',
]);
const INSTALLATION_STATES = new Set([
  'absent', 'user-authored-only', 'upstream-managed-only',
  'canonical-managed', 'duplicate-managed', 'stale-managed',
]);

const safeInteger = (value, { positive = false } = {}) => Number.isSafeInteger(value)
  && (positive ? value > 0 : value >= 0) ? value : null;
const hasControl = (value) => [...value].some((char) => {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
});
const safeText = (value, fallback = null, max = 128) => typeof value === 'string'
  && value.length > 0 && value.length <= max && !hasControl(value) ? value : fallback;
const health = (value, fallback = 'not-recorded') => HEALTH.has(value) ? value : fallback;

function safeReason(value, fallback) {
  const reason = safeText(value, fallback, 160);
  return /^[a-z0-9][a-z0-9-]*$/.test(reason) ? reason : fallback;
}

export function selectedContextHosts(values = []) {
  const requested = Array.isArray(values) && values.length ? values : ['all'];
  const expanded = requested.includes('all') ? CONTEXT_AUDIT_HOSTS : [...new Set(requested)];
  const unknown = expanded.filter((host) => !CONTEXT_AUDIT_HOSTS.includes(host));
  if (unknown.length) throw new TypeError(`unknown context audit host(s): ${unknown.join(', ')}`);
  return CONTEXT_AUDIT_HOSTS.filter((host) => expanded.includes(host));
}

function safeFact(value) {
  if (!value || typeof value !== 'object') return null;
  const tokens = safeInteger(value.tokens, { positive: true });
  if (tokens === null) return null;
  const provenance = PROVENANCE.has(value.provenance) ? value.provenance : null;
  if (!provenance) return null;
  return {
    tokens,
    provenance,
    source: safeText(value.source, 'unknown-source'),
    status: value.status === 'stale' ? 'stale' : 'current',
  };
}

/** Convert an existing model-discovery result to the small context audit
 * contract. No source metadata is copied, so local paths cannot escape. */
export function modelWindowFromDiscovery(host, result) {
  const models = Array.isArray(result?.models) ? result.models : [];
  const active = models.find((model) => model?.states?.effective === true
    || model?.dimensions?.effective?.value === true);
  if (!active) {
    return {
      status: result?.status === 'unsupported-schema' ? 'unavailable' : 'not-recorded',
      reason: 'active-model-window-not-recorded',
    };
  }
  const modelId = safeText(active.key?.modelId ?? active.identity?.modelId, 'unknown-model', 256);
  const variant = active.variant ?? {};
  const catalog = models.find((model) => model !== active
    && (model?.key?.modelId ?? model?.identity?.modelId) === modelId
    && safeInteger(model?.capabilities?.contextLimit, { positive: true }) !== null);
  const source = host === 'codex' ? 'codex-cache'
    : host === 'claude' ? 'claude-config-catalog' : `${host}-local-catalog`;
  const advertisedTokens = safeInteger(
    variant.maximumContextWindow ?? catalog?.capabilities?.contextLimit
      ?? active.capabilities?.contextLimit,
    { positive: true },
  );
  const hostTokens = safeInteger(variant.contextWindow, { positive: true });
  const effectiveTokens = safeInteger(variant.effectiveContextWindow, { positive: true });
  const autoCompactTokens = safeInteger(variant.autoCompactTokenLimit, { positive: true });
  return {
    status: health(result?.status, 'partial'),
    model: modelId,
    advertised: advertisedTokens === null ? null
      : { tokens: advertisedTokens, provenance: host === 'claude' ? 'provider-catalog' : 'host-configured', source },
    host: hostTokens === null ? null
      : { tokens: hostTokens, provenance: 'host-configured', source },
    effective: effectiveTokens === null ? null
      : { tokens: effectiveTokens, provenance: 'host-configured', source },
    autoCompact: autoCompactTokens === null ? null
      : { tokens: autoCompactTokens, provenance: 'host-configured', source },
  };
}

function guidanceEntries(value, fallbackReason) {
  return Array.isArray(value) ? value.slice(0, 256).map((entry) => ({
    slug: safeText(entry?.slug, 'unknown-block'),
    reason: safeReason(entry?.reason, fallbackReason),
  })) : [];
}

function upstreamProjection(value) {
  return Array.isArray(value) ? value.slice(0, 8).map((upstream) => ({
    owner: upstream?.owner === 'agentic-qe' ? 'agentic-qe' : 'unknown-upstream',
    blocks: safeInteger(upstream?.blocks) ?? 0,
    bytes: safeInteger(upstream?.bytes),
    estimatedTokens: safeInteger(upstream?.estimatedTokens?.tokens) === null ? null : {
      tokens: safeInteger(upstream.estimatedTokens.tokens),
      unit: 'estimated-tokens', method: 'utf8-bytes-div-3-ceil',
    },
    state: ['single-managed', 'duplicate-managed', 'orphaned-managed'].includes(upstream?.state)
      ? upstream.state : 'orphaned-managed',
  })) : [];
}

function installationProjection(value) {
  return Array.isArray(value) ? value.slice(0, 8).map((entry) => ({
      scope: entry?.scope === 'project' ? 'project' : 'machine',
      status: health(entry?.status, 'partial'),
      state: INSTALLATION_STATES.has(entry?.state) ? entry.state : 'stale-managed',
      managedBlocks: safeInteger(entry?.managedBlocks) ?? 0,
      expectedBlocks: safeInteger(entry?.expectedBlocks) ?? 0,
      duplicateBlocks: safeInteger(entry?.duplicateBlocks) ?? 0,
      staleBlocks: safeInteger(entry?.staleBlocks) ?? 0,
      missingBlocks: safeInteger(entry?.missingBlocks) ?? 0,
      upstreamOwned: upstreamProjection(entry?.upstreamOwned),
    })) : [];
}

function unavailableGuidanceProjection(value, status) {
  return {
    status, target: null, bytes: null, estimatedTokens: null, budget: null,
    withinBudget: null, includedCount: 0, omitted: [], unknown: [],
    installations: [],
    reason: safeReason(value?.reason, `${status}-guidance-evidence`),
  };
}

function guidanceBudget(value) {
  const maxBytes = safeInteger(value?.maxBytes);
  const maxConservativeTokens = safeInteger(value?.maxConservativeTokens);
  return maxBytes === null || maxConservativeTokens === null
    ? null : { maxBytes, maxConservativeTokens };
}

function guidanceProjection(value) {
  const status = health(value?.status, value?.unknown?.length ? 'partial' : 'not-recorded');
  if (status === 'unsupported' || status === 'not-recorded' || status === 'unavailable') {
    return unavailableGuidanceProjection(value, status);
  }
  const bytes = safeInteger(value?.bytes);
  const tokens = safeInteger(value?.conservativeTokens);
  const omitted = guidanceEntries(value?.omitted, 'detector-false');
  const unknown = guidanceEntries(value?.unknown, 'unknown-measurement');
  const installations = installationProjection(value?.installations);
  return {
    status: unknown.length ? 'partial' : status,
    target: safeText(value?.target, null),
    bytes,
    estimatedTokens: tokens === null ? null : {
      tokens, unit: 'estimated-tokens', method: 'utf8-bytes-div-3-ceil',
    },
    budget: guidanceBudget(value?.budget),
    withinBudget: typeof value?.withinBudget === 'boolean' ? value.withinBudget : null,
    includedCount: Array.isArray(value?.included) ? value.included.length : 0,
    omitted,
    unknown,
    installations,
    reason: unknown.length ? 'managed-guidance-measurement-incomplete' : null,
  };
}

function windowProjection(value) {
  const status = health(value?.status);
  const advertised = safeFact(value?.advertised);
  const host = safeFact(value?.host);
  const effective = safeFact(value?.effective);
  const autoCompact = safeFact(value?.autoCompact);
  /** @type {Array<any>} */
  const facts = [];
  /** @type {Array<[string, any]>} */
  const candidates = [
    ['advertised', advertised], ['host', host], ['effective', effective], ['auto-compact', autoCompact],
  ];
  for (const [kind, fact] of candidates) {
    if (fact) facts.push({ ...fact, kind });
  }
  return {
    status,
    model: safeText(value?.model, null, 256),
    advertised,
    host,
    effective,
    autoCompact,
    ceiling: resolveEffectiveContextCeiling(facts),
    reason: status === 'complete' || status === 'partial'
      ? null : safeReason(value?.reason, `${status}-model-window-evidence`),
  };
}

function skillsProjection(value) {
  const status = health(value?.status);
  return {
    status,
    count: safeInteger(value?.count),
    metadataBytes: safeInteger(value?.metadataBytes),
    omitted: safeInteger(value?.omitted) ?? 0,
    reason: status === 'complete' && safeInteger(value?.metadataBytes) !== null
      ? null : safeReason(value?.reason, 'host-rendered-metadata-not-recorded'),
  };
}

function mcpProjection(value) {
  const status = health(value?.status);
  return {
    status,
    registrations: safeInteger(value?.registrations),
    configBytes: safeInteger(value?.configBytes),
    schemaBytes: safeInteger(value?.schemaBytes),
    reason: status === 'complete' && safeInteger(value?.schemaBytes) !== null
      ? null : safeReason(value?.reason, 'tool-schemas-not-recorded'),
  };
}

function hooksProjection(hookAudit, host) {
  if (host === 'external') return {
    status: 'unsupported',
    sources: null, invalidSources: null, occurrences: null, stopOccurrences: null,
    reason: 'external-contract-v1-no-hook-runtime-observability',
  };
  const report = hookAudit?.reports?.[host];
  if (!report) return {
    status: 'not-recorded',
    sources: null, invalidSources: null, occurrences: null, stopOccurrences: null,
    reason: 'hook-audit-not-recorded',
  };
  const records = Array.isArray(report.records) ? report.records : [];
  const invalidSources = safeInteger(report.summary?.invalidSources) ?? 0;
  const coverage = health(report.coverage?.status, 'partial');
  return {
    status: invalidSources > 0 ? 'partial' : coverage,
    sources: safeInteger(report.summary?.sources) ?? 0,
    invalidSources,
    occurrences: safeInteger(report.summary?.hookOccurrences) ?? records.length,
    stopOccurrences: records.filter((record) => record?.event === 'Stop').length,
    reason: invalidSources > 0 ? 'invalid-hook-sources-present' : null,
  };
}

function startupProjection(guidance, modelWindow) {
  if (guidance.status !== 'complete' || guidance.unknown.length
      || guidance.estimatedTokens?.unit !== 'estimated-tokens') {
    return { state: 'unknown', reason: 'startup-contribution-incomplete' };
  }
  if (modelWindow.ceiling.state !== 'resolved') {
    return { state: 'unknown', reason: 'compatible-window-denominator-not-recorded' };
  }
  return {
    ...evaluateContextBudget({
      ceilingTokens: modelWindow.ceiling.tokens,
      startupTokens: guidance.estimatedTokens.tokens,
    }),
    basis: 'estimated-startup-vs-token-window',
  };
}

function overallHealth(parts) {
  const values = Object.values(parts);
  if (values.every((value) => value === 'unsupported')) return 'unsupported';
  if (values.every((value) => value === 'complete')) return 'complete';
  if (values.some((value) => value === 'unavailable')) return 'unavailable';
  return 'partial';
}

function hostReport(host, evidence) {
  const guidance = guidanceProjection(evidence.guidance?.[host]);
  const modelWindow = windowProjection(evidence.windows?.[host]);
  const skills = skillsProjection(evidence.skills?.[host]);
  const mcp = mcpProjection(evidence.mcp?.[host]);
  const hooks = hooksProjection(evidence.hookAudit, host);
  const components = {
    guidance: guidance.status, modelWindow: modelWindow.status,
    skills: skills.status, mcp: mcp.status, hooks: hooks.status,
  };
  return {
    host,
    guidance,
    modelWindow,
    skills,
    mcp,
    hooks,
    startup: startupProjection(guidance, modelWindow),
    sourceHealth: { overall: overallHealth(components), components },
  };
}

/** @param {{hosts?: string[], evidence?: any}} [input] */
export function buildContextAudit({ hosts, evidence = {} } = {}) {
  const selected = selectedContextHosts(hosts);
  const reports = Object.fromEntries(selected.map((host) => [host, hostReport(host, evidence)]));
  return {
    schemaVersion: 1,
    mode: 'read-only',
    hosts: selected,
    policy: { ...CONTEXT_BUDGET_POLICY },
    reports,
    summary: {
      hosts: selected.length,
      guidanceWithinBudget: Object.values(reports)
        .filter((report) => report.guidance.withinBudget === true).length,
      startupEvaluated: Object.values(reports)
        .filter((report) => report.startup.state === 'evaluated').length,
      unsupportedHosts: Object.values(reports)
        .filter((report) => report.sourceHealth.overall === 'unsupported').length,
    },
  };
}
