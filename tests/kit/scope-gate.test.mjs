import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkWrite, clearViolations, droppedViolations, isInside, MAX_VIOLATIONS, OutOfScopeWrite,
  violations, withWriteScope,
} from '../../src/lib/scope-gate.mjs';
import { cacheDir } from '../../src/lib/cache-dir.mjs';
import { rmrf, sandboxHome } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const home = sandboxHome('scope-gate');
after(() => rmrf(home));
beforeEach(() => clearViolations());

test('a write inside the scope root is not reported', (t) => {
  const root = tempDir('scope-root', t);
  withWriteScope({ root }, () => checkWrite(path.join(root, 'a', 'b.txt'), 'write'));
  assert.deepEqual(violations(), []);
});

test('a write inside the cache is not reported even with no scope set', () => {
  checkWrite(path.join(cacheDir(), 'x.json'), 'write');
  assert.deepEqual(violations(), []);
});

test('a write outside the root and the cache is reported with its details', (t) => {
  const root = tempDir('scope-root', t);
  const outside = tempDir('scope-outside', t);
  const target = path.join(outside, 'settings.json');
  withWriteScope({ root }, () => checkWrite(target, 'write'));
  assert.equal(violations().length, 1);
  const [only] = violations();
  assert.equal(only.kind, 'OutOfScopeWrite');
  assert.equal(only.target, target);
  assert.equal(only.op, 'write');
  assert.equal(only.scopeRoot, root);
});

test('with no scope set every write outside the cache is reported', (t) => {
  const outside = tempDir('scope-outside', t);
  checkWrite(path.join(outside, 'a.txt'), 'write');
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].scopeRoot, null);
});

test('a dot-dot segment cannot carry a write out of the root unseen', (t) => {
  const root = tempDir('scope-root', t);
  withWriteScope({ root }, () => checkWrite(path.join(root, '..', 'escape.txt'), 'write'));
  assert.equal(violations().length, 1);
});

test('a symlink inside the root that points outside is reported', { skip: process.platform === 'win32' }, (t) => {
  const root = tempDir('scope-root', t);
  const outside = tempDir('scope-outside', t);
  fs.symlinkSync(outside, path.join(root, 'link'));
  withWriteScope({ root }, () => checkWrite(path.join(root, 'link', 'file.txt'), 'write'));
  assert.equal(violations().length, 1);
});

test('a symlinked scope root accepts writes through the link and through the real path', { skip: process.platform === 'win32' }, (t) => {
  const real = tempDir('scope-real', t);
  const link = path.join(tempDir('scope-links', t), 'project');
  fs.symlinkSync(real, link);
  withWriteScope({ root: link }, () => {
    checkWrite(path.join(link, 'a.txt'), 'write');
    checkWrite(path.join(real, 'b.txt'), 'write');
  });
  assert.deepEqual(violations(), []);
});

test('a relative file path is resolved against the working directory and reported absolutely', (t) => {
  const outside = tempDir('scope-outside', t);
  const target = path.join(outside, 'rel.txt');
  checkWrite(path.relative(process.cwd(), target), 'write');
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].target, target);
});

test('isInside accepts the folder itself and a trailing separator', () => {
  const dir = path.resolve('/a/proj');
  assert.equal(isInside(dir, dir), true);
  assert.equal(isInside(`${dir}${path.sep}`, path.join(dir, 'f')), true);
});

test('isInside rejects a sibling that shares a name prefix', () => {
  assert.equal(isInside(path.resolve('/a/proj'), path.resolve('/a/proj-two/f')), false);
});

test('isInside folds case only when asked', () => {
  assert.equal(isInside(path.resolve('/Proj'), path.resolve('/proj/a.txt'), { foldCase: true }), true);
});

test('isInside is exact on a case-sensitive platform', { skip: process.platform !== 'linux' }, () => {
  assert.equal(isInside(path.resolve('/Proj'), path.resolve('/proj/a.txt'), { foldCase: false }), false);
});

test('the scope holds across an await', async (t) => {
  const root = tempDir('scope-root', t);
  await withWriteScope({ root }, async () => {
    await Promise.resolve();
    checkWrite(path.join(root, 'late.txt'), 'write');
  });
  assert.deepEqual(violations(), []);
});

test('a path that cannot be probed is dropped instead of thrown', () => {
  assert.doesNotThrow(() => checkWrite('bad\0path', 'write'));
  assert.deepEqual(violations(), []);
});

test('the enforce mode records the violation and throws OutOfScopeWrite', (t) => {
  const outside = tempDir('scope-outside', t);
  assert.throws(() => checkWrite(path.join(outside, 'a.txt'), 'write', { mode: 'enforce' }), OutOfScopeWrite);
  assert.equal(violations().length, 1);
});

test('the list stops at its cap and counts what it dropped', (t) => {
  const outside = tempDir('scope-outside', t);
  for (let index = 0; index < MAX_VIOLATIONS + 5; index += 1) {
    checkWrite(path.join(outside, `f${index}.txt`), 'write');
  }
  assert.equal(violations().length, MAX_VIOLATIONS);
  assert.equal(droppedViolations(), 5);
});

test('clearViolations empties the list and the dropped count', (t) => {
  const outside = tempDir('scope-outside', t);
  checkWrite(path.join(outside, 'a.txt'), 'write');
  clearViolations();
  assert.deepEqual(violations(), []);
  assert.equal(droppedViolations(), 0);
});
