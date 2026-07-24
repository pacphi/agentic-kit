// Dual-host per-activity LLM routing — the pure policy core (ADR-0001..0005).
//
// One policy (kit.json `providers.dualRouting`) is the single source of truth for
// "which host + model runs which activity", and is PROJECTED into downstream
// artifacts (aqe agentOverrides, dual-run config, codex MCP). This module is pure
// (no I/O) so the projectors and defaults are unit-testable in isolation; the
// writers/UX that consume it live in providers.mjs / the commands.
import { vendorOf } from './qeCourt.mjs';

// ── Vocabulary ───────────────────────────────────────────────────────────────
// Canonical development activities ak routes (ADR-0002). Array order = display order.
export const ACTIVITIES = [
  'specification', 'architecture', 'design', 'implementation', 'testing',
  'review', 'security-scan', 'security-analysis', 'documentation',
  'debugging', 'packaging', 'release',
];

// Activities ak originated (no upstream rUv template) — flagged wherever surfaced (ADR-0002).
export const AK_ORIGINATED = new Set(['packaging', 'release']);

// Host → aqe/router provider type. Both are subscription-billed ($0 marginal).
export const HOST_PROVIDER = { claude: 'claude-code', codex: 'codex' };
export const HOSTS = Object.keys(HOST_PROVIDER);

// Providers aqe's ProviderManager can construct — grounded in agentic-qe 3.13.1
// RUNTIME_CONSTRUCTIBLE_PROVIDERS ∩ ALL_PROVIDER_TYPES (now includes `codex`,
// issue #568). Used to validate a route's provider, mirroring upstream
// `sanitizeAgentOverrides`. Re-check on each aqe version bump (ADR-0002).
export const AQE_CONSTRUCTIBLE_PROVIDERS = [
  'claude', 'claude-code', 'codex', 'openai', 'ollama',
  'openrouter', 'gemini', 'azure-openai', 'bedrock', 'cognitum',
];

// Subscription/local providers — the ONLY targets auto-seed may use (ADR-0003
// cost safety: seeding must never route work to a metered provider).
export const SUBSCRIPTION_PROVIDERS = new Set(['claude-code', 'codex', 'ollama', 'onnx']);

// ── Model catalog ────────────────────────────────────────────────────────────
// Known-good model choices per host, surfaced as help in `ak x provider pick`,
// `--help`, and docs/PROVIDERS.md. NOT a hard allow-list: any model your host CLI
// accepts also works — these are ak's curated picks. Web-verified on the date
// below; model lines move fast, so re-check and let users override (ADR-0002/0003).
export const MODEL_CATALOG_VERIFIED = '2026-07-23';
export const MODEL_CATALOG = {
  claude: [
    { id: 'claude-opus-4-8', tier: 'reasoning', note: 'deep reasoning — architecture, design, hard debugging' },
    { id: 'claude-sonnet-5', tier: 'balanced', note: 'near-Opus at lower cost — review, spec, release' },
    { id: 'claude-fable-5', tier: 'flagship', note: 'top capability (above Opus), premium — hardest problems' },
    { id: 'claude-haiku-4-5-20251001', tier: 'fast', note: 'cheap/fast — high-volume mechanical work' },
  ],
  codex: [
    { id: 'gpt-5.4', tier: 'flagship', note: 'coding + reasoning + agentic — recommended execution default' },
    { id: 'gpt-5.6-sol', tier: 'newest', note: 'newest line; first-class max reasoning effort' },
    { id: 'gpt-5.3-codex', tier: 'coding', note: 'pure coding-tuned — mechanical implementation & docs' },
    { id: 'gpt-5-codex-mini', tier: 'cheap', note: 'smallest/cheapest — escalation floor, high volume' },
  ],
};

// Provider-axis model catalog — LLMs reached through the aqe fallback chain
// (`--aqe-fallback`) or ruflo's routers, NOT hosts (they don't drive the ruflo
// loop, so they never appear in HOSTS/HOST_PROVIDER). Metered: keys live in the
// env (e.g. OPENROUTER_API_KEY), never kit.json, and these must never be an
// auto-seed target (SUBSCRIPTION_PROVIDERS excludes them — ADR-0003 cost safety).
// GLM ids web-verified against openrouter on MODEL_CATALOG_VERIFIED.
export const PROVIDER_MODEL_CATALOG = {
  openrouter: [
    { id: 'z-ai/glm-5.2', tier: 'flagship', note: 'GLM 5.2 — 1M context, strong tool-use, long-horizon agent work (metered)' },
    { id: 'z-ai/glm-5', tier: 'value', note: 'GLM 5 — 205K context, cheapest of the 5.x line (metered)' },
  ],
};

