// x provider — frontier-host + LLM-provider detection and wiring.
//   status (default) : detected CLIs, aqe provider, ruflo providers, what's wired
//   pick             : choose enabled hosts / aqe provider / ruflo providers → persist → apply
//   off              : reversible teardown (strip managed env keys)
// Mirrors `ak x mcp`: detect → persist to kit.json → idempotent heal.
// Two independent axes: ruflo host CLIs (claude/codex) and the LLM the routers use.
import readline from 'node:readline/promises';
import {
  HOSTS, API_PROVIDERS, AQE_PROVIDER_TYPES, detectHosts,
  settingsTarget, isDefault, applyHosts, applyProviders, ensureDualAgents,
  undoProviders, hostInstallState, hostAuthState, installHost, applyAqeRouter, undoAqeRouter,
  bothHostsEnabled, DUAL_ROLE_TIP, JUDGE_BIAS_TIP, QE_COURT_TIP, suggestedFallbackFor,
  seedDualRoutingIfDualHost, printActivityRoutingTable, ensureCodexMcp, undoCodexMcp,
  ensureRufloMcpInCodex, undoRufloMcpInCodex, detectAqeProviders, aqeProviderCredential, credentialGaps, fallbackSource,
  collectIntegrationFacts,
} from '../../lib/providers.mjs';
import { parseRouteSpecs, formatModelHelp, PRIMARY_HOSTS, DEFAULT_PRIMARY_HOST, divergedRoutes, refreshSeededRoutes, pruneRoutesForHosts, modelNote, ACTIVITIES } from '../../lib/routing.mjs';
import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import { OPENCODE_LIFECYCLE_ADAPTER, reconcileOpencodeGuidance } from '../../lib/opencode.mjs';
import { runLifecycle } from '../../lib/adapters/lifecycle.mjs';
import { routableHostIds } from '../../lib/adapters/index.mjs';
import { have } from '../../lib/exec.mjs';
import { ok, warn, fail, info, dim, bold, yellow } from '../../lib/output.mjs';
import { repoRoot } from '../../lib/paths.mjs';
import { writeJsonWithBackup } from '../../lib/settings.mjs';
import { panelFromRouting, validateCourtConfig, readQeCourtConfig, qeCourtConfigPath, vendorOf, qeCourtShipped } from '../../lib/qeCourt.mjs';

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
  activity: { type: 'string' },      // refresh: csv of activities to re-seed (default = prompt)
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

/** Billing is the non-obvious axis of the aqe provider list. Three categories,
 *  and claude-code is the ONLY same-vendor subscription alternative to a metered
 *  key (codex/gemini OAuth live on the host axis, not as aqe provider types). */
export const AQE_BILLING_HINT = 'billing: claude-code = your Claude subscription ($0), ollama/onnx = local ($0), all others = metered API key';

