// Frontier-host + LLM-provider detection and wiring.
//
// why: rUv ships this downstream — ak only detects + wires it (detect→heal→verify),
// it does NOT reimplement provider machinery. Grounded in rUv source:
//   - ruflo ADR-034 "Optional MCP Backends" (ACCEPTED): Claude Code / Gemini / OpenAI
//     Codex backends are enabled via env vars ENABLE_CLAUDE_CODE / ENABLE_CODEX /
//     ENABLE_GEMINI_MCP.
//   - `ruflo providers configure -p <id> -m <model> [-e <endpoint>]` persists
//     provider records to ruflo's project config. Ruflo >=3.38.8's direct
//     agent_execute path consumes persisted Ollama/OpenRouter entries (#2962).
//   - agentic-qe LLM selector `AQE_LLM_PROVIDER=<type>` (ADR-123,
//     dist/shared/llm/router/config-store.js) force-selects ANY provider in
//     ALL_PROVIDER_TYPES — claude-code (subscription), claude/openai/gemini/
//     openrouter/azure-openai/bedrock/cognitum (metered api), ollama (local). It
//     normalizes `anthropic`→`claude` and warns on unknown values. So aqe is NOT
//     limited to claude-code; codex-the-CLI simply isn't a provider *type* (its
//     OpenAI models are reached via `openai`).
//
// Two independent axes:
//   host axis     — which agent CLI executes a managed worker (claude, codex,
//                   opencode).
//   provider axis — which LLM the *routers* use: ruflo's persisted providers
//                   (`ruflo providers configure`) and aqe's `AQE_LLM_PROVIDER`.
//                   Independent of the host axis; keys live in the env, never kit.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run, have } from './exec.mjs';
import { readJson, writeJsonWithBackup } from './settings.mjs';
import { saveKitConfig } from './config.mjs';
import { installedVersion, cmpVersions } from './versions.mjs';
import * as paths from './paths.mjs';
import {
  bold, dim, cyan, reportOutcome,
} from './output.mjs';
import { configuredPolicyToAgentOverrides, seedActivityRoutes, resolveRoutes, routingSummary, divergedRoutes, migrateRetiredRoutes, ACTIVITIES, AGENT_ACTIVITY_MAP, PRIMARY_HOSTS } from './routing.mjs';
import { HOST_ADAPTERS } from './hosts.mjs';
import {
  HOST_REGISTRY, PROVIDER_REGISTRY, normalizeIntegrationFacts, defaultHostMap,
} from './adapters/index.mjs';
import { CURRENT_INTEGRATIONS_VERSION, validateEndpoint } from './adapters/config.mjs';
import { opencodeMcpStatus } from './opencode.mjs';
import { codexMcpStatus, rufloCodexMcpStatus } from './mcp.mjs';
import { admittedAqeProviders, projectedAqeExternalProviders } from './adapters/aqe-provider.mjs';
import {
  DEFAULT_PRIMARY_HOST,
  ROUTING_SCHEMA_VERSION,
} from './routing-config.mjs';

/** Frontier agent-CLI hosts. `pkg` is the npm global package; `enableEnv` is
 *  ruflo's ADR-034 backend flag; `aqe` is the AQE_LLM_PROVIDER value (null when
 *  aqe can't host it). */
export const HOSTS = HOST_REGISTRY
  .filter((host) => host.capabilities.canDriveSession)
  .map((host) => ({
    id: host.id, bin: host.install.bin, pkg: host.install.npmPackage,
    enableEnv: host.legacy?.enableEnv ?? null,
    aqe: host.legacy?.aqeProvider ?? (host.id === 'codex' ? 'codex' : null),
  }));

/** API-key LLM providers ruflo's router understands (`ruflo providers`). */
const apiProvider = (id, keyEnv) => {
  const provider = PROVIDER_REGISTRY.find((entry) => entry.id === id);
  return { id: provider?.id ?? id, keyEnv };
};
export const API_PROVIDERS = [
  apiProvider('anthropic', ['ANTHROPIC_API_KEY']),
  apiProvider('openai', ['OPENAI_API_KEY']),
  apiProvider('openrouter', ['OPENROUTER_API_KEY']),
  { id: 'google', keyEnv: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
  apiProvider('ollama', []), // local; presence = reachable daemon (not checked here)
];

/** Valid `AQE_LLM_PROVIDER` values (grounded: aqe ALL_PROVIDER_TYPES in
 *  dist/shared/llm/router/types.js). aqe force-selects any of these for its QE
 *  analysis, independent of ruflo's host. `claude-code`/`codex` = host
 *  subscriptions; `ollama`/`onnx` = local ($0); the rest metered. Keep in sync
 *  with aqe's list. */
export const AQE_PROVIDER_TYPES = [
  'claude-code', 'codex', 'claude', 'openai', 'gemini', 'openrouter',
  'azure-openai', 'bedrock', 'cognitum', 'ollama', 'onnx',
];

// `codex` is a first-class direct selection and chain rung. Grounded in aqe
// 3.13.12 (dist/shared/llm/router/config-store.js): BUILTIN_CONSTRUCTIBLE_
// PROVIDERS includes codex, PROVIDER_ENV_KEYS.codex = [] (ChatGPT-subscription
// via the codex binary — no env key), and provider REACHABILITY requires a
// fallbackChain entry: aqe's FALLBACK_PRIORITY contains neither codex nor
// claude-code, so an enabled codex provider is inert unless chained (#108
// phase 3). AQE 3.13.12 also admits external ids registered from llm-config;
// those are exposed lazily by aqeSelectableProviderTypes().
export const AQE_CHAIN_PROVIDER_TYPES = [...AQE_PROVIDER_TYPES];

/** Admitted external provider declarations currently projected by the runtime.
 * Re-read on each call so providers registered after this module loaded become
 * immediately selectable. */
export function aqeExternalProviders({ projectRoot = path.resolve(process.cwd()) } = {}) {
  return projectedAqeExternalProviders({ projectRoot }) ?? {};
}

/** Provider ids accepted by the interactive/non-interactive CLI right now. */
export function aqeSelectableProviderTypes() {
  return [...new Set([...AQE_PROVIDER_TYPES, ...Object.keys(aqeExternalProviders())])];
}

/** Provider ids accepted in fallback chains right now. */
export function aqeSelectableChainProviderTypes() {
  return aqeSelectableProviderTypes();
}

/** Credential descriptor per AQE_PROVIDER_TYPES member — the missing half of the
 *  chain validation: a rung whose provider has no usable credential is inert, and
 *  a type/shape check can't see that (#54). Env names are GROUNDED in aqe's own
 *  provider implementations (dist/shared/llm/providers/*.js `getApiKey`), not
 *  guessed; `also` are the extra vars a provider hard-requires beyond the key.
 *    host  — credentialed by a frontier host's login rather than an env key
 *    local — runs locally, no credential ($0)
 *  Keyed by provider id so AQE_PROVIDER_TYPES and this map cannot diverge silently
 *  (a test asserts the two cover exactly the same set). */
const registryCredential = (id) => {
  const provider = PROVIDER_REGISTRY.find((entry) => entry.id === id);
  if (provider?.billing === 'local') return { local: true, billing: 'local' };
  if (provider?.credentials.kind === 'environment') {
    return { keyEnv: [...provider.credentials.env], billing: provider.billing };
  }
  return null;
};
export const AQE_PROVIDER_CREDENTIALS = {
  'claude-code': { host: 'claude', billing: 'subscription' },
  // AQE 3.13.12 promotes `codex` to a built-in, directly selectable provider.
  // It is authenticated by the Codex host login rather than an API-key env var.
  codex: { host: 'codex', billing: 'subscription' },
  claude: { keyEnv: ['ANTHROPIC_API_KEY'], billing: 'metered' },
  openai: { keyEnv: ['OPENAI_API_KEY'], billing: 'metered' },
  gemini: { keyEnv: ['GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'], billing: 'metered' },
  openrouter: registryCredential('openrouter'),
  'azure-openai': { keyEnv: ['AZURE_OPENAI_API_KEY'], also: ['AZURE_OPENAI_ENDPOINT'], billing: 'metered' },
  bedrock: { keyEnv: ['AWS_ACCESS_KEY_ID'], also: ['AWS_SECRET_ACCESS_KEY'], billing: 'metered' },
  cognitum: { keyEnv: ['COGNITUM_API_KEY'], billing: 'metered' },
  ollama: registryCredential('ollama'),
  onnx: { local: true, billing: 'local' },
};

/** Is this aqe provider actually usable right now? Returns
 *  {known, present, billing, source, missing[]}. `source` names the env var (or
 *  host login) that satisfied it; `missing` names what would satisfy it. Pure
 *  except for the injected env. */
export function aqeProviderCredential(provider, { env = process.env, hostAuth = hostAuthState } = {}) {
  const d = AQE_PROVIDER_CREDENTIALS[provider];
  if (!d) {
    const declaration = aqeExternalProviders()[provider];
    if (!declaration) return { known: false, present: false, billing: 'unknown', source: null, missing: [] };
    // Admission proves the executable declaration was trusted and is current;
    // it does not prove the provider's downstream login/account is usable.
    return {
      known: false,
      present: false,
      billing: declaration.billingMode ?? 'metered-api',
      source: 'admitted external adapter (credential not introspectable)',
      missing: [],
    };
  }
  if (d.host) {
    const auth = hostAuth(d.host, { env });
    return { known: true, present: auth.mode !== 'none', billing: d.billing, source: auth.source, missing: auth.mode === 'none' ? [`${d.host} login`] : [] };
  }
  if (d.local) return { known: true, present: true, billing: d.billing, source: 'local', missing: [] };
  const key = d.keyEnv.find((k) => !!env[k]);
  const missingAlso = (d.also ?? []).filter((k) => !env[k]);
  return {
    known: true,
    present: !!key && missingAlso.length === 0,
    billing: d.billing,
    source: key ?? null,
    missing: [...(key ? [] : [d.keyEnv.join(' | ')]), ...missingAlso],
  };
}

/** Chain rungs that cannot execute — [{provider, missing}] in chain order. The
 *  shared basis for the write-time warning, the pick-time warning, and the
 *  `ak status` viability row, so the three can never disagree.
 *  @param {Array<{provider?: string}>} [chain]
 *  @param {{ env?: NodeJS.ProcessEnv, hostAuth?: typeof hostAuthState }} [opts]
 *  @returns {Array<{provider: string, missing: string[]}>} */
export function credentialGaps(chain = [], { env = process.env, hostAuth } = {}) {
  return chain
    .filter((e) => e?.provider)
    .map((e) => ({ provider: e.provider, ...aqeProviderCredential(e.provider, { env, ...(hostAuth ? { hostAuth } : {}) }) }))
    // `known === false` is UNVERIFIABLE, not uncredentialed: an unrecognized
    // provider must never be reported as "no credential" — that would be ak
    // asserting a fact about a provider it has no descriptor for. The separate
    // unknown-provider path (applyAqeRouter's type filter) already handles it.
    .filter((c) => c.known && !c.present)
    .map((c) => ({ provider: c.provider, missing: c.missing }));
}

/** Credential state for every aqe provider type — what `ak x host status`
 *  renders, so a credentialed provider (e.g. openrouter) is never invisible. */
export function detectAqeProviders({ env = process.env } = {}) {
  return Object.fromEntries(aqeSelectableProviderTypes().map((p) => [p, aqeProviderCredential(p, { env })]));
}

/** Provenance for an aqeFallback entry. A legacy entry written before stamping
 *  is treated as 'user' — never auto-touched, since we cannot tell whether the
 *  user typed it or accepted a suggestion (#55). */
export const fallbackSource = (entry) => entry?.source ?? 'user';

/** Every env key this module owns — the reversible surface for `off`/undo. */
export const MANAGED_ENV_KEYS = [
  'ENABLE_CLAUDE_CODE', 'ENABLE_CODEX', 'ENABLE_GEMINI_MCP',
  'AQE_LLM_PROVIDER', 'AQE_MAX_BUDGET_USD',
];

const VERSION_RE = /(\d+\.\d+\.\d+[^\s)]*)/;

