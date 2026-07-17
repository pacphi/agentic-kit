// scanNpxStale / pruneNpxStale — the stale npx-env prune behind `ak sync`.
// Uses a synthetic _npx fixture and an injected baseline, so the test is
// hermetic (no npm, no network, never the machine's real cache).
//
// The invariant under test is the conservative prune rule: a stale env is
// removed ONLY when every package it is keyed to is judgeable (managed +
// installed baseline + readable cached copy) and at least one cached copy is
// strictly older. Anything unjudgeable is left alone — misses must fail safe
// as "not pruned", never as a wrong prune.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanNpxStale, pruneNpxStale, managedBaseline } from '../../src/lib/npx.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';

// One npx env: <root>/<name>/package.json (keyed spec) + node_modules/<pkg> copies.
function env(root, name, keyed, copies = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: keyed }));
  for (const [pkg, version] of Object.entries(copies)) {
    const p = path.join(dir, 'node_modules', pkg);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: pkg, version }));
  }
  return dir;
}

const INSTALLED = { ruflo: '3.32.2', '@claude-flow/cli': '3.32.2', 'agentic-qe': '3.12.2' };
const baseline = (pkg) => INSTALLED[pkg] ?? null;
const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-npx-'));

test('scan flags an env whose cached copy is strictly older than the baseline', () => {
  const root = mkroot();
  const dir = env(root, 'aaa', { ruflo: '^3.21.1' }, { ruflo: '3.21.1' });
  const found = scanNpxStale({ root, baseline });
  assert.deepEqual(found, [{ dir, stale: [{ pkg: 'ruflo', installed: '3.32.2', cached: '3.21.1' }] }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan keeps an env whose cached copy matches the installed version', () => {
  const root = mkroot();
  env(root, 'bbb', { '@claude-flow/cli': '^3.32.0' }, { '@claude-flow/cli': '3.32.2' });
  assert.deepEqual(scanNpxStale({ root, baseline }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan keeps an env cached NEWER than the install — only strictly older is stale', () => {
  const root = mkroot();
  env(root, 'ccc', { ruflo: '^3.33.0' }, { ruflo: '3.33.0' });
  assert.deepEqual(scanNpxStale({ root, baseline }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan keeps an env keyed to any unmanaged package — partial verdicts never prune', () => {
  const root = mkroot();
  // ruflo copy is stale, but the pnpm key is unjudgeable → whole env exempt.
  env(root, 'ddd', { ruflo: '^3.21.1', pnpm: '^9' }, { ruflo: '3.21.1', pnpm: '9.0.0' });
  assert.deepEqual(scanNpxStale({ root, baseline }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan keeps a managed env when no installed baseline exists to judge against', () => {
  const root = mkroot();
  env(root, 'eee', { 'agentic-qe': '^3.11.5' }, { 'agentic-qe': '3.11.5' });
  assert.deepEqual(scanNpxStale({ root, baseline: () => null }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan keeps an env whose cached copy is unreadable — no version, no verdict', () => {
  const root = mkroot();
  env(root, 'fff', { ruflo: '^3.21.1' }, {}); // keyed but node_modules copy missing
  assert.deepEqual(scanNpxStale({ root, baseline }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan of a missing cache dir returns empty, never throws', () => {
  assert.deepEqual(scanNpxStale({ root: path.join(os.tmpdir(), 'ak-npx-does-not-exist'), baseline }), []);
});

test('prune removes exactly the stale envs and reports what it removed', () => {
  const root = mkroot();
  const stale = env(root, 'stale', { '@claude-flow/cli': '^3.28.0' }, { '@claude-flow/cli': '3.28.0' });
  const current = env(root, 'current', { ruflo: '^3.32.2' }, { ruflo: '3.32.2' });
  const foreign = env(root, 'foreign', { typescript: '^5' }, { typescript: '5.5.0' });

  const r = pruneNpxStale({ root, baseline });

  assert.equal(r.ok, true);
  assert.match(r.detail, /@claude-flow\/cli@3\.28\.0/);
  assert.equal(fs.existsSync(stale), false, 'stale env removed');
  assert.equal(fs.existsSync(current), true, 'current env kept');
  assert.equal(fs.existsSync(foreign), true, 'foreign env kept');
  fs.rmSync(root, { recursive: true, force: true });
});

test('prune reports "no stale envs" on a clean cache without touching anything', () => {
  const root = mkroot();
  const kept = env(root, 'ok', { ruflo: '^3.32.2' }, { ruflo: '3.32.2' });
  const r = pruneNpxStale({ root, baseline });
  assert.deepEqual(r, { ok: true, detail: 'no stale envs' });
  assert.equal(fs.existsSync(kept), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('managedBaseline resolves @claude-flow/cli from its NESTED location under ruflo', () => {
  const groot = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-npx-groot-'));
  const nested = path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ version: '3.32.2' }));
  _setGlobalRootForTest(groot);
  assert.equal(managedBaseline('@claude-flow/cli'), '3.32.2');
  assert.equal(managedBaseline('left-pad'), null, 'unmanaged packages are never judged');
  fs.rmSync(groot, { recursive: true, force: true });
});