export const help = `ak host — frontier-host + LLM-provider detection and wiring

Two independent axes: which host CLIs run the ruflo loop, and which LLM the
routers use (aqe + ruflo). Mirrors \`ak x mcp\`: detect → persist to kit.json →
idempotent heal. \`ak sync\` reapplies your choice.

Host model — three managed hosts, all eligible for explicit activity routing:
  claude, codex   routing hosts: env-wired, one is primary, dual-host seeds the
                  per-activity routing policy (they drive QE work)
  opencode        config-file wiring (opencode.json
                  MCP + skills + permissions), lifecycle plugin, converted ruflo
                  agents, platform skill — routable through ak run, never primary,
                  never an aqe provider
\`pick\` manages ALL THREE: enable/disable opencode here exactly like claude/codex.

Subcommands:
  status   (default) detected CLIs, aqe provider, ruflo providers, what's wired
  pick     choose hosts / aqe provider / ruflo providers → persist → apply
  refresh  re-seed routes whose seeded pin diverges from the current defaults
             (per-activity, opt-in; user pins are never touched, and \`ak sync\`
             never does this for you)
  off      reversible teardown (reset to claude-only; strip managed env keys)

Options (pick, all optional — omit for interactive):
  --host <csv>                 the complete desired enabled-host set, e.g.
                                 claude,codex or claude,opencode (opencode is
                                 wired + guided; excluding an
                                 enabled host here DISABLES it — ak-managed
                                 wiring is stripped, user config preserved)
  --primary-host claude|codex  which host leads (default claude; routing hosts
                                 only); codex-primary mirrors the routing
                                 defaults so codex drives and claude is the
                                 alternate
  --aqe-provider <type>        set aqe's primary LLM (or 'none' to unset)
                                 billing: claude-code = Claude sub ($0),
                                 ollama/onnx = local ($0), all others = metered key
  --aqe-fallback '<chain>'     ordered aqe chain, e.g.
                                 'claude-code:claude-opus-5; openai:gpt-5.6'
                                 (metered providers work too, e.g. add
                                 'openrouter:z-ai/glm-5.2' — GLM via OpenRouter,
                                 needs OPENROUTER_API_KEY in the env)
  --provider <csv>             register ruflo API providers (e.g. openai:gpt-5.6)
  --route 'act:host[:model]'   override one activity's routing (repeatable), e.g.
                                 --route 'implementation:claude:claude-opus-5'
                                 activities: specification, architecture, design,
                                 implementation, testing, review, security-scan,
                                 security-analysis, documentation, debugging,
                                 packaging, release
  --activity <csv>             refresh: which activities to re-seed (default: prompt)
  --yes                        accept defaults without prompting

When both claude and codex hosts are enabled (and aqe ≥ 3.13.1), ak seeds a
per-activity routing policy from sensible defaults and materializes it into
.agentic-qe/llm-config.json (agentOverrides). Override any activity with --route;
your edits are preserved across syncs. ${formatModelHelp()}

Examples:
  ak host                          show what's detected + wired + routing
  ak host pick --host claude,codex
  ak host pick --host claude,opencode
  ak host pick --host claude,codex,opencode
  ak host pick --host claude       disable codex + opencode; preserve user config
  ak host pick --route 'testing:claude:claude-sonnet-5'
  ak host refresh --activity architecture,design
  ak host off`;

/** Stamp provenance onto chain entries. 'suggested' = ak proposed it and the
 *  user pressed enter; 'user' = they typed it. Only 'suggested' entries are
 *  eligible for an offered refresh — a typed pin is intent (#55). */
const stamp = (source) => (entries) => entries.map((e) => ({ ...e, source }));

/** Parse 'claude-code:m1,m2; openai:gpt-5.6' → [{provider, models:[…]}, …]. */
const parseFallback = (str) => str.split(';').map((s) => s.trim()).filter(Boolean).map((tok) => {
  const [provider, models] = tok.split(':');
  return { provider: provider.trim().toLowerCase(), models: (models ?? '').split(',').map((m) => m.trim()).filter(Boolean) };
});

export async function run({ flags, positionals, pkgRoot }) {
  const sub = positionals[0] ?? 'status';
  const cwd = process.cwd();

  if (sub === 'status') return status({ flags, cwd });
  if (sub === 'off') return off({ cwd, pkgRoot });
  if (sub === 'pick') return pick({ flags, cwd, pkgRoot });
  if (sub === 'refresh') return refresh({ flags, cwd });

  fail(`unknown provider subcommand: ${sub} (status|pick|refresh|off)`);
  return 2;
}

