// ak uninstall — remove the kit's machine footprint (default), a
// project's patches (--this-project), and optionally the global packages
// (--remove-ruflo / --remove-aqe / --purge, each confirmed). Also cleans a
// LEGACY shell-kit install (rc source lines, ~/.local/bin/ruflo-*,
// ~/.config/ruflo shell files) — the migration path off the bash era.
import fs from 'node:fs';
import { releaseCodexContext } from '../lib/codex-context.mjs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { run as runCmd, have } from '../lib/exec.mjs';
import { stripBlock, BEGIN, BUILTIN_BLOCKS } from '../lib/blocks.mjs';
import { unregister } from '../lib/mcp.mjs';
import { undoProviders, undoCodexMcp, undoRufloMcpInCodex } from '../lib/providers.mjs';
import { undoAqeRouter } from '../lib/aqe-router.mjs';
import { reconcileAqeEmbeddingProjections } from '../lib/aqe-embedding-projection.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { releaseRufloComponents } from '../lib/ruflo-components/teardown.mjs';
import { releaseAqePins } from '../lib/aqe-project-pin.mjs';
import { installedVersion } from '../lib/versions.mjs';
import { runLifecycle } from '../lib/adapters/lifecycle.mjs';
import { hostsWithLifecycle, lifecycleAdapterFor, lifecycleExecutionEnabled, isBuiltinHost } from '../lib/adapters/lifecycle-registry.mjs';
import { companionLifecycleFor } from '../lib/adapters/companion-lifecycle-registry.mjs';
import { renderUndoReport } from '../lib/adapters/lifecycle-render.mjs';
import { parseDejaVuDoctor, validateDejaVuIndexPath } from '../lib/deja-vu.mjs';
import { present as rbPresent } from '../lib/ruvnet-brain.mjs';
import { disableRuvnetBrainNightly } from '../lib/heal.mjs';
import { AQE_EMBEDDING_MODEL, OLLAMA_EMBEDDING_MODEL } from '../lib/aqe-embedding-config.mjs';
import * as paths from '../lib/paths.mjs';
import { brainShimPath } from '../lib/opencode-core.mjs';
import { ok, warn, fail, info } from '../lib/output.mjs';
import { removeCodexStatusline } from '../lib/codex-statusline.mjs';
import { modelInventoryPath, modelScopeKeyPath } from '../lib/model-inventory/store.mjs';
import { removeManagedAgentBrowser, removeManagedAgentBrowserConfig } from '../lib/agent-browser.mjs';
import { editLabel, installEditStatus, restoreInstallEdits } from '../lib/install-edits.mjs';

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
blocks, MCP registration), puts back the better-sqlite3 lines ak changed inside
Ruflo's install (only where they still hold ak's value; \`ak status\` lists
them), and cleans any legacy shell-kit install. The global packages (ruflo,
agentic-qe) stay unless you ask for them. Each removal is confirmed unless --yes.

Usage: ak uninstall [options]

Options:
  --this-project   also remove this project's patches (settings, .claude-flow)
  --remove-ruflo   uninstall the global ruflo package (confirmed)
  --remove-aqe     uninstall the global agentic-qe package (confirmed)
  --remove-agent-browser  uninstall only a receipt-owned agent-browser package
  --remove-deja-vu uninstall the Kit-owned deja-vu package (confirmed)
  --purge-deja-vu-data delete only the derived deja-vu index (confirmed)
  --purge          remove Kit footprint + ruflo/aqe and receipt-owned agent-browser, and
                   undo what \`ak host off\` undoes: provider env, the AQE router, the
                   Codex MCP entries ak registered and the AQE embedding settings, each
                   by receipt; asks before removing the RuvNet Brain plugin and nightly
                   updater (its knowledge base is kept) and the Ollama alias ak created;
                   keeps the deja-vu package/index and a standalone global agentdb unless
                   you answer yes at their prompts (--yes does not approve those);
                   preserves all browser/session/profile data
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

// For defaults that KEEP data: only a typed interactive yes counts. `--yes` does not
// approve these, so `ak uninstall --purge --yes` can never delete them.
const confirmKeep = async (q) => {
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
  const configBases = [path.join(homeDir, '.config'), paths.xdgBase('XDG_CONFIG_HOME', null, { env }), env.APPDATA]
    .filter(absolute);
  const dataBases = [path.join(homeDir, '.local', 'share'), paths.xdgBase('XDG_DATA_HOME', null, { env })]
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

/** @typedef {{dejaAdapter?:any,purgeDejaVuIndex?:typeof purgeDejaVuIndex,installEdits?:{ledger?:string,runner?:typeof runCmd}}} UninstallDeps */

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
  const ask = ctx.deps?.extras?.confirmKeep ?? confirmKeep;
  let removePackageApproved = false;
  let purgeDataApproved = dry && flags['purge-deja-vu-data'];
  if (dry && flags.purge && !flags['purge-deja-vu-data']) {
    info('[dry-run] deja-vu package and derived index: kept unless you answer yes at the prompt (--yes does not approve them)');
  }
  // An explicit flag keeps today's behaviour (--yes approves). Under --purge alone the
  // default is to keep, so only an interactive yes approves (#311).
  if (!dry && (flags['remove-deja-vu'] || flags.purge) && dejaOwn?.install) {
    const q = 'Remove the Kit-owned global deja-vu package for ALL projects on this machine?';
    removePackageApproved = flags['remove-deja-vu'] ? await confirm(q, flags.yes) : await ask(q);
    if (!removePackageApproved) info('kept deja-vu package');
  }
  // Under --purge alone, ask about the index only when deja-vu is actually installed.
  if (!dry && (flags['purge-deja-vu-data'] || (flags.purge && ownsDeja))) {
    const q = 'Delete the derived deja-vu index? Notes, policy, peers, config, and source transcripts stay.';
    purgeDataApproved = flags['purge-deja-vu-data'] ? await confirm(q, flags.yes) : await ask(q);
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
  if (!ctx.flags['remove-deja-vu'] && !ctx.flags.purge) return;
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

// ADR-0058: release every ak-owned ruflo component setting (Claude env keys, and in every
// receipted project the policy file, project env and memory pin; the funnel toggle), and
// only under --purge, the typesafe package. Runs BEFORE purge-artifacts/
// purge-kit-config (not literally adjacent to 'mcp', but still strictly
// before it in this array) because it calls saveKitConfig — placed after
// kit.json's own purge, that save would resurrect the file a purge just
// deleted (codex-review: 'purge must not recreate kit.json').
async function stepRufloComponents(ctx) {
  if (ctx.dry) {
    info('[dry-run] remove ak-owned ruflo component settings, policy files and funnel change; keep @ruvector/typesafe unless --purge');
    return;
  }
  const report = { ok, warn, info };
  const result = await releaseRufloComponents(ctx.cfg, {
    cwd: process.cwd(), purge: Boolean(ctx.flags.purge), rufloVersion: installedVersion('ruflo'),
  });
  for (const line of result.lines) report[line.level](line.text);
  // Controller ruling: every teardown failure here must gate kit.json's purge and the
  // exit code, exactly like every other uninstall step that can fail to release what it owns.
  if (!result.ok) ctx.state.ownershipTeardownOk = false;
  saveKitConfig(ctx.cfg);
}

// B5-D1: put back the AQE pin's before-state (AQE's own relative AQE_MEMORY_PATH
// included) in every project kit.json recorded and in this one. Before any
// kit.json purge, like the step above.
function stepAqePin(ctx) {
  if (ctx.dry) {
    info('[dry-run] remove the AQE project pin (AQE_PROJECT_ROOT, AQE_MEMORY_PATH, AQE_STORAGE_PATH) where ak wrote it');
    return;
  }
  const report = { ok, warn, info };
  const result = releaseAqePins(ctx.cfg, { cwd: process.cwd() });
  for (const line of result.lines) report[line.level](line.text);
  if (!result.ok) ctx.state.ownershipTeardownOk = false;
  saveKitConfig(ctx.cfg);
}

// #310 (exit release): the teardown `ak host off` runs, which --purge used to skip.
// Each undo restores only values whose receipts show ak wrote them, so a user's own
// provider env, router config or Codex MCP entry is preserved. It runs under --purge
// only, and before purge-kit-config, so the receipts in kit.json are still readable.
// `deps.undo` replaces the real calls in tests.
const REAL_UNDO = {
  providers: undoProviders,
  aqeRouter: undoAqeRouter,
  codexMcp: undoCodexMcp,
  rufloMcpInCodex: undoRufloMcpInCodex,
  aqeEmbedding: reconcileAqeEmbeddingProjections,
};

async function stepHostOffTeardown(ctx) {
  const { cfg, dry } = ctx;
  if (dry) {
    info('[dry-run] restore ak-owned provider env (ENABLE_*, AQE_LLM_PROVIDER, AQE_MAX_BUDGET_USD) by receipt');
    info('[dry-run] restore or remove the ak-managed AQE router config by receipt');
    info('[dry-run] remove the Codex MCP entries ak registered (Codex MCP, ruflo MCP in Codex)');
    info('[dry-run] release ak-owned AQE embedding projections in Codex and OpenCode config by receipt');
    return;
  }
  const undo = { ...REAL_UNDO, ...(ctx.deps?.undo ?? {}) };
  const cwd = process.cwd();
  const codexOwn = cfg.integrations?.ownership?.codex ?? {};
  const results = [
    undo.providers(cwd),
    undo.aqeRouter(cwd),
    await undo.codexMcp(cwd, { managed: codexOwn.mcp === 'ak' }),
    await undo.rufloMcpInCodex(cwd, { managed: codexOwn.reverseMcp === 'ak' }),
    // unmanaged mode makes the projection remove only the keys its receipts show ak wrote
    undo.aqeEmbedding({ ...cfg, aqeEmbedding: { mode: 'unmanaged' } }, cwd),
  ];
  const [, , codex, rufloCodex] = results;
  for (const r of results) (r.ok ? ok : warn)(r.detail);
  if (results.some((r) => !r.ok)) ctx.state.ownershipTeardownOk = false;
  // A removed entry no longer needs its receipt; a failed removal keeps it for a retry.
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.codex = {
    ...codexOwn,
    ...(codex.ok ? { mcp: null } : {}),
    ...(rufloCodex.ok ? { reverseMcp: null } : {}),
  };
  saveKitConfig(cfg);
}

// #311 (exit release): what older ak installed outside kit.json's receipts. Removals
// ak can show it owns ask first; the knowledge base and anything the user installed
// themselves are never touched. A failure sets the exit code but not kit.json's fate,
// because none of these depend on a receipt.
const REAL_EXTRAS = {
  confirm,
  confirmKeep,
  run: runCmd,
  have,
  brainPresent: rbPresent,
  brainShim: brainShimPath,
  disableNightly: disableRuvnetBrainNightly,
  // The standalone global copy, never the one Ruflo bundles inside its own tree.
  agentdbDir: () => { try { const d = path.join(paths.globalRoot(), 'agentdb'); return fs.existsSync(d) ? d : null; } catch { return null; } },
};
const AGENTDB_REMOVE_CMD = 'npm uninstall -g agentdb';

// The Brain installer, not ak, writes this stable-spine MCP shim, so it goes only after the
// same confirmation as the plugin, only as a regular file, and its folders only when empty.
function brainShimFile(x) {
  const shim = x.brainShim();
  try {
    if (fs.lstatSync(shim).isFile()) return shim;
    info(`${shim} is not a regular file — left alone`);
  } catch { /* absent */ }
  return null;
}
function removeBrainShim(shim, ctx) {
  try {
    fs.rmSync(shim);
    for (const dir of [path.dirname(shim), path.dirname(path.dirname(shim))]) {
      try { fs.rmdirSync(dir); } catch { break; } // not empty or already gone: leave it
    }
    ok(`RuvNet Brain MCP shim: removed ${shim}`);
  } catch (e) {
    warn(`RuvNet Brain MCP shim: could not remove ${shim} — ${e.message}`);
    ctx.state.extrasOk = false;
  }
}

async function purgeBrain(x, ctx) {
  const plugin = x.brainPresent();
  const shim = brainShimFile(x);
  if (!plugin && !shim) return;
  const what = [
    plugin && 'the RuvNet Brain plugin and its nightly LaunchAgent',
    shim && `the Brain MCP shim ${shim}`,
  ].filter(Boolean).join(' and ');
  if (ctx.dry) {
    info(`[dry-run] remove ${what} (confirmed); the knowledge base in ~/.cache/ruvnet-brain is kept`);
    return;
  }
  if (!await x.confirm(`Remove ${what}? The knowledge base is kept.`, ctx.flags.yes)) {
    info('kept the RuvNet Brain plugin and shim');
    return;
  }
  let pluginGone = !plugin;
  if (plugin) {
    const removed = await x.run('claude', ['plugin', 'uninstall', 'ruvnet-brain@ruvnet-brain'], { timeout: 60_000 });
    const nightly = await x.disableNightly();
    pluginGone = removed.code === 0;
    (pluginGone ? ok : warn)(`RuvNet Brain plugin: ${pluginGone ? 'removed' : 'could not remove — run `claude plugin uninstall ruvnet-brain@ruvnet-brain`'}`);
    (nightly.ok ? ok : warn)(`RuvNet Brain nightly updater: ${nightly.detail}`);
    if (!pluginGone || !nightly.ok) ctx.state.extrasOk = false;
  }
  if (shim && pluginGone) removeBrainShim(shim, ctx);
  else if (shim) warn(`RuvNet Brain MCP shim kept at ${shim} while the plugin is installed — run the purge again once the plugin is removed`);
  info('RuvNet Brain knowledge base kept in ~/.cache/ruvnet-brain (delete it yourself if you do not want it)');
}

// The alias is a copy of the model ak pulled, so it shares that model's ID in
// `ollama list`. A different ID means someone else made it: leave it alone.
function ollamaIds(listing, names) {
  const ids = {};
  for (const line of String(listing).split('\n').slice(1)) {
    const [name, id] = line.trim().split(/\s+/);
    for (const n of names) if (name === n || name === `${n}:latest`) ids[n] = id;
  }
  return ids;
}
async function purgeOllamaAlias(x, ctx) {
  if (ctx.dry) {
    info(`[dry-run] remove the Ollama alias ${AQE_EMBEDDING_MODEL} if it is a copy of ${OLLAMA_EMBEDDING_MODEL} (confirmed)`);
    return;
  }
  if (!await x.have('ollama')) return;
  const listed = await x.run('ollama', ['list'], { timeout: 30_000 });
  if (listed.code !== 0) return;
  const ids = ollamaIds(listed.stdout, [AQE_EMBEDDING_MODEL, OLLAMA_EMBEDDING_MODEL]);
  if (!ids[AQE_EMBEDDING_MODEL]) return;
  if (ids[AQE_EMBEDDING_MODEL] !== ids[OLLAMA_EMBEDDING_MODEL]) {
    info(`Ollama model ${AQE_EMBEDDING_MODEL} is not a copy ak made — left alone`);
    return;
  }
  if (!await x.confirm(`Remove the Ollama alias ${AQE_EMBEDDING_MODEL}? The ${OLLAMA_EMBEDDING_MODEL} model stays.`, ctx.flags.yes)) {
    info('kept the Ollama alias');
    return;
  }
  const rm = await x.run('ollama', ['rm', AQE_EMBEDDING_MODEL], { timeout: 60_000 });
  (rm.code === 0 ? ok : warn)(`Ollama alias: ${rm.code === 0 ? 'removed' : `could not remove — run \`ollama rm ${AQE_EMBEDDING_MODEL}\``}`);
  if (rm.code !== 0) ctx.state.extrasOk = false;
}

// Older ak installed a standalone global agentdb with no ownership receipt. The only
// trace is the retired `agentdb` key in kit.json, so a copy is removed only with that key
// AND a typed interactive yes; otherwise the command is printed for the user.
async function purgeAgentdb(x, ctx) {
  const dir = x.agentdbDir();
  if (ctx.dry) { info(`[dry-run] standalone agentdb: remove only with the older-ak marker and an interactive yes, else print \`${AGENTDB_REMOVE_CMD}\``); return; }
  if (!dir) return;
  const markedByOlderAk = Object.hasOwn(ctx.cfg, 'agentdb');
  if (markedByOlderAk && await x.confirmKeep('Remove the standalone global agentdb that an older ak installed?')) {
    const r = await x.run('npm', ['uninstall', '-g', 'agentdb'], { timeout: 300_000 });
    (r.code === 0 ? ok : warn)(`agentdb: ${r.code === 0 ? 'removed' : 'could not remove'}`);
    if (r.code !== 0) ctx.state.extrasOk = false;
    return;
  }
  info(`standalone agentdb left installed${markedByOlderAk ? '' : ' (ak cannot show it installed this copy)'} — remove it yourself if you do not use it: \`${AGENTDB_REMOVE_CMD}\``);
}

