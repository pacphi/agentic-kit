// ak uninstall — remove the kit's machine footprint (default), a
// project's patches (--this-project), and optionally the global packages
// (--remove-ruflo / --remove-aqe / --purge, each confirmed). Also cleans a
// LEGACY shell-kit install (rc source lines, ~/.local/bin/ruflo-*,
// ~/.config/ruflo shell files) — the migration path off the bash era.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { run as runCmd } from '../lib/exec.mjs';
import { stripBlock, BEGIN, BUILTIN_BLOCKS } from '../lib/blocks.mjs';
import { unregister } from '../lib/mcp.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { runLifecycle } from '../lib/adapters/lifecycle.mjs';
import { hostsWithLifecycle, lifecycleAdapterFor, lifecycleExecutionEnabled, isBuiltinHost } from '../lib/adapters/lifecycle-registry.mjs';
import { companionLifecycleFor } from '../lib/adapters/companion-lifecycle-registry.mjs';
import { renderUndoReport } from '../lib/adapters/lifecycle-render.mjs';
import { parseDejaVuDoctor, validateDejaVuIndexPath } from '../lib/deja-vu.mjs';
import { present as rbPresent } from '../lib/ruvnet-brain.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, fail, info } from '../lib/output.mjs';
import { removeCodexStatusline } from '../lib/codex-statusline.mjs';
import { modelInventoryPath, modelScopeKeyPath } from '../lib/model-inventory/store.mjs';
import { removeManagedAgentBrowser, removeManagedAgentBrowserConfig } from '../lib/agent-browser.mjs';

/** Prints one lifecycle-render.mjs report line at its own level — mirrors
 *  setup.mjs/sync.mjs's own printReportLine (N-2, Wave C security review
 *  follow-up): renderUndoReport only ever emits 'ok'/'warn' today, so this is
 *  latent, but the day an undo renderer adopts levelForResult (F5's mapping)
 *  a 'fail' line must reach fail(), not be silently downgraded to warn(). */
export function printReportLine(line) {
  if (line.level === 'ok') ok(line.text);
  else if (line.level === 'warn') warn(line.text);
  else if (line.level === 'fail') fail(line.text);
  else info(line.text);
}

export const options = {
  'dry-run': { type: 'boolean', default: false },
  'this-project': { type: 'boolean', default: false },
  'remove-ruflo': { type: 'boolean', default: false },
  'remove-aqe': { type: 'boolean', default: false },
  'remove-agent-browser': { type: 'boolean', default: false },
  'remove-deja-vu': { type: 'boolean', default: false },
  'purge-deja-vu-data': { type: 'boolean', default: false },
  purge: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
};

export const help = `ak uninstall — leave cleanly

By default removes only the kit's own machine footprint (CLAUDE.md managed
blocks, MCP registration) and cleans any legacy shell-kit install. The global
packages (ruflo, agentic-qe) stay unless you ask for them. Each removal is
confirmed unless --yes.

Usage: ak uninstall [options]

Options:
  --this-project   also remove this project's patches (settings, .claude-flow)
  --remove-ruflo   uninstall the global ruflo package (confirmed)
  --remove-aqe     uninstall the global agentic-qe package (confirmed)
  --remove-agent-browser  uninstall only a receipt-owned agent-browser package
  --remove-deja-vu uninstall the Kit-owned deja-vu package (confirmed)
  --purge-deja-vu-data delete only the derived deja-vu index (confirmed)
  --purge          remove Kit footprint + ruflo/aqe and receipt-owned agent-browser;
                   preserve all browser/session/profile data and deja-vu package/data
  --yes            skip confirmation prompts
  --dry-run        print what would be removed; change nothing

Examples:
  ak uninstall                    remove the kit's footprint only
  ak uninstall --this-project     also unpatch the current repo
  ak uninstall --purge --dry-run  preview a full teardown`;

const confirm = async (q, yes) => {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a.startsWith('y');
};

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function dejaVuOwnership(cfg) {
  const own = cfg?.integrations?.ownership?.dejaVu;
  return plain(own) ? own : null;
}

function hasDejaVuOwnership(cfg) {
  const own = dejaVuOwnership(cfg);
  return !!own && (!!own.install || (plain(own.targets) && Object.keys(own.targets).length > 0));
}

