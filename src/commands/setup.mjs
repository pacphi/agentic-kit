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
import { register as mcpRegister, applyExclusions } from '../lib/mcp.mjs';
import { reconcileOpencodeGuidance } from '../lib/opencode.mjs';
import { runLifecycle } from '../lib/adapters/lifecycle.mjs';
import { builtinHostsWithLifecycle, lifecycleAdapterFor } from '../lib/adapters/lifecycle-registry.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { HOSTS, applyHosts, applyProviders, hostInstallState, installHost, applyAqeRouter, seedActivityRoutesIfMultiHost, printActivityRoutingTable, aqeSupportsAgentOverrides, ensureCodexMcp, ensureRufloMcpInCodex, applySetupHostFlags, bothHostsEnabled } from '../lib/providers.mjs';
import { installedVersion } from '../lib/versions.mjs';
import * as rb from '../lib/ruvnet-brain.mjs';
import * as adb from '../lib/agentdb.mjs';
import { readJson, writeJsonWithBackup } from '../lib/settings.mjs';
import { withDb } from '../lib/sqlite.mjs';
import { findMemoryEntry } from '../lib/project-memory.mjs';
import {
  setupTrustManifest, trustManifestLines,
} from '../lib/trust-manifest.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, fail, info, heading, bold, dim, reportOutcome } from '../lib/output.mjs';

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
  'primary-host': { type: 'string' },
  reconfigure: { type: 'boolean', default: false },
};

