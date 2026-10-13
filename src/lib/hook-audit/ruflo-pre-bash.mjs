// A project's Ruflo hook helper whose pre-bash path prints [BLOCKED] and still
// lets the command run. Claude Code blocks a PreToolUse command only on exit 2;
// exit 1 is a non-blocking error. @claude-flow/cli 3.5.19 through 3.51.0 write
// process.exit(1) there, and 3.51.1 is the first release that writes exit 2.
// The helper is read, never run. The fix belongs to Ruflo, so no recipe edits it.
import path from 'node:path';
import { readBoundedFile, sha256 } from './common.mjs';

export const RUFLO_FIRST_BLOCKING_RELEASE = '3.51.1';
export const RUFLO_HELPER_REFRESH = 'ruflo init upgrade';
export const RUFLO_PRE_BASH_CODE = 'ruflo-pre-bash-exit-not-blocking';

const HELPER_RELATIVE = path.join('.claude', 'helpers', 'hook-handler.cjs');
const PRE_BASH_HANDLER = /['"]pre-bash['"]\s*:\s*(?:async\s*)?(?:\(|function|\w+\s*=>)/;
const COMMENTS = /\/\*[\s\S]*?\*\/|(?:^|\s)\/\/[^\n]*/g;
const NEXT_HANDLER = /\n {2}['"][\w-]+['"]\s*:/;

/** The exit code that follows [BLOCKED] in the pre-bash handler: the first one
 *  that is not 2 when any [BLOCKED] path misses it, else 2. Null when the
 *  handler has no [BLOCKED] path with a literal process.exit. Comments are
 *  ignored. */
export function preBashBlockedExit(source) {
  const text = source.replace(COMMENTS, (match) => match.replace(/[^\n]/g, ' '));
  const start = PRE_BASH_HANDLER.exec(text);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const body = rest.slice(0, NEXT_HANDLER.exec(rest)?.index ?? rest.length);
  const exits = [];
  for (let at = body.indexOf('[BLOCKED]'); at >= 0; at = body.indexOf('[BLOCKED]', at + 1)) {
    // The first closing brace on its own line ends the `if` that prints [BLOCKED].
    const branch = body.slice(at).split(/\n\s*\}/, 1)[0];
    const exit = /process\.exit\(\s*(\d+)\s*\)/.exec(branch);
    if (exit) exits.push(Number(exit[1]));
  }
  if (!exits.length) return null;
  return exits.find((code) => code !== 2) ?? 2;
}

export function auditRufloPreBash(projectRoots) {
  const sources = [];
  const plan = [];
  for (const root of [...new Set(projectRoots.map((item) => path.resolve(item)))]) {
    const file = path.join(root, HELPER_RELATIVE);
    const read = readBoundedFile(file, root);
    if (read.status === 'absent') continue;
    sources.push({ file, baseDir: root, kind: 'ruflo-hook-helper', authority: 'project-owner',
      generatedStatus: 'unknown', status: read.status, digest: read.digest, error: read.error });
    if (read.status !== 'valid') continue;
    const exitCode = preBashBlockedExit(read.text);
    if (exitCode === null || exitCode === 2) continue;
    plan.push({ id: `ruflo-pre-bash-${sha256(file).slice(0, 16)}`, host: 'claude', target: file,
      diagnostic: RUFLO_PRE_BASH_CODE, classification: 'upstream-required',
      reason: `Ruflo helper prints [BLOCKED] but exits ${exitCode}, so Claude Code still runs the command unless the helper also prints a JSON deny; only exit 2 blocks. `
        + `Ruflo ${RUFLO_FIRST_BLOCKING_RELEASE} is the first release that blocks: update Ruflo, then run \`${RUFLO_HELPER_REFRESH}\` in the project`,
      evidence: { exitCode, firstBlockingRelease: RUFLO_FIRST_BLOCKING_RELEASE, fix: RUFLO_HELPER_REFRESH } });
  }
  return { sources, plan };
}
