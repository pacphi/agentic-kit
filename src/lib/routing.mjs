// Host-neutral per-activity LLM routing — the pure policy core (ADR-0001..0006).
//
// One policy (kit.json `routing.routes`) is the single source of truth for
// "which host + model runs which activity", and is PROJECTED into downstream
// artifacts (AQE agentOverrides and host-neutral run plans). This module is pure
// (no I/O) so the projectors and defaults are unit-testable in isolation; the
// writers/UX that consume it live in providers.mjs / the commands.
import { vendorOf } from './qeCourt.mjs';
import {
  routableHostIds, primaryHostIds, validateActivityHost, effectiveHostRegistry, effectiveRoutableHostIds,
} from './adapters/index.mjs';
import { admittedAqeProviders } from './adapters/aqe-provider.mjs';

// ── Vocabulary ───────────────────────────────────────────────────────────────
// Canonical development activities ak routes (ADR-0002). Array order = display order.
export const ACTIVITIES = [
  'specification', 'architecture', 'design', 'implementation', 'testing',
  'review', 'security-scan', 'security-analysis', 'documentation',
  'debugging', 'packaging', 'release',
];

// Activities ak originated (no upstream rUv template) — flagged wherever surfaced (ADR-0002).
export const AK_ORIGINATED = new Set(['packaging', 'release']);

// Host → aqe/router provider type. OpenCode deliberately has no entry: its
// execution provider is observed per worker and must never be inferred from the
// host or silently projected into AQE's separate provider vocabulary. An
// admitted external host (P2, ADR-0031) gets no entry either, same reasoning.
export const HOST_PROVIDER = { claude: 'claude-code', codex: 'codex' };

/** Live host -> AQE provider mapping. Built-ins are stable; external mappings
 * are read from the admitted registry for every call so an adapter loaded after
 * this module was imported is selectable without restarting the process. */
export function aqeProviderForHost(host) {
  if (HOST_PROVIDER[host]) return HOST_PROVIDER[host];
  const providers = admittedAqeProviders();
  const records = Array.isArray(providers) ? providers : Object.values(providers ?? {});
  const record = records.find((entry) => (entry.hostId ?? entry.host ?? entry.manifestId) === host);
  return record?.id ?? record?.providerId ?? record?.type ?? null;
}
// Frozen at import time — built-ins only. Display strings and built-in
// listings ONLY (formatModelHelp, model catalogs below): every VALIDATION
// path (isRoutableHost, validateRoute, materializeRunPlan) consults the lazy
// effectiveRoutableHostIds()/effectiveHostRegistry() instead, so an admitted
// external host routes without this constant ever needing to change.
export const HOSTS = routableHostIds();

// Providers aqe's ProviderManager can construct — grounded in agentic-qe 3.13.1
// RUNTIME_CONSTRUCTIBLE_PROVIDERS ∩ ALL_PROVIDER_TYPES (now includes `codex`,
// issue #568). Used to validate a route's provider, mirroring upstream
// `sanitizeAgentOverrides`. Re-check on each aqe version bump (ADR-0002).
export const AQE_CONSTRUCTIBLE_PROVIDERS = [
  'claude', 'claude-code', 'codex', 'openai', 'ollama',
  'openrouter', 'gemini', 'azure-openai', 'bedrock', 'cognitum',
];

/** Runtime-constructible provider ids, including admitted external CLI
 * providers. This is intentionally a function rather than an import-time list. */
export function aqeConstructibleProviderTypes() {
  const records = admittedAqeProviders();
  const external = (Array.isArray(records) ? records : Object.values(records ?? {}))
    .map((entry) => entry.id ?? entry.providerId ?? entry.type)
    .filter(Boolean);
  return [...new Set([...AQE_CONSTRUCTIBLE_PROVIDERS, ...external])];
}

// Subscription/local providers — the ONLY targets auto-seed may use (ADR-0003
// cost safety: seeding must never route work to a metered provider).
export const SUBSCRIPTION_PROVIDERS = new Set(['claude-code', 'codex', 'ollama', 'onnx']);

