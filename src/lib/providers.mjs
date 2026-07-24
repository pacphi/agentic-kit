// Frontier-host + LLM-provider detection and wiring.
//
// why: rUv ships this downstream — ak only detects + wires it (detect→heal→verify),
// it does NOT reimplement provider machinery. Grounded in rUv source:
//   - ruflo ADR-034 "Optional MCP Backends" (ACCEPTED): Claude Code / Gemini / OpenAI
//     Codex backends are enabled via env vars ENABLE_CLAUDE_CODE / ENABLE_CODEX /
//     ENABLE_GEMINI_MCP.
//   - @claude-flow/codex adapter (bin claude-flow-codex); `ruflo init --dual` =
//     "Initialize for both Claude Code and OpenAI Codex".
//   - `ruflo providers configure -p <id> -m <model>` persists API-key providers
//     (anthropic/openai/google/ollama) to ruflo's config.
//   - agentic-qe LLM selector `AQE_LLM_PROVIDER=<type>` (ADR-123,
//     dist/shared/llm/router/config-store.js) force-selects ANY provider in
//     ALL_PROVIDER_TYPES — claude-code (subscription), claude/openai/gemini/
//     openrouter/azure-openai/bedrock/cognitum (metered api), ollama (local). It
//     normalizes `anthropic`→`claude` and warns on unknown values. So aqe is NOT
//     limited to claude-code; codex-the-CLI simply isn't a provider *type* (its
//     OpenAI models are reached via `openai`).
//
// Two independent axes:
//   host axis     — which agent CLI runs the ruflo loop (claude, codex). ruflo runs
//                   both at once (dual-mode). This is about the coding-agent CLI.
//   provider axis — which LLM the *routers* use: ruflo's API-key providers
//                   (`ruflo providers configure`) and aqe's `AQE_LLM_PROVIDER`.
//                   Independent of the host axis; keys live in the env, never kit.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, have } from './exec.mjs';
import { readJson, writeJsonWithBackup } from './settings.mjs';
import { installedVersion, cmpVersions } from './versions.mjs';
import * as paths from './paths.mjs';
import { bold, dim, cyan } from './output.mjs';
import { policyToAgentOverrides, seedDualRouting, resolveRoutes, routingSummary, ACTIVITIES, DEFAULT_PRIMARY_HOST } from './routing.mjs';
import { HOST_ADAPTERS } from './hosts.mjs';

/** Frontier agent-CLI hosts. `pkg` is the npm global package; `enableEnv` is
 *  ruflo's ADR-034 backend flag; `aqe` is the AQE_LLM_PROVIDER value (null when
 *  aqe can't host it). */
/** ruflo's dual-mode adapter — a SEPARATE npm global from the codex CLI. Without
 *  it, `ruflo init --dual` aborts with "The @claude-flow/codex package is not
 *  installed". ak treats it as a managed prerequisite of dual-mode (installed
 *  only when codex is opted-in AND the codex CLI is detected). */
export const CODEX_ADAPTER_PKG = '@claude-flow/codex';

export const HOSTS = [
  { id: 'claude', bin: 'claude', pkg: '@anthropic-ai/claude-code', enableEnv: 'ENABLE_CLAUDE_CODE', aqe: 'claude-code' },
  { id: 'codex', bin: 'codex', pkg: '@openai/codex', enableEnv: 'ENABLE_CODEX', aqe: null, adapterPkg: CODEX_ADAPTER_PKG },
];

