// bsq3Root / bsq3IsNative — the resolution + binding check behind the
// natives heal ladder. Uses a synthetic node_modules fixture so the test
// is hermetic (no npm, no network) and runs on the full CI matrix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bsq3Root, bsq3IsNative } from '../../src/lib/natives.mjs';

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