async function status({ flags, cwd }) {
  const cfg = loadKitConfig();
  const facts = await collectIntegrationFacts({ cwd, cfg });
  const hosts = facts.hosts;
  const providers = facts.providers;
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
    const tier = h.id === 'opencode' ? dim('  · routing host (ak run; never primary/AQE)')
      : dim('  · routing host');
    // auth/billing axis — subscription ($0) vs metered key, per host.
    const auth = d.present ? hostAuthState(h.id, { present: true }) : null;
    const authStr = auth ? dim(`  ${auth.mode}/${auth.billing === 'subscription' ? '$0' : auth.billing}`) : '';
    console.log(`  ${h.id.padEnd(9)} ${(d.version ? `v${d.version}` : '—').padEnd(12)} ${state}${authStr}${tier}`);
  }

  // agentic-qe LLM provider (AQE_LLM_PROVIDER) + fallback chain
  const ap = cfg.providers.aqeProvider;
  console.log(bold('\nagentic-qe LLM provider') + dim('  (AQE_LLM_PROVIDER)'));
  console.log(`  ${(ap ?? dim('aqe default (unset)')).padEnd(24)} ${dim(`supported: ${AQE_PROVIDER_TYPES.join(', ')}`)}`);
  console.log(`  ${dim(AQE_BILLING_HINT)}`);
  const chain = cfg.providers.aqeFallback ?? [];
  if (chain.length) {
    const rendered = chain.map((e) => {
      const cred = aqeProviderCredential(e.provider);
      const models = e.models?.length ? `(${e.models.join(',')})` : dim('(no models)');
      return `${e.provider}${models}${cred.present ? '' : yellow(' ⚠ no credential')}`;
    }).join(' → ');
    console.log(`  ${dim('fallback chain:')} ${rendered} ${dim('· .agentic-qe/llm-config.json')}`);
    for (const g of credentialGaps(chain)) {
      warn(`fallback rung '${g.provider}' has no credential — needs ${g.missing.join(', ')} in the env; it will fail over into nothing`);
    }
  } else {
    console.log(`  ${dim('fallback chain: none (aqe auto-enables keyed providers)')}`);
  }

  // Credential state for EVERY aqe provider type, so a provider that is
  // credentialed on this machine (openrouter, say) is never invisible while an
  // uncredentialed one is displayed as a configured fallback (#54).
  const creds = detectAqeProviders();
  console.log(bold('\naqe provider credentials') + dim('  (keys read from env; never persisted)'));
  for (const p of AQE_PROVIDER_TYPES) {
    const c = creds[p];
    const state = c.present ? (c.billing === 'local' ? 'local' : c.billing === 'subscription' ? 'subscription' : 'key present')
      : `no key ${dim(`(${c.missing.join(', ')})`)}`;
    console.log(`  ${p.padEnd(14)} ${state}${c.source && c.present && c.billing === 'metered' ? dim(`  · ${c.source}`) : ''}`);
  }

  const cm = cfg.providers.models ?? [];
  console.log(bold('\nruflo LLM API providers') + dim('  (ruflo router; keys read from env)'));
  for (const p of API_PROVIDERS) {
    const cfgEntry = cm.find((m) => m.id === p.id);
    const key = p.keyEnv.length
      ? (providers[p.id]?.credentialPresent ? 'key present' : 'no key') : 'local';
    const conf = cfgEntry ? `configured${cfgEntry.model ? ` (${cfgEntry.model})` : ''}` : dim('not configured');
    console.log(`  ${p.id.padEnd(10)} ${key.padEnd(12)} ${conf}`);
  }

  printActivityRoutingTable(cfg);
  printQeCourtStatus(cwd);

  const codexIdle = hosts.codex.present && !cfg.providers.hosts.codex;
  const ocIdle = hosts.opencode.present && !cfg.providers.hosts.opencode;
  console.log('');
  if (codexIdle) info('codex is installed but disabled — enable it with: ak host pick');
  if (ocIdle) info('opencode is installed but disabled — enable it with: ak host pick --host claude,opencode');
  if (!codexIdle && !ocIdle) ok('host/provider config reflects installed CLIs');
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
  const violations = validateCourtConfig(qc);
  console.log(bold('\nqe-court routing') + dim('  (.claude/skills/qe-court/config.json)'));
  for (const { role, provider } of panel) {
    console.log(`  ${role.padEnd(28)} ${provider ?? dim('(unset)')}`);
  }
  if (violations.length) warn(`qe-court panel invalid: ${violations.join(', ')}`);
  else ok('qe-court panel valid (vendor-diverse, jury independent of writer)');
}

/** Opt-in, per-activity re-seed of routes whose seeded pin diverges from the
 *  current defaults. Deliberately a separate command, never part of `ak sync`:
 *  sync is documented as idempotent reapplication of persisted choice, and the
 *  newer default is not uniformly better — on routine work it can cost 2-3× the
 *  agentic turns for the same result (#55). Only `source: 'seeded'` entries are
 *  eligible; a user pin survives even when named. */