export const help = `ak setup — first-time setup (machine and/or this project)

Machine scope always runs: installs ruflo + agentic-qe globally, deploys the
token-audit skill, merges the CLAUDE.md managed blocks, and offers MCP. Project
scope auto-runs when .git exists in the current directory. Project setup runs
ruflo init --full --force and may replace existing agent configuration; commit
or back up first. Details: docs/SETUP.md

Usage: ak setup [options]

Options:
  --project        force project setup in cwd even without .git; same mutations
  --minimal        machine scope only; skip project setup
  --no-aqe         skip agentic-qe install + configuration
  --no-ruvnet-brain  skip the RuvNet Brain (~2 GB offline KB) setup step
  --no-security    skip the security-surface verification
  --codex          enable + install the OpenAI Codex host during setup (dual-mode;
                     default is claude-only, codex opt-in). Installs @openai/codex
                     if absent (prompted; external installs untouched) and wires
                     the Claude↔Codex bridges + per-activity routing.
  --opencode       enable the opencode host during setup: wires opencode.json
                     (claude-flow + ruvnet-brain MCP, skills paths, permissions),
                     deploys the lifecycle plugin + platform skill, and converts
                     the ruflo agent set into opencode subagents. Already set up?
                     Use: ak host pick --host claude,opencode
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

export function discloseSetupTrust(cfg, { project = false } = {}) {
  const manifest = setupTrustManifest(cfg, { project });
  if (!manifest.length) return manifest;
  info('setup trust manifest (evaluated before any machine, user, or project changes):');
  for (const line of trustManifestLines(manifest)) console.log(`  ${line}`);
  return manifest;
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

export async function run_machine({ flags, pkgRoot, cfg }) {
  heading('machine setup');
  if (flags['dry-run']) { info('dry-run: would ensure packages (incl. ruvnet-brain), deploy skill (blocks + MCP land in the final pass)'); return true; }

  // 1. global packages
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

  // 2. heal natives + the #2670 aidefence gap up front. The aidefence heal is
  // the security surface — it honors `--no-security` (cfg.security=false),
  // which was previously write-only: documented, persisted, read by nothing.
  reportOutcome('natives', await heal.healNatives());
  if (cfg.security !== false) reportOutcome('aidefence', await heal.healAidefence());
  else info('security surface skipped (kit.json security:false — re-enable by removing the key)');
  if (cfg.aqe) reportOutcome('aqe solver', await heal.healAqeSolver());

  // 3. token-audit skill → ~/.claude/skills
  const skillSrc = path.join(pkgRoot, 'claude', 'skills', 'ruflo-token-audit');
  if (fs.existsSync(skillSrc)) {
    const dst = path.join(paths.claudeSkillsDir(), 'ruflo-token-audit');
    fs.mkdirSync(paths.claudeSkillsDir(), { recursive: true });
    fs.cpSync(skillSrc, dst, { recursive: true });
    ok('skill deployed: ruflo-token-audit');
  }

  // 4+5. CLAUDE.md guidance blocks + user-scope MCP registration moved to the
  //      FINAL pass in run(): both depend on host CLIs that step 6 below is
  //      about to install (mcp needs `claude` on disk; several block detectors
  //      key on `codex` being on PATH / dual-mode enablement). Running them
  //      here warned + drifted on genuinely bare machines.

  // 6. frontier hosts — install any ENABLED host that is entirely absent (default
  //    enables claude only). External installs (mise/native/brew) are left alone.
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

  // 6b. host lifecycle wiring — connected MCPs, compact lazy gateway,
  //     lifecycle plugin, converted agents, specialist dispatcher, and
  //     platform skill (each adapter owns its own surfaces
  //     — opencode.mjs for opencode). Registry-driven: loops
  //     builtinHostsWithLifecycle() rather than naming opencode, so a second
  //     BUILT-IN lifecycle host needs no new branch here. Only when the CLI
  //     is actually present: a declined/failed install must not leave a
  //     freshly-created config home behind (codex-review #4). The result
  //     SHAPE consumed below (stack.oc/plugin/agents/skill) is still
  //     opencode's own — the lifecycle contract doesn't mandate a common
  //     `apply()` result shape across hosts. builtinHostsWithLifecycle()
  //     (not hostsWithLifecycle()) deliberately excludes admitted external
  //     hosts: this loop body is opencode-shaped, and external lifecycle
  //     execution graduates in a later wave alongside a shape-agnostic body
  //     (see lifecycle-registry.mjs's registerAdmittedLifecycle comment).
  for (const hostId of builtinHostsWithLifecycle()) {
    if (!cfg.integrations?.hosts?.[hostId]) continue;
    if (!(await have(hostId))) {
      const pkg = HOSTS.find((h) => h.id === hostId)?.pkg ?? hostId;
      warn(`${hostId}: enabled but CLI not installed — wiring skipped (re-run \`ak sync\` after installing ${pkg})`);
      continue;
    }
    const lifecycle = await runLifecycle({
      adapter: lifecycleAdapterFor(hostId), action: 'apply', cfg, options: { pkgRoot },
    });
    const stack = lifecycle.result;
    (stack.oc.ok ? ok : warn)(`opencode: ${stack.oc.detail}`);
    if (stack.oc.fatal) {
      warn(`opencode plugins/agent projection/skill/guidance skipped — ${stack.oc.detail}`);
      return false;
    }
    ok(`opencode plugin: ${stack.plugin.detail}`);
    ok(`opencode gateway: ${stack.gateway.detail}`);
    ok(`opencode agent projection: ${stack.agents.detail}`);
    if (stack.skill.changed) ok(`opencode skill: ${stack.skill.detail}`);
    // guidance blocks for the opencode AGENTS.md land NOW (codex-review #18)
    // — not on the next status-driven reconcile. Same shared reconcile pick
    // and off use, so every command converges guidance identically.
    const guidance = await reconcileOpencodeGuidance({ pkgRoot, cfg, cwd: process.cwd(), enabled: true });
    ok(`opencode guidance: ${guidance.detail.replace(/^guidance: /, '')}`);
    // opencode loads config/plugins/MCP/agents once at startup — say so now,
    // or the user files "hooks don't work" issues (observed live).
    info('restart opencode to load the Agentic Kit hooks, compact gateway, and MCP connections (loaded once at startup)');
  }

  // 7. frontier host hint — codex detected but not enabled (opt-in via `ak host pick`)
  if (!cfg.integrations?.hosts?.codex && await have('codex')) {
    info('codex CLI detected — run `ak host pick` to let ruflo use both claude and codex');
  }
  // opencode hint — detected but not enabled (post-install opt-in via provider pick)
  if (!cfg.integrations?.hosts?.opencode && await have('opencode')) {
    info('opencode CLI detected — wire ruflo + ruvnet-brain into it with: ak host pick --host claude,opencode');
  }
  return true;
}

