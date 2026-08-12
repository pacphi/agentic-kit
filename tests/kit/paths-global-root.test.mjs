// The spawn-free half of `globalRoot()`. It only runs when `npm` is
// unreachable — which is what every sandboxed test does by design
// (helpers/home-sandbox.mjs points PATH at a directory that does not exist),
// so this walk is on the hot path for the suite itself, not just for exotic
// machines.
//
// Following the convention in footprint-windows.test.mjs: the win32 layouts
// run the REAL win32 code path through an injected `path` implementation, so
// separator handling is verified from any host rather than asserted in
// whichever flavour the runner happens to use. Expected values are composed
// with the same implementation under test — comparing against a hand-written
// '/usr/lib/node_modules' literal is what made the first revision pass on
// POSIX and fail on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalRootCandidates, resolveGlobalRoot } from '../../src/lib/paths.mjs';

const posix = path.posix;
const win32 = path.win32;

const HOMEBREW_EXEC = '/opt/homebrew/Cellar/node/26.4.0/bin/node';
const LINUXBREW_EXEC = '/home/linuxbrew/.linuxbrew/Cellar/node/24.8.0/bin/node';
const POSIX_EXEC = '/usr/bin/node';
const NVM_EXEC = '/home/dev/.nvm/versions/node/v22.14.0/bin/node';
const WIN_EXEC = 'C:\\Users\\dev\\scoop\\apps\\nodejs\\24.8.0\\node.exe';

test('a versioned (kegged) layout offers the linked prefix, not just the keg', () => {
  const candidates = globalRootCandidates(HOMEBREW_EXEC, {}, posix);
  // The regression: only the two keg-local paths used to be tried, and neither
  // exists on a Homebrew install, so globalRoot() threw "is npm installed?"
  // on a machine where npm was installed all along.
  const linked = posix.join('/opt/homebrew', 'lib', 'node_modules');
  const keg = posix.join('/opt/homebrew/Cellar/node/26.4.0', 'lib', 'node_modules');
  assert.ok(candidates.includes(linked), `linked prefix missing: ${candidates.join(', ')}`);
  assert.ok(candidates.indexOf(keg) < candidates.indexOf(linked),
    'nearest-first ordering must still prefer the keg-local tree when it exists');
});

test('the ascent reaches a linuxbrew prefix', () => {
  const candidates = globalRootCandidates(LINUXBREW_EXEC, {}, posix);
  assert.ok(candidates.includes(posix.join('/home/linuxbrew/.linuxbrew', 'lib', 'node_modules')));
});

test('the plain POSIX layout is still the first candidate', () => {
  assert.equal(globalRootCandidates(POSIX_EXEC, {}, posix)[0],
    posix.join('/usr', 'lib', 'node_modules'));
});

test('the filesystem root is never probed — `/lib/node_modules` belongs to no install', () => {
  // /usr/bin/node ascends into `/` within the bound, so this is the shallow
  // case that proves the skip rather than passing vacuously on a deep path.
  const candidates = globalRootCandidates(POSIX_EXEC, {}, posix);
  assert.ok(!candidates.includes(posix.join('/', 'lib', 'node_modules')),
    `root probed: ${candidates.join(', ')}`);
});

test('a version-manager layout resolves to its own prefix', () => {
  assert.equal(globalRootCandidates(NVM_EXEC, {}, posix)[0],
    posix.join('/home/dev/.nvm/versions/node/v22.14.0', 'lib', 'node_modules'));
});

test("npm's own prefix override wins over any execPath derivation", () => {
  const candidates = globalRootCandidates(HOMEBREW_EXEC, { npm_config_prefix: '/custom/prefix' }, posix);
  assert.equal(candidates[0], posix.join('/custom/prefix', 'lib', 'node_modules'));
  assert.ok(candidates.indexOf(posix.join('/custom/prefix', 'lib', 'node_modules'))
    < candidates.indexOf(posix.join('/opt/homebrew', 'lib', 'node_modules')));
});

// ── win32, exercised from any host ───────────────────────────────────────────

test('win32: candidates are emitted with backslash separators', () => {
  const candidates = globalRootCandidates(WIN_EXEC, {}, win32);
  assert.ok(candidates.every((c) => !c.includes('/')), `forward slash leaked: ${candidates.join(', ')}`);
  assert.ok(candidates.includes(win32.join('C:\\Users\\dev\\scoop\\apps\\nodejs', 'lib', 'node_modules')));
});

test('win32: the sibling layout (npm/nodejs ship node_modules beside node.exe) is a candidate', () => {
  const candidates = globalRootCandidates('C:\\Program Files\\nodejs\\node.exe', {}, win32);
  assert.equal(candidates.at(-1), win32.join('C:\\Program Files\\nodejs', 'node_modules'));
});

test('win32: a drive root is never probed', () => {
  const candidates = globalRootCandidates('C:\\node.exe', {}, win32);
  assert.ok(!candidates.includes(win32.join('C:\\', 'lib', 'node_modules')),
    `drive root probed: ${candidates.join(', ')}`);
});

// ── against a real fixture tree, on whatever host is running ─────────────────

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
