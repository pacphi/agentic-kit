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
  'ak-ship': {
    triggers: [/"ship" with a PR number/i, /squash-merge/i],
    gates: [/only the (pull requests|PRs) the maintainer named/i, /one (removal|deletion) per call/i,
      /ask which PR/i, /never merge/i, /minimumReleaseAge/, /--match-head-commit/, /--required/,
      /explicit yes before (any|each) deletion/i, /status --porcelain/, /never `--force`/i,
      /worktree this session created/i, /every merge needs a yes/i],
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
    assert.doesNotMatch(head[2], /^["'>|[{&*!%@`]/, `${name}: description must not start with a YAML indicator`);
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
