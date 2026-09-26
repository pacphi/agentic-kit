// Which scope a plain `ak setup` configures from a directory. setup.mjs makes
// its project/machine decision with this predicate and the status readiness
// hints name their command from it, so a hint never promises project setup
// that plain `ak setup` would not perform (#237, audit N3).
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';

/** Plain `ak setup` selects project scope only in a directory that itself
 *  holds `.git`, and never in the home directory (a dotfiles repository). */
export function setupSelectsProject(cwd) {
  return fs.existsSync(path.join(cwd, '.git')) && cwd !== paths.home;
}

/** The hint clause naming the command that sets project features up in `cwd`:
 *  plain setup in a repository root; otherwise `ak setup --project` (or the
 *  repository root, from a subfolder), because plain setup here would
 *  configure the machine only.
 *  @param {string} cwd @param {string} verb e.g. 'initialize' */
export function projectSetupHint(cwd, verb) {
  if (setupSelectsProject(cwd)) return `run setup here to ${verb}`;
  const machineOnly = 'plain `ak setup` here configures the machine only';
  const root = paths.repoRoot(cwd);
  if (root && root !== path.resolve(cwd) && root !== paths.home) {
    return `${machineOnly}; run it at the repository root, or \`ak setup --project\` to ${verb} this folder`;
  }
  return `${machineOnly}; run \`ak setup --project\` to ${verb} this folder`;
}
