// ak sync — converge to good. Plan comes from the same collector status
// uses; --dry-run prints it and stops. Apply order: upgrades first (they wipe
// natives), then heals, then re-collect to prove convergence.
import path from 'node:path';
import { collect } from './status.mjs';
import * as heal from '../lib/heal.mjs';
import { have } from '../lib/exec.mjs';
import { fixStatusline, helperStampStale } from '../lib/statusline.mjs';
import { reconcileGuidance } from '../lib/blocks.mjs';
import { register as mcpRegister, applyExclusions } from '../lib/mcp.mjs';
import { runLifecycle } from '../lib/adapters/lifecycle.mjs';
import { builtinHostsWithLifecycle, lifecycleAdapterFor } from '../lib/adapters/lifecycle-registry.mjs';
import { listDaemons, staleDaemons, reap } from '../lib/daemons.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { commandHosts, applyHosts, applyProviders, hostInstallState, installHost, applyAqeRouter, seedActivityRoutesIfMultiHost, migrateRetiredRoutesInConfig, ensureCodexMcp, ensureRufloMcpInCodex, bothHostsEnabled } from '../lib/providers.mjs';
import { driftReport, selfDrift } from '../lib/versions.mjs';
import { RUVECTOR_PKG, managed as ruvectorManaged } from '../lib/ruvector.mjs';
import { pruneNpxStale } from '../lib/npx.mjs';
import { runScaffoldAgentsFix } from '../lib/scaffold.mjs';
import { nativesStatus, securityPresent } from '../lib/natives.mjs';
import { readJson } from '../lib/settings.mjs';
import { appendToConfig } from '../lib/health-history.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, fail, info, bold, dim, withProgress, reportOutcome } from '../lib/output.mjs';
import { applyCodexStatusline, projectionFor } from '../lib/codex-statusline.mjs';

