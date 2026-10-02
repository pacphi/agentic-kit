// The steps that move a machine from the user-level ak to the project-scoped line. `ak sync` prints
// them instead of updating the kit (docs/plans/2026-10-01-project-scope-only-design.md, "The
// instructions"). They always run this release by exact version through npx, whatever happens to be
// installed globally, so the old setup can be removed even from a broken or missing global `ak`.
import { KIT_PKG } from './versions.mjs';

/** @param {string | null | undefined} version the running kit's exact version
 *  @returns {{ title: string, commands: string[] }[]} */
export function upgradeSteps(version) {
  const spec = `${KIT_PKG}@${version || '<this-version>'}`;
  return [
    {
      title: 'Remove the old setup with this release (preview first)',
      commands: [`npx ${spec} uninstall --purge --dry-run`, `npx ${spec} uninstall --purge`],
    },
    {
      title: 'Remove the old global runner, if you installed one',
      commands: [`npm uninstall -g ${KIT_PKG}`],
    },
    {
      title: 'Opt in each project you want (@beta during the betas, @latest after GA)',
      commands: ['cd my-project', `npx ${KIT_PKG}@beta init`],
    },
  ];
}

/** The lines `ak sync` prints. @param {string | null | undefined} version */
export function upgradeStepLines(version) {
  const lines = ['ak does not update itself. To move to the project-scoped line, run these steps:'];
  upgradeSteps(version).forEach((step, i) => {
    lines.push(`  ${i + 1}. ${step.title}`);
    for (const command of step.commands) lines.push(`       ${command}`);
  });
  return lines;
}
