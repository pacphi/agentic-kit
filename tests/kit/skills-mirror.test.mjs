import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import { mirrorSkills, main, AUTHORED_SKILLS } from '../../scripts/skills-mirror.mjs';

const put = (root, rel, text) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// Most cases mirror one listed skill; the real list is exercised on its own below.
const ONE = ['ak-ship'];

test('copies a listed skill to the Codex folder, normalizing CRLF, and a second run changes nothing', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', '---\r\nname: ak-ship\r\n---\r\nbody\r\n');
  put(root, '.claude/skills/ak-ship/notes/extra.md', 'extra\n');
  const first = mirrorSkills({ root, skills: ONE });
  assert.deepEqual(first.changed.sort(), ['.agents/skills/ak-ship/SKILL.md', '.agents/skills/ak-ship/notes/extra.md']);
  assert.deepEqual(first.problems, []);
  assert.equal(read(root, '.agents/skills/ak-ship/SKILL.md'), '---\nname: ak-ship\n---\nbody\n');
  assert.deepEqual(mirrorSkills({ root, skills: ONE }), { changed: [], removed: [], problems: [] });
});

test('--check reports a differing copy and writes nothing', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', 'new\n');
  put(root, '.agents/skills/ak-ship/SKILL.md', 'old\n');
  const result = mirrorSkills({ root, check: true, skills: ONE });
  assert.deepEqual(result.changed, ['.agents/skills/ak-ship/SKILL.md']);
  assert.equal(read(root, '.agents/skills/ak-ship/SKILL.md'), 'old\n');
});

test('a listed skill that exists only for Codex is a problem and is never deleted', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.agents/skills/ak-ship/SKILL.md', 'x\n');
  const result = mirrorSkills({ root, skills: ONE });
  assert.deepEqual(result.problems, ['.agents/skills/ak-ship has no .claude/skills/ak-ship']);
  assert.equal(read(root, '.agents/skills/ak-ship/SKILL.md'), 'x\n');
});

test('a listed skill with no .claude folder is a problem', (t) => {
  const root = tempDir('ak-mirror', t);
  assert.deepEqual(mirrorSkills({ root, skills: ONE }).problems,
    ['.claude/skills/ak-ship is missing; AUTHORED_SKILLS lists it']);
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
});

test('AUTHORED_SKILLS is a frozen list of distinct ak- names', () => {
  assert.ok(Object.isFrozen(AUTHORED_SKILLS));
  assert.ok(AUTHORED_SKILLS.length > 0);
  assert.equal(new Set(AUTHORED_SKILLS).size, AUTHORED_SKILLS.length);
  for (const name of AUTHORED_SKILLS) assert.match(name, /^ak-[a-z0-9]+(?:-[a-z0-9]+)*$/, name);
});

test('by default every name in AUTHORED_SKILLS is mirrored, and each missing one is a problem', (t) => {
  const root = tempDir('ak-mirror', t);
  const missing = mirrorSkills({ root, check: true });
  assert.deepEqual(missing.problems.sort(), AUTHORED_SKILLS.map((name) => `.claude/skills/${name} is missing; AUTHORED_SKILLS lists it`).sort());
  for (const name of AUTHORED_SKILLS) put(root, `.claude/skills/${name}/SKILL.md`, `${name}\n`);
  const result = mirrorSkills({ root });
  assert.deepEqual(result.changed.sort(), AUTHORED_SKILLS.map((name) => `.agents/skills/${name}/SKILL.md`).sort());
  assert.deepEqual(result.problems, []);
  assert.equal(main(['--check'], root), 0);
});

test('generated skills are never mirrored', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/a11y-ally/SKILL.md', 'generated\n');
  put(root, '.claude/skills/ak-ship/SKILL.md', 'a\n');
  assert.deepEqual(mirrorSkills({ root, skills: ONE }).changed, ['.agents/skills/ak-ship/SKILL.md']);
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/a11y-ally')), false);
});

