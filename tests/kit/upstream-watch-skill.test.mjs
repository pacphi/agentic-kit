// The upstream-status maintainer skill: one text for Claude (.claude/skills)
// and Codex (.agents/skills), tracked through the narrowest .gitignore
// exceptions while every generated file beside it stays ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { GROUPS } from '../../scripts/upstream-watch/classify.mjs';

const SKILLS = ['.claude/skills/upstream-status/SKILL.md', '.agents/skills/upstream-status/SKILL.md'];
// .gitattributes checks both copies out with LF everywhere; reading them as
// LF keeps these content checks independent of a clone made without it.
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const ignored = (file) => spawnSync('git', ['check-ignore', '-q', '--no-index', file]).status === 0; // spawn-env: inherits (read-only git query on this checkout)

test('Claude and Codex get the same upstream-status skill', () => {
  const [claude, codex] = SKILLS.map(readText);
  assert.equal(codex, claude);
  assert.match(claude, /^---\nname: upstream-status\ndescription: .+\n---\n/);
  assert.match(claude, /node scripts\/upstream-watch\.mjs report --json/);
  assert.match(claude, /explicit-user-approval-required/);
  assert.match(claude, /never (post|push|merge)/i);
});

test('both skill copies check out with LF line endings on every platform', () => {
  for (const file of SKILLS) {
    const out = spawnSync('git', ['check-attr', 'eol', '--', file], { encoding: 'utf8' }); // spawn-env: inherits (read-only git query on this checkout)
    assert.match(out.stdout, /: eol: lf$/m, `${file} must be pinned to LF in .gitattributes`);
  }
});

test('only the two skill folders are exempt from the generated-file ignores', () => {
  for (const file of SKILLS) assert.equal(ignored(file), false, `${file} must be trackable`);
  for (const file of [
    '.claude/settings.json', '.claude/helpers/statusline.cjs', '.claude/skills/a11y-ally/SKILL.md',
    '.agents/skills/a11y-ally/SKILL.md', '.agents/config.toml', '.claude/skills/upstream-status-extra/SKILL.md',
    // Generated host folders below the root stay ignored, skill folder included.
    'src/lib/.claude/settings.json', 'claude/.claude/skills/upstream-status/SKILL.md', 'tests/.agents/skills/upstream-status/SKILL.md',
  ]) {
    assert.equal(ignored(file), true, `${file} must stay ignored`);
  }
});

// contracts-7: the skill names every report group by its title, so a thread
// the watcher could not check (or a fixed but unreleased one) is never left
// out of the maintainer's summary.
test('the skill names every report group the watcher can produce', () => {
  const claude = readText(SKILLS[0]);
  const missing = GROUPS.map(([, title]) => title).filter((title) => !claude.includes(`"${title}"`));
  assert.deepEqual(missing, []);
  assert.match(claude, /fetchErrors/, 'an unchecked thread is reported with its error');
});

// #213 and #240 are already registry entries; nothing says they still migrate.
test('tracking issues are named as ours, not as issues to migrate', () => {
  assert.equal(Object.fromEntries(GROUPS).tracking, 'Our tracking issues');
  for (const file of [...SKILLS, 'docs/UPSTREAM-WATCH.md']) {
    assert.doesNotMatch(readText(file), /to migrate|migrates? here/i, file);
  }
});