/** Version from `<bin> --version` — hosts install via many managers (mise, npm,
 *  standalone), so we ask the CLI rather than read a global package.json. */
async function hostVersion(bin) {
  const r = await run(bin, ['--version'], { timeout: 15_000 });
  if (r.code !== 0) return null;
  const m = (r.stdout || r.stderr).match(VERSION_RE);
  return m ? m[1] : null;
}

/** How a host is installed, so we never clobber a non-npm install:
 *   'npm'      — an npm global copy exists (we may update it)
 *   'external' — on PATH but not the npm global copy (mise/native/brew — advise only)
 *   'absent'   — not installed at all (we may install it) */
export async function hostInstallState(host) {
  const npmVer = installedVersion(host.pkg);
  if (npmVer) return { method: 'npm', version: npmVer };
  if (await have(host.bin)) return { method: 'external', version: await hostVersion(host.bin) };
  return { method: 'absent', version: null };
}

/** How a host is AUTHENTICATED (distinct from how it's installed) — the axis that
 *  drives billing. Grounded, evidence-based (no over-claiming):
 *   - api key env present → 'api-key' (metered). For codex, an api key OVERRIDES a
 *     ChatGPT login (keyOverridesLogin) — flagged in `note`.
 *   - else a readable login file present → 'oauth' (subscription, $0).
 *   - else, claude only: macOS stores the login in the Keychain (no readable file),
 *     so when the CLI is present with no api key we INFER subscription and say so.
 *   - else → 'none'.
 *  Pure-ish: reads env + one fs.existsSync per host. `present` lets the caller pass
 *  the already-known install state so an absent host reads 'none' without a probe.
 *  `home` is a test seam (same convention as rufloCodexMcpStatus's opts.home). */
export function hostAuthState(id, { env = process.env, present = true, home = os.homedir() } = {}) {
  const a = HOST_ADAPTERS[id]?.auth;
  if (!a) return { mode: 'unknown', billing: 'unknown', source: null, note: null };
  const keyEnv = a.apiKeyEnv.find((k) => !!env[k]);
  const loginPath = a.loginFile ? path.join(home, ...a.loginFile) : null;
  const loginPresent = !!loginPath && fs.existsSync(loginPath);
  if (keyEnv) {
    return {
      mode: 'api-key', billing: 'metered', source: keyEnv,
      note: a.keyOverridesLogin && loginPresent ? 'api key overrides login' : null,
    };
  }
  if (loginPresent) return { mode: 'oauth', billing: 'subscription', source: `~/${a.loginFile.join('/')}`, note: null };
  // claude on macOS keeps the subscription login in the Keychain (unreadable here);
  // when the CLI is present with no api key, subscription is the only live option.
  if (id === 'claude' && present) return { mode: 'oauth', billing: 'subscription', source: 'login (keychain — inferred)', note: null };
  return { mode: 'none', billing: 'unknown', source: null, note: null };
}

/** Install a missing host globally via npm. Intended for the 'absent' case only —
 *  callers check hostInstallState first so an external install is never shadowed. */
export async function installHost(id) {
  const host = HOSTS.find((h) => h.id === id);
  if (!host) return { ok: false, detail: `unknown host: ${id}` };
  const r = await run('npm', ['install', '-g', `${host.pkg}@latest`], { timeout: 600_000 });
  return { ok: r.code === 0, changed: r.code === 0, detail: r.code === 0 ? `installed ${host.pkg}` : r.stderr.split('\n').slice(-2).join(' ').slice(0, 200) };
}

// NOTE: host UPDATES ride versions.mjs `driftReport` (which lists the host
// packages) + heal.upgradePackage — there is deliberately no parallel
// updateHost/hostDrift pair here. Two earlier ones were dead code (zero
// production callers) and were removed; don't reintroduce a second drift path.

/** Detect installed hosts + whether they are currently wired on in `cwd`.
 *  `opts.opencodeConfigFile` is a test seam for the config-file wired probe.
 *  @param {string} [cwd] @param {{ opencodeConfigFile?: string }} [opts] */
export async function detectHosts(cwd = process.cwd(), { opencodeConfigFile } = {}) {
  const env = currentEnv(cwd);
  const out = {};
  for (const h of HOSTS) {
    const present = await have(h.bin);
    out[h.id] = {
      present,
      version: present ? await hostVersion(h.bin) : null,
      // config-file hosts (enableEnv: null) have no env to be "wired" in —
      // their wired state is the presence of the ak-managed server entry in
      // the host's own config (opencode.json mcp.claude-flow), read
      // spawn-free. env[null] would read 'not wired' forever (codex-review).
      wired: h.enableEnv
        ? env[h.enableEnv] === 'true'
        : (h.id === 'opencode' ? opencodeMcpStatus(null, { configFile: opencodeConfigFile ?? paths.opencodeConfigPath() }).claudeFlow : false),
    };
  }
  return out;
}

/** Detect which API providers have credentials available. */
export function detectProviders({ env = process.env } = {}) {
  const out = {};
  for (const p of API_PROVIDERS) {
    out[p.id] = { keyPresent: p.keyEnv.some((k) => !!env[k]) };
  }
  return out;
}

/** One immutable command-facing snapshot of host, provider and binding truth. */
export async function collectIntegrationFacts({
  cwd = process.cwd(), cfg = null, env = process.env,
} = {}) {
  const detectedHosts = await detectHosts(cwd);
  const detectedProviders = detectProviders({ env });
  for (const adapter of PROVIDER_REGISTRY) {
    if (detectedProviders[adapter.id]) continue;
    const names = adapter.credentials?.kind === 'environment' ? adapter.credentials.env : [];
    detectedProviders[adapter.id] = { keyPresent: names.some((name) => !!env[name]) };
  }
  const hosts = Object.fromEntries(Object.entries(detectedHosts).map(([id, fact]) => [id, {
    ...fact,
    enabled: cfg?.integrations?.hosts?.[id] ?? null,
  }]));
  const providers = Object.fromEntries(Object.entries(detectedProviders).map(([id, fact]) => {
    const adapter = PROVIDER_REGISTRY.find((entry) => entry.id === id);
    return [id, {
      ...fact,
      configured: fact.keyPresent || adapter?.billing === 'local',
      reachable: null,
      // An API key is metered even when the same vendor also offers a
      // subscription-backed host login.
      billing: fact.keyPresent ? 'metered' : (adapter?.billing ?? 'unknown'),
    }];
  }));
  return normalizeIntegrationFacts({
    hosts,
    providers,
    bindings: cfg?.integrations?.bindings ?? [],
  });
}

/** Hosts eligible for legacy env-backed setup/sync loops. OpenCode has its own
 * owner-module lifecycle because it has no ruflo enable-env projection. */
export const commandHosts = () => HOSTS.filter((host) => host.enableEnv &&
  HOST_REGISTRY.find((entry) => entry.id === host.id)?.capabilities.canRouteActivities);

/** Where host-enable env lands: project settings.local.json inside a repo (same
 *  seam as CLAUDE_FLOW_DB_PATH), else the user settings.json. Repo membership
 *  is resolved by WALKING UP to .git (paths.repoRoot) and the project file is
 *  anchored at that root — a cwd-only probe run from a repo subdir would
 *  silently retarget machine-wide user settings (and undo/status, run from
 *  the root, would never find the leaked keys). */
export function settingsTarget(cwd = process.cwd()) {
  const root = paths.repoRoot(cwd);
  return root
    ? { file: paths.projectSettingsLocal(root), scope: 'project' }
    : { file: paths.claudeSettingsPath(), scope: 'user' };
}

function currentEnv(cwd) {
  const { file } = settingsTarget(cwd);
  return readJson(file, {})?.env ?? {};
}

/** True when providers config is untouched (claude host only, aqe left on its own
 *  default). Keeps the heal a deliberate no-op so existing users see zero change
 *  until they opt in. ANY non-claude host (codex OR opencode) breaks the default —
 *  an enabled opencode host is not "claude-only" (codex-review r2). */
