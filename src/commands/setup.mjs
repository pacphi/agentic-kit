// ak setup — context-aware first-time setup.
//   Machine scope (always ensured): ruflo + agentic-qe installed globally
//   (security surface is part of ruflo — verified, not separately installed),
//   token-audit skill deployed, CLAUDE.md managed blocks merged, MCP offered.
//   Project scope (when run inside a git repo / --project): the port of
//   ruflo-setup-project — init, sanitize, pin, activate, verify, daemon.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { run as runCmd, have } from '../lib/exec.mjs';
import * as heal from '../lib/heal.mjs';
import { fixStatusline } from '../lib/statusline.mjs';
import { reconcileGuidance } from '../lib/blocks.mjs';
import { captureProjectGuidance, reconcileProjectGuidance } from '../lib/project-guidance.mjs';
import { register as mcpRegister, applyExclusions } from '../lib/mcp.mjs';
import { reconcileOpencodeGuidance } from '../lib/opencode.mjs';
import { runLifecycle } from '../lib/adapters/lifecycle.mjs';
import { hostsWithLifecycle, lifecycleAdapterFor, lifecycleExecutionEnabled, detectionBinFor } from '../lib/adapters/lifecycle-registry.mjs';
import { companionLifecycleFor } from '../lib/adapters/companion-lifecycle-registry.mjs';
import { managedCompanionFor } from '../lib/adapters/companion-registry.mjs';
import { renderApplyReport } from '../lib/adapters/lifecycle-render.mjs';
import { DEJA_VU_TARGETS } from '../lib/deja-vu.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { HOSTS, hostInstallState, installHost, migrateRetiredRoutesInConfig, printActivityRoutingTable, aqeSupportsAgentOverrides, convergeProviderStack, applySetupHostFlags, guidanceContext, reportRetiredRouteChanges } from '../lib/providers.mjs';
import { installedVersion } from '../lib/versions.mjs';
import * as rb from '../lib/ruvnet-brain.mjs';
import * as adb from '../lib/agentdb.mjs';
import { readJson, writeJsonWithBackup } from '../lib/settings.mjs';
import { withDb } from '../lib/sqlite.mjs';
import { findMemoryEntry } from '../lib/project-memory.mjs';
import { projectMemoryEnv } from '../lib/ruflo-memory.mjs';
import {
  setupTrustManifest, trustManifestLines,
} from '../lib/trust-manifest.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, fail, info, heading, bold, dim, reportOutcome } from '../lib/output.mjs';

const DEJA_VU = managedCompanionFor('deja-vu');
const DEFAULT_DEJA_VU_LIFECYCLE = companionLifecycleFor('deja-vu');

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
  yes: { type: 'boolean', default: false },
  minimal: { type: 'boolean', default: false },
  project: { type: 'boolean', default: false },
  'no-aqe': { type: 'boolean', default: false },
  'no-ruvnet-brain': { type: 'boolean', default: false },
  'no-security': { type: 'boolean', default: false },
  codex: { type: 'boolean', default: false },
  opencode: { type: 'boolean', default: false },
  'with-deja-vu': { type: 'boolean', default: false },
  'deja-vu-mode': { type: 'string' },
  'no-deja-vu': { type: 'boolean', default: false },
  'primary-host': { type: 'string' },
  reconfigure: { type: 'boolean', default: false },
};

export const help = `ak setup — first-time setup (machine and/or this project)

Machine scope always runs: installs ruflo + agentic-qe globally, deploys the
token-audit skill, merges the CLAUDE.md managed blocks, and offers MCP. Project
scope auto-runs when .git exists in the current directory. Project setup runs
Ruflo and AQE initializers while preserving user-authored CLAUDE.md/AGENTS.md
content and reconciling only sentinel-owned guidance. Details: docs/SETUP.md

Usage: ak setup [options]

Options:
  --project        force project setup in cwd even without .git; same mutations
  --minimal        machine scope only; skip project setup
  --no-aqe         skip agentic-qe install + configuration
  --no-ruvnet-brain  skip the RuvNet Brain (~2 GB offline KB) setup step
  --no-security    skip the security-surface verification
  --codex          enable + install the OpenAI Codex host during setup (dual-mode;
                     default is claude-only, codex opt-in). Installs @openai/codex
                     if absent (prompted; external installs untouched), wires
                     shared Ruflo/AQE access, and seeds per-activity routing.
  --opencode       enable the opencode host during setup: wires opencode.json
                     (claude-flow + ruvnet-brain MCP, skills paths, permissions),
                     deploys the lifecycle plugin + platform skill, and converts
                     the ruflo agent set into opencode subagents. Already set up?
                     Use: ak host pick --host claude,opencode
  --with-deja-vu   explicitly install/manage deja-vu 0.19+ for enabled Kit hosts;
                     default mode is MCP and setup runs one bounded \`deja index\`
  --deja-vu-mode <m>  companion mode: mcp|auto; auto is a second consent for
                     automatic recalls, including action-time events where supported
  --no-deja-vu     keep the optional companion disabled (the setup default)
  --primary-host <h>  which host leads: claude|codex (default claude). Passing
                     codex implies --codex and mirrors the routing defaults so
                     codex drives with claude as the alternate.
  --reconfigure    re-run interactive choices, ignoring saved kit.json
  --yes            accept prompts non-interactively; still prints the host-neutral
                     setup trust manifest before any machine/user/project changes
  --dry-run        print the plan; change nothing

Examples:
  ak setup                    machine + project (when inside a git repo)
  ak setup --minimal          machine only
  ak setup --codex --yes      install everything incl. codex, non-interactive
  ak setup --with-deja-vu --deja-vu-mode mcp
  ak setup --primary-host codex --yes   dual-host with codex leading
  ak setup --project --yes    force project setup, no prompts`;