/** API-key LLM providers ruflo's router understands (`ruflo providers`). */
export const API_PROVIDERS = [
  { id: 'anthropic', keyEnv: ['ANTHROPIC_API_KEY'] },
  { id: 'openai', keyEnv: ['OPENAI_API_KEY'] },
  { id: 'google', keyEnv: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
  { id: 'ollama', keyEnv: [] }, // local; presence = reachable daemon (not checked here)
];

/** Valid `AQE_LLM_PROVIDER` values (grounded: aqe ALL_PROVIDER_TYPES in
 *  dist/shared/llm/router/types.js). aqe force-selects any of these for its QE
 *  analysis, independent of ruflo's host. `claude-code` = Claude subscription;
 *  `ollama`/`onnx` = local ($0); the rest metered. Keep in sync with aqe's list. */
export const AQE_PROVIDER_TYPES = [
  'claude-code', 'claude', 'openai', 'gemini', 'openrouter',
  'azure-openai', 'bedrock', 'cognitum', 'ollama', 'onnx',
];

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
 *  the already-known install state so an absent host reads 'none' without a probe. */
export function hostAuthState(id, { env = process.env, present = true } = {}) {
  const a = HOST_ADAPTERS[id]?.auth;
  if (!a) return { mode: 'unknown', billing: 'unknown', source: null, note: null };
  const keyEnv = a.apiKeyEnv.find((k) => !!env[k]);
  const loginPath = a.loginFile ? path.join(os.homedir(), ...a.loginFile) : null;
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

/** Detect installed hosts + whether they are currently wired on in `cwd`. */
export async function detectHosts(cwd = process.cwd()) {
  const env = currentEnv(cwd);
  const out = {};
  for (const h of HOSTS) {
    const present = await have(h.bin);
    out[h.id] = {
      present,
      version: present ? await hostVersion(h.bin) : null,
      wired: env[h.enableEnv] === 'true',
    };
  }
  return out;
}

/** Detect which API providers have credentials available. */
export function detectProviders() {
  const out = {};
  for (const p of API_PROVIDERS) {
    out[p.id] = { keyPresent: p.keyEnv.some((k) => !!process.env[k]) };
  }
  return out;
}

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
 *  until they opt in. */
export function isDefault(cfg) {
  const p = cfg.providers ?? {};
  return !!p.hosts?.claude && !p.hosts?.codex && p.aqeProvider == null
    && (!p.models || p.models.length === 0) && (p.maxBudgetUsd == null)
    && (!p.aqeFallback || p.aqeFallback.length === 0);
}

/** True when both frontier hosts are enabled in persisted intent (kit.json),
 *  regardless of whether the env is wired yet — this is the same source
 *  `status()` already keys "enabled" off of. Guards the dual-mode/judge-bias
 *  guidance below: only relevant once both are actually opted in. */
export const bothHostsEnabled = (cfg) => !!cfg.providers?.hosts?.claude && !!cfg.providers?.hosts?.codex;

/** Guidance printed once both hosts are enabled — pointers to capability that
 *  already exists one layer up from ak's own wiring (see issue #36):
 *   - role-based dual-mode delegation lives in the separate @claude-flow/codex
 *     npm package's `dual` CLI, which ak installs as a prerequisite but never
 *     surfaces itself.
 *   - judge-vendor-bias: a same-vendor LLM judge scores ~8-10pp inflated versus
 *     a cross-vendor judge (still ordinally correct, not calibrated) — measured
 *     in openrouter-alts.json's judge_bias_check_2026_06_15. */
export const DUAL_ROLE_TIP = 'both hosts enabled — try role delegation: claude-flow-codex dual run --template feature|security|refactor (or custom --worker specs)';
export const JUDGE_BIAS_TIP = 'tip: for LLM-judged scoring, use a different vendor than the writer as judge — same-vendor judges run ~8-10pp inflated (still ordinally correct, but not calibrated)';

/** Cross-sell for agentic-qe's qe-court (ADR-124, shipped 3.13.0): its jury
 *  requires >= 2 distinct vendors seated, which a dual-host setup already
 *  satisfies. Only meaningful once both hosts are enabled AND aqe is new
 *  enough to ship the skill — callers gate on both. */
export const QE_COURT_TIP = 'agentic-qe ≥ 3.13.0 ships qe-court (adversarial review) — its jury requires ≥ 2 distinct vendors, which your dual-host setup already satisfies';

/** Suggested aqe-fallback chain when codex is among the enabled hosts: codex's
 *  models are reached via the `openai` provider type (not as an aqe provider
 *  itself), so pairing claude-code + openai is a direct inference from the
 *  hosts already chosen in the same session. Literal reused from
 *  docs/PROVIDERS.md's own example rather than inventing new model ids. */
export const AQE_FALLBACK_CODEX_SUGGESTION = 'claude-code:claude-opus-4-8; openai:gpt-5.6';
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

/** Write ak's managed router config into `.agentic-qe/llm-config.json`, merged
 *  into any existing file (backup-first, never persisting apiKey):
 *    - the ordered fallback chain + enabled set + default provider (from
 *      `aqeFallback`), and
 *    - the per-activity `agentOverrides` map projected from `dualRouting`
 *      (issue #568; only when installed aqe ≥ 3.13.1).
 *  No-op unless at least one of those is configured and we are in a project.
 *  Returns {ok, changed, detail}. */
export function applyAqeRouter(cfg, cwd = process.cwd()) {
  const chain = cfg.providers?.aqeFallback ?? [];
  const policy = cfg.providers?.dualRouting ?? {};
  const hasChain = chain.length > 0;
  const hasPolicy = Object.keys(policy).length > 0;
  if (!hasChain && !hasPolicy) return { ok: true, changed: false, detail: 'no aqe router config to apply' };
  // Same repo-root resolution as settingsTarget — the three scope gates must
  // never disagree about what "in a project" means (see paths.repoRoot).
  const root = paths.repoRoot(cwd);
  if (!root) return { ok: true, changed: false, detail: 'not a project — aqe router unmanaged' };
  const file = aqeRouterFile(root);
  const existing = readJson(file, {}) ?? {};
  const next = { ...existing };
  next._managedBy = AQE_MANAGED_TAG;
  const details = [];
  let wrote = false;

  let chainError = null;
  if (hasChain) {
    const valid = chain.filter((e) => e?.provider && AQE_PROVIDER_TYPES.includes(e.provider));
    if (valid.length === 0) {
      // A bad chain must NOT block the independent agentOverrides projection — the
      // dualRouting policy is validated separately. Record it and carry on.
      chainError = 'no valid providers in fallback chain';
      details.push(`chain: ⚠ ${chainError}`);
    } else {
      next.defaultProvider = cfg.providers.aqeProvider ?? valid[0].provider;
      next.providers = { ...(existing.providers ?? {}) };
      for (const e of valid) next.providers[e.provider] = { ...(existing.providers?.[e.provider] ?? {}), enabled: true };
      next.fallbackChain = buildChain(valid);
      const emptyModels = valid.filter((e) => !e.models || e.models.length === 0).map((e) => e.provider);
      details.push(`chain: ${valid.map((e) => e.provider).join(' → ')}${emptyModels.length ? ` (⚠ no models for: ${emptyModels.join(', ')})` : ''}`);
      wrote = true;
    }
  }

  if (hasPolicy && aqeSupportsAgentOverrides()) {
    // MERGE, don't replace: ak owns only the curated agent-types it projects;
    // preserve foreign entries (aqe's own defaults or a hand-added agent). The
    // projector drops non-constructible providers (mirrors sanitizeAgentOverrides)
    // and only ever emits {provider, model} — no apiKey.
    const projected = policyToAgentOverrides(policy);
    next.agentOverrides = { ...(existing.agentOverrides ?? {}), ...projected };
    details.push(`agentOverrides: ${Object.keys(projected).length} agents`);
    wrote = true;
  } else if (hasPolicy) {
    details.push('agentOverrides: skipped (needs agentic-qe ≥ 3.13.1)');
  }

  if (!wrote) return { ok: !chainError, changed: false, detail: details.join('; ') || 'nothing to apply' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonWithBackup(file, next);
  return { ok: !chainError, changed: true, detail: details.join('; ') };
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

// ── per-activity dual-host routing (kit.json providers.dualRouting) ──────────
// Seed/format helpers shared by `ak x provider` and `ak setup`. The pure policy
// core + projectors live in routing.mjs; these bridge it to kit.json + the CLI.

/** Seed the per-activity routing policy from defaults when BOTH hosts are enabled
 *  and aqe supports agentOverrides — but only if the user has no policy yet (empty
 *  map). Subscription-only targeting + `seeded` provenance come from seedDualRouting
 *  (ADR-0003). Mutates cfg.providers.dualRouting. Returns {seeded, count}. */
export function seedDualRoutingIfDualHost(cfg) {
  const p = cfg.providers ?? (cfg.providers = {});
  const existing = p.dualRouting ?? {};
  if (Object.keys(existing).length > 0) return { seeded: false, count: Object.keys(existing).length };
  if (!bothHostsEnabled(cfg) || !aqeSupportsAgentOverrides()) return { seeded: false, count: 0 };
  // primary host (default claude) biases the seed: codex-primary mirrors the
  // default routes so codex leads and claude is the alternate (ADR-0004 escalation).
  p.dualRouting = seedDualRouting({ hosts: ['claude', 'codex'], primary: p.primaryHost ?? DEFAULT_PRIMARY_HOST });
  return { seeded: true, count: Object.keys(p.dualRouting).length };
}

/** Render the effective per-activity routing as a colorized table, or null when
 *  no policy is set. Shared by `pick`/`status`/`setup` so the view never drifts. */
export function formatRoutingTable(cfg) {
  const policy = cfg.providers?.dualRouting ?? {};
  if (Object.keys(policy).length === 0) return null;
  const routes = resolveRoutes(policy);
  const s = routingSummary(policy);
  const lines = [bold('\nper-activity routing')
    + dim(`  (${s.byHost.claude ?? 0} claude · ${s.byHost.codex ?? 0} codex · ${s.custom} custom · .agentic-qe/llm-config.json)`)];
  for (const act of ACTIVITIES) {
    const r = routes[act];
    const src = r.source === 'user' ? cyan('custom') : dim(r.source);
    const esc = r.escalate?.length ? dim(`  ↑ ${r.escalate.map((e) => e.host).join('→')}`) : '';
    const tag = r.akOriginated ? dim(' [ak]') : '';
    lines.push(`  ${act.padEnd(18)} ${r.host.padEnd(7)} ${(r.model ?? '').padEnd(24)} ${src}${tag}${esc}`);
  }
  return lines.join('\n');
}

/** Print the routing table (no-op when no policy is set). */
export function printActivityRoutingTable(cfg) {
  const t = formatRoutingTable(cfg);
  if (t) console.log(t);
}

// ── codex MCP backend (mcp__codex__codex) ───────────────────────────────────
// Register `codex mcp-server` (stdio) as a project-scoped Claude Code MCP server
// so a Claude orchestrator can call Codex inline via the mcp__codex__codex tool
// (the dual-host swarm's MCP path, ADR-0001 projection #3). Reversible via
// undoCodexMcp. Best-effort: a failure here never fails the caller.
// Ownership: a `codex` MCP server that PRE-EXISTS ak's registration is the user's
// and must never be torn down (there's no `_managedBy` on an MCP entry). ak only
// removes a server it actually added, tracked by `providers.codexMcp === 'ak'` in
// kit.json. On mutation ak sets the marker; the caller persists cfg.
export async function ensureCodexMcp(cfg, cwd = process.cwd()) {
  if (!cfg.providers?.hosts?.codex) return { ok: true, changed: false, detail: 'codex not enabled — codex MCP unmanaged' };
  if (!(await have('codex'))) return { ok: true, changed: false, detail: 'codex CLI not installed' };
  const r = await run('claude', ['mcp', 'add', 'codex', '-s', 'project', '--', 'codex', 'mcp-server'], { cwd });
  if (r.code === 0) {
    if (cfg.providers) cfg.providers.codexMcp = 'ak'; // ak owns it → safe to remove later
    return { ok: true, changed: true, detail: 'codex MCP registered (mcp__codex__codex)' };
  }
  if (/already exists|already configured/i.test(`${r.stderr}${r.stdout}`)) {
    // pre-existing: leave ownership as-is (only a prior ak run would have set it)
    return { ok: true, changed: false, detail: 'codex MCP already registered' };
  }
  return { ok: false, changed: false, detail: `codex MCP registration failed: ${(r.stderr || r.stdout || '').split('\n')[0].slice(0, 120)}` };
}

/** Remove the project-scoped codex MCP server — ONLY when ak registered it
 *  (managed === true). Never tears down a server the user added themselves. */
export async function undoCodexMcp(cwd = process.cwd(), { managed = false } = {}) {
  if (!managed) return { ok: true, changed: false, detail: 'codex MCP left as-is (not ak-registered)' };
  const r = await run('claude', ['mcp', 'remove', 'codex', '-s', 'project'], { cwd });
  return { ok: true, changed: r.code === 0, detail: r.code === 0 ? 'codex MCP removed' : 'codex MCP not registered' };
}

// ── reverse MCP bridge: ruflo MCP → Codex ───────────────────────────────────
// ensureCodexMcp above wires claude→codex (Claude calls Codex via mcp__codex__codex).
// This is the MIRROR: register the ruflo MCP server INTO Codex so a Codex-driven
// session can reach ruflo's tools — the codex→ruflo half that makes the bridge
// bidirectional (ambidextrous parity). Grounded in @claude-flow/codex mcp-config.ts:
// `codex mcp add ruflo -- <cmd> mcp start` writes a [mcp_servers.ruflo] table into
// ~/.codex/config.toml. aqe's own codex MCP is handled by `aqe init --with-codex`
// (setup runs it), and Claude Code is not itself an MCP server, so those two legs
// live elsewhere; this owns the ruflo leg. Best-effort; a failure never fails the
// caller. Ownership marker: providers.rufloCodexMcp === 'ak'.
export async function ensureRufloMcpInCodex(cfg, cwd = process.cwd()) {
  if (!cfg.providers?.hosts?.codex) return { ok: true, changed: false, detail: 'codex not enabled — ruflo→codex MCP unmanaged' };
  if (!(await have('codex'))) return { ok: true, changed: false, detail: 'codex CLI not installed' };
  if (!(await have('ruflo'))) return { ok: true, changed: false, detail: 'ruflo not on PATH — ruflo→codex MCP skipped' };
  const r = await run('codex', ['mcp', 'add', 'ruflo', '--', 'ruflo', 'mcp', 'start'], { cwd });
  if (r.code === 0) {
    if (cfg.providers) cfg.providers.rufloCodexMcp = 'ak'; // ak owns it → safe to remove later
    return { ok: true, changed: true, detail: 'ruflo MCP registered into codex ([mcp_servers.ruflo])' };
  }
  if (/already exists|already configured/i.test(`${r.stderr}${r.stdout}`)) {
    return { ok: true, changed: false, detail: 'ruflo MCP already registered in codex' };
  }
  return { ok: false, changed: false, detail: `ruflo→codex MCP registration failed: ${(r.stderr || r.stdout || '').split('\n')[0].slice(0, 120)}` };
}

/** Remove the ruflo MCP server from Codex — ONLY when ak registered it
 *  (managed === true). Never tears down a server the user added themselves. */
export async function undoRufloMcpInCodex(cwd = process.cwd(), { managed = false } = {}) {
  if (!managed) return { ok: true, changed: false, detail: 'ruflo→codex MCP left as-is (not ak-registered)' };
  if (!(await have('codex'))) return { ok: true, changed: false, detail: 'codex CLI not installed' };
  const r = await run('codex', ['mcp', 'remove', 'ruflo'], { cwd });
  return { ok: true, changed: r.code === 0, detail: r.code === 0 ? 'ruflo MCP removed from codex' : 'ruflo→codex MCP not registered' };
}

/** The exact env this config wants written. `AQE_LLM_PROVIDER` is written only
 *  when the user pinned a (valid) aqe provider — otherwise aqe keeps its own
 *  default/env detection. Omitting a key means "remove if present". */
export function managedEnv(cfg) {
  const p = cfg.providers ?? {};
  const e = {
    ENABLE_CLAUDE_CODE: String(!!p.hosts?.claude),
    ENABLE_CODEX: String(!!p.hosts?.codex),
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
  const on = HOSTS.filter((h) => cfg.providers.hosts[h.id]).map((h) => h.id).join('+') || 'none';
  return { ok: true, changed, detail: `hosts=${on} (${scope}${changed ? ', written' : ', in sync'})` };
}

/** Register configured API-key providers with ruflo (keys read from env, never
 *  passed here). Idempotent — ruflo upserts. Returns {ok, detail}. */
export async function applyProviders(cfg, cwd = process.cwd()) {
  const models = cfg.providers?.models ?? [];
  if (models.length === 0) return { ok: true, changed: false, detail: 'no API-key providers configured' };
  if (!(await have('ruflo'))) return { ok: false, detail: 'ruflo not on PATH' };
  const done = [];
  for (const m of models) {
    if (!m?.id) continue;
    const args = ['providers', 'configure', '-p', m.id];
    if (m.model) args.push('-m', m.model);
    const r = await run('ruflo', args, { cwd, timeout: 60_000 });
    done.push(`${m.id}${r.code === 0 ? '' : '(failed)'}`);
  }
  return { ok: done.every((d) => !d.includes('failed')), changed: true, detail: `configured: ${done.join(', ')}` };
}

/** Pure decision for the codex dual-mode adapter, factored out for tests:
 *  install ONLY when codex is opted-in, the codex CLI is present, and the adapter
 *  is not already installed. Never install the adapter for an absent CLI. */
export function codexAdapterAction({ opted, cliPresent, adapterInstalled }) {
  if (!opted) return 'skip-not-opted';
  if (!cliPresent) return 'skip-no-cli';
  if (adapterInstalled) return 'already-installed';
  return 'install';
}

/** Ensure ruflo's dual-mode adapter (@claude-flow/codex) is installed before we
 *  run `ruflo init --dual`. Guarded: opted-in codex host + detected codex CLI. */
export async function ensureCodexAdapter(cfg, cwd = process.cwd()) {
  const opted = !!cfg.providers?.hosts?.codex;
  if (!opted) return { ok: true, changed: false, detail: 'codex disabled — adapter not needed' };
  const cliPresent = await have('codex');
  const adapterInstalled = !!installedVersion(CODEX_ADAPTER_PKG);
  const action = codexAdapterAction({ opted, cliPresent, adapterInstalled });
  if (action === 'skip-no-cli') return { ok: true, changed: false, detail: 'codex CLI not detected — adapter install skipped' };
  if (action === 'already-installed') return { ok: true, changed: false, detail: `${CODEX_ADAPTER_PKG} already installed` };
  const r = await run('npm', ['install', '-g', `${CODEX_ADAPTER_PKG}@latest`], { cwd, timeout: 600_000 });
  return { ok: r.code === 0, changed: r.code === 0, detail: r.code === 0 ? `installed ${CODEX_ADAPTER_PKG}` : r.stderr.split('\n').slice(-2).join(' ').slice(0, 200) };
}

/** Heavy, pick/setup-time only: regenerate dual-mode agents when codex is on.
 *  Kept OUT of the sync hot path (it force-regenerates project files). */
export async function ensureDualAgents(cfg, cwd = process.cwd()) {
  if (!cfg.providers?.hosts?.codex) return { ok: true, changed: false, detail: 'codex disabled — no dual agents' };
  // Repo-root walk, matching settingsTarget/applyAqeRouter — and init runs at
  // the ROOT, so a subdir invocation can't scatter project files mid-tree.
  const root = paths.repoRoot(cwd);
  if (!root) return { ok: true, changed: false, detail: 'not a project — skipped `ruflo init --dual`' };
  if (!(await have('ruflo'))) return { ok: false, detail: 'ruflo not on PATH' };
  // Prerequisite: dual-init aborts unless @claude-flow/codex is present. Install
  // it first (guarded on opted-in codex + detected CLI) so a fresh machine just works.
  const adapter = await ensureCodexAdapter(cfg, root);
  if (!adapter.ok) return { ok: false, changed: adapter.changed, detail: `adapter prerequisite failed: ${adapter.detail}` };
  const r = await run('ruflo', ['init', '--dual', '--force'], { cwd: root, timeout: 300_000 });
  return { ok: r.code === 0, changed: r.code === 0, detail: r.code === 0 ? 'ruflo init --dual applied' : 'ruflo init --dual failed' };
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
