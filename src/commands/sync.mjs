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
import { hostsWithLifecycle, lifecycleAdapterFor, lifecycleExecutionEnabled, detectionBinFor } from '../lib/adapters/lifecycle-registry.mjs';
import { companionLifecycleFor } from '../lib/adapters/companion-lifecycle-registry.mjs';
import { renderApplyReport } from '../lib/adapters/lifecycle-render.mjs';
import { listDaemons, staleDaemons, reap } from '../lib/daemons.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { commandHosts, hostInstallState, installHost, convergeProviderStack, guidanceContext } from '../lib/providers.mjs';
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

/** Prints one lifecycle-render.mjs report line at its own level — 'fail'
 *  (F5, Wave C security review) reaches `fail()`, not a fallback `info()`,
 *  so a genuinely failed opencode sub-surface never reads as merely
 *  informational. */
function printReportLine(line) {
  if (line.level === 'ok') ok(line.text);
  else if (line.level === 'warn') warn(line.text);
  else if (line.level === 'fail') fail(line.text);
  else info(line.text);
}

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

// ── the sync step registry ───────────────────────────────────────────────────
// Every heal used to be a `if (subsystems.has(X)) { ... }` block inlined into
// `run()`, with real ordering invariants (natives LAST among npm-tree
// mutations, statusline AFTER providers, kit self-update LAST of all) proven
// only by source-order and explained only in comments — nothing stopped a
// future edit from reordering them apart. Each step below is
// `{id, when(subsystems, flags, cfg), run(ctx)}`; SYNC_STEPS's array order
// *is* the ordering invariant, and `when` is a pure, explicitly-parameterized
// predicate (no closures) so it stays easy to reason about independent of
// `run`'s side effects. `run(ctx)` receives the shared per-invocation context
// (see `run()` below): {cfg, cwd, pkgRoot, flags, dejaVuAdapter, subsystems,
// report, step, state}. `state` carries the two cross-step signals
// (`dejaVuApplyFailed`, `aqeRouterApplyFailure`) the final convergence check
// needs — the only state that survives past its own step.
export const SYNC_STEPS = [
  {
    id: 'codex-statusline',
    when: (subs, flags, cfg) => subs.has('codex-statusline') && !!cfg.statusline?.codex?.preset,
    run: (ctx) => {
      const preset = ctx.cfg.statusline.codex.preset;
      const r = applyCodexStatusline(preset);
      ctx.cfg.statusline.codex.lastProjection = projectionFor(preset);
      saveKitConfig(ctx.cfg);
      ok(`codex statusline: ${r.changed ? `restored ${preset} preset` : 'in sync'}`);
    },
  },
  {
    id: 'versions',
    when: (subs, flags) => subs.has('versions') && !flags['no-upgrade'],
    run: async (ctx) => {
      ctx.report('daemons', await heal.stopAllDaemons());
      // No force here: the pre-plan refresh in run() already ran for every
      // non-dry-run, non-no-upgrade sync, so this read hits that fresh cache.
      for (const d of await driftReport()) {
        if (d.outdated || !d.installed) await ctx.step(`upgrade ${d.pkg}`, () => heal.upgradePackage(d.pkg));
      }
    },
  },
  // ruvnet-brain: install if absent / re-run installer to pull latest when
  // drifted (force bypasses the installer's skip-if-present). Not an npm pkg, so
  // it rides its own step rather than the driftReport loop above.
  {
    id: 'ruvnet-brain',
    when: (subs, flags) => subs.has('ruvnet-brain') && !flags['no-upgrade'],
    run: (ctx) => ctx.step('ruvnet-brain', () => heal.installRuvnetBrain({ force: true })),
  },
  // ruvector: an unmanaged global users wire up as an MCP server by hand. Only
  // ever UPGRADED — status emits no row (and so no plan entry) when it is absent,
  // so this step can never install it for someone who didn't opt in. The status
  // row already gates on registration + opt-in (an unregistered or opted-out
  // ruvector emits no `fix`, so it cannot reach this plan) — but this step
  // installs software globally, so it re-checks rather than trusting the plan
  // to be the only guard.
  {
    id: 'ruvector',
    when: (subs, flags, cfg) => subs.has('ruvector') && !flags['no-upgrade'] && ruvectorManaged(cfg),
    run: (ctx) => ctx.step('ruvector', () => heal.upgradePackage(RUVECTOR_PKG)),
  },
  // The brain installer's own nightly self-updater (macOS LaunchAgent) bypasses
  // ak-managed updates — disabling it is a heal, not an upgrade, so it runs even
  // under --no-upgrade. Reversible: `npx ruvnet-brain --enable-nightly`.
  {
    id: 'ruvnet-brain-nightly',
    when: (subs) => subs.has('ruvnet-brain-nightly'),
    run: async (ctx) => ctx.report('ruvnet-brain nightly', await heal.disableRuvnetBrainNightly()),
  },
  // cfg.security gate: on `versions` this step would otherwise heal the
  // security surface even when the user disabled it (`ak setup --no-security`).
  {
    id: 'security',
    when: (subs, flags, cfg) => (subs.has('security') || subs.has('versions')) && cfg.security !== false,
    run: async (ctx) => {
      await ctx.step('aidefence', () => heal.healAidefence());
      await ctx.step('aqe solver', () => heal.healAqeSolver());
    },
  },
  // natives LAST among the npm-tree mutations. Every agentdb location resolves up
  // to the single shared ruflo/node_modules/better-sqlite3, so any later `npm
  // install` into the ruflo/aqe root re-resolves that copy and drops the freshly
  // built binding — project-scoped installs can't pass --allow-scripts, so the
  // build script never re-runs and a half-built build/ dir (obj/, sqlite3.a, no
  // .node) is left behind. Healing here means nothing reshapes the tree after us.
  // Runs on `security` too: an aidefence install wipes the binding even when the
  // plan never flagged natives. (Array position, not this comment, is what keeps
  // it last among those three sibling gates — see the section note above.)
  {
    id: 'natives',
    when: (subs) => subs.has('natives') || subs.has('versions') || subs.has('security'),
    run: (ctx) => ctx.step('natives', () => heal.healNatives()),
  },
  // npx: prune cached envs serving outdated ruflo-family code — the statusline/
  // hook `npx --prefer-offline` fallbacks execute these verbatim, so a stale env
  // keeps retired defects (the fabricated CVE counter) alive on an upgraded
  // machine. Runs on `versions` too: an upgrade is precisely what turns a
  // previously-current cache stale.
  {
    id: 'npx',
    when: (subs) => subs.has('npx') || subs.has('versions'),
    run: (ctx) => ctx.report('npx', pruneNpxStale()),
  },
  // Scaffold agents: the row only carries a fix (and so only enters the plan)
  // when the installed CLI already ships `migrate fix --agents` (ruflo#2986) —
  // delegation, never a kit-side restore. If THIS sync's upgrade step is what
  // delivered the capability, the pre-upgrade plan won't include it; the next
  // `ak status`/`ak sync` picks it up (same one-pass-behind rule as any
  // upgrade-delivered fix).
  {
    id: 'scaffold-agents',
    when: (subs) => subs.has('scaffold-agents'),
    run: (ctx) => ctx.step('scaffold agents', () => runScaffoldAgentsFix(ctx.cwd)),
  },
  {
    id: 'aqe-rvf',
    when: (subs) => subs.has('aqe'),
    run: (ctx) => ctx.report('rvf', heal.healRvf(paths.projectAqeDir(ctx.cwd))),
  },
  // agentdb: install/repin the standalone CLI to ruflo's bundled version so the
  // shared cognitive store stays coherent (harvest's write path depends on it).
  {
    id: 'agentdb',
    when: (subs, flags, cfg) => subs.has('agentdb') && cfg.agentdb !== false,
    run: (ctx) => ctx.step('agentdb', () => heal.healAgentdb()),
  },
  {
    id: 'mcp',
    when: (subs, flags, cfg) => subs.has('mcp') && cfg.mcp.register,
    run: async (ctx) => {
      const okReg = await withProgress('mcp', () => mcpRegister());
      if (okReg) {
        const { denied } = applyExclusions(ctx.cfg.mcp.excludeFamilies ?? []);
        ok(`mcp: claude-flow registered (user scope), ${denied} tool(s) denied per kit.json`);
      } else warn('mcp: claude mcp add failed — run: ak x mcp pick');
    },
  },
  {
    id: 'daemons',
    when: (subs) => subs.has('daemons'),
    run: async (ctx) => {
      const stale = staleDaemons(await listDaemons({ cwd: ctx.cwd }));
      for (const r of reap(stale)) {
        (r.killed ? ok : warn)(`daemon pid=${r.pid}: ${r.killed ? 'reaped' : 'could not stop'}`);
      }
    },
  },
  // hosts: install any ENABLED host that is entirely absent (updates to
  // npm-managed hosts ride the `versions` step above via driftReport).
  {
    id: 'hosts',
    when: (subs) => subs.has('hosts'),
    run: async (ctx) => {
      for (const h of commandHosts()) {
        if (!ctx.cfg.integrations.hosts[h.id]) continue;
        if ((await hostInstallState(h)).method !== 'absent') continue;
        await ctx.step(`install ${h.id}`, () => installHost(h.id));
      }
    },
  },
  // Managed companion convergence is independent from host lifecycle
  // adapters. The adapter owns exact package/target/index ordering and mutates
  // only its in-memory ownership ledger; this command owns persistence. Save a
  // changed ledger even after a partial failure so a later sync or uninstall
  // retains the proof for every operation that did verify successfully.
  {
    id: 'deja-vu',
    when: (subs) => subs.has('deja-vu'),
    run: async (ctx) => {
      if (!ctx.dejaVuAdapter) return;
      const lifecycle = await withProgress('deja-vu', () => runLifecycle({
        adapter: ctx.dejaVuAdapter,
        action: 'apply',
        cfg: ctx.cfg,
        options: { pkgRoot: ctx.pkgRoot, allowUpgrade: !ctx.flags['no-upgrade'] },
      }));
      if (lifecycle.configChanged) saveKitConfig(ctx.cfg);
      ctx.state.dejaVuApplyFailed = lifecycle.ok === false;
      const applyReport = renderApplyReport('deja-vu', lifecycle);
      for (const line of applyReport.lines) printReportLine(line);
    },
  },
  // opencode host wiring: connected MCPs, compact lazy gateway, lifecycle
  // bridge, specialist dispatcher, and platform skill. Runs AFTER the `hosts`
  // step so an enable+install converges in one sync, and only when the CLI is
  // actually present — otherwise the writers would create the host's config
  // home for a host that isn't there (codex-review #4). Runs BEFORE `blocks`:
  // the agents-opencode guidance target is gated on the config home this step
  // creates — this order lets a fresh enable converge guidance in the SAME
  // sync (a second sync is then a true no-op). Registry-driven: loops
  // hostsWithLifecycle() (built-ins + admitted, ADR-0031 P3) rather than
  // naming opencode, so a second lifecycle host — built-in or admitted —
  // needs no new step here. lifecycleExecutionEnabled gates each host exactly
  // as setup.mjs does (built-in: cfg enablement only; admitted: cfg
  // enablement AND the experimental flag — never auto-enabled).
  // lifecycle-render.mjs's renderApplyReport dispatches on the runLifecycle
  // result's own shape, so this loop body never destructures a host-specific
  // result directly; opencode's per-surface lines render exactly as before.
  {
    id: 'host-lifecycles',
    when: () => true,
    run: async (ctx) => {
      for (const hostId of hostsWithLifecycle()) {
        if (!ctx.subsystems.has(hostId) || !lifecycleExecutionEnabled(hostId, ctx.cfg)) continue;
        if (!(await have(detectionBinFor(hostId)))) {
          info(`${hostId}: enabled but CLI not installed — wiring skipped (hosts step installs it)`);
          continue;
        }
        const lifecycle = await runLifecycle({
          adapter: lifecycleAdapterFor(hostId), action: 'apply', cfg: ctx.cfg, options: { pkgRoot: ctx.pkgRoot },
        });
        const applyReport = renderApplyReport(hostId, lifecycle);
        // persist the markers on ANY refresh (a converged file whose kit.json
        // markers are stale/missing still needs the save, or the next teardown
        // cannot prove ownership — codex-review r3), not only on file changes.
        if (applyReport.ocChanged || applyReport.markersChanged) saveKitConfig(ctx.cfg);
        for (const line of applyReport.lines) printReportLine(line);
      }
    },
  },
  // The 'opencode' guard: the host-lifecycles step above can CREATE the config
  // home that activates the agents-opencode guidance target — a machine whose
  // other guidance is already converged (no blocks drift rows) would otherwise
  // skip this step on a fresh enable and land the guidance one sync late
  // (codex-review r3). When the CLI is absent the target's own config-home
  // gate still refuses to fabricate anything.
  {
    id: 'blocks',
    when: (subs) => subs.has('blocks') || subs.has('versions') || subs.has('opencode'),
    run: async (ctx) => {
      // The reconcile loop itself (targets, retired-row strips, dual-mode/
      // opencode flag gating) lives in blocks.mjs reconcileGuidance — shared
      // with setup's final pass so the two commands cannot drift (ADR-0008 on
      // target scoping; providers.mjs's guidanceContext is the shared ctx
      // shape both commands build).
      for (const t of await reconcileGuidance({
        cwd: ctx.cwd, cfg: ctx.cfg, pkgRoot: ctx.pkgRoot, context: guidanceContext(ctx.cfg),
      })) {
        // stay quiet on the agents targets unless they actually changed
        // (single-host leaves them unmanaged); always report the claude target.
        if (t.name === 'claude' || t.changed) ok(`blocks(${t.label}): ${t.changed || 'in sync'}`);
      }
    },
  },
  {
    id: 'providers',
    when: (subs) => subs.has('providers') || subs.has('routing') || subs.has('codex-mcp'),
    run: async (ctx) => {
      // The shared pipeline (providers.mjs's convergeProviderStack) computes
      // and persists every step; this reporter only decides what to print and
      // how, preserving sync's exact wording/gating per step.
      const reporter = (step, result) => {
        if (step === 'hosts') { ctx.report('providers', result); return; }
        // heal per-activity routing: seed from defaults if dual-host only just
        // became eligible (e.g. aqe upgraded ≥3.13.1 since enablement), before
        // materializing.
        if (step === 'routing-seed') {
          if (result.seeded) ctx.report('routing', { ok: true, changed: true, detail: `seeded ${result.count} activities` });
          return;
        }
        // Retire withdrawn models from the persisted policy. Distinct from
        // divergence (which stays an explicit `ak x host refresh` decision): a
        // retired model stops answering, so leaving it named on disk is a
        // scheduled failure. Only seeded entries are rewritten; a user pin is
        // reported and left alone.
        if (step === 'routing-retired') {
          for (const c of result.changes) {
            const when = c.retiresOn ? `retires ${c.retiresOn}` : 'already withdrawn';
            ctx.report('routing', c.rewritten
              ? { ok: true, changed: true, detail: `${c.activity} ${c.field}: ${c.from} → ${c.to} (${when})` }
              : { ok: true, changed: false, detail: `${c.activity} ${c.field} pins ${c.from} (${when}) — user pin kept; ak runs ${c.to}` });
          }
          return;
        }
        if (step === 'aqe-router') {
          if (result.changed || !result.ok) ctx.report('aqe router', result);
          if (!result.ok) ctx.state.aqeRouterApplyFailure = result.detail || 'AQE router apply failed';
          return;
        }
        if (step === 'legacy-codex-mcp') {
          if (result.changed || !result.ok) ctx.report('legacy codex MCP', result);
          return;
        }
        // Independent Ruflo integration for Codex-driven sessions.
        if (step === 'ruflo-codex-mcp') {
          if (result.changed || !result.ok) ctx.report('ruflo→codex MCP', result);
          return;
        }
        if (step === 'providers-api' && (result.changed || !result.ok)) ctx.report('providers (api)', result);
      };
      await convergeProviderStack(ctx.cfg, ctx.cwd, {
        reporter,
        runProviders: (fn) => withProgress('providers (api)', fn),
      });
    },
  },
  // Gate includes 'providers': applyProviders runs ruflo CLI commands, and any
  // ruflo command is a potential helper-refresh wiper — so a providers-only
  // sync must re-heal the statusline afterwards (this step runs after the
  // `providers` step by design — array position, not comments, keeps it so).
  // Without this, a stale-oracle miss could let a providers sync wipe the
  // footer with no re-inject planned.
  {
    id: 'statusline',
    when: (subs) => subs.has('statusline') || subs.has('versions') || subs.has('providers'),
    run: async (ctx) => {
      // withProgress: fixStatusline blocks on a node subprocess (ruflo's helper
      // refresh, up to 30s). The interval can't animate through a synchronous
      // execFileSync, but the initial "⏳ statusline" render lands before the
      // block — a visible label beats a frozen prompt.
      const r = await withProgress('statusline', async () => fixStatusline(ctx.cwd));
      (r.applied || !r.reason ? ok : warn)(`statusline: ${r.applied ? `footer injected (v${r.version})` : r.reason ?? 'in sync'}`);
      // Honest success: fixStatusline invokes ruflo's PRIVATE helper-refresh
      // internal, best-effort. If the stamp is STILL stale after the heal, that
      // refresh silently no-oped (e.g. upstream moved the dist module) and the
      // next ruflo command will wipe the footer we just injected — say so
      // instead of letting "footer injected" read as converged.
      if (helperStampStale(ctx.cwd)) {
        warn('statusline: helper stamp still stale after heal — ruflo\'s refresh did not run; the footer may not survive the next ruflo command');
      }
    },
  },
  // kit self-update — LAST, after every other heal: npm replaces the kit's
  // files on disk, and the new code applies from the next ak run, so nothing
  // after this point should depend on the kit's own modules being current.
  // (Array position — the final entry in SYNC_STEPS — is the invariant.)
  {
    id: 'self',
    when: (subs, flags) => subs.has('self') && !flags['no-upgrade'],
    run: async (ctx) => {
      const s = await selfDrift({ pkgRoot: ctx.pkgRoot, force: true });
      if (s.outdated) await ctx.step('self-update', () => heal.selfUpdate(s.latest));
    },
  },
];

