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
import { seedActivityRoutes, resolveRoutes, routingSummary, divergedRoutes, migrateRetiredRoutes, ACTIVITIES, PRIMARY_HOSTS } from './routing.mjs';
import { HOST_ADAPTERS } from './hosts.mjs';
import {
  HOST_REGISTRY, PROVIDER_REGISTRY, normalizeIntegrationFacts, defaultHostMap,
} from './adapters/index.mjs';
import { CURRENT_INTEGRATIONS_VERSION, validateEndpoint } from './adapters/config.mjs';
import { opencodeMcpStatus } from './opencode.mjs';
import { codexMcpStatus, rufloCodexMcpStatus } from './mcp.mjs';
import { projectedAqeExternalProviders } from './adapters/aqe-provider.mjs';
import { applyAqeRouter, aqeRouterDrift, undoAqeRouter } from './aqe-router.mjs';
import { globalInstallArgs } from './npm-global-install.mjs';

// The AQE-router convergence pipeline itself lives in aqe-router.mjs
// (ADR-0037); re-exported here so every existing `./providers.mjs` import
// path (commands, status sections, tests) keeps working unchanged.
export { applyAqeRouter, aqeRouterDrift, undoAqeRouter };
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
export async function installHost(id, { runner = run } = {}) {
  const host = HOSTS.find((h) => h.id === id);
  if (!host) return { ok: false, detail: `unknown host: ${id}` };
  const r = await runner('npm', globalInstallArgs(`${host.pkg}@latest`), { timeout: 600_000 });
  if (r.code !== 0) {
    return {
      ok: false, changed: false,
      detail: (r.stderr || `exit ${r.code}`).split('\n').slice(-2).join(' ').slice(0, 200),
    };
  }
  // npm exit 0 proves package extraction, not that a lifecycle-created CLI is
  // usable. This catches the Claude Code stub state that motivated issue #189
  // and benefits every managed host without executing a session or network call.
  const verify = await runner(host.bin, ['--version'], { timeout: 15_000 });
  if (verify.code !== 0) {
    return {
      ok: false, changed: true,
      detail: `installed package but ${host.bin} --version failed: ${(verify.stderr || verify.stdout || `exit ${verify.code}`).trim().split('\n')[0].slice(0, 160)}`,
    };
  }
  return { ok: true, changed: true, detail: `installed ${host.pkg}` };
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
// Grounded in aqe's router config-store + types (ADR-123). The convergence
// pipeline itself (fallback chain, default provider, external provider
// declarations/activations, agentOverrides projection) lives in
// aqe-router.mjs (ADR-0037); this module keeps the version gates and the
// hash/ownership primitives aqe-router.mjs's surfaces are built from.

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

// Ownership/hash primitives shared with aqe-router.mjs: this key/these
// functions decide whether a value on disk is still EXACTLY what ak wrote
// (never trusted input — a null/array/primitive receipt proves nothing).
// Exported for aqe-router.mjs's own reconcilers and ownership receipts; kept
// here (not there) because aqeExternalProviderState below needs them too and
// this is the direction that avoids a cycle between the two modules.
export const AQE_OWNERSHIP_KEY = '_agenticKit';

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function declarationHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function plainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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

/** Host-adapter ids kit.json configures — either declared in `hostAdapters`, or
 *  named in `integrations.hosts` without being one of the built-in HOSTS. The
 *  status/verify surface that needs to know which non-builtin ids a config
 *  intends to be an aqe-external provider (relocated from status/sections —
 *  #129-shaped: this must read the config the same way the config is written,
 *  never a re-guessed shape). */
export function configuredAdapterIds(cfg) {
  const ids = new Set((cfg.hostAdapters ?? [])
    .map((entry) => entry?.name).filter((name) => typeof name === 'string' && name));
  const builtinHostIds = new Set(HOSTS.map((host) => host.id));
  for (const id of Object.keys(cfg.integrations?.hosts ?? {})) {
    if (!builtinHostIds.has(id)) ids.add(id);
  }
  return ids;
}

/** Which configured-adapter ids are actually REFERENCED by provider/routing
 *  intent (aqeProvider, aqeFallback, or a routing route/escalation host) —
 *  regardless of whether that id is currently admitted/live. */
export function externalProviderIntent(cfg, adapterIds = configuredAdapterIds(cfg)) {
  const intent = new Set();
  if (adapterIds.has(cfg.providers?.aqeProvider)) intent.add(cfg.providers.aqeProvider);
  for (const entry of cfg.providers?.aqeFallback ?? []) {
    if (adapterIds.has(entry?.provider)) intent.add(entry.provider);
  }
  for (const route of Object.values(cfg.routing?.routes ?? {})) {
    if (adapterIds.has(route?.host)) intent.add(route.host);
    for (const rung of route?.escalation ?? []) {
      if (adapterIds.has(rung?.host)) intent.add(rung.host);
    }
  }
  return intent;
}

/** One honest read of the external-AQE-provider world for status/verify: the
 *  live projection state (aqeExternalProviderState) plus which configured
 *  intent (aqeProvider/aqeFallback/routing) names an id that isn't actually
 *  live right now. The single home for this derivation (#129) — every status
 *  section that needs it consumes this instead of re-deriving its own view. */
export function providerExternalState(cfg, cwd = process.cwd()) {
  const root = paths.repoRoot(cwd);
  const disk = root ? (readJson(aqeRouterFile(root), {}) ?? {}) : {};
  const state = root ? aqeExternalProviderState(disk, { projectRoot: root }) : null;
  const intent = externalProviderIntent(cfg);
  const live = new Set(state?.desired ?? []);
  const unavailableIntent = [...intent].filter((id) => !live.has(id));
  return {
    root, disk, state, unavailableIntent, unavailableIntentSet: new Set(unavailableIntent),
  };
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

/** Read-only: does `env` (the persisted settings.json env block) differ from
 *  what `managedEnv(cfg)` wants written? The exact predicate applyHosts uses to
 *  decide whether to write — the single source for both the writer and any
 *  drift-reporting caller (status), so the two can never diverge (#129). */
export function providerEnvDrift(cfg, env = process.env) {
  const desired = managedEnv(cfg);
  return MANAGED_ENV_KEYS.some((k) => (k in desired ? env[k] !== desired[k] : k in env));
}

/** Reconcile the managed env keys in the target settings file to match `cfg`.
 *  Idempotent, backup-first, merge-not-clobber. Returns {ok, detail, changed}. */
export function applyHosts(cfg, cwd = process.cwd()) {
  if (isDefault(cfg)) return { ok: true, changed: false, detail: 'claude-only (default) — nothing to wire' };
  const { file, scope } = settingsTarget(cwd);
  const desired = managedEnv(cfg);
  const s = readJson(file, {}) ?? {};
  s.env ??= {};
  const changed = providerEnvDrift(cfg, s.env);
  if (changed) {
    for (const k of MANAGED_ENV_KEYS) {
      if (k in desired) s.env[k] = desired[k];
      else delete s.env[k];
    }
    writeJsonWithBackup(file, s);
  }
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

/** A provider entry's id/model grammar is valid: id always required, model
 *  only when present (a provider entry may name a bare provider, no model). */
function validProviderEntry(m) {
  return typeof m.id === 'string' && PROVIDER_ID_RE.test(m.id)
    && (!m.model || (typeof m.model === 'string' && PROVIDER_MODEL_RE.test(m.model)));
}

/** The `-e <endpoint>` args for one provider entry, when any apply: explicit,
 *  or Ollama's standard loopback endpoint on a fresh entry with no existing
 *  Ruflo-persisted baseUrl or env override. `ok: false` on an invalid
 *  explicit endpoint — the caller must not proceed to invoke ruflo. */
function resolveProviderEndpointArgs(m, cwd, env) {
  const existing = persistedRufloProvider(cwd, m.id, { env });
  let endpoint = m.endpoint;
  if (endpoint === undefined && m.id.toLowerCase() === 'ollama' && !existing?.baseUrl
    && !env.OLLAMA_BASE_URL && !env.OLLAMA_API_KEY) {
    endpoint = DEFAULT_OLLAMA_ENDPOINT;
  }
  if (endpoint === undefined) return { ok: true, args: [] };
  const validation = typeof endpoint === 'string'
    ? validateEndpoint(endpoint)
    : { ok: false, reason: 'invalid-url' };
  if (!validation.ok) return { ok: false, reason: validation.reason };
  return { ok: true, args: ['-e', validation.normalized] };
}

/** Register one provider entry with ruflo. Returns the done-list label
 *  (`id`, `id(invalid)`, `id(invalid endpoint: …)`, `id(failed)`) and whether
 *  a ruflo invocation was actually attempted (never true for an id/model or
 *  endpoint that failed validation — those never reach ruflo at all). */
async function applyOneProvider(m, cwd, env, runner) {
  if (!validProviderEntry(m)) return { label: `${m.id}(invalid)`, attempted: false };
  const args = ['providers', 'configure', '-p', m.id];
  if (m.model) args.push('-m', m.model);
  const endpoint = resolveProviderEndpointArgs(m, cwd, env);
  if (!endpoint.ok) return { label: `${m.id}(invalid endpoint: ${endpoint.reason})`, attempted: false };
  args.push(...endpoint.args);
  const r = await runner('ruflo', args, { cwd, timeout: 60_000 });
  return { label: `${m.id}${r.code === 0 ? '' : '(failed)'}`, attempted: true };
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
    const result = await applyOneProvider(m, cwd, env, runner);
    done.push(result.label);
    if (result.attempted) attempted += 1;
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
