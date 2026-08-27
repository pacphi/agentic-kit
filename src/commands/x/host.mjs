// x host — frontier-host + LLM-provider detection and wiring.
//   status (default) : detected CLIs, aqe provider, ruflo providers, what's wired
//   pick             : choose enabled hosts / aqe provider / ruflo providers → persist → apply
//   off              : reversible teardown (strip managed env keys)
// Mirrors `ak x mcp`: detect → persist to kit.json → idempotent heal.
// Two independent axes: ruflo host CLIs (claude/codex) and the LLM the routers use.
import readline from 'node:readline/promises';
import {
  HOSTS, API_PROVIDERS, AQE_PROVIDER_TYPES, detectHosts,
  settingsTarget, isDefault,
  undoProviders, hostInstallState, hostAuthState, installHost, applyAqeRouter, undoAqeRouter,
  bothHostsEnabled, DUAL_ROLE_TIP, JUDGE_BIAS_TIP, QE_COURT_TIP, suggestedFallbackFor,
  seedActivityRoutesIfMultiHost, migrateRetiredRoutesInConfig, printActivityRoutingTable, convergeProviderStack, reportRetiredRouteChanges, undoCodexMcp,
  undoRufloMcpInCodex, detectAqeProviders, aqeProviderCredential, credentialGaps, fallbackSource,
  collectIntegrationFacts, aqeSelectableProviderTypes, aqeSelectableChainProviderTypes,
} from '../../lib/providers.mjs';
import { parseRouteSpecs, formatModelHelp, PRIMARY_HOSTS, DEFAULT_PRIMARY_HOST, divergedRoutes, refreshSeededRoutes, pruneRoutesForHosts, modelNote, ACTIVITIES } from '../../lib/routing.mjs';
import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import { reconcileOpencodeGuidance } from '../../lib/opencode.mjs';
import { runLifecycle } from '../../lib/adapters/lifecycle.mjs';
import { lifecycleAdapterFor } from '../../lib/adapters/lifecycle-registry.mjs';
import { bootstrapHostAdapters } from '../../lib/adapters/admission.mjs';
import { hostTierLabel, hostAsymmetryNote } from '../../lib/hosts.mjs';
import {
  routableHostIds, effectiveRoutableHostIds, defaultHostMap, validateBinding, HOST_REGISTRY, PROVIDER_REGISTRY,
} from '../../lib/adapters/index.mjs';
import {
  newlyEnabledHostTrustManifest, trustManifestLines,
} from '../../lib/trust-manifest.mjs';
import { have } from '../../lib/exec.mjs';
import {
  ok, warn, fail, info, dim, bold, yellow,
} from '../../lib/output.mjs';
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
  'expect-hash': { type: 'string' }, // adapters trust: required sha256 pin when --yes resolves a non-file source
  timeout: { type: 'string' },       // adapters conformance: outer ms budget override (default: manifest's own execution.run.hook.timeoutMs, else 120000)
  dev: { type: 'boolean', default: false }, // adapters conformance: run without persisting evidence/grants
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

/** Billing is the non-obvious axis of the aqe provider list. Three categories,
 *  and claude-code is the ONLY same-vendor subscription alternative to a metered
 *  key (codex/gemini OAuth live on the host axis, not as aqe provider types). */
export const AQE_BILLING_HINT = 'billing: claude-code/codex = host subscription, ollama/onnx = local, built-in APIs = metered; external billing is adapter-declared and unverified';

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
  adapters record hash-pinned consent for external host-adapter manifests
             (experimental — set AK_EXPERIMENTAL_HOST_ADAPTERS=1; revoke
             always works, list/trust need the flag)
             list        show each configured adapter's trust state (default)
             trust <name> [--expect-hash <sha256>]   grant consent (required
                          with --yes against a non-file source); revoke <name>
             conformance <name> [--timeout <ms>] [--dev]
                          run the tiered black-box harness; --dev is a loud,
                          non-persistent self-test and never produces
                          graduation evidence

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
                                 ollama/onnx = local ($0); external billing is
                                 adapter-declared and shown as unverified
  --aqe-fallback '<chain>'     ordered aqe chain, e.g.
                                 'claude-code:claude-opus-5; openai:gpt-5.6'
                                 (metered providers work too, e.g. add
                                 'openrouter:z-ai/glm-5.2' — GLM via OpenRouter,
                                 needs OPENROUTER_API_KEY in the env)
  --provider <csv>             register ruflo providers (e.g. ollama:qwen3.6:27b)
  --route 'act:host[:model]'   override one activity's routing (repeatable), e.g.
                                 --route 'implementation:claude:claude-opus-5'
                                 activities: specification, architecture, design,
                                 implementation, testing, review, security-scan,
                                 security-analysis, documentation, debugging,
                                 packaging, release
  --activity <csv>             refresh: which activities to re-seed (default: prompt)
  --yes                        accept defaults without prompting

Enabling a host prints its host trust manifest before kit.json or host config
is changed. --yes accepts that manifest non-interactively; without --yes, a
non-interactive invocation stops before mutation.

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
export const parseFallback = (str) => str.split(';').map((s) => s.trim()).filter(Boolean).map((tok) => {
  const delimiter = tok.indexOf(':');
  const provider = delimiter < 0 ? tok : tok.slice(0, delimiter);
  const models = delimiter < 0 ? '' : tok.slice(delimiter + 1);
  return { provider: provider.trim().toLowerCase(), models: models.split(',').map((m) => m.trim()).filter(Boolean) };
});