function protectedDejaVuRoots(homeDir, env) {
  const absolute = (value) => typeof value === 'string' && path.isAbsolute(value);
  const configBases = [path.join(homeDir, '.config'), env.XDG_CONFIG_HOME, env.APPDATA]
    .filter(absolute);
  const dataBases = [path.join(homeDir, '.local', 'share'), env.XDG_DATA_HOME]
    .filter(absolute);
  return {
    sourceRoots: [
      path.join(homeDir, '.claude', 'projects'),
      path.join(homeDir, '.codex', 'sessions'),
      ...dataBases.map((base) => path.join(base, 'opencode')),
    ],
    configRoots: configBases.flatMap((base) => [
      path.join(base, 'deja'), path.join(base, 'opencode'), path.join(base, 'agentic-kit'),
    ]),
  };
}

/**
 * Delete only the v0.19 doctor-reported derived index. Raw doctor output and
 * the validated path stay inside this function; callers receive reason codes.
 */
export async function purgeDejaVuIndex({
  runner = runCmd,
  homeDir = paths.home,
  env = process.env,
  dryRun = false,
} = {}) {
  let result;
  try {
    result = await runner('deja', ['doctor', '--json', '--offline'], { timeout: 60_000 });
  } catch {
    return { ok: false, changed: false, reason: 'doctor-command-failed' };
  }
  if (result?.code !== 0) return { ok: false, changed: false, reason: 'doctor-command-failed' };
  const parsed = parseDejaVuDoctor(result.stdout);
  if (parsed.state !== 'ok' || parsed.facts?.schemaVersion !== 2) {
    return { ok: false, changed: false, reason: `doctor-${parsed.reason ?? 'invalid'}` };
  }

  let raw;
  try { raw = JSON.parse(result.stdout); } catch {
    return { ok: false, changed: false, reason: 'doctor-json-malformed' };
  }
  const allowedRoots = [path.join(homeDir, '.cache', 'deja')];
  const exactIndexPaths = [];
  if (typeof env.DEJA_INDEX_DIR === 'string' && path.isAbsolute(env.DEJA_INDEX_DIR)) {
    const override = path.resolve(env.DEJA_INDEX_DIR);
    // v0.19 treats DEJA_INDEX_DIR as the exact directory, and it need not be
    // named index.db. Admit only that exact doctor-reported path below its
    // parent; a sibling or broader parent can never inherit the exception.
    allowedRoots.push(path.dirname(override));
    exactIndexPaths.push(override);
  }
  const protectedRoots = protectedDejaVuRoots(homeDir, env);
  const candidate = raw?.index?.path;
  const validated = validateDejaVuIndexPath(candidate, {
    homeDir,
    allowedRoots,
    exactIndexPaths,
    sourceRoots: protectedRoots.sourceRoots,
    configRoots: protectedRoots.configRoots,
  });
  if (!validated.ok) return { ok: false, changed: false, reason: validated.reason };

  try {
    let stat;
    try { stat = fs.lstatSync(candidate); } catch {
      if (!fs.existsSync(candidate)) return { ok: true, changed: false, reason: 'index-missing' };
      return { ok: false, changed: false, reason: 'index-inspect-failed' };
    }
    if (stat.isSymbolicLink()) return { ok: false, changed: false, reason: 'path-symlink' };
    if (!stat.isDirectory()) return { ok: false, changed: false, reason: 'path-not-directory' };
    // Revalidate immediately before deletion to narrow the filesystem race.
    const revalidated = validateDejaVuIndexPath(candidate, {
      homeDir,
      allowedRoots,
      exactIndexPaths,
      sourceRoots: protectedRoots.sourceRoots,
      configRoots: protectedRoots.configRoots,
    });
    if (!revalidated.ok || revalidated.path !== validated.path) {
      return { ok: false, changed: false, reason: 'path-changed' };
    }
    if (dryRun) return { ok: true, changed: false, reason: 'dry-run' };
    fs.rmSync(validated.path, { recursive: true, force: false });
    return { ok: true, changed: true, reason: null };
  } catch {
    return { ok: false, changed: false, reason: 'index-delete-failed' };
  }
}