async function refresh({ flags, cwd }) {
  const cfg = loadKitConfig();
  const policy = cfg.providers?.dualRouting ?? {};
  const diverged = divergedRoutes(policy);
  if (!diverged.length) { ok('no seeded routes diverge from the current defaults'); return 0; }

  console.log(bold('seeded routes that diverge from current defaults'));
  for (const d of diverged) {
    const head = d.modelDiverged ? `${d.model} → ${d.defaultModel}` : d.model;
    console.log(`  ${d.activity.padEnd(18)} ${d.host.padEnd(7)} ${head}`);
    for (const e of d.escalate) console.log(`    ${dim('escalation:')} ${e.model} → ${e.defaultModel}`);
    // The trade, not just the ids: choosing on a price axis while paying on a
    // turns axis is the misreading this whole surface exists to prevent.
    if (d.modelDiverged && d.currentNote) console.log(dim(`    now:     ${d.model} — ${d.currentNote}`));
    if (d.modelDiverged && d.defaultNote) console.log(dim(`    default: ${d.defaultModel} — ${d.defaultNote}`));
    for (const e of d.escalate) {
      const note = modelNote(e.defaultModel);
      if (note) console.log(dim(`    default: ${e.defaultModel} — ${note}`));
    }
  }

  let picked;
  if (flags.activity !== undefined) {
    const want = flags.activity.split(',').map((s) => s.trim()).filter(Boolean);
    for (const a of want.filter((a) => !ACTIVITIES.includes(a))) warn(`unknown activity '${a}' — ignored`);
    picked = want.filter((a) => diverged.some((d) => d.activity === a));
  } else if (flags.yes) {
    picked = diverged.map((d) => d.activity);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`refresh which activities? (comma-separated, "all", blank = none) [${diverged.map((d) => d.activity).join(',')}]: `)).trim();
    rl.close();
    if (!ans) { info('nothing refreshed — routes left as they are'); return 0; }
    picked = ans.toLowerCase() === 'all'
      ? diverged.map((d) => d.activity)
      : ans.split(',').map((s) => s.trim()).filter((a) => diverged.some((d) => d.activity === a));
  }
  if (!picked.length) { info('nothing refreshed — routes left as they are'); return 0; }

  cfg.providers.dualRouting = refreshSeededRoutes(policy, { activities: picked });
  saveKitConfig(cfg);
  ok(`refreshed ${picked.length} route(s): ${picked.join(', ')}`);
  const router = applyAqeRouter(cfg, cwd);
  (router.ok ? ok : warn)(`aqe router: ${router.detail}`);
  printActivityRoutingTable(cfg);
  return 0;
}

async function off({ cwd, pkgRoot }) {
  const cfg = loadKitConfig();
  const codexMcpManaged = cfg.providers?.codexMcp === 'ak';
  const rufloCodexManaged = cfg.providers?.rufloCodexMcp === 'ak';
  // opencode teardown reads the ownership markers from cfg — strip BEFORE the
  // reset below clears them (mirrors the codex managed-flag captures above).
  // On a FAILED teardown (e.g. JSONC config) the markers are the only remaining
  // proof — preserve them for the retry instead of nulling them into the reset.
  const retired = await runLifecycle({ adapter: OPENCODE_LIFECYCLE_ADAPTER, action: 'undo', cfg });
  const ret = retired.result;
  const keptMarkers = ret.ok ? { opencodeMcp: null, opencodeManaged: null }
    : { opencodeMcp: cfg.providers.opencodeMcp, opencodeManaged: cfg.providers.opencodeManaged };
  cfg.providers = { hosts: { claude: true, codex: false, opencode: false }, primaryHost: 'claude', aqeProvider: null, aqeFallback: [], models: [], maxBudgetUsd: null, dualRouting: {}, codexMcp: null, rufloCodexMcp: null, ...keptMarkers };
  saveKitConfig(cfg);
  // enablement-gated guidance strips regardless (user content preserved).
  if (pkgRoot) await reconcileOpencodeGuidance({ pkgRoot, cfg, cwd, enabled: false });
  const env = undoProviders(cwd);
  const router = undoAqeRouter(cwd);
  const mcp = await undoCodexMcp(cwd, { managed: codexMcpManaged });
  const rmcp = await undoRufloMcpInCodex(cwd, { managed: rufloCodexManaged });
  const ocLine = ret.ok ? `opencode: ${ret.undo.detail}; ${ret.artifacts.detail}`
    : `opencode teardown incomplete — ${ret.undo.detail}`;
  (ret.ok ? ok : warn)(`reset to claude-only default — ${env.detail}; ${router.detail}; ${mcp.detail}; ${rmcp.detail}; ${ocLine}`);
  return ret.ok ? 0 : 1;
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
  const violations = validateCourtConfig({ ...qc, routing });
  if (violations.length) { warn(`qe-court routing defaults would be invalid (${violations.join(', ')}) — not written`); return; }

  writeJsonWithBackup(qeCourtConfigPath(root), { ...qc, routing });
  ok(`qe-court routing updated: ${changes.map(([role, p]) => `${role}→${p}`).join(', ')}`);
}