export function isDefault(cfg) {
  const p = cfg.providers ?? {};
  const hosts = cfg.integrations?.hosts ?? {};
  return !!hosts.claude && !hosts.codex && !hosts.opencode && p.aqeProvider == null
    && (!p.models || p.models.length === 0) && (p.maxBudgetUsd == null)
    && (!p.aqeFallback || p.aqeFallback.length === 0);
}

/** True when both frontier hosts are enabled in persisted intent (kit.json),
 *  regardless of whether the env is wired yet — this is the same source
 *  `status()` already keys "enabled" off of. Guards the dual-mode/judge-bias
 *  guidance below: only relevant once both are actually opted in. */
export const bothHostsEnabled = (cfg) => !!cfg.integrations?.hosts?.claude && !!cfg.integrations?.hosts?.codex;

/** The context blocks.mjs's reconcileGuidance needs to gate dual-mode/
 *  opencode-specific guidance targets — shared by `ak sync` and `ak setup`'s
 *  final reconcile pass so the two commands cannot drift (ADR-0008 on target
 *  scoping). */
export function guidanceContext(cfg) {
  return { flags: { dualMode: bothHostsEnabled(cfg), opencodeEnabled: !!cfg.integrations?.hosts?.opencode } };
}

/** Guidance printed once both hosts are enabled:
 *   - ak run executes role-based activity pipelines through the configured hosts.
 *   - judge-vendor-bias: a same-vendor LLM judge scores ~8-10pp inflated versus
 *     a cross-vendor judge (still ordinally correct, not calibrated) — measured
 *     in openrouter-alts.json's judge_bias_check_2026_06_15. */
export const DUAL_ROLE_TIP = 'both hosts enabled — run a role-based pipeline with: ak run feature|security|refactor "<task>"';
export const JUDGE_BIAS_TIP = 'tip: for LLM-judged scoring, use a different vendor than the writer as judge — same-vendor judges run ~8-10pp inflated (still ordinally correct, but not calibrated)';

/** Cross-sell for agentic-qe's qe-court (ADR-124, shipped 3.13.0): its jury
 *  requires >= 2 distinct vendors seated. Host count is not sufficient
 *  evidence because a host can route to a provider from the same vendor. */
export const QE_COURT_TIP = 'agentic-qe ships qe-court (adversarial review; upgrade to ≥ 3.13.3 for enforced config validation) — its jury requires evidence from ≥ 2 distinct vendors; host count alone is not provider evidence';

/** Suggested aqe-fallback chain when codex is among the enabled hosts: codex's
 *  models are reached via the `openai` provider type (not as an aqe provider
 *  itself), so pairing claude-code + openai is a direct inference from the
 *  hosts already chosen in the same session. Literal reused from
 *  docs/PROVIDERS.md's own example rather than inventing new model ids. */
export const AQE_FALLBACK_CODEX_SUGGESTION = 'claude-code:claude-opus-5; openai:gpt-5.6';
export const suggestedFallbackFor = (enabledHosts) => (enabledHosts.includes('codex') ? AQE_FALLBACK_CODEX_SUGGESTION : null);

// ── agentic-qe router config (.agentic-qe/llm-config.json) ──────────────────
// Grounded in aqe's router config-store + types (ADR-123):
//   - mergeRouterConfig deep-merges `providers` but SHALLOW-replaces
//     `fallbackChain` → ak must write a COMPLETE chain (these scalar defaults).
//   - the router iterates `entry.models` → each entry needs populated models.
//   - aqe refuses to persist apiKey → ak writes only `enabled` per provider;
//     keys stay in the env.
const AQE_CHAIN_DEFAULTS = { maxRetries: 3, retryDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 5000 };
const AQE_MANAGED_TAG = 'agentic-kit';

// agentic-qe ≥ 3.13.1 shipped on-disk per-agent routing (`agentOverrides`, issue
// #568). Below that, aqe ignores the key, so ak gates writing it on the version.
const AGENT_OVERRIDES_MIN_AQE = '3.13.1';
export function aqeSupportsAgentOverrides() {
  const v = installedVersion('agentic-qe');
  return !!v && cmpVersions(v, AGENT_OVERRIDES_MIN_AQE) >= 0;
}

// agentic-qe #628 shipped external CLI providers in 3.13.12. Earlier versions
// ignore/reject this surface, so never write a declaration that cannot run.
export const EXTERNAL_PROVIDERS_MIN_AQE = '3.13.12';
export function aqeSupportsExternalProviders(version = installedVersion('agentic-qe')) {
  return !!version && cmpVersions(version, EXTERNAL_PROVIDERS_MIN_AQE) >= 0;
}

const AQE_OWNERSHIP_KEY = '_agenticKit';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function declarationHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function plainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function exactlyOwnedDefault(config, receiptKey) {
  const provider = config?.defaultProvider;
  const receipt = plainRecord(config?.[AQE_OWNERSHIP_KEY]?.[receiptKey]);
  return typeof provider === 'string' && receipt?.provider === provider
    && receipt.writtenHash === declarationHash(provider)
    ? provider
    : null;
}

function setDefaultOwnership(config, receiptKey, provider) {
  const ownership = { ...(plainRecord(config[AQE_OWNERSHIP_KEY]) ?? {}) };
  ownership[receiptKey] = { provider, writtenHash: declarationHash(provider) };
  config[AQE_OWNERSHIP_KEY] = ownership;
}

function clearDefaultOwnership(config, receiptKey) {
  const ownership = { ...(plainRecord(config[AQE_OWNERSHIP_KEY]) ?? {}) };
  delete ownership[receiptKey];
  if (Object.keys(ownership).length) config[AQE_OWNERSHIP_KEY] = ownership;
  else delete config[AQE_OWNERSHIP_KEY];
}

const exactlyOwnedExternalDefault = (config) => exactlyOwnedDefault(config, 'externalDefaultProvider');
const exactlyOwnedFallbackDefault = (config) => exactlyOwnedDefault(config, 'fallbackDefaultProvider');
const setExternalDefaultOwnership = (config, provider) =>
  setDefaultOwnership(config, 'externalDefaultProvider', provider);
const setFallbackDefaultOwnership = (config, provider) =>
  setDefaultOwnership(config, 'fallbackDefaultProvider', provider);
const clearExternalDefaultOwnership = (config) =>
  clearDefaultOwnership(config, 'externalDefaultProvider');
const clearFallbackDefaultOwnership = (config) =>
  clearDefaultOwnership(config, 'fallbackDefaultProvider');

function admittedProviderRecord(id) {
  const records = admittedAqeProviders();
  return (Array.isArray(records) ? records : Object.values(records ?? {}))
    .find((entry) => (entry.id ?? entry.providerId ?? entry.type) === id) ?? null;
}

/** Compare the live admitted declarations with the exact values ak previously
 * wrote. Foreign entries and user-edited owned entries are never overwritten or
 * removed. Returned `active` ids are safe to reference from defaults/chains. */
function reconcileExternalProviders(existing, desired = aqeExternalProviders()) {
  const current = { ...(existing.externalProviders ?? {}) };
  const currentProviders = { ...(existing.providers ?? {}) };
  // Ownership metadata is advisory proof, never trusted input. A null/array/
  // primitive receipt proves nothing and must be dropped rather than crashing
  // sync or authorizing deletion of user values.
  const rawReceipts = plainRecord(existing[AQE_OWNERSHIP_KEY]?.externalProviders) ?? {};
  const priorReceipts = Object.fromEntries(Object.entries(rawReceipts)
    .filter(([, receipt]) => plainRecord(receipt)));
  const receipts = { ...priorReceipts };
  const active = new Set();
  const conflicts = [];
  const unavailable = new Set();
  const retired = [];
  const pruned = [];
  const added = [];
  const activationsAdded = [];
  const activationsPruned = [];

  for (const [id, declaration] of Object.entries(desired)) {
    const prior = priorReceipts[id];
    const currentDeclaration = current[id];
    const currentHash = currentDeclaration === undefined ? null : declarationHash(currentDeclaration);
    if (currentDeclaration !== undefined && (!prior || currentHash !== prior.writtenHash)) {
      conflicts.push(id);
      unavailable.add(id);
      // A changed declaration becomes user-owned immediately. Its activation
      // has independent ownership, though: retain only an exact activation
      // receipt so a later revoke can remove the minimal record ak created
      // without ever deleting the edited declaration.
      const currentActivation = currentProviders[id];
      if (prior?.providerWrittenHash && currentActivation !== undefined
        && declarationHash(currentActivation) === prior.providerWrittenHash) {
        receipts[id] = { providerWrittenHash: prior.providerWrittenHash };
      } else {
        delete receipts[id];
      }
      continue;
    }
    current[id] = declaration;
    const record = admittedProviderRecord(id);
    const nextReceipt = {
      hostId: record?.hostId ?? record?.host ?? record?.manifestId ?? null,
      contentHash: record?.contentHash ?? record?.integrity ?? null,
      writtenHash: declarationHash(declaration),
    };
    if (currentDeclaration === undefined) added.push(id);

    // AQE 3.13.12's MCP router asks whether any providers are enabled BEFORE
    // it loads externalProviders (the load is what registers them). A minimal
    // providers[id].enabled record breaks that bootstrap cycle. Own only a
    // record we created from absence; a user-owned record is preserved and is
    // usable only when the user already enabled it explicitly.
    const currentActivation = currentProviders[id];
    const priorActivationHash = prior?.providerWrittenHash;
    const activationHash = currentActivation === undefined ? null : declarationHash(currentActivation);
    if (currentActivation === undefined) {
      currentProviders[id] = { enabled: true };
      nextReceipt.providerWrittenHash = declarationHash(currentProviders[id]);
      activationsAdded.push(id);
      active.add(id);
    } else if (currentActivation?.enabled === true) {
      if (priorActivationHash && activationHash === priorActivationHash) {
        nextReceipt.providerWrittenHash = priorActivationHash;
      }
      active.add(id);
    } else {
      conflicts.push(`${id} (providers.${id}.enabled is not true)`);
      unavailable.add(id);
    }
    receipts[id] = nextReceipt;
  }

  for (const [id, receipt] of Object.entries(priorReceipts)) {
    if (id in desired) continue;
    retired.push(id);
    const currentDeclaration = current[id];
    if (currentDeclaration !== undefined && declarationHash(currentDeclaration) === receipt.writtenHash) {
      delete current[id];
      pruned.push(id);
    }
    const currentActivation = currentProviders[id];
    if (receipt.providerWrittenHash && currentActivation !== undefined
      && declarationHash(currentActivation) === receipt.providerWrittenHash) {
      delete currentProviders[id];
      activationsPruned.push(id);
    }
    // If it changed, relinquish ownership and preserve it.
    delete receipts[id];
  }

  return {
    externalProviders: current,
    providers: currentProviders,
    receipts,
    active,
    conflicts,
    unavailable: [...unavailable],
    retired,
    pruned,
    added,
    activationsAdded,
    activationsPruned,
  };
}

