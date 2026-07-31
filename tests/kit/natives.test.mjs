// bsq3Root / bsq3IsNative — the resolution + binding check behind the
// natives heal ladder. Uses a synthetic node_modules fixture so the test
// is hermetic (no npm, no network) and runs on the full CI matrix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bsq3Root, bsq3IsNative, selfSpecConflicts, aidefencePresent, securityPresent } from '../../src/lib/natives.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';

function makeFixture({ withBinding }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-natives-'));
  const pkg = path.join(dir, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '12.0.0', main: 'lib/index.js' }));
  fs.writeFileSync(path.join(pkg, 'lib', 'index.js'), 'module.exports = {};\n');
  if (withBinding) {
    fs.mkdirSync(path.join(pkg, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'build', 'Release', 'better_sqlite3.node'), '');
  }
  return { dir, pkg };
}

test('bsq3Root resolves the package root through node resolution', () => {
  const { dir, pkg } = makeFixture({ withBinding: true });
  assert.equal(fs.realpathSync(bsq3Root(dir)), fs.realpathSync(pkg));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bsq3Root returns null when better-sqlite3 is not resolvable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-natives-empty-'));
  assert.equal(bsq3Root(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bsq3IsNative is true when the compiled binding exists', () => {
  const { dir } = makeFixture({ withBinding: true });
  assert.equal(bsq3IsNative(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bsq3IsNative is false for a WASM-fallback install (no binding file)', () => {
  const { dir } = makeFixture({ withBinding: false });
  assert.equal(bsq3IsNative(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bsq3Root finds better-sqlite3 hoisted up the node_modules chain', () => {
  // Real layout: ruflo/node_modules/agentdb resolves better-sqlite3 from the
  // hoisted ruflo/node_modules/better-sqlite3 — walk up, don't only look nested.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-natives-hoist-'));
  const fromDir = path.join(root, 'node_modules', 'agentdb');
  const hoisted = path.join(root, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(fromDir, { recursive: true });
  fs.mkdirSync(hoisted, { recursive: true });
  fs.writeFileSync(path.join(hoisted, 'package.json'), JSON.stringify({ name: 'better-sqlite3' }));
  assert.equal(bsq3Root(fromDir), hoisted);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bsq3Root follows a nested→hoisted move in-process (sync convergence bug)', () => {
  // The false-negative: healNatives resolves better-sqlite3 to a NESTED copy,
  // then an in-process `npm install` (aidefence) dedupes it away, leaving only a
  // HOISTED copy. The final proof must resolve to the hoisted copy — reading disk
  // fresh — not a stale cached root pointing at the removed nested path.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-natives-move-'));
  const fromDir = path.join(root, 'node_modules', 'agentdb');
  const nested = path.join(fromDir, 'node_modules', 'better-sqlite3');
  const hoisted = path.join(root, 'node_modules', 'better-sqlite3');
  for (const p of [nested, hoisted]) {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: 'better-sqlite3' }));
  }
  assert.equal(bsq3Root(fromDir), nested, 'prefers the nested copy while it exists');
  fs.rmSync(nested, { recursive: true, force: true }); // simulate npm dedupe mid-sync
  assert.equal(bsq3Root(fromDir), hoisted, 'resolves to the hoisted copy after the move');
  fs.rmSync(root, { recursive: true, force: true });
});

function writePkgJson(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(data));
}

test('selfSpecConflicts finds a stale optionalDependencies pin against a bumped spec', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-natives-selfconflict-'));
  writePkgJson(dir, {
    name: '@claude-flow/cli',
    overrides: { 'better-sqlite3': '^12.10.0' },
    optionalDependencies: { 'better-sqlite3': '^12.9.0' },
  });
  assert.deepEqual(selfSpecConflicts(dir, '^12.10.0'), ['optionalDependencies']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('selfSpecConflicts is empty when every self-declared field already agrees', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-natives-noconflict-'));
  writePkgJson(dir, {
    name: '@claude-flow/cli',
    overrides: { 'better-sqlite3': '^12.10.0' },
    optionalDependencies: { 'better-sqlite3': '^12.10.0' },
  });
  assert.deepEqual(selfSpecConflicts(dir, '^12.10.0'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('selfSpecConflicts ignores non-plain-semver declarations (workspace:/link:/etc.)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-natives-nonsemver-'));
  writePkgJson(dir, { name: 'x', dependencies: { 'better-sqlite3': 'link:../better-sqlite3' } });
  assert.deepEqual(selfSpecConflicts(dir, '^12.10.0'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeGlobalRootFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-natives-cfpkg-'));
  fs.mkdirSync(path.join(root, 'ruflo', 'node_modules'), { recursive: true });
  return root;
}

test('securityPresent is true when the package is hoisted to the top of ruflo/node_modules', () => {
  const root = makeGlobalRootFixture();
  writePkgJson(path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'security'), { name: '@claude-flow/security' });
  _setGlobalRootForTest(root);
  try {
    assert.equal(securityPresent(), true);
  } finally {
    _setGlobalRootForTest(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('securityPresent is true when npm nests the package under @claude-flow/cli instead of hoisting it (regression: false WARN when a version conflict prevents hoisting)', () => {
  const root = makeGlobalRootFixture();
  writePkgJson(
    path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'node_modules', '@claude-flow', 'security'),
    { name: '@claude-flow/security' },
  );
  _setGlobalRootForTest(root);
  try {
    assert.equal(securityPresent(), true);
  } finally {
    _setGlobalRootForTest(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('securityPresent is false when the package is genuinely absent from both locations', () => {
  const root = makeGlobalRootFixture();
  _setGlobalRootForTest(root);
  try {
    assert.equal(securityPresent(), false);
  } finally {
    _setGlobalRootForTest(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aidefencePresent follows the same top-level-or-nested-under-cli resolution', () => {
  const root = makeGlobalRootFixture();
  writePkgJson(
    path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'node_modules', '@claude-flow', 'aidefence'),
    { name: '@claude-flow/aidefence' },
  );
  _setGlobalRootForTest(root);
  try {
    assert.equal(aidefencePresent(), true);
  } finally {
    _setGlobalRootForTest(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
