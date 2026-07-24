// x provider — frontier-host + LLM-provider detection and wiring.
//   status (default) : detected CLIs, aqe provider, ruflo providers, what's wired
//   pick             : choose enabled hosts / aqe provider / ruflo providers → persist → apply
//   off              : reversible teardown (strip managed env keys)
// Mirrors `ak x mcp`: detect → persist to kit.json → idempotent heal.
// Two independent axes: ruflo host CLIs (claude/codex) and the LLM the routers use.
import readline from 'node:readline/promises';
import {
  HOSTS, API_PROVIDERS, AQE_PROVIDER_TYPES, detectHosts, detectProviders,
  settingsTarget, isDefault, applyHosts, applyProviders, ensureDualAgents,
  undoProviders, hostInstallState, hostAuthState, installHost, applyAqeRouter, undoAqeRouter,
  bothHostsEnabled, DUAL_ROLE_TIP, JUDGE_BIAS_TIP, QE_COURT_TIP, suggestedFallbackFor,
  seedDualRoutingIfDualHost, printActivityRoutingTable, ensureCodexMcp, undoCodexMcp,
  ensureRufloMcpInCodex, undoRufloMcpInCodex,
} from '../../lib/providers.mjs';
import { parseRouteSpecs, formatModelHelp, PRIMARY_HOSTS, DEFAULT_PRIMARY_HOST } from '../../lib/routing.mjs';
import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import { ok, warn, fail, info, dim, bold } from '../../lib/output.mjs';
import { installedVersion, cmpVersions } from '../../lib/versions.mjs';
import { repoRoot } from '../../lib/paths.mjs';
import { writeJsonWithBackup } from '../../lib/settings.mjs';
import { panelFromRouting, validatePanel, readQeCourtConfig, qeCourtConfigPath, vendorOf } from '../../lib/qeCourt.mjs';

const QE_COURT_MIN_VERSION = '3.13.0';
const qeCourtShipped = () => {
  const v = installedVersion('agentic-qe');
  return !!v && cmpVersions(v, QE_COURT_MIN_VERSION) >= 0;
};

/** Print the dual-host guidance tips (role delegation, judge-bias, qe-court
 *  cross-sell) once both hosts are enabled — shared by `pick()` and
 *  `status()` so the strings/gating never drift between the two. */
function printDualHostTips(cfg) {
  if (!bothHostsEnabled(cfg)) return;
  info(DUAL_ROLE_TIP);
  info(JUDGE_BIAS_TIP);
  if (qeCourtShipped()) info(QE_COURT_TIP);
}