async function stepPurgeExtras(ctx) {
  const x = { ...REAL_EXTRAS, ...(ctx.deps?.extras ?? {}) };
  await purgeBrain(x, ctx);
  await purgeOllamaAlias(x, ctx);
  await purgeAgentdb(x, ctx);
}

// #312 (exit release): ak's own config and state folders go once every teardown that reads
// receipts has finished. Two things are the user's data, not ak's, and stay unless a typed
// interactive yes (not --yes) says otherwise: the AQE store-merge archives and backups, and
// the user-level Ruflo memory store. Runs LAST: install-edits.json lives in the state folder
// and stepInstallEdits reads it.
const UNRESTORABLE_EDITS = 'Three edits that older ak releases made inside Ruflo\'s install before ak kept receipts cannot be restored. Reinstall Ruflo to get its shipped files back.';

// Only ever remove a folder this code created: its own name, and not a symlink.
function removableOwnDir(dir) {
  try { return path.basename(dir) === 'agentic-kit' && !fs.lstatSync(dir).isSymbolicLink(); } catch { return false; }
}
async function keepOrDelete(x, ctx, dir, label, question) {
  if (!fs.existsSync(dir)) return true;
  if (await x.confirmKeep(question)) {
    try { fs.rmSync(dir, { recursive: true }); ok(`${label} deleted`); return false; }
    catch (error) { warn(`${label} could not be deleted: ${error.message}`); ctx.state.extrasOk = false; return true; }
  }
  info(`kept ${label} (${dir}) — it is your data, not ak configuration`);
  return true;
}