export async function run({ flags, positionals, pkgRoot }) {
  const sub = positionals[0] ?? 'status';
  const cwd = process.cwd();

  if (sub === 'status') return status({ flags, cwd });
  if (sub === 'off') return off({ cwd, pkgRoot });
  if (sub === 'pick') return pick({ flags, cwd, pkgRoot });
  if (sub === 'refresh') return refresh({ flags, cwd });
  if (sub === 'adapters') {
    const { run: runHostAdapters } = await import('./host-adapters.mjs');
    return runHostAdapters({ flags, positionals: positionals.slice(1) });
  }

  fail(`unknown host subcommand: ${sub} (status|pick|refresh|off|adapters)`);
  return 2;
}

/** Structured, friendly warnings for invalid user-declared bindings in kit.json
 *  integrations.bindings (F-16: validateBinding had zero call sites — wired
 *  here so a bad entry surfaces as a warning instead of silent garbage or an
 *  uncaught TypeError reaching the user). A valid binding list yields []. */
export function bindingWarnings(cfg) {
  return (cfg.integrations?.bindings ?? []).flatMap((binding, index) =>
    validateBinding(binding, { hosts: HOST_REGISTRY, providers: PROVIDER_REGISTRY }).map((error) =>
      `kit.json integrations.bindings[${index}].${error.path.replace(/^binding\./, '')}: ${error.code} (${JSON.stringify(error.value)})`));
}

