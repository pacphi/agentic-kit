import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureProjectKind } from '../../src/lib/footprint/project-kind.mjs';
import { mapProjects } from '../../src/lib/maintenance/management/projection-projects.mjs';
import { runInventoryQuery } from '../../src/lib/maintenance/management/query.mjs';
import { publicInventoryPage } from '../../src/lib/dashboard/maintenance-api.mjs';
import { SENTINEL_FIXTURES } from '../fixtures/maintenance/management-fixtures.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-project-kind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('readable non-Git folders are distinguished from repositories and nested working folders', (t) => {
  const root = fixture(t);
  assert.equal(measureProjectKind(root), 'folder');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src'));
  assert.equal(measureProjectKind(root), 'git');
  assert.equal(measureProjectKind(path.join(root, 'src')), 'git');
});
test('verified worktree pointers are distinct from submodule Git pointers', (t) => {
  const root = fixture(t), main = path.join(root, 'main'), linked = path.join(root, 'linked');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'linked'), { recursive: true });
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ../main/.git/worktrees/linked\n');
  assert.equal(measureProjectKind(linked), 'worktree');
  fs.mkdirSync(path.join(main, '.git', 'modules', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ../main/.git/modules/sub\n');
  assert.equal(measureProjectKind(linked), 'git');
});
test('missing, unreadable, malformed, and dangling metadata never claim non-Git', (t) => {
  const root = fixture(t);
  assert.equal(measureProjectKind(path.join(root, 'missing')), 'unknown');
  const denied = { lstatSync(p) { if (p === root) return fs.lstatSync(root); throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  assert.equal(measureProjectKind(root, { fsImpl: denied }), 'unknown');
  fs.writeFileSync(path.join(root, '.git'), 'not a Git pointer');
  assert.equal(measureProjectKind(root), 'unknown');
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /nonexistent-ak-test/.git/worktrees/nope');
  assert.equal(measureProjectKind(root), 'unknown');
});
test('legacy false is unknown; new evidence does not change project identity', () => {
  const opts = { installationKey: 'project-kind-test-installation-key' };
  const before = mapProjects({}, { legacyRows: [{ path: '/work/example', isGitRepo: false }], discoveryProjects: [] }, opts).registry.get('/work/example');
  const after = mapProjects({}, { legacyRows: [{ path: '/work/example', projectKind: 'folder' }], discoveryProjects: [] }, opts).registry.get('/work/example');
  assert.equal(before.projectKind, 'unknown');
  assert.equal(after.projectKind, 'folder');
  assert.equal(before.projectId, after.projectId);
});
test('project type filtering and classifications survive the public API', () => {
  const inventory = structuredClone(SENTINEL_FIXTURES.projects());
  const ids = [...new Set(inventory.placements.map((p) => p.projectId).filter(Boolean))];
  const kinds = ['git', 'folder', 'worktree'];
  for (const p of inventory.placements) if (p.projectId) p.projectKind = kinds[ids.indexOf(p.projectId)];
  const page = publicInventoryPage(runInventoryQuery(inventory, { scope: 'project', facets: { projectType: ['folder'] } }));
  assert.ok(page.total > 0);
  for (const row of page.groups.flatMap((g) => g.placements)) {
    assert.equal(row.projectKind, 'folder');
    assert.equal(page.projectKinds[row.projectId], 'folder');
  }
});
test('worktrees from bare repositories use verified common-directory and reverse pointers', (t) => {
  const root = fixture(t), linked = path.join(root, 'linked'), target = path.join(root, 'bare.git', 'worktrees', 'linked');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(linked);
  const marker = path.join(linked, '.git');
  fs.writeFileSync(marker, `gitdir: ${target}\n`);
  fs.writeFileSync(path.join(target, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(target, 'gitdir'), `${marker}\n`);
  assert.equal(measureProjectKind(linked), 'worktree');
});