async function stepPurgeConfigState(ctx) {
  const stateDir = path.join(paths.stateBase(), 'agentic-kit');
  const configDir = paths.configDir();
  const archives = paths.aqeStoreMergeDir();
  const memory = paths.userMemoryDir();
  if (ctx.dry) {
    info(`[dry-run] ${UNRESTORABLE_EDITS}`);
    info(`[dry-run] remove ${configDir} and ${stateDir} after teardown succeeds (adapter consent and grants go with the config folder)`);
    if (fs.existsSync(archives)) info(`[dry-run] keep the AQE store-merge archives in ${archives} unless you answer yes at the prompt (--yes does not approve it)`);
    if (fs.existsSync(memory)) info(`[dry-run] keep the Ruflo memory store ${memory} unless you answer yes at the prompt (--yes does not approve it)`);
    return;
  }
  if (!ctx.state.ownershipTeardownOk) {
    warn('config and state folders retained because a teardown above is incomplete; they hold the receipts a retry needs');
    return;
  }
  const x = { ...REAL_EXTRAS, ...(ctx.deps?.extras ?? {}) };
  const archivesKept = fs.existsSync(archives)
    ? await keepOrDelete(x, ctx, archives, 'AQE store-merge archives and backups', `Delete the AQE store-merge archives and backups in ${archives}? They are your data.`)
    : false;
  await keepOrDelete(x, ctx, memory, 'the Ruflo memory store', `Delete the user-level Ruflo memory store ${memory}? It holds your memories.`);
  if (removableOwnDir(stateDir)) {
    for (const entry of fs.readdirSync(stateDir)) {
      if (archivesKept && path.join(stateDir, entry) === archives) continue;
      fs.rmSync(path.join(stateDir, entry), { recursive: true, force: true });
    }
    if (!fs.readdirSync(stateDir).length) fs.rmdirSync(stateDir);
    ok(`removed ak state${archivesKept ? ' (archives kept)' : ''}`);
  }
  if (removableOwnDir(configDir)) { fs.rmSync(configDir, { recursive: true, force: true }); ok('removed ak config'); }
  info(UNRESTORABLE_EDITS);
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
  } else if (ctx.cfg.codexContext) warn('kit.json retained because Codex context teardown is incomplete; it contains the recovery ownership receipt');
  else warn('kit.json retained because OpenCode teardown is incomplete; it contains the recovery ownership receipt');
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

