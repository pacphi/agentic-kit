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
import { registry, syncBlocks } from '../lib/blocks.mjs';
import { register as mcpRegister, applyExclusions } from '../lib/mcp.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { installedVersion } from '../lib/versions.mjs';
import { readJson, writeJsonWithBackup } from '../lib/settings.mjs';
import { scalar, checkpoint, withDb } from '../lib/sqlite.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, fail, info, heading, bold } from '../lib/output.mjs';

export const options = {
  'dry-run': { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  minimal: { type: 'boolean', default: false },
  project: { type: 'boolean', default: false },
  'no-aqe': { type: 'boolean', default: false },
  'no-security': { type: 'boolean', default: false },
  reconfigure: { type: 'boolean', default: false },
};

const ask = async (q, dflt, yes) => {
  if (yes || !process.stdin.isTTY) return dflt;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [${dflt ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
  rl.close();
  return a === '' ? dflt : a.startsWith('y');
};

export async function run_machine({ flags, pkgRoot, cfg }) {
  heading('machine setup');
  if (flags['dry-run']) { info('dry-run: would ensure packages, deploy skill, merge blocks, offer MCP'); return true; }

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

  // 2. heal natives + the #2670 aidefence gap up front
  ok(`natives: ${(await heal.healNatives()).detail}`);
  ok(`aidefence: ${(await heal.healAidefence()).detail}`);
  if (cfg.aqe) info(`aqe solver: ${(await heal.healAqeSolver()).detail}`);

  // 3. token-audit skill → ~/.claude/skills
  const skillSrc = path.join(pkgRoot, 'claude', 'skills', 'ruflo-token-audit');
  if (fs.existsSync(skillSrc)) {
    const dst = path.join(paths.claudeSkillsDir(), 'ruflo-token-audit');
    fs.mkdirSync(paths.claudeSkillsDir(), { recursive: true });
    fs.cpSync(skillSrc, dst, { recursive: true });
    ok('skill deployed: ruflo-token-audit');
  }

  // 4. CLAUDE.md managed blocks
  const rows = registry(cfg.customBlocks);
  const resolve = (r) => (r.custom
    ? (r.template.startsWith('~/') ? path.join(paths.home, r.template.slice(2)) : r.template)
    : path.join(pkgRoot, 'claude', r.template));
  const res = await syncBlocks(paths.claudeMdPath(), rows, resolve);
  ok(`CLAUDE.md blocks: ${res.filter((r) => r.action !== 'unchanged').length || 'no'} change(s)`);

  // 5. MCP (once; --reconfigure or `x mcp pick` to revisit)
  const wantMcp = cfg.mcp.register && (flags.reconfigure || !(readJson(paths.claudeUserMcpPath(), {})?.mcpServers?.['claude-flow']));
  if (wantMcp && await ask('Register the ruflo MCP server at user scope (schemas load on demand)?', true, flags.yes)) {
    if (await mcpRegister()) {
      const { denied } = applyExclusions(cfg.mcp.excludeFamilies ?? []);
      ok(`MCP registered${denied ? ` (${denied} tool(s) denied per kit.json)` : ''} — exclude families anytime: ak x mcp pick`);
    } else warn('claude mcp add failed — run: ak x mcp pick');
  }
  return true;
}

export async function run_project({ flags, cfg }) {
  const root = process.cwd();
  heading(`project setup — ${root}`);
  if (flags['dry-run']) { info('dry-run: would init, sanitize, pin DB path, activate memory/swarm/daemon, verify'); return true; }

  // 1. ruflo init (--force regenerates; CLAUDE.md backed up upstream, #2208)
  const init = await runCmd('ruflo', ['init', '--full', '--force'], { cwd: root, timeout: 300_000 });
  (init.code === 0 ? ok : fail)('ruflo init --full');
  if (init.code !== 0) return false;

  // 2. statusline heal (footer + fallback version + legacy repoint)
  const sl = fixStatusline(root);
  (sl.applied ? ok : info)(`statusline: ${sl.applied ? 'footer injected' : sl.reason ?? 'in sync'}`);

  // 3. strip committed MCP cruft (keep any agentic-qe entry)
  const mcpJson = path.join(root, '.mcp.json');
  const mcpCfg = readJson(mcpJson);
  if (mcpCfg?.mcpServers) {
    for (const k of ['ruflo', 'claude-flow', 'ruv-swarm', 'flow-nexus']) delete mcpCfg.mcpServers[k];
    if (Object.keys(mcpCfg.mcpServers).length === 0) fs.rmSync(mcpJson, { force: true });
    else fs.writeFileSync(mcpJson, JSON.stringify(mcpCfg, null, 2) + '\n');
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

  // 7. WAL checkpoint + write-verification (store → on-disk row, then clean up)
  checkpoint(dbPath);
  const probeKey = `_setup/verify-${process.pid}`;
  const stored = (await runCmd('ruflo', ['memory', 'store', '-k', probeKey, '--value', 'setup-verify', '-n', '_setup'], { cwd: root, env })).code === 0;
  const onDisk = stored && scalar(dbPath, `SELECT COUNT(*) FROM memory_entries WHERE key='${probeKey}'`) === 1;
  if (onDisk) {
    withDb(dbPath, (db) => db.exec(`DELETE FROM memory_entries WHERE key='${probeKey}'; PRAGMA wal_checkpoint(TRUNCATE);`), null, { readonly: false });
    ok('memory write VERIFIED (store → on-disk row confirmed)');
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
    let md = fs.existsSync(projectMd) ? fs.readFileSync(projectMd, 'utf8') : '';
    if (!md.includes('## Agentic QE v3')) {
      fs.appendFileSync(projectMd, '\n## Agentic QE v3\n<!-- managed by agentic-kit — aqe init skips regeneration when this sentinel is present -->\n');
    }
    heal.healRvf(paths.projectAqeDir(root));
    const aqe = await runCmd('aqe', ['init', '--auto'], { cwd: root, timeout: 300_000 });
    (aqe.code === 0 ? ok : warn)('agentic-qe initialized');
  }
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

export async function run({ flags, pkgRoot }) {
  const cfg = loadKitConfig();
  if (flags['no-aqe']) cfg.aqe = false;
  if (flags['no-security']) cfg.security = false;

  if (!(await run_machine({ flags, pkgRoot, cfg }))) return 1;
  saveKitConfig(cfg);

  const inProject = flags.project
    || (fs.existsSync(path.join(process.cwd(), '.git')) && process.cwd() !== paths.home);
  if (inProject && !flags.minimal) {
    if (!(await run_project({ flags, cfg }))) return 1;
  } else if (!flags.minimal) {
    info('not inside a project (no .git here) — run `ak setup` from a repo to set one up');
  }
  console.log('');
  ok(bold('setup complete — `agentic-kit` anytime for status, `ak sync` after upgrades'));
  return 0;
}
