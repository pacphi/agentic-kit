# ak- maintainer skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Status

**Active** (2026-10-03). Waiting for the maintainer to review this plan and choose an execution
method. Nothing is implemented; the design is approved.

**Goal:** Track nine `ak-` maintainer skills for Claude and Codex through one prefix convention, with a mirror script and contract tests.

**Architecture:** `.gitignore` and `.gitattributes` gain an `ak-*` glob in place of the per-skill `upstream-status` exceptions. `.claude/skills/ak-*` is the source; `scripts/skills-mirror.mjs` copies it verbatim to `.agents/skills/ak-*`. One data-driven test file holds a contract per skill (triggers, cited paths, gate phrases).

**Tech Stack:** Node.js 22+ ES modules, `node:test`, no new dependencies.

**Spec:** [2026-10-03-ak-maintainer-skills-design.md](2026-10-03-ak-maintainer-skills-design.md)

## Global Constraints

- Skill folders are named `ak-<name>`; `name:` in the frontmatter equals the folder name.
- Each `SKILL.md` is under 500 lines, with LF endings, and has the parts: frontmatter, when to use, preflight, steps, gates, done.
- `.agents/skills/ak-*` is a verbatim copy of `.claude/skills/ak-*`.
- Skills restate no script logic; they name `scripts/*.mjs` files and `pnpm run` scripts that exist.
- A skill never merges, publishes, posts, pushes or deletes without the maintainer's explicit yes on that specific action.
- Generated skills (`a11y-ally`, `dual-mode`, every non-`ak-` folder) are neither renamed nor wrapped.
- Archived ADRs and plans keep the name `upstream-status`.
- Markdown file names are lower case; no folder is added under `docs/`; no `Co-Authored-By` trailer.
- Commits are local. Ask the maintainer before the first push. Never merge.

## Concurrency (another session works in this repository)

- This plan runs only in the worktree `../agentic-kit-wt-ak-skills` on `feat/ak-maintainer-skills`. Never switch branches in `../agentic-kit`; the other session uses it.
- The other session's branches (`upstream/proffesor-for-testing-agentic-qe-735`, `fix/completion-m1`) touch none of the files this plan edits (checked 2026-10-03: `.gitignore`, `.gitattributes`, `AGENTS.md`, `docs/maintainer.md`, `docs/upstream-watch.md`, `scripts/`, `tests/kit/upstream-watch-*`). Re-check in Task 11.
- Never run `pnpm` in this worktree (it would try to replace the symlinked `node_modules`). Use `node scripts/run-tests.mjs …` and the binaries under `node_modules/.bin`.
- Only one writer at a time in this worktree. Subagents run one after another.

## Review Focus

1. A generated skill folder that happens to start with `ak-` appears: the "every folder has a contract" test fails and says to add one.
2. A Windows checkout rewrites `SKILL.md` to CRLF: `.gitattributes` pins every `ak-*` file, and the test asks git for the `eol` attribute of each discovered skill.
3. Mirroring on Windows: file lists use `/` separators, never `path.sep`.
4. A cited script is renamed later: the contract test fails on the stale path.
5. A skill exists on `.agents` only: `--check` reports it, and the script never deletes a whole skill folder.
6. The maintainer types `ship` without a PR number: the skill must ask which PR rather than guess (gate phrase tested in Task 4).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/skills-mirror.mjs` (create) | Copy and check `.claude/skills/ak-*` against `.agents/skills/ak-*`. |
| `tests/kit/skills-mirror.test.mjs` (create) | Unit tests for the mirror script on temp folders. |
| `tests/kit/ak-skills.test.mjs` (create, from `upstream-watch-skill.test.mjs`) | Contract tests over the real skill folders. |
| `tests/kit/upstream-watch-skill.test.mjs` (delete) | Replaced by the file above. |
| `.gitignore`, `.gitattributes` (modify) | `ak-*` glob in place of the `upstream-status` exceptions. |
| `.claude/skills/ak-*/SKILL.md`, `.agents/skills/ak-*/SKILL.md` (create) | The nine skills; `ak-upstream-status` is a rename. |
| `docs/maintainer.md`, `docs/upstream-watch.md`, `AGENTS.md` (modify) | Living docs. |

---

### Task 1: The mirror script

**Files:**

- Create: `scripts/skills-mirror.mjs`
- Test: `tests/kit/skills-mirror.test.mjs`

**Interfaces:**

- Produces: `mirrorSkills({ root?: string, check?: boolean }): { changed: string[], problems: string[] }` and `main(argv: string[], root?: string): number`. `changed` holds repo-relative POSIX paths that were (or, with `check`, would be) written; `problems` holds human-readable lines for orphans, a missing `SKILL.md`, and extra files. Constant `PREFIX = 'ak-'`.

- [ ] **Step 1: Write the failing test**

```js
// tests/kit/skills-mirror.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import { mirrorSkills, main } from '../../scripts/skills-mirror.mjs';

