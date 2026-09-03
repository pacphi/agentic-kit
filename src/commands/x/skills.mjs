import path from 'node:path';

import { collectCatalog } from '../../lib/footprint/catalog.mjs';
import { buildSkillMaintenancePlan } from '../../lib/skill-maintenance-plan.mjs';
import { loadKitConfig } from '../../lib/config.mjs';
import { heading, info, warn, dim } from '../../lib/output.mjs';

export const options = {
  project: { type: 'string' },
  json: { type: 'boolean', default: false },
};

export const help = `ak x skills plan — read-only project skill maintenance plan

Classifies project skills using bounded digest, source, plugin, receipt, and git
evidence. It never changes or deletes anything. Mutation belongs to issue #200.

Usage: ak x skills plan [--project PATH] [--json]

Options:
  --project PATH   project to inspect (default: current working directory)
  --json           emit the complete evidence and plan payload

Examples:
  ak x skills plan
  ak x skills plan --project /absolute/path/to/project --json`;

export async function run({ flags, positionals }) {
  if ((positionals[0] ?? 'plan') !== 'plan' || positionals.length > 1) {
    warn('usage: ak x skills plan [--project PATH] [--json]');
    return 2;
  }
  const project = path.resolve(flags.project ?? process.cwd());
  const cfg = loadKitConfig();
  const catalog = /** @type {any} */ (collectCatalog({ cwd: project, projects: [project], cfg }));
  const receipts = cfg.maintenance?.skillReceipts ?? [];
  const plan = buildSkillMaintenancePlan({ catalog, project, receipts });
  if (flags.json) {
    console.log(JSON.stringify({ catalog: {
      schemaVersion: catalog.schemaVersion, complete: catalog.complete,
      pluginSources: catalog.pluginSources, overlaps: catalog.overlaps,
      project: catalog.projects.find((row) => row.project === project) ?? null,
    }, plan }, null, 2));
    return 0;
  }
  heading('Project skill maintenance — read-only plan');
  info(`${project}`);
  info(`${plan.projection.currentProjectSkillPaths} project skill path(s) · `
    + `${plan.projection.safePruneCandidates} receipt-proven safe-prune candidate(s)`);
  for (const artifact of plan.artifacts) {
    const evidence = artifact.git.tracked === true ? 'tracked'
      : artifact.git.tracked === false ? 'untracked' : 'git unknown';
    info(`${artifact.displayName}: ${artifact.classification} · ${evidence}`);
    info(dim(`  ${artifact.path}`));
  }
  if (!plan.artifacts.length) info(dim('No project-scoped skills were observed.'));
  info(dim('Nothing was changed. Mutating remediation is tracked in GitHub issue #200.'));
  return 0;
}
