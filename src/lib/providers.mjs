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
import path from 'node:path';
import { run, have } from './exec.mjs';
import { readJson, writeJsonWithBackup } from './settings.mjs';
import { installedVersion, cmpVersions } from './versions.mjs';
import * as paths from './paths.mjs';

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

async function npmLatest(pkg) {
  const r = await run('npm', ['view', `${pkg}@latest`, 'version'], { timeout: 20_000 });
  return r.code === 0 ? r.stdout.trim() : null;
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

/** Install a missing host globally via npm. Intended for the 'absent' case only —
 *  callers check hostInstallState first so an external install is never shadowed. */
export async function installHost(id) {
  const host = HOSTS.find((h) => h.id === id);
  if (!host) return { ok: false, detail: `unknown host: ${id}` };
  const r = await run('npm', ['install', '-g', `${host.pkg}@latest`], { timeout: 600_000 });
  return { ok: r.code === 0, changed: r.code === 0, detail: r.code === 0 ? `installed ${host.pkg}` : r.stderr.split('\n').slice(-2).join(' ').slice(0, 200) };
}

/** Update an npm-managed host to latest. No-op guidance for external installs. */
export async function updateHost(id) {
  const host = HOSTS.find((h) => h.id === id);
  if (!host) return { ok: false, detail: `unknown host: ${id}` };
  const st = await hostInstallState(host);
  if (st.method !== 'npm') return { ok: true, changed: false, detail: `${id} is ${st.method}-managed — update it with your own tool` };
  const r = await run('npm', ['install', '-g', `${host.pkg}@latest`], { timeout: 600_000 });
  return { ok: r.code === 0, changed: r.code === 0, detail: r.code === 0 ? `updated ${host.pkg}` : r.stderr.split('\n').slice(-2).join(' ').slice(0, 200) };
}

/** Version drift per host. npm-managed hosts get a live `latest` lookup (network,
 *  cached by npm); external installs report installed-only (outdated=false, we
 *  don't own the update). Absent hosts report method 'absent'. */
export async function hostDrift() {
  const out = [];
  for (const h of HOSTS) {
    const st = await hostInstallState(h);
    if (st.method === 'absent') { out.push({ id: h.id, method: 'absent', installed: null, latest: null, outdated: false }); continue; }
    const latest = st.method === 'npm' ? await npmLatest(h.pkg) : null;
    const outdated = !!(latest && st.version && cmpVersions(latest, st.version) > 0);
    out.push({ id: h.id, method: st.method, installed: st.version, latest, outdated });
  }
  return out;
}

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
 *  seam as CLAUDE_FLOW_DB_PATH), else the user settings.json. */
export function settingsTarget(cwd = process.cwd()) {
  const inProject = fs.existsSync(path.join(cwd, '.git'));
  return inProject
    ? { file: paths.projectSettingsLocal(cwd), scope: 'project' }
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

// ── agentic-qe router config (.agentic-qe/llm-config.json) ──────────────────
// Grounded in aqe's router config-store + types (ADR-123):
//   - mergeRouterConfig deep-merges `providers` but SHALLOW-replaces
//     `fallbackChain` → ak must write a COMPLETE chain (these scalar defaults).
//   - the router iterates `entry.models` → each entry needs populated models.
//   - aqe refuses to persist apiKey → ak writes only `enabled` per provider;
//     keys stay in the env.
const AQE_CHAIN_DEFAULTS = { maxRetries: 3, retryDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 5000 };
const AQE_MANAGED_TAG = 'agentic-kit';

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

/** Write ak's managed router config: the ordered fallback chain + enabled set +
 *  default provider, merged into any existing llm-config.json (backup-first,
 *  never persisting apiKey). No-op unless a fallback chain is configured and we
 *  are in a project. Returns {ok, changed, detail}. */
export function applyAqeRouter(cfg, cwd = process.cwd()) {
  const chain = cfg.providers?.aqeFallback ?? [];
  if (chain.length === 0) return { ok: true, changed: false, detail: 'no aqe fallback chain configured' };
  if (!fs.existsSync(path.join(cwd, '.git'))) return { ok: true, changed: false, detail: 'not a project — aqe router unmanaged' };
  const valid = chain.filter((e) => e?.provider && AQE_PROVIDER_TYPES.includes(e.provider));
  if (valid.length === 0) return { ok: false, detail: 'no valid providers in fallback chain' };
  const file = aqeRouterFile(cwd);
  const existing = readJson(file, {}) ?? {};
  const next = { ...existing };
  next._managedBy = AQE_MANAGED_TAG;
  next.defaultProvider = cfg.providers.aqeProvider ?? valid[0].provider;
  next.providers = { ...(existing.providers ?? {}) };
  for (const e of valid) next.providers[e.provider] = { ...(existing.providers?.[e.provider] ?? {}), enabled: true };
  next.fallbackChain = buildChain(valid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonWithBackup(file, next);
  const emptyModels = valid.filter((e) => !e.models || e.models.length === 0).map((e) => e.provider);
  const warn = emptyModels.length ? ` (⚠ no models for: ${emptyModels.join(', ')})` : '';
  return { ok: true, changed: true, detail: `chain: ${valid.map((e) => e.provider).join(' → ')}${warn}` };
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
  if (!fs.existsSync(path.join(cwd, '.git'))) return { ok: true, changed: false, detail: 'not a project — skipped `ruflo init --dual`' };
  if (!(await have('ruflo'))) return { ok: false, detail: 'ruflo not on PATH' };
  // Prerequisite: dual-init aborts unless @claude-flow/codex is present. Install
  // it first (guarded on opted-in codex + detected CLI) so a fresh machine just works.
  const adapter = await ensureCodexAdapter(cfg, cwd);
  if (!adapter.ok) return { ok: false, changed: adapter.changed, detail: `adapter prerequisite failed: ${adapter.detail}` };
  const r = await run('ruflo', ['init', '--dual', '--force'], { cwd, timeout: 300_000 });
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