export const options = {
  host: { type: 'string' },          // csv: claude,codex (pick, non-interactive)
  'primary-host': { type: 'string' }, // claude|codex — which host leads (default claude)
  'aqe-provider': { type: 'string' }, // one of AQE_PROVIDER_TYPES, or 'none' to unset
  'aqe-fallback': { type: 'string' }, // 'claude-code:model1,model2;openai:gpt-5.6'  ('none' clears)
  provider: { type: 'string' },      // csv of ruflo API providers, optional id:model (openai:gpt-5.6)
  route: { type: 'string', multiple: true }, // repeatable: 'activity:host[:model]' per-activity routing override
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

/** Billing is the non-obvious axis of the aqe provider list. Three categories,
 *  and claude-code is the ONLY same-vendor subscription alternative to a metered
 *  key (codex/gemini OAuth live on the host axis, not as aqe provider types). */
export const AQE_BILLING_HINT = 'billing: claude-code = your Claude subscription ($0), ollama/onnx = local ($0), all others = metered API key';

export const help = `ak x provider — frontier-host + LLM-provider detection and wiring

Two independent axes: which host CLI runs the ruflo loop (claude/codex, can be
both), and which LLM the routers use (aqe + ruflo). Mirrors \`ak x mcp\`: detect →
persist to kit.json → idempotent heal. \`ak sync\` reapplies your choice.

Subcommands:
  status   (default) detected CLIs, aqe provider, ruflo providers, what's wired
  pick     choose hosts / aqe provider / ruflo providers → persist → apply
  off      reversible teardown (reset to claude-only; strip managed env keys)

Options (pick, all optional — omit for interactive):
  --host claude,codex          enable these ruflo host CLIs
  --primary-host claude|codex  which host leads (default claude); codex-primary
                                 mirrors the routing defaults so codex drives and
                                 claude is the alternate
  --aqe-provider <type>        set aqe's primary LLM (or 'none' to unset)
                                 billing: claude-code = Claude sub ($0),
                                 ollama/onnx = local ($0), all others = metered key
  --aqe-fallback '<chain>'     ordered aqe chain, e.g.
                                 'claude-code:claude-opus-4-8; openai:gpt-5.6'
                                 (metered providers work too, e.g. add
                                 'openrouter:z-ai/glm-5.2' — GLM via OpenRouter,
                                 needs OPENROUTER_API_KEY in the env)
  --provider <csv>             register ruflo API providers (e.g. openai:gpt-5.6)
  --route 'act:host[:model]'   override one activity's routing (repeatable), e.g.
                                 --route 'implementation:claude:claude-opus-4-8'
                                 activities: specification, architecture, design,
                                 implementation, testing, review, security-scan,
                                 security-analysis, documentation, debugging,
                                 packaging, release
  --yes                        accept defaults without prompting

When both claude and codex hosts are enabled (and aqe ≥ 3.13.1), ak seeds a
per-activity routing policy from sensible defaults and materializes it into
.agentic-qe/llm-config.json (agentOverrides). Override any activity with --route;
your edits are preserved across syncs. ${formatModelHelp()}

Examples:
  ak x provider                          show what's detected + wired + routing
  ak x provider pick --host claude,codex
  ak x provider pick --route 'testing:claude:claude-sonnet-5'
  ak x provider off`;

/** Parse 'claude-code:m1,m2; openai:gpt-5.6' → [{provider, models:[…]}, …]. */
const parseFallback = (str) => str.split(';').map((s) => s.trim()).filter(Boolean).map((tok) => {
  const [provider, models] = tok.split(':');
  return { provider: provider.trim().toLowerCase(), models: (models ?? '').split(',').map((m) => m.trim()).filter(Boolean) };
});

export async function run({ flags, positionals }) {
  const sub = positionals[0] ?? 'status';
  const cwd = process.cwd();

  if (sub === 'status') return status({ flags, cwd });
  if (sub === 'off') return off({ cwd });
  if (sub === 'pick') return pick({ flags, cwd });

  fail(`unknown provider subcommand: ${sub} (status|pick|off)`);
  return 2;
}

async function status({ flags, cwd }) {
  const cfg = loadKitConfig();
  const hosts = await detectHosts(cwd);
  const providers = detectProviders();
  const { scope } = settingsTarget(cwd);

  if (flags.json) {
    console.log(JSON.stringify({ scope, config: cfg.providers, hosts, providers }, null, 2));
    return 0;
  }

  const dflt = isDefault(cfg);
  console.log(bold('ruflo agent hosts') + dim(`  (wiring scope: ${scope})`));
  for (const h of HOSTS) {
    const d = hosts[h.id];
    const enabled = !!cfg.providers.hosts[h.id];
    const state = !d.present ? dim('not installed')
      : !enabled ? 'installed, disabled'
      : dflt ? 'enabled (default — ruflo default-on, no env written)'
      : d.wired ? 'enabled, wired'
      : 'enabled, not wired → ak sync';
    // auth/billing axis — subscription ($0) vs metered key, per host.
    const auth = d.present ? hostAuthState(h.id, { present: true }) : null;
    const authStr = auth ? dim(`  ${auth.mode}/${auth.billing === 'subscription' ? '$0' : auth.billing}`) : '';
    console.log(`  ${h.id.padEnd(7)} ${(d.version ? `v${d.version}` : '—').padEnd(12)} ${state}${authStr}`);
  }

  // agentic-qe LLM provider (AQE_LLM_PROVIDER) + fallback chain
  const ap = cfg.providers.aqeProvider;
  console.log(bold('\nagentic-qe LLM provider') + dim('  (AQE_LLM_PROVIDER)'));
  console.log(`  ${(ap ?? dim('aqe default (unset)')).padEnd(24)} ${dim(`supported: ${AQE_PROVIDER_TYPES.join(', ')}`)}`);
  console.log(`  ${dim(AQE_BILLING_HINT)}`);
  const chain = cfg.providers.aqeFallback ?? [];
  if (chain.length) {
    const rendered = chain.map((e) => `${e.provider}${e.models?.length ? `(${e.models.join(',')})` : dim('(no models)')}`).join(' → ');
    console.log(`  ${dim('fallback chain:')} ${rendered} ${dim('· .agentic-qe/llm-config.json')}`);
  } else {
    console.log(`  ${dim('fallback chain: none (aqe auto-enables keyed providers)')}`);
  }

  const cm = cfg.providers.models ?? [];
  console.log(bold('\nruflo LLM API providers') + dim('  (ruflo router; keys read from env)'));
  for (const p of API_PROVIDERS) {
    const cfgEntry = cm.find((m) => m.id === p.id);
    const key = p.keyEnv.length ? (providers[p.id].keyPresent ? 'key present' : 'no key') : 'local';
    const conf = cfgEntry ? `configured${cfgEntry.model ? ` (${cfgEntry.model})` : ''}` : dim('not configured');
    console.log(`  ${p.id.padEnd(10)} ${key.padEnd(12)} ${conf}`);
  }

  printActivityRoutingTable(cfg);
  printQeCourtStatus(cwd);

  const codexIdle = hosts.codex.present && !cfg.providers.hosts.codex;
  console.log('');
  if (codexIdle) info('codex is installed but disabled — enable it with: ak x provider pick');
  else ok('provider config reflects installed CLIs');
  printDualHostTips(cfg);
  return 0;
}

/** Read-only awareness of qe-court's per-role routing (ADR-124, aqe >= 3.13.0)
 *  — a third config surface alongside ruflo host env + aqe's fallback chain.
 *  No-op unless aqe is new enough AND the skill has already created its
 *  config.json (ak never creates it). */
function printQeCourtStatus(cwd) {
  if (!qeCourtShipped()) return;
  const root = repoRoot(cwd);
  if (!root) return;
  const qc = readQeCourtConfig(root);
  if (!qc) return;
  const panel = panelFromRouting(qc.routing);
  const minVendors = qc.options?.minDistinctVendors ?? 2;
  const violations = validatePanel(panel, { minVendors });
  console.log(bold('\nqe-court routing') + dim('  (.claude/skills/qe-court/config.json)'));
  for (const { role, provider } of panel) {
    console.log(`  ${role.padEnd(28)} ${provider ?? dim('(unset)')}`);
  }
  if (violations.length) warn(`qe-court panel invalid: ${violations.join(', ')}`);
  else ok('qe-court panel valid (vendor-diverse, jury independent of writer)');
}

async function off({ cwd }) {
  const cfg = loadKitConfig();
  const codexMcpManaged = cfg.providers?.codexMcp === 'ak';
  const rufloCodexManaged = cfg.providers?.rufloCodexMcp === 'ak';
  cfg.providers = { hosts: { claude: true, codex: false }, primaryHost: 'claude', aqeProvider: null, aqeFallback: [], models: [], maxBudgetUsd: null, dualRouting: {}, codexMcp: null, rufloCodexMcp: null };
  saveKitConfig(cfg);
  const env = undoProviders(cwd);
  const router = undoAqeRouter(cwd);
  const mcp = await undoCodexMcp(cwd, { managed: codexMcpManaged });
  const rmcp = await undoRufloMcpInCodex(cwd, { managed: rufloCodexManaged });
  ok(`reset to claude-only default — ${env.detail}; ${router.detail}; ${mcp.detail}; ${rmcp.detail}`);
  return 0;
}

const parseModels = (csv) => csv.split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
  const [id, model] = tok.split(':');
  return model ? { id, model } : { id };
});