const ask = async (q, dflt, yes) => {
  if (yes) return true;
  if (!process.stdin.isTTY) return dflt;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [${dflt ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
  rl.close();
  return a === '' ? dflt : a.startsWith('y');
};

// The authorized/disclosed auto-approve set is the UNION across every
// enabled host's trust manifest, not claude's alone (F-04) — a host whose
// auto-approve rules don't gate on enablement (requiresHostEnabled: false,
// claude's posture today) always contributes; an opt-in host (opencode,
// codex, or a future one) only contributes once cfg actually enables it.
// `hosts` is injectable so tests can prove a second host's rule survives
// removeUndisclosedPermissions through the same seam trust-manifest.test.mjs
// uses for host-registry-construction tests.
export function projectPermissionManifest(cfg, /** @type {{hosts?: any[]}} */ { hosts } = {}) {
  const manifest = setupTrustManifest(cfg, { project: true, ...(hosts ? { hosts } : {}) });
  return manifest.flatMap((group) => group.changes)
    .filter((entry) => entry.kind === 'auto-approve')
    .map((entry) => ({ owner: entry.owner, rule: entry.value, effect: entry.effect }));
}

// The baseline (no non-default host enabled) authorized set — identical to
// "claude's rules" today because every claude auto-approve change sets
// requiresHostEnabled: false, but now derived through the same registry-
// driven path as projectPermissionManifest rather than hardcoded to claude.
export const PROJECT_PERMISSION_MANIFEST = Object.freeze(projectPermissionManifest({}));

/** @param {any} cfg
 * @param {{project?: boolean, companionPreflight?: any}} [options] */
export function discloseSetupTrust(cfg, { project = false, companionPreflight } = {}) {
  const manifest = setupTrustManifest(cfg, { project, companionPreflight });
  if (!manifest.length) return manifest;
  info('setup trust manifest (evaluated before any machine, user, or project changes):');
  for (const line of trustManifestLines(manifest)) console.log(`  ${line}`);
  return manifest;
}

export function validateDejaVuSetupFlags(flags = {}) {
  if (flags['with-deja-vu'] && flags['no-deja-vu']) {
    return { ok: false, error: '--with-deja-vu and --no-deja-vu are mutually exclusive' };
  }
  if (flags['deja-vu-mode'] !== undefined && !DEJA_VU.modes.includes(flags['deja-vu-mode'])) {
    return { ok: false, error: '--deja-vu-mode must be one of: mcp, auto' };
  }
  if (flags['deja-vu-mode'] !== undefined && !flags['with-deja-vu']) {
    return { ok: false, error: '--deja-vu-mode requires --with-deja-vu' };
  }
  return { ok: true };
}

export function applySetupDejaVuFlags(cfg, flags = {}) {
  const intent = cfg.integrations.tools.dejaVu;
  if (flags['no-deja-vu']) {
    const changed = intent.enabled || intent.hosts.length > 0;
    intent.enabled = false;
    intent.hosts = [];
    return { changed };
  }
  if (!flags['with-deja-vu']) return { changed: false };
  const hosts = DEJA_VU.hosts.filter((host) => cfg.integrations.hosts[host] === true);
  const mode = flags['deja-vu-mode'] ?? 'mcp';
  const changed = !intent.enabled || intent.mode !== mode || intent.indexOnSetup !== true
    || JSON.stringify(intent.hosts) !== JSON.stringify(hosts);
  Object.assign(intent, { enabled: true, mode, hosts, indexOnSetup: true });
  return { changed };
}

function safeCompanionCode(value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function validDejaVuPlan(plan) {
  if (!plan || !Array.isArray(plan.operations)) return false;
  return plan.operations.every((operation) => {
    if (!['package-install', 'package-upgrade', 'target-install', 'target-remove', 'index'].includes(operation.kind)) return false;
    if (operation.command === 'deja') {
      if (operation.kind === 'index') {
        return operation.args?.[0] === 'index' && operation.args.length === 1;
      }
      const verb = operation.kind === 'target-install' ? 'install'
        : operation.kind === 'target-remove' ? 'uninstall' : null;
      if (!verb || operation.args?.[0] !== verb) return false;
      return operation.args.length === 4
        && DEJA_VU_TARGETS[operation.host]?.[operation.mode] === operation.args[1]
        && operation.args[2] === '--no-guidance' && operation.args[3] === '--no-index';
    }
    return operation.command === 'npm'
      && ['package-install', 'package-upgrade'].includes(operation.kind)
      && typeof operation.version === 'string'
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(operation.version)
      && operation.args?.[0] === 'install' && operation.args?.[1] === '-g'
      && operation.args?.[2] === `${DEJA_VU.install.npmPackage}@${operation.version}`
      && operation.args?.length === 5
      && operation.args?.[3] === '--no-audit' && operation.args?.[4] === '--no-fund';
  });
}

function hasDejaVuOwnership(cfg) {
  const ownership = cfg.integrations?.ownership?.dejaVu;
  return !!ownership?.install || Object.keys(ownership?.targets ?? {}).length > 0;
}

export async function preflightSetupDejaVu(cfg, companion = DEFAULT_DEJA_VU_LIFECYCLE, {
  removeRequested = false,
} = {}) {
  if (cfg.integrations.tools.dejaVu.enabled !== true
    && !(removeRequested && hasDejaVuOwnership(cfg))) return null;
  const facts = await companion.detect({ cfg });
  const plan = await companion.plan({ cfg, facts });
  if (!validDejaVuPlan(plan)) return { facts, plan, error: 'deja-vu-unbounded-plan-refused' };
  return { facts, plan, error: plan.error ?? null };
}

export async function applySetupDejaVu(cfg, preflight, companion = DEFAULT_DEJA_VU_LIFECYCLE) {
  const result = await companion.apply({ cfg, facts: preflight.facts, plan: preflight.plan });
  // Persist unconditionally: explicit intent and any receipts produced before a
  // partial adapter failure must survive so later repair/removal remains safe.
  saveKitConfig(cfg);
  for (const warning of result.warnings ?? []) warn(`deja-vu: ${safeCompanionCode(warning)}`);
  if (!result.ok) {
    const codes = (result.errors ?? ['unknown']).map(safeCompanionCode).join(', ');
    fail(`deja-vu companion setup failed (${codes}); saved intent/ownership for safe retry`);
    return false;
  }
  ok(`deja-vu companion ready (${result.actions?.length ?? 0} bounded operation(s))`);
  return true;
}

export async function finishSetupDejaVu(cfg, initialPreflight,
  companion = DEFAULT_DEJA_VU_LIFECYCLE, { removeRequested = false } = {}) {
  let fresh;
  try {
    fresh = await preflightSetupDejaVu(cfg, companion, { removeRequested });
  } catch {
    saveKitConfig(cfg);
    fail('deja-vu post-host preflight failed; saved intent/ownership for safe retry');
    return false;
  }
  if (!fresh || fresh.error) {
    saveKitConfig(cfg);
    fail(`deja-vu post-host plan refused (${safeCompanionCode(fresh?.error ?? 'missing-plan')}); saved intent/ownership for safe retry`);
    return false;
  }
  const initiallyResolved = initialPreflight?.plan?.operations?.find((entry) =>
    ['package-install', 'package-upgrade'].includes(entry.kind))?.version;
  const freshlyResolved = fresh.plan.operations.find((entry) =>
    ['package-install', 'package-upgrade'].includes(entry.kind))?.version;
  if (freshlyResolved && (!initiallyResolved || initiallyResolved !== freshlyResolved)) {
    saveKitConfig(cfg);
    fail('deja-vu resolved version changed after consent; saved intent and refused undisclosed package mutation');
    return false;
  }
  return applySetupDejaVu(cfg, fresh, companion);
}

const allowRules = (file) => {
  const allow = readJson(file, {})?.permissions?.allow;
  return Array.isArray(allow) ? allow.filter((rule) => typeof rule === 'string') : [];
};

export function removeUndisclosedPermissions(file, before, authorized) {
  const doc = readJson(file, {}) ?? {};
  const allow = Array.isArray(doc.permissions?.allow) ? doc.permissions.allow : [];
  const unexpected = allow.filter((rule) => !before.has(rule) && !authorized.has(rule));
  if (!unexpected.length) return [];
  doc.permissions.allow = allow.filter((rule) => !unexpected.includes(rule));
  writeJsonWithBackup(file, doc);
  return unexpected;
}

/** Step 1: global packages (ruflo/agentic-qe/agentdb/ruvnet-brain). Returns
 *  false only when the mandatory ruflo install itself fails. */
async function installMachinePackages(cfg, flags) {
  if (!installedVersion('ruflo')) {
    info('installing ruflo globally (native build scripts allowed)…');
    const r = await heal.upgradePackage('ruflo');
    (r.ok ? ok : fail)(`ruflo: ${r.detail}`);
    if (!r.ok) return false;
  } else ok(`ruflo ${installedVersion('ruflo')} present`);
  if (cfg.aqe) {
    if (!installedVersion('agentic-qe')) {
      info('installing agentic-qe globally…');
      const r = await heal.upgradePackage('agentic-qe');
      (r.ok ? ok : warn)(`agentic-qe: ${r.detail}`);
    } else ok(`agentic-qe ${installedVersion('agentic-qe')} present`);
  }
  if (cfg.agentdb) {
    const c = adb.coherence();
    if (!c.present) {
      info("installing agentdb globally (harvest write path; pinned to ruflo's bundled version)…");
      const r = await heal.healAgentdb();
      (r.ok ? ok : warn)(`agentdb: ${r.detail}`);
    } else if (c.skew === 'core') {
      const r = await heal.healAgentdb();
      (r.ok ? ok : warn)(`agentdb: ${r.detail}`);
    } else ok(`agentdb ${c.global} present (coherent with ruflo)`);
  }
  if (cfg.ruvnetBrain) {
    if (!rb.present()) {
      if (await ask('Install the RuvNet Brain (~2 GB offline KB, powers the search_ruvnet MCP)?', true, flags.yes)) {
        info('installing ruvnet-brain via npx (downloads the KB — may take a while)…');
        const r = await heal.installRuvnetBrain();
        reportOutcome('ruvnet-brain', r);
      } else warn('ruvnet-brain skipped — install later with `ak sync` (or `ak setup --no-ruvnet-brain` to stop asking)');
    } else ok('ruvnet-brain present (refresh to the latest release with `ak sync`)');
  }
  return true;
}

/** Step 2: heal natives + the #2670 aidefence gap up front. The aidefence
 *  heal is the security surface — it honors `--no-security`
 *  (cfg.security=false), which was previously write-only: documented,
 *  persisted, read by nothing. */
async function healMachineSecuritySurface(cfg) {
  reportOutcome('natives', await heal.healNatives());
  if (cfg.security !== false) reportOutcome('aidefence', await heal.healAidefence());
  else info('security surface skipped (kit.json security:false — re-enable by removing the key)');
  if (cfg.aqe) reportOutcome('aqe solver', await heal.healAqeSolver());
}

/** Step 3: token-audit skill → ~/.claude/skills. */
function deployTokenAuditSkill(pkgRoot) {
  const skillSrc = path.join(pkgRoot, 'claude', 'skills', 'ruflo-token-audit');
  if (fs.existsSync(skillSrc)) {
    const dst = path.join(paths.claudeSkillsDir(), 'ruflo-token-audit');
    fs.mkdirSync(paths.claudeSkillsDir(), { recursive: true });
    fs.cpSync(skillSrc, dst, { recursive: true });
    ok('skill deployed: ruflo-token-audit');
  }
}

/** Step 6: frontier hosts — install any ENABLED host that is entirely absent
 *  (default enables claude only). External installs (mise/native/brew) are
 *  left alone. Shares HOSTS/hostInstallState/installHost with `ak sync`'s
 *  and `ak host pick`'s own host-install loops; the interactive confirmation
 *  here (vs. their unconditional install) is this command's own UX. */
async function installEnabledAbsentHosts(cfg, flags) {
  for (const h of HOSTS) {
    if (!cfg.integrations?.hosts?.[h.id]) continue;
    const st = await hostInstallState(h);
    if (st.method === 'absent') {
      if (await ask(`${h.id} CLI not found — install ${h.pkg} globally?`, true, flags.yes)) {
        const r = await installHost(h.id);
        (r.ok ? ok : warn)(`${h.id}: ${r.detail}`);
      } else warn(`${h.id} not installed — enable/install later with: ak host pick`);
    } else {
      ok(`${h.id} ${st.version ?? ''} present (${st.method}${st.method === 'external' ? ' — self-managed' : ''})`);
    }
  }
}

/** Step 6b: host lifecycle wiring — connected MCPs, compact lazy gateway,
 *  lifecycle plugin, converted agents, specialist dispatcher, and platform
 *  skill (each adapter owns its own surfaces — opencode.mjs for opencode; a
 *  subprocess hook for an admitted external, see lifecycle-registry.mjs's
 *  buildAdmittedLifecycleAdapter). Registry-driven: loops
 *  hostsWithLifecycle() (built-ins + admitted, ADR-0031 P3) rather than
 *  naming opencode, so a second lifecycle host — built-in or admitted —
 *  needs no new branch here. lifecycleExecutionEnabled gates each host: a
 *  built-in only needs cfg enablement (unchanged); an admitted external
 *  ALSO needs the experimental flag — an admitted host is opt-in exactly
 *  like opencode, and this never auto-enables anything. Only when the CLI
 *  is actually present: a declined/failed install must not leave a
 *  freshly-created config home behind (codex-review #4).
 *  lifecycle-render.mjs's renderApplyReport dispatches on the runLifecycle
 *  result's own shape (opencode's rich per-surface shape — including the
 *  compact gateway — vs. an admitted host's generic lifecycleResult), so
 *  this loop body never destructures a host-specific result directly.
 *  Returns false only when a report demands run_machine abort. */
async function applyMachineHostLifecycles(cfg, pkgRoot) {
  for (const hostId of hostsWithLifecycle()) {
    if (!lifecycleExecutionEnabled(hostId, cfg)) continue;
    if (!(await have(detectionBinFor(hostId)))) {
      const pkg = HOSTS.find((h) => h.id === hostId)?.pkg ?? hostId;
      warn(`${hostId}: enabled but CLI not installed — wiring skipped (re-run \`ak sync\` after installing ${pkg})`);
      continue;
    }
    const lifecycle = await runLifecycle({
      adapter: lifecycleAdapterFor(hostId), action: 'apply', cfg, options: { pkgRoot },
    });
    const report = renderApplyReport(hostId, lifecycle);
    for (const line of report.lines) printReportLine(line);
    if (report.fatal) return false;
    // guidance blocks + the startup-reload note are opencode-specific surfaces
    // (AGENTS.md blocks, opencode's own load-once-at-startup behavior) with no
    // equivalent in the generic hook contract — stays gated on the rich shape.
    if (report.shape === 'opencode') {
      // guidance blocks for the opencode AGENTS.md land NOW (codex-review #18)
      // — not on the next status-driven reconcile. Same shared reconcile pick
      // and off use, so every command converges guidance identically.
      const guidance = await reconcileOpencodeGuidance({ pkgRoot, cfg, cwd: process.cwd(), enabled: true });
      ok(`opencode guidance: ${guidance.detail.replace(/^guidance: /, '')}`);
      // opencode loads config/plugins/MCP/agents once at startup — say so now,
      // or the user files "hooks don't work" issues (observed live).
      info('restart opencode to load the Agentic Kit hooks, compact gateway, and MCP connections (loaded once at startup)');
    }
  }
  return true;
}

/** Step 7: frontier host hints — detected but not enabled (opt-in via
 *  `ak host pick`). */
async function printUndetectedHostHints(cfg) {
  if (!cfg.integrations?.hosts?.codex && await have('codex')) {
    info('codex CLI detected — run `ak host pick` to let ruflo use both claude and codex');
  }
  if (!cfg.integrations?.hosts?.opencode && await have('opencode')) {
    info('opencode CLI detected — wire ruflo + ruvnet-brain into it with: ak host pick --host claude,opencode');
  }
}

export async function run_machine({ flags, pkgRoot, cfg }) {
  heading('machine setup');
  if (flags['dry-run']) { info('dry-run: would ensure packages (incl. ruvnet-brain), deploy skill (blocks + MCP land in the final pass)'); return true; }

  if (!(await installMachinePackages(cfg, flags))) return false;
  await healMachineSecuritySurface(cfg);
  // Steps 4+5 (CLAUDE.md guidance blocks + user-scope MCP registration) moved
  // to the FINAL pass in run(): both depend on host CLIs step 6 below is
  // about to install (mcp needs `claude` on disk; several block detectors
  // key on `codex` being on PATH / dual-mode enablement). Running them here
  // warned + drifted on genuinely bare machines.
  deployTokenAuditSkill(pkgRoot);
  await installEnabledAbsentHosts(cfg, flags);
  if (!(await applyMachineHostLifecycles(cfg, pkgRoot))) return false;
  await printUndetectedHostHints(cfg);
  return true;
}

export const RUFLO_PROJECT_INIT_ARGS = Object.freeze([
  'init', '--full', '--force',
  // Agentic-kit owns machine guidance and Codex host selection. These Ruflo
  // escape hatches prevent a project init from creating overlapping surfaces.
  '--no-global', '--no-codex-detect', '--no-skills-sh',
]);

/** Step 1: initialize Ruflo project assets without overlapping agentic-kit's
 *  machine guidance, Codex adapter, or explicit skill projections. The caller
 *  restores/reconciles project guidance from its pre-init snapshot. */
async function rufloProjectInit(root, permCtx) {
  const init = await runCmd('ruflo', [...RUFLO_PROJECT_INIT_ARGS], { cwd: root, timeout: 300_000 });
  (init.code === 0 ? ok : fail)('ruflo init --full');
  if (init.code !== 0) return false;
  const rufloUnexpected = removeUndisclosedPermissions(
    permCtx.permissionsFile, permCtx.permissionsBefore, permCtx.authorizedPermissions,
  );
  if (rufloUnexpected.length) {
    fail(`ruflo init introduced undisclosed auto-approve rules; removed: ${rufloUnexpected.join(', ')}`);
    return false;
  }
  return true;
}

/** Step 3: strip committed MCP cruft (keep any agentic-qe entry), and remove
 *  any local-scope `ruflo` MCP server `ruflo init` may have registered.
 *  Step 2 (statusline heal) is DEFERRED to the end of project setup (see
 *  healProjectStatusline): fixStatusline is a no-op until ruflo/aqe have
 *  finished writing .claude/helpers/statusline.cjs, so injecting the footer
 *  before that can silently miss — running it last guarantees convergence. */
async function sanitizeProjectMcpConfig(root) {
  const mcpJson = path.join(root, '.mcp.json');
  const mcpCfg = readJson(mcpJson);
  if (mcpCfg?.mcpServers) {
    for (const k of ['ruflo', 'claude-flow', 'ruv-swarm', 'flow-nexus']) delete mcpCfg.mcpServers[k];
    // Delete the FILE only when mcpServers was its only content — a repo may
    // carry other top-level keys in .mcp.json that must survive the strip.
    if (Object.keys(mcpCfg.mcpServers).length === 0 && Object.keys(mcpCfg).length === 1) {
      fs.rmSync(mcpJson, { force: true });
    } else fs.writeFileSync(mcpJson, JSON.stringify(mcpCfg, null, 2) + '\n');
    ok('.mcp.json sanitized (no committed ruflo/ruv-swarm/flow-nexus entries)');
  }
  await runCmd('claude', ['mcp', 'remove', 'ruflo', '-s', 'local'], { cwd: root });
}

/** Step 4: pin ABSOLUTE CLAUDE_FLOW_DB_PATH (Claude Code doesn't expand
 *  ${CLAUDE_PROJECT_DIR}). */
function pinProjectMemoryDbPath(root) {
  const dbPath = paths.projectMemoryDb(fs.realpathSync(root));
  const localFile = paths.projectSettingsLocal(root);
  const local = readJson(localFile, {}) ?? {};
  local.env = { ...local.env, CLAUDE_FLOW_DB_PATH: dbPath };
  writeJsonWithBackup(localFile, local);
  ok(`CLAUDE_FLOW_DB_PATH pinned → ${dbPath}`);
}

/** Step 5: activate memory + swarm with the pin exported. */
async function activateProjectMemoryAndSwarm(root, env) {
  (await runCmd('ruflo', ['memory', 'init'], { cwd: root, env })).code === 0
    ? ok('memory initialized') : warn('ruflo memory init failed');
  (await runCmd('ruflo', ['swarm', 'init', '--v3-mode'], { cwd: root, env })).code === 0
    ? ok('swarm initialized (v3-mode)') : warn('ruflo swarm init failed');
}

/** Step 6: daemon — default-on, local-only workers (AI workers stay opt-in
 *  upstream); defensive: never let Claude Code auto-restart it (issue #3 RC3). */
async function startProjectDaemon(root) {
  const d = await runCmd('ruflo', ['daemon', 'start'], { cwd: root, timeout: 60_000 });
  if (d.code === 0) {
    ok('daemon started (local-only workers; 12h TTL; AI workers opt-in: RUFLO_DAEMON_AI_WORKERS=1)');
  } else warn('daemon failed to start — try: ruflo daemon start');
  const projSettingsFile = paths.projectSettings(root);
  const ps = readJson(projSettingsFile);
  if (ps?.claudeFlow?.daemon?.autoStart === true) {
    ps.claudeFlow.daemon.autoStart = false;
    writeJsonWithBackup(projSettingsFile, ps);
    ok('claudeFlow.daemon.autoStart → false (explicit start only)');
  }
}

/** Step 7: write-verification (store → actual on-disk row, then clean up).
 *  Native memory integrations may select agentdb-memory.db beside the pinned
 *  compatibility DB. */
async function verifyProjectMemoryWrite(root, env) {
  const probeKey = `_setup/verify-${process.pid}-${Date.now()}`;
  const stored = (await runCmd('ruflo', ['memory', 'store', '-k', probeKey, '--value', 'setup-verify', '-n', '_setup'], { cwd: root, env })).code === 0;
  const landed = stored ? findMemoryEntry(root, '_setup', probeKey) : null;
  if (landed) {
    // Bound parameters, not interpolation. Delete only this disposable probe
    // from the store that actually received it.
    const cleanup = withDb(landed.file, (db) => {
      db.prepare('DELETE FROM memory_entries WHERE namespace = ? AND key = ?').run('_setup', probeKey);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      return true;
    }, { readonly: false });
    if (cleanup.ok) ok(`memory write VERIFIED (store → ${path.basename(landed.file)} row confirmed)`);
    else warn(`memory write verified, but probe cleanup ${cleanup.error.kind} — remove ${probeKey} from _setup manually`);
  } else {
    fail('memory write verification FAILED — run: ak status / ruflo doctor -c memory');
  }
}

function reportProjectGuidance(result) {
  if (result.action === 'removed-generated') {
    ok('project guidance: removed initializer-only CLAUDE.md (machine guidance remains authoritative)');
  } else if (result.action !== 'unchanged') {
    ok(`project guidance: ${result.action} (${result.bytes} bounded bytes)`);
  }
}

/** Step 9: agentic-qe in this repo. project-guidance.mjs installs a bounded
 *  compatibility guard before this call and reconciles again afterward. AQE
 *  retains ownership of its sentineled Codex block in AGENTS.md. */
async function initProjectAgenticQe(root, cfg, flags, permCtx) {
  if (!(cfg.aqe && !flags['no-aqe'] && await have('aqe'))) return true;
  heal.healRvf(paths.projectAqeDir(root));
  // aqe ≥ 3.13.1 with codex enabled → install the Codex-native QE skills too.
  const withCodex = !!cfg.integrations?.hosts?.codex && aqeSupportsAgentOverrides();
  const aqe = await runCmd('aqe', ['init', '--auto', ...(withCodex ? ['--with-codex'] : [])], { cwd: root, timeout: 300_000 });
  (aqe.code === 0 ? ok : warn)(`agentic-qe initialized${withCodex ? ' (+ codex skills)' : ''}`);
  const aqeUnexpected = removeUndisclosedPermissions(
    permCtx.permissionsFile, permCtx.permissionsBefore, permCtx.authorizedPermissions,
  );
  if (aqeUnexpected.length) {
    fail(`agentic-qe init introduced undisclosed auto-approve rules; removed: ${aqeUnexpected.join(', ')}`);
    return false;
  }
  return true;
}

/** The 'aqe-router' step's own report, plus the activity-routing table print
 *  that always follows it here (regardless of whether the router itself
 *  changed) — split out purely to keep applyProjectProviderStack's
 *  reporter's own branch count legible. */
function reportProjectAqeRouterStep(cfg, result) {
  if (result.changed) (result.ok ? ok : warn)(`aqe router: ${result.detail}`);
  if (Object.keys(cfg.routing?.routes ?? {}).length) printActivityRoutingTable(cfg);
}

/** The 'ruflo-codex-mcp' step's own report — when codexMcp:false skipped it
 *  (`result` is null), print the "codex CLI detected" hint instead, in the
 *  same position the whole codex block used to occupy. */
async function reportProjectRufloCodexMcpStep(result) {
  if (result) {
    if (result.changed || !result.ok) (result.ok ? ok : warn)(`ruflo→codex MCP: ${result.detail}`);
    return;
  }
  if (await have('codex')) {
    info('codex CLI detected — enable dual-host with: ak host pick');
  }
}

/** Step 9.5: frontier host/provider wiring — reapply kit.json prefs (no-op
 *  at the claude-only default, so existing repos see zero change). When
 *  codex is enabled: write ENABLE_* env and register providers. The shared
 *  pipeline (providers.mjs's convergeProviderStack) computes and persists
 *  every step; this reporter only decides what to print and how, preserving
 *  setup's exact wording/gating/ordering per step. codexMcp gates the
 *  legacy/reverse Codex MCP steps to run only while codex is enabled —
 *  matching this command's pre-existing behavior (sync and pick always run
 *  them; the deprecated-backend cleanup is independent of enablement there —
 *  see retireCodexMcp). */
async function applyProjectProviderStack(cfg, root, migrateRoutes) {
  const codexEnabled = !!cfg.integrations?.hosts?.codex;
  const projectReporter = async (step, result) => {
    if (step === 'hosts') { if (result.changed) ok(`providers: ${result.detail}`); return; }
    // dual-host: seed the per-activity routing policy from defaults (persist
    // first so the router materialization below writes agentOverrides).
    // No-op single-host.
    if (step === 'routing-seed') {
      if (result.seeded) ok(`per-activity routing seeded — ${result.count} activities (dual-host defaults)`);
      return;
    }
    // Retire withdrawn models from the persisted policy — the same heal `ak
    // sync` already runs (sync.mjs). Without this, project setup could
    // persist a route naming a model the host has withdrawn, left for the
    // next sync to repair. Only seeded entries are rewritten; a user pin is
    // reported and kept.
    if (step === 'routing-retired') { reportRetiredRouteChanges(result.changes); return; }
    if (step === 'aqe-router') { reportProjectAqeRouterStep(cfg, result); return; }
    if (step === 'legacy-codex-mcp') {
      if (result && (result.changed || !result.ok)) (result.ok ? ok : warn)(`legacy codex MCP: ${result.detail}`);
      return;
    }
    // Independently register Ruflo in Codex for shared routing/swarm/memory tools.
    if (step === 'ruflo-codex-mcp') { await reportProjectRufloCodexMcpStep(result); return; }
    // Provider routing is independent of the enabled execution-host set.
    // Apply persisted Ruflo providers for Claude-only setups too (#128 /
    // ruflo#2962).
    if (step === 'providers-api' && (result.changed || !result.ok || result.status === 'degraded')) {
      reportOutcome('providers', result);
    }
  };
  await convergeProviderStack(cfg, root, {
    reporter: projectReporter, migrateRoutes, codexMcp: codexEnabled,
  });
}

/** Step 10: statusline footer — LAST, after ruflo + aqe have settled the
 *  helper. A still-missing footer is a WARN (not silent info): it means the
 *  AQE/SONA segments won't render and `ak sync` is needed to heal it. */
function healProjectStatusline(root) {
  const sl = fixStatusline(root);
  if (sl.applied) ok(`statusline: footer injected (v${sl.version})`);
  else if (sl.reason) warn(`statusline: ${sl.reason} — run \`ak sync\` to re-inject`);
  else ok('statusline: footer in sync');
}

export async function run_project({
  flags, cfg, trustDisclosed = false, migrateRoutes = migrateRetiredRoutesInConfig,
}) {
  const root = process.cwd();
  heading(`project setup — ${root}`);
  if (!trustDisclosed) discloseSetupTrust(cfg, { project: true });
  if (flags['dry-run']) { info('dry-run: would init, sanitize, pin DB path, activate memory/swarm/daemon, verify'); return true; }

  const permissionsFile = paths.projectSettings(root);
  const permCtx = {
    permissionsFile,
    permissionsBefore: new Set(allowRules(permissionsFile)),
    authorizedPermissions: new Set(projectPermissionManifest(cfg).map((entry) => entry.rule)),
  };
  const priorGuidance = captureProjectGuidance(root);

  if (!(await rufloProjectInit(root, permCtx))) return false;
  await sanitizeProjectMcpConfig(root);
  pinProjectMemoryDbPath(root);
  const env = projectMemoryEnv(root);
  await activateProjectMemoryAndSwarm(root, env);
  await startProjectDaemon(root);
  await verifyProjectMemoryWrite(root, env);
  const aqeEnabled = !!(cfg.aqe && !flags['no-aqe']);
  reportProjectGuidance(reconcileProjectGuidance({ root, prior: priorGuidance, aqeEnabled }));
  const aqeOk = await initProjectAgenticQe(root, cfg, flags, permCtx);
  // Reassert the pre-init source of truth even if an upstream initializer did
  // not honor its compatibility guard. This never rewrites AQE's AGENTS block.
  reportProjectGuidance(reconcileProjectGuidance({ root, prior: priorGuidance, aqeEnabled }));
  if (!aqeOk) return false;
  await applyProjectProviderStack(cfg, root, migrateRoutes);
  healProjectStatusline(root);
  return true;
}

/** Preflight the deja-vu companion and disclose the full setup trust
 *  manifest (host + project + companion changes), honoring a declined
 *  confirmation. Returns `{code}` when `run()` must return immediately, or
 *  `{companionPreflight}` to continue. */
async function resolveSetupTrust(cfg, flags, dejaVuLifecycle, confirm, willConfigureProject) {
  let companionPreflight;
  try {
    companionPreflight = await preflightSetupDejaVu(cfg, dejaVuLifecycle, {
      removeRequested: flags['no-deja-vu'],
    });
  } catch {
    fail('deja-vu preflight failed before any setup mutation');
    return { code: 1 };
  }
  const trustManifest = discloseSetupTrust(cfg, {
    project: willConfigureProject, companionPreflight,
  });
  if (companionPreflight?.error) {
    fail(`deja-vu preflight refused the plan (${safeCompanionCode(companionPreflight.error)})`);
    return { code: 1 };
  }
  if (trustManifest.length && !flags['dry-run']
    && !(await confirm('Proceed with setup and these trust changes?', false, flags.yes))) {
    info('setup cancelled before machine, user, or project changes');
    return { code: 0 };
  }
  return { companionPreflight };
}

/** --codex / --primary-host / --opencode / deja-vu: preview (dry-run) or
 *  announce (real run) what the host/companion flags will do. Opting codex
 *  in happens BEFORE run_machine's host-install loop and run_project's dual
 *  wiring (applySetupHostFlags already ran, in `run()`, so the existing
 *  gated/prompted/external-safe paths install + wire codex); dry-run applies
 *  these choices in memory for an accurate preview but never persists them. */
function printSetupHostFlagPreview({
  flags, cfg, hostFlags, companionPreflight, dejaVuFlagsResult,
}) {
  if (flags['dry-run']) {
    if (flags.codex || flags['primary-host']) info('dry-run: --codex/--primary-host would enable + install the codex host and wire dual-mode (no changes made)');
    if (flags.opencode) info('dry-run: --opencode would enable the opencode host and wire it (no changes made)');
    if (companionPreflight) {
      const kinds = companionPreflight.plan.operations.map((entry) => entry.kind).join(', ') || 'none';
      info(`dry-run: deja-vu would apply bounded operations: ${kinds} (no changes made)`);
    } else if (dejaVuFlagsResult.changed) {
      info('dry-run: deja-vu would remain disabled (no probes or changes)');
    }
    return;
  }
  for (const w of hostFlags.warnings) warn(w);
  if (hostFlags.changed) {
    if (flags.codex || flags['primary-host'] === 'codex') {
      const primary = cfg.routing?.primaryHost && cfg.routing.primaryHost !== 'claude'
        ? ` (primary: ${cfg.routing.primaryHost})` : '';
      info(`codex host enabled${primary} — will install + wire dual-mode`);
    }
    if (flags.opencode) info('opencode host enabled — will wire opencode.json and deploy plugin/agents/skills');
  }
}

/** Final reconcile pass — deliberately AFTER the hosts branch (which installs
 *  the claude/codex/opencode CLIs) and the project phase (whose Codex
 *  integration creates ~/.codex): the user-scope MCP registration needs the
 *  claude CLI on disk, and several guidance blocks gate on freshly-installed
 *  hosts (command:codex, flag:dualMode). Shares blocks.mjs reconcileGuidance
 *  (via providers.mjs's guidanceContext) with `ak sync` so setup and sync
 *  converge guidance identically. */
async function finalizeSetupGuidanceAndMcp(cfg, pkgRoot, flags) {
  for (const t of await reconcileGuidance({ cwd: process.cwd(), cfg, pkgRoot, context: guidanceContext(cfg) })) {
    if (t.name === 'claude' || t.changed) ok(`blocks(${t.label}): ${t.changed || 'in sync'}`);
  }
  const wantMcp = cfg.mcp.register && (flags.reconfigure || !(readJson(paths.claudeUserMcpPath(), {})?.mcpServers?.['claude-flow']));
  if (wantMcp && await ask('Register the ruflo MCP server at user scope (schemas load on demand)?', true, flags.yes)) {
    if (await mcpRegister()) {
      const { denied } = applyExclusions(cfg.mcp.excludeFamilies ?? []);
      ok(`MCP registered${denied ? ` (${denied} tool(s) denied per kit.json)` : ''} — exclude families anytime: ak x mcp pick`);
    } else warn('claude mcp add failed — run: ak x mcp pick');
  }
}

export async function run({ flags, pkgRoot, confirm = ask, dejaVuLifecycle = DEFAULT_DEJA_VU_LIFECYCLE }) {
  const dejaVuFlags = validateDejaVuSetupFlags(flags);
  if (!dejaVuFlags.ok) {
    fail(dejaVuFlags.error);
    return 2;
  }
  const cfg = loadKitConfig();
  if (flags['no-aqe']) cfg.aqe = false;
  if (flags['no-ruvnet-brain']) cfg.ruvnetBrain = false;
  if (flags['no-security']) cfg.security = false;

  const inProject = flags.project
    || (fs.existsSync(path.join(process.cwd(), '.git')) && process.cwd() !== paths.home);
  const willConfigureProject = inProject && !flags.minimal;

  // Apply host flags to the in-memory config before preflight so the manifest
  // describes this invocation, including a newly requested host. Dry-run never
  // persists this object; a declined confirmation returns before saveKitConfig.
  const hostFlags = applySetupHostFlags(cfg, flags);
  const dejaVuFlagsResult = applySetupDejaVuFlags(cfg, flags);
  const trust = await resolveSetupTrust(cfg, flags, dejaVuLifecycle, confirm, willConfigureProject);
  if (trust.code !== undefined) return trust.code;
  const { companionPreflight } = trust;

  printSetupHostFlagPreview({
    flags, cfg, hostFlags, companionPreflight, dejaVuFlagsResult,
  });

  if (!(await run_machine({ flags, pkgRoot, cfg }))) return 1;
  // Companion execution is deliberately sequenced after every enabled host is
  // installed and its lifecycle wiring has converged. It never uses upstream
  // aggregate/warmup/update commands; the preflight accepts only exact targets
  // and one bounded `deja index` operation.
  if (!flags['dry-run'] && companionPreflight) {
    if (!(await finishSetupDejaVu(cfg, companionPreflight, dejaVuLifecycle, {
      removeRequested: flags['no-deja-vu'],
    }))) return 1;
  }
  // "--dry-run: print the plan; change nothing" — an unconditional save once
  // CREATED ~/.config/agentic-kit/kit.json on a previewed setup. The effective
  // config may be changed in memory above so the plan is truthful; never write
  // that preview state.
  if (!flags['dry-run']) saveKitConfig(cfg);

  if (inProject && !flags.minimal) {
    if (!(await run_project({ flags, cfg, trustDisclosed: true }))) return 1;
  } else if (!flags.minimal) {
    info('not inside a project (no .git here) — run `ak setup` from a repo to set one up');
  }
  if (!flags['dry-run']) await finalizeSetupGuidanceAndMcp(cfg, pkgRoot, flags);

  console.log('');
  ok(bold('setup complete — `agentic-kit` anytime for status, `ak sync` after upgrades'));
  info(dim('📊 dashboard: run `ak dashboard` → opens http://127.0.0.1:7431 (local, read-only)'));
  return 0;
}