async function status({ flags, cwd }) {
  const cfg = loadKitConfig();
  const facts = await collectIntegrationFacts({ cwd, cfg });
  const hosts = facts.hosts;
  const providers = facts.providers;
  const { scope } = settingsTarget(cwd);

  if (flags.json) {
    console.log(JSON.stringify({
      scope,
      config: {
        integrations: cfg.integrations,
        routing: cfg.routing,
        providers: cfg.providers,
      },
      hosts,
      providers,
    }, null, 2));
    return 0;
  }

  for (const message of bindingWarnings(cfg)) warn(message);

  const dflt = isDefault(cfg);
  console.log(bold('ruflo agent hosts') + dim(`  (wiring scope: ${scope})`));
  for (const h of HOSTS) {
    const d = hosts[h.id];
    const enabled = !!cfg.integrations.hosts[h.id];
    const state = !d.present ? dim('not installed')
      : !enabled ? 'installed, disabled'
      : dflt ? 'enabled (default — ruflo default-on, no env written)'
      : d.wired ? 'enabled, wired'
      : 'enabled, not wired → ak sync';
    const tier = dim(`  · ${hostTierLabel(h.id)}`);
    // auth/billing axis — subscription ($0) vs metered key, per host.
    const auth = d.present ? hostAuthState(h.id, { present: true }) : null;
    const authStr = auth ? dim(`  ${auth.mode}/${auth.billing === 'subscription' ? '$0' : auth.billing}`) : '';
    console.log(`  ${h.id.padEnd(9)} ${(d.version ? `v${d.version}` : '—').padEnd(12)} ${state}${authStr}${tier}`);
    const note = hostAsymmetryNote(h.id);
    if (note) console.log(`    ${dim(note)}`);
  }

  // agentic-qe LLM provider (AQE_LLM_PROVIDER) + fallback chain
  const ap = cfg.providers.aqeProvider;
  console.log(bold('\nagentic-qe LLM provider') + dim('  (built-ins: env; external: project llm-config)'));
  console.log(`  ${(ap ?? dim('aqe default (unset)')).padEnd(24)} ${dim(`supported: ${aqeSelectableProviderTypes().join(', ')}`)}`);
  console.log(`  ${dim(AQE_BILLING_HINT)}`);
  const chain = cfg.providers.aqeFallback ?? [];
  if (chain.length) {
    const rendered = chain.map((e) => {
      const cred = aqeProviderCredential(e.provider);
      const models = e.models?.length ? `(${e.models.join(',')})` : dim('(no models)');
      return `${e.provider}${models}${cred.known && !cred.present ? yellow(' ⚠ no credential') : ''}`;
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
  for (const p of aqeSelectableProviderTypes()) {
    const c = creds[p];
    const state = !c.known
      ? `admitted · credential not introspectable · billing ${c.billing} (declared/unverified)`
      : c.present ? (c.billing === 'local' ? 'local' : c.billing === 'subscription' ? 'subscription' : 'key present')
        : `no key ${dim(`(${c.missing.join(', ')})`)}`;
    console.log(`  ${p.padEnd(14)} ${state}${c.source && c.present && c.billing === 'metered' ? dim(`  · ${c.source}`) : ''}`);
  }

  const cm = cfg.providers.models ?? [];
  console.log(bold('\nruflo LLM providers') + dim('  (registered intent; direct agents select provider + model)'));
  for (const p of API_PROVIDERS) {
    const cfgEntry = cm.find((m) => m.id === p.id);
    const key = p.keyEnv.length
      ? (providers[p.id]?.credentialPresent ? 'key present' : 'no key') : 'local';
    const conf = cfgEntry ? `registered${cfgEntry.model ? ` (${cfgEntry.model})` : ''}` : dim('not registered');
    console.log(`  ${p.id.padEnd(10)} ${key.padEnd(12)} ${conf}`);
  }

  printActivityRoutingTable(cfg);
  printQeCourtStatus(cwd);

  const codexIdle = hosts.codex.present && !cfg.integrations.hosts.codex;
  const ocIdle = hosts.opencode.present && !cfg.integrations.hosts.opencode;
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
  else ok('qe-court routing config passes the local anti-collusion check (runtime court readiness not proven)');
}

/** Opt-in, per-activity re-seed of routes whose seeded pin diverges from the
 *  current defaults. Deliberately a separate command, never part of `ak sync`:
 *  sync is documented as idempotent reapplication of persisted choice, and the
 *  newer default is not uniformly better — on routine work it can cost 2-3× the
 *  agentic turns for the same result (#55). Only `provenance: 'seeded'` entries are
 *  eligible; a user pin survives even when named. */
async function refresh({ flags, cwd }) {
  const cfg = loadKitConfig();
  const policy = cfg.routing?.routes ?? {};
  const diverged = divergedRoutes(policy);
  if (!diverged.length) { ok('no seeded routes diverge from the current defaults'); return 0; }

  console.log(bold('seeded routes that diverge from current defaults'));
  for (const d of diverged) {
    const head = d.modelDiverged ? `${d.model} → ${d.defaultModel}` : d.model;
    console.log(`  ${d.activity.padEnd(18)} ${d.host.padEnd(7)} ${head}`);
    for (const e of d.escalation) console.log(`    ${dim('escalation:')} ${e.model} → ${e.defaultModel}`);
    // The trade, not just the ids: choosing on a price axis while paying on a
    // turns axis is the misreading this whole surface exists to prevent.
    if (d.modelDiverged && d.currentNote) console.log(dim(`    now:     ${d.model} — ${d.currentNote}`));
    if (d.modelDiverged && d.defaultNote) console.log(dim(`    default: ${d.defaultModel} — ${d.defaultNote}`));
    for (const e of d.escalation) {
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

  cfg.routing.routes = refreshSeededRoutes(policy, { activities: picked });
  saveKitConfig(cfg);
  ok(`refreshed ${picked.length} route(s): ${picked.join(', ')}`);
  const router = applyAqeRouter(cfg, cwd);
  (router.ok ? ok : warn)(`aqe router: ${router.detail}`);
  printActivityRoutingTable(cfg);
  return router.ok ? 0 : 1;
}

async function off({ cwd, pkgRoot }) {
  const cfg = loadKitConfig();
  const codexMcpManaged = cfg.integrations?.ownership?.codex?.mcp === 'ak';
  const rufloCodexManaged = cfg.integrations?.ownership?.codex?.reverseMcp === 'ak';
  // OpenCode teardown reads its ownership receipt before the host/routing reset.
  // A failed teardown retains that receipt (including catalogDir) for a retry.
  const retired = await runLifecycle({ adapter: lifecycleAdapterFor('opencode'), action: 'undo', cfg });
  const ret = retired.result;
  cfg.providers = {
    aqeProvider: null,
    aqeFallback: [],
    models: [],
    maxBudgetUsd: null,
  };
  cfg.integrations.hosts = defaultHostMap();
  cfg.routing.primaryHost = DEFAULT_PRIMARY_HOST;
  cfg.routing.routes = {};
  if (ret.ok && cfg.integrations.ownership.opencode) {
    delete cfg.integrations.ownership.opencode.catalogDir;
  }
  saveKitConfig(cfg);
  // enablement-gated guidance strips regardless (user content preserved).
  if (pkgRoot) await reconcileOpencodeGuidance({ pkgRoot, cfg, cwd, enabled: false });
  const env = undoProviders(cwd);
  const router = undoAqeRouter(cwd);
  const mcp = await undoCodexMcp(cwd, { managed: codexMcpManaged });
  const rmcp = await undoRufloMcpInCodex(cwd, { managed: rufloCodexManaged });
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.codex = {
    ...(cfg.integrations.ownership.codex ?? {}),
    ...(mcp.ok ? { mcp: null } : {}),
    ...(rmcp.ok ? { reverseMcp: null } : {}),
  };
  saveKitConfig(cfg);
  const ocLine = ret.ok ? `opencode: ${ret.undo.detail}; ${ret.artifacts.detail}`
    : `opencode teardown incomplete — ${ret.undo.detail}`;
  const complete = ret.ok && mcp.ok && rmcp.ok;
  (complete ? ok : warn)(`reset to claude-only default${complete ? '' : ' with teardown receipts retained'} — ${env.detail}; ${router.detail}; ${mcp.detail}; ${rmcp.detail}; ${ocLine}`);
  return complete ? 0 : 1;
}

export const parseModels = (csv) => csv.split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
  const delimiter = tok.indexOf(':');
  if (delimiter < 0) return { id: tok };
  const id = tok.slice(0, delimiter);
  const model = tok.slice(delimiter + 1);
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

// ── pick(): three stages ─────────────────────────────────────────────────────
// 1. parsePickInput      — raw {enabled, aqeProvider, aqeFallback, models}
//                          intent, from flags or an interactive prompt.
// 2. resolvePickDecision — validate + resolve that intent into the actual
//                          cfg.integrations.hosts/providers/routing writes
//                          (host validation, primary-host resolution, admission
//                          refresh, aqe selection validation, route policy).
// 3. the apply step      — install/wire/converge (uses convergeProviderStack).
// pick() itself is the sequencing of these three stages plus the handful of
// pick-specific side effects (trust confirmation, codex-disable teardown,
// opencode lifecycle) that sit between them.

/** The non-interactive half of stage 1: flags fully determine the intent. */
function parsePickInputFromFlags(flags, cfg) {
  const enabled = flags.host !== undefined
    ? flags.host.split(',').map((s) => s.trim()).filter(Boolean)
    : Object.entries(cfg.integrations.hosts).filter(([, v]) => v).map(([k]) => k);
  let aqeProvider = cfg.providers.aqeProvider ?? null;
  if (flags['aqe-provider'] !== undefined) {
    const v = flags['aqe-provider'].trim().toLowerCase();
    aqeProvider = (v === 'none' || v === '') ? null : v;
  }
  // A legacy chain written before provenance existed reads as 'user': we cannot
  // tell whether it was typed or accepted, so it must never be auto-touched.
  let aqeFallback = (cfg.providers.aqeFallback ?? []).map((e) => ({ ...e, source: fallbackSource(e) }));
  if (flags['aqe-fallback'] !== undefined) {
    const v = flags['aqe-fallback'].trim().toLowerCase();
    aqeFallback = (v === 'none' || v === '') ? [] : stamp('user')(parseFallback(v));
  }
  const models = flags.provider !== undefined ? parseModels(flags.provider) : (cfg.providers.models ?? []);
  return {
    enabled, aqeProvider, aqeFallback, models,
  };
}

/** The interactive half of stage 1: prompt for enable/provider/fallback/
 *  models via readline. Returns `{code}` when no frontier CLI is detected
 *  at all. */
async function promptPickInputInteractively(cfg, hosts, registries, aqeProviderTypes) {
  const installedRouting = HOSTS.filter((h) => hosts[h.id].present && registries.ROUTING.has(h.id)
    && (h.id !== 'opencode' || cfg.integrations.hosts.opencode)).map((h) => h.id);
  const installedOpenCode = hosts.opencode?.present && !cfg.integrations.hosts.opencode;
  if (installedRouting.length === 0 && !installedOpenCode) { fail('no frontier CLI (claude/codex/opencode) found on PATH'); return { code: 1 }; }
  console.log(`Installed hosts: ${installedRouting.join(', ') || 'none'}${installedOpenCode ? dim('  (opencode is available; type it to opt in)') : ''}`);
  // Default: every currently ENABLED host (even one temporarily absent from
  // PATH — a bare enter must never tear down an enabled host it simply can't
  // see right now) ∪ newly detected routing hosts. An installed-but-disabled
  // OpenCode host remains opt-in by typing it — a bare enter must not opt a
  // third host's config home in sight unseen either.
  const enabledHosts = HOSTS.filter((h) => cfg.integrations.hosts[h.id]).map((h) => h.id);
  const dflt = [...new Set([...enabledHosts, ...installedRouting])];
  const absentEnabled = enabledHosts.filter((h) => !hosts[h].present);
  if (absentEnabled.length) {
    console.log(dim(`  enabled but not detected right now: ${absentEnabled.join(', ')} (kept enabled on Enter)`));
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const hAns = (await rl.question(`Enable which ruflo host(s)? (comma-separated) [${dflt.join(',')}]: `)).trim();
  const enabled = (hAns || dflt.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  console.log(dim(`  ${AQE_BILLING_HINT}`));
  const aAns = (await rl.question(`agentic-qe primary LLM provider — ${aqeProviderTypes.join('/')} (blank = leave aqe default): `)).trim().toLowerCase();
  const aqeProvider = aAns ? aAns : null;
  const suggestion = suggestedFallbackFor(enabled);
  const fAns = (await rl.question(
    `aqe fallback chain, ordered (e.g. "claude-code:claude-opus-5; openai:gpt-5.6"${suggestion ? `, blank = use suggested [${suggestion}]` : ', blank = none'}): `,
  )).trim().toLowerCase();
  const aqeFallback = fAns
    ? stamp('user')(parseFallback(fAns))
    : (suggestion ? stamp('suggested')(parseFallback(suggestion.toLowerCase())) : []);
  const provAns = (await rl.question('ruflo providers to register (e.g. ollama:qwen3.6:27b, blank to skip): ')).trim();
  const models = provAns ? parseModels(provAns) : (cfg.providers.models ?? []);
  rl.close();
  return {
    enabled, aqeProvider, aqeFallback, models,
  };
}

/** Stage 1/3: resolve the raw enable/provider intent — from flags
 *  (non-interactive) or a readline prompt sequence. Returns `{code}` when
 *  pick() must return immediately (no frontier CLI detected on an
 *  interactive run), else the parsed intent plus `nonInteractive` (used
 *  later to gate the qe-court defaults prompt). */
async function parsePickInput({
  flags, cfg, hosts, registries, aqeProviderTypes,
}) {
  const nonInteractive = flags.host !== undefined || flags['aqe-provider'] !== undefined
    || flags['aqe-fallback'] !== undefined || flags.provider !== undefined
    || flags['primary-host'] !== undefined;
  const parsed = nonInteractive
    ? parsePickInputFromFlags(flags, cfg)
    : await promptPickInputInteractively(cfg, hosts, registries, aqeProviderTypes);
  if (parsed.code !== undefined) return parsed;
  return { ...parsed, nonInteractive };
}

/** Validate the aqe primary-provider and fallback-chain selections against
 *  the (possibly admission-refreshed) selectable sets, warning about —
 *  rather than silently keeping — anything unusable. Returns the validated
 *  {aqeProvider, aqeFallback}. */
function validatePickAqeSelections({
  aqeProvider, aqeFallback, aqeProviderTypes, aqeChainProviderTypes,
}) {
  // validate aqe primary provider
  let provider = aqeProvider;
  if (provider && !aqeProviderTypes.includes(provider)) {
    const norm = provider === 'anthropic' ? 'claude' : provider;
    if (aqeProviderTypes.includes(norm)) provider = norm;
    else { warn(`unknown aqe provider '${provider}' — leaving aqe on its default (valid: ${aqeProviderTypes.join(', ')})`); provider = null; }
  }
  // validate fallback chain providers (chain gate admits codex — #108 phase 3)
  const fallback = aqeFallback
    .map((e) => ({ ...e, provider: e.provider === 'anthropic' ? 'claude' : e.provider }))
    .filter((e) => {
      const okp = aqeChainProviderTypes.includes(e.provider);
      if (!okp) warn(`dropping unknown fallback provider '${e.provider}'`);
      else if (!e.models.length) warn(`fallback entry '${e.provider}' has no models — aqe may skip it; add e.g. ${e.provider}:<model-id>`);
      return okp;
    });
  // Tell the user AT ENTRY TIME that a rung is inert, and name what it needs —
  // the failure otherwise surfaces at QE-run time, far from the config (#54).
  const gaps = credentialGaps(fallback);
  for (const g of gaps) {
    warn(`${g.provider}: no ${g.missing.join(' / ')} in env — this rung will fail over into nothing`);
  }
  if (gaps.length) {
    const live = AQE_PROVIDER_TYPES.filter((p) => aqeProviderCredential(p).present
      && !fallback.some((e) => e.provider === p));
    if (live.length) info(`credentialed alternatives available now: ${live.join(', ')}`);
  }
  return { aqeProvider: provider, aqeFallback: fallback };
}

/** Stage 2/3: validate the enabled-host set, resolve primary-host + routing
 *  intent, refresh host-adapter admission against that final intent,
 *  validate the aqe provider/fallback selections against the (possibly
 *  refreshed) selectable sets, and build the resulting providers/routing
 *  policy. Mutates `cfg` in place (integrations.hosts, providers, routing) —
 *  this is the decision, not yet the apply step (see applyPickProviderStack).
 *  Returns `{code}` when pick() must return immediately (unknown host
 *  token), else the resolved decision. */
async function resolvePickDecision(cfg, {
  enabled: rawEnabled, aqeProvider: rawAqeProvider, aqeFallback: rawAqeFallback, models,
  flags, registries, prevPrimary, oldPolicy, aqeProviderTypes: initialAqeProviderTypes, aqeChainProviderTypes: initialAqeChainProviderTypes,
}) {
  const { ROUTING, EFFECTIVE_ROUTING, MANAGED_HOSTS } = registries;
  let enabled = rawEnabled;
  let aqeProvider = rawAqeProvider;
  let aqeFallback = rawAqeFallback;

  // validate hosts against the two tiers. An unknown token is a hard error,
  // never a silent drop: `--host claude,opencdoe` must not "succeed" as
  // claude-only and destructively tear the opencode host down (codex-review r3).
  const known = new Set([...MANAGED_HOSTS, ...EFFECTIVE_ROUTING]);
  const unknown = enabled.filter((h) => !known.has(h));
  if (unknown.length) {
    fail(`unknown host(s): ${unknown.join(', ')} (valid: ${[...known].join(', ')}) — nothing changed`);
    return { code: 2 };
  }
  // The routing set needs at least one primary-capable member; OpenCode remains
  // routable but cannot satisfy that primary-host invariant on its own.
  const routing = enabled.filter((h) => ROUTING.has(h));
  if (!routing.some((h) => PRIMARY_HOSTS.includes(h))) {
    routing.unshift('claude');
    enabled.unshift('claude');
  }
  enabled = [...new Set(enabled)];
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
  const policyAllSeeded = Object.keys(oldPolicy).length > 0
    && Object.values(oldPolicy).every((r) => r.provenance === 'seeded');
  const reseedForPrimary = primaryHost !== prevPrimary && policyAllSeeded;

  const hostIntent = {
    claude: routing.includes('claude'),
    codex: routing.includes('codex'),
    opencode: enabled.includes('opencode'),
  };
  // External host ids are not primary candidates, but they are first-class
  // integration intent. Retain every live admitted external id as an explicit
  // boolean so a provider-only pick cannot deactivate its own bridge; an
  // explicit --host set can still disable it by omission.
  for (const id of EFFECTIVE_ROUTING) {
    if (!MANAGED_HOSTS.has(id)) hostIntent[id] = enabled.includes(id);
  }
  cfg.integrations.hosts = hostIntent;

  // Admission ran once at process bootstrap against the persisted pre-pick
  // config. Re-run it against the final in-memory host intent before provider
  // validation/projection: an admitted+granted provider can then be enabled
  // and selected atomically, while a provider disabled by this command is
  // removed from the AQE bridge before applyAqeRouter computes its projection.
  let aqeProviderTypes = initialAqeProviderTypes;
  let aqeChainProviderTypes = initialAqeChainProviderTypes;
  if (process.env.AK_EXPERIMENTAL_HOST_ADAPTERS === '1') {
    const refreshed = await bootstrapHostAdapters({ cfg, env: process.env });
    for (const entry of refreshed.warnings) {
      warn(`host adapter '${entry.name}' refresh refused (${entry.reason}): ${entry.detail}`);
    }
    aqeProviderTypes = aqeSelectableProviderTypes();
    aqeChainProviderTypes = aqeSelectableChainProviderTypes();
  }

  ({ aqeProvider, aqeFallback } = validatePickAqeSelections({
    aqeProvider, aqeFallback, aqeProviderTypes, aqeChainProviderTypes,
  }));

  cfg.providers = {
    aqeProvider,
    aqeFallback,
    models,
    maxBudgetUsd: cfg.providers.maxBudgetUsd ?? null,
  };
  cfg.routing.primaryHost = primaryHost;
  cfg.routing.routes = reseedForPrimary ? {} : { ...oldPolicy };
  // Multi-host: seed per-activity routing from defaults (only when the policy is
  // empty), then layer any explicit --route overrides on top (marked user, never
  // re-seeded). Single-host / older aqe → no-op, policy stays empty (ADR-0003).
  const seed = seedActivityRoutesIfMultiHost(cfg);
  if (flags.route?.length) {
    const { policy, warnings } = parseRouteSpecs(flags.route);
    for (const w of warnings) warn(w);
    cfg.routing.routes = { ...cfg.routing.routes, ...policy };
  }
  const prunedRoutes = pruneRoutesForHosts(cfg.routing.routes, { hosts: enabled });
  cfg.routing.routes = prunedRoutes.policy;
  for (const message of prunedRoutes.warnings) warn(message);

  return {
    enabled, routing, primaryHost, aqeProvider, seed,
  };
}

/** Print the host trust manifest (if any newly-enabled host carries one) and
 *  confirm before any user/project mutation. Returns a numeric exit code
 *  when pick() must return immediately, else undefined. */
async function confirmPickTrustManifest(trustManifest, flags) {
  if (!trustManifest.length) return undefined;
  info('host trust manifest (evaluated before user or project changes):');
  for (const line of trustManifestLines(trustManifest)) console.log(`  ${line}`);
  if (flags.yes) return undefined;
  if (!process.stdin.isTTY) {
    fail('host enablement needs trust confirmation; re-run with --yes after reviewing the manifest');
    return 2;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Enable these hosts and apply these trust changes? [y/N] '))
    .trim().toLowerCase();
  rl.close();
  if (!answer.startsWith('y')) {
    info('host selection cancelled before user or project changes');
    return 0;
  }
  return undefined;
}

/** Disable only marker-owned codex integrations, matching OpenCode's
 *  receipt-based teardown semantics. The legacy Claude→Codex MCP receipt may
 *  still exist on machines upgrading across ADR-0033. Mutates
 *  cfg.integrations.ownership.codex. */
async function retireCodexOnDisable(cfg, cwd, { codexMcpManaged, rufloCodexManaged }) {
  const mcp = await undoCodexMcp(cwd, { managed: codexMcpManaged });
  const rmcp = await undoRufloMcpInCodex(cwd, { managed: rufloCodexManaged });
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.codex = {
    ...(cfg.integrations.ownership.codex ?? {}),
    ...(mcp.ok ? { mcp: null } : {}),
    ...(rmcp.ok ? { reverseMcp: null } : {}),
  };
  return { mcp, rmcp };
}

/** Install any enabled host that is entirely absent (external installs
 *  untouched). Unlike setup's install loop, pick never prompts first — the
 *  user already confirmed the trust manifest for this exact enable. */
async function installPickAbsentHosts(cfg) {
  for (const h of HOSTS) {
    if (!cfg.integrations.hosts[h.id]) continue;
    if ((await hostInstallState(h)).method !== 'absent') continue;
    info(`${h.id} not installed — installing ${h.pkg}…`);
    const r = await installHost(h.id);
    (r.ok ? ok : warn)(`${h.id}: ${r.detail}`);
  }
}

/** opencode enable half: apply the same owner-module stack setup/sync use —
 *  connected MCPs, compact lazy gateway, lifecycle plugin, specialist
 *  dispatcher, and platform skill — then converge guidance the same way
 *  ("wired + guided" is one contract, not two). CLI-gated: an
 *  enabled-but-absent CLI never fabricates the config home. */
async function enablePickOpencodeLifecycle(cfg, { pkgRoot, cwd }) {
  if (!(await have('opencode'))) {
    warn('opencode: enabled but CLI not installed — wiring skipped (re-run `ak sync` after installing opencode-ai)');
    return;
  }
  const lifecycle = await runLifecycle({
    adapter: lifecycleAdapterFor('opencode'), action: 'apply', cfg, options: { pkgRoot },
  });
  const stack = lifecycle.result;
  // persist the markers on ANY refresh (converged file + stale markers is
  // exactly the stranded-teardown case), not only on file changes.
  if (stack.oc.changed || stack.markersChanged) saveKitConfig(cfg);
  if (stack.oc.changed || !stack.oc.ok) (stack.oc.ok ? ok : warn)(`opencode: ${stack.oc.detail}`);
  if (stack.plugin.changed || !stack.plugin.ok) (stack.plugin.ok ? ok : warn)(`opencode plugin: ${stack.plugin.detail}`);
  if (stack.gateway.changed || !stack.gateway.ok) (stack.gateway.ok ? ok : warn)(`opencode gateway: ${stack.gateway.detail}`);
  if (stack.agents.changed || !stack.agents.ok) (stack.agents.ok ? ok : warn)(`opencode agent projection: ${stack.agents.detail}`);
  if (stack.skill.changed || !stack.skill.ok) (stack.skill.ok ? ok : warn)(`opencode skill: ${stack.skill.detail}`);
  const guidance = await reconcileOpencodeGuidance({ pkgRoot, cfg, cwd, enabled: true });
  if (guidance.changed) ok(`opencode ${guidance.detail}`);
  // opencode loads config/plugins/MCP/agents once at startup — say so now,
  // or the user files "hooks don't work" issues (observed live).
  if (stack.oc.changed || stack.plugin.changed || stack.gateway.changed
      || stack.agents.changed || stack.skill.changed) {
    info('restart opencode to load the Agentic Kit hooks, compact gateway, and MCP connections (loaded once at startup)');
  }
}

/** opencode disable half: excluded from the desired set while previously
 *  enabled/managed → strip ONLY ak-managed wiring/artifacts (priors
 *  restored, marker-gated), never the user's own opencode config. A
 *  teardown that cannot complete (e.g. a JSONC config) is reported honestly
 *  — markers stay for the retry and "disabled" is never claimed over
 *  still-active wiring. Returns {incompleteTeardown}. */
async function disablePickOpencodeLifecycle(cfg, { pkgRoot, cwd }) {
  const retired = await runLifecycle({ adapter: lifecycleAdapterFor('opencode'), action: 'undo', cfg });
  const ret = retired.result;
  saveKitConfig(cfg); // persist markers (nulled on success, retained on failure)
  let incompleteTeardown = false;
  if (ret.ok) ok(`opencode disabled: ${ret.undo.detail}; ${ret.artifacts.detail}`);
  else {
    incompleteTeardown = true;
    warn(`opencode disable incomplete — ${ret.undo.detail} (artifacts: ${ret.artifacts.detail})`);
  }
  // enablement-gated guidance strips regardless (user content preserved).
  const guidance = await reconcileOpencodeGuidance({ pkgRoot, cfg, cwd, enabled: false });
  if (guidance.changed) ok(`opencode ${guidance.detail}`);
  return { incompleteTeardown };
}

async function applyPickOpencodeLifecycle(cfg, { pkgRoot, cwd, prevOpencode }) {
  if (cfg.integrations.hosts.opencode) {
    await enablePickOpencodeLifecycle(cfg, { pkgRoot, cwd });
    return { incompleteTeardown: false };
  }
  if (prevOpencode) return disablePickOpencodeLifecycle(cfg, { pkgRoot, cwd });
  return { incompleteTeardown: false };
}

/** Stage 3/3 (apply): the shared pipeline (providers.mjs's
 *  convergeProviderStack) computes and persists every step; this reporter
 *  only decides what to print and how, preserving pick's exact
 *  wording/gating/ordering per step. seedRoutes:false — routes were already
 *  seeded during resolvePickDecision (before pruning); re-seeding here would
 *  be a no-op anyway, but the reporter stays silent for it since the
 *  "seeded" message prints later, from that earlier `seed`. */
/** The 'hosts' step's own report: the hosts-apply result, plus (only on this
 *  step) the codex-disabled and primary-host messages — split out purely to
 *  keep applyPickProviderStack's reporter's own branch count legible. */
function reportPickHostsStep(result, { codexRetired, primaryHost, routing }) {
  (result.ok ? ok : fail)(`hosts: ${result.detail}`);
  if (codexRetired) {
    const complete = codexRetired.mcp.ok && codexRetired.rmcp.ok;
    (complete ? ok : warn)(`codex disabled${complete ? '' : ' with teardown receipts retained'}: ${codexRetired.mcp.detail}; ${codexRetired.rmcp.detail}`);
  }
  if (primaryHost !== DEFAULT_PRIMARY_HOST) {
    const alt = routing.filter((e) => e !== primaryHost).join(', ') || 'none';
    ok(`primary host: ${primaryHost} (alternate: ${alt})`);
  }
}

/** The 'aqe-router' step's own report: the router-apply result, plus (only
 *  when a primary provider is selected) whether it actually took effect. */
function reportPickAqeRouterStep(result, aqeProvider) {
  if (result.changed || !result.ok) (result.ok ? ok : warn)(`aqe router: ${result.detail}`);
  if (aqeProvider) {
    (result.ok ? ok : warn)(result.ok
      ? `aqe provider: AQE_LLM_PROVIDER=${aqeProvider}`
      : `aqe provider intent not active: ${aqeProvider} (router projection incomplete)`);
  }
}

async function applyPickProviderStack(cfg, cwd, {
  codexRetired, primaryHost, routing, aqeProvider, migrateRoutes,
}) {
  const pickReporter = (step, result) => {
    if (step === 'hosts') { reportPickHostsStep(result, { codexRetired, primaryHost, routing }); return; }
    // Retire withdrawn models from the persisted policy — the same heal `ak
    // sync` already runs (sync.mjs). Without this, `ak host pick` could
    // persist a route naming a model the host has withdrawn, left for the
    // next sync to repair. Only seeded entries are rewritten; a user pin is
    // reported and kept.
    if (step === 'routing-retired') { reportRetiredRouteChanges(result.changes); return; }
    if (step === 'aqe-router') { reportPickAqeRouterStep(result, aqeProvider); return; }
    if (step === 'legacy-codex-mcp') {
      if (result.changed || !result.ok) (result.ok ? ok : warn)(`legacy codex MCP: ${result.detail}`);
      return;
    }
    // Register Ruflo independently in Codex. Agentic-QE's Codex integration is
    // handled by `aqe init --with-codex` during setup.
    if (step === 'ruflo-codex-mcp') {
      if (result.changed || !result.ok) (result.ok ? ok : warn)(`ruflo→codex MCP: ${result.detail}`);
      return;
    }
    if (step === 'providers-api') {
      (result.status === 'degraded' ? warn : result.ok ? (result.changed ? ok : info) : warn)(`ruflo providers: ${result.detail}`);
    }
  };
  return convergeProviderStack(cfg, cwd, {
    reporter: pickReporter, seedRoutes: false, migrateRoutes,
  });
}

/** The pre-pick facts pick() needs to detect a transition (host being newly
 *  disabled, primary changing, etc.) — read once, before any mutation. */
function readPickPriorState(cfg) {
  return {
    prevOpencode: !!cfg.integrations?.hosts?.opencode || cfg.integrations?.ownership?.opencode?.mcp === 'ak',
    prevPrimary: cfg.routing?.primaryHost ?? DEFAULT_PRIMARY_HOST,
    oldPolicy: cfg.routing?.routes ?? {},
    prevCodex: !!cfg.integrations?.hosts?.codex,
    codexMcpManaged: cfg.integrations?.ownership?.codex?.mcp === 'ak',
    rufloCodexManaged: cfg.integrations?.ownership?.codex?.reverseMcp === 'ak',
  };
}

export async function pick({ flags, cwd, pkgRoot, migrateRoutes = migrateRetiredRoutesInConfig }) {
  const aqeProviderTypes = aqeSelectableProviderTypes();
  const aqeChainProviderTypes = aqeSelectableChainProviderTypes();
  const cfg = loadKitConfig();
  const trustBaseline = structuredClone(cfg);
  const hosts = await detectHosts(cwd);
  // Routing eligibility is capability-derived. OpenCode retains its independent
  // lifecycle wiring even though it is now an execution host; it is never a
  // primary/AQE host because those are separate registry capabilities.
  // --host is the complete desired enabled-host set on BOTH tiers; excluding an
  // enabled host disables it (ak-managed wiring stripped, user config kept).
  // Keep primary-host selection on the built-in routing set, but admit an
  // explicitly named external host when the live adapter overlay proves it is
  // routable. Provider-only retunes also carry already-enabled external ids
  // through unchanged instead of mistaking them for unknown host tokens.
  const registries = {
    ROUTING: new Set(routableHostIds()),
    EFFECTIVE_ROUTING: new Set(effectiveRoutableHostIds()),
    MANAGED_HOSTS: new Set(HOSTS.map((host) => host.id)),
  };
  const {
    prevOpencode, prevPrimary, oldPolicy, prevCodex, codexMcpManaged, rufloCodexManaged,
  } = readPickPriorState(cfg);

  const input = await parsePickInput({
    flags, cfg, hosts, registries, aqeProviderTypes,
  });
  if (input.code !== undefined) return input.code;

  const decision = await resolvePickDecision(cfg, {
    enabled: input.enabled,
    aqeProvider: input.aqeProvider,
    aqeFallback: input.aqeFallback,
    models: input.models,
    flags,
    registries,
    prevPrimary,
    oldPolicy,
    aqeProviderTypes,
    aqeChainProviderTypes,
  });
  if (decision.code !== undefined) return decision.code;
  const {
    enabled, routing, primaryHost, aqeProvider, seed,
  } = decision;

  const trustManifest = newlyEnabledHostTrustManifest(trustBaseline, enabled);
  const trustCode = await confirmPickTrustManifest(trustManifest, flags);
  if (trustCode !== undefined) return trustCode;

  let codexRetired = null;
  if (prevCodex && !cfg.integrations.hosts.codex) {
    codexRetired = await retireCodexOnDisable(cfg, cwd, { codexMcpManaged, rufloCodexManaged });
  }
  saveKitConfig(cfg);

  await installPickAbsentHosts(cfg);
  const { incompleteTeardown } = await applyPickOpencodeLifecycle(cfg, { pkgRoot, cwd, prevOpencode });

  const { router } = await applyPickProviderStack(cfg, cwd, {
    codexRetired, primaryHost, routing, aqeProvider, migrateRoutes,
  });
  if (router.ok) ok('saved to kit.json — reapplied on every `ak sync`; undo with `ak host off`');
  else warn('saved intent to kit.json, but AQE routing is incomplete — fix the warning above and re-run `ak sync`');
  if (seed.seeded) ok(`per-activity routing seeded — ${seed.count} activities (dual-host defaults; tune with --route or edit kit.json)`);
  printActivityRoutingTable(cfg);
  await maybeWriteQeCourtDefaults({ nonInteractive: input.nonInteractive, cwd, enabled, aqeProvider });
  printDualHostTips(cfg);
  return incompleteTeardown || !router.ok ? 1 : 0;
}