/** Model choices for a host (for prompts / help). Unknown host → []. */
export function modelChoices(host) {
  return MODEL_CATALOG[host] ?? [];
}

/** Curated model choices for a provider-axis LLM (openrouter/GLM, …). Unknown → []. */
export function providerModelChoices(provider) {
  return PROVIDER_MODEL_CATALOG[provider] ?? [];
}

/** Human-readable model-choice lines for CLI help / interactive prompts. Covers
 *  host models (claude/codex) and provider-axis models (openrouter/GLM) reachable
 *  via the aqe fallback chain. */
export function formatModelHelp() {
  const lines = [`known-good models (verified ${MODEL_CATALOG_VERIFIED}; any model your host accepts also works):`];
  for (const host of HOSTS) {
    lines.push(`  ${host}:`);
    for (const m of MODEL_CATALOG[host]) lines.push(`    ${m.id.padEnd(28)} ${m.tier.padEnd(10)} ${m.note}`);
  }
  for (const [prov, models] of Object.entries(PROVIDER_MODEL_CATALOG)) {
    lines.push(`  ${prov} (aqe-fallback provider — metered):`);
    for (const m of models) lines.push(`    ${m.id.padEnd(28)} ${m.tier.padEnd(10)} ${m.note}`);
  }
  return lines.join('\n');
}

// ── Primary-host swap (ambidextrous defaults) ────────────────────────────────
// DEFAULT_ROUTES encode rUv's shipped role→host assignments (claude leads the
// reasoning roles). When codex is chosen as PRIMARY, we mirror each default route
// to the opposite host so codex takes the lead and claude becomes the alternate —
// a defaults/policy change only (DualModeOrchestrator workers are symmetric).
export const PRIMARY_HOSTS = HOSTS; // both hosts may be primary
export const DEFAULT_PRIMARY_HOST = 'claude';

// Model id → tier, so a host swap can pick the counterpart's tier-equivalent.
// Built from the catalog so it never drifts from the curated model lines.
const MODEL_TIER = Object.fromEntries(
  HOSTS.flatMap((h) => (MODEL_CATALOG[h] ?? []).map((m) => [m.id, m.tier])),
);

/** The opposite host's best model when swapping. Tier names differ between claude
 *  and codex, so an exact-tier match is best-effort; else fall back to that host's
 *  first (recommended) model. Pure. */
export function swapHostModel(host, model) {
  const other = host === 'claude' ? 'codex' : 'claude';
  const cat = MODEL_CATALOG[other] ?? [];
  const tier = MODEL_TIER[model];
  const pick = (tier && cat.find((m) => m.tier === tier)) || cat[0];
  return { host: other, model: pick?.id };
}

/** Mirror a route to the opposite host (host + model + escalation ladder). Pure.
 *  @param {{host: string, model?: string, escalate?: Array<{host: string, model?: string}>}} route */
export function swapRoute(route) {
  const { host, model } = swapHostModel(route.host, route.model);
  /** @type {{host: string, model?: string, escalate?: Array<{host: string, model?: string}>}} */
  const out = { host, ...(model ? { model } : {}) };
  if (route.escalate?.length) out.escalate = route.escalate.map((e) => swapHostModel(e.host, e.model));
  return out;
}

