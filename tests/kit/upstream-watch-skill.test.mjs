// The upstream-status maintainer skill: one text for Claude (.claude/skills)
// and Codex (.agents/skills), tracked through the narrowest .gitignore
// exceptions while every generated file beside it stays ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SKILLS = ['.claude/skills/upstream-status/SKILL.md', '.agents/skills/upstream-status/SKILL.md'];
const ignored = (file) => spawnSync('git', ['check-ignore', '-q', '--no-index', file]).status === 0;

test('Claude and Codex get the same upstream-status skill', () => {
  const [claude, codex] = SKILLS.map((file) => fs.readFileSync(file, 'utf8'));
  assert.equal(codex, claude);
  assert.match(claude, /^---\nname: upstream-status\ndescription: .+\n---\n/);
  assert.match(claude, /node scripts\/upstream-watch\.mjs report --json/);
  assert.match(claude, /explicit-user-approval-required/);
  assert.match(claude, /never (post|push|merge)/i);
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
