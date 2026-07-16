// ak status — read-only dashboard. Each row: subsystem, level, message,
// and (for drift) what `sync` would do. --json emits the raw rows; --hint
// (set by bare invocation) appends exactly one suggested next action.
import fs from 'node:fs';
import path from 'node:path';
import { glyph, dim, bold } from '../lib/output.mjs';
import * as paths from '../lib/paths.mjs';
import { nativesStatus, aidefencePresent, securityPresent } from '../lib/natives.mjs';
import { registrationStatus } from '../lib/mcp.mjs';
import { listDaemons, staleDaemons } from '../lib/daemons.mjs';
import { scanRvf } from '../lib/rvf.mjs';
import { registry, syncBlocks } from '../lib/blocks.mjs';
import { loadKitConfig } from '../lib/config.mjs';
import { driftReport, selfDrift } from '../lib/versions.mjs';
import { drift as ruvnetBrainDrift } from '../lib/ruvnet-brain.mjs';
import { readJson } from '../lib/settings.mjs';
import { have } from '../lib/exec.mjs';
import { HOSTS, settingsTarget, isDefault, managedEnv, MANAGED_ENV_KEYS, hostInstallState, aqeRouterFile } from '../lib/providers.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  deep: { type: 'boolean', default: false },
  hint: { type: 'boolean', default: false },
};

export const help = `ak status — read-only dashboard of what's true and what's drifted

Prints one row per subsystem (versions, natives, security, learning, providers,
…). Read-only: it never changes anything. A bare \`ak\` runs this plus one
suggested next action.

Usage: ak status [options]

Options:
  --deep    run the slower probes (spawns CLIs) for a fuller picture
  --json    emit the raw rows as JSON (suppresses the drift nudge)

Examples:
  ak status           quick dashboard
  ak status --deep    thorough check
  ak status --json    machine-readable rows`;

const row = (subsystem, level, message, fix = null) => ({ subsystem, level, message, fix });