/** Honest, non-mutating projection state for status/verify. */
export function aqeExternalProviderState(disk = {}, { projectRoot = path.resolve(process.cwd()) } = {}) {
  const desired = aqeExternalProviders({ projectRoot });
  const receipts = disk[AQE_OWNERSHIP_KEY]?.externalProviders ?? {};
  const missing = [];
  const drifted = [];
  const stale = [];
  for (const [id, declaration] of Object.entries(desired)) {
    if (!(id in (disk.externalProviders ?? {}))) missing.push(id);
    else if (declarationHash(disk.externalProviders[id]) !== declarationHash(declaration)
      || receipts[id]?.writtenHash !== declarationHash(declaration)) drifted.push(id);
    const activation = disk.providers?.[id];
    if (activation === undefined) missing.push(`${id} activation`);
    else if (activation.enabled !== true
      || (receipts[id]?.providerWrittenHash
        && declarationHash(activation) !== receipts[id].providerWrittenHash)) {
      drifted.push(`${id} activation`);
    }
  }
  for (const id of Object.keys(receipts)) if (!(id in desired)) stale.push(id);
  return {
    supported: aqeSupportsExternalProviders(), desired: Object.keys(desired), missing, drifted, stale,
    ok: aqeSupportsExternalProviders() && missing.length === 0 && drifted.length === 0 && stale.length === 0,
  };
}

export function aqeRouterFile(cwd = process.cwd()) {
  return path.join(paths.projectAqeDir(cwd), 'llm-config.json');
}

/** Map kit.json `aqeFallback` entries → a complete aqe FallbackChain. Priority
 *  descends by list order (first = highest). Entries carry provider + models. */
function buildChain(entries) {
  return {
    id: AQE_MANAGED_TAG,
    entries: entries.map((e, i) => ({
      provider: e.provider,
      models: e.models ?? [],
      enabled: true,
      priority: 100 - i * 10,
      maxAttempts: 2,
      timeoutMs: 30000,
    })),
    ...AQE_CHAIN_DEFAULTS,
  };
}

// ── applyAqeRouter: ordered surface reconcilers ─────────────────────────────
// Five surfaces used to be braided together in one function, sharing mutable
// accumulators with implicit cross-surface feedback: `externalActive`
// (computed while reconciling external providers) constrained what the
// fallback-chain/default-provider/agentOverrides surfaces below it could
// safely reference, and `projected`/`staleOverrides` had to be recomputed
// after that same fact became known. Each surface below is a
// `(next, ctx) => {detail, error, changed, ctx?}` step, folded left-to-right
// over one shared `next` draft; a surface returns an optional `ctx` PATCH
// (applied before the next surface runs) instead of closing over an outer
// `let` — the one real cross-surface dependency (externalActive -> the
// refined `projected`/`staleOverrides`) is the only patch actually used, so
// it stays a single, explicit, ordered hand-off rather than several loose
// mutable accumulators.

/** The externalProviders surface's own detail line — split out only to keep
 *  that surface's branch count (five independent `?  : ''` clauses) legible
 *  and under the reconciler's own complexity budget. */
function formatExternalProvidersDetail(externalActive, reconciled) {
  return `externalProviders: ${externalActive.size} managed`
    + (reconciled.added.length ? ` (${reconciled.added.length} added)` : '')
    + (reconciled.pruned.length ? ` (${reconciled.pruned.length} stale owned pruned)` : '')
    + (reconciled.activationsAdded.length ? ` (${reconciled.activationsAdded.length} MCP activation added)` : '')
    + (reconciled.activationsPruned.length ? ` (${reconciled.activationsPruned.length} stale activation pruned)` : '')
    + (reconciled.conflicts.length ? ` (⚠ conflicts preserved: ${reconciled.conflicts.join(', ')})` : '');
}

/** Surface 1/4: reconcile admitted external-provider declarations/activations
 *  against the live file, prune anything that became unavailable from the
 *  fallback chain/defaultProvider, and refine `projected`/`staleOverrides` for
 *  the surfaces after it (their safe-to-reference set depends on which
 *  external ids ended up active here). */
function reconcileExternalProvidersSurface(next, ctx) {
  const {
    existing, desiredExternal, hasExternal, hasOwnedExternal, externalSupported,
    hasManagedFallback, ownedFallbackDefault, ownedExternalDefault,
    priorOverrides, managedOverrideKeys, projected: priorProjected,
  } = ctx;
  let externalActive = new Set();
  let error = null;
  let changed = false;
  const detail = [];

  if (hasExternal || hasOwnedExternal) {
    // A downgrade must remove only unchanged entries we previously wrote,
    // plus their dangling references. Keeping declarations that this AQE
    // version cannot understand would strand every router startup on drift.
    const reconciled = reconcileExternalProviders(existing, externalSupported ? desiredExternal : {});
    externalActive = reconciled.active;
    if (Object.keys(reconciled.externalProviders).length) next.externalProviders = reconciled.externalProviders;
    else delete next.externalProviders;
    if (Object.keys(reconciled.providers).length) next.providers = reconciled.providers;
    else delete next.providers;
    const ownership = { ...(plainRecord(next[AQE_OWNERSHIP_KEY]) ?? {}) };
    if (!ownedExternalDefault) delete ownership.externalDefaultProvider;
    if (Object.keys(reconciled.receipts).length) ownership.externalProviders = reconciled.receipts;
    else delete ownership.externalProviders;
    if (Object.keys(ownership).length) next[AQE_OWNERSHIP_KEY] = ownership;
    else delete next[AQE_OWNERSHIP_KEY];
    if (reconciled.conflicts.length) {
      error = `refused conflicting foreign/user-edited external provider ids: ${reconciled.conflicts.join(', ')}`;
    }
    detail.push(formatExternalProvidersDetail(externalActive, reconciled));
    if (hasExternal && !externalSupported) {
      error = `external providers need agentic-qe >=${EXTERNAL_PROVIDERS_MIN_AQE}`;
      detail.push(`externalProviders: disabled (${error})`);
    }
    const unavailableExternal = new Set([...reconciled.unavailable, ...reconciled.retired]);
    if (hasManagedFallback && next.fallbackChain?.entries) {
      next.fallbackChain = {
        ...next.fallbackChain,
        entries: next.fallbackChain.entries.filter((entry) => !unavailableExternal.has(entry.provider)),
      };
      if (next.fallbackChain.entries.length === 0) delete next.fallbackChain;
    }
    if (unavailableExternal.has(next.defaultProvider)
      && (ownedFallbackDefault === next.defaultProvider || ownedExternalDefault === next.defaultProvider)) {
      delete next.defaultProvider;
      clearExternalDefaultOwnership(next);
      clearFallbackDefaultOwnership(next);
    }
    changed = reconciled.added.length > 0 || reconciled.pruned.length > 0
      || reconciled.activationsAdded.length > 0 || reconciled.activationsPruned.length > 0
      || Object.keys(desiredExternal).some((id) => existing.externalProviders?.[id]
        && declarationHash(existing.externalProviders[id]) !== declarationHash(desiredExternal[id]));
  }

  // Admission/version/conflict filtering can make a previously projected
  // external route inactive. Recompute from the safe projection so ak-owned
  // overrides never retain an unusable id — this runs regardless of whether
  // the branch above executed (externalActive then defaults to empty).
  const projected = Object.fromEntries(Object.entries(priorProjected).filter(([, entry]) =>
    !(entry.provider in desiredExternal) || externalActive.has(entry.provider)));
  const staleOverrides = Object.keys(priorOverrides)
    .filter((agent) => managedOverrideKeys.has(agent) && !(agent in projected));

  return {
    detail, error, changed, ctx: { externalActive, projected, staleOverrides },
  };
}

/** Surface 2/4: retire a previously-written managed fallback chain (and its
 *  derived default) once the canonical `aqeFallback` intent goes empty. */
function reconcileFallbackRetirementSurface(next, ctx) {
  const {
    hasChain, hasManagedFallback, ownedFallbackDefault, ownedExternalDefault,
  } = ctx;
  if (hasChain || !hasManagedFallback) return null;
  // An empty canonical fallback intent retires the tagged chain ak previously
  // wrote. Its derived default belongs to the same projection and must not
  // survive independently; provider declarations/activations remain available
  // for explicit selection, routes, or a future chain.
  delete next.fallbackChain;
  if (ownedFallbackDefault) {
    delete next.defaultProvider;
    if (ownedExternalDefault) clearExternalDefaultOwnership(next);
  }
  clearFallbackDefaultOwnership(next);
  return { detail: 'chain: managed fallback retired', changed: true };
}

/** Surface 3/4: decide `defaultProvider` and which of the two ownership
 *  receipts (external vs. fallback-chain-derived) it carries, across the
 *  three ways it can change: explicit deselection, chain-derived assignment
 *  (which also builds/validates the active chain itself), and an explicit
 *  project-local external selection. */