export async function run_project({ flags, cfg, trustDisclosed = false }) {
  const root = process.cwd();
  heading(`project setup — ${root}`);
  if (!trustDisclosed) discloseSetupTrust(cfg, { project: true });
  if (flags['dry-run']) { info('dry-run: would init, sanitize, pin DB path, activate memory/swarm/daemon, verify'); return true; }

  const permissionsFile = paths.projectSettings(root);
  const permissionsBefore = new Set(allowRules(permissionsFile));
  const authorizedPermissions = new Set(projectPermissionManifest(cfg).map((entry) => entry.rule));

  // 1. ruflo init (--force regenerates; CLAUDE.md backed up upstream, #2208)
  const init = await runCmd('ruflo', ['init', '--full', '--force'], { cwd: root, timeout: 300_000 });
  (init.code === 0 ? ok : fail)('ruflo init --full');
  if (init.code !== 0) return false;
  const rufloUnexpected = removeUndisclosedPermissions(permissionsFile, permissionsBefore, authorizedPermissions);
  if (rufloUnexpected.length) {
    fail(`ruflo init introduced undisclosed auto-approve rules; removed: ${rufloUnexpected.join(', ')}`);
    return false;
  }

  // 2. statusline heal is DEFERRED to the end of project setup (see step 10):
  //    fixStatusline is a no-op until ruflo/aqe have finished writing
  //    .claude/helpers/statusline.cjs, so injecting the footer here can silently
  //    miss (helper not settled) — running it last guarantees convergence.

  // 3. strip committed MCP cruft (keep any agentic-qe entry)
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

  // 4. pin ABSOLUTE CLAUDE_FLOW_DB_PATH (Claude Code doesn't expand ${CLAUDE_PROJECT_DIR})
  const dbPath = paths.projectMemoryDb(fs.realpathSync(root));
  const localFile = paths.projectSettingsLocal(root);
  const local = readJson(localFile, {}) ?? {};
  local.env = { ...local.env, CLAUDE_FLOW_DB_PATH: dbPath };
  writeJsonWithBackup(localFile, local);
  ok(`CLAUDE_FLOW_DB_PATH pinned → ${dbPath}`);

  // 5. activate memory + swarm with the pin exported
  const env = { CLAUDE_FLOW_DB_PATH: dbPath };
  (await runCmd('ruflo', ['memory', 'init'], { cwd: root, env })).code === 0
    ? ok('memory initialized') : warn('ruflo memory init failed');
  (await runCmd('ruflo', ['swarm', 'init', '--v3-mode'], { cwd: root, env })).code === 0
    ? ok('swarm initialized (v3-mode)') : warn('ruflo swarm init failed');

  // 6. daemon: default-on, local-only workers (AI workers stay opt-in upstream)
  const d = await runCmd('ruflo', ['daemon', 'start'], { cwd: root, timeout: 60_000 });
  if (d.code === 0) {
    ok('daemon started (local-only workers; 12h TTL; AI workers opt-in: RUFLO_DAEMON_AI_WORKERS=1)');
  } else warn('daemon failed to start — try: ruflo daemon start');
  // defensive: never let Claude Code auto-restart it (issue #3 RC3)
  const projSettingsFile = paths.projectSettings(root);
  const ps = readJson(projSettingsFile);
  if (ps?.claudeFlow?.daemon?.autoStart === true) {
    ps.claudeFlow.daemon.autoStart = false;
    writeJsonWithBackup(projSettingsFile, ps);
    ok('claudeFlow.daemon.autoStart → false (explicit start only)');
  }

  // 7. Write-verification (store → actual on-disk row, then clean up). Native
  // bridges may select agentdb-memory.db beside the pinned compatibility DB.
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

  // 8. lean project CLAUDE.md (generic guidance lives machine-wide)
  const projectMd = path.join(root, 'CLAUDE.md');
  if (fs.existsSync(projectMd) && !flags.minimal) {
    fs.writeFileSync(projectMd, leanStub(path.basename(root)));
    ok('project CLAUDE.md → lean stub (machine-wide reference carries the rest)');
  }

  // 9. agentic-qe in this repo (sentinel first so aqe init skips duplicate guidance)
  if (cfg.aqe && !flags['no-aqe'] && await have('aqe')) {
    const md = fs.existsSync(projectMd) ? fs.readFileSync(projectMd, 'utf8') : '';
    if (!md.includes('## Agentic QE v3')) {
      fs.appendFileSync(projectMd, '\n## Agentic QE v3\n<!-- managed by agentic-kit — aqe init skips regeneration when this sentinel is present -->\n');
    }
    heal.healRvf(paths.projectAqeDir(root));
    // aqe ≥ 3.13.1 with codex enabled → install the Codex-native QE skills too.
    const withCodex = !!cfg.integrations?.hosts?.codex && aqeSupportsAgentOverrides();
    const aqe = await runCmd('aqe', ['init', '--auto', ...(withCodex ? ['--with-codex'] : [])], { cwd: root, timeout: 300_000 });
    (aqe.code === 0 ? ok : warn)(`agentic-qe initialized${withCodex ? ' (+ codex skills)' : ''}`);
    const aqeUnexpected = removeUndisclosedPermissions(permissionsFile, permissionsBefore, authorizedPermissions);
    if (aqeUnexpected.length) {
      fail(`agentic-qe init introduced undisclosed auto-approve rules; removed: ${aqeUnexpected.join(', ')}`);
      return false;
    }
  }

  // 9.5 frontier host/provider wiring — reapply kit.json prefs (no-op at the
  //     claude-only default, so existing repos see zero change). When codex is
  //     enabled: write ENABLE_* env and register providers.
  const ph = applyHosts(cfg, root);
  if (ph.changed) ok(`providers: ${ph.detail}`);
  // dual-host: seed the per-activity routing policy from defaults (persist first
  // so the router materialization below writes agentOverrides). No-op single-host.
  const seed = seedActivityRoutesIfMultiHost(cfg);
  if (seed.seeded) { saveKitConfig(cfg); ok(`per-activity routing seeded — ${seed.count} activities (dual-host defaults)`); }
  const rt = applyAqeRouter(cfg, root);
  if (rt.changed) (rt.ok ? ok : warn)(`aqe router: ${rt.detail}`);
  if (Object.keys(cfg.routing?.routes ?? {}).length) printActivityRoutingTable(cfg);
  if (cfg.integrations?.hosts?.codex) {
    const mcp = await ensureCodexMcp(cfg, root);
    if (mcp.changed) saveKitConfig(cfg); // persist the codexMcp ownership marker
    if (mcp.changed || !mcp.ok) (mcp.ok ? ok : warn)(`codex MCP: ${mcp.detail}`);
    // reverse bridge: register ruflo MCP into codex (codex→ruflo) so the bridge is
    // two-way — parity with `ak sync` / `ak host pick`.
    const rmcp = await ensureRufloMcpInCodex(cfg, root);
    if (rmcp.changed) saveKitConfig(cfg); // persist reverse MCP ownership
    if (rmcp.changed || !rmcp.ok) (rmcp.ok ? ok : warn)(`ruflo→codex MCP: ${rmcp.detail}`);
    const prov = await applyProviders(cfg, root);
    if (prov.changed) (prov.ok ? ok : warn)(`providers: ${prov.detail}`);
  } else if (await have('codex')) {
    info('codex CLI detected — enable dual-host with: ak host pick');
  }

  // 10. statusline footer — LAST, after ruflo + aqe have settled the helper.
  //     A still-missing footer is a WARN (not silent info): it means the AQE /
  //     SONA segments won't render and `ak sync` is needed to heal it.
  const sl = fixStatusline(root);
  if (sl.applied) ok(`statusline: footer injected (v${sl.version})`);
  else if (sl.reason) warn(`statusline: ${sl.reason} — run \`ak sync\` to re-inject`);
  else ok('statusline: footer in sync');
  return true;
}