// ── Default routes ───────────────────────────────────────────────────────────
// Grounded in rUv's shipped CollaborationTemplates (ADR-0002): architect→claude,
// coder/tester→codex, reviewer→claude, securityAudit scanner/fixer→codex,
// analyzer→claude. packaging/release are ak-originated gap-fills. Model IDs are
// soft defaults, web-verified (see MODEL_CATALOG_VERIFIED); users override freely.
const R = (host, model, escalate) => ({ host, model, ...(escalate ? { escalate } : {}) });
export const DEFAULT_ROUTES = {
  specification:       R('claude', 'claude-sonnet-5'),
  architecture:        R('claude', 'claude-opus-4-8'),
  design:              R('claude', 'claude-opus-4-8'),
  implementation:      R('codex',  'gpt-5.4', [{ host: 'claude', model: 'claude-opus-4-8' }]),
  testing:             R('codex',  'gpt-5.4', [{ host: 'claude', model: 'claude-opus-4-8' }]),
  review:              R('claude', 'claude-sonnet-5'),
  'security-scan':     R('codex',  'gpt-5.4'),
  'security-analysis': R('claude', 'claude-opus-4-8'),
  documentation:       R('codex',  'gpt-5.3-codex'),
  debugging:           R('claude', 'claude-opus-4-8'),
  packaging:           R('codex',  'gpt-5.3-codex'),
  release:             R('claude', 'claude-sonnet-5'),
};

// Curated aqe agent-type → activity map for the agentOverrides projection.
// Only the QE-relevant activities have aqe agents; the rest are dual-run roles.
export const AGENT_ACTIVITY_MAP = {
  'qe-security-scanner': 'security-scan',
  'qe-security-auditor': 'security-scan',
  'qe-pentest-validator': 'security-scan',
  'qe-security-reviewer': 'security-analysis',
  'qe-test-architect': 'testing',
  'qe-test-generator': 'testing',
  'qe-coverage-specialist': 'testing',
  'qe-mutation-tester': 'testing',
  'qe-code-reviewer': 'review',
  'qe-integration-reviewer': 'review',
  'qe-performance-reviewer': 'review',
  'qe-requirements-validator': 'specification',
};

// ── Policy resolution + projections (pure) ──────────────────────────────────

/** True when both frontier hosts appear in a route (a route's host is valid). */
export function isRoutableHost(host) {
  return HOSTS.includes(host);
}

/**
 * Effective routes = DEFAULT_ROUTES overlaid with the persisted policy, each
 * carrying provenance. A persisted entry defaults its `source` to 'user' (a hand
 * edit is intent); `seedDualRouting` stamps 'seeded'; an unset activity is 'default'.
 */
export function resolveRoutes(policy = {}) {
  const out = {};
  for (const act of ACTIVITIES) {
    const def = DEFAULT_ROUTES[act];
    const p = policy[act];
    if (!p) { out[act] = { ...def, source: 'default', akOriginated: AK_ORIGINATED.has(act) }; continue; }
    out[act] = {
      host: p.host ?? def.host,
      model: p.model ?? def.model,
      ...((p.escalate ?? def.escalate) ? { escalate: p.escalate ?? def.escalate } : {}),
      source: p.source ?? 'user',
      akOriginated: AK_ORIGINATED.has(act),
    };
  }
  return out;
}

/**
 * Seed a policy from defaults for the seedable activities (ADR-0003). Cost-safety:
 * only routes whose host maps to a subscription/local provider are seeded, and
 * only for the hosts the caller passes as usable. When `primary` is 'codex', each
 * default route is mirrored to the opposite host (swapRoute) so codex leads and
 * claude is the alternate. Gating on enablement + aqe version is the caller's job
 * (seedDualRoutingIfDualHost); this does NOT verify the host CLI is installed.
 * Returns entries stamped `source: 'seeded'`.
 */
export function seedDualRouting({ hosts = HOSTS, primary = DEFAULT_PRIMARY_HOST } = {}) {
  const usable = new Set(hosts);
  const swap = primary === 'codex';
  const policy = {};
  for (const act of ACTIVITIES) {
    const def = swap ? { ...DEFAULT_ROUTES[act], ...swapRoute(DEFAULT_ROUTES[act]) } : DEFAULT_ROUTES[act];
    if (!usable.has(def.host)) continue;
    if (!SUBSCRIPTION_PROVIDERS.has(HOST_PROVIDER[def.host])) continue;
    policy[act] = {
      host: def.host, model: def.model,
      ...(def.escalate ? { escalate: def.escalate } : {}),
      source: 'seeded',
    };
  }
  return policy;
}

/**
 * Projection #1 → aqe `agentOverrides`. Map curated QE agent-types to the
 * {provider, model} of their activity's effective route. Drops any whose provider
 * isn't runtime-constructible (mirrors upstream `sanitizeAgentOverrides`), so a
 * bad route can never write an entry aqe would reject.
 */