const put = (root, rel, text) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('copies an ak- skill to the Codex folder, normalizing CRLF, and a second run changes nothing', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', '---\r\nname: ak-ship\r\n---\r\nbody\r\n');
  put(root, '.claude/skills/ak-ship/notes/extra.md', 'extra\n');
  const first = mirrorSkills({ root });
  assert.deepEqual(first.changed.sort(), ['.agents/skills/ak-ship/SKILL.md', '.agents/skills/ak-ship/notes/extra.md']);
  assert.deepEqual(first.problems, []);
  assert.equal(read(root, '.agents/skills/ak-ship/SKILL.md'), '---\nname: ak-ship\n---\nbody\n');
  assert.deepEqual(mirrorSkills({ root }), { changed: [], problems: [] });
});

test('--check reports a differing copy and writes nothing', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', 'new\n');
  put(root, '.agents/skills/ak-ship/SKILL.md', 'old\n');
  const result = mirrorSkills({ root, check: true });
  assert.deepEqual(result.changed, ['.agents/skills/ak-ship/SKILL.md']);
  assert.equal(read(root, '.agents/skills/ak-ship/SKILL.md'), 'old\n');
});

test('an ak- skill that exists only for Codex is a problem and is never deleted', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.agents/skills/ak-lost/SKILL.md', 'x\n');
  const result = mirrorSkills({ root });
  assert.match(result.problems.join('\n'), /\.agents\/skills\/ak-lost has no \.claude\/skills\/ak-lost/);
  assert.equal(read(root, '.agents/skills/ak-lost/SKILL.md'), 'x\n');
});

test('generated skills without the prefix are never mirrored', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/a11y-ally/SKILL.md', 'generated\n');
  assert.deepEqual(mirrorSkills({ root }), { changed: [], problems: [] });
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/a11y-ally')), false);
});

test('a skill folder without SKILL.md is a problem', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-empty/notes.md', 'x\n');
  assert.match(mirrorSkills({ root }).problems.join('\n'), /ak-empty has no SKILL\.md/);
});

test('a stale file inside a mirrored skill is removed, and only reported with --check', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', 'a\n');
  put(root, '.agents/skills/ak-ship/SKILL.md', 'a\n');
  put(root, '.agents/skills/ak-ship/old.md', 'stale\n');
  const checked = mirrorSkills({ root, check: true });
  assert.match(checked.problems.join('\n'), /\.agents\/skills\/ak-ship\/old\.md is not in \.claude\/skills\/ak-ship/);
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/ak-ship/old.md')), true);
  mirrorSkills({ root });
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/ak-ship/old.md')), false);
});

test('main returns 1 for --check drift, 0 once mirrored, and 2 for an unknown flag', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', 'a\n');
  assert.equal(main(['--check'], root), 1);
  assert.equal(main([], root), 0);
  assert.equal(main(['--check'], root), 0);
  assert.equal(main(['--bogus'], root), 2);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node scripts/run-tests.mjs focus tests/kit/skills-mirror.test.mjs`
Expected: FAIL, `Cannot find module '../../scripts/skills-mirror.mjs'`.

- [ ] **Step 3: Write the script**

```js
// scripts/skills-mirror.mjs — keep the authored ak- maintainer skills identical for Claude and Codex.
// `.claude/skills/ak-*` is the source; `.agents/skills/ak-*` is a verbatim copy (LF endings).
// Generated skills (any folder without the prefix) are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREFIX = 'ak-';
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

const skillNames = (root) => (fs.existsSync(root)
  ? fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFIX)).map((entry) => entry.name).sort()
  : []);

/**
 * @param {{root?: string, check?: boolean}} [options]
 * @returns {{changed: string[], problems: string[]}}
 */