// ── Model catalog ────────────────────────────────────────────────────────────
// Known-good model choices per host, surfaced as help in `ak x host pick`,
// `--help`, and docs/PROVIDERS.md. NOT a hard allow-list: any model your host CLI
// accepts also works — these are ak's curated picks. Web-verified on the date
// below; model lines move fast, so re-check and let users override (ADR-0002/0003).
// Notes must state work-per-task, not only price: a note that compares cost
// WITHOUT saying "per-token" gets read as cost-per-task, which is the axis users
// actually pay on (a model needing 2-3x the agentic turns costs more per task at
// identical per-token price). Measured end-to-end in pacphi/retort versions-blog.
export const MODEL_CATALOG_VERIFIED = '2026-08-07';
export const COST_AXIS_NOTE = 'per-token price ≠ per-task cost — a model that needs more agentic turns costs more per task at the same per-token price';
// Tier names are the pairing key for swapHostModel(): a codex tier only mirrors
// to a claude model (and back) when BOTH catalogs use the same tier string.
// Keep `flagship`/`balanced`/`fast` spelled identically on both hosts —
// renaming one side silently degrades every mirrored route to cat[0].
export const MODEL_CATALOG = {
  claude: [
    { id: 'claude-opus-5', tier: 'reasoning', note: 'top Opus — the deepest reasoning, at ~2–3× the agentic turns of a balanced model on routine work; earns it at the hard end' },
    { id: 'claude-sonnet-5', tier: 'balanced', note: 'near-Opus capability at a lower per-token price — review, spec, release' },
    { id: 'claude-fable-5', tier: 'flagship', note: 'top capability (Mythos-class, above Opus 5) — hardest problems' },
    { id: 'claude-haiku-4-5-20251001', tier: 'fast', note: 'cheap/fast — high-volume mechanical work' },
    // Still current (no deprecation notice) and still pinnable — it is simply no
    // longer what ak routes to by default. Kept listed so divergedRoutes can name
    // its cost-per-task trade when a policy is still pointing at it.
    { id: 'claude-opus-4-8', tier: 'prior', note: 'prior Opus generation — same per-token price as Opus 5, roughly half the agentic turns on routine work' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', tier: 'flagship', note: 'flagship 5.6 — strongest on complex coding, computer use and security work; first-class max reasoning effort' },
    { id: 'gpt-5.6-terra', tier: 'balanced', note: 'balanced 5.6 — everyday implementation and testing at a materially lower per-token price than sol; the gpt-5.4 replacement' },
    { id: 'gpt-5.6-luna', tier: 'fast', note: 'fastest/cheapest 5.6 — mechanical implementation, docs and packaging; the gpt-5.4-mini replacement' },
  ],
};

// ── Retired models ───────────────────────────────────────────────────────────
// Models a host has withdrawn (or announced a withdrawal date for), and what ak
// substitutes. This is NOT the same thing as divergence:
//
//   divergedRoutes()  — the defaults moved and a seeded route did not. Which
//                       side is better is activity-dependent, so it is reported
//                       neutrally and only ever changed by an explicit
//                       `ak x host refresh`.
//   RETIRED_MODELS    — the model stops answering. There is no trade to weigh
//                       and nothing for a user to decide; a route left pointing
//                       here is a future hard failure, so ak substitutes at read
//                       time (resolveRoutes) and rewrites seeded entries on sync.
//
// A `provenance: 'user'` pin is still never rewritten on disk — but it IS
// substituted at read time, because dispatching a user's pin to a model that no
// longer exists fails the run rather than honoring the pin.
//
// ONLY models the host has publicly announced a withdrawal for belong here.
// This map overrides a user's explicit pin at read time, so a wrong entry
// silently ignores deliberate intent — "we'd rather they used the newer one" is
// never sufficient grounds. Dropping a model from MODEL_CATALOG stops OFFERING
// it; adding it here asserts it no longer ANSWERS. Those are different claims
// and only the second one needs a citation.
//
// No automatic migrations are currently asserted. The 2026-08-25 OpenAI API
// catalog still publishes GPT-5.4 and GPT-5.4 mini, and its deprecations list
// does not establish the previously claimed 2026-08-31 withdrawal. A local
// host cache or a preferred successor is not enough to override a user route.
// Add an entry only with its direct first-party withdrawal-notice URL.
export const RETIRED_MODELS = Object.freeze({});

/** The retirement record for a model id, or null when it is still current. Pure. */
export function retirementOf(model) {
  return (typeof model === 'string' && RETIRED_MODELS[model]) || null;
}

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
  const lines = [
    `known-good models (verified ${MODEL_CATALOG_VERIFIED}; any model your host accepts also works):`,
    `  ${COST_AXIS_NOTE}`,
  ];
  for (const host of HOSTS) {
    lines.push(`  ${host}:`);
    for (const m of MODEL_CATALOG[host] ?? []) lines.push(`    ${m.id.padEnd(28)} ${m.tier.padEnd(10)} ${m.note}`);
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
// Frozen at import time — built-ins only, deliberately (audited for the D2
// keystone wave, ADR-0031 §1). Every current reader of PRIMARY_HOSTS
// (providers.mjs's applySetupHostFlags `--primary-host` validation, and
// x/host.mjs's `ak host pick` primary-host flag + selection menu) is the
// primary-host SELECTION UX, not an eligibility-VALIDATION path — extending
// that picker surface to an admitted external host is explicitly out of
// scope this wave (the deferred pick surface), mirroring how HOSTS above
// stays display-only. hosts.mjs's drivingHost() does NOT use this constant —
// it consults admitted.mjs's effectivePrimaryHostIds() (fresh per call)
// instead, so the eligibility PRIMITIVE is live there. That said, no
// production path drives kit.json's routing.primaryHost to an admitted
// external id today (the picker that writes it stays built-in-only, as
// above), so this is a live primitive with no live privileged caller yet —
// not an active validation gate anything currently depends on.
export const PRIMARY_HOSTS = primaryHostIds();
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
 *  @param {{host: string, model?: string, escalation?: Array<{host: string, model?: string}>}} route */
export function swapRoute(route) {
  const { host, model } = swapHostModel(route.host, route.model);
  /** @type {{host: string, model?: string, escalation?: Array<{host: string, model?: string}>}} */
  const out = { host, ...(model ? { model } : {}) };
  if (route.escalation?.length) out.escalation = route.escalation.map((e) => swapHostModel(e.host, e.model));
  return out;
}

// ── Default routes ───────────────────────────────────────────────────────────
// Grounded in rUv's shipped CollaborationTemplates (ADR-0002): architect→claude,
// coder/tester→codex, reviewer→claude, securityAudit scanner/fixer→codex,
// analyzer→claude. packaging/release are ak-originated gap-fills. Model IDs are
// soft defaults, web-verified (see MODEL_CATALOG_VERIFIED); users override freely.
const R = (host, model, escalation) => ({ host, model, ...(escalation ? { escalation } : {}) });
export const DEFAULT_ROUTES = {
  specification:       R('claude', 'claude-sonnet-5'),
  architecture:        R('claude', 'claude-opus-5'),
  design:              R('claude', 'claude-opus-5'),
  implementation:      R('codex',  'gpt-5.6-terra', [{ host: 'claude', model: 'claude-opus-5' }]),
  testing:             R('codex',  'gpt-5.6-terra', [{ host: 'claude', model: 'claude-opus-5' }]),
  review:              R('claude', 'claude-sonnet-5'),
  'security-scan':     R('codex',  'gpt-5.6-terra'),
  'security-analysis': R('claude', 'claude-opus-5'),
  documentation:       R('codex',  'gpt-5.6-luna'),
  debugging:           R('claude', 'claude-opus-5'),
  packaging:           R('codex',  'gpt-5.6-luna'),
  release:             R('claude', 'claude-sonnet-5'),
};

// Curated aqe agent-type → activity map for the agentOverrides projection.
// Only the QE-relevant activities have aqe agents; the rest are pipeline roles.
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

/** True when `host` is routable: a built-in, or an admitted external host
 *  whose manifest declared capabilities.canRouteActivities (P2, ADR-0031).
 *  Lazy — re-reads the effective registry on every call, so it reflects an
 *  overlay applied after this module first loaded. */
export function isRoutableHost(host) {
  return effectiveRoutableHostIds().includes(host);
}

/** Substitute a retired model for its replacement, recording what was swapped.
 *  Returns the model unchanged (and `null` retirement) when it is still current.
 *  A null/absent model stays null — that means "let the adapter decide", which
 *  is already safe. Pure. */
function substituteRetired(model) {
  const r = retirementOf(model);
  return r ? { model: r.replacement, retiredFrom: model } : { model, retiredFrom: null };
}

/** Apply substituteRetired down an escalation ladder, preserving rung order and
 *  host. Returns null when there is nothing to escalate to. Pure. */
function substituteRetiredLadder(escalation) {
  if (!escalation?.length) return null;
  return escalation.map((rung) => {
    const { model, retiredFrom } = substituteRetired(rung.model);
    return { ...rung, ...(model ? { model } : {}), ...(retiredFrom ? { retiredFrom } : {}) };
  });
}

/**
 * Effective routes = DEFAULT_ROUTES overlaid with the persisted policy, each
 * carrying provenance. A persisted entry defaults its `provenance` to 'user' (a
 * hand edit is intent); `seedActivityRoutes` stamps 'seeded'; an unset activity
 * is 'default'.
 *
 * Retired models are substituted here, at the READ boundary, so nothing ak
 * dispatches can target a model the host has withdrawn — including a `user` pin,
 * which is honored everywhere else but cannot be honored into a model that no
 * longer answers. A substituted route carries `retiredFrom` (the id that was
 * replaced) so surfaces can say what happened instead of silently differing from
 * the file on disk. See RETIRED_MODELS for why this is not divergence.
 */
export function resolveRoutes(policy = {}) {
  const out = {};
  for (const act of ACTIVITIES) {
    const def = DEFAULT_ROUTES[act];
    const p = policy[act];
    if (!p) { out[act] = { ...def, provenance: 'default', akOriginated: AK_ORIGINATED.has(act) }; continue; }
    // A host-only override must NOT inherit the previous host's default
    // model: `--route implementation:claude` handing codex's default model
    // to the claude CLI is a live model/protocol error (qe-court B1). The
    // default only falls forward for the SAME host; a cross-host override
    // leaves the model to the adapter's own default (null).
    const raw = p.model ?? (p.host && p.host !== def.host ? null : def.model);
    const { model, retiredFrom } = substituteRetired(raw);
    const ladder = substituteRetiredLadder(p.escalation ?? def.escalation);
    out[act] = {
      host: p.host ?? def.host,
      model,
      ...(ladder ? { escalation: ladder } : {}),
      provenance: p.provenance ?? 'user',
      akOriginated: AK_ORIGINATED.has(act),
      ...(retiredFrom ? { retiredFrom } : {}),
    };
  }
  return out;
}

/**
 * Seeded routes still pointing at a retired model on disk, and the rewrite that
 * would fix them. Pure — the caller persists.
 *
 * Only `provenance === 'seeded'` entries are rewritten: ak wrote those values,
 * so ak may correct them. A `user` pin is reported (so the user learns their
 * pin is dead) but never rewritten — resolveRoutes already keeps the run safe.
 *
 * Escalation rungs are migrated independently of the primary model: a route
 * whose own model is current can still escalate into a retired one.
 *
 * @param {Record<string, any>} [policy]
 * @returns {{ routes: Record<string, any>, changes: Array<{
 *   activity: string, field: string, from: string, to: string,
 *   retiresOn: string|null, provenance: string, rewritten: boolean }> }}
 */
export function migrateRetiredRoutes(policy = {}) {
  const routes = structuredClone(policy);
  const changes = [];
  for (const [activity, entry] of Object.entries(routes)) {
    if (!entry || typeof entry !== 'object') continue;
    const provenance = entry.provenance ?? 'user';
    const rewritten = provenance === 'seeded';
    const note = (field, from, retirement) => changes.push({
      activity, field, from, to: retirement.replacement,
      retiresOn: retirement.retiresOn, provenance, rewritten,
    });

    const primary = retirementOf(entry.model);
    if (primary) {
      note('model', entry.model, primary);
      if (rewritten) entry.model = primary.replacement;
    }
    for (const [i, rung] of (entry.escalation ?? []).entries()) {
      const r = retirementOf(rung?.model);
      if (!r) continue;
      note(`escalation[${i}].model`, rung.model, r);
      if (rewritten) rung.model = r.replacement;
    }
  }
  return { routes, changes };
}

/**
 * Seed a policy from defaults for the seedable activities (ADR-0003). Cost-safety:
 * only routes whose host maps to a subscription/local provider are seeded, and
 * only for the hosts the caller passes as usable. When `primary` is 'codex', each
 * default route is mirrored to the opposite host (swapRoute) so codex leads and
 * claude is the alternate. Gating on enablement + aqe version is the caller's job
 * (seedActivityRoutesIfMultiHost); this does NOT verify the host CLI is installed.
 * Returns entries stamped `provenance: 'seeded'`.
 */
export function seedActivityRoutes({ hosts = HOSTS, primary = DEFAULT_PRIMARY_HOST } = {}) {
  const usable = new Set(hosts);
  const swap = primary === 'codex';
  const policy = {};
  for (const act of ACTIVITIES) {
    const def = swap ? { ...DEFAULT_ROUTES[act], ...swapRoute(DEFAULT_ROUTES[act]) } : DEFAULT_ROUTES[act];
    if (!usable.has(def.host)) continue;
    if (!SUBSCRIPTION_PROVIDERS.has(HOST_PROVIDER[def.host])) continue;
    policy[act] = {
      host: def.host, model: def.model,
      ...(def.escalation ? { escalation: def.escalation } : {}),
      provenance: 'seeded',
    };
  }
  return policy;
}

/** The catalog note for a model id (its cost-per-task characteristic), or null.
 *  Searches host + provider catalogs so a refresh diff can explain the trade. */
export function modelNote(model) {
  for (const list of [...Object.values(MODEL_CATALOG), ...Object.values(PROVIDER_MODEL_CATALOG)]) {
    const m = list.find((e) => e.id === model);
    if (m) return m.note;
  }
  return null;
}

/** What seeding would produce for `act` TODAY, on the host the entry already
 *  sits on. A codex-primary seed mirrors every default route to the opposite
 *  host (swapRoute), so comparing against the raw default would read every
 *  mirrored route as diverged — mirror first when the hosts disagree. Pure. */
function currentSeedFor(act, entry = {}) {
  const def = DEFAULT_ROUTES[act];
  if (!def) return null;
  return entry.host && entry.host !== def.host ? { ...def, ...swapRoute(def) } : def;
}

/**
 * Seeded routes whose model no longer matches what seeding would produce today —
 * ak chose these values, the defaults have since moved, and nothing re-seeds them.
 * Pure.
 *
 * Only `provenance === 'seeded'` entries are reported: a 'user' pin is deliberate
 * intent and is never divergence.
 *
 * Which side is better is activity-dependent (a newer default can cost 2-3× the
 * agentic turns on routine work), so callers must present this neutrally — a
 * divergence to decide about, not a lag to clear.
 */
export function divergedRoutes(policy = {}) {
  const out = [];
  for (const act of ACTIVITIES) {
    const p = policy[act];
    if (!p || p.provenance !== 'seeded') continue;
    const want = currentSeedFor(act, p);
    if (!want) continue;
    const modelDiverged = !!(want.model && p.model && p.model !== want.model);
    // An escalation rung is a routing decision too, and it diverges on its own
    // schedule: a seed whose primary model never moved can still escalate into a
    // model the defaults have since replaced.
    const escalation = (p.escalation ?? []).map((rung, i) => {
      const wantRung = want.escalation?.[i];
      return wantRung && rung.model !== wantRung.model
        ? { host: rung.host, model: rung.model, defaultModel: wantRung.model }
        : null;
    }).filter(Boolean);
    if (!modelDiverged && escalation.length === 0) continue;
    out.push({
      activity: act,
      host: p.host ?? want.host,
      model: p.model,
      defaultHost: want.host,
      defaultModel: want.model,
      modelDiverged,
      escalation,
      defaultNote: modelNote(want.model),
      currentNote: modelNote(p.model),
    });
  }
  return out;
}

/**
 * Re-seed the named activities from the current defaults, returning a NEW policy.
 * Only `provenance === 'seeded'` entries are eligible — a user pin survives untouched
 * even when named. `activities` defaults to every diverged activity. Pure.
 * @param {Record<string, any>} [policy]
 * @param {{ activities?: string[] }} [opts]
 */
export function refreshSeededRoutes(policy = {}, { activities } = {}) {
  const eligible = new Set(divergedRoutes(policy).map((d) => d.activity));
  const want = new Set(activities ?? [...eligible]);
  const out = { ...policy };
  for (const act of want) {
    if (!eligible.has(act)) continue;
    const seed = currentSeedFor(act, out[act]);
    out[act] = {
      host: seed.host,
      model: seed.model,
      ...(seed.escalation ? { escalation: seed.escalation } : {}),
      provenance: 'seeded',
    };
  }
  return out;
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
    const provider = aqeProviderForHost(r.host);
    if (!aqeConstructibleProviderTypes().includes(provider)) continue;
    overrides[agent] = { provider, model: r.model };
  }
  return overrides;
}

/** Project only explicitly persisted routes. This intentionally does not fill
 * holes from dual-host defaults: a host-disable operation may remove an entry,
 * and projecting a default for that hole would reintroduce the disabled host. */
export function configuredPolicyToAgentOverrides(policy = {}, { agentMap = AGENT_ACTIVITY_MAP } = {}) {
  const overrides = {};
  for (const [agent, act] of Object.entries(agentMap)) {
    const route = policy[act];
    if (!route) continue;
    const provider = aqeProviderForHost(route.host);
    if (!aqeConstructibleProviderTypes().includes(provider)) continue;
    overrides[agent] = { provider, model: route.model };
  }
  return overrides;
}

/** Drift predicate for the status↔sync contract (#129): does the on-disk
 * `agentOverrides` object diverge from what applyAqeRouter would write for this
 * policy? Judged by the WRITER's projection (configured routes only) and only
 * over ak-managed keys, key-wise — foreign entries and JSON key order belong to
 * the writer's merge domain and must never read as drift. */
export function agentOverridesDrift(diskOverrides, policy = {}, { agentMap = AGENT_ACTIVITY_MAP } = {}) {
  const disk = diskOverrides ?? {};
  const want = configuredPolicyToAgentOverrides(policy, { agentMap });
  for (const agent of Object.keys(agentMap)) {
    const a = disk[agent];
    const b = want[agent];
    if (!a && !b) continue;
    if (!a || !b) return true;
    if (a.provider !== b.provider || (a.model ?? null) !== (b.model ?? null)) return true;
  }
  return false;
}

/** Remove disabled hosts from persisted routes and escalation ladders. Seeded
 * entries are ak-owned and silent; user pins return actionable warnings. */
export function pruneRoutesForHosts(policy = {}, { hosts = HOSTS } = {}) {
  const enabled = new Set(hosts);
  const next = {};
  const warnings = [];
  const pruned = [];
  for (const [activity, route] of Object.entries(policy)) {
    const provenance = route?.provenance ?? 'user';
    if (!enabled.has(route?.host)) {
      pruned.push({ activity, kind: 'route', host: route?.host ?? null, provenance });
      if (provenance !== 'seeded') warnings.push(`removed user route '${activity}' — host '${route?.host ?? 'unknown'}' is disabled`);
      continue;
    }
    const before = Array.isArray(route.escalation) ? route.escalation : [];
    const escalation = before.filter((rung) => enabled.has(rung?.host));
    const removed = before.filter((rung) => !enabled.has(rung?.host));
    for (const rung of removed) {
      pruned.push({ activity, kind: 'escalation', host: rung?.host ?? null, provenance });
      if (provenance !== 'seeded') warnings.push(`removed user escalation for '${activity}' — host '${rung?.host ?? 'unknown'}' is disabled`);
    }
    next[activity] = { ...route, ...(escalation.length ? { escalation } : {}) };
    if (removed.length && !escalation.length) delete next[activity].escalation;
  }
  return { policy: next, pruned, warnings };
}

// ── Host-neutral run templates ──────────────────────────────────────────────
// A template is an ordered DAG of activities; the policy fills host+model per
// node. Grounded in rUv's CollaborationTemplates (feature/security/refactor);
// packaging/release are ak-added (ADR-0002).
export const RUN_TEMPLATES = {
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
export const RUN_TEMPLATE_NAMES = Object.keys(RUN_TEMPLATES);

/**
 * Build a host-neutral execution plan. Each template node becomes a worker whose
 * host + model come from the policy's effective route for that node's activity.
 * Throws on an unknown template.
 */
export function materializeRunPlan(policy = {}, { template = 'feature', task = '' } = {}) {
  const nodes = RUN_TEMPLATES[template];
  if (!nodes) throw new Error(`unknown template "${template}" (expected: ${RUN_TEMPLATE_NAMES.join(', ')})`);
  const routes = resolveRoutes(policy);
  // Snapshot once per materialization (not per validateActivityHost call): an
  // admitted overlay applied mid-call must not be able to make one worker's
  // eligibility check see a different registry than another's in the same plan.
  const hosts = effectiveHostRegistry();
  return {
    template,
    workers: nodes.map((n) => {
    const r = routes[n.activity];
    const eligibility = validateActivityHost(r.host, hosts);
    if (!eligibility.ok) {
      throw new Error(`route for "${n.activity}" cannot materialize: host "${r.host}" requires canRouteActivities`);
    }
    // The escalation ladder travels with the worker (ADR-0019). Self-equal
    // rungs are dropped here (escalating to the same host+model would re-run
    // the identical attempt — the legacy L4 rule), and every rung must be a
    // routable host or materialization fails the same way the primary does.
    const ladder = (r.escalation ?? [])
      .filter((rung) => rung && (rung.host !== r.host || (rung.model ?? null) !== (r.model ?? null)))
      .map((rung) => {
        const rungEligibility = validateActivityHost(rung.host, hosts);
        if (!rungEligibility.ok) {
          throw new Error(`escalation rung for "${n.activity}" cannot materialize: host "${rung.host}" requires canRouteActivities`);
        }
        return { host: rung.host, model: rung.model ?? null };
      });
    return {
      id: n.id,
      activity: n.activity,
      host: r.host,
      role: n.role,
      configuredModel: r.model ?? null,
      prompt: n.prompt(task),
      ...(n.dependsOn ? { dependsOn: n.dependsOn } : {}),
      ...(n.maxTurns ? { maxTurns: n.maxTurns } : {}),
      ...(ladder.length ? { escalate: ladder } : {}),
    };
    }),
  };
}

/**
 * Distinct vendors across the routed activities, via qe-court's classifier.
 * ≥2 = cross-vendor coverage (the qe-court diversity property; ADR-0004).
 */
export function routedVendors(policy = {}) {
  const routes = resolveRoutes(policy);
  return new Set(Object.values(routes)
    .map((r) => aqeProviderForHost(r.host))
    .filter(Boolean)
    .map((provider) => vendorOf(provider))
    .filter(Boolean));
}

/** Compact summary for status rows / dashboard / tables. */
export function routingSummary(policy = {}) {
  const routes = Object.values(resolveRoutes(policy));
  const byHost = {};
  for (const r of routes) byHost[r.host] = (byHost[r.host] ?? 0) + 1;
  return {
    total: routes.length,
    seeded: routes.filter((r) => r.provenance === 'seeded').length,
    custom: routes.filter((r) => r.provenance === 'user').length,
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
  if (!isRoutableHost(host)) errs.push(`unknown host "${host}" (expected: ${effectiveRoutableHostIds().join('|')})`);
  else if (aqeProviderForHost(host) && !aqeConstructibleProviderTypes().includes(aqeProviderForHost(host))) errs.push(`host "${host}" maps to a non-constructible provider`);
  if (model != null && (typeof model !== 'string' || model.trim() === '')) errs.push('model must be a non-empty string');
  return errs;
}

/**
 * Parse a repeatable `--route "activity:host[:model]"` CLI spec into a partial
 * policy (`provenance:'user'`). Sibling to provider.mjs's parseFallback. Unknown
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
    policy[activity] = { host, ...(model ? { model } : {}), provenance: 'user' };
  }
  return { policy, warnings };
}