// 5b. ak's receipted edits inside other tools' installs (install-edits.mjs):
// better-sqlite3 lines ak rewrote so the native binding could be installed
// (Ruflo's own intent, ruvnet/ruflo#2219). Restored only where the file still
// holds ak's value; a value someone else changed since is left alone. Runs on
// every uninstall and before global packages, so an edit is reversed even when
// ruflo stays installed. A restore that does not take keeps its receipt.
async function stepInstallEdits(ctx) {
  const options = ctx.deps?.installEdits ?? {};
  let rufloRoot = null;
  try { rufloRoot = paths.rufloRoot(); } catch { /* no npm global root: label by folder */ }
  const applied = installEditStatus(options).filter((edit) => edit.state === 'applied');
  if (ctx.dry) {
    for (const edit of applied) {
      info(`[dry-run] restore ${editLabel(edit, { rufloRoot })} ${edit.section} ${edit.name} from ak's ${edit.to} to the original ${edit.from ?? '(absent)'}`);
    }
    return;
  }
  const result = await restoreInstallEdits({ ...options, rufloRoot });
  const report = { ok, warn, info };
  for (const line of result.lines) report[line.level](line.text);
  if (!result.ok) ctx.state.ownershipTeardownOk = false;
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
function stepRuvnetBrainNotice(ctx) {
  if (ctx?.flags?.purge) return; // --purge asks about the plugin itself (purge-extras)
  if (rbPresent()) {
    info('RuvNet Brain left installed — remove manually: `claude plugin uninstall ruvnet-brain@ruvnet-brain` + `rm -rf ~/.cache/ruvnet-brain`');
  }
}

export const UNINSTALL_STEPS = [
  { id: 'codex-context', when: ctx => !!ctx.cfg.codexContext, run: async ctx => {
    if (ctx.dry) { info('[dry-run] restore unchanged managed Codex context scalar'); return; }
    try { await releaseCodexContext(ctx.cfg, { persist: saveKitConfig }); }
    catch (error) {
      ctx.state.ownershipTeardownOk = false;
      warn(`Codex context ownership retained: ${error.message}`);
    }
  } },
  { id: 'codex-statusline', when: (ctx) => !!ctx.cfg.statusline?.codex, run: stepCodexStatusline },
  { id: 'claude-md-blocks', when: () => true, run: stepClaudeMdBlocks },
  { id: 'skill', when: () => true, run: stepSkill },
  { id: 'opencode-agents-md', when: () => true, run: stepOpencodeAgentsMd },
  { id: 'deja-vu', when: () => true, run: stepDejaVu },
  { id: 'host-lifecycles', when: () => true, run: stepHostLifecycles },
  { id: 'agent-browser', when: () => true, run: stepAgentBrowser },
  { id: 'aqe-pin', when: () => true, run: stepAqePin },
  { id: 'ruflo-components', when: () => true, run: stepRufloComponents },
  { id: 'host-off-teardown', when: (ctx) => ctx.flags.purge, run: stepHostOffTeardown },
  { id: 'purge-extras', when: (ctx) => ctx.flags.purge, run: stepPurgeExtras },
  { id: 'purge-artifacts', when: (ctx) => ctx.flags.purge, run: stepPurgeArtifacts },
  {
    id: 'purge-kit-config',
    when: (ctx) => ctx.flags.purge && fs.existsSync(paths.kitConfigPath()),
    run: stepPurgeKitConfig,
  },
  { id: 'mcp', when: () => true, run: stepMcp },
  { id: 'legacy-shell-kit', when: () => true, run: stepLegacyShellKit },
  { id: 'this-project', when: (ctx) => ctx.flags['this-project'], run: stepThisProject },
  { id: 'install-edits', when: () => true, run: stepInstallEdits },
  { id: 'global-packages', when: () => true, run: stepGlobalPackages },
  { id: 'purge-config-state', when: (ctx) => ctx.flags.purge, run: stepPurgeConfigState },
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
    state: { ownershipTeardownOk: true, dejaVuTeardownOk: true, extrasOk: true },
  };

  for (const step of UNINSTALL_STEPS) {
    if (step.when(ctx)) await step.run(ctx);
  }

  ok('uninstall complete — project data (.swarm/.claude-flow/.agentic-qe) untouched');
  return ctx.state.ownershipTeardownOk && ctx.state.extrasOk ? 0 : 1;
}