export function mirrorSkills({ root = process.cwd(), check = false } = {}) {
  const src = path.join(root, SOURCE);
  const dst = path.join(root, TARGET);
  const changed = [];
  const problems = [];
  const sources = skillNames(src);
  for (const name of skillNames(dst)) {
    if (!sources.includes(name)) problems.push(`${TARGET}/${name} has no ${SOURCE}/${name}`);
  }
  for (const name of sources) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) {
      problems.push(`${SOURCE}/${name} has no SKILL.md`);
      continue;
    }
    const want = files(from);
    for (const extra of files(to).filter((file) => !want.includes(file))) {
      problems.push(`${TARGET}/${name}/${extra} is not in ${SOURCE}/${name}`);
      if (!check) fs.rmSync(path.join(to, extra));
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
  return { changed, problems };
}

export function main(argv, root = process.cwd()) {
  const flags = argv.filter((arg) => arg.startsWith('-'));
  if (flags.some((flag) => flag !== '--check')) {
    console.error('usage: skills-mirror.mjs [--check]');
    return 2;
  }
  const check = flags.includes('--check');
  const { changed, problems } = mirrorSkills({ root, check });
  for (const file of changed) console.log(`${check ? 'differs' : 'wrote'} ${file}`);
  for (const problem of problems) console.error(problem);
  return problems.length || (check && changed.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node scripts/run-tests.mjs focus tests/kit/skills-mirror.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/skills-mirror.mjs tests/kit/skills-mirror.test.mjs
git commit -m "feat(scripts): mirror ak- maintainer skills to Codex"
```

---

### Task 2: Prefix convention, the rename and the contract test

**Files:**

- Modify: `.gitignore:28-39`, `.gitattributes:11-14`, `tests/kit/upstream-watch-workflow.test.mjs:91`
- Rename: `.claude/skills/upstream-status` to `.claude/skills/ak-upstream-status`, `.agents/skills/upstream-status` to `.agents/skills/ak-upstream-status`
- Rename and rewrite: `tests/kit/upstream-watch-skill.test.mjs` to `tests/kit/ak-skills.test.mjs`

**Interfaces:**

- Consumes: `mirrorSkills` from Task 1.
- Produces: the `CONTRACTS` object in `tests/kit/ak-skills.test.mjs`, keyed by skill name, each value `{ triggers: RegExp[], gates: RegExp[] }`. Tasks 3 to 10 each add one entry.

- [ ] **Step 0: Link the dependencies for the tooling**

```bash
ln -s ../agentic-kit/node_modules node_modules
ls node_modules/.bin/eslint node_modules/.bin/markdownlint node_modules/.bin/tsc
```

Expected: the three binaries are listed. `node_modules` is gitignored. Never run `pnpm` here.

- [ ] **Step 1: Write the new test file**

```bash
git mv tests/kit/upstream-watch-skill.test.mjs tests/kit/ak-skills.test.mjs
```

Replace the whole file with:

```js
// The ak- maintainer skills: authored for this repository, one text for Claude (.claude/skills)
// and Codex (.agents/skills), tracked through an `ak-*` glob in .gitignore while every
// generated skill beside them stays ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { GROUPS } from '../../scripts/upstream-watch/classify.mjs';
import { mirrorSkills } from '../../scripts/skills-mirror.mjs';

const HOSTS = ['.claude/skills', '.agents/skills'];
// Each authored skill states its trigger phrases and the gates that keep it from acting
// without the maintainer's yes. A new skill adds an entry here in the same commit.
const CONTRACTS = {
  'ak-upstream-status': {
    triggers: [/upstream status/i, /upstream report/i],
    gates: [/explicit-user-approval-required/, /never (post|push|merge)/i, /fetchErrors/],
  },
};

// .gitattributes checks the skills out with LF everywhere; reading them as LF keeps these
// content checks independent of a clone made without it.
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }); // spawn-env: inherits (read-only git query on this checkout)
const ignored = (file) => git('check-ignore', '-q', '--no-index', file).status === 0;
const found = fs.readdirSync('.claude/skills').filter((name) => name.startsWith('ak-')).sort();
const path = (host, name) => `${host}/${name}/SKILL.md`;

