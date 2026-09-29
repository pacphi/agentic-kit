import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SKIPS, destinationProblem, emptiedDirs, isText, parseMap, protectCode, relocate, rewriteMentions, rewriteText,
} from '../../scripts/docs-relocate.mjs';

const rows = parseMap([
  '# comment',
  'docs/superpowers/plans/2026-01-02-x.md\tdocs/archive/2026-01-02-superpowers-plan-x.md',
  'docs/audits/README.md\tdocs/archive/README.md\tredirect',
  'docs/audits/\tdocs/archive/\tredirect',
].join('\n'));
const exists = (entry) => !entry.includes('missing');

test('parses the map and rejects a folder move', () => {
  assert.deepEqual(rows.map((row) => row.mode), ['move', 'redirect', 'redirect']);
  assert.throws(() => parseMap('docs/a/\tdocs/b/'), /folder row can only redirect/);
  assert.throws(() => parseMap('docs/a.md'), /bad map row/);
});

test('relocates exact paths before folder redirects', () => {
  assert.equal(relocate('docs/superpowers/plans/2026-01-02-x.md', rows), 'docs/archive/2026-01-02-superpowers-plan-x.md');
  assert.equal(relocate('docs/audits/other.md', rows), 'docs/archive/other.md');
  assert.equal(relocate('docs/HOOKS.md', rows), 'docs/HOOKS.md');
});

test('rewrites links into moved files and re-bases links out of them', () => {
  const into = rewriteText('See [x](superpowers/plans/2026-01-02-x.md#task-2).', 'docs/HOOKS.md', 'docs/HOOKS.md', rows, exists);
  assert.equal(into.text, 'See [x](archive/2026-01-02-superpowers-plan-x.md#task-2).');
  const out = rewriteText('[ADR](../../adr/0001-a.md) [same](2026-01-02-x.md)', 'docs/superpowers/plans/2026-01-02-x.md', 'docs/archive/2026-01-02-superpowers-plan-x.md', rows, exists);
  assert.equal(out.text, '[ADR](../adr/0001-a.md) [same](2026-01-02-superpowers-plan-x.md)');
});

test('rewrites HTML and repository URLs, but not unrelated URLs', () => {
  assert.equal(rewriteText('<a href="../superpowers/plans/2026-01-02-x.md#t">x</a>', 'docs/assets/m.html', 'docs/assets/m.html', rows, exists).text, '<a href="../archive/2026-01-02-superpowers-plan-x.md#t">x</a>');
  const source = 'https://github.com/pacphi/agentic-kit/blob/main/docs/superpowers/plans/2026-01-02-x.md#a https://example.test/docs/x.md';
  assert.equal(rewriteText(source, 'README.md', 'README.md', rows, exists).text, 'https://github.com/pacphi/agentic-kit/blob/main/docs/archive/2026-01-02-superpowers-plan-x.md#a https://example.test/docs/x.md');
});

test('preserves code, prose references and pre-existing broken links', () => {
  const source = 'Use `[x](superpowers/plans/2026-01-02-x.md)`\n```md\n[x](superpowers/plans/2026-01-02-x.md)\n```\nMoved from docs/superpowers/plans/2026-01-02-x.md. [gone](missing.md)';
  const result = rewriteText(source, 'docs/HOOKS.md', 'docs/HOOKS.md', rows, exists);
  assert.equal(result.text, source);
  assert.deepEqual(result.broken, ['missing.md']);
  const guarded = protectCode(source);
  assert.equal(guarded.restore(guarded.masked), source);
});

test('allows case-only renames and rejects actual destination collisions', () => {
  const tracked = new Set(['docs/MODELS.md', 'docs/models-old.md', 'docs/Other.md', 'docs/other.md']);
  const caseInsensitive = (entry) => [...tracked].some((file) => file.toLowerCase() === entry.toLowerCase());
  assert.equal(destinationProblem({ from: 'docs/MODELS.md', to: 'docs/models.md' }, tracked, caseInsensitive), null);
  assert.match(destinationProblem({ from: 'docs/Other.md', to: 'docs/other.md' }, tracked, caseInsensitive), /clashes/);
  assert.match(destinationProblem({ from: 'docs/gone.md', to: 'docs/x.md' }, tracked, caseInsensitive), /not tracked/);
});

test('rewrites exact mentions, optional same-folder bare names and regex literals only', () => {
  const renames = parseMap('docs/MAINTENANCE.md\tdocs/maintenance.md\nMAINTAINER.md\tdocs/maintainer.md\n');
  const source = "const a = 'docs/MAINTENANCE.md'; /docs\\/MAINTENANCE\\.md/ docs/MAINTENANCE-ACCEPTANCE.md ruflo/docs/MAINTENANCE.md";
  const result = rewriteMentions(source, renames);
  assert.match(result.text, /docs\/maintenance\.md/);
  assert.match(result.text, /docs\\\/maintenance\\\.md/);
  assert.match(result.text, /MAINTENANCE-ACCEPTANCE/);
  assert.match(result.text, /ruflo\/docs\/MAINTENANCE/);
  const sameFolder = parseMap('docs/UPGRADING.md\tdocs/upgrading.md\ndocs/MODEL.md\tdocs/archive/model.md\n');
  assert.equal(rewriteMentions('UPGRADING.md MODEL.md', sameFolder, { bare: true }).text, 'upgrading.md MODEL.md');
});

test('identifies text files, default skips and directories that can empty', () => {
  assert.ok(isText('docker/Dockerfile')); assert.ok(isText('src/a.mjs')); assert.ok(!isText('docs/a.png'));
  assert.deepEqual(DEFAULT_SKIPS, ['docs/archive/', 'scripts/docs-relocate.mjs', 'scripts/docs-layout.mjs', 'tests/kit/docs-relocate.test.mjs', 'tests/kit/docs-layout.test.mjs']);
  assert.deepEqual(emptiedDirs([{ from: 'docs/evidence/context/usage/a.png' }, { from: 'docs/audits/b.md' }]), ['docs/evidence/context/usage', 'docs/evidence/context', 'docs/audits', 'docs/evidence']);
});
