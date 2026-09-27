// ak sync — converge to good. Plan comes from the same collector status
// uses; --dry-run prints it and stops. Apply order: upgrades first (they wipe
// natives), then heals, then re-collect to prove convergence.
import path from 'node:path';
import { manageCodexContext } from '../lib/codex-context.mjs';
import readline from 'node:readline/promises';
import { collect } from './status.mjs';
import { row } from './status/row.mjs';
import { stripUnsafeChars } from '../lib/text-safety.mjs';
import * as heal from '../lib/heal.mjs';
import { have } from '../lib/exec.mjs';
import { fixStatusline, helperStampStale, runHelperRefresh, bakedVersionManualFix } from '../lib/statusline.mjs';
import { reconcileGuidance } from '../lib/blocks.mjs';
import {
  register as mcpRegister, applyExclusions, codexMcpTopology, codexMcpRepairPlan,
  repairCodexMcpTopology, legacyRufloRemovalCommands,
} from '../lib/mcp.mjs';
import { runLifecycle } from '../lib/adapters/lifecycle.mjs';
import { hostsWithLifecycle, lifecycleAdapterFor, lifecycleExecutionEnabled, detectionBinFor } from '../lib/adapters/lifecycle-registry.mjs';
import { companionLifecycleFor } from '../lib/adapters/companion-lifecycle-registry.mjs';
import { renderApplyReport } from '../lib/adapters/lifecycle-render.mjs';
import { listDaemons, staleDaemons, reap } from '../lib/daemons.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { reconcileRufloComponents } from '../lib/ruflo-components/apply.mjs';
import { RESTART_REMINDER } from './status/sections/ruflo-components.mjs';
import { HOSTS, commandHosts, hostInstallState, hostExecutable, installHost, convergeProviderStack, guidanceContext, reportRetiredRouteChanges } from '../lib/providers.mjs';
import { driftReport, selfDrift } from '../lib/versions.mjs';
import { drift as ruvnetBrainDrift } from '../lib/ruvnet-brain.mjs';
import { RUVECTOR_PKG, managed as ruvectorManaged } from '../lib/ruvector.mjs';
import { pruneNpxStale } from '../lib/npx.mjs';
import { runScaffoldAgentsFix } from '../lib/scaffold.mjs';
import { nativesStatus, securityPresent } from '../lib/natives.mjs';
import { readJson } from '../lib/settings.mjs';
import { appendToConfig } from '../lib/health-history.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, fail, info, bold, dim, withProgress, reportOutcome } from '../lib/output.mjs';
import { applyCodexStatusline, projectionFor } from '../lib/codex-statusline.mjs';
import { ensureAgentBrowser } from '../lib/agent-browser.mjs';
import { confirmCodexMcpRepairs, reconcileCodexMcp } from '../lib/codex-mcp-reconcile.mjs';
import { alignHosts } from './x/host-align.mjs';
import { prepareAqeEmbedding } from '../lib/aqe-embedding-lifecycle.mjs';
import { reconcileAqeEmbeddingProjections } from '../lib/aqe-embedding-projection.mjs';
import { rememberLiveCheck, embeddingCheckOutcome } from '../lib/live-check-evidence.mjs';