/** @typedef {{dejaAdapter?:any,purgeDejaVuIndex?:typeof purgeDejaVuIndex}} UninstallDeps */

// ── the uninstall step registry ──────────────────────────────────────────
// Mirrors sync.mjs's SYNC_STEPS idiom (ADR-0037): every teardown phase used to
// be inlined sequentially into `run()`, with real ordering invariants (the
// CLAUDE.md/skill/opencode strips before kit.json purge reads ownership;
// deja-vu targets before its data purge before its package removal; the
// registry-driven host-lifecycle loop before kit.json is ever deleted) proven
// only by source order. Each step below is `{id, when(ctx), run(ctx)}`;
// UNINSTALL_STEPS's array order *is* the ordering invariant. `ctx` is the
// shared per-invocation context built in `run()`: {flags, dry, deps, cfg,
// act, state}. `state` carries the two cross-step signals
// (`ownershipTeardownOk`, `dejaVuTeardownOk`) later steps (the kit.json purge
// decision) still need to read.
function stepCodexStatusline(ctx) {
  const { dry, cfg, flags } = ctx;
  if (dry) { info('[dry-run] release managed Codex status line (preserving user-modified keys)'); return; }
  let r;
  try { r = removeCodexStatusline(cfg.statusline.codex.lastProjection); }
  catch (error) {
    warn(`Codex config was not changed; status-line ownership retained: ${error.message}`);
    r = null;
  }
  if (r) {
    cfg.statusline.codex = null;
    if (!flags.purge) saveKitConfig(cfg);
    ok(`Codex status-line ownership released${r.changed ? ' (unchanged managed keys removed)' : ' (user-modified keys preserved)'}`);
  }
}

// 1. CLAUDE.md managed blocks: every built-in slug (registry-driven, so
// non-ruflo blocks like ruvnet-brain-reference are covered), the legacy
// ruflo-* pattern as a catch-all, plus any custom slugs from kit.json.
function stepClaudeMdBlocks(ctx) {
  const md = paths.claudeMdPath();
  if (!fs.existsSync(md)) return;
  let content = fs.readFileSync(md, 'utf8');
  const slugs = new Set([...content.matchAll(/<!-- BEGIN (ruflo-[\w-]+) -->/g)].map((m) => m[1]));
  for (const b of BUILTIN_BLOCKS) if (content.includes(BEGIN(b.slug))) slugs.add(b.slug);
  for (const b of ctx.cfg.customBlocks) if (content.includes(BEGIN(b.slug))) slugs.add(b.slug);
  if (!slugs.size) return;
  ctx.act(`stripped ${slugs.size} managed block(s) from ~/.claude/CLAUDE.md (backup written)`, () => {
    fs.copyFileSync(md, `${md}.bak.${Date.now()}`);
    for (const s of slugs) content = stripBlock(content, s);
    fs.writeFileSync(md, content);
  });
}

// 2. deployed skill. kit.json is purged only after all receipt-dependent
// teardown succeeds; otherwise it remains the recovery proof.
function stepSkill(ctx) {
  const skill = path.join(paths.claudeSkillsDir(), 'ruflo-token-audit');
  if (fs.existsSync(skill)) ctx.act('removed skill ruflo-token-audit', () => fs.rmSync(skill, { recursive: true }));
}

// 2b. opencode host footprint (when ak managed it): strip the guidance
// blocks from opencode's AGENTS.md. (The opencode.json wiring and deployed
// artifacts are handled by the registry-driven host-lifecycle loop below.)
function stepOpencodeAgentsMd(ctx) {
  const ocMd = paths.opencodeAgentsMdPath();
  if (!fs.existsSync(ocMd)) return;
  let content = fs.readFileSync(ocMd, 'utf8');
  const slugs = new Set([...content.matchAll(/<!-- BEGIN (ruflo-[\w-]+|ruvnet-[\w-]+) -->/g)].map((m) => m[1]));
  if (!slugs.size) return;
  ctx.act(`stripped ${slugs.size} managed block(s) from opencode AGENTS.md (backup written)`, () => {
    fs.copyFileSync(ocMd, `${ocMd}.bak.${Date.now()}`);
    for (const s of slugs) content = stripBlock(content, s);
    fs.writeFileSync(ocMd, content);
  });
}

