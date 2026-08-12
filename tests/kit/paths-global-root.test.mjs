import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalRootCandidates, resolveGlobalRoot } from '../../src/lib/paths.mjs';

// The spawn-free fallback is only exercised when `npm` is unreachable — which
// is exactly what every sandboxed test does (helpers/home-sandbox.mjs points
// PATH at a directory that does not exist). These fixtures assert the layouts
// it has to cover as data, rather than installing node five different ways.

const HOMEBREW_EXEC = '/opt/homebrew/Cellar/node/26.4.0/bin/node';
const LINUXBREW_EXEC = '/home/linuxbrew/.linuxbrew/Cellar/node/24.8.0/bin/node';
const POSIX_EXEC = '/usr/bin/node';
const NVM_EXEC = '/home/dev/.nvm/versions/node/v22.14.0/bin/node';

test('a versioned (kegged) layout offers the linked prefix, not just the keg', () => {
  const candidates = globalRootCandidates(HOMEBREW_EXEC, {});
  // The regression: only the two keg-local paths used to be tried, and neither
  // exists on a Homebrew install, so globalRoot() threw "is npm installed?"
  // on a machine where npm was installed all along.
  assert.ok(candidates.includes('/opt/homebrew/lib/node_modules'),
    `linked prefix missing from candidates: ${candidates.join(', ')}`);
  assert.ok(candidates.indexOf('/opt/homebrew/Cellar/node/26.4.0/lib/node_modules')
    < candidates.indexOf('/opt/homebrew/lib/node_modules'),
    'nearest-first ordering must still prefer the keg-local tree when it exists');
});

test('the ascent bound reaches a linuxbrew prefix and stops short of the filesystem root', () => {
  const candidates = globalRootCandidates(LINUXBREW_EXEC, {});
  assert.ok(candidates.includes('/home/linuxbrew/.linuxbrew/lib/node_modules'));
  assert.ok(!candidates.includes(path.join(path.sep, 'lib', 'node_modules')),
    'the filesystem root is not a prefix and must never be probed');
});

test('the plain POSIX layout is still the first candidate', () => {
  assert.equal(globalRootCandidates(POSIX_EXEC, {})[0], '/usr/lib/node_modules');
});

test('a version-manager layout resolves to its own prefix', () => {
  const candidates = globalRootCandidates(NVM_EXEC, {});
  assert.equal(candidates[0], '/home/dev/.nvm/versions/node/v22.14.0/lib/node_modules');
});

test("npm's own prefix override wins over any execPath derivation", () => {
  const candidates = globalRootCandidates(HOMEBREW_EXEC, { npm_config_prefix: '/custom/prefix' });
  assert.equal(candidates[0], path.join('/custom/prefix', 'lib', 'node_modules'));
  assert.ok(candidates.indexOf(path.join('/custom/prefix', 'lib', 'node_modules'))
    < candidates.indexOf('/opt/homebrew/lib/node_modules'));
});

// Asserted with a platform-neutral path: the invariant is the sibling tree's
// presence and its last-resort ordering, not win32 path parsing (paths.mjs uses
// the ambient `path`, which is already `path.win32` when running on Windows).
test('the sibling layout (Windows / some managers) remains the last candidate', () => {
  const candidates = globalRootCandidates(POSIX_EXEC, {});
  assert.equal(candidates.at(-1), path.join('/usr/bin', 'node_modules'));
});

test('resolveGlobalRoot finds a kegged prefix on a real fixture tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-global-root-'));
  try {
    // <root>/Cellar/node/26.4.0/bin/node, with the tree only at <root>/lib.
    const bin = path.join(root, 'Cellar', 'node', '26.4.0', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(root, 'lib', 'node_modules'), { recursive: true });
    // path.resolve, not realpath: the walk normalizes but never dereferences.
    assert.equal(
      resolveGlobalRoot(path.join(bin, 'node'), {}),
      path.join(root, 'lib', 'node_modules'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGlobalRoot returns null rather than guessing when nothing exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-global-root-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    assert.equal(resolveGlobalRoot(path.join(bin, 'node'), {}, () => false), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