/** Opt-in write of qe-court routing defaults (Phase C, issue #36). Only offers
 *  when: interactive session, aqe >= 3.13.0, the skill has already created its
 *  config.json (ak never creates it), and an aqeProvider was chosen. Defaults
 *  prosecutor.codex-review/deeperReviewer -> codex when codex is enabled, and
 *  jury -> aqeProvider (picking a different vendor if it would collide with
 *  the writer/defense). Validates the resulting panel BEFORE writing — never
 *  produces an invalid panel on disk. Only ever touches the `routing` key. */
async function maybeWriteQeCourtDefaults({ nonInteractive, cwd, enabled, aqeProvider }) {
  if (nonInteractive || !aqeProvider) return;
  if (!qeCourtShipped()) return;
  const root = repoRoot(cwd);
  if (!root) return;
  const qc = readQeCourtConfig(root);
  if (!qc) return;

  const codexOn = enabled.includes('codex');
  const routing = { ...(qc.routing ?? {}) };
  const defenseProvider = routing.defense?.provider;
  let juryProvider = aqeProvider;
  let juryNote = '';
  if (defenseProvider && vendorOf(juryProvider) === vendorOf(defenseProvider)) {
    const alt = AQE_PROVIDER_TYPES.find((p) => vendorOf(p) !== vendorOf(defenseProvider) && p !== juryProvider);
    if (alt) { juryNote = ` (switched from ${juryProvider} — same vendor as defense/writer)`; juryProvider = alt; }
  }

  const changes = codexOn ? [['prosecutor.codex-review', 'codex'], ['deeperReviewer', 'codex'], ['jury', juryProvider]]
    : [['jury', juryProvider]];

  console.log(bold('\nqe-court detected') + dim('  (.claude/skills/qe-court/config.json)'));
  console.log(dim(`  would set: ${changes.map(([role, p]) => `${role} → ${p}`).join(', ')}${juryNote}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('apply these qe-court routing defaults? [y/N]: ')).trim().toLowerCase();
  rl.close();
  if (ans !== 'y' && ans !== 'yes') { info('qe-court routing left unchanged'); return; }

  for (const [role, provider] of changes) routing[role] = { ...(routing[role] ?? {}), provider };
  const violations = validatePanel(panelFromRouting(routing), { minVendors: qc.options?.minDistinctVendors ?? 2 });
  if (violations.length) { warn(`qe-court routing defaults would be invalid (${violations.join(', ')}) — not written`); return; }

  writeJsonWithBackup(qeCourtConfigPath(root), { ...qc, routing });
  ok(`qe-court routing updated: ${changes.map(([role, p]) => `${role}→${p}`).join(', ')}`);
}

async function pick({ flags, cwd }) {
  const cfg = loadKitConfig();
  const hosts = await detectHosts(cwd);
  let enabled;
  let aqeProvider = cfg.providers.aqeProvider ?? null;
  let aqeFallback = cfg.providers.aqeFallback ?? [];
  let models = cfg.providers.models ?? [];
  const prevPrimary = cfg.providers.primaryHost ?? DEFAULT_PRIMARY_HOST;
  const oldPolicy = cfg.providers.dualRouting ?? {};

  const nonInteractive = flags.host !== undefined || flags['aqe-provider'] !== undefined
    || flags['aqe-fallback'] !== undefined || flags.provider !== undefined
    || flags['primary-host'] !== undefined;
  if (nonInteractive) {
    enabled = flags.host !== undefined
      ? flags.host.split(',').map((s) => s.trim()).filter(Boolean)
      : Object.entries(cfg.providers.hosts).filter(([, v]) => v).map(([k]) => k);
    if (flags['aqe-provider'] !== undefined) {
      const v = flags['aqe-provider'].trim().toLowerCase();
      aqeProvider = (v === 'none' || v === '') ? null : v;
    }
    if (flags['aqe-fallback'] !== undefined) {
      const v = flags['aqe-fallback'].trim().toLowerCase();
      aqeFallback = (v === 'none' || v === '') ? [] : parseFallback(v);
    }
    if (flags.provider !== undefined) models = parseModels(flags.provider);
  } else {
    const installed = HOSTS.filter((h) => hosts[h.id].present).map((h) => h.id);
    if (installed.length === 0) { fail('no frontier CLI (claude/codex) found on PATH'); return 1; }
    console.log(`Installed hosts: ${installed.join(', ')}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const hAns = (await rl.question(`Enable which ruflo host(s)? (comma-separated) [${installed.join(',')}]: `)).trim();
    enabled = (hAns || installed.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    console.log(dim(`  ${AQE_BILLING_HINT}`));
    const aAns = (await rl.question(`agentic-qe primary LLM provider — ${AQE_PROVIDER_TYPES.join('/')} (blank = leave aqe default): `)).trim().toLowerCase();
    aqeProvider = aAns ? aAns : null;
    const suggestion = suggestedFallbackFor(enabled);
    const fAns = (await rl.question(
      `aqe fallback chain, ordered (e.g. "claude-code:claude-opus-4-8; openai:gpt-5.6"${suggestion ? `, blank = use suggested [${suggestion}]` : ', blank = none'}): `,
    )).trim().toLowerCase();
    aqeFallback = fAns ? parseFallback(fAns) : (suggestion ? parseFallback(suggestion.toLowerCase()) : []);
    const provAns = (await rl.question('ruflo API-key providers to register (e.g. openai:gpt-5.6, blank to skip): ')).trim();
    if (provAns) models = parseModels(provAns);
    rl.close();
  }

  // validate hosts
  const known = new Set(HOSTS.map((h) => h.id));
  enabled = enabled.filter((h) => known.has(h));
  if (!enabled.includes('claude') && !enabled.includes('codex')) enabled = ['claude'];
  // primary host — which host leads (default claude); must be an enabled host.
  let primaryHost = prevPrimary;
  if (flags['primary-host'] !== undefined) {
    const v = flags['primary-host'].trim().toLowerCase();
    if (PRIMARY_HOSTS.includes(v)) primaryHost = v;
    else warn(`unknown primary host '${v}' (valid: ${PRIMARY_HOSTS.join('|')}) — keeping ${primaryHost}`);
  }
  if (!enabled.includes(primaryHost)) primaryHost = enabled[0] ?? DEFAULT_PRIMARY_HOST;
  // re-seed when the primary changed AND the current policy is entirely seeded
  // (no user overrides to preserve) — so mirrored defaults reflect the new primary.
  const policyAllSeeded = Object.keys(oldPolicy).length > 0 && Object.values(oldPolicy).every((r) => r.source === 'seeded');
  const reseedForPrimary = primaryHost !== prevPrimary && policyAllSeeded;
  // validate aqe primary provider
  if (aqeProvider && !AQE_PROVIDER_TYPES.includes(aqeProvider)) {
    const norm = aqeProvider === 'anthropic' ? 'claude' : aqeProvider;
    if (AQE_PROVIDER_TYPES.includes(norm)) aqeProvider = norm;
    else { warn(`unknown aqe provider '${aqeProvider}' — leaving aqe on its default (valid: ${AQE_PROVIDER_TYPES.join(', ')})`); aqeProvider = null; }
  }
  // validate fallback chain providers
  aqeFallback = aqeFallback
    .map((e) => ({ ...e, provider: e.provider === 'anthropic' ? 'claude' : e.provider }))
    .filter((e) => {
      const okp = AQE_PROVIDER_TYPES.includes(e.provider);
      if (!okp) warn(`dropping unknown fallback provider '${e.provider}'`);
      else if (!e.models.length) warn(`fallback entry '${e.provider}' has no models — aqe may skip it; add e.g. ${e.provider}:<model-id>`);
      return okp;
    });

  cfg.providers = {
    hosts: { claude: enabled.includes('claude'), codex: enabled.includes('codex') },
    aqeProvider,
    aqeFallback,
    models,
    primaryHost,
    maxBudgetUsd: cfg.providers.maxBudgetUsd ?? null,
    dualRouting: reseedForPrimary ? {} : { ...oldPolicy },
  };
  // dual-host: seed per-activity routing from defaults (only when the policy is
  // empty), then layer any explicit --route overrides on top (marked user, never
  // re-seeded). Single-host / older aqe → no-op, policy stays empty (ADR-0003).
  const seed = seedDualRoutingIfDualHost(cfg);
  if (flags.route?.length) {
    const { policy, warnings } = parseRouteSpecs(flags.route);
    for (const w of warnings) warn(w);
    cfg.providers.dualRouting = { ...cfg.providers.dualRouting, ...policy };
  }
  saveKitConfig(cfg);

  // install any enabled host that is entirely absent (external installs untouched)
  for (const h of HOSTS) {
    if (!cfg.providers.hosts[h.id]) continue;
    if ((await hostInstallState(h)).method !== 'absent') continue;
    info(`${h.id} not installed — installing ${h.pkg}…`);
    const r = await installHost(h.id);
    (r.ok ? ok : warn)(`${h.id}: ${r.detail}`);
  }

  const h = applyHosts(cfg, cwd);
  (h.ok ? ok : fail)(`hosts: ${h.detail}`);
  if (primaryHost !== DEFAULT_PRIMARY_HOST) {
    const alt = enabled.filter((e) => e !== primaryHost).join(', ') || 'none';
    ok(`primary host: ${primaryHost} (alternate: ${alt})`);
  }
  if (aqeProvider) ok(`aqe provider: AQE_LLM_PROVIDER=${aqeProvider}`);
  const router = applyAqeRouter(cfg, cwd);
  if (router.changed || !router.ok) (router.ok ? ok : warn)(`aqe router: ${router.detail}`);
  const dual = await ensureDualAgents(cfg, cwd);
  (dual.ok ? (dual.changed ? ok : info) : warn)(`dual agents: ${dual.detail}`);
  const mcp = await ensureCodexMcp(cfg, cwd);
  if (mcp.changed) saveKitConfig(cfg); // persist the codexMcp ownership marker
  if (mcp.changed || !mcp.ok) (mcp.ok ? ok : warn)(`codex MCP: ${mcp.detail}`);
  // reverse bridge — register ruflo MCP into codex (codex→ruflo) so the bridge is
  // two-way. aqe's codex MCP is handled by `aqe init --with-codex` (setup runs it).
  const rmcp = await ensureRufloMcpInCodex(cfg, cwd);
  if (rmcp.changed) saveKitConfig(cfg); // persist the rufloCodexMcp ownership marker
  if (rmcp.changed || !rmcp.ok) (rmcp.ok ? ok : warn)(`ruflo→codex MCP: ${rmcp.detail}`);
  const prov = await applyProviders(cfg, cwd);
  (prov.ok ? (prov.changed ? ok : info) : warn)(`ruflo providers: ${prov.detail}`);
  ok('saved to kit.json — reapplied on every `ak sync`; undo with `ak x provider off`');
  if (seed.seeded) ok(`per-activity routing seeded — ${seed.count} activities (dual-host defaults; tune with --route or edit kit.json)`);
  printActivityRoutingTable(cfg);
  await maybeWriteQeCourtDefaults({ nonInteractive, cwd, enabled, aqeProvider });
  printDualHostTips(cfg);
  return 0;
}