function reconcileDefaultProviderSurface(next, ctx) {
  const {
    cfg, existing, chain, selectedProvider, hasChain, desiredExternal, externalActive, ownedExternalDefault,
  } = ctx;
  const detail = [];
  let error = null;
  let changed = false;

  // `aqeProvider: null` is an explicit deselection. Retire only an exact
  // external default that ak previously wrote, while leaving the admitted
  // declaration and MCP activation intact for routes or future selection.
  // A configured fallback chain owns default selection independently and is
  // handled below; it must not be erased by primary-provider deselection.
  if (!hasChain && selectedProvider === null && ownedExternalDefault) {
    delete next.defaultProvider;
    clearExternalDefaultOwnership(next);
    detail.push(`defaultProvider: ${ownedExternalDefault} retired`);
    changed = true;
  }

  if (hasChain) {
    const selectable = new Set(aqeSelectableChainProviderTypes());
    const valid = chain.filter((e) => e?.provider && selectable.has(e.provider)
      && (!(e.provider in desiredExternal) || externalActive.has(e.provider)));
    if (valid.length === 0) {
      // A bad chain must NOT block the independent agentOverrides projection — the
      // Activity routing is validated separately. Record it and carry on.
      error = 'no valid providers in fallback chain';
      detail.push(`chain: ⚠ ${error}`);
    } else {
      const requestedDefault = cfg.providers.aqeProvider;
      const requestedUnavailable = requestedDefault in desiredExternal && !externalActive.has(requestedDefault);
      next.defaultProvider = requestedUnavailable ? valid[0].provider : requestedDefault ?? valid[0].provider;
      setFallbackDefaultOwnership(next, next.defaultProvider);
      next.providers = { ...(next.providers ?? existing.providers ?? {}) };
      for (const e of valid) {
        if (!(e.provider in desiredExternal)) next.providers[e.provider] = { ...(existing.providers?.[e.provider] ?? {}), enabled: true };
      }
      next.fallbackChain = buildChain(valid);
      if (next.defaultProvider in desiredExternal && externalActive.has(next.defaultProvider)) {
        setExternalDefaultOwnership(next, next.defaultProvider);
      } else if (ownedExternalDefault) {
        clearExternalDefaultOwnership(next);
      }
      const emptyModels = valid.filter((e) => !e.models || e.models.length === 0).map((e) => e.provider);
      // Warn, never refuse: the user may export the key later, and silently
      // dropping a rung is worse than writing one that is currently inert (#54).
      const gaps = credentialGaps(valid);
      detail.push(`chain: ${valid.map((e) => e.provider).join(' → ')}`
        + (emptyModels.length ? ` (⚠ no models for: ${emptyModels.join(', ')})` : '')
        + (gaps.length ? ` (⚠ no credential for: ${gaps.map((g) => `${g.provider} — needs ${g.missing.join(', ')}`).join('; ')})` : ''));
      changed = true;
    }
  }

  // External provider selection is project-local by contract: AQE discovers it
  // from this file only. managedEnv deliberately never exports an external id
  // into project or user host settings.
  if (selectedProvider && selectedProvider in desiredExternal) {
    if (externalActive.has(selectedProvider)) {
      next.defaultProvider = selectedProvider;
      setExternalDefaultOwnership(next, selectedProvider);
      detail.push(`defaultProvider: ${selectedProvider} (project-local external)`);
      changed = true;
    } else {
      error ??= `external default '${selectedProvider}' is not safely managed`;
    }
  }

  return { detail, error, changed };
}

/** Surface 4/4: project `routing.routes` into aqe's `agentOverrides`, merged
 *  with (not replacing) foreign entries, pruning only the ak-owned entries
 *  the current projection no longer names (`ctx.staleOverrides`, refined by
 *  surface 1 against the final external-availability set). */
function reconcileAgentOverridesSurface(next, ctx) {
  const {
    existing, desiredExternal, priorOverrides, projected, staleOverrides, hasPolicy, agentOverridesSupported,
  } = ctx;
  if ((agentOverridesSupported && Object.keys(projected).length) || staleOverrides.length) {
    // MERGE, don't replace: ak owns only the curated agent-types it projects;
    // preserve foreign entries (aqe's own defaults or a hand-added agent). The
    // projector drops non-constructible providers (mirrors sanitizeAgentOverrides)
    // and only ever emits {provider, model} — no apiKey.
    next.agentOverrides = { ...priorOverrides };
    for (const agent of staleOverrides) delete next.agentOverrides[agent];
    if (agentOverridesSupported) Object.assign(next.agentOverrides, projected);
    // An override naming a provider is inert until that provider is ENABLED in
    // this same file: aqe enables from env keys or the `providers` map, and a
    // subscription host-CLI provider (codex, claude-code) has no env key at
    // all — so ak-projected codex overrides sat dead and warned on every aqe
    // startup (#108 phase 3). Enable exactly the providers the projection
    // references — merge-not-clobber, writing nothing beyond `enabled`.
    const referenced = agentOverridesSupported
      ? [...new Set(Object.values(projected).map((entry) => entry.provider))]
      : [];
    if (referenced.length) {
      next.providers = { ...(next.providers ?? existing.providers ?? {}) };
      for (const provider of referenced) {
        if (!(provider in desiredExternal)) next.providers[provider] = { ...(next.providers[provider] ?? {}), enabled: true };
      }
    }
    return {
      changed: true,
      detail: `agentOverrides: ${agentOverridesSupported ? Object.keys(projected).length : 0} agents`
        + (referenced.length ? ` (providers enabled: ${referenced.join(', ')})` : '')
        + (staleOverrides.length ? ` (${staleOverrides.length} stale ak entries pruned)` : '')
        + (!agentOverridesSupported ? ' (new projection skipped; needs agentic-qe ≥ 3.13.1)' : ''),
    };
  }
  if (hasPolicy && !agentOverridesSupported) return { detail: 'agentOverrides: skipped (needs agentic-qe ≥ 3.13.1)' };
  if (hasPolicy && Object.keys(projected).length === 0) return { detail: 'agentOverrides: skipped (no safely constructible providers)' };
  return null;
}

const AQE_ROUTER_SURFACES = [
  reconcileExternalProvidersSurface,
  reconcileFallbackRetirementSurface,
  reconcileDefaultProviderSurface,
  reconcileAgentOverridesSurface,
];

/** Fold an ordered list of `(draft, ctx) => {detail, error, changed, ctx?}`
 *  surface reconcilers over one draft, left to right. A surface's own `ctx`
 *  patch (if any) is applied before the next surface runs — the only
 *  sanctioned channel for one surface's output to inform a later one (see the
 *  section comment above AQE_ROUTER_SURFACES). `draft`/`ctx` are mutated in
 *  place as usual; returns the accumulated {details, changed, error}. */
function foldSurfaces(surfaces, draft, ctx) {
  const details = [];
  let changed = false;
  let error = null;
  for (const reconcile of surfaces) {
    const result = reconcile(draft, ctx);
    if (!result) continue;
    if (result.detail) {
      if (Array.isArray(result.detail)) details.push(...result.detail);
      else details.push(result.detail);
    }
    if (result.changed) changed = true;
    if (result.error) error ??= result.error;
    if (result.ctx) Object.assign(ctx, result.ctx);
  }
  return { details, changed, error };
}

/** True when nothing in `cfg`/the on-disk file requires any router surface to
 *  run — the router file is left untouched (and unread beyond this check). */
function aqeRouterHasNothingToApply({
  hasChain, hasPolicy, hasExternal, hasOwnedExternal, hasManagedFallback,
  hasExternalDefaultReceipt, hasFallbackDefaultReceipt, staleOverrides,
}) {
  return !hasChain && !hasPolicy && !hasExternal && !hasOwnedExternal && !hasManagedFallback
    && !hasExternalDefaultReceipt && !hasFallbackDefaultReceipt && staleOverrides.length === 0;
}

/** Exact receipts never regain authority. If a user changes the default away
 *  from the value ak wrote (external default), or the managed fallback chain
 *  that derived a default is gone or no longer owned, relinquish that receipt
 *  immediately — changing it back later is still a user write and cannot
 *  resurrect it. Runs before any surface, on the initial draft. */
function clearStaleDefaultReceipts(next, {
  hasExternalDefaultReceipt, ownedExternalDefault, hasFallbackDefaultReceipt, ownedFallbackDefault, hasManagedFallback,
}) {
  if (hasExternalDefaultReceipt && !ownedExternalDefault) clearExternalDefaultOwnership(next);
  if (hasFallbackDefaultReceipt && (!ownedFallbackDefault || !hasManagedFallback)) clearFallbackDefaultOwnership(next);
}

/** Write ak's managed router config into `.agentic-qe/llm-config.json`, merged
 *  into any existing file (backup-first, never persisting apiKey):
 *    - the ordered fallback chain + enabled set + default provider (from
 *      `aqeFallback`), and
 *    - the per-activity `agentOverrides` map projected from `routing.routes`
 *      (issue #568; only when installed aqe ≥ 3.13.1).
 *  No-op unless at least one of those is configured and we are in a project.
 *  Folds AQE_ROUTER_SURFACES over one draft (see the section comment above);
 *  this function is the setup (context + initial draft), the fold, and the
 *  final change-detect-and-write.
 *  Returns {ok, changed, detail}. */