export function policyToAgentOverrides(policy = {}, { agentMap = AGENT_ACTIVITY_MAP } = {}) {
  const routes = resolveRoutes(policy);
  const overrides = {};
  for (const [agent, act] of Object.entries(agentMap)) {
    const r = routes[act];
    if (!r) continue;
    const provider = HOST_PROVIDER[r.host];
    if (!AQE_CONSTRUCTIBLE_PROVIDERS.includes(provider)) continue;
    overrides[agent] = { provider, model: r.model };
  }
  return overrides;
}

// ── Projection #2: dual-run collaboration config ────────────────────────────
// A template is an ordered DAG of activities; the policy fills host+model per
// node. Grounded in rUv's CollaborationTemplates (feature/security/refactor);
// packaging/release are ak-added (ADR-0002). Consumed by `claude-flow-codex dual
// run --config` (each node → a worker {id, platform, role, model, prompt, dependsOn}).
export const DUAL_RUN_TEMPLATES = {
  feature: [
    { id: 'architect', role: 'architect', activity: 'architecture', maxTurns: 10, prompt: (t) => `Design the architecture for: ${t}. Define components, interfaces, and data flow.` },
    { id: 'coder', role: 'coder', activity: 'implementation', dependsOn: ['architect'], maxTurns: 15, prompt: (t) => `Implement "${t}" from the architecture. Write clean, typed code.` },
    { id: 'tester', role: 'tester', activity: 'testing', dependsOn: ['coder'], maxTurns: 10, prompt: () => 'Write comprehensive tests for the implementation. Target meaningful coverage.' },
    { id: 'reviewer', role: 'reviewer', activity: 'review', dependsOn: ['coder', 'tester'], maxTurns: 8, prompt: () => 'Review the code and tests for correctness, security, and best practices.' },
  ],
  security: [
    { id: 'scanner', role: 'scanner', activity: 'security-scan', maxTurns: 8, prompt: (t) => `Scan ${t} for security vulnerabilities; enumerate findings with severity.` },
    { id: 'analyzer', role: 'analyzer', activity: 'security-analysis', dependsOn: ['scanner'], maxTurns: 10, prompt: () => 'Analyze the findings; confirm true positives and identify root causes.' },
    { id: 'fixer', role: 'fixer', activity: 'security-scan', dependsOn: ['analyzer'], maxTurns: 12, prompt: () => 'Fix the confirmed vulnerabilities. Keep changes minimal and covered by tests.' },
  ],
  refactor: [
    { id: 'architect', role: 'architect', activity: 'design', maxTurns: 10, prompt: (t) => `Plan a refactor of ${t}: target structure, seams, and a safety net.` },
    { id: 'coder', role: 'coder', activity: 'implementation', dependsOn: ['architect'], maxTurns: 15, prompt: () => 'Apply the refactor in small steps; preserve behavior.' },
    { id: 'tester', role: 'tester', activity: 'testing', dependsOn: ['coder'], maxTurns: 10, prompt: () => 'Add/adjust tests proving behavior is preserved.' },
    { id: 'reviewer', role: 'reviewer', activity: 'review', dependsOn: ['coder', 'tester'], maxTurns: 8, prompt: () => 'Review the refactor for regressions and clarity.' },
  ],
  packaging: [
    { id: 'packager', role: 'packager', activity: 'packaging', maxTurns: 10, prompt: (t) => `Prepare ${t} for packaging: build, metadata, and artifacts.` },
    { id: 'reviewer', role: 'reviewer', activity: 'review', dependsOn: ['packager'], maxTurns: 6, prompt: () => 'Verify the package: contents, versions, and release-readiness.' },
  ],
  release: [
    { id: 'preparer', role: 'preparer', activity: 'release', maxTurns: 10, prompt: (t) => `Prepare the release for ${t}: changelog, version bump, and tag plan.` },
    { id: 'reviewer', role: 'reviewer', activity: 'review', dependsOn: ['preparer'], maxTurns: 6, prompt: () => 'Review the release plan for correctness and completeness.' },
  ],
};
export const DUAL_RUN_TEMPLATE_NAMES = Object.keys(DUAL_RUN_TEMPLATES);