/** Approvals + derived facts for the deja-vu teardown phases below, computed
 * once so target/data/package phases share one confirm pass. */
async function computeDejaVuPlan(ctx) {
  const { cfg, dry, flags } = ctx;
  const dejaOwn = dejaVuOwnership(cfg);
  const ownsDeja = hasDejaVuOwnership(cfg);
  const ownedTargetCount = plain(dejaOwn?.targets) ? Object.keys(dejaOwn.targets).length : 0;
  const dejaAdapter = ctx.deps.dejaAdapter ?? companionLifecycleFor('deja-vu');
  let removePackageApproved = false;
  let purgeDataApproved = dry && flags['purge-deja-vu-data'];
  if (!dry && flags['remove-deja-vu'] && dejaOwn?.install) {
    removePackageApproved = await confirm(
      'Remove the Kit-owned global deja-vu package for ALL projects on this machine?',
      flags.yes,
    );
    if (!removePackageApproved) info('kept deja-vu package');
  }
  if (!dry && flags['purge-deja-vu-data']) {
    purgeDataApproved = await confirm(
      'Delete the derived deja-vu index? Notes, policy, peers, config, and source transcripts stay.',
      flags.yes,
    );
    if (!purgeDataApproved) info('kept deja-vu derived index');
  }
  return {
    dejaOwn, ownsDeja, ownedTargetCount, dejaAdapter, removePackageApproved, purgeDataApproved,
  };
}

async function undoDejaVu(ctx, removePackage) {
  try {
    const retired = await runLifecycle({
      adapter: ctx.plan.dejaAdapter,
      action: 'undo',
      cfg: ctx.cfg,
      options: { removePackage },
    });
    if (retired?.configChanged) saveKitConfig(ctx.cfg);
    return retired;
  } catch {
    return { ok: false, changed: false, configChanged: false };
  }
}

// Phase 1: default uninstall always attempts only Kit-owned target receipts.
async function dejaVuTargetTeardown(ctx) {
  const { ownsDeja, ownedTargetCount, dejaAdapter } = ctx.plan;
  if (ownsDeja && ctx.dry) {
    if (ownedTargetCount > 0) info('[dry-run] remove Kit-owned deja-vu target wiring');
    return;
  }
  if (!ownsDeja) return;
  if (!dejaAdapter) {
    warn('deja-vu teardown unavailable — ownership receipt retained');
    ctx.state.dejaVuTeardownOk = false;
    return;
  }
  const retired = await undoDejaVu(ctx, false);
  ctx.state.dejaVuTeardownOk = retired?.ok === true;
  if (ctx.state.dejaVuTeardownOk) {
    if (retired?.changed) ok('deja-vu: Kit-owned target wiring teardown complete');
  } else {
    warn('deja-vu teardown incomplete — recovery ownership receipts retained');
  }
}

// Phase 2: data has a separate destructive scope and is validated through a
// single offline doctor call. Dry-run performs the validation but no delete.
async function dejaVuDataPurge(ctx) {
  if (!ctx.plan.purgeDataApproved) return;
  const { dry } = ctx;
  if (!dry && !ctx.state.dejaVuTeardownOk) {
    warn('deja-vu derived index retained because ownership teardown is incomplete');
    return;
  }
  const purge = ctx.deps.purgeDejaVuIndex ?? purgeDejaVuIndex;
  const removed = await purge({ homeDir: paths.home, dryRun: dry });
  if (removed?.ok) {
    if (dry) info('[dry-run] validated deja-vu derived index; would delete it (path withheld)');
    else (removed.changed ? ok : info)(removed.changed
      ? 'deja-vu derived index deleted (path withheld)'
      : 'deja-vu derived index was already absent');
  } else {
    warn(`${dry ? '[dry-run] ' : ''}deja-vu derived index refused — validation or doctor check failed (path withheld)`);
    ctx.state.dejaVuTeardownOk = false;
  }
}