export function applyAqeRouter(cfg, cwd = process.cwd()) {
  const chain = cfg.providers?.aqeFallback ?? [];
  const policy = cfg.routing?.routes ?? {};
  const selectedProvider = cfg.providers?.aqeProvider ?? null;
  const hasChain = chain.length > 0;
  const hasPolicy = Object.keys(policy).length > 0;
  // Same repo-root resolution as settingsTarget — the three scope gates must
  // never disagree about what "in a project" means (see paths.repoRoot).
  const root = paths.repoRoot(cwd);
  if (!root) return { ok: true, changed: false, detail: 'not a project — aqe router unmanaged' };
  const file = aqeRouterFile(root);
  const existing = readJson(file, {}) ?? {};
  const ownedExternalDefault = exactlyOwnedExternalDefault(existing);
  const ownedFallbackDefault = exactlyOwnedFallbackDefault(existing);
  const desiredExternal = aqeExternalProviders({ projectRoot: root });
  const hasExternal = Object.keys(desiredExternal).length > 0;
  const hasOwnedExternal = Object.keys(existing[AQE_OWNERSHIP_KEY]?.externalProviders ?? {}).length > 0;
  const existingOwnership = plainRecord(existing[AQE_OWNERSHIP_KEY]) ?? {};
  const hasExternalDefaultReceipt = Object.hasOwn(existingOwnership, 'externalDefaultProvider');
  const hasFallbackDefaultReceipt = Object.hasOwn(existingOwnership, 'fallbackDefaultProvider');
  const hasManagedFallback = existing.fallbackChain?.id === AQE_MANAGED_TAG;
  const priorOverrides = existing.agentOverrides ?? {};
  const projected = configuredPolicyToAgentOverrides(policy);
  const managedOverrideKeys = new Set(Object.keys(AGENT_ACTIVITY_MAP));
  const staleOverrides = Object.keys(priorOverrides)
    .filter((agent) => managedOverrideKeys.has(agent) && !(agent in projected));

  const facts = {
    hasChain, hasPolicy, hasExternal, hasOwnedExternal, hasManagedFallback,
    hasExternalDefaultReceipt, hasFallbackDefaultReceipt, staleOverrides,
  };
  if (aqeRouterHasNothingToApply(facts)) {
    return { ok: true, changed: false, detail: 'no aqe router config to apply' };
  }

  const next = { ...existing };
  clearStaleDefaultReceipts(next, {
    hasExternalDefaultReceipt, ownedExternalDefault, hasFallbackDefaultReceipt, ownedFallbackDefault, hasManagedFallback,
  });

  const ctx = {
    cfg,
    existing,
    chain,
    selectedProvider,
    hasChain,
    hasPolicy,
    desiredExternal,
    hasExternal,
    hasOwnedExternal,
    hasManagedFallback,
    ownedExternalDefault,
    ownedFallbackDefault,
    priorOverrides,
    managedOverrideKeys,
    projected,
    staleOverrides,
    externalActive: new Set(),
    externalSupported: aqeSupportsExternalProviders(),
    agentOverridesSupported: aqeSupportsAgentOverrides(),
  };
  const { details, changed: surfacesChanged, error } = foldSurfaces(AQE_ROUTER_SURFACES, next, ctx);

  // One exact compare, reused for both phases below (the prior version
  // stringified `existing` twice for the same never-mutated object).
  const existingSnapshot = JSON.stringify(stableValue(existing));
  const changed = surfacesChanged || JSON.stringify(stableValue(next)) !== existingSnapshot;
  if (!changed) return { ok: !error, changed: false, detail: details.join('; ') || 'nothing to apply' };
  next._managedBy = AQE_MANAGED_TAG;
  // A surface reporting `changed: true` means this invocation owns at least
  // one projection surface; it does not by itself mean the artifact changed.
  // Compare the complete managed value (including the ownership tag) before
  // touching disk so a converged external default/fallback/override remains
  // byte- and mtime-stable across repeated syncs.
  if (JSON.stringify(stableValue(next)) === existingSnapshot) {
    return { ok: !error, changed: false, detail: details.join('; ') || 'nothing to apply' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonWithBackup(file, next);
  return { ok: !error, changed: true, detail: details.join('; ') };
}

/** Reversible teardown of ak's router management. Restores the pre-ak file from
 *  its one-time .bak, or removes an ak-created file. Never touches a file ak
 *  didn't write (no `_managedBy` tag). */
export function undoAqeRouter(cwd = process.cwd()) {
  const file = aqeRouterFile(cwd);
  if (!fs.existsSync(file)) return { ok: true, changed: false, detail: 'no aqe router config' };
  const cur = readJson(file);
  if (cur?._managedBy !== AQE_MANAGED_TAG) return { ok: true, changed: false, detail: 'llm-config.json not ak-managed — left as-is' };
  const bak = `${file}.bak`;
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, file);
    fs.rmSync(bak, { force: true });
    return { ok: true, changed: true, detail: 'restored pre-ak llm-config.json' };
  }
  fs.rmSync(file, { force: true });
  return { ok: true, changed: true, detail: 'removed ak-created llm-config.json' };
}

// ── per-activity host routing (kit.json routing.routes) ─────────────────────
// Seed/format helpers shared by `ak x host` and `ak setup`. The pure policy
// core + projectors live in routing.mjs; these bridge it to kit.json + the CLI.

/** Seed the per-activity routing policy from defaults when BOTH hosts are enabled
 *  and aqe supports agentOverrides — but only if the user has no policy yet (empty
 *  map). Subscription-only targeting + `seeded` provenance come from
 *  seedActivityRoutes (ADR-0003). Mutates cfg.routing.routes. */
export function seedActivityRoutesIfMultiHost(cfg) {
  const routing = cfg.routing ?? (cfg.routing = {
    version: ROUTING_SCHEMA_VERSION,
    primaryHost: DEFAULT_PRIMARY_HOST,
    routes: {},
  });
  const existing = routing.routes ?? {};
  if (Object.keys(existing).length > 0) return { seeded: false, count: Object.keys(existing).length };
  if (!bothHostsEnabled(cfg) || !aqeSupportsAgentOverrides()) return { seeded: false, count: 0 };
  // primary host (default claude) biases the seed: codex-primary mirrors the
  // default routes so codex leads and claude is the alternate (ADR-0004 escalation).
  routing.routes = seedActivityRoutes({
    hosts: ['claude', 'codex'],
    primary: routing.primaryHost ?? DEFAULT_PRIMARY_HOST,
  });
  return { seeded: true, count: Object.keys(routing.routes).length };
}

/** Rewrite seeded routes that still point at a model the host has withdrawn, so
 *  the persisted policy stops naming a model that will not answer. Mutates
 *  cfg.routing.routes; the rewrite itself is migrateRetiredRoutes (pure). A
 *  `user` pin is reported but never rewritten — resolveRoutes substitutes it at
 *  read time so the run stays safe without overwriting deliberate intent. */
export function migrateRetiredRoutesInConfig(cfg) {
  const routes = cfg.routing?.routes;
  if (!routes || Object.keys(routes).length === 0) return { changed: false, changes: [] };
  const { routes: next, changes } = migrateRetiredRoutes(routes);
  const rewritten = changes.filter((c) => c.rewritten);
  if (rewritten.length > 0) cfg.routing.routes = next;
  return { changed: rewritten.length > 0, changes };
}

/** Print one line per retired-route change — the identical loop `ak sync`,
 *  `ak host pick`, and `ak setup` each ran inline in their
 *  convergeProviderStack 'routing-retired' reporter, shared here so the
 *  wording can never drift between the three. A rewritten (seeded) change
 *  reports what changed; a `provenance: 'user'` change reports the pin kept
 *  and what ak actually runs instead, per migrateRetiredRoutesInConfig's
 *  {activity, field, from, to, retiresOn, rewritten} shape. */
export function reportRetiredRouteChanges(changes) {
  for (const c of changes) {
    const when = c.retiresOn ? `retires ${c.retiresOn}` : 'already withdrawn';
    reportOutcome('routing', c.rewritten
      ? { ok: true, changed: true, detail: `${c.activity} ${c.field}: ${c.from} → ${c.to} (${when})` }
      : { ok: true, changed: false, detail: `${c.activity} ${c.field} pins ${c.from} (${when}) — user pin kept; ak runs ${c.to}` });
  }
}

/** Apply `ak setup` host flags to a kit.json cfg IN PLACE (before setup's
 *  install/wiring runs), so the existing gated/prompted/external-safe paths pick
 *  codex up. `--codex` (or `--primary-host codex`) enables BOTH hosts; keeps the
 *  default claude-only behavior untouched when neither flag is passed. Returns
 *  {changed, warnings} — pure except for the intended cfg mutation. */
export function applySetupHostFlags(cfg, flags = {}) {
  const integrations = cfg.integrations ?? (cfg.integrations = {
    version: CURRENT_INTEGRATIONS_VERSION,
    bindings: [],
  });
  integrations.hosts ?? (integrations.hosts = defaultHostMap());
  const routing = cfg.routing ?? (cfg.routing = {
    version: ROUTING_SCHEMA_VERSION,
    primaryHost: DEFAULT_PRIMARY_HOST,
    routes: {},
  });
  const warnings = [];
  let changed = false;
  const wantPrimary = typeof flags['primary-host'] === 'string' ? flags['primary-host'].trim().toLowerCase() : null;
  // choosing codex as primary implies wanting codex enabled
  if (flags.codex || wantPrimary === 'codex') {
    if (!integrations.hosts.codex || !integrations.hosts.claude) changed = true;
    integrations.hosts = { ...integrations.hosts, claude: true, codex: true };
  }
  // --opencode opts the opencode host in (config-file wiring, no env flags)
  if (flags.opencode) {
    if (!integrations.hosts.opencode) changed = true;
    integrations.hosts = { ...integrations.hosts, opencode: true };
  }
  if (wantPrimary) {
    if (PRIMARY_HOSTS.includes(wantPrimary)) {
      if (routing.primaryHost !== wantPrimary) { routing.primaryHost = wantPrimary; changed = true; }
    } else {
      warnings.push(`unknown --primary-host '${wantPrimary}' (valid: ${PRIMARY_HOSTS.join('|')}) — ignored`);
    }
  }
  return { changed, warnings };
}

/** Render the effective per-activity routing as a colorized table, or null when
 *  no policy is set. Shared by `pick`/`status`/`setup` so the view never drifts. */
