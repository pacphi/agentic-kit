// ADR-0048 discovery preview — MNT-DSC-002/003/007/008, repository identity
// (linked worktree vs. nested repo vs. submodule), and the bounded TTL cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPreviewCache, previewExclusion, previewSource,
} from '../../src/lib/maintenance/discovery/preview.mjs';
import { isOpaqueId } from '../../src/lib/maintenance/management/model.mjs';

const INSTALLATION_KEY = 'test-installation-key-0123456789abcdef';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-discovery-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitDir(root) { fs.mkdirSync(path.join(root, '.git'), { recursive: true }); }
function gitFile(root, gitdirLine) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitdirLine}\n`);
}

test('MNT-DSC-002/003: previewSource finds standalone and nested repositories with breadcrumbs', (t) => {
  const root = fixture(t);
  gitDir(path.join(root, 'alpha'));
  gitDir(path.join(root, 'alpha', 'vendor-with-its-own-repo'));
  fs.mkdirSync(path.join(root, 'plain-folder'), { recursive: true });

  const preview = previewSource({ kind: 'collection-root', root, installationKey: INSTALLATION_KEY });
  assert.equal(preview.valid, true);
  assert.ok(isOpaqueId(preview.previewId, 'prv'));
  const breadcrumbs = preview.projectsFound.map((p) => p.breadcrumb.join('/')).sort();
  assert.deepEqual(breadcrumbs, ['alpha', 'alpha/vendor-with-its-own-repo']);
  assert.ok(preview.projectsFound.every((p) => isOpaqueId(p.projectId, 'prj')));
});

test('repository identity: a linked worktree is recorded as a worktree; a submodule is not a project', (t) => {
  const root = fixture(t);
  gitDir(path.join(root, 'main-repo'));
  gitFile(path.join(root, 'worktree-checkout'), path.join(root, 'main-repo', '.git', 'worktrees', 'feature'));
  fs.mkdirSync(path.join(root, 'main-repo', 'libs', 'sub'), { recursive: true });
  gitFile(path.join(root, 'main-repo', 'libs', 'sub'), path.join(root, 'main-repo', '.git', 'modules', 'sub'));

  const preview = previewSource({ kind: 'collection-root', root, installationKey: INSTALLATION_KEY });
  const byBreadcrumb = Object.fromEntries(preview.projectsFound.map((p) => [p.breadcrumb.join('/'), p]));
  assert.ok(byBreadcrumb['main-repo']);
  assert.ok(byBreadcrumb['worktree-checkout']?.worktree);
  assert.ok(!('main-repo/libs/sub' in byBreadcrumb), 'an initialized submodule is not its own project by default');
});

test('MNT-DSC-007: a symlinked directory is never traversed, and its skip is counted', (t) => {
  const root = fixture(t);
  const real = path.join(root, 'real-project');
  gitDir(real);
  fs.symlinkSync(real, path.join(root, 'linked'), 'dir');

  const preview = previewSource({ kind: 'collection-root', root, installationKey: INSTALLATION_KEY });
  const breadcrumbs = preview.projectsFound.map((p) => p.breadcrumb.join('/'));
  assert.deepEqual(breadcrumbs, ['real-project']);
  assert.ok(preview.symlinksSkipped >= 1);
});

test('curated skip directories are excluded from project detection', (t) => {
  const root = fixture(t);
  gitDir(path.join(root, 'node_modules', 'some-package'));
  gitDir(path.join(root, 'real'));
  const preview = previewSource({ kind: 'collection-root', root, installationKey: INSTALLATION_KEY });
  assert.deepEqual(preview.projectsFound.map((p) => p.breadcrumb.join('/')), ['real']);
});

test('a configured recursive exclusion removes the covered subtree from the preview', (t) => {
  const root = fixture(t);
  gitDir(path.join(root, 'keep'));
  gitDir(path.join(root, 'skip-me', 'nested'));
  const preview = previewSource({
    kind: 'collection-root', root, installationKey: INSTALLATION_KEY,
    configuration: { exclusions: [{ path: path.join(root, 'skip-me'), recursive: true }] },
  });
  assert.deepEqual(preview.projectsFound.map((p) => p.breadcrumb.join('/')), ['keep']);
  assert.equal(preview.exclusions.recursive.length, 1);
});

test('MNT-DSC-008: previewSource reports a boundary without refusing to preview it', (t) => {
  const root = fixture(t);
  const cloudRoot = path.join(root, 'Dropbox', 'work');
  fs.mkdirSync(cloudRoot, { recursive: true });
  const preview = previewSource({ kind: 'exact-project', root: cloudRoot, installationKey: INSTALLATION_KEY });
  assert.equal(preview.valid, true);
  assert.equal(preview.boundary, 'cloud-placeholder');
  assert.deepEqual(preview.boundaries, ['cloud-placeholder']);
});

test('an invalid root produces an advisory, non-throwing preview', (t) => {
  const root = fixture(t);
  const missing = path.join(root, 'does-not-exist');
  const preview = previewSource({ kind: 'exact-project', root: missing, installationKey: INSTALLATION_KEY });
  assert.equal(preview.valid, false);
  assert.deepEqual(preview.projectsFound, []);
  assert.equal(preview.estimate, null);
});

test('the preview estimate states when the bounded walk did not finish', (t) => {
  const root = fixture(t);
  for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(root, `file-${i}.txt`), 'x');
  const preview = previewSource({
    kind: 'collection-root', root, installationKey: INSTALLATION_KEY, ceilings: { maxDepth: 8, maxEntries: 5 },
  });
  assert.equal(preview.estimate, null);
  assert.match(preview.estimateReason, /incomplete/);
});

test('previewExclusion lists affected projects only for a recursive exclusion', (t) => {
  const root = fixture(t);
  gitDir(path.join(root, 'nested-a'));
  gitDir(path.join(root, 'nested-b'));
  const recursive = previewExclusion({ path: root, recursive: true, installationKey: INSTALLATION_KEY });
  assert.equal(recursive.affectedProjects.length, 2);
  assert.ok(isOpaqueId(recursive.exclusionId, 'exc'));

  const exact = previewExclusion({ path: root, recursive: false, installationKey: INSTALLATION_KEY });
  assert.deepEqual(exact.affectedProjects, []);
});

test('createPreviewCache remembers a preview until its TTL elapses', () => {
  let now = 1_000;
  const cache = createPreviewCache({ now: () => now, ttlMs: 100 });
  const preview = { previewId: 'prv_x', valid: true };
  cache.remember(preview);
  assert.equal(cache.get('prv_x'), preview);
  now += 101;
  assert.equal(cache.get('prv_x'), null);
});
