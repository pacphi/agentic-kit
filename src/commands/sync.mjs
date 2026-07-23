// ak sync — converge to good. Plan comes from the same collector status
// uses; --dry-run prints it and stops. Apply order: upgrades first (they wipe
// natives), then heals, then re-collect to prove convergence.
import path from 'node:path';
import { collect } from './status.mjs';
import * as heal from '../lib/heal.mjs';
import { fixStatusline, helperStampStale } from '../lib/statusline.mjs';
import { registry, syncBlocks } from '../lib/blocks.mjs';
import { register as mcpRegister, applyExclusions } from '../lib/mcp.mjs';
import { listDaemons, staleDaemons, reap } from '../lib/daemons.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { HOSTS, applyHosts, applyProviders, hostInstallState, installHost, applyAqeRouter, seedDualRoutingIfDualHost, ensureCodexMcp } from '../lib/providers.mjs';
import { driftReport, selfDrift } from '../lib/versions.mjs';
import { pruneNpxStale } from '../lib/npx.mjs';
import { nativesStatus, securityPresent } from '../lib/natives.mjs';
import { readJson } from '../lib/settings.mjs';
import { appendToConfig } from '../lib/health-history.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, fail, info, bold, dim, withProgress } from '../lib/output.mjs';

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

export async function run({ flags, pkgRoot }) {
  const cwd = process.cwd();
  const rows = await collect({ pkgRoot, cwd });
  const plan = rows.filter((r) => r.fix)
    .filter((r) => !(flags['no-upgrade'] && (r.subsystem === 'versions' || r.subsystem === 'self' || r.subsystem === 'ruvnet-brain')));

  if (plan.length === 0) { ok('nothing to do — all subsystems healthy'); return 0; }

  console.log(bold(`sync plan (${plan.length} action(s)):`));
  for (const p of plan) console.log(`  • [${p.subsystem}] ${p.fix} ${dim(`— because: ${p.message}`)}`);
  if (flags['dry-run']) return 0;
  console.log('');

  const cfg = loadKitConfig();
  const subsystems = new Set(plan.map((p) => p.subsystem));
  const report = (name, r) => (r.ok ? ok(`${name}: ${r.detail}`) : fail(`${name}: ${r.detail}`));
  // Run a managed heal under a live elapsed-time ticker, then print its result.
  // Keeps every slow tool (npm upgrades, brain KB download, native rebuild)
  // visibly alive instead of freezing the prompt; fast/local steps clear in <1s.
  const step = async (name, thunk) => { const r = await withProgress(name, thunk); report(name, r); return r; };

  if (subsystems.has('versions') && !flags['no-upgrade']) {
    report('daemons', await heal.stopAllDaemons());
    for (const d of await driftReport({ force: true })) {
      if (d.outdated || !d.installed) await step(`upgrade ${d.pkg}`, () => heal.upgradePackage(d.pkg));
    }
  }
  // ruvnet-brain: install if absent / re-run installer to pull latest when
  // drifted (force bypasses the installer's skip-if-present). Not an npm pkg, so
  // it rides its own branch rather than the driftReport loop above.
  if (subsystems.has('ruvnet-brain') && !flags['no-upgrade']) {
    await step('ruvnet-brain', () => heal.installRuvnetBrain({ force: true }));
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
  if (subsystems.has('blocks') || subsystems.has('versions')) {
    const rowsReg = registry(cfg.customBlocks);
    const resolve = (r) => (r.custom
      ? (r.template.startsWith('~/') ? path.join(paths.home, r.template.slice(2)) : r.template)
      : path.join(pkgRoot, 'claude', r.template));
    const res = await syncBlocks(paths.claudeMdPath(), rowsReg, resolve);
    ok(`blocks: ${res.filter((r) => r.action !== 'unchanged').map((r) => `${r.slug} ${r.action}`).join(', ') || 'in sync'}`);
  }
  // hosts: install any ENABLED host that is entirely absent (updates to
  // npm-managed hosts ride the versions branch above via driftReport).
  if (subsystems.has('hosts')) {
    for (const h of HOSTS) {
      if (!cfg.providers.hosts[h.id]) continue;
      if ((await hostInstallState(h)).method !== 'absent') continue;
      await step(`install ${h.id}`, () => installHost(h.id));
    }
  }
  if (subsystems.has('providers') || subsystems.has('routing')) {
    report('providers', applyHosts(cfg, cwd));
    // heal per-activity routing: seed from defaults if dual-host only just became
    // eligible (e.g. aqe upgraded ≥3.13.1 since enablement), before materializing.
    const seed = seedDualRoutingIfDualHost(cfg);
    if (seed.seeded) { saveKitConfig(cfg); report('routing', { ok: true, changed: true, detail: `seeded ${seed.count} activities` }); }
    const router = applyAqeRouter(cfg, cwd);
    if (router.changed || !router.ok) report('aqe router', router);
    const mcp = await ensureCodexMcp(cfg, cwd);
    if (mcp.changed) saveKitConfig(cfg);
    if (mcp.changed || !mcp.ok) report('codex MCP', mcp);
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
      learningRows: stats?.patternsLearned ?? 0,
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