export function formatRoutingTable(cfg) {
  const policy = cfg.routing?.routes ?? {};
  if (Object.keys(policy).length === 0) return null;
  const routes = resolveRoutes(policy);
  const s = routingSummary(policy);
  const lines = [bold('\nper-activity routing')
    + dim(`  (${s.byHost.claude ?? 0} claude · ${s.byHost.codex ?? 0} codex · ${s.byHost.opencode ?? 0} opencode · ${s.custom} custom · .agentic-qe/llm-config.json)`)];
  // "diverges from", never "stale"/"outdated"/"superseded": the pinned model is
  // sometimes the better choice for an activity, so the wording must present a
  // decision rather than a lag (#55).
  const diverged = Object.fromEntries(divergedRoutes(policy).map((d) => [d.activity, d]));
  for (const act of ACTIVITIES) {
    const r = routes[act];
    const src = r.provenance === 'user' ? cyan('custom') : dim(r.provenance);
    const esc = r.escalation?.length ? dim(`  ↑ ${r.escalation.map((e) => e.host).join('→')}`) : '';
    const tag = r.akOriginated ? dim(' [ak]') : '';
    const d = diverged[act];
    const div = d
      ? dim(`  diverges from default ${d.modelDiverged ? d.defaultModel : d.escalation.map((e) => `↑${e.defaultModel}`).join(',')}`)
      : '';
    lines.push(`  ${act.padEnd(18)} ${r.host.padEnd(7)} ${(r.model ?? '').padEnd(24)} ${src}${tag}${esc}${div}`);
  }
  if (Object.keys(diverged).length) {
    lines.push(dim(`  ${Object.keys(diverged).length} seeded route(s) diverge from current defaults — review with: ak host refresh`));
  }
  return lines.join('\n');
}

/** Print the routing table (no-op when no policy is set). */
export function printActivityRoutingTable(cfg) {
  const t = formatRoutingTable(cfg);
  if (t) console.log(t);
}

// ── retired Claude → Codex MCP backend ──────────────────────────────────────
// OpenAI deprecated `codex mcp-server` on 2026-08-24. `ak run` is the managed,
// deadline-bounded cross-host path (ADR-0018/0020/0033); OpenAI's Claude Code
// plugin is an optional user-owned interactive path. Reconciliation therefore
// removes ONLY the project MCP entry that agentic-kit previously registered.
// A pre-existing/user-owned entry is preserved and reported with an explicit
// manual remedy. The ownership receipt is cleared only after absence is proven.
function clearLegacyCodexMcpReceipt(cfg) {
  cfg.integrations ??= {};
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.codex ??= {};
  cfg.integrations.ownership.codex.mcp = null;
}

export async function retireCodexMcp(cfg, cwd = process.cwd(), {
  runner = run, inspect = codexMcpStatus,
} = {}) {
  const current = inspect(cfg, cwd);
  if (!current.registered) {
    if (current.owned) {
      clearLegacyCodexMcpReceipt(cfg);
      return { ok: true, changed: true, detail: 'stale legacy codex MCP ownership receipt cleared' };
    }
    return { ok: true, changed: false, detail: 'legacy codex MCP absent (retired)' };
  }
  if (!current.owned) {
    return {
      ok: false,
      changed: false,
      detail: 'deprecated user-owned codex MCP preserved — remove manually: claude mcp remove codex -s project',
    };
  }

  const removed = await undoCodexMcp(cwd, { managed: true, runner });
  if (!removed.ok) return { ...removed, detail: `legacy codex MCP retirement failed: ${removed.detail}` };
  if (inspect(cfg, cwd).registered) {
    return { ok: false, changed: false, detail: 'legacy codex MCP removal could not be confirmed; ownership receipt retained' };
  }
  clearLegacyCodexMcpReceipt(cfg);
  return { ok: true, changed: true, detail: 'legacy codex MCP removed; supervised cross-host execution uses ak run' };
}

/** Remove the project-scoped codex MCP server — ONLY when ak registered it
 *  (managed === true). Never tears down a server the user added themselves. */
export async function undoCodexMcp(cwd = process.cwd(), { managed = false, runner = run } = {}) {
  if (!managed) return { ok: true, changed: false, detail: 'codex MCP left as-is (not ak-registered)' };
  const r = await runner('claude', ['mcp', 'remove', 'codex', '-s', 'project'], { cwd });
  return r.code === 0
    ? { ok: true, changed: true, detail: 'codex MCP removed' }
    : { ok: false, changed: false, detail: `codex MCP removal failed: ${(r.stderr || r.stdout || `exit ${r.code}`).split('\n')[0].slice(0, 120)}` };
}

// ── Ruflo MCP → Codex ───────────────────────────────────────────────────────
// Register the Ruflo MCP server INTO Codex so a Codex-driven session can reach
// the same routing, swarm, and memory tools as Claude. This is an independent
// host integration, not the reverse half of a peer-to-peer MCP bridge. It uses:
// `codex mcp add ruflo -- ak x ruflo-mcp` writes a [mcp_servers.ruflo] table into
// ~/.codex/config.toml; the launcher pins memory from each runtime workspace.
// aqe's own codex MCP is handled by `aqe init --with-codex`
// (setup runs it), and Claude Code is not itself an MCP server, so those two legs
// live elsewhere; this owns the ruflo leg. Best-effort; a failure never fails the
// caller. Ownership marker: integrations.ownership.codex.reverseMcp === 'ak'.
export async function ensureRufloMcpInCodex(cfg, cwd = process.cwd(), {
  runner = run, haveFn = have, inspect = rufloCodexMcpStatus,
} = {}) {
  if (!cfg.integrations?.hosts?.codex) return { ok: true, changed: false, detail: 'codex not enabled — ruflo→codex MCP unmanaged' };
  if (!(await haveFn('codex'))) return { ok: true, changed: false, detail: 'codex CLI not installed' };
  if (!(await haveFn('ruflo'))) return { ok: true, changed: false, detail: 'ruflo not on PATH — ruflo→codex MCP skipped' };
  const current = inspect(cfg);
  const desired = current.command === 'ak'
    && JSON.stringify(current.args) === JSON.stringify(['x', 'ruflo-mcp']);
  if (current.registered && desired) {
    return { ok: true, changed: false, detail: 'ruflo MCP already registered in codex (workspace memory pinned)' };
  }
  if (current.registered && !current.owned) {
    return { ok: true, changed: false, detail: 'ruflo MCP already registered in codex (user-owned; left unchanged)' };
  }
  if (current.registered) {
    const removed = await runner('codex', ['mcp', 'remove', 'ruflo'], { cwd });
    if (removed.code !== 0) {
      return { ok: false, changed: false, detail: 'ruflo→codex MCP migration could not remove the ak-owned legacy registration' };
    }
  }
  const r = await runner('codex', ['mcp', 'add', 'ruflo', '--', 'ak', 'x', 'ruflo-mcp'], { cwd });
  if (r.code === 0) {
    cfg.integrations.ownership ??= {};
    cfg.integrations.ownership.codex ??= {};
    cfg.integrations.ownership.codex.reverseMcp = 'ak';
    return { ok: true, changed: true, detail: 'ruflo MCP registered into codex with workspace-pinned project memory ([mcp_servers.ruflo])' };
  }
  if (/already exists|already configured/i.test(`${r.stderr}${r.stdout}`)) {
    return { ok: true, changed: false, detail: 'ruflo MCP already registered in codex' };
  }
  return { ok: false, changed: false, detail: `ruflo→codex MCP registration failed: ${(r.stderr || r.stdout || '').split('\n')[0].slice(0, 120)}` };
}

/** Remove the ruflo MCP server from Codex — ONLY when ak registered it
 *  (managed === true). Never tears down a server the user added themselves. */
export async function undoRufloMcpInCodex(cwd = process.cwd(), { managed = false, runner = run, haveFn = have } = {}) {
  if (!managed) return { ok: true, changed: false, detail: 'ruflo→codex MCP left as-is (not ak-registered)' };
  if (!(await haveFn('codex'))) return { ok: true, changed: false, detail: 'codex CLI not installed' };
  const r = await runner('codex', ['mcp', 'remove', 'ruflo'], { cwd });
  return r.code === 0
    ? { ok: true, changed: true, detail: 'ruflo MCP removed from codex' }
    : { ok: false, changed: false, detail: `ruflo→codex MCP removal failed: ${(r.stderr || r.stdout || `exit ${r.code}`).split('\n')[0].slice(0, 120)}` };
}

/** The exact env this config wants written. `AQE_LLM_PROVIDER` is written only
 *  when the user pinned a (valid) aqe provider — otherwise aqe keeps its own
 *  default/env detection. Omitting a key means "remove if present". */
export function managedEnv(cfg) {
  const p = cfg.providers ?? {};
  const hosts = cfg.integrations?.hosts ?? {};
  const e = {
    ENABLE_CLAUDE_CODE: String(!!hosts.claude),
    ENABLE_CODEX: String(!!hosts.codex),
  };
  if (cfg.aqe !== false && p.aqeProvider && AQE_PROVIDER_TYPES.includes(p.aqeProvider)) {
    e.AQE_LLM_PROVIDER = p.aqeProvider;
  }
  if (p.maxBudgetUsd != null) e.AQE_MAX_BUDGET_USD = String(p.maxBudgetUsd);
  return e;
}

/** Reconcile the managed env keys in the target settings file to match `cfg`.
 *  Idempotent, backup-first, merge-not-clobber. Returns {ok, detail, changed}. */
export function applyHosts(cfg, cwd = process.cwd()) {
  if (isDefault(cfg)) return { ok: true, changed: false, detail: 'claude-only (default) — nothing to wire' };
  const { file, scope } = settingsTarget(cwd);
  const desired = managedEnv(cfg);
  const s = readJson(file, {}) ?? {};
  s.env ??= {};
  let changed = false;
  for (const k of MANAGED_ENV_KEYS) {
    if (k in desired) {
      if (s.env[k] !== desired[k]) { s.env[k] = desired[k]; changed = true; }
    } else if (k in s.env) { delete s.env[k]; changed = true; }
  }
  if (changed) writeJsonWithBackup(file, s);
  const on = HOSTS.filter((h) => cfg.integrations?.hosts?.[h.id]).map((h) => h.id).join('+') || 'none';
  return { ok: true, changed, detail: `hosts=${on} (${scope}${changed ? ', written' : ', in sync'})` };
}

