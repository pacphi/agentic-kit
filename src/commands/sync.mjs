// ak sync — converge to good. Plan comes from the same collector status
// uses; --dry-run prints it and stops. Apply order: upgrades first (they wipe
// natives), then heals, then re-collect to prove convergence.
import path from 'node:path';
import { collect } from './status.mjs';
import * as heal from '../lib/heal.mjs';
import { fixStatusline } from '../lib/statusline.mjs';
import { registry, syncBlocks } from '../lib/blocks.mjs';
import { register as mcpRegister, applyExclusions } from '../lib/mcp.mjs';
import { listDaemons, staleDaemons, reap } from '../lib/daemons.mjs';
import { loadKitConfig } from '../lib/config.mjs';
import { driftReport } from '../lib/versions.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, fail, bold, dim } from '../lib/output.mjs';

export const options = {
  'dry-run': { type: 'boolean', default: false },
  'no-upgrade': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

export async function run({ flags, pkgRoot }) {
  const cwd = process.cwd();
  const rows = await collect({ pkgRoot, cwd });
  const plan = rows.filter((r) => r.fix)
    .filter((r) => !(flags['no-upgrade'] && r.subsystem === 'versions'));

  if (plan.length === 0) { ok('nothing to do — all subsystems healthy'); return 0; }

  console.log(bold(`sync plan (${plan.length} action(s)):`));
  for (const p of plan) console.log(`  • [${p.subsystem}] ${p.fix} ${dim(`— because: ${p.message}`)}`);
  if (flags['dry-run']) return 0;
  console.log('');

  const cfg = loadKitConfig();
  const subsystems = new Set(plan.map((p) => p.subsystem));
  const report = (name, r) => (r.ok ? ok(`${name}: ${r.detail}`) : fail(`${name}: ${r.detail}`));

  if (subsystems.has('versions') && !flags['no-upgrade']) {
    report('daemons', await heal.stopAllDaemons());
    for (const d of await driftReport({ force: true })) {
      if (d.outdated || !d.installed) report(`upgrade ${d.pkg}`, await heal.upgradePackage(d.pkg));
    }
  }
  if (subsystems.has('natives') || subsystems.has('versions')) {
    report('natives', await heal.healNatives());
  }
  if (subsystems.has('security') || subsystems.has('versions')) {
    report('aidefence', await heal.healAidefence());
    report('aqe solver', await heal.healAqeSolver());
  }
  if (subsystems.has('aqe')) {
    report('rvf', heal.healRvf(paths.projectAqeDir(cwd)));
  }
  if (subsystems.has('mcp') && cfg.mcp.register) {
    const okReg = await mcpRegister();
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
  if (subsystems.has('statusline') || subsystems.has('versions')) {
    const r = fixStatusline(cwd);
    (r.applied || !r.reason ? ok : warn)(`statusline: ${r.applied ? `footer injected (v${r.version})` : r.reason ?? 'in sync'}`);
  }

  // converge proof
  console.log('');
  const after = await collect({ pkgRoot, cwd });
  const remaining = after.filter((r) => r.level === 'fail');
  if (remaining.length === 0) { ok(bold('converged — no failing subsystems')); return 0; }
  for (const r of remaining) fail(`still failing: [${r.subsystem}] ${r.message}`);
  return 1;
}
