// ensureNativeBsq3 — the natives heal ladder. Uses a synthetic node_modules
// fixture and an injected runner that simulates npm, so the test is hermetic
// (no npm, no network, no global tree) and runs on the full CI matrix.
//
// The regression under test (the sync that reported "native installed" and then
// failed its own convergence proof with a WASM fallback, 30s apart — both true):
// healing by installing better-sqlite3 INTO the agentdb location plants a copy
// no package.json declares. The next `npm install` into the ruflo root reconciles
// the tree, PRUNES that copy as extraneous, and resolution silently falls back to
// the unbuilt copy underneath. Heal must survive a reconciliation to be a heal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureNativeBsq3, healNatives } from '../../src/lib/heal.mjs';
import { bsq3IsNative } from '../../src/lib/natives.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';

const BINDING = path.join('build', 'Release', 'better_sqlite3.node');

function writePkg(dir, { withBinding = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '12.0.0' }));
  if (withBinding) addBinding(dir);
}

function addBinding(pkgDir) {
  fs.mkdirSync(path.join(pkgDir, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, BINDING), '');
}

/** ruflo/node_modules/{agentdb, better-sqlite3} — better-sqlite3 hoisted and
 *  declared, but unbuilt: the state a `ruflo@latest` upgrade leaves behind. */
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-heal-'));
  const agentdb = path.join(root, 'node_modules', 'agentdb');
  const shared = path.join(root, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(agentdb, { recursive: true });
  writePkg(shared);
  return { root, agentdb, shared, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A runner that fakes just enough npm: `npm run install` builds the binding in
 *  cwd (prebuild-install succeeding), `npm install better-sqlite3` plants a
 *  built copy under cwd/node_modules (the old rung 1). Records every call. */
function fakeNpm({ nested = null } = {}) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    if (args[0] === 'run' && args[1] === 'install') addBinding(opts.cwd);
    if (args[0] === 'install' && String(args[1]).startsWith('better-sqlite3')) {
      writePkg(nested ?? path.join(opts.cwd, 'node_modules', 'better-sqlite3'), { withBinding: true });
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

/** What `npm install <anything>` into the ruflo root does to the tree: removes
 *  packages no package.json declares. The heal's `--no-save` copy is exactly that. */
function reconcileTree(root) {
  for (const extraneous of [path.join(root, 'node_modules', 'agentdb', 'node_modules')]) {
    fs.rmSync(extraneous, { recursive: true, force: true });
  }
}

test('heal survives an npm tree reconciliation (the sync convergence regression)', async () => {
  const { root, agentdb, cleanup } = makeTree();
  const { runner } = fakeNpm();

  const r = await ensureNativeBsq3(agentdb, { runner });
  assert.equal(r.ok, true, 'heal reports success');
  assert.equal(bsq3IsNative(agentdb), true, 'native immediately after the heal');

  reconcileTree(root); // a later `npm install` into the ruflo root (healAidefence's)

  assert.equal(bsq3IsNative(agentdb), true,
    'STILL native after reconciliation — a heal that a later npm install prunes away is not a heal');
  cleanup();
});

test('heal builds the resolved copy in place, planting no extraneous copy', async () => {
  const { agentdb, shared, cleanup } = makeTree();
  const { runner, calls } = fakeNpm();

  await ensureNativeBsq3(agentdb, { runner });

  assert.equal(fs.existsSync(path.join(shared, BINDING)), true, 'binding built on the declared copy');
  assert.equal(fs.existsSync(path.join(agentdb, 'node_modules', 'better-sqlite3')), false,
    'no extraneous copy planted under agentdb — npm would prune it as undeclared');
  assert.equal(calls.some((c) => c.args[0] === 'install'), false,
    'never installs a copy when better-sqlite3 already resolves');
  cleanup();
});

test('heal installs a copy only when better-sqlite3 is not resolvable at all', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-heal-bare-'));
  const agentdb = path.join(root, 'node_modules', 'agentdb');
  fs.mkdirSync(agentdb, { recursive: true });
  const { runner, calls } = fakeNpm();

  const r = await ensureNativeBsq3(agentdb, { runner });

  assert.equal(r.ok, true);
  assert.equal(calls[0].args[0], 'install', 'falls back to installing a copy — nothing in place to build');
  assert.equal(bsq3IsNative(agentdb), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('heal reports failure honestly when no rung produces a binding', async () => {
  const { agentdb, cleanup } = makeTree();
  const runner = async () => ({ code: 1, stdout: '', stderr: 'node-gyp: build error\n' });

  const r = await ensureNativeBsq3(agentdb, { runner });

  assert.equal(r.ok, false, 'never claims success without the binding on disk');
  assert.match(r.how, /FAILED/);
  cleanup();
});

test('heal reports failure when better-sqlite3 stays unresolvable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-heal-noop-'));
  const runner = async () => ({ code: 0, stdout: '', stderr: '' }); // install produces nothing

  const r = await ensureNativeBsq3(root, { runner });

  assert.equal(r.ok, false);
  assert.match(r.how, /not resolvable/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── FR-2: the install rung derives its spec from the tree (EOVERRIDE fix) ─────

/** A better-sqlite3 that node resolution CANNOT find, in a dir that pins an npm
 *  `overrides` for it — the npm-12 state where a direct `@^12` install is
 *  EOVERRIDE-rejected but the declared `^12.9.0` succeeds. */
function overrideDir(pin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-heal-override-'));
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: '@claude-flow/cli', overrides: { 'better-sqlite3': pin } }));
  return dir;
}

/** Runner that mimics npm's EOVERRIDE: `install better-sqlite3@^12` fails, the
 *  declared spec succeeds and plants a built copy. Records install specs seen. */
function eoverrideNpm(declared) {
  const specs = [];
  const runner = async (cmd, args, opts) => {
    if (args[0] === 'install' && String(args[1]).startsWith('better-sqlite3')) {
      const spec = String(args[1]);
      specs.push(spec);
      if (spec === 'better-sqlite3@^12') {
        return { code: 1, stdout: '', stderr: 'npm error code EOVERRIDE\nOverride for better-sqlite3@^12 conflicts with direct dependency\n' };
      }
      const pkg = path.join(opts.cwd, 'node_modules', 'better-sqlite3');
      fs.mkdirSync(path.join(pkg, 'build', 'Release'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.9.0' }));
      fs.writeFileSync(path.join(pkg, BINDING), '');
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, specs, declared };
}

test('ensureNativeBsq3 installs the tree-derived override spec, never the hardcoded ^12', async () => {
  const dir = overrideDir('^12.9.0');
  const { runner, specs } = eoverrideNpm('^12.9.0');

  const r = await ensureNativeBsq3(dir, { runner });

  assert.equal(r.ok, true, 'heal succeeds with the derived spec');
  assert.ok(specs.includes('better-sqlite3@^12.9.0'), `derived spec used (saw ${JSON.stringify(specs)})`);
  assert.ok(!specs.includes('better-sqlite3@^12'), 'never falls into the EOVERRIDE-rejected hardcoded ^12');
  assert.equal(bsq3IsNative(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── FR-1: healNatives also heals the ruflo memory runtime contexts ──────────

test('healNatives heals @claude-flow/memory + /cli with each tree\'s derived spec (AC-1)', async () => {
  // Fake global tree: ruflo/node_modules/@claude-flow/{memory,cli}, each pinning
  // better-sqlite3 via overrides, none resolvable — the npm-12 WASM-only state.
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-heal-global-'));
  const nm = path.join(g, 'ruflo', 'node_modules');
  for (const c of ['memory', 'cli']) {
    const dir = path.join(nm, '@claude-flow', c);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: `@claude-flow/${c}`, overrides: { 'better-sqlite3': '^12.9.0' } }));
  }
  _setGlobalRootForTest(g);
  const { runner, specs } = eoverrideNpm('^12.9.0');

  const r = await healNatives({ runner });

  assert.ok(specs.length >= 2, 'installed into both contexts');
  assert.ok(specs.every((s) => s === 'better-sqlite3@^12.9.0'), `only the derived spec (saw ${JSON.stringify(specs)})`);
  assert.match(r.detail, /@claude-flow\/memory/);
  assert.match(r.detail, /@claude-flow\/cli/);
  assert.equal(r.ok, true);
  _setGlobalRootForTest(null);
  fs.rmSync(g, { recursive: true, force: true });
});

test('healNatives skips a ruflo tree with no @claude-flow packages, without crashing (EC-2)', async () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-heal-bare-global-'));
  fs.mkdirSync(path.join(g, 'ruflo', 'node_modules'), { recursive: true });
  _setGlobalRootForTest(g);
  let installed = false;
  const runner = async (cmd, args) => { if (args[0] === 'install') installed = true; return { code: 0 }; };

  const r = await healNatives({ runner });

  assert.equal(installed, false, 'nothing to heal → no install');
  assert.equal(r.ok, true);
  _setGlobalRootForTest(null);
  fs.rmSync(g, { recursive: true, force: true });
});

// ── AC-2 / NFR-1: the ladder tolerates npm 9–12 approve-scripts behavior ─────

test('ladder tolerates an npm-9 approve-scripts unknown-command and still succeeds', async () => {
  // npm ≤11.16 has no `approve-scripts`; its failure must not abort the ladder.
  const { agentdb, shared, cleanup } = makeTree();
  const calls = [];
  const runner = async (cmd, args, _opts) => {
    calls.push(args.join(' '));
    if (args[0] === 'run' && args[1] === 'install') return { code: 0 }; // rung 1: no build (simulated miss)
    if (args[0] === 'approve-scripts') return { code: 1, stdout: '', stderr: 'Unknown command: "approve-scripts"\n' };
    if (args[0] === 'rebuild') { addBinding(shared); return { code: 0 }; }
    return { code: 0 };
  };

  const r = await ensureNativeBsq3(agentdb, { runner });

  assert.equal(r.ok, true, 'ladder recovers at rebuild despite approve-scripts failing');
  assert.ok(calls.some((c) => c.startsWith('approve-scripts')), 'approve-scripts rung was attempted');
  assert.ok(calls.some((c) => c.startsWith('rebuild')), 'ladder proceeded to rebuild after the failure');
  cleanup();
});

test('ladder succeeds on npm-12 (run install blocked, approve-scripts then rebuild builds)', async () => {
  const { agentdb, shared, cleanup } = makeTree();
  const runner = async (cmd, args) => {
    if (args[0] === 'run' && args[1] === 'install') return { code: 0 }; // blocked → no build
    if (args[0] === 'approve-scripts') return { code: 0 }; // npm 12: command exists
    if (args[0] === 'rebuild') { addBinding(shared); return { code: 0 }; }
    return { code: 0 };
  };

  const r = await ensureNativeBsq3(agentdb, { runner });

  assert.equal(r.ok, true);
  assert.match(r.how, /rebuilt/);
  cleanup();
});