async function askCodexRepair(question) {
  if (!process.stdin.isTTY) {
    fail('Codex repairs need confirmation; re-run with --yes in a non-interactive session');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}

/** Prints one lifecycle-render.mjs report line at its own level — 'fail'
 *  (F5, Wave C security review) reaches `fail()`, not a fallback `info()`,
 *  so a genuinely failed opencode sub-surface never reads as merely
 *  informational. */
function printReportLine(line, onFail) {
  if (line.level === 'ok') ok(line.text);
  else if (line.level === 'warn') warn(line.text);
  else if (line.level === 'fail') { fail(line.text); onFail?.(); }
  else info(line.text);
}

/** A package update can change the source catalog used by a lifecycle host.
 * Re-enter its idempotent apply path in the same sync, rather than leaving a
 * fresh package paired with its prior generated projection until another run. */
export function lifecycleRefreshRequired(subsystems, hostId) {
  return subsystems.has(hostId) || (hostId === 'opencode' && subsystems.has('versions'));
}

/** Print the plan, or why there is none, the items --skip took out of it, and
 *  the count of manual steps sync leaves to the user (status/row.mjs repair
 *  contract). With manual or skipped items left, an empty plan is never
 *  reported as "all subsystems healthy". Returns false when there is nothing
 *  to apply. */
function announcePlan(plan, manual, skipped) {
  const manualNote = `${manual.length} item(s) need a manual step — \`ak status\` shows them as "→ manual:"`;
  if (plan.length) {
    console.log(bold(`sync plan (${plan.length} action(s)):`));
    for (const p of plan) console.log(`  • [${p.subsystem}] ${p.fix} ${dim(`— because: ${p.message}`)}`);
  } else if (skipped.length) info(`nothing to do — ${skipped.length} planned item(s) skipped by request`);
  else if (manual.length) info(`nothing sync can do — ${manualNote}`);
  else ok('nothing to do — all subsystems healthy');
  for (const s of skipped) info(dim(`skipped by request: [${s.subsystem}] ${s.fix}`));
  if (manual.length && (plan.length || skipped.length)) info(dim(manualNote));
  return plan.length > 0;
}

/** Preserve a failed mutation for the final convergence proof. A failed heal
 * may leave an existing but stale capability on disk, so post-heal presence
 * alone is not success evidence. */
export function recordApplyFailure(state, name, result) {
  if (result?.ok === false) state.applyFailures.push({ name, detail: result.detail || `exit ${result.status || 'failed'}` });
}

/** Refresh every network-backed fact that can open an upgrade gate. Kept out
 *  of run() so adding one release boundary does not grow the command's already
 *  broad orchestration complexity. Sequential: these probes persist kit.json. */
async function refreshPlanDrift(flags, fetchLatest, pkgRoot) {
  if (flags['dry-run'] || flags['no-upgrade']) return;
  await driftReport({ force: true, ...(fetchLatest ? { fetchLatest } : {}) });
  // Self-update has its own TTL cache; refresh it before the collector decides
  // whether a self action exists. An apply-time refresh cannot open that gate.
  await selfDrift({ pkgRoot, force: true, ...(fetchLatest ? { fetchLatest } : {}) });
  // Brain releases have a second executability fact beyond the tag: the
  // required ruvnet-brain.zip asset. A tag-only release is not actionable.
  if (loadKitConfig().ruvnetBrain) await ruvnetBrainDrift({ force: true });
}

export const options = {
  'dry-run': { type: 'boolean', default: false },
  'no-upgrade': { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  skip: { type: 'string', multiple: true },
};

export const help = `ak sync — converge to good: upgrade + heal + verify

Builds a plan from the same collector \`ak status\` uses, then applies it in
order: upgrades first (they wipe native modules), then heals, then re-collects
to prove convergence. Idempotent — safe to run any time. When in doubt, run this.
Only fixes a sync step performs are planned; a status row marked "→ manual:"
(a command you run, a file you edit, a login) is counted but never applied.
A planned fix whose row is still there after the apply phase is reported as
"unresolved: [subsystem] fix — reason", and sync exits 1.

--skip leaves a subsystem out of this run only; kit.json is unchanged. Its
plan items, the step it owns (even when another planned subsystem would
trigger that step), and a fix only that step performs are all skipped, and
none of them counts as a failure. A step shared by several subsystems (for
example providers, which also serves routing) still runs for the others.
An unknown name is rejected with the list of names sync accepts.

--json writes every human line (the plan, step results, prompts) to stderr
and exactly one JSON object to stdout, pretty-printed as \`ak status --json\`:
  { plan[], steps[{id, ok, detail}], unresolved[], skipped[], converged, exitCode }
plan and skipped items carry status's row fields (subsystem, level, message,
fix, repair); each unresolved item has a reason: not-converged, no-step,
failing, apply-failed, or declined. converged is null when the run stopped
before a verdict (a dry run with a plan, a rejected flag, an error); an error
also sets "error". The exit code equals exitCode.

Usage: ak sync [options]

Options:
  --dry-run            print the plan and stop; change nothing
  --no-upgrade         heal only; don't upgrade ruflo/aqe/kit versions
  --skip SUBSYSTEM     leave SUBSYSTEM out of this run (repeatable, or
                       comma-separated: --skip natives,ruvnet-brain)
  --yes                approve disclosed repairs without prompting
  --json               one JSON result on stdout; human output on stderr

Examples:
  ak sync                          upgrade, heal, verify
  ak sync --dry-run                preview the plan
  ak sync --no-upgrade             re-heal without touching versions
  ak sync --skip ruvnet-brain      everything except the Brain refresh
  ak sync --json 2>sync.log        machine-readable result for CI`;

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
// (see `converge()` below): {cfg, cwd, pkgRoot, flags, dejaVuAdapter, subsystems,
// skip, report, step, markFailed, state}. `state` carries the two cross-step signals
// (`dejaVuApplyFailed`, `aqeRouterApplyFailure`) the final convergence check
// needs — the only state that survives past its own step.
const HOST_LIFECYCLE = { installState: hostInstallState, executable: hostExecutable, install: installHost };

/** A host package's CLI must start after an upgrade, not just extract. */
export function hostUpgradeOptions(pkg) {
  const host = HOSTS.find((h) => h.pkg === pkg);
  return host ? { bin: host.bin } : {};
}

export const SYNC_STEPS = [
  {
    id: 'agent-browser',
    when: (subs, flags, cfg) => subs.has('agent-browser') && cfg.agentBrowser !== false,
    run: async (ctx) => {
      const result = await ctx.step('agent-browser', () => ensureAgentBrowser(ctx.cfg, {
        installBrowser: true,
        allowUpgrade: !ctx.flags['no-upgrade'],
      }));
      // Package/config receipts must survive even when the optional Chrome
      // download fails after the native CLI verified successfully.
      saveKitConfig(ctx.cfg);
      return result;
    },
  },
  // hosts: install any ENABLED host that is entirely absent, and reinstall an
  // npm-owned host whose CLI cannot start (npm exits 0 after dropping a failed
  // optional platform binary). External installs are never touched; updates
  // ride the `versions` step via driftReport. Runs before the Codex MCP and
  // provider steps, which shell out to the host CLIs.
  {
    id: 'hosts',
    when: (subs) => subs.has('hosts'),
    run: async (ctx) => {
      const { installState, executable, install } = { ...HOST_LIFECYCLE, ...ctx.hostLifecycle };
      for (const h of commandHosts()) {
        if (!ctx.cfg.integrations.hosts[h.id]) continue;
        const { method } = await installState(h);
        if (method === 'absent') await ctx.step(`install ${h.id}`, () => install(h.id));
        else if (method === 'npm' && !(await executable(h)).ok) await ctx.step(`repair ${h.id}`, () => install(h.id));
      }
    },
  },
  {
    id: 'codex-mcp-repair',
    when: (subs) => subs.has('codex-mcp'),
    run: async (ctx) => {
      const recursive = ctx.codexRepairPlan.filter(entry => entry.repairKind === 'recursive-codex');
      if (!recursive.length) return;
      const result = await ctx.step('codex MCP repair', () => ctx.repairCodexTopology(recursive, ctx.cwd));
      if (!result.ok) ctx.state.codexRepairFailure = result.detail;
    },
  },
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
        if (d.outdated || !d.installed) await ctx.step(`upgrade ${d.pkg}`, () => heal.upgradePackage(d.pkg, hostUpgradeOptions(d.pkg)));
      }
    },
  },
  // ADR-0058: runs immediately after `versions` so a `needs ruflo >= X`
  // component can apply in the SAME sync that just upgraded ruflo, rather
  // than waiting one more sync cycle behind it.
  {
    id: 'ruflo-components',
    when: (subs) => subs.has('ruflo-components'),
    run: async (ctx) => {
      const result = await ctx.step('ruflo components', async () => {
        const r = await reconcileRufloComponents(ctx.cfg, { cwd: ctx.cwd, refresh: true });
        return { ok: r.ok, detail: r.results.map((x) => `${x.id}: ${x.detail}`).join('; '), snapshot: r.snapshot, changed: r.changed };
      });
      saveKitConfig(ctx.cfg);
      if (result?.changed) info(RESTART_REMINDER);
      return result;
    },
  },
  // ruvnet-brain: install if absent, else refresh when drifted. The heal picks
  // the path from disk (the bundle's own updater when it ships one), so this
  // step passes no mode. Not an npm pkg, so it rides its own step rather than
  // the driftReport loop above.
  {
    id: 'ruvnet-brain',
    when: (subs, flags) => subs.has('ruvnet-brain') && !flags['no-upgrade'],
    // Through sync's own cfg: sync saves that object later in this run, which
    // would otherwise erase the release stamp or held refresh the heal records.
    run: (ctx) => ctx.step('ruvnet-brain', () => heal.installRuvnetBrain({ cfg: ctx.cfg })),
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
  {
    id: 'mcp',
    when: (subs, flags, cfg) => subs.has('mcp') && cfg.mcp.register,
    run: async (ctx) => {
      let preserved = [];
      await ctx.step('mcp', async () => {
        const reg = await (ctx.registerMcp ?? mcpRegister)(ctx.cfg);
        preserved = reg.preserved ?? [];
        if (!reg.ok) {
          return { ok: false, detail: 'claude mcp registration failed; prior compatible registration was restored when possible' };
        }
        const { denied } = applyExclusions(ctx.cfg.mcp.excludeFamilies ?? []);
        return { ok: true, detail: `claude-flow registered (user scope), ${denied} tool(s) denied per kit.json` };
      });
      // register() keeps a legacy entry ak did not write (ADR-0016); say so
      // with the manual command instead of implying a migration happened.
      for (const entry of preserved) {
        warn(`custom 'ruflo' MCP registration preserved (${entry.scope} scope) — not agentic-kit's registration; if unwanted, remove it: ${legacyRufloRemovalCommands([entry.scope])}`);
      }
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
      for (const line of applyReport.lines) printReportLine(line, ctx.markFailed);
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
        // --skip <host> also stops the refresh an upgrade (versions) would trigger.
        if (ctx.skip?.has(hostId)) continue;
        if (!lifecycleRefreshRequired(ctx.subsystems, hostId) || !lifecycleExecutionEnabled(hostId, ctx.cfg)) continue;
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
        for (const line of applyReport.lines) printReportLine(line, ctx.markFailed);
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
        if (step === 'routing-retired') { reportRetiredRouteChanges(result.changes); return; }
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
  // Ruflo's signed helper-refresh owns the generated `.claude/helpers` set.
  // Run it explicitly after a versions plan, rather than requiring a broad
  // `ruflo init --full --force` or waiting for a later hook invocation to do
  // it implicitly. Statusline follows immediately because this refresh may
  // replace statusline.cjs.
  {
    id: 'ruflo-helpers',
    when: (subs) => subs.has('versions'),
    run: async (ctx) => {
      // Helpers live at the project root, not a subdirectory cwd (repoRoot is
      // the kit-wide project gate); outside a repository the cwd is used as-is.
      const root = paths.repoRoot(ctx.cwd) ?? ctx.cwd;
      const outcome = await withProgress('ruflo helpers', async () => runHelperRefresh(root));
      if (outcome === 'refreshed') ok('ruflo helpers: signed generated helpers refreshed');
      else if (helperStampStale(root)) warn('ruflo helpers: refresh did not converge; generated helpers remain stale');
      else info('ruflo helpers: current');
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
    // 'statusline/cve': fixStatusline also injects the CVE-counter overlay
    // that row promises (a planned overlay fix used to run no step at all).
    when: (subs) => subs.has('statusline') || subs.has('statusline/cve') || subs.has('versions') || subs.has('providers'),
    run: async (ctx) => {
      // withProgress: fixStatusline blocks on a node subprocess (ruflo's helper
      // refresh, up to 30s). The interval can't animate through a synchronous
      // execFileSync, but the initial "⏳ statusline" render lands before the
      // block — a visible label beats a frozen prompt.
      const root = paths.repoRoot(ctx.cwd) ?? ctx.cwd;
      const r = await withProgress('statusline', async () => fixStatusline(root));
      if (r.absent) info('statusline: no ruflo helpers here — nothing to patch');
      else (r.applied || !r.reason ? ok : warn)(`statusline: ${r.applied ? 'footer injected' : r.reason ?? 'in sync'}`);
      // The baked Ruflo version is repaired only by Ruflo's own helper refresh
      // (fixStatusline clears the stamp first); ak never writes a version.
      const v = r.versionAhead;
      if (r.versionRepair === 'repaired') ok(`statusline: Ruflo regenerated the helper; it no longer shows v${v.baked} (installed v${v.installed})`);
      else if (r.versionRepair === 'failed') {
        warn(`statusline: still shows Ruflo v${v.baked} (installed v${v.installed}) — ruflo's helper refresh did not regenerate it; ${bakedVersionManualFix(v.installed)}`);
      }
      // Honest success: fixStatusline invokes ruflo's PRIVATE helper-refresh
      // internal, best-effort. If the stamp is STILL stale after the heal, that
      // refresh silently no-oped (e.g. upstream moved the dist module) and the
      // next ruflo command will wipe the footer we just injected — say so
      // instead of letting "footer injected" read as converged.
      if (helperStampStale(root)) {
        warn('statusline: helper stamp still stale after heal — ruflo\'s refresh did not run; the footer may not survive the next ruflo command');
      }
    },
  },
  // kit self-update — LAST, after every other heal: npm replaces the kit's
  // files on disk, and the new code applies from the next ak run, so nothing
  // after this point should depend on the kit's own modules being current.
  // (Array position — the final entry in SYNC_STEPS — is the invariant.)
  {
    id: 'codex-context',
    when: (subs, flags, cfg) => subs.has('codex-context') && !!cfg.codexContext && !!cfg.integrations?.hosts?.codex,
    run: async (ctx) => {
      await manageCodexContext(ctx.cfg, { persist: saveKitConfig });
      ok('Codex native context maximum reconciled; start new sessions');
    },
  },
  {
    id: 'aqe-embedding',
    when: (subs, flags, cfg) => cfg.aqe !== false && subs.has('aqe-embedding'),
    run: async (ctx) => {
      const backend = await ctx.step('aqe-embedding', () => prepareAqeEmbedding(ctx.cfg));
      // Remember the live result so plain `ak status` shows it (decision 9a).
      rememberLiveCheck('aqe-embedding', embeddingCheckOutcome(backend), { source: 'sync', cfg: ctx.cfg, cwd: ctx.cwd });
      if (backend?.ok === false) return;
      const projection = reconcileAqeEmbeddingProjections(ctx.cfg, ctx.cwd);
      ctx.report('AQE embedding projections', projection);
      recordApplyFailure(ctx.state, 'aqe-embedding', projection);
    },
  },
  {
    id: 'self',
    when: (subs, flags) => subs.has('self') && !flags['no-upgrade'],
    run: async (ctx) => {
      const s = await selfDrift({ pkgRoot: ctx.pkgRoot, force: true });
      if (s.outdated) await ctx.step('self-update', () => heal.selfUpdate(s.latest));
    },
  },
];

// Repairs run() performs after SYNC_STEPS, on every run.
const TAIL_REPAIRS = new Set(['host-alignment']);

// The subsystem each step repairs, which is what --skip names. A step's id is
// that subsystem unless listed here; host-lifecycles answers per host instead
// (its loop checks ctx.skip), so no single subsystem owns it.
const STEP_SUBSYSTEM = { 'codex-mcp-repair': 'codex-mcp', 'aqe-rvf': 'aqe', 'ruflo-helpers': 'versions', 'host-lifecycles': null };
const stepSubsystem = (s) => (Object.hasOwn(STEP_SUBSYSTEM, s.id) ? STEP_SUBSYSTEM[s.id] : s.id);

// Every subsystem a plan item or step can name. tests/kit/sync-command.test.mjs
// fails when a step's `when` names one missing here.
const SYNC_SUBSYSTEMS = [
  'agent-browser', 'aqe', 'aqe-embedding', 'blocks', 'codex-context', 'codex-mcp', 'codex-statusline',
  'daemons', 'deja-vu', 'host-alignment', 'hosts', 'mcp', 'natives', 'npx', 'providers', 'routing',
  'ruflo-components', 'ruvector', 'ruvnet-brain', 'ruvnet-brain-nightly', 'scaffold-agents', 'security',
  'self', 'statusline', 'statusline/cve', 'versions',
];

/** The names `ak sync --skip` accepts: SYNC_SUBSYSTEMS plus every lifecycle host. */
export function skippableSubsystems() {
  return [...new Set([...SYNC_SUBSYSTEMS, ...hostsWithLifecycle()])].sort();
}

/** --skip values (repeatable, or comma-separated) → `{ skip: Set }`, or
 *  `{ error }` naming each unknown value and the accepted list. */
export function parseSkip(values) {
  const names = [values ?? []].flat().flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
  const known = skippableSubsystems();
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length) {
    return { error: `unknown --skip subsystem ${unknown.map((n) => `'${n}'`).join(', ')} — accepted: ${known.join(', ')}` };
  }
  return { skip: new Set(names) };
}

/** A step runs when its `when` fires on the planned subsystems and --skip did
 *  not name the subsystem it repairs. Removing a skipped subsystem from the
 *  plan already stops the triggers it would derive (versions → natives …);
 *  this check stops a skipped step that another planned subsystem triggers. */
const stepRuns = (s, subsystems, flags, cfg, skip) => !skip.has(stepSubsystem(s)) && s.when(subsystems, flags, cfg);

/** Ids of the steps that run for `subsystems` under --skip (for tests). */
export function activeSteps(subsystems, flags, cfg, skip = new Set()) {
  return SYNC_STEPS.filter((s) => stepRuns(s, subsystems, flags, cfg, skip)).map((s) => s.id);
}

/** Which steps would perform a planned fix for `subsystem`, judged on that
 *  subsystem alone. `host-lifecycles` runs on every sync but acts only for a
 *  lifecycle host it is asked to refresh, so its always-true `when` is not
 *  evidence; `host-alignment` is the post-step alignHosts pass. An empty list
 *  means sync cannot perform the fix it planned (or --skip stopped every step
 *  that could). */
export function performingSteps(subsystem, flags, cfg, skip = new Set()) {
  if (skip.has(subsystem)) return [];
  const subs = new Set([subsystem]);
  const steps = SYNC_STEPS.filter((s) => s.id !== 'host-lifecycles' && stepRuns(s, subs, flags, cfg, skip)).map((s) => s.id);
  if (hostsWithLifecycle().includes(subsystem) && lifecycleRefreshRequired(subs, subsystem)
    && lifecycleExecutionEnabled(subsystem, cfg)) steps.push('host-lifecycles');
  if (TAIL_REPAIRS.has(subsystem)) steps.push('sync tail');
  return steps;
}

/** Take --skip's items out of the plan: those of a skipped subsystem, and
 *  those only a skipped step performs (statusline/cve when statusline is
 *  skipped) — running the rest could never repair them. */
export function splitSkipped(candidates, skip, flags, cfg) {
  if (!skip.size) return { plan: candidates, skipped: [] };
  const plan = []; const skipped = [];
  for (const p of candidates) {
    const onlySkippedSteps = () => performingSteps(p.subsystem, flags, cfg).length > 0
      && performingSteps(p.subsystem, flags, cfg, skip).length === 0;
    (skip.has(p.subsystem) || onlySkippedSteps() ? skipped : plan).push(p);
  }
  return { plan, skipped };
}

const repairKey = (r) => `${r.subsystem}\u0000${r.fix}`;

/** The post-apply verdict (ADR-0033). `unresolved` holds promised repairs that
 *  did not take: a planned (subsystem, fix) whose row is still present after
 *  the apply phase, and any planned subsystem no step performs. Manual fixes
 *  never enter the plan, so they can never be unresolved. `remaining` holds
 *  everything else still failing: fail-level rows, a deja-vu row with a fix,
 *  and mutations that reported failure during this run. A subsystem --skip
 *  left out is never a failure: its failing rows join the skipped plan items
 *  in `skipped`, reported as "skipped by request". */
export function convergenceVerdict({ plan, after: collected, state, flags, cfg, skip = new Set(), skipped: skippedPlan = [] }) {
  const left = new Set([...skip, ...skippedPlan.map((p) => p.subsystem)]);
  const counts = (r) => r.level === 'fail' || (r.subsystem === 'deja-vu' && r.fix !== null);
  const skipped = [...skippedPlan, ...collected.filter((r) => left.has(r.subsystem) && counts(r)
    && !skippedPlan.some((p) => repairKey(p) === repairKey(r)))];
  const after = collected.filter((r) => !left.has(r.subsystem));
  const unresolved = [];
  for (const p of plan) {
    if (performingSteps(p.subsystem, flags, cfg).length) continue;
    unresolved.push({ subsystem: p.subsystem, fix: p.fix, message: `no sync step performs this repair (${p.message})`, reason: 'no-step' });
  }
  // Same test the plan used to admit a fix, so a row cannot enter the plan
  // under one rule and escape the proof under another.
  const planned = new Set(plan.map(repairKey));
  const flagged = new Set(unresolved.map(repairKey));
  for (const r of after) {
    if (!r.fix || r.repair === 'manual' || !planned.has(repairKey(r)) || flagged.has(repairKey(r))) continue;
    flagged.add(repairKey(r));
    unresolved.push({ subsystem: r.subsystem, fix: r.fix, message: r.message, reason: 'not-converged' });
  }
  const remaining = after.filter((r) => !(r.fix && flagged.has(repairKey(r))) && counts(r));
  // Collector rows describe persisted state after the heal, but they cannot
  // erase an apply failure from this run. In particular, an unavailable
  // external fallback can leave only a warning row; claiming convergence
  // after applyAqeRouter returned !ok is a false success and retry loop.
  const applyFailed = (subsystem, message) => remaining.push({ subsystem, message, reason: 'apply-failed' });
  if (state.aqeRouterApplyFailure && !remaining.some((r) => r.subsystem === 'providers')) {
    applyFailed('providers', `AQE router apply failed: ${state.aqeRouterApplyFailure}`);
  }
  if (state.dejaVuApplyFailed && !remaining.some((r) => r.subsystem === 'deja-vu')) {
    applyFailed('deja-vu', 'companion lifecycle apply failed');
  }
  if (state.codexRepairFailure && !remaining.some((r) => r.subsystem === 'codex-mcp')) {
    applyFailed('codex-mcp', state.codexRepairFailure);
  }
  for (const failure of state.applyFailures) {
    if (!remaining.some((r) => r.message === `${failure.name}: ${failure.detail}`)) {
      applyFailed(failure.name, `${failure.name}: ${failure.detail}`);
    }
  }
  return { unresolved, remaining, skipped };
}

// ── --json ───────────────────────────────────────────────────────────────────

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const LEADING_GLYPH = /^[✓⚠✗ℹ·]\s*/u;

/** A plan or skipped item as --json reports it: `ak status --json`'s row fields. */
const publicRow = (r) => ({
  subsystem: r.subsystem, level: r.level ?? null, message: r.message, fix: r.fix ?? null,
  repair: r.repair ?? (r.fix ? 'sync' : null),
});

/** An unresolved item as --json reports it. `reason`: 'not-converged' (the
 *  planned fix is still there), 'no-step' (no step performs it), 'failing' (a
 *  fail-level row), 'apply-failed' (a mutation reported failure), or
 *  'declined' (a Codex repair was not confirmed, so nothing was applied). */
const publicIssue = (r) => ({ subsystem: r.subsystem, fix: r.fix ?? null, message: r.message, reason: r.reason ?? 'failing' });

/** What one step printed, as a single line: no color, glyphs, or progress
 *  ticker (only the text after a line's last carriage return survives). */
function stepDetail(chunks) {
  const lines = chunks.join('').split('\n')
    .map((l) => stripUnsafeChars(l.slice(l.lastIndexOf('\r') + 1).replace(ANSI, '')).replace(LEADING_GLYPH, '').trim())
    .filter(Boolean);
  return lines.length ? lines.join('; ') : null;
}

/** Records each step that runs as `{ id, ok, detail }`. A step is not ok when
 *  a result it reported failed, it printed a failed sub-surface, it recorded a
 *  failure in the run state, or it threw. Its detail is what it printed, which
 *  is captured only under --json (see humanOutputToStderr). */
function stepTracer(state, result, capture) {
  let current = null;
  const failures = () => state.applyFailures.length
    + [state.dejaVuApplyFailed, state.aqeRouterApplyFailure, state.codexRepairFailure].filter(Boolean).length;
  const markFailed = () => { if (current) current.failed = true; };
  const report = (name, r) => {
    const status = reportOutcome(name, r);
    if (!['ok', 'degraded', 'skipped'].includes(status)) markFailed();
    return status;
  };
  const traced = async (id, fn) => {
    const rec = { failed: false, chunks: [] };
    const before = failures();
    current = rec;
    if (capture) capture.chunks = rec.chunks;
    try {
      return await fn();
    } catch (e) {
      rec.failed = true;
      throw e;
    } finally {
      if (capture) capture.chunks = null;
      current = null;
      result.steps.push({ id, ok: !rec.failed && failures() === before, detail: stepDetail(rec.chunks) });
    }
  };
  return { traced, report, markFailed };
}

/** Under --json, send everything written to stdout during `fn` (ok/warn/fail/
 *  info lines, the plan listing, prompts, progress) to stderr instead, and
 *  let the step tracer collect it while `capture.chunks` is set. stdout is
 *  restored even when `fn` throws, so the one JSON result lands on it alone. */
async function humanOutputToStderr(fn) {
  const stdoutWrite = process.stdout.write;
  const capture = { chunks: null };
  // stderr.write is looked up on every call, so a caller's own wrapper still sees it.
  const toStderr = (...args) => {
    capture.chunks?.push(String(args[0]));
    return Reflect.apply(process.stderr.write, process.stderr, args);
  };
  process.stdout.write = /** @type {typeof process.stdout.write} */ (/** @type {unknown} */ (toStderr));
  try {
    return await fn(capture);
  } finally {
    process.stdout.write = stdoutWrite;
  }
}

/** Print the verdict; returns the exit code. */
function reportVerdict({ unresolved, remaining, skipped }) {
  for (const s of skipped) info(`skipped by request: [${s.subsystem}] ${s.fix ?? s.message}`);
  if (unresolved.length === 0 && remaining.length === 0) {
    ok(bold(`converged — no failing subsystems${skipped.length ? ` (${skipped.length} skipped by request)` : ''}`));
    info(dim('📊 dashboard: run `ak dashboard` → opens http://127.0.0.1:7431 (local, read-only)'));
    return 0;
  }
  for (const u of unresolved) fail(`unresolved: [${u.subsystem}] ${u.fix} — ${u.message}`);
  for (const r of remaining) fail(`still failing: [${r.subsystem}] ${r.message}`);
  return 1;
}

/** The passes after SYNC_STEPS, each unless --skip named it: a final Codex MCP
 *  reconcile (codex-mcp) and host transport alignment (host-alignment). */
async function runTail({ cfg, cwd, flags, skip, state, codexRepairPlan, confirm, inspect, repair, traced }) {
  // An initializer can restore a legacy alias after the initial repair. Keep
  // the replacement's ownership check and the user's explicitly remembered
  // choice, then verify the final topology before declaring convergence.
  if (!skip.has('codex-mcp')) {
    await traced('codex-mcp-reconcile', async () => {
      const finalMcp = await reconcileCodexMcp({ cfg, cwd, yes: flags.yes, confirm, inspect, repair, approvedTargets: codexRepairPlan });
      if (!finalMcp.ok) state.codexRepairFailure = finalMcp.detail;
    });
  }
  if (!skip.has('host-alignment')) {
    await traced('host-alignment', async () => {
      if (await alignHosts({ flags: { apply: true, yes: flags.yes }, roots: [cwd], cfg, confirm }) !== 0) {
        state.applyFailures.push({ name: 'host-alignment', detail: 'transport anomalies remain; run ak host align for the exact scope and correction' });
      }
    });
  }
}

/** `ak sync`. Without --json it prints as it goes and returns the exit code.
 *  With --json every human line goes to stderr and stdout carries exactly one
 *  JSON object: { plan, steps, unresolved, skipped, converged, exitCode } (plus
 *  `error` when the run was rejected or threw). `converged` is true when
 *  nothing is left for sync to do, false when it ended with unresolved or
 *  failing items, and null when it stopped before a verdict (a dry run with a
 *  plan, a rejected flag, an error). */
export async function run(opts) {
  const result = { plan: [], steps: [], unresolved: [], skipped: [], converged: null, exitCode: 0 };
  if (!opts.flags.json) {
    result.exitCode = await converge(opts, result);
    return result.exitCode;
  }
  await humanOutputToStderr(async (capture) => {
    try {
      result.exitCode = await converge(opts, result, capture);
    } catch (e) {
      fail(`ak sync: ${e?.stack ?? e}`);
      Object.assign(result, { converged: null, exitCode: 1, error: e?.message ?? String(e) });
    }
  });
  console.log(JSON.stringify(result, null, 2));
  return result.exitCode;
}

async function converge({
  flags,
  pkgRoot,
  fetchLatest,
  dejaVuAdapter = companionLifecycleFor('deja-vu'),
  collectFn = collect,
  confirmCodexRepair = askCodexRepair,
  inspectCodexTopology = codexMcpTopology,
  repairCodexTopology = repairCodexMcpTopology,
}, result, capture = null) {
  const cwd = process.cwd();
  const dejaVuPlanOptions = { allowUpgrade: !flags['no-upgrade'] };
  const { skip, error: skipError } = parseSkip(flags.skip);
  if (skipError) {
    fail(`ak sync: ${skipError}`);
    result.error = skipError;
    return 2;
  }
  // #134: draw the plan from CURRENT drift, not the TTL cache — a cache
  // stamped before an upstream release claims "all current" and the upgrade
  // never reaches the plan (the old force at apply time sat behind the very
  // versions gate it needed to open). Dry-runs skip the refresh: it writes
  // kit.json, and --dry-run is pinned to touch nothing — so a dry-run
  // preview may be cache-stale by up to one TTL window.
  await refreshPlanDrift(flags, fetchLatest, pkgRoot);
  const rows = await collectFn({ pkgRoot, cwd, dejaVuAdapter, dejaVuPlanOptions });
  // Only fixes a sync step performs enter the plan (status/row.mjs repair
  // contract, #237). A manual fix — a command the user runs, a file they edit,
  // a login, an explicit model-lifecycle command — is named by `ak status` and
  // counted below, but sync never plans or claims it.
  const manual = rows.filter((r) => r.fix && r.repair === 'manual');
  const candidates = rows.filter((r) => r.fix && r.repair !== 'manual')
    .filter((r) => !(flags['no-upgrade'] && ['versions', 'self', 'ruvnet-brain', 'ruvector'].includes(r.subsystem)))
    // A ruflo-components row asking for a ruflo UPGRADE (state 'needs-ruflo') gets the
    // same --no-upgrade treatment as 'versions': the component can't actually apply
    // without the upgrade --no-upgrade just withheld, so planning it would report
    // an action sync cannot complete this run. Other ruflo-components fixes
    // (not-applied/drifted/blocked) don't need an upgrade and stay in the plan.
    .filter((r) => !(flags['no-upgrade'] && r.subsystem === 'ruflo-components' && r.state === 'needs-ruflo'));

  const cfg = loadKitConfig();
  if (cfg.aqe !== false && cfg.aqeEmbedding && cfg.aqeEmbedding.mode !== 'unmanaged') {
    candidates.push(row('aqe-embedding', 'info', 'selected semantic backend requires live verification',
      'verify selected backend and repair missing opted-in local model'));
  }
  const { plan, skipped } = splitSkipped(candidates, skip, flags, cfg);
  result.plan = plan.map(publicRow);
  result.skipped = skipped.map(publicRow);
  if (!announcePlan(plan, manual, skipped)) {
    result.converged = true;
    return 0;
  }
  if (flags['dry-run']) return 0;
  console.log('');

  const subsystems = new Set(plan.map((p) => p.subsystem));
  const codexRepairPlan = plan.some((p) => p.subsystem === 'codex-mcp')
    ? codexMcpRepairPlan(inspectCodexTopology({ cwd })) : [];
  if (codexRepairPlan.length) {
    const confirmed = await confirmCodexMcpRepairs(cfg, codexRepairPlan, inspectCodexTopology({ cwd }), {
      yes: flags.yes, confirm: confirmCodexRepair,
    });
    if (!confirmed) {
      info('Codex configuration was left unchanged; no sync actions were applied');
      result.converged = false;
      result.unresolved = plan.filter((p) => p.subsystem === 'codex-mcp').map((p) => publicIssue({
        ...p, message: 'Codex repairs were not confirmed; no sync actions were applied', reason: 'declined',
      }));
      return 1;
    }
  }
  const state = {
    dejaVuApplyFailed: false,
    aqeRouterApplyFailure: null,
    codexRepairFailure: null,
    applyFailures: [],
  };
  const { traced, report, markFailed } = stepTracer(state, result, capture);
  // Run a managed heal under a live elapsed-time ticker, then print its result.
  // Keeps every slow tool (npm upgrades, brain KB download, native rebuild)
  // visibly alive instead of freezing the prompt; fast/local steps clear in <1s.
  const step = async (name, thunk) => {
    const r = await withProgress(name, thunk);
    report(name, r);
    recordApplyFailure(state, name, r);
    return r;
  };
  const ctx = {
    cfg, cwd, pkgRoot, flags, dejaVuAdapter, codexRepairPlan, subsystems, skip, report, step, markFailed, state,
    inspectCodexTopology, repairCodexTopology,
  };

  for (const s of SYNC_STEPS) {
    if (stepRuns(s, subsystems, flags, cfg, skip)) await traced(s.id, () => s.run(ctx));
    if (state.codexRepairFailure) {
      result.converged = false;
      result.unresolved = [publicIssue({ subsystem: 'codex-mcp', message: state.codexRepairFailure, reason: 'apply-failed' })];
      return 1;
    }
  }
  await runTail({ cfg, cwd, flags, skip, state, codexRepairPlan, traced,
    confirm: confirmCodexRepair, inspect: inspectCodexTopology, repair: repairCodexTopology });

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

  const verdict = convergenceVerdict({ plan, after, state, flags, cfg, skip, skipped });
  result.unresolved = [...verdict.unresolved, ...verdict.remaining].map(publicIssue);
  result.skipped = verdict.skipped.map(publicRow);
  const code = reportVerdict(verdict);
  result.converged = code === 0;
  return code;
}