// id/model/endpoint reach a real subprocess argv (`ruflo providers configure
// -p <id> -m <model> -e <endpoint>`). exec.mjs's shell:false + resolved-argv fix is the real
// injection defense (no shell ever parses these), but kit.json is user-edited
// and `--provider` is a CLI flag with no upstream allowlist — this grammar is
// defense-in-depth so a malformed value fails fast and visibly here rather
// than reaching ruflo as a mangled/truncated argument. Not restricted to
// API_PROVIDERS (a narrower, unrelated list — the api-key-only providers this
// module can check env keys for): ruflo's own provider set is broader
// (openrouter, azure-openai, bedrock, cognitum, …) and ruflo validates the id
// itself; this only rejects shapes no real provider/model id has. Provider ids
// and model ids deliberately use different grammars: tagged Ollama models and
// vendor-qualified OpenRouter slugs contain ':' and '/' respectively.
export const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PROVIDER_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export const MIN_RUFLO_PERSISTED_PROVIDER_VERSION = '3.38.8';
export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';

/** Read the same cwd-scoped provider entry Ruflo's ConfigFileManager will use.
 * This is read-only preservation logic: when a user already set a custom
 * baseUrl directly with Ruflo, ak omits `-e` so Ruflo's upsert keeps it. */
export function persistedRufloProvider(cwd, providerId, { env = process.env } = {}) {
  const projectFiles = [
    path.resolve(cwd, 'claude-flow.config.json'),
    path.resolve(cwd, '.claude-flow', 'config.json'),
  ];
  const envFile = env.CLAUDE_FLOW_CONFIG ? path.resolve(cwd, env.CLAUDE_FLOW_CONFIG) : null;
  const file = [...projectFiles, envFile].find((candidate) => candidate && fs.existsSync(candidate));
  if (!file) return null;
  const providers = readJson(file)?.agents?.providers;
  if (!Array.isArray(providers)) return null;
  return providers.find((entry) => typeof entry?.name === 'string'
    && entry.name.toLowerCase() === providerId.toLowerCase()) ?? null;
}

/** Register configured providers with Ruflo (keys read from env, never passed
 * here). Idempotent — Ruflo upserts. A fresh Ollama entry receives its standard
 * loopback endpoint; a pre-existing custom Ruflo endpoint is preserved. */
export async function applyProviders(cfg, cwd = process.cwd(), {
  haveFn = have,
  runner = run,
  versionFn = installedVersion,
  env = process.env,
} = {}) {
  const models = cfg.providers?.models ?? [];
  if (models.length === 0) return { ok: true, changed: false, status: 'ok', detail: 'no providers configured' };
  if (!(await haveFn('ruflo'))) return { ok: false, changed: false, status: 'failed', detail: 'ruflo not on PATH' };
  const rufloVersion = versionFn('ruflo');
  const providerSelectionSupported = !rufloVersion
    || cmpVersions(rufloVersion, MIN_RUFLO_PERSISTED_PROVIDER_VERSION) >= 0;
  const done = [];
  let attempted = 0;
  for (const m of models) {
    if (!m?.id) continue;
    if (typeof m.id !== 'string' || !PROVIDER_ID_RE.test(m.id)
      || (m.model && (typeof m.model !== 'string' || !PROVIDER_MODEL_RE.test(m.model)))) {
      done.push(`${m.id}(invalid)`);
      continue;
    }
    const args = ['providers', 'configure', '-p', m.id];
    if (m.model) args.push('-m', m.model);
    const existing = persistedRufloProvider(cwd, m.id, { env });
    let endpoint = m.endpoint;
    if (endpoint === undefined && m.id.toLowerCase() === 'ollama' && !existing?.baseUrl
      && !env.OLLAMA_BASE_URL && !env.OLLAMA_API_KEY) {
      endpoint = DEFAULT_OLLAMA_ENDPOINT;
    }
    if (endpoint !== undefined) {
      const validation = typeof endpoint === 'string'
        ? validateEndpoint(endpoint)
        : { ok: false, reason: 'invalid-url' };
      if (!validation.ok) {
        done.push(`${m.id}(invalid endpoint: ${validation.reason})`);
        continue;
      }
      args.push('-e', validation.normalized);
    }
    attempted += 1;
    const r = await runner('ruflo', args, { cwd, timeout: 60_000 });
    done.push(`${m.id}${r.code === 0 ? '' : '(failed)'}`);
  }
  const ok = done.every((d) => !d.includes('failed') && !d.includes('invalid'));
  const compatibility = providerSelectionSupported ? ''
    : `; ruflo ${rufloVersion} registers providers but agent_execute needs >=${MIN_RUFLO_PERSISTED_PROVIDER_VERSION} to select persisted config`;
  return {
    ok,
    changed: attempted > 0,
    status: !ok ? 'failed' : providerSelectionSupported ? 'ok' : 'degraded',
    detail: `registered: ${done.join(', ')}${compatibility}`,
  };
}

// ── the shared provider-convergence pipeline ─────────────────────────────────
// `ak sync`, `ak host pick`, and `ak setup --project` each apply the SAME
// ordered sequence of provider/routing surfaces after hosts/routing intent is
// settled: applyHosts -> seedActivityRoutesIfMultiHost ->
// migrateRetiredRoutesInConfig -> applyAqeRouter -> retireCodexMcp ->
// ensureRufloMcpInCodex -> applyProviders. This was pasted 3x with only sync
// calling migrateRetiredRoutesInConfig, so pick/setup could persist a route
// naming a withdrawn model until the next sync repaired it (fixed above).
// convergeProviderStack is the ONE place that pipeline is defined; the three
// call sites supply only report/save policy via `reporter`/`save`.

/** Run the shared provider-convergence pipeline against `cfg`. Mutates (and,
 *  for a cfg-mutating step that reports a change, persists via `save`) `cfg`
 *  in place; never mutates the caller's on-disk kit.json beyond that.
 *
 *  `reporter(step, result)` fires once per step, UNCONDITIONALLY (`await`ed,
 *  so an async reporter still runs in strict pipeline order), in pipeline
 *  order — a caller decides whether/how to print from `result`, so each of
 *  the three call sites can keep its own exact wording and gating (e.g. "only
 *  print when changed or failed"). Step ids, in order: 'hosts', 'routing-
 *  seed', 'routing-retired', 'aqe-router', 'legacy-codex-mcp',
 *  'ruflo-codex-mcp', 'providers-api'.
 *
 *  `seedRoutes: false` skips the seed step for a caller that already seeded
 *  earlier in its own flow (`ak host pick` seeds before route pruning, well
 *  before this pipeline runs) — seeding twice would be a harmless no-op
 *  (seedActivityRoutesIfMultiHost is idempotent once routes exist), but
 *  skipping it keeps the 'routing-seed' step's reporter call meaningful only
 *  where seeding actually happens here.
 *
 *  `codexMcp: false` skips the legacy-codex-mcp/ruflo-codex-mcp steps
 *  entirely (their reporter calls still fire, with `result: null`) — `ak
 *  setup --project` only runs them while codex is enabled, whereas `ak sync`
 *  and `ak host pick` always run them (the deprecated-backend cleanup is
 *  independent of current enablement by design; see retireCodexMcp).
 *
 *  `runProviders` lets a caller wrap the terminal applyProviders call (sync
 *  shows a progress ticker around it); it defaults to a plain call.
 *
 *  Returns every step's raw result, for a caller that needs more than the
 *  reporter callback (e.g. sync's `aqeRouterApplyFailure` bookkeeping).
 * @param {any} cfg
 * @param {string} [cwd]
 * @param {{
 *   reporter?: (step: string, result: any) => any,
 *   save?: (cfg: any) => void,
 *   seedRoutes?: boolean,
 *   seed?: (cfg: any) => {seeded: boolean, count: number},
 *   migrateRoutes?: (cfg: any) => {changed: boolean, changes: any[]},
 *   codexMcp?: boolean,
 *   runProviders?: (fn: () => Promise<any>) => Promise<any>,
 * }} [options] */
export async function convergeProviderStack(cfg, cwd = process.cwd(), {
  reporter = () => {},
  save = saveKitConfig,
  seedRoutes = true,
  seed: seedFn = seedActivityRoutesIfMultiHost,
  migrateRoutes = migrateRetiredRoutesInConfig,
  codexMcp = true,
  runProviders = (fn) => fn(),
} = {}) {
  const hosts = applyHosts(cfg, cwd);
  await reporter('hosts', hosts);

  const seed = seedRoutes ? seedFn(cfg) : { seeded: false, count: 0 };
  if (seed.seeded) save(cfg);
  await reporter('routing-seed', seed);

  const retired = migrateRoutes(cfg);
  if (retired.changed) save(cfg);
  await reporter('routing-retired', retired);

  const router = applyAqeRouter(cfg, cwd);
  await reporter('aqe-router', router);

  let mcp = null;
  if (codexMcp) {
    mcp = await retireCodexMcp(cfg, cwd);
    if (mcp.changed) save(cfg);
  }
  await reporter('legacy-codex-mcp', mcp);

  let rmcp = null;
  if (codexMcp) {
    rmcp = await ensureRufloMcpInCodex(cfg, cwd);
    if (rmcp.changed) save(cfg);
  }
  await reporter('ruflo-codex-mcp', rmcp);

  const providers = await runProviders(() => applyProviders(cfg, cwd));
  await reporter('providers-api', providers);

  return {
    hosts, seed, retired, router, mcp, rmcp, providers,
  };
}

/** Reversible teardown: strip every managed env key from the target file. */
export function undoProviders(cwd = process.cwd()) {
  const { file } = settingsTarget(cwd);
  const s = readJson(file);
  if (!s?.env) return { ok: true, changed: false, detail: 'nothing wired' };
  let removed = 0;
  for (const k of MANAGED_ENV_KEYS) if (k in s.env) { delete s.env[k]; removed++; }
  if (removed) writeJsonWithBackup(file, s);
  return { ok: true, changed: removed > 0, detail: `${removed} managed env key(s) removed` };
}