test('every ak- skill folder has a contract and every contract has a skill', () => {
  assert.deepEqual(found, Object.keys(CONTRACTS).sort(),
    'add a CONTRACTS entry for a new skill, or write the skill for a contract');
});

test('each skill has matching frontmatter, a trigger description and a bounded size', () => {
  for (const name of Object.keys(CONTRACTS)) {
    const text = readText(path(HOSTS[0], name));
    const head = text.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    assert.ok(head, `${name}: frontmatter must be name then description`);
    assert.equal(head[1], name);
    assert.ok(head[2].length >= 40, `${name}: description says what it does and when to use it`);
    // A plain YAML scalar ends at " #" (a comment) and cannot hold ": ", so a host's YAML
    // parser would truncate or reject the description.
    assert.doesNotMatch(head[2], / #|: /, `${name}: description must be a valid plain YAML scalar`);
    assert.doesNotMatch(head[2], /^["'>|\[{&*!%@`]/, `${name}: description must not start with a YAML indicator`);
    for (const trigger of CONTRACTS[name].triggers) assert.match(head[2], trigger, `${name}: description trigger`);
    assert.ok(text.split('\n').length < 500, `${name}: under 500 lines`);
  }
});

test('Claude and Codex get identical skills', () => {
  assert.deepEqual(mirrorSkills({ check: true }), { changed: [], problems: [] });
  for (const name of Object.keys(CONTRACTS)) {
    assert.equal(readText(path(HOSTS[1], name)), readText(path(HOSTS[0], name)), name);
  }
});

test('every script, pnpm script and doc a skill cites exists', () => {
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  for (const name of Object.keys(CONTRACTS)) {
    const text = readText(path(HOSTS[0], name));
    const cited = [...text.matchAll(/\b((?:scripts|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|md))/g)].map((m) => m[1])
      .filter((file) => !/YYYY|\*/.test(file));
    for (const file of cited) assert.ok(fs.existsSync(file), `${name} cites ${file}, which does not exist`);
    for (const m of text.matchAll(/pnpm run ([a-z][a-z0-9:-]*)/g)) {
      assert.ok(m[1] in scripts, `${name} cites pnpm run ${m[1]}, which package.json lacks`);
    }
  }
});

test('each skill carries its gate phrases', () => {
  for (const [name, { gates }] of Object.entries(CONTRACTS)) {
    const text = readText(path(HOSTS[0], name));
    for (const gate of gates) assert.match(text, gate, `${name}: gate ${gate}`);
  }
});

test('every ak- SKILL.md checks out with LF line endings on every platform', () => {
  for (const name of Object.keys(CONTRACTS)) {
    for (const host of HOSTS) {
      const out = git('check-attr', 'eol', '--', path(host, name));
      assert.match(out.stdout, /: eol: lf$/m, `${path(host, name)} must be pinned to LF in .gitattributes`);
    }
  }
});

test('only ak- folders are exempt from the generated-file ignores', () => {
  for (const host of HOSTS) assert.equal(ignored(path(host, 'ak-ship')), false, `${host}/ak-ship must be trackable`);
  for (const file of [
    '.claude/settings.json', '.claude/helpers/statusline.cjs', '.claude/skills/a11y-ally/SKILL.md',
    '.agents/skills/a11y-ally/SKILL.md', '.agents/config.toml', '.claude/skills/ak/SKILL.md',
    '.claude/skills/upstream-status/SKILL.md', '.claude/skills/akship/SKILL.md', '.claude/skills/ak-ship.md',
    // Generated host folders below the root stay ignored, skill folder included.
    'src/lib/.claude/settings.json', 'claude/.claude/skills/ak-ship/SKILL.md', 'tests/.agents/skills/ak-ship/SKILL.md',
  ]) {
    assert.equal(ignored(file), true, `${file} must stay ignored`);
  }
});

// contracts-7: the skill names every report group by its title, so a thread the watcher
// could not check (or a fixed but unreleased one) is never left out of the summary.
test('ak-upstream-status names every report group the watcher can produce', () => {
  const text = readText(path(HOSTS[0], 'ak-upstream-status'));
  const missing = GROUPS.map(([, title]) => title).filter((title) => !text.includes(`"${title}"`));
  assert.deepEqual(missing, []);
});

// #213 and #240 are already registry entries; nothing says they still migrate.
test('tracking issues are named as ours, not as issues to migrate', () => {
  assert.equal(Object.fromEntries(GROUPS).tracking, 'Our tracking issues');
  for (const file of [path(HOSTS[0], 'ak-upstream-status'), path(HOSTS[1], 'ak-upstream-status'), 'docs/upstream-watch.md']) {
    assert.doesNotMatch(readText(file), /to migrate|migrates? here/i, file);
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node scripts/run-tests.mjs focus tests/kit/ak-skills.test.mjs`
Expected: FAIL. The folder list is empty against the contract, and the ignore test fails because `.claude/skills/ak-ship/SKILL.md` is still ignored.

- [ ] **Step 3: Switch the rules to the glob and rename the skill**

In `.gitignore` replace the comment at lines 27-28 and the two exceptions:

```gitignore
# local overrides (.codex/) are ignored. The authored maintainer skills are the exception:
# every ak-* skill folder is tracked for both hosts (docs/maintainer.md, "Maintainer skills").
```

```gitignore
!/.claude/skills/ak-*/
```

```gitignore
!/.agents/skills/ak-*/
```

(each replacing the matching `!/…/upstream-status/` line). In `.gitattributes` replace lines 11-14 with:

```gitattributes
# Host skill loaders (Claude Code, Codex) parse these skills' YAML frontmatter
# at runtime: a Windows checkout must hand them the same LF text CI tests.
.claude/skills/ak-*/** text eol=lf
.agents/skills/ak-*/** text eol=lf
```

Then rename and fix the frontmatter name:

```bash
git mv .claude/skills/upstream-status .claude/skills/ak-upstream-status
git mv .agents/skills/upstream-status .agents/skills/ak-upstream-status
sed -i '' 's/^name: upstream-status$/name: ak-upstream-status/' .claude/skills/ak-upstream-status/SKILL.md
node scripts/skills-mirror.mjs
```

In `tests/kit/upstream-watch-workflow.test.mjs:91` replace both skill paths with `.claude/skills/ak-upstream-status/SKILL.md` and `.agents/skills/ak-upstream-status/SKILL.md`.

The ignore test also names `ak-ship`, which does not exist yet. That check asks git about a path, so it passes without the file.

- [ ] **Step 4: Run it to see it pass**

Run: `node scripts/run-tests.mjs focus tests/kit/ak-skills.test.mjs tests/kit/skills-mirror.test.mjs tests/kit/upstream-watch-workflow.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .gitignore .gitattributes .claude/skills .agents/skills tests/kit
git commit -m "refactor(skills): track authored skills by ak- prefix and rename upstream-status"
```

Run `git status --short` first and confirm nothing generated is staged.

---

### Task 3: `ak-ship` (the reference skill)

**Files:**

- Create: `.claude/skills/ak-ship/SKILL.md`, `.agents/skills/ak-ship/SKILL.md` (by the mirror script)
- Modify: `tests/kit/ak-skills.test.mjs` (the `CONTRACTS` object)

**Interfaces:**

- Consumes: `CONTRACTS`, `mirrorSkills`.
- Produces: the section layout every later skill copies: `# Title`, `## When to use`, `## Preflight`, `## Steps`, `## Gates`, `## Done`.

- [ ] **Step 1: Add the contract (fails until the skill exists)**

```js
  'ak-ship': {
    triggers: [/"ship" with a PR number/i, /squash-merge/i],
    gates: [/only the (pull requests|PRs) the maintainer named/i, /one (removal|deletion) per call/i,
      /ask which PR/i, /never merge/i, /minimumReleaseAge/],
  },
```

Run: `node scripts/run-tests.mjs focus tests/kit/ak-skills.test.mjs`. Expected: FAIL (the contract has no skill).

- [ ] **Step 2: Write the skill**

````markdown
---
name: ak-ship
description: Take an open agentic-kit pull request from "CI running" to a clean main - watch CI, fix red jobs, squash-merge, delete the backing branch and worktree, pull main, list stale branches. Use when the maintainer says "ship" with a PR number, "squash-merge it", "do the merge dance", or "get that PR progressed".
---

# Ship a pull request

## When to use

The maintainer names one or more open pull requests and wants them merged and cleaned up. If they
say "ship" without a number, ask which PR; never pick one.

## Preflight

1. `gh pr view <N> --json state,isDraft,mergeable,statusCheckRollup,headRefName,baseRefName`.
   Stop if it is not open or not based on `main`.
2. `git worktree list` and `git branch --show-current`. Note any worktree whose branch is the PR's
   head, and note any worktree owned by another session. Never switch branches in a checkout you
   did not create.
3. With several PRs, say the merge order and why (dependencies, shared files) before acting.

## Steps

1. Watch CI: `gh pr checks <N> --watch`. When a job is red, read its log (`gh run view <id>
   --log-failed`) and fix the cause on the PR branch with a test first. A failure that started
   within seconds across every dependency job is the `minimumReleaseAge` policy, not breakage:
   report it and wait.
2. When every required check is green, ask for the merge. After a yes: `gh pr merge <N> --squash`.
   Do not pass `--admin` unless the maintainer names it.
3. Clean up, one removal per call, each verified first:
   - the remote branch is gone: `git ls-remote --heads origin <head>`;
   - the local worktree: `git worktree list`, then `git worktree remove <literal absolute path>`;
   - the local branch: `git branch -d <head>` (use `-D` only when the maintainer says the squash
     is why it looks unmerged).
4. In the main checkout only if it is yours and clean: `git switch main && git pull --ff-only`.
5. Report stale branches (`git branch -vv` marked `gone`) and offer to list them. Do not delete
   them in bulk.

## Gates

- Merge only the pull requests the maintainer named. Never merge a PR that is draft, red or
  behind on required checks.
- One removal per call: list the literal target, check it, remove it, repeat. No blanket `rm`,
  no `git branch -D` loops, no paths directly under `~` or `/`.
- Never merge a release or dependency-consolidation PR without a fresh yes for that PR.
- Never force-push, rewrite history or skip hooks.

## Done

The PR shows `MERGED`, the remote and local branch and the worktree are gone (verified, not
assumed), `main` matches `origin/main`, and the report names anything left behind.
````

- [ ] **Step 3: Mirror and run the tests**

```bash
node scripts/skills-mirror.mjs
node scripts/run-tests.mjs focus tests/kit/ak-skills.test.mjs tests/kit/skills-mirror.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Dry run (read-only)**

On this repository run the Preflight commands against any merged PR (for example `gh pr view 440 --json state,headRefName`) and confirm each command exists and returns what the skill expects. Record the result in the pull request.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/ak-ship .agents/skills/ak-ship tests/kit/ak-skills.test.mjs
git commit -m "feat(skills): add ak-ship"
```

---

### Tasks 4 to 10: the remaining skills

Each task repeats Task 3's five steps: add the contract (red), write the skill in the Task 3 layout, run the mirror and the tests (green), dry-run one read-only command per skill, commit as `feat(skills): add <name>`. The content below is the specification; the commands named are the only ones the skill may cite, and every one must exist (the contract test checks paths and `pnpm run` names).

#### Task 4: `ak-release`

- **Read first:** `docs/maintainer.md` sections 6 and 7, `scripts/release-dist-tag.mjs`, `.github/workflows/release.yml`.
- **Contract:** triggers `/release next/i`, `/semantic (release|version)/i`; gates `/separate approval/i` (tag push, publish and npm check each need a yes), `/never .*(--force|--no-verify)/i`, `/ask whether .*(alpha|beta)/i`, `/npm i -g/`.
- **Steps to cover:** choose the version and dist-tag with `scripts/release-dist-tag.mjs`; bump `package.json`; release commit and annotated tag as in section 7; watch the workflow with `gh run watch`; check the dist-tag and tarball (`npm view @pacphi/agentic-kit dist-tags`; allow about eight minutes for the tarball to appear and say that a 404 inside that window is lag); confirm the GitHub Release; close the epic and its items in the GitHub Project; remind that the global `ak` is the published copy (`npm i -g`, then `ak sync`).

#### Task 5: `ak-upstream-file`

- **Read first:** `docs/upstream-watch.md`, `.claude/skills/ak-upstream-status/SKILL.md`, the memory note "Upstream issue standard".
- **Contract:** triggers `/file upstream/i`, `/upstream issue/i`; gates `/never post .*without/i`, `/redact/i`, `/search .*existing/i`, `/maintainer says .?post/i` (the one-word approval).
- **YAML rule for every skill description:** no space followed by a hash and no colon followed by a space inside it (the contract test enforces this).
- **Steps to cover:** search the upstream repository for an existing thread (`gh search issues`, `gh issue list --repo`) and supplement an open one; reproduce the failure and keep the repro script; draft with problem, system info, repro, proposed fixes, impact for the upstream's users, friendly tone; strip local paths, emails and tokens; show the draft; post only after the maintainer says `post`; add the new thread to the upstream registry through `scripts/upstream-watch.mjs` guidance in `ak-upstream-status`.

#### Task 6: `ak-verify`

- **Read first:** `AGENTS.md` "Testing", `docs/maintainer.md` section 4.
- **Contract:** triggers `/^.*\bverify\b/i`, `/completion gate/i`; gates (regexes) `/never plain .node --test./i`, `/never .pnpm. inside a worktree/i`, `/FORCE_COLOR/`, `/AQE_EMBEDDER_/`, `/XDG_/`, `/\$TMPDIR/`, `/test:ui/`.
- **Steps to cover:** read the environment and unset `FORCE_COLOR`, `AQE_EMBEDDER_*` and relative `XDG_*`; focused test through `node scripts/run-tests.mjs focus <files>`; then `pnpm run typecheck`, `pnpm run lint`, `pnpm run lint:md`, `pnpm run build` (in a worktree use `node_modules/.bin` binaries); `node scripts/docs-layout.mjs` if it takes arguments-free input (confirm with `--help` before citing); dashboard changes add `pnpm run test:ui` and a screenshot; a disposable `HOME` needs `XDG_*` unset and its paths asserted before any `ak` write; never sweep `$TMPDIR`; list skipped checks plainly.

#### Task 7: `ak-resume`

- **Read first:** the newest file in `.superpowers/handoff/` (gitignored, local), `docs/plans/README.md`.
- **Contract:** triggers `/\bresume\b/i`, `/where are we/i`; gates `/read-only/i`, `/decisions? only the maintainer/i`, `/handoff/`.
- **Steps to cover:** read the newest handoff plus `git log --oneline -15`, `git worktree list` and open PRs; answer as done, left, decisions only the maintainer can make, orphaned worktrees or branches; at session end write the next handoff file under `.superpowers/handoff/YYYY-MM-DD-<topic>-handoff.md`; never edit anything else.

#### Task 8: `ak-pricing-refresh`

- **Read first:** `docs/models.md`, the memory notes on the 2026-09-23 and 2026-09-29 refreshes, then find the pricing data file with `grep -rn PRICES_AS_OF src`.
- **Contract:** triggers `/refresh pricing/i`, `/model pricing/i`; gates `/cite a source/i`, `/PRICES_AS_OF/`, `/cache.read/i`, `/never open a (PR|pull request) without/i`.
- **Steps to cover:** web research for new OpenAI and Anthropic releases and price changes; update the data file; bump `PRICES_AS_OF` only when prices were re-verified; keep cache-read prices under their own key; update defaults only on the maintainer's decision; report what changed with sources; focused tests then `ak-verify`.

#### Task 9: `ak-docs-gate`

- **Read first:** `docs/README.md`, `docs/plans/README.md`, `scripts/docs-layout.mjs`, `scripts/docs-relocate.mjs`.
- **Contract:** triggers `/docs gate/i`, `/docs (alignment|check)/i`; gates `/never move an ADR/i`, `/never create a folder under .docs\//i`, `/lower.case/i`, `/docs-relocate/`.
- **Steps to cover:** the layout rules in `AGENTS.md`; `node scripts/run-tests.mjs focus tests/kit/docs-layout.test.mjs`; finished plans move with `node scripts/docs-relocate.mjs` plus one `docs/archive/README.md` row each; living guides carry current state only (history stays in ADRs); a code change is not complete until the docs it touches are aligned.

#### Task 10: `ak-worktree-sweep`

- **Read first:** the memory notes "One removal per call" and "Test temp cleanup only after a complete run".
- **Contract:** triggers `/\bsweep\b/i`, `/worktree sprawl/i`; gates `/one removal per call/i`, `/literal absolute path/i`, `/never .*directly under (`~`|~)/i`, `/hand .* one command/i`, `/another session/i`.
- **Steps to cover:** `git worktree list`, `git branch -vv`, and the sibling folders `ls -d ../agentic-kit*`; classify each as merged, abandoned or live (a worktree with uncommitted changes, an unpushed branch or a recent reflog entry from another session is live); propose removals as a table; remove only what the maintainer approves, one per call after re-checking the target; for a bulk cleanup give the maintainer one command with literal paths and `\` continuations; never touch the checkout another session is using.

---

### Task 11: Docs and the integration check

**Files:**

- Modify: `docs/maintainer.md:199-202` and a new section "Maintainer skills" after section 3, `docs/upstream-watch.md:210,257`, `AGENTS.md` ("Available Skills")

**Interfaces:**

- Consumes: the nine skill names and triggers from the spec's inventory table.

- [ ] **Step 1: Write the docs**

In `docs/maintainer.md` replace the `upstream-status` sentence at line 201 with: "The one authored exception is the `ak-*` maintainer skills, tracked under `.claude/skills/` and `.agents/skills/`." Add a section "Maintainer skills" with: the convention (`ak-` means authored and tracked; every other skill folder is generated and ignored); a table of the nine skills with their one-word triggers; and how to add one (create `.claude/skills/ak-<name>/SKILL.md`, run `node scripts/skills-mirror.mjs`, add a contract to `tests/kit/ak-skills.test.mjs`). In `docs/upstream-watch.md` lines 210 and 257 change the skill name to `ak-upstream-status`. In `AGENTS.md`, under "Available Skills", add: "Maintainer-only skills for this repository are the `ak-*` skills; see `docs/maintainer.md`, section 'Maintainer skills'."

- [ ] **Step 2: Run the affected tests**

Run: `node scripts/run-tests.mjs focus tests/kit/docs-layout.test.mjs tests/kit/guidance-budget.test.mjs tests/kit/context-audit.test.mjs tests/kit/guidance-targets.test.mjs tests/kit/ak-skills.test.mjs`
Expected: PASS. If a guidance-budget test fails on the `AGENTS.md` line, revert that line, keep the `docs/maintainer.md` section, and note it in the pull request.

- [ ] **Step 3: Commit**

```bash
git add docs/maintainer.md docs/upstream-watch.md AGENTS.md
git commit -m "docs(maintainer): document the ak- maintainer skills"
```

---

### Task 12: Open checks and the completion gate

- [ ] **Step 1: `aqe init` and `ak sync` leave `ak-*` folders alone.** In a disposable folder with `HOME` set to it and every `XDG_*` unset (`env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME`), copy the repository's `.claude/skills/ak-ship` in, run `ak sync --dry-run` and `aqe init --help` first, and assert that every path written is under the disposable folder. Only when a dry run shows no deletion of `ak-*` folders, run the real command there. Record the result; if either command removes the folder, stop and report.
- [ ] **Step 2: The tarball excludes the skills.** Run `npm pack --dry-run 2>&1 | grep -E "\.claude|\.agents" || echo none`. Expected: `none`.
- [ ] **Step 3: The suite leaves `.claude/skills` alone.** Run `node scripts/run-tests.mjs unit`. The tripwire fingerprints `.claude`; any change is listed. Expected: pass with the coverage floors.
- [ ] **Step 4: Static checks.** Run `node_modules/.bin/tsc --noEmit`, `node_modules/.bin/eslint scripts/skills-mirror.mjs tests/kit/ak-skills.test.mjs tests/kit/skills-mirror.test.mjs`, and `node_modules/.bin/markdownlint .claude/skills/ak-*/SKILL.md docs/maintainer.md docs/upstream-watch.md docs/plans/2026-10-03-ak-maintainer-skills.md docs/plans/2026-10-03-ak-maintainer-skills-design.md`. Expected: no findings. Use `scripts/run-tests.mjs exec -- ...` for any command that writes.
- [ ] **Step 5: Overlap with the other session.** Run `git fetch origin` then `git diff --name-only main...<branch>` for each branch listed by `git worktree list` and by the maintainer, and compare with this branch's files. Report any shared file before rebasing.
- [ ] **Step 6: Rebase and stop.** `git rebase origin/main` (fix conflicts only in files this branch owns), rerun Step 3, then stop and ask the maintainer before the first push. After a yes: push, open the pull request with the dry-run results from Tasks 3 to 10, and watch CI. Never merge. Move this plan and the design to `docs/archive/` in the same pull request with `node scripts/docs-relocate.mjs`, and add one row each to `docs/archive/README.md`.