export async function collect({ pkgRoot, cwd = process.cwd() }) {
  const rows = [];
  const cfg = loadKitConfig();

  // versions
  try {
    for (const r of await driftReport()) {
      if (!r.installed) {
        rows.push(row('versions', r.pkg === 'ruflo' ? 'fail' : 'warn',
          `${r.pkg} not installed globally`, 'setup installs it'));
      } else if (r.outdated) {
        rows.push(row('versions', 'warn',
          `${r.pkg} ${r.installed} installed, ${r.latest} available`, 'sync upgrades + re-heals'));
      } else {
        rows.push(row('versions', 'ok', `${r.pkg} ${r.installed}${r.latest ? ' (latest)' : ''}`));
      }
    }
  } catch (e) {
    rows.push(row('versions', 'warn', `version check unavailable: ${e.message}`));
  }

  // ruvnet-brain (offline KB + search_ruvnet MCP; not an npm package — detected
  // on disk, drift via GitHub releases, TTL-cached like `self`)
  if (cfg.ruvnetBrain) {
    try {
      const b = await ruvnetBrainDrift();
      if (!b.present) {
        rows.push(row('ruvnet-brain', 'warn', 'RuvNet Brain not installed', 'setup installs it (or `ak sync`)'));
      } else if (b.outdated) {
        const have = b.installedRelease ? `release v${b.installedRelease}` : 'present (unversioned install)';
        rows.push(row('ruvnet-brain', 'warn',
          `ruvnet-brain ${have}, release v${b.latest} available`, 'sync refreshes the KB'));
      } else {
        const shown = b.installedRelease ? `release v${b.installedRelease}${b.latest ? ' (latest)' : ''}` : 'present';
        rows.push(row('ruvnet-brain', 'ok', `ruvnet-brain ${shown}`));
      }
    } catch (e) {
      rows.push(row('ruvnet-brain', 'warn', `ruvnet-brain check unavailable: ${e.message}`));
    }
  }

  // self (the kit's own version — prerelease installs track the `next` tag)
  try {
    const s = await selfDrift({ pkgRoot });
    if (s.outdated) {
      rows.push(row('self', 'warn',
        `kit ${s.installed} installed, ${s.latest} available (${s.tag} tag)`,
        'sync self-updates the kit (runs last)'));
    } else if (s.installed) {
      rows.push(row('self', 'ok', `kit ${s.installed}${s.latest ? ' (latest)' : ''}`));
    }
  } catch (e) {
    rows.push(row('self', 'warn', `kit version check unavailable: ${e.message}`));
  }

  // natives (better-sqlite3 in agentdb locations + aqe)
  try {
    const n = nativesStatus();
    const bad = n.locations.filter((l) => !l.native);
    if (n.locations.length === 0) {
      rows.push(row('natives', 'warn', 'no agentdb locations found under global ruflo', 'setup/sync installs ruflo'));
    } else if (bad.length) {
      rows.push(row('natives', 'fail',
        `${bad.length}/${n.locations.length} agentdb location(s) on WASM fallback (data-loss writes)`,
        'sync installs native better-sqlite3'));
    } else {
      rows.push(row('natives', 'ok', `native better-sqlite3 in ${n.locations.length} agentdb location(s)`));
    }
    if (n.aqe && !n.aqe.native) {
      rows.push(row('natives', 'fail', 'agentic-qe better-sqlite3 not native', 'sync repairs it'));
    }
  } catch (e) {
    rows.push(row('natives', 'warn', `native check unavailable: ${e.message}`));
  }

  // security surface
  if (securityPresent()) {
    if (aidefencePresent()) {
      rows.push(row('security', 'ok', '@claude-flow/security + aidefence present (defend functional)'));
    } else {
      rows.push(row('security', 'fail',
        'aidefence missing — `security defend` silently non-functional (ruvnet/ruflo#2670)',
        'sync reinstalls @claude-flow/aidefence'));
    }
  } else {
    rows.push(row('security', 'warn', '@claude-flow/security not found under global ruflo'));
  }

  // learning (project-scope quick signals)
  const stats = readJson(path.join(paths.projectClaudeFlowDir(cwd), 'neural', 'stats.json'));
  if (stats) {
    const pn = stats.patternsLearned ?? 0;
    rows.push(row('learning', pn > 0 ? 'ok' : 'warn',
      pn > 0 ? `${pn} patterns learned, ${stats.trajectoriesRecorded ?? 0} trajectories (this project)`
             : 'learning initialized but no patterns yet (this project)'));
  } else {
    rows.push(row('learning', 'info', 'no learning state in this project (run setup here to activate)'));
  }

  // aqe / RVF (project scope)
  const aqeDir = paths.projectAqeDir(cwd);
  if (fs.existsSync(aqeDir)) {
    const findings = scanRvf(aqeDir);
    if (findings.length) {
      rows.push(row('aqe', 'fail',
        `${findings.length} corrupt/oversized RVF artifact(s) — aqe will drop OFF ruvector (FsyncFailed)`,
        'sync quarantines them (rebuilt from memory.db)'));
    } else {
      rows.push(row('aqe', 'ok', 'agentic-qe initialized here; RVF store healthy'));
    }
  } else {
    rows.push(row('aqe', 'info', 'agentic-qe not initialized in this project'));
  }

  // MCP
  const mcp = registrationStatus();
  if (mcp.claudeFlow) {
    rows.push(row('mcp', 'ok',
      `claude-flow registered (user scope)${mcp.denyCount ? `, ${mcp.denyCount} tool(s) denied by family exclusions` : ', all families allowed'}`));
  } else if (cfg.mcp.register) {
    rows.push(row('mcp', 'warn', 'ruflo MCP not registered', 'setup/sync registers claude-flow at user scope'));
  } else {
    rows.push(row('mcp', 'info', 'MCP registration disabled in kit.json'));
  }
  if (mcp.legacyRuflo) {
    rows.push(row('mcp', 'warn', "legacy 'ruflo'-keyed MCP registration present", 'sync migrates it to claude-flow'));
  }

  // hosts (install-if-missing) — cheap: file read + `which`, no network.
  // An enabled host that is entirely absent is installable by sync; an external
  // install (mise/native/brew) is reported but never touched.
  try {
    for (const h of HOSTS) {
      if (!cfg.providers.hosts[h.id]) continue;
      const st = await hostInstallState(h);
      if (st.method === 'absent') {
        rows.push(row('hosts', h.id === 'claude' ? 'fail' : 'warn',
          `${h.id} enabled but not installed`, `sync installs ${h.pkg}`));
      } else {
        rows.push(row('hosts', 'ok', `${h.id} ${st.version ?? ''} (${st.method}${st.method === 'external' ? ' — self-managed' : ''})`));
      }
    }
  } catch (e) {
    rows.push(row('hosts', 'warn', `host check unavailable: ${e.message}`));
  }

  // providers (frontier host wiring) — light: `have` probe + env read, no --version
  try {
    const { file, scope } = settingsTarget(cwd);
    const env = readJson(file, {})?.env ?? {};
    if (isDefault(cfg)) {
      // advisory only (no fix): opting codex in is a deliberate `x provider pick`
      if (await have('codex')) {
        rows.push(row('providers', 'info', 'codex CLI installed but not enabled (claude-only default)'));
      } else {
        rows.push(row('providers', 'info', 'claude-only (default host)'));
      }
    } else {
      const desired = managedEnv(cfg);
      const envDrift = MANAGED_ENV_KEYS.some((k) => (k in desired ? env[k] !== desired[k] : k in env));
      // aqe fallback chain: on-disk llm-config.json must match kit.json order
      const chain = cfg.providers.aqeFallback ?? [];
      let routerDrift = false;
      if (chain.length) {
        const disk = readJson(aqeRouterFile(cwd));
        const diskOrder = (disk?.fallbackChain?.entries ?? []).map((e) => e.provider).join('→');
        routerDrift = disk?._managedBy !== 'agentic-kit' || diskOrder !== chain.map((e) => e.provider).join('→');
      }
      const on = HOSTS.filter((h) => cfg.providers.hosts[h.id]).map((h) => h.id).join('+') || 'none';
      const chainStr = chain.length ? `; aqe chain ${chain.map((e) => e.provider).join('→')}` : '';
      if (envDrift || routerDrift) {
        rows.push(row('providers', 'warn', `provider config drifted (want ${on}${chainStr}, ${scope})`, 'sync re-applies provider env + aqe router'));
      } else {
        rows.push(row('providers', 'ok', `wired: ${on}${chainStr} (${scope})`));
      }
    }
  } catch (e) {
    rows.push(row('providers', 'warn', `provider check unavailable: ${e.message}`));
  }

  // daemons
  try {
    const daemons = await listDaemons({ cwd });
    const stale = staleDaemons(daemons);
    if (stale.length) {
      rows.push(row('daemons', 'warn',
        `${daemons.length} running, ${stale.length} stale (orphaned or past TTL)`, 'sync reaps stale daemons'));
    } else {
      rows.push(row('daemons', 'ok',
        daemons.length ? `${daemons.length} running (one per active project is expected)` : 'none running'));
    }
  } catch (e) {
    rows.push(row('daemons', 'warn', `daemon check unavailable: ${e.message}`));
  }

  // CLAUDE.md blocks (dry-run reconcile = drift report)
  try {
    const rows_ = registry(cfg.customBlocks);
    const resolve = (r) => (r.custom
      ? (r.template.startsWith('~/') ? path.join(paths.home, r.template.slice(2)) : r.template)
      : path.join(pkgRoot, 'claude', r.template));
    const res = await syncBlocks(paths.claudeMdPath(), rows_, resolve, { dryRun: true });
    const drift = res.filter((r) => r.action === 'upserted' || r.action === 'stripped');
    const missing = res.filter((r) => r.action === 'missing-template');
    if (drift.length) {
      rows.push(row('blocks', 'warn',
        `${drift.length} CLAUDE.md block(s) drifted: ${drift.map((d) => `${d.slug}→${d.action.replace('ped', 'p')}`).join(', ')}`,
        'sync reconciles blocks'));
    } else {
      rows.push(row('blocks', 'ok', `CLAUDE.md managed blocks in sync (${res.length} in registry)`));
    }
    for (const m of missing) rows.push(row('blocks', 'warn', `template missing for block '${m.slug}'`));
  } catch (e) {
    rows.push(row('blocks', 'warn', `block check unavailable: ${e.message}`));
  }

  // statusline footer (project scope)
  const sl = paths.projectStatusline(cwd);
  if (fs.existsSync(sl)) {
    const hasFooter = fs.readFileSync(sl, 'utf8').includes('ruflo-seg:BEGIN');
    rows.push(row('statusline', hasFooter ? 'ok' : 'warn',
      hasFooter ? 'activation footer present' : 'statusline present but footer missing',
      hasFooter ? null : 'sync re-injects the footer'));
  } else {
    rows.push(row('statusline', 'info', 'no project statusline here (created by setup)'));
  }

  return rows;
}

export async function run({ flags, pkgRoot }) {
  const rows = await collect({ pkgRoot });
  const worst = rows.some((r) => r.level === 'fail') ? 'fail'
    : rows.some((r) => r.level === 'warn') ? 'warn' : 'ok';

  if (flags.json) {
    console.log(JSON.stringify({ overall: worst, rows }, null, 2));
    return worst === 'fail' ? 1 : 0;
  }

  console.log(bold('ak status'));
  let last = '';
  for (const r of rows) {
    const label = r.subsystem === last ? ' '.repeat(r.subsystem.length) : r.subsystem;
    last = r.subsystem;
    console.log(`  ${glyph(r.level)} ${label.padEnd(11)} ${r.message}${r.fix ? dim(`  → ${r.fix}`) : ''}`);
  }

  if (flags.hint) {
    const actionable = rows.filter((r) => r.fix);
    console.log('');
    if (worst === 'ok') console.log(`${glyph('ok')} all healthy — nothing to do`);
    else console.log(`${actionable.length} item(s) need attention — run: ${bold('ak sync')}${worst === 'fail' ? '' : dim('  (or --dry-run to preview)')}`);
  }
  return worst === 'fail' ? 1 : 0;
}