export async function run({
  flags,
  pkgRoot,
  fetchLatest,
  dejaVuAdapter = companionLifecycleFor('deja-vu'),
  collectFn = collect,
}) {
  const cwd = process.cwd();
  const dejaVuPlanOptions = { allowUpgrade: !flags['no-upgrade'] };
  // #134: draw the plan from CURRENT drift, not the TTL cache — a cache
  // stamped before an upstream release claims "all current" and the upgrade
  // never reaches the plan (the old force at apply time sat behind the very
  // versions gate it needed to open). Dry-runs skip the refresh: it writes
  // kit.json, and --dry-run is pinned to touch nothing — so a dry-run
  // preview may be cache-stale by up to one TTL window.
  if (!flags['dry-run'] && !flags['no-upgrade']) {
    await driftReport({ force: true, ...(fetchLatest ? { fetchLatest } : {}) });
  }
  const rows = await collectFn({ pkgRoot, cwd, dejaVuAdapter, dejaVuPlanOptions });
  const plan = rows.filter((r) => r.fix)
    // Model lifecycle actions are explicit advisory commands. `ak status` must
    // name them, but sync neither refreshes catalogs nor applies model plans.
    .filter((r) => r.subsystem !== 'models')
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
  const state = { dejaVuApplyFailed: false, aqeRouterApplyFailure: null };
  const ctx = {
    cfg, cwd, pkgRoot, flags, dejaVuAdapter, subsystems, report, step, state,
  };

  for (const s of SYNC_STEPS) {
    if (s.when(subsystems, flags, cfg)) await s.run(ctx);
  }

  // converge proof
  console.log('');
  const after = await collectFn({ pkgRoot, cwd, dejaVuAdapter, dejaVuPlanOptions });

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

  const remaining = after.filter((r) => r.level === 'fail'
    || (r.subsystem === 'deja-vu' && r.fix !== null));
  // Collector rows describe persisted state after the heal, but they cannot
  // erase an apply failure from this run. In particular, an unavailable
  // external fallback can leave only a warning row; claiming convergence
  // after applyAqeRouter returned !ok is a false success and retry loop.
  if (state.aqeRouterApplyFailure && !remaining.some((r) => r.subsystem === 'providers')) {
    remaining.push({ subsystem: 'providers', message: `AQE router apply failed: ${state.aqeRouterApplyFailure}` });
  }
  if (state.dejaVuApplyFailed && !remaining.some((r) => r.subsystem === 'deja-vu')) {
    remaining.push({ subsystem: 'deja-vu', message: 'companion lifecycle apply failed' });
  }
  if (remaining.length === 0) {
    ok(bold('converged — no failing subsystems'));
    info(dim('📊 dashboard: run `ak dashboard` → opens http://127.0.0.1:7431 (local, read-only)'));
    return 0;
  }
  for (const r of remaining) fail(`still failing: [${r.subsystem}] ${r.message}`);
  return 1;
}
