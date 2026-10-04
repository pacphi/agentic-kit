// scripts/skills-mirror.mjs — keep the authored maintainer skills identical for Claude and Codex.
// `.claude/skills/<name>` is the source; `.agents/skills/<name>` is a verbatim copy (LF endings).
// Only the names in AUTHORED_SKILLS are mirrored. Every other folder, an unlisted `ak-*` one or a
// generated `managed-tools` skill, is never read, copied or reported.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The one list of authored skills. Each name also needs its two exception lines in .gitignore
// (`!/.claude/skills/<name>/` and `!/.agents/skills/<name>/`) and a contract in
// tests/kit/ak-skills.test.mjs, which checks that the three agree.
export const AUTHORED_SKILLS = Object.freeze([
  'ak-docs-gate',
  'ak-pricing-refresh',
  'ak-release',
  'ak-resume',
  'ak-ship',
  'ak-token-audit',
  'ak-upstream-file',
  'ak-upstream-status',
  'ak-verify',
  'ak-worktree-sweep',
]);
const SOURCE = '.claude/skills';
const TARGET = '.agents/skills';
const TEXT = /\.(md|json|ya?ml|toml|mjs)$/i;

const bytes = (file) => {
  const data = fs.readFileSync(file);
  return TEXT.test(file) ? Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n')) : data;
};

function files(dir) {
  if (!fs.existsSync(dir)) return [];
  const walk = (current) => fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() ? [path.relative(dir, full).split(path.sep).join('/')] : [];
  });
  return walk(dir).sort();
}

const isDir = (dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory();

/**
 * A stale copy is a problem for --check (the copies differ) and a removal for a write run (fixed).
 * A listed skill with no `.claude` folder is a problem, and its `.agents` copy is never deleted.
 * @param {{root?: string, check?: boolean, skills?: readonly string[]}} [options]
 * @returns {{changed: string[], removed: string[], problems: string[]}}
 */
export function mirrorSkills({ root = process.cwd(), check = false, skills = AUTHORED_SKILLS } = {}) {
  const src = path.join(root, SOURCE);
  const dst = path.join(root, TARGET);
  const changed = [];
  const removed = [];
  const problems = [];
  for (const name of skills) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (!isDir(from)) {
      problems.push(isDir(to)
        ? `${TARGET}/${name} has no ${SOURCE}/${name}`
        : `${SOURCE}/${name} is missing; AUTHORED_SKILLS lists it`);
      continue;
    }
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) {
      problems.push(`${SOURCE}/${name} has no SKILL.md`);
      continue;
    }
    const want = files(from);
    for (const extra of files(to).filter((file) => !want.includes(file))) {
      if (check) {
        problems.push(`${TARGET}/${name}/${extra} is not in ${SOURCE}/${name}`);
        continue;
      }
      fs.rmSync(path.join(to, extra));
      removed.push(`${TARGET}/${name}/${extra}`);
    }
    for (const file of want) {
      const content = bytes(path.join(from, file));
      const target = path.join(to, file);
      if (fs.existsSync(target) && fs.readFileSync(target).equals(content)) continue;
      changed.push(`${TARGET}/${name}/${file}`);
      if (check) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  return { changed, removed, problems };
}

/**
 * @param {string[]} argv
 * @param {string} [root]
 * @param {readonly string[]} [skills]
 */
export function main(argv, root = process.cwd(), skills = AUTHORED_SKILLS) {
  // Any other argument, a positional one included (`check` without its dashes), is a usage error,
  // never a write run.
  if (argv.some((arg) => arg !== '--check')) {
    console.error('usage: skills-mirror.mjs [--check]');
    return 2;
  }
  const check = argv.includes('--check');
  const { changed, removed, problems } = mirrorSkills({ root, check, skills });
  for (const file of changed) console.log(`${check ? 'differs' : 'wrote'} ${file}`);
  for (const file of removed) console.log(`removed ${file}`);
  for (const problem of problems) console.error(problem);
  return problems.length || (check && changed.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
