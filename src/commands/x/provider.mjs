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
  undoProviders, hostInstallState, installHost, applyAqeRouter, undoAqeRouter,
} from '../../lib/providers.mjs';
import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import { ok, warn, fail, info, dim, bold } from '../../lib/output.mjs';

export const options = {
  host: { type: 'string' },          // csv: claude,codex (pick, non-interactive)
  'aqe-provider': { type: 'string' }, // one of AQE_PROVIDER_TYPES, or 'none' to unset
  'aqe-fallback': { type: 'string' }, // 'claude-code:model1,model2;openai:gpt-5.6'  ('none' clears)
  provider: { type: 'string' },      // csv of ruflo API providers, optional id:model (openai:gpt-5.6)
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

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
  --aqe-provider <type>        set aqe's primary LLM (or 'none' to unset)
  --aqe-fallback '<chain>'     ordered aqe chain, e.g.
                                 'claude-code:claude-opus-4-8; openai:gpt-5.6'
  --provider <csv>             register ruflo API providers (e.g. openai:gpt-5.6)
  --yes                        accept defaults without prompting

Examples:
  ak x provider                          show what's detected + wired
  ak x provider pick --host claude,codex
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
    console.log(`  ${h.id.padEnd(7)} ${(d.version ? `v${d.version}` : '—').padEnd(12)} ${state}`);
  }

  // agentic-qe LLM provider (AQE_LLM_PROVIDER) + fallback chain
  const ap = cfg.providers.aqeProvider;
  console.log(bold('\nagentic-qe LLM provider') + dim('  (AQE_LLM_PROVIDER)'));
  console.log(`  ${(ap ?? dim('aqe default (unset)')).padEnd(24)} ${dim(`supported: ${AQE_PROVIDER_TYPES.join(', ')}`)}`);
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

  const codexIdle = hosts.codex.present && !cfg.providers.hosts.codex;
  console.log('');
  if (codexIdle) info('codex is installed but disabled — enable it with: ak x provider pick');
  else ok('provider config reflects installed CLIs');
  return 0;
}

async function off({ cwd }) {
  const cfg = loadKitConfig();
  cfg.providers = { hosts: { claude: true, codex: false }, aqeProvider: null, aqeFallback: [], models: [], maxBudgetUsd: null };
  saveKitConfig(cfg);
  const env = undoProviders(cwd);
  const router = undoAqeRouter(cwd);
  ok(`reset to claude-only default — ${env.detail}; ${router.detail}`);
  return 0;
}

const parseModels = (csv) => csv.split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
  const [id, model] = tok.split(':');
  return model ? { id, model } : { id };
});

async function pick({ flags, cwd }) {
  const cfg = loadKitConfig();
  const hosts = await detectHosts(cwd);
  let enabled;
  let aqeProvider = cfg.providers.aqeProvider ?? null;
  let aqeFallback = cfg.providers.aqeFallback ?? [];
  let models = cfg.providers.models ?? [];

  const nonInteractive = flags.host !== undefined || flags['aqe-provider'] !== undefined
    || flags['aqe-fallback'] !== undefined || flags.provider !== undefined;
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
    const aAns = (await rl.question(`agentic-qe primary LLM provider — ${AQE_PROVIDER_TYPES.join('/')} (blank = leave aqe default): `)).trim().toLowerCase();
    aqeProvider = aAns ? aAns : null;
    const fAns = (await rl.question('aqe fallback chain, ordered (e.g. "claude-code:claude-opus-4-8; openai:gpt-5.6", blank = none): ')).trim().toLowerCase();
    aqeFallback = fAns ? parseFallback(fAns) : [];
    const provAns = (await rl.question('ruflo API-key providers to register (e.g. openai:gpt-5.6, blank to skip): ')).trim();
    if (provAns) models = parseModels(provAns);
    rl.close();
  }

  // validate hosts
  const known = new Set(HOSTS.map((h) => h.id));
  enabled = enabled.filter((h) => known.has(h));
  if (!enabled.includes('claude') && !enabled.includes('codex')) enabled = ['claude'];
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
    maxBudgetUsd: cfg.providers.maxBudgetUsd ?? null,
  };
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
  if (aqeProvider) ok(`aqe provider: AQE_LLM_PROVIDER=${aqeProvider}`);
  const router = applyAqeRouter(cfg, cwd);
  if (router.changed || !router.ok) (router.ok ? ok : warn)(`aqe router: ${router.detail}`);
  const dual = await ensureDualAgents(cfg, cwd);
  (dual.ok ? (dual.changed ? ok : info) : warn)(`dual agents: ${dual.detail}`);
  const prov = await applyProviders(cfg, cwd);
  (prov.ok ? (prov.changed ? ok : info) : warn)(`ruflo providers: ${prov.detail}`);
  ok('saved to kit.json — reapplied on every `ak sync`; undo with `ak x provider off`');
  return 0;
}