// Phase 3: package removal is possible only after target teardown and any
// requested data purge succeeded. A data failure retains the CLI for retry.
async function dejaVuPackageRemoval(ctx) {
  if (!ctx.flags['remove-deja-vu']) return;
  const { dry } = ctx;
  const { ownsDeja, dejaOwn, removePackageApproved } = ctx.plan;
  if (!ownsDeja || !dejaOwn?.install) {
    info('deja-vu package preserved — no Kit ownership receipt');
  } else if (dry) {
    info('[dry-run] uninstall Kit-owned deja-vu package after target/data teardown');
  } else if (removePackageApproved && !ctx.state.dejaVuTeardownOk) {
    warn('deja-vu package retained because target/data teardown is incomplete');
  } else if (removePackageApproved) {
    const retired = await undoDejaVu(ctx, true);
    ctx.state.dejaVuTeardownOk = retired?.ok === true;
    if (ctx.state.dejaVuTeardownOk && retired?.changed) ok('deja-vu: Kit-owned package removed');
    else if (!ctx.state.dejaVuTeardownOk) warn('deja-vu package removal incomplete — ownership receipt retained');
  }
}

// 2c. Companion teardown is receipt-gated and precedes any kit.json purge.
// The sequence is load-bearing: targets first, then the optional derived
// index while `deja doctor` still exists, and only then the optional package.
async function stepDejaVu(ctx) {
  ctx.plan = await computeDejaVuPlan(ctx);
  await dejaVuTargetTeardown(ctx);
  await dejaVuDataPurge(ctx);
  await dejaVuPackageRemoval(ctx);
  ctx.state.ownershipTeardownOk = ctx.state.ownershipTeardownOk && ctx.state.dejaVuTeardownOk;
}

// Registry-driven host lifecycle teardown — reached by id, never by name
// (mirrors x/host.mjs's off(), which does its undo the same way). cfg comes
// from the top of run() (read before any purge of kit.json); --purge
// removes kit.json below, so persisting cfg here would recreate it. Each
// adapter's own undo() already honors ownership/receipts (opencode's
// undoOpencode no-ops when it never held mcp:'ak', and marker-gates
// artifact removal independent of that), so a BUILT-IN's call is
// unconditional per host, same as before ADR-0031 P3 — the only kit-side
// gate is "did anything actually happen", to avoid a no-op teardown line
// (and a needless kit.json rewrite) on a host that was never enabled. An
// ADMITTED external host is different: there is no "always safe, always
// idempotent" guarantee for an arbitrary third-party hook the way there is
// for opencode's own undo, so an admitted host's teardown is gated by
// lifecycleExecutionEnabled (cfg enablement AND the experimental flag) —
// an admitted host that was never enabled/consented for this run is never
// invoked. hostsWithLifecycle() (built-ins + admitted, ADR-0031 P3) is safe
// to loop unconditionally now: lifecycle-render.mjs's renderUndoReport
// dispatches on the runLifecycle result's own shape, so this loop body
// never destructures a host-specific result directly.
async function stepHostLifecycles(ctx) {
  const { cfg, dry, flags } = ctx;
  for (const hostId of hostsWithLifecycle()) {
    if (!isBuiltinHost(hostId) && !lifecycleExecutionEnabled(hostId, cfg)) continue;
    const adapter = lifecycleAdapterFor(hostId);
    if (dry) {
      info(isBuiltinHost(hostId)
        ? `[dry-run] stripped ak-managed ${hostId} wiring + artifacts (opencode.json, plugin, agents, skill)`
        : `[dry-run] stripped ak-managed ${hostId} wiring + artifacts (hook-declared undo)`);
      continue;
    }
    const retired = await runLifecycle({ adapter, action: 'undo', cfg });
    const undoReport = renderUndoReport(hostId, retired);
    ctx.state.ownershipTeardownOk = ctx.state.ownershipTeardownOk && undoReport.ok;
    // Persist markers unconditionally, exactly like x/host.mjs's off()/pick():
    // undo() mutates cfg's ownership markers in memory even when it rewrote
    // no file (`undo.changed` measures the FILE, not cfg), so gating the save
    // on `changed` would strand a stale mcp:'ak' receipt forever on the
    // quiet-success path. Only the human-facing line stays gated on "did
    // anything observable happen".
    if (!flags.purge) saveKitConfig(cfg);
    for (const line of undoReport.lines) printReportLine(line);
  }
}

function stepPurgeArtifacts(ctx) {
  for (const [label, file] of [
    ['model inventory cache', modelInventoryPath()], ['model scope key', modelScopeKeyPath()],
  ]) {
    if (fs.existsSync(file)) ctx.act(`removed ${label}`, () => fs.rmSync(file));
  }
}