export const options = {
  'dry-run': { type: 'boolean', default: false },
  'no-upgrade': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

export const help = `ak sync — converge to good: upgrade + heal + verify

Builds a plan from the same collector \`ak status\` uses, then applies it in
order: upgrades first (they wipe native modules), then heals, then re-collects
to prove convergence. Idempotent — safe to run any time. When in doubt, run this.

Usage: ak sync [options]

Options:
  --dry-run       print the plan and stop; change nothing
  --no-upgrade    heal only; don't upgrade ruflo/aqe/kit versions
  --json          emit results as JSON

Examples:
  ak sync                 upgrade, heal, verify
  ak sync --dry-run       preview the plan
  ak sync --no-upgrade    re-heal without touching versions`;

export async function run({ flags, pkgRoot, fetchLatest }) {
  const cwd = process.cwd();
  // #134: draw the plan from CURRENT drift, not the TTL cache — a cache
  // stamped before an upstream release claims "all current" and the upgrade
  // never reaches the plan (the old force at apply time sat behind the very
  // versions gate it needed to open). Dry-runs skip the refresh: it writes
  // kit.json, and --dry-run is pinned to touch nothing — so a dry-run
  // preview may be cache-stale by up to one TTL window.
  if (!flags['dry-run'] && !flags['no-upgrade']) {
    await driftReport({ force: true, ...(fetchLatest ? { fetchLatest } : {}) });
  }
  const rows = await collect({ pkgRoot, cwd });
  const plan = rows.filter((r) => r.fix)
    .filter((r) => !(flags['no-upgrade'] && ['versions', 'self', 'ruvnet-brain', 'ruvector'].includes(r.subsystem)));

  if (plan.length === 0) { ok('nothing to do — all subsystems healthy'); return 0; }

  console.log(bold(`sync plan (${plan.length} action(s)):`));
  for (const p of plan) console.log(`  • [${p.subsystem}] ${p.fix} ${dim(`— because: ${p.message}`)}`);
  if (flags['dry-run']) return 0;
  console.log('');

  const cfg = loadKitConfig();
  const subsystems = new Set(plan.map((p) => p.subsystem));
  const report = reportOutcome;
  // Run a managed heal under a live elapsed-time ticker, then print its result.
  // Keeps every slow tool (npm upgrades, brain KB download, native rebuild)
  // visibly alive instead of freezing the prompt; fast/local steps clear in <1s.
  const step = async (name, thunk) => { const r = await withProgress(name, thunk); report(name, r); return r; };

  if (subsystems.has('codex-statusline') && cfg.statusline?.codex?.preset) {
    const preset = cfg.statusline.codex.preset;
    const r = applyCodexStatusline(preset);
    cfg.statusline.codex.lastProjection = projectionFor(preset);
    saveKitConfig(cfg);
    ok(`codex statusline: ${r.changed ? `restored ${preset} preset` : 'in sync'}`);
  }

  if (subsystems.has('versions') && !flags['no-upgrade']) {
    report('daemons', await heal.stopAllDaemons());
    // No force here: the pre-plan refresh above already ran for every
    // non-dry-run, non-no-upgrade sync, so this read hits that fresh cache.
    for (const d of await driftReport()) {
      if (d.outdated || !d.installed) await step(`upgrade ${d.pkg}`, () => heal.upgradePackage(d.pkg));
    }
  }
  // ruvnet-brain: install if absent / re-run installer to pull latest when
  // drifted (force bypasses the installer's skip-if-present). Not an npm pkg, so
  // it rides its own branch rather than the driftReport loop above.
  if (subsystems.has('ruvnet-brain') && !flags['no-upgrade']) {
    await step('ruvnet-brain', () => heal.installRuvnetBrain({ force: true }));
  }
  // ruvector: an unmanaged global users wire up as an MCP server by hand. Only
  // ever UPGRADED — status emits no row (and so no plan entry) when it is absent,
  // so this branch can never install it for someone who didn't opt in.
  // The status row already gates on registration + opt-in (an unregistered or
  // opted-out ruvector emits no `fix`, so it cannot reach this plan) — but this
  // branch installs software globally, so it re-checks rather than trusting the
  // plan to be the only guard.
  if (subsystems.has('ruvector') && !flags['no-upgrade'] && ruvectorManaged(cfg)) {
    await step('ruvector', () => heal.upgradePackage(RUVECTOR_PKG));
  }
  // The brain installer's own nightly self-updater (macOS LaunchAgent) bypasses
  // ak-managed updates — disabling it is a heal, not an upgrade, so it runs even
  // under --no-upgrade. Reversible: `npx ruvnet-brain --enable-nightly`.
  if (subsystems.has('ruvnet-brain-nightly')) {
    report('ruvnet-brain nightly', await heal.disableRuvnetBrainNightly());
  }
  // cfg.security gate: on `versions` this branch would otherwise heal the
  // security surface even when the user disabled it (`ak setup --no-security`).
  if ((subsystems.has('security') || subsystems.has('versions')) && cfg.security !== false) {
    await step('aidefence', () => heal.healAidefence());
    await step('aqe solver', () => heal.healAqeSolver());
  }
  // natives LAST among the npm-tree mutations. Every agentdb location resolves up
  // to the single shared ruflo/node_modules/better-sqlite3, so any later `npm
  // install` into the ruflo/aqe root re-resolves that copy and drops the freshly
  // built binding — project-scoped installs can't pass --allow-scripts, so the
  // build script never re-runs and a half-built build/ dir (obj/, sqlite3.a, no
  // .node) is left behind. Healing here means nothing reshapes the tree after us.
  // Runs on `security` too: an aidefence install wipes the binding even when the
  // plan never flagged natives.
  if (subsystems.has('natives') || subsystems.has('versions') || subsystems.has('security')) {
    await step('natives', () => heal.healNatives());
  }
  // npx: prune cached envs serving outdated ruflo-family code — the statusline/
  // hook `npx --prefer-offline` fallbacks execute these verbatim, so a stale env
  // keeps retired defects (the fabricated CVE counter) alive on an upgraded
  // machine. Runs on `versions` too: an upgrade is precisely what turns a
  // previously-current cache stale.
  if (subsystems.has('npx') || subsystems.has('versions')) {
    report('npx', pruneNpxStale());
  }
  // Scaffold agents: the row only carries a fix (and so only enters the plan)
  // when the installed CLI already ships `migrate fix --agents` (ruflo#2986) —
  // delegation, never a kit-side restore. If THIS sync's upgrade step is what
  // delivered the capability, the pre-upgrade plan won't include it; the next
  // `ak status`/`ak sync` picks it up (same one-pass-behind rule as any
  // upgrade-delivered fix).
  if (subsystems.has('scaffold-agents')) {
    await step('scaffold agents', () => runScaffoldAgentsFix(cwd));
  }
  if (subsystems.has('aqe')) {
    report('rvf', heal.healRvf(paths.projectAqeDir(cwd)));
  }
  // agentdb: install/repin the standalone CLI to ruflo's bundled version so the
  // shared cognitive store stays coherent (harvest's write path depends on it).
  if (subsystems.has('agentdb') && cfg.agentdb !== false) {
    await step('agentdb', () => heal.healAgentdb());
  }
  if (subsystems.has('mcp') && cfg.mcp.register) {
    const okReg = await withProgress('mcp', () => mcpRegister());
    if (okReg) {
      const { denied } = applyExclusions(cfg.mcp.excludeFamilies ?? []);
      ok(`mcp: claude-flow registered (user scope), ${denied} tool(s) denied per kit.json`);
    } else warn('mcp: claude mcp add failed — run: ak x mcp pick');
  }
  if (subsystems.has('daemons')) {
    const stale = staleDaemons(await listDaemons({ cwd }));
    for (const r of reap(stale)) {
      (r.killed ? ok : warn)(`daemon pid=${r.pid}: ${r.killed ? 'reaped' : 'could not stop'}`);
    }
  }
  // hosts: install any ENABLED host that is entirely absent (updates to
  // npm-managed hosts ride the versions branch above via driftReport).
  if (subsystems.has('hosts')) {
    for (const h of commandHosts()) {
      if (!cfg.integrations.hosts[h.id]) continue;
      if ((await hostInstallState(h)).method !== 'absent') continue;
      await step(`install ${h.id}`, () => installHost(h.id));
    }
  }
  // opencode host wiring: connected MCPs, compact lazy gateway, lifecycle
  // bridge, specialist dispatcher, and platform skill. Runs AFTER
  // the hosts install branch so an enable+install converges in one sync, and
  // only when the CLI is actually present — otherwise the writers would create
  // the host's config home for a host that isn't there (codex-review #4).
  // Runs BEFORE the blocks branch: the agents-opencode guidance target is gated
  // on the config home this branch creates — this order lets a fresh enable
  // converge guidance in the SAME sync (a second sync is then a true no-op).
  // Registry-driven: loops builtinHostsWithLifecycle() rather than naming
  // opencode, so a second BUILT-IN lifecycle host needs no new branch here.
  // Only opencode is registered today, so this loop runs exactly once —
  // byte-identical to the single-host branch it replaces. The result SHAPE
  // consumed below (stack.oc/plugin/agents/skill) is still opencode's own —
  // the lifecycle contract doesn't mandate a common `apply()` result shape
  // across hosts. builtinHostsWithLifecycle() (not hostsWithLifecycle())
  // deliberately excludes admitted external hosts — see lifecycle-registry.mjs.
  for (const hostId of builtinHostsWithLifecycle()) {
    if (!subsystems.has(hostId) || !cfg.integrations?.hosts?.[hostId]) continue;
    if (!(await have(hostId))) {
      info(`${hostId}: enabled but CLI not installed — wiring skipped (hosts step installs it)`);
      continue;
    }
    const lifecycle = await runLifecycle({
      adapter: lifecycleAdapterFor(hostId), action: 'apply', cfg, options: { pkgRoot },
    });
    const stack = lifecycle.result;
    // persist the markers on ANY refresh (a converged file whose kit.json
    // markers are stale/missing still needs the save, or the next teardown
    // cannot prove ownership — codex-review r3), not only on file changes.
    if (stack.oc.changed || stack.markersChanged) saveKitConfig(cfg);
    if (stack.oc.changed || !stack.oc.ok) report('opencode', stack.oc);
    report('opencode plugin', stack.plugin);
    report('opencode gateway', stack.gateway);
    report('opencode agent projection', stack.agents);
    if (stack.skill.changed || !stack.skill.ok) report('opencode skill', stack.skill);
  }
  // The 'opencode' guard: the opencode branch above can CREATE the config home
  // that activates the agents-opencode guidance target — a machine whose other
  // guidance is already converged (no blocks drift rows) would otherwise skip
  // this branch on a fresh enable and land the guidance one sync late
  // (codex-review r3). When the CLI is absent the target's own config-home
  // gate still refuses to fabricate anything.
  if (subsystems.has('blocks') || subsystems.has('versions') || subsystems.has('opencode')) {
    // The reconcile loop itself (targets, retired-row strips, dual-mode/
    // opencode flag gating) lives in blocks.mjs reconcileGuidance — shared
    // with setup's final pass so the two commands cannot drift (ADR-0008 on
    // target scoping).
    const ctx = { flags: { dualMode: bothHostsEnabled(cfg), opencodeEnabled: !!cfg.integrations?.hosts?.opencode } };
    for (const t of await reconcileGuidance({ cwd, cfg, pkgRoot, context: ctx })) {
      // stay quiet on the agents targets unless they actually changed (single-host
      // leaves them unmanaged); always report the claude target.
      if (t.name === 'claude' || t.changed) ok(`blocks(${t.label}): ${t.changed || 'in sync'}`);
    }
  }
  if (subsystems.has('providers') || subsystems.has('routing') || subsystems.has('codex-mcp')) {
    report('providers', applyHosts(cfg, cwd));
    // heal per-activity routing: seed from defaults if dual-host only just became
    // eligible (e.g. aqe upgraded ≥3.13.1 since enablement), before materializing.
    const seed = seedActivityRoutesIfMultiHost(cfg);
    if (seed.seeded) { saveKitConfig(cfg); report('routing', { ok: true, changed: true, detail: `seeded ${seed.count} activities` }); }
    // Retire withdrawn models from the persisted policy. Distinct from divergence
    // (which stays an explicit `ak x host refresh` decision): a retired model
    // stops answering, so leaving it named on disk is a scheduled failure. Only
    // seeded entries are rewritten; a user pin is reported and left alone.
    const retired = migrateRetiredRoutesInConfig(cfg);
    if (retired.changes.length > 0) {
      if (retired.changed) saveKitConfig(cfg);
      for (const c of retired.changes) {
        const when = c.retiresOn ? `retires ${c.retiresOn}` : 'already withdrawn';
        report('routing', c.rewritten
          ? { ok: true, changed: true, detail: `${c.activity} ${c.field}: ${c.from} → ${c.to} (${when})` }
          : { ok: true, changed: false, detail: `${c.activity} ${c.field} pins ${c.from} (${when}) — user pin kept; ak runs ${c.to}` });
      }
    }
    const router = applyAqeRouter(cfg, cwd);
    if (router.changed || !router.ok) report('aqe router', router);
    const mcp = await ensureCodexMcp(cfg, cwd);
    if (mcp.changed) saveKitConfig(cfg);
    if (mcp.changed || !mcp.ok) report('codex MCP', mcp);
    // reverse bridge: register ruflo MCP into codex (codex→ruflo half)
    const rmcp = await ensureRufloMcpInCodex(cfg, cwd);
    if (rmcp.changed) saveKitConfig(cfg);
    if (rmcp.changed || !rmcp.ok) report('ruflo→codex MCP', rmcp);
    const prov = await withProgress('providers (api)', () => applyProviders(cfg, cwd));
    if (prov.changed || !prov.ok) report('providers (api)', prov);
  }
  // Gate includes 'providers': applyProviders runs ruflo CLI commands, and any
  // ruflo command is a potential helper-refresh wiper — so a providers-only
  // sync must re-heal the statusline afterwards (this step runs after the
  // providers step by design). Without this, a stale-oracle miss could let a
  // providers sync wipe the footer with no re-inject planned.
  if (subsystems.has('statusline') || subsystems.has('versions') || subsystems.has('providers')) {
    // withProgress: fixStatusline blocks on a node subprocess (ruflo's helper
    // refresh, up to 30s). The interval can't animate through a synchronous
    // execFileSync, but the initial "⏳ statusline" render lands before the
    // block — a visible label beats a frozen prompt.
    const r = await withProgress('statusline', async () => fixStatusline(cwd));
    (r.applied || !r.reason ? ok : warn)(`statusline: ${r.applied ? `footer injected (v${r.version})` : r.reason ?? 'in sync'}`);
    // Honest success: fixStatusline invokes ruflo's PRIVATE helper-refresh
    // internal, best-effort. If the stamp is STILL stale after the heal, that
    // refresh silently no-oped (e.g. upstream moved the dist module) and the
    // next ruflo command will wipe the footer we just injected — say so
    // instead of letting "footer injected" read as converged.
    if (helperStampStale(cwd)) {
      warn('statusline: helper stamp still stale after heal — ruflo\'s refresh did not run; the footer may not survive the next ruflo command');
    }
  }

  // kit self-update — LAST, after every other heal: npm replaces the kit's
  // files on disk, and the new code applies from the next ak run, so nothing
  // after this point should depend on the kit's own modules being current.
  if (subsystems.has('self') && !flags['no-upgrade']) {
    const s = await selfDrift({ pkgRoot, force: true });
    if (s.outdated) await step('self-update', () => heal.selfUpdate(s.latest));
  }

  // converge proof
  console.log('');
  const after = await collect({ pkgRoot, cwd });

  // health-history: append one post-heal snapshot so `status` can flag backslides
  // (learning shrank, native slots dropped, drift/security regressed) across syncs.
  try {
    const stats = readJson(path.join(paths.projectClaudeFlowDir(cwd), 'neural', 'stats.json'));
    appendToConfig(cfg, {
      ts: Math.floor(Date.now() / 1000),
      // learningRows is PROJECT-local (this cwd's learning store) in a MACHINE-
      // global ring, so stamp the project and record null (unknown) when the
      // store is absent — a fabricated 0 would let a sync run from a store-less
      // project fake a "learning shrank" alarm against another project's count.
      project: cwd,
      learningRows: Number.isFinite(stats?.patternsLearned) ? stats.patternsLearned : null,
      // Count NATIVE bindings (incl. the aqe slot), not directories: a location
      // flipping native→WASM must move this number or the regression detector
      // named "native agentdb slots dropped" can never fire; and a benign tree
      // reshape (a location legitimately vanishing) must not fake an alarm
      // when its binding was WASM anyway.
      nativeSlots: (() => {
        const n = nativesStatus();
        return (n?.locations?.filter((l) => l.native).length ?? 0) + (n?.aqe?.native ? 1 : 0);
      })(),
      driftOutdated: (await driftReport()).some((r) => !r.installed || r.outdated),
      securityPresent: securityPresent(),
    });
    saveKitConfig(cfg);
  } catch { /* health snapshot is best-effort — never fail a sync over it */ }

  const remaining = after.filter((r) => r.level === 'fail');
  if (remaining.length === 0) {
    ok(bold('converged — no failing subsystems'));
    info(dim('📊 dashboard: run `ak dashboard` → opens http://127.0.0.1:7431 (local, read-only)'));
    return 0;
  }
  for (const r of remaining) fail(`still failing: [${r.subsystem}] ${r.message}`);
  return 1;
}
