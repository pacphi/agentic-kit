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