// `ak init` will write ak-ruflo, ak-aqe and the other ak- skills for both hosts as ignored files
// (docs/plans/2026-10-01-project-scope-only-design.md, "On-demand skills"). They share the ak- prefix,
// so the mirror goes by AUTHORED_SKILLS: an unlisted ak- folder is neither copied nor reported.
test('an unlisted ak- skill is never mirrored and never a problem', (t) => {
  const root = tempDir('ak-mirror', t);
  for (const name of AUTHORED_SKILLS) {
    put(root, `.claude/skills/${name}/SKILL.md`, `${name}\n`);
    put(root, `.agents/skills/${name}/SKILL.md`, `${name}\n`);
  }
  put(root, '.claude/skills/ak-extra/SKILL.md', 'generated for Claude\n');
  put(root, '.claude/skills/ak-ruflo/SKILL.md', 'generated for Claude\n');
  put(root, '.agents/skills/ak-ruflo/SKILL.md', 'generated for Codex\n');
  put(root, '.agents/skills/ak-aqe/SKILL.md', 'generated for Codex\n');
  assert.deepEqual(mirrorSkills({ root }), { changed: [], removed: [], problems: [] });
  assert.deepEqual(mirrorSkills({ root, check: true }), { changed: [], removed: [], problems: [] });
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/ak-extra')), false);
  assert.equal(read(root, '.agents/skills/ak-ruflo/SKILL.md'), 'generated for Codex\n');
  assert.equal(main(['--check'], root), 0);
});

test('a skill folder without SKILL.md is a problem', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-empty/notes.md', 'x\n');
  assert.match(mirrorSkills({ root, skills: ['ak-empty'] }).problems.join('\n'), /ak-empty has no SKILL\.md/);
});

test('a stale file inside a mirrored skill is a problem with --check; a write run removes it and reports it as removed', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', 'a\n');
  put(root, '.agents/skills/ak-ship/SKILL.md', 'a\n');
  put(root, '.agents/skills/ak-ship/old.md', 'stale\n');
  const checked = mirrorSkills({ root, check: true, skills: ONE });
  assert.match(checked.problems.join('\n'), /\.agents\/skills\/ak-ship\/old\.md is not in \.claude\/skills\/ak-ship/);
  assert.deepEqual(checked.removed, []);
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/ak-ship/old.md')), true);
  // The write run fixes the drift, so the removal is a change it made, not a problem left behind.
  assert.deepEqual(mirrorSkills({ root, skills: ONE }), { changed: [], removed: ['.agents/skills/ak-ship/old.md'], problems: [] });
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/ak-ship/old.md')), false);
});

test('main exits 0 after a write run removes a stale file, and --check then passes', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', 'a\n');
  put(root, '.agents/skills/ak-ship/SKILL.md', 'a\n');
  put(root, '.agents/skills/ak-ship/old.md', 'stale\n');
  assert.equal(main(['--check'], root, ONE), 1);
  assert.equal(main([], root, ONE), 0);
  assert.equal(main(['--check'], root, ONE), 0);
});

test('main returns 1 for --check drift, 0 once mirrored, and 2 for an unknown flag', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', 'a\n');
  assert.equal(main(['--check'], root, ONE), 1);
  assert.equal(main([], root, ONE), 0);
  assert.equal(main(['--check'], root, ONE), 0);
  assert.equal(main(['--bogus'], root, ONE), 2);
});

test('main returns 1 when a listed skill is missing', (t) => {
  const root = tempDir('ak-mirror', t);
  assert.equal(main([], root, ONE), 1);
  assert.equal(main(['--check'], root, ONE), 1);
});

// `skills-mirror.mjs check` (dashes forgotten) must not quietly run as a write.
test('main rejects a positional argument with the usage message and writes nothing', (t) => {
  const root = tempDir('ak-mirror', t);
  put(root, '.claude/skills/ak-ship/SKILL.md', 'a\n');
  for (const argv of [['check'], ['--check', 'extra'], ['ak-ship']]) assert.equal(main(argv, root, ONE), 2, argv.join(' '));
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
});
