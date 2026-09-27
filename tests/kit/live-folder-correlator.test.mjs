// Exact-folder correlator for Live sessions outside a Git repository
// (ADR-0012, decision 2 of the #237/#238 audit). A plain folder's public
// project key hashes only its name, so two `scratch` folders share it. The
// correlator tells them apart with a keyed value that never leaves memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFolderCorrelator } from '../../src/lib/live/folder-correlator.mjs';

const sandbox = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-folder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a', 'scratch');
  const b = path.join(dir, 'b', 'scratch');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  return { dir, a, b };
};

test('the same folder correlates, including through a symlinked path', (t) => {
  const { dir, a } = sandbox(t);
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(path.join(dir, 'a'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const folderOf = createFolderCorrelator();
  assert.equal(typeof folderOf(a), 'string');
  assert.equal(folderOf(a), folderOf(`${a}${path.sep}`), 'a trailing separator is the same folder');
  assert.equal(folderOf(path.join(alias, 'scratch')), folderOf(a), 'both sides compare real paths');
});

test('two folders with the same name do not correlate', (t) => {
  const { a, b } = sandbox(t);
  const folderOf = createFolderCorrelator();
  assert.notEqual(folderOf(a), folderOf(b));
});

test('a folder that does not exist, or no folder, never correlates', (t) => {
  const { dir } = sandbox(t);
  const folderOf = createFolderCorrelator();
  assert.equal(folderOf(path.join(dir, 'gone', 'scratch')), null);
  assert.equal(folderOf(''), null);
  assert.equal(folderOf(undefined), null);
});

test('the value is keyed per correlator and reveals neither the path nor its plain hash', (t) => {
  const { a } = sandbox(t);
  const first = createFolderCorrelator()(a);
  const second = createFolderCorrelator()(a);
  assert.notEqual(first, second, 'each correlator has its own secret, so values are not portable');
  const real = fs.realpathSync.native(a);
  for (const exposed of [a, real, path.basename(a)]) assert.ok(!first.includes(exposed));
  for (const plain of [a, real, real.replaceAll('\\', '/')]) {
    assert.notEqual(first, createHash('sha256').update(plain).digest('hex'), 'an unkeyed hash is guessable');
  }
});