async function pick({ flags, cwd, pkgRoot }) {
  const cfg = loadKitConfig();
  const hosts = await detectHosts(cwd);
  // Routing eligibility is capability-derived. OpenCode retains its independent
  // lifecycle wiring even though it is now an execution host; it is never a
  // primary/AQE host because those are separate registry capabilities.
  // --host is the complete desired enabled-host set on BOTH tiers; excluding an
  // enabled host disables it (ak-managed wiring stripped, user config kept).
  const ROUTING = new Set(routableHostIds());
  const prevOpencode = !!cfg.providers?.hosts?.opencode || cfg.providers?.opencodeMcp === 'ak';
  let enabled;
  let aqeProvider = cfg.providers.aqeProvider ?? null;
  // A legacy chain written before provenance existed reads as 'user': we cannot
  // tell whether it was typed or accepted, so it must never be auto-touched.
  let aqeFallback = (cfg.providers.aqeFallback ?? []).map((e) => ({ ...e, source: fallbackSource(e) }));
  let models = cfg.providers.models ?? [];
  const prevPrimary = cfg.providers.primaryHost ?? DEFAULT_PRIMARY_HOST;
  const oldPolicy = cfg.providers.dualRouting ?? {};
  const prevCodex = !!cfg.providers?.hosts?.codex;
  const codexMcpManaged = cfg.providers?.codexMcp === 'ak';
  const rufloCodexManaged = cfg.providers?.rufloCodexMcp === 'ak';

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
      aqeFallback = (v === 'none' || v === '') ? [] : stamp('user')(parseFallback(v));
    }
    if (flags.provider !== undefined) models = parseModels(flags.provider);
  } else {
    const installedRouting = HOSTS.filter((h) => hosts[h.id].present && ROUTING.has(h.id)
      && (h.id !== 'opencode' || cfg.providers.hosts.opencode)).map((h) => h.id);
    const installedOpenCode = hosts.opencode?.present && !cfg.providers.hosts.opencode;
    if (installedRouting.length === 0 && !installedOpenCode) { fail('no frontier CLI (claude/codex/opencode) found on PATH'); return 1; }
    console.log(`Installed hosts: ${installedRouting.join(', ') || 'none'}${installedOpenCode ? dim('  (opencode is available; type it to opt in)') : ''}`);
    // Default: every currently ENABLED host (even one temporarily absent from
    // PATH — a bare enter must never tear down an enabled host it simply can't
    // see right now) ∪ newly detected routing hosts. An installed-but-disabled
    // OpenCode host remains opt-in by typing it — a bare enter must not opt a
    // third host's config home in sight unseen either.
    const enabledHosts = HOSTS.filter((h) => cfg.providers.hosts[h.id]).map((h) => h.id);
    const dflt = [...new Set([...enabledHosts, ...installedRouting])];
    const absentEnabled = enabledHosts.filter((h) => !hosts[h].present);
    if (absentEnabled.length) {
      console.log(dim(`  enabled but not detected right now: ${absentEnabled.join(', ')} (kept enabled on Enter)`));
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const hAns = (await rl.question(`Enable which ruflo host(s)? (comma-separated) [${dflt.join(',')}]: `)).trim();
    enabled = (hAns || dflt.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    console.log(dim(`  ${AQE_BILLING_HINT}`));
    const aAns = (await rl.question(`agentic-qe primary LLM provider — ${AQE_PROVIDER_TYPES.join('/')} (blank = leave aqe default): `)).trim().toLowerCase();
    aqeProvider = aAns ? aAns : null;
    const suggestion = suggestedFallbackFor(enabled);
    const fAns = (await rl.question(
      `aqe fallback chain, ordered (e.g. "claude-code:claude-opus-5; openai:gpt-5.6"${suggestion ? `, blank = use suggested [${suggestion}]` : ', blank = none'}): `,
    )).trim().toLowerCase();
    aqeFallback = fAns
      ? stamp('user')(parseFallback(fAns))
      : (suggestion ? stamp('suggested')(parseFallback(suggestion.toLowerCase())) : []);
    const provAns = (await rl.question('ruflo API-key providers to register (e.g. openai:gpt-5.6, blank to skip): ')).trim();
    if (provAns) models = parseModels(provAns);
    rl.close();
  }

  // validate hosts against the two tiers. An unknown token is a hard error,
  // never a silent drop: `--host claude,opencdoe` must not "succeed" as
  // claude-only and destructively tear the opencode host down (codex-review r3).
  const known = new Set(HOSTS.map((h) => h.id));
  const unknown = enabled.filter((h) => !known.has(h));
  if (unknown.length) {
    fail(`unknown host(s): ${unknown.join(', ')} (valid: ${[...known].join(', ')}) — nothing changed`);
    return 2;
  }
  // The routing set needs at least one primary-capable member; OpenCode remains
  // routable but cannot satisfy that primary-host invariant on its own.
  const routing = enabled.filter((h) => ROUTING.has(h));
  if (!routing.some((h) => PRIMARY_HOSTS.includes(h))) routing.unshift('claude');
  enabled = [...new Set(routing)];
  // primary host — which host leads (default claude); must be a ROUTING host.
  let primaryHost = prevPrimary;
  if (flags['primary-host'] !== undefined) {
    const v = flags['primary-host'].trim().toLowerCase();
    if (PRIMARY_HOSTS.includes(v)) primaryHost = v;
    else warn(`unknown primary host '${v}' (valid: ${PRIMARY_HOSTS.join('|')}) — keeping ${primaryHost}`);
  }
  if (!routing.includes(primaryHost)) primaryHost = routing[0] ?? DEFAULT_PRIMARY_HOST;
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
  // Tell the user AT ENTRY TIME that a rung is inert, and name what it needs —
  // the failure otherwise surfaces at QE-run time, far from the config (#54).
  const gaps = credentialGaps(aqeFallback);
  for (const g of gaps) {
    warn(`${g.provider}: no ${g.missing.join(' / ')} in env — this rung will fail over into nothing`);
  }
  if (gaps.length) {
    const live = AQE_PROVIDER_TYPES.filter((p) => aqeProviderCredential(p).present
      && !aqeFallback.some((e) => e.provider === p));
    if (live.length) info(`credentialed alternatives available now: ${live.join(', ')}`);
  }

  cfg.providers = {
    hosts: {
      claude: routing.includes('claude'),
      codex: routing.includes('codex'),
      opencode: enabled.includes('opencode'),
    },
    aqeProvider,
    aqeFallback,
    models,
    primaryHost,
    maxBudgetUsd: cfg.providers.maxBudgetUsd ?? null,
    dualRouting: reseedForPrimary ? {} : { ...oldPolicy },
    // Every ownership marker survives a retune (teardown contract): the codex
    // MCP bridges AND the opencode wiring. Dropping these on rewrite would
    // strand managed servers ak can no longer prove it owns — the data-loss
    // class the ownership model exists to prevent.
    codexMcp: cfg.providers?.codexMcp ?? null,
    rufloCodexMcp: cfg.providers?.rufloCodexMcp ?? null,
    opencodeMcp: cfg.providers?.opencodeMcp ?? null,
    opencodeManaged: cfg.providers?.opencodeManaged ?? null,
    opencodeCatalogDir: cfg.providers?.opencodeCatalogDir ?? null,
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
  const prunedRoutes = pruneRoutesForHosts(cfg.providers.dualRouting, { hosts: enabled });
  cfg.providers.dualRouting = prunedRoutes.policy;
  for (const message of prunedRoutes.warnings) warn(message);

  // Codex owns two directional MCP bridges. Disable only the marker-owned
  // bridges, matching OpenCode's receipt-based teardown semantics.
  let codexRetired = null;
  if (prevCodex && !cfg.providers.hosts.codex) {
    const mcp = await undoCodexMcp(cwd, { managed: codexMcpManaged });
    const rmcp = await undoRufloMcpInCodex(cwd, { managed: rufloCodexManaged });
    cfg.providers.codexMcp = null;
    cfg.providers.rufloCodexMcp = null;
    codexRetired = { mcp, rmcp };
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

  // opencode (integration host): apply the same owner-module stack setup/sync
  // use — config wiring, lifecycle plugin, converted agents, platform skill —
  // then converge the guidance blocks the same way setup/sync do ("wired +
  // guided" is one contract, not two).
  // CLI-gated: an enabled-but-absent CLI never fabricates the config home.
  let incompleteTeardown = false;
  if (cfg.providers.hosts.opencode) {
    if (!(await have('opencode'))) {
      warn('opencode: enabled but CLI not installed — wiring skipped (re-run `ak sync` after installing opencode-ai)');
    } else {
      const lifecycle = await runLifecycle({
        adapter: OPENCODE_LIFECYCLE_ADAPTER, action: 'apply', cfg, options: { pkgRoot },
      });
      const stack = lifecycle.result;
      // persist the markers on ANY refresh (converged file + stale markers is
      // exactly the stranded-teardown case), not only on file changes.
      if (stack.oc.changed || stack.markersChanged) saveKitConfig(cfg);
      if (stack.oc.changed || !stack.oc.ok) (stack.oc.ok ? ok : warn)(`opencode: ${stack.oc.detail}`);
      if (stack.plugin.changed || !stack.plugin.ok) (stack.plugin.ok ? ok : warn)(`opencode plugin: ${stack.plugin.detail}`);
      if (stack.agents.changed || !stack.agents.ok) (stack.agents.ok ? ok : warn)(`opencode agents: ${stack.agents.detail}`);
      if (stack.skill.changed || !stack.skill.ok) (stack.skill.ok ? ok : warn)(`opencode skill: ${stack.skill.detail}`);
      const guidance = await reconcileOpencodeGuidance({ pkgRoot, cfg, cwd, enabled: true });
      if (guidance.changed) ok(`opencode ${guidance.detail}`);
      // opencode loads config/plugins/MCP/agents once at startup — say so now,
      // or the user files "hooks don't work" issues (observed live).
      if (stack.oc.changed || stack.plugin.changed || stack.agents.changed || stack.skill.changed) {
        info('restart opencode to load the hooks + MCP servers (loaded once at startup)');
      }
    }
  } else if (prevOpencode) {
    // Excluded from the desired set while previously enabled/managed → disable:
    // strip ONLY ak-managed wiring/artifacts (priors restored, marker-gated),
    // never the user's own opencode config. A teardown that cannot complete
    // (e.g. a JSONC config) is reported honestly — markers stay for the retry
    // and "disabled" is never claimed over still-active wiring.
    const retired = await runLifecycle({ adapter: OPENCODE_LIFECYCLE_ADAPTER, action: 'undo', cfg });
    const ret = retired.result;
    saveKitConfig(cfg); // persist markers (nulled on success, retained on failure)
    if (ret.ok) ok(`opencode disabled: ${ret.undo.detail}; ${ret.artifacts.detail}`);
    else {
      incompleteTeardown = true;
      warn(`opencode disable incomplete — ${ret.undo.detail} (artifacts: ${ret.artifacts.detail})`);
    }
    // enablement-gated guidance strips regardless (user content preserved).
    const guidance = await reconcileOpencodeGuidance({ pkgRoot, cfg, cwd, enabled: false });
    if (guidance.changed) ok(`opencode ${guidance.detail}`);
  }

  const h = applyHosts(cfg, cwd);
  (h.ok ? ok : fail)(`hosts: ${h.detail}`);
  if (codexRetired) ok(`codex disabled: ${codexRetired.mcp.detail}; ${codexRetired.rmcp.detail}`);
  if (primaryHost !== DEFAULT_PRIMARY_HOST) {
    const alt = routing.filter((e) => e !== primaryHost).join(', ') || 'none';
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
  ok('saved to kit.json — reapplied on every `ak sync`; undo with `ak host off`');
  if (seed.seeded) ok(`per-activity routing seeded — ${seed.count} activities (dual-host defaults; tune with --route or edit kit.json)`);
  printActivityRoutingTable(cfg);
  await maybeWriteQeCourtDefaults({ nonInteractive, cwd, enabled, aqeProvider });
  printDualHostTips(cfg);
  return incompleteTeardown ? 1 : 0;
}
