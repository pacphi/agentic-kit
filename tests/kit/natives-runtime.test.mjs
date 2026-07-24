// #45 truthful-natives additions: the tree-derived install spec (FR-2), the
// ruflo memory-runtime load-test (FR-3), and the CLAUDE_FLOW_DB_PATH pin drift
// check (FR-5). All hermetic — a synthetic global tree + an injected runner, no
// npm, no network, no real child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveBsq3Spec, rufloMemoryContexts, rufloRuntimeNatives, dbPathPinStatus,
} from '../../src/lib/natives.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

function writePkg(dir, pkg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

/** ruflo/node_modules/@claude-flow/{memory,cli} under a fake global root. */
function fakeGlobalTree({ contexts = ['memory', 'cli'], pkg = {} } = {}) {
  const g = tmp('ak-rt-global-');
  const nm = path.join(g, 'ruflo', 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  for (const c of contexts) {
    writePkg(path.join(nm, '@claude-flow', c), { name: `@claude-flow/${c}`, ...pkg });
  }
  _setGlobalRootForTest(g);
  return { g, nm, cleanup: () => { _setGlobalRootForTest(null); rm(g); } };
}

// ── FR-2: deriveBsq3Spec ────────────────────────────────────────────────────

test('deriveBsq3Spec honors an override pin exactly (12.9.0-style)', () => {
  const dir = tmp('ak-derive-');
  writePkg(dir, { overrides: { 'better-sqlite3': '12.9.0' } });
  assert.equal(deriveBsq3Spec(dir), '12.9.0');
  rm(dir);
});

test('deriveBsq3Spec prefers overrides over optionalDependencies (EOVERRIDE avoidance)', () => {
  const dir = tmp('ak-derive-');
  writePkg(dir, {
    overrides: { 'better-sqlite3': '^12.9.0' },
    optionalDependencies: { 'better-sqlite3': '^12.0.0' },
  });
  assert.equal(deriveBsq3Spec(dir), '^12.9.0');
  rm(dir);
});

test('deriveBsq3Spec falls back through optionalDependencies when no override', () => {
  const dir = tmp('ak-derive-');
  writePkg(dir, { optionalDependencies: { 'better-sqlite3': '^12.9.0' } });
  assert.equal(deriveBsq3Spec(dir), '^12.9.0');
  rm(dir);
});

test('deriveBsq3Spec skips a $ref override and a workspace protocol, falling back (EC-3)', () => {
  const refDir = tmp('ak-derive-');
  writePkg(refDir, {
    overrides: { 'better-sqlite3': '$agentdb' },
    dependencies: { 'better-sqlite3': 'workspace:*' },
  });
  assert.equal(deriveBsq3Spec(refDir), '^12', 'non-semver forms are skipped, fallback used');
  rm(refDir);

  const protoDir = tmp('ak-derive-');
  writePkg(protoDir, { optionalDependencies: { 'better-sqlite3': 'npm:better-sqlite3-alt@^12' } });
  assert.equal(deriveBsq3Spec(protoDir), '^12', 'npm: alias skipped');
  rm(protoDir);
});

test('deriveBsq3Spec falls back to ^12 when better-sqlite3 is not declared at all', () => {
  const dir = tmp('ak-derive-');
  writePkg(dir, { name: 'x' });
  assert.equal(deriveBsq3Spec(dir), '^12');
  rm(dir);
});

// ── FR-3: rufloMemoryContexts + rufloRuntimeNatives ─────────────────────────

test('rufloMemoryContexts enumerates only the @claude-flow packages that exist (EC-2)', () => {
  const { cleanup } = fakeGlobalTree({ contexts: ['memory'] }); // older tree: no cli
  const ctxs = rufloMemoryContexts();
  assert.deepEqual(ctxs.map((c) => c.context), ['memory']);
  cleanup();
});

test('rufloRuntimeNatives reports per-context native vs WASM via the injected child probe', async () => {
  const { cleanup } = fakeGlobalTree();
  // Runner stands in for `node -e <require+SELECT 1>`: memory loads native (code 0),
  // cli fails to load the binding (the #45 WASM-only state) → non-zero + reason.
  const runner = async (cmd, args, opts) => {
    assert.equal(cmd, 'node');
    if (opts.cwd.endsWith(path.join('@claude-flow', 'memory'))) return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'Error: Could not locate the bindings file\n' };
  };
  const rt = await rufloRuntimeNatives({ runner });
  assert.equal(rt.installed, true);
  const memory = rt.contexts.find((c) => c.context === 'memory');
  const cli = rt.contexts.find((c) => c.context === 'cli');
  assert.equal(memory.ok, true);
  assert.equal(cli.ok, false);
  assert.match(cli.reason, /bindings file/);
  cleanup();
});

test('rufloRuntimeNatives reports all-ok when every context loads native', async () => {
  const { cleanup } = fakeGlobalTree();
  const runner = async () => ({ code: 0, stdout: '', stderr: '' });
  const rt = await rufloRuntimeNatives({ runner });
  assert.equal(rt.installed, true);
  assert.ok(rt.contexts.length >= 1);
  assert.ok(rt.contexts.every((c) => c.ok), 'no false failure when all native');
  cleanup();
});

test('rufloRuntimeNatives reports not-installed and never spawns when ruflo is absent (EC-1)', async () => {
  const g = tmp('ak-rt-empty-');
  _setGlobalRootForTest(g); // no ruflo/ subtree
  let spawned = false;
  const runner = async () => { spawned = true; return { code: 0 }; };
  const rt = await rufloRuntimeNatives({ runner });
  assert.equal(rt.installed, false);
  assert.deepEqual(rt.contexts, []);
  assert.equal(spawned, false, 'no child process when there is nothing to probe');
  _setGlobalRootForTest(null); rm(g);
});

// ── FR-5: dbPathPinStatus ───────────────────────────────────────────────────

function settingsWith(envObj) {
  const root = tmp('ak-pin-proj-');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const file = path.join(root, '.claude', 'settings.local.json');
  if (envObj !== undefined) fs.writeFileSync(file, JSON.stringify({ env: envObj }));
  return { root, file };
}

test('dbPathPinStatus warns when the pinned directory does not exist', () => {
  const missingDir = path.join(os.tmpdir(), 'ak-nope-' + Math.random().toString(36).slice(2));
  const { root, file } = settingsWith({ CLAUDE_FLOW_DB_PATH: path.join(missingDir, 'memory.db') });
  const s = dbPathPinStatus({ settingsLocalFile: file, projectRoot: root });
  assert.equal(s.warn, true);
  assert.match(s.reason, /does not exist/);
  rm(root);
});

test('dbPathPinStatus warns when the pin is outside the project (path.relative, not string-prefix)', () => {
  const outside = tmp('ak-pin-outside-'); // a real, existing dir OUTSIDE the project
  const { root, file } = settingsWith({ CLAUDE_FLOW_DB_PATH: path.join(outside, 'memory.db') });
  const s = dbPathPinStatus({ settingsLocalFile: file, projectRoot: root });
  assert.equal(s.warn, true);
  assert.match(s.reason, /outside/);
  assert.match(s.pinned, /memory\.db$/);
  rm(root); rm(outside);
});

test('dbPathPinStatus is quiet for a valid in-project pin', () => {
  const { root, file } = settingsWith({ CLAUDE_FLOW_DB_PATH: 'PLACEHOLDER' });
  const dbDir = path.join(root, '.swarm');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: { CLAUDE_FLOW_DB_PATH: path.join(dbDir, 'memory.db') } }));
  const s = dbPathPinStatus({ settingsLocalFile: file, projectRoot: root });
  assert.equal(s.warn, false);
  rm(root);
});

test('dbPathPinStatus is null when no pin is set', () => {
  const { root, file } = settingsWith({ SOMETHING_ELSE: '1' });
  assert.equal(dbPathPinStatus({ settingsLocalFile: file, projectRoot: root }), null);
  rm(root);
});

test('dbPathPinStatus is null when settings.local is absent or unparseable (EC-4)', () => {
  const absent = tmp('ak-pin-absent-');
  assert.equal(dbPathPinStatus({
    settingsLocalFile: path.join(absent, 'nope.json'), projectRoot: absent,
  }), null);
  const badFile = path.join(absent, 'bad.json');
  fs.writeFileSync(badFile, '{ not json');
  assert.equal(dbPathPinStatus({ settingsLocalFile: badFile, projectRoot: absent }), null);
  rm(absent);
});
