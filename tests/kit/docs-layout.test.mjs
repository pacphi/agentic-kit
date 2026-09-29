import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { DOC_FOLDERS, NAME_EXCEPTIONS, ROOT_DOCS, RULE_HEADING, layoutProblems } from '../../scripts/docs-layout.mjs';

const RULE = `${RULE_HEADING}\n\nPlans and specs go to docs/plans/.\n`;
const tree = (entries) => ({ files: Object.keys(entries), read: (file) => entries[file] ?? '' });
const base = { 'CLAUDE.md': RULE, 'AGENTS.md': RULE, 'docs/README.md': '[Hooks](hooks.md)', 'docs/archive/README.md': '[a](2026-01-02-audit-x.md)' };

test('accepts the documented layout', () => {
  assert.deepEqual(layoutProblems(tree({ ...base, 'docs/archive/2026-01-02-audit-x.md': '', 'docs/plans/2026-01-02-y.md': '', 'docs/plans/README.md': '', 'docs/proposals/a/contracts.md': '', 'docs/hooks.md': '', 'README.md': '', 'claude/skill.md': 'use /docs' })), []);
});

test('allows only the named documentation folders', () => {
  assert.deepEqual(Object.keys(DOC_FOLDERS).sort(), ['adr', 'archive', 'assets', 'ddd', 'plans', 'proposals', 'schemas']);
  assert.match(layoutProblems(tree({ ...base, 'docs/superpowers/a.md': '' }))[0], /docs\/superpowers\/ is not a documentation folder/);
});

test('requires flat dated archive names and index rows', () => {
  const problems = layoutProblems(tree({ ...base, 'docs/archive/sub/a.md': '', 'docs/archive/notes.md': '', 'docs/archive/2026-01-03-audit-unindexed.md': '' }));
  assert.equal(problems.length, 3); assert.match(problems[0], /flat/); assert.match(problems[1], /YYYY-MM/); assert.match(problems[2], /add a row/);
});

test('requires dated plan names, valid proposal paths and indexed top-level guides', () => {
  const problems = layoutProblems(tree({ ...base, 'docs/plans/my-plan.md': '', 'docs/proposals/a/b/c.md': '', 'docs/new-guide.md': '' }));
  assert.equal(problems.length, 3);
});

test('requires both instruction-file rules and prevents template leakage', () => {
  assert.deepEqual(layoutProblems(tree({ ...base, 'AGENTS.md': '# kit' })), ['AGENTS.md: missing the "## Documentation layout" section that names docs/plans/']);
  assert.match(layoutProblems(tree({ ...base, 'claude/reference.md': 'write to docs/plans/' }))[0], /shipped guidance names this repository/);
});

test('enforces lower-case markdown names and root documents', () => {
  assert.deepEqual(Object.keys(NAME_EXCEPTIONS).sort(), ['AGENTS.md', 'CLAUDE.md', 'README.md', 'SKILL.md']);
  assert.deepEqual(ROOT_DOCS, ['README.md', 'CLAUDE.md', 'AGENTS.md']);
  const problems = layoutProblems(tree({ ...base, 'docs/MODELS.md': '', 'docker/USER-GUIDE.md': '', 'maintainer.md': '', 'explainer.html': '' }));
  assert.equal(problems.length, 5);
});

test('the tracked tree follows the documentation layout', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(layoutProblems({ files, read: (file) => fs.readFileSync(file, 'utf8') }), []);
});