/**
 * Projection #2 → `claude-flow-codex dual run --config` JSON. Each template node
 * becomes a worker whose platform + model come from the policy's effective route
 * for that node's activity. Throws on an unknown template.
 */
export function policyToDualRunConfig(policy = {}, { template = 'feature', task = '' } = {}) {
  const nodes = DUAL_RUN_TEMPLATES[template];
  if (!nodes) throw new Error(`unknown template "${template}" (expected: ${DUAL_RUN_TEMPLATE_NAMES.join(', ')})`);
  const routes = resolveRoutes(policy);
  const workers = nodes.map((n) => {
    const r = routes[n.activity];
    return {
      id: n.id,
      platform: r.host, // 'claude' | 'codex' — matches DualModeOrchestrator's worker.platform
      role: n.role,
      model: r.model,
      prompt: n.prompt(task),
      ...(n.dependsOn ? { dependsOn: n.dependsOn } : {}),
      ...(n.maxTurns ? { maxTurns: n.maxTurns } : {}),
    };
  });
  return { workers };
}

/**
 * One escalation step (ADR-0004): a partial policy that bumps every activity with
 * an escalation ladder to its next rung (host+model). Overlay it onto the policy
 * and re-project to retry a failed dual-run on a different (cross-vendor) rung.
 */
export function escalatePolicy(policy = {}) {
  const routes = resolveRoutes(policy);
  const next = {};
  for (const [act, r] of Object.entries(routes)) {
    const rung = r.escalate?.[0];
    // skip a rung that equals the current host+model — a user override can retain
    // the default ladder, so escalating there would just re-run the same thing (L4).
    if (rung && (rung.host !== r.host || rung.model !== r.model)) {
      next[act] = { host: rung.host, model: rung.model, source: 'user' };
    }
  }
  return next;
}

/**
 * Distinct vendors across the routed activities, via qe-court's classifier.
 * ≥2 = cross-vendor coverage (the qe-court diversity property; ADR-0004).
 */
export function routedVendors(policy = {}) {
  const routes = resolveRoutes(policy);
  return new Set(Object.values(routes).map((r) => vendorOf(HOST_PROVIDER[r.host])));
}

/** Compact summary for status rows / dashboard / tables. */
export function routingSummary(policy = {}) {
  const routes = Object.values(resolveRoutes(policy));
  const byHost = {};
  for (const r of routes) byHost[r.host] = (byHost[r.host] ?? 0) + 1;
  return {
    total: routes.length,
    seeded: routes.filter((r) => r.source === 'seeded').length,
    custom: routes.filter((r) => r.source === 'user').length,
    byHost,
    vendors: routedVendors(policy).size,
  };
}

/**
 * Validate a user-supplied route; returns an array of error strings ([] = ok).
 * @param {{ host?: string, model?: string }} [route]
 * @returns {string[]}
 */
export function validateRoute(route = {}) {
  const { host, model } = route;
  const errs = [];
  if (!isRoutableHost(host)) errs.push(`unknown host "${host}" (expected: ${HOSTS.join('|')})`);
  else if (!AQE_CONSTRUCTIBLE_PROVIDERS.includes(HOST_PROVIDER[host])) errs.push(`host "${host}" maps to a non-constructible provider`);
  if (model != null && (typeof model !== 'string' || model.trim() === '')) errs.push('model must be a non-empty string');
  return errs;
}

/**
 * Parse a repeatable `--route "activity:host[:model]"` CLI spec into a partial
 * policy (source:'user'). Sibling to provider.mjs's parseFallback. Unknown
 * activities/hosts are collected as warnings, not thrown.
 */
export function parseRouteSpecs(specs = []) {
  const policy = {};
  const warnings = [];
  for (const spec of specs) {
    const parts = String(spec).split(':').map((s) => s?.trim());
    const activity = parts[0];
    const host = parts[1];
    const model = parts.slice(2).join(':') || undefined; // rejoin so model ids may contain ':' (L5)
    if (!ACTIVITIES.includes(activity)) { warnings.push(`unknown activity "${activity}" — ignored`); continue; }
    const errs = validateRoute({ host, model });
    if (errs.length) { warnings.push(`route "${spec}": ${errs.join('; ')} — ignored`); continue; }
    policy[activity] = { host, ...(model ? { model } : {}), source: 'user' };
  }
  return { policy, warnings };
}