function stepPurgeKitConfig(ctx) {
  if (ctx.state.ownershipTeardownOk) {
    ctx.act('removed kit.json', () => fs.rmSync(paths.kitConfigPath()));
  } else if (!ctx.state.dejaVuTeardownOk) {
    warn('kit.json retained because deja-vu teardown is incomplete; it contains recovery ownership receipts');
  } else warn('kit.json retained because OpenCode teardown is incomplete; it contains the recovery ownership receipt');
}

// 3. MCP registration + deny rules
async function stepMcp(ctx) {
  if (ctx.dry) { info('[dry-run] unregister claude-flow/ruflo MCP + clean deny rules'); return; }
  const removed = await unregister();
  ok(`MCP unregistered (deny rules cleaned: ${removed})`);
}

async function stepAgentBrowser(ctx) {
  const removePackage = ctx.flags['remove-agent-browser'] || ctx.flags.purge;
  if (ctx.dry) {
    info(`[dry-run] remove receipt-owned agent-browser MCP config${removePackage ? ' and package' : ''}; preserve browser/session/profile data`);
    return;
  }
  if (removePackage) {
    const approved = await confirm(
      'Remove the Kit-owned global agent-browser package for ALL projects (browser/session/profile data stays)?',
      ctx.flags.yes,
    );
    if (!approved) {
      info('kept agent-browser package');
      const configOnly = removeManagedAgentBrowserConfig(ctx.cfg);
      (configOnly.ok ? ok : warn)(`agent-browser: ${configOnly.detail}`);
      if (!configOnly.ok) ctx.state.ownershipTeardownOk = false;
      saveKitConfig(ctx.cfg);
      return;
    }
    const removed = await removeManagedAgentBrowser(ctx.cfg);
    (removed.ok ? ok : warn)(`agent-browser: ${removed.detail}`);
    if (!removed.ok) ctx.state.ownershipTeardownOk = false;
    saveKitConfig(ctx.cfg);
    return;
  }
  const configOnly = removeManagedAgentBrowserConfig(ctx.cfg);
  (configOnly.ok ? ok : warn)(`agent-browser: ${configOnly.detail}`);
  if (!configOnly.ok) ctx.state.ownershipTeardownOk = false;
  saveKitConfig(ctx.cfg);
}

// 4. legacy shell-kit remnants
function stepLegacyShellKit(ctx) {
  for (const rc of ['.zshrc', '.bashrc'].map((f) => path.join(paths.home, f))) {
    if (!fs.existsSync(rc)) continue;
    const txt = fs.readFileSync(rc, 'utf8');
    if (txt.includes('ruflo-functions.sh')) {
      ctx.act(`removed shell-kit source line from ${rc}`, () => {
        fs.copyFileSync(rc, `${rc}.bak`);
        fs.writeFileSync(rc, txt.split('\n').filter((l) => !l.includes('ruflo-functions.sh')).join('\n'));
      });
    }
  }
  const localBin = path.join(paths.home, '.local', 'bin');
  if (fs.existsSync(localBin)) {
    // every ruflo-* here is shell-kit era (the npm kit's bins live in npm's global bin)
    for (const f of fs.readdirSync(localBin).filter((f) => f.startsWith('ruflo-'))) {
      ctx.act(`removed legacy ${path.join(localBin, f)}`, () => fs.rmSync(path.join(localBin, f)));
    }
  }
  const cfgDir = paths.legacyConfigDir(); // shell-kit files lived in ~/.config/ruflo
  if (fs.existsSync(cfgDir)) {
    for (const f of fs.readdirSync(cfgDir).filter((f) => f.endsWith('.sh') || f.endsWith('-template.md') || f === 'ruflo-reference-full.md')) {
      ctx.act(`removed legacy ${path.join(cfgDir, f)}`, () => fs.rmSync(path.join(cfgDir, f)));
    }
  }
}