const leanStub = (name) => `<!-- Full ruflo reference: machine-wide ~/.claude/CLAUDE.md (managed by agentic-kit) -->

# ${name}

## Swarm Config

- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid

\`\`\`bash
ruflo swarm init --topology hierarchical --max-agents 15 --strategy specialized
\`\`\`
`;

export async function run({ flags, pkgRoot, confirm = ask }) {
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
  const trustManifest = discloseSetupTrust(cfg, { project: willConfigureProject });
  if (trustManifest.length) {
    if (!flags['dry-run'] && !(await confirm(
      'Proceed with setup and these trust changes?', false, flags.yes))) {
      info('setup cancelled before machine, user, or project changes');
      return 0;
    }
  }

  // --codex / --primary-host: opt codex in BEFORE run_machine's host-install loop
  // and run_project's dual wiring, so the existing gated/prompted/external-safe
  // paths install + wire codex. No-op (claude-only) when neither flag is passed.
  // Dry-run applies these choices in memory for an accurate plan, but never
  // persists the resulting config.
  if (flags['dry-run']) {
    if (flags.codex || flags['primary-host']) info('dry-run: --codex/--primary-host would enable + install the codex host and wire dual-mode (no changes made)');
    if (flags.opencode) info('dry-run: --opencode would enable the opencode host and wire it (no changes made)');
  } else {
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

  if (!(await run_machine({ flags, pkgRoot, cfg }))) return 1;
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
  // Final reconcile pass — deliberately AFTER the hosts branch (which installs
  // the claude/codex/opencode CLIs) and the project phase (whose codex bridge
  // creates ~/.codex): the user-scope MCP registration needs the claude CLI on
  // disk, and several guidance blocks gate on freshly-installed hosts
  // (command:codex, flag:dualMode). Shares blocks.mjs reconcileGuidance with
  // `ak sync` so setup and sync converge guidance identically.
  if (!flags['dry-run']) {
    const ctx = { flags: { dualMode: bothHostsEnabled(cfg), opencodeEnabled: !!cfg.integrations?.hosts?.opencode } };
    for (const t of await reconcileGuidance({ cwd: process.cwd(), cfg, pkgRoot, context: ctx })) {
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

  console.log('');
  ok(bold('setup complete — `agentic-kit` anytime for status, `ak sync` after upgrades'));
  info(dim('📊 dashboard: run `ak dashboard` → opens http://127.0.0.1:7431 (local, read-only)'));
  return 0;
}