// 5. per-project revert
function stepThisProject(ctx) {
  const sl = paths.projectStatusline(process.cwd());
  if (!fs.existsSync(sl)) return;
  ctx.act('reverted statusline footer in this project', () => {
    fs.copyFileSync(sl, `${sl}.bak`);
    let s = fs.readFileSync(sl, 'utf8');
    s = s.replace(/\/\* ruflo-seg:BEGIN \*\/[\s\S]*?\/\* ruflo-seg:END \*\/\n?/, '');
    s = s.replace(/ \+ rufloActivationSegments\(process\.cwd\(\)\)/g, '');
    fs.writeFileSync(sl, s);
  });
}

// 6. global packages (machine-wide — confirmed individually)
async function stepGlobalPackages(ctx) {
  const { flags, dry } = ctx;
  const removals = [];
  if (flags['remove-ruflo'] || flags.purge) removals.push('ruflo');
  if (flags['remove-aqe'] || flags.purge) removals.push('agentic-qe');
  for (const pkg of removals) {
    if (dry) { info(`[dry-run] npm uninstall -g ${pkg}`); continue; }
    if (await confirm(`Remove global ${pkg} for ALL projects on this machine?`, flags.yes)) {
      if (pkg === 'ruflo') await runCmd('ruflo', ['daemon', 'stop', '--all'], { timeout: 60_000 });
      const r = await runCmd('npm', ['uninstall', '-g', pkg], { timeout: 300_000 });
      (r.code === 0 ? ok : warn)(`${pkg}: ${r.code === 0 ? 'removed' : 'could not remove'}`);
    } else info(`kept ${pkg}`);
  }
}

// RuvNet Brain: a user-scope plugin + a large (~512 MB) KB cache — left in
// place (like ruflo/aqe) rather than force-deleted. Point at the manual path.
function stepRuvnetBrainNotice() {
  if (rbPresent()) {
    info('RuvNet Brain left installed — remove manually: `claude plugin uninstall ruvnet-brain@ruvnet-brain` + `rm -rf ~/.cache/ruvnet-brain`');
  }
}

export const UNINSTALL_STEPS = [
  { id: 'codex-statusline', when: (ctx) => !!ctx.cfg.statusline?.codex, run: stepCodexStatusline },
  { id: 'claude-md-blocks', when: () => true, run: stepClaudeMdBlocks },
  { id: 'skill', when: () => true, run: stepSkill },
  { id: 'opencode-agents-md', when: () => true, run: stepOpencodeAgentsMd },
  { id: 'deja-vu', when: () => true, run: stepDejaVu },
  { id: 'host-lifecycles', when: () => true, run: stepHostLifecycles },
  { id: 'agent-browser', when: () => true, run: stepAgentBrowser },
  { id: 'purge-artifacts', when: (ctx) => ctx.flags.purge, run: stepPurgeArtifacts },
  {
    id: 'purge-kit-config',
    when: (ctx) => ctx.flags.purge && fs.existsSync(paths.kitConfigPath()),
    run: stepPurgeKitConfig,
  },
  { id: 'mcp', when: () => true, run: stepMcp },
  { id: 'legacy-shell-kit', when: () => true, run: stepLegacyShellKit },
  { id: 'this-project', when: (ctx) => ctx.flags['this-project'], run: stepThisProject },
  { id: 'global-packages', when: () => true, run: stepGlobalPackages },
  { id: 'ruvnet-brain-notice', when: () => true, run: stepRuvnetBrainNotice },
];

/** @param {{flags:Record<string,boolean>,deps?:UninstallDeps}} request */
export async function run({ flags, deps = {} }) {
  const dry = flags['dry-run'];
  const act = (msg, fn) => { if (dry) info(`[dry-run] ${msg}`); else { fn(); ok(msg); } };
  // Ownership markers are read ONCE up front: the purge path removes kit.json
  // below, and teardown decisions (opencode undo) must still see what ak owned
  // (codex-review — purge ordering must not strand managed opencode.json keys).
  const cfg = loadKitConfig();
  const ctx = {
    flags,
    dry,
    deps,
    cfg,
    act,
    state: { ownershipTeardownOk: true, dejaVuTeardownOk: true },
  };

  for (const step of UNINSTALL_STEPS) {
    if (step.when(ctx)) await step.run(ctx);
  }

  ok('uninstall complete — project data (.swarm/.claude-flow/.agentic-qe) untouched');
  return ctx.state.ownershipTeardownOk ? 0 : 1;
}
