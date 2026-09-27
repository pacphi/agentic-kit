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
import path from 'node:path';
import {
  brainInstallFailure, ensureNativeBsq3, healNatives, installRuvnetBrain,
} from '../../src/lib/heal.mjs';
import * as heal from '../../src/lib/heal.mjs';
import { SYNC_STEPS } from '../../src/commands/sync.mjs';
import { bsq3IsNative } from '../../src/lib/natives.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const BINDING = path.join('build', 'Release', 'better_sqlite3.node');

// Every installRuvnetBrain test below must be blind to this machine's real
// Brain: kbDir() honors RUVNET_BRAIN_KB at call time, so point it at an empty
// directory for the whole file (a real KB has forge-update.mjs and SOURCE.json,
// which would silently switch these tests onto the updater path).
process.env.RUVNET_BRAIN_KB = tempDir('ak-heal-brain-kb');
// The natives heal receipts every manifest edit in ak's state folder
// (install-edits.mjs), resolved at call time: keep this file's heals out of the
// real one.
process.env.XDG_STATE_HOME = tempDir('ak-heal-state');
process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME;

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
  const root = tempDir('ak-heal');
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
  const root = tempDir('ak-heal-bare');
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
  const root = tempDir('ak-heal-noop');
  const runner = async () => ({ code: 0, stdout: '', stderr: '' }); // install produces nothing

  const r = await ensureNativeBsq3(root, { runner });

  assert.equal(r.ok, false);
  assert.match(r.how, /not resolvable/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('heal reports the npm install error when the package stays unresolvable', async () => {
  const root = tempDir('ak-heal-install-fail');
  const runner = async () => ({ code: 1, stdout: '', stderr: 'npm error native build failed\n' });

  const r = await ensureNativeBsq3(root, { runner });

  assert.equal(r.ok, false);
  assert.match(r.how, /native build failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── FR-2: the install rung derives its spec from the tree (EOVERRIDE fix) ─────

/** A better-sqlite3 that node resolution CANNOT find, in a dir that pins an npm
 *  `overrides` for it — the npm-12 state where a direct `@^12` install is
 *  EOVERRIDE-rejected but the declared `^12.9.0` succeeds. */
function overrideDir(pin) {
  const dir = tempDir('ak-heal-override');
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
  const dir = overrideDir('^12.10.0');
  const { runner, specs } = eoverrideNpm('^12.10.0');

  const r = await ensureNativeBsq3(dir, { runner });

  assert.equal(r.ok, true, 'heal succeeds with the derived spec');
  assert.ok(specs.includes('better-sqlite3@^12.10.0'), `derived spec used (saw ${JSON.stringify(specs)})`);
  assert.ok(!specs.includes('better-sqlite3@^12'), 'never falls into the EOVERRIDE-rejected hardcoded ^12');
  assert.equal(bsq3IsNative(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureNativeBsq3 reconciles a self-declared optionalDependencies pin before installing (EOVERRIDE fix)', async () => {
  // Live regression: @claude-flow/cli's OWN package.json pinned better-sqlite3
  // via both `overrides` (already bumped to Node 26's ^12.10.0) and
  // `optionalDependencies` (still the stale ^12.9.0). npm requires a root
  // package's self-declared fields for the same dependency to agree, so the
  // stale optionalDependencies entry alone triggered EOVERRIDE even though the
  // derived install spec matched `overrides`.
  const dir = tempDir('ak-heal-selfconflict');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@claude-flow/cli',
    overrides: { 'better-sqlite3': '^12.10.0' },
    optionalDependencies: { 'better-sqlite3': '^12.9.0' },
  }));
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    if (cmd === 'npm' && args[0] === 'pkg') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'install' && String(args[1]).startsWith('better-sqlite3')) {
      const pkg = path.join(opts.cwd, 'node_modules', 'better-sqlite3');
      fs.mkdirSync(path.join(pkg, 'build', 'Release'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.10.0' }));
      fs.writeFileSync(path.join(pkg, BINDING), '');
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const r = await ensureNativeBsq3(dir, { runner });

  assert.equal(r.ok, true, 'heal succeeds once the self-declared fields are reconciled');
  const pkgSetCalls = calls.filter((c) => c.args[0] === 'pkg' && c.args[1] === 'set');
  assert.ok(pkgSetCalls.some((c) => c.args[2] === 'optionalDependencies.better-sqlite3=^12.10.0'),
    `optionalDependencies reconciled to the derived spec before install (saw ${JSON.stringify(calls.map((c) => c.args))})`);
  assert.ok(!pkgSetCalls.some((c) => c.args[2].startsWith('overrides.')),
    'overrides already agreed with the derived spec — left untouched');
  const pkgSetIdx = calls.findIndex((c) => c.args[0] === 'pkg');
  const installIdx = calls.findIndex((c) => c.args[0] === 'install');
  assert.ok(pkgSetIdx >= 0 && pkgSetIdx < installIdx, 'reconciliation runs before the install');
  assert.equal(bsq3IsNative(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── FR-1: healNatives also heals the ruflo memory runtime contexts ──────────

test('healNatives heals @claude-flow/memory + /cli with each tree\'s derived spec (AC-1)', async () => {
  // Fake global tree: ruflo/node_modules/@claude-flow/{memory,cli}, each pinning
  // better-sqlite3 via overrides, none resolvable — the npm-12 WASM-only state.
  const g = tempDir('ak-heal-global');
  const nm = path.join(g, 'ruflo', 'node_modules');
  for (const c of ['memory', 'cli']) {
    const dir = path.join(nm, '@claude-flow', c);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: `@claude-flow/${c}`, overrides: { 'better-sqlite3': '^12.10.0' } }));
  }
  _setGlobalRootForTest(g);
  const { runner, specs } = eoverrideNpm('^12.10.0');

  const r = await healNatives({ runner });

  assert.ok(specs.length >= 2, 'installed into both contexts');
  assert.ok(specs.every((s) => s === 'better-sqlite3@^12.10.0'), `only the derived spec (saw ${JSON.stringify(specs)})`);
  assert.match(r.detail, /@claude-flow\/memory/);
  assert.match(r.detail, /@claude-flow\/cli/);
  assert.equal(r.ok, true);
  _setGlobalRootForTest(null);
  fs.rmSync(g, { recursive: true, force: true });
});

test('healNatives skips a ruflo tree with no @claude-flow packages, without crashing (EC-2)', async () => {
  const g = tempDir('ak-heal-bare-global');
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

// ── P3: a binding that exists but will not load (status load-tests it) ───────

/** ruflo/node_modules/@claude-flow/cli with its own better-sqlite3 whose
 *  build/Release binding file is PRESENT — the state a Node major upgrade leaves:
 *  the file exists, so the old file-exists check called it native. */
function presentBindingTree() {
  const g = tempDir('ak-heal-unloadable');
  const cli = path.join(g, 'ruflo', 'node_modules', '@claude-flow', 'cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@claude-flow/cli' }));
  const pkg = path.join(cli, 'node_modules', 'better-sqlite3');
  writePkg(pkg, { withBinding: true });
  fs.writeFileSync(path.join(pkg, BINDING), 'binary built for another Node ABI');
  _setGlobalRootForTest(g);
  return { pkg, cleanup: () => { _setGlobalRootForTest(null); fs.rmSync(g, { recursive: true, force: true }); } };
}

const loadFailure = (message) => ({
  code: 2, stdout: '', stderr: `AK_NATIVE_FAILURE:${JSON.stringify({ message })}\n`,
});

/** Runner for the load probe (`node`) and npm. The binding loads once a rung
 *  has produced a NEW file (`npm run install` writes one) unless `stillBroken`. */
function probeAndNpm(pkg, { stillBroken = false, probe = null } = {}) {
  const calls = [];
  let rebuilt = false;
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd, bindingOnDisk: fs.existsSync(path.join(pkg, BINDING)) });
    if (cmd === 'node') {
      if (probe) return probe();
      return rebuilt && !stillBroken ? { code: 0, stdout: '', stderr: '' }
        : loadFailure(`The module '${path.join(pkg, BINDING)}'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 137.`);
    }
    if (args[0] === 'run' && args[1] === 'install') { addBinding(opts.cwd); rebuilt = true; }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('healNatives rebuilds a present binding that will not load (status and sync share the load test)', async () => {
  const { pkg, cleanup } = presentBindingTree();
  try {
    const { runner, calls } = probeAndNpm(pkg);
    const r = await healNatives({ runner });
    const install = calls.find((c) => c.cmd === 'npm' && c.args.join(' ') === 'run install');
    assert.ok(install, `npm run install ran (saw ${JSON.stringify(calls.map((c) => `${c.cmd} ${c.args[0]}`))})`);
    assert.equal(install.cwd, pkg, 'rebuilt in place, in the package the runtime resolves');
    assert.equal(r.ok, true);
    assert.match(r.detail, /@claude-flow\/cli: native built in place/);
  } finally { cleanup(); }
});

test('healNatives removes the unloadable binding before rebuilding, so the rebuild writes a new file', async () => {
  // prebuild-install extracts over an existing file in place (tar-fs
  // createWriteStream); a process started before a Node upgrade may still map it.
  const { pkg, cleanup } = presentBindingTree();
  try {
    const { runner, calls } = probeAndNpm(pkg);
    await healNatives({ runner });
    const install = calls.find((c) => c.cmd === 'npm' && c.args[0] === 'run');
    assert.equal(install.bindingOnDisk, false, 'the stale file is gone before the first rung runs');
  } finally { cleanup(); }
});

test('healNatives reports a rebuild that still will not load as a failure with the load error', async () => {
  const { pkg, cleanup } = presentBindingTree();
  try {
    const { runner } = probeAndNpm(pkg, { stillBroken: true });
    const r = await healNatives({ runner });
    assert.equal(r.ok, false, 'a binding file on disk is not a heal when it still will not load');
    assert.match(r.detail, /still (?:does|will) not load/);
    assert.match(r.detail, /compiled against a different Node\.js version/);
    assert.doesNotMatch(r.detail, /FAILED \(exit 0\)/);
  } finally { cleanup(); }
});

test('healNatives never rebuilds on an inconclusive probe', async () => {
  const { pkg, cleanup } = presentBindingTree();
  try {
    // A crashed probe (no diagnostic, not a timeout): no verdict about the binding.
    const { runner, calls } = probeAndNpm(pkg, {
      probe: () => ({ code: 1, stdout: '', stderr: 'Command failed: node -e try{…' }),
    });
    const r = await healNatives({ runner });
    assert.deepEqual(calls.filter((c) => c.cmd === 'npm'), [], 'no npm call on an inconclusive probe');
    assert.equal(fs.existsSync(path.join(pkg, BINDING)), true, 'the binding is left alone');
    assert.equal(r.ok, true);
    assert.match(r.detail, /@claude-flow\/cli: load probe inconclusive/);
  } finally { cleanup(); }
});

test('healNatives leaves a present binding that loads alone', async () => {
  const { pkg, cleanup } = presentBindingTree();
  try {
    const { runner, calls } = probeAndNpm(pkg, { probe: () => ({ code: 0, stdout: '', stderr: '' }) });
    const r = await healNatives({ runner });
    assert.deepEqual(calls.filter((c) => c.cmd === 'npm'), []);
    assert.deepEqual(r, { ok: true, detail: 'already native everywhere' });
  } finally { cleanup(); }
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

test('brain installer exit failure is failed even when an old or partial KB is present', async () => {
  let stamped = false;
  const r = await installRuvnetBrain({
    runner: async () => ({ code: 1, stdout: '', stderr: 'installer failed after partial copy\n' }),
    latestRelease: async () => ({ version: '4.0.12', releaseAssetAvailable: true }),
    present: () => true,
    recordRelease: () => { stamped = true; },
    recordRefusal: () => {},
  });

  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.equal(r.usable, true, 'old presence is retained as usability evidence only');
  assert.equal(stamped, false, 'failed installers never stamp a release');
});

test('brain installer stamps only a zero-exit installation', async () => {
  let stamped = null;
  const r = await installRuvnetBrain({
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    latestRelease: async () => ({ version: '4.0.12', releaseAssetAvailable: true }),
    present: () => false,
    recordRelease: (version) => { stamped = version; },
  });
  assert.equal(r.status, 'ok');
  assert.equal(stamped, '4.0.12');
});

test('brain installer refuses a release tag whose required bundle asset is absent', async () => {
  let ran = false;
  const r = await installRuvnetBrain({
    runner: async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; },
    latestRelease: async () => ({ version: '4.3.1', releaseAssetAvailable: false }),
    present: () => true,
    recordRefusal: () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.usable, true);
  assert.equal(ran, false, 'a release known to lack ruvnet-brain.zip must never launch npx');
  assert.match(r.detail, /v4\.3\.1 is missing ruvnet-brain\.zip/);
  assert.match(r.detail, /existing Brain was left unchanged/);
});

test('brain installer failure selects the causal updater error across stdout and stderr', async () => {
  const r = await installRuvnetBrain({
    runner: async () => ({
      code: 1,
      stdout: '[forge-update] ERROR: v4.3.1 has no matching .zip asset\n',
      stderr: "Nothing is left half-installed — fix the above and re-run.\n",
    }),
    latestRelease: async () => ({ version: '4.3.1', releaseAssetAvailable: true }),
    present: () => true,
    recordRefusal: () => {}, // never the real kit.json from this unsandboxed file
  });
  assert.match(r.detail, /no matching \.zip asset/);
  assert.doesNotMatch(r.detail, /Nothing is left half-installed/);
});

// #237 §4/§C (B-deps D2): an existing install used to be refreshed with the
// FRESH-install path plus --force, which the installer refuses for a Brain with
// private stores — after downloading the whole bundle — on every sync. The
// installed bundle ships its own updater (kb/forge-update.mjs); `--update` runs
// it, and it is the installer's own precondition for that command.
const brainCalls = () => {
  const calls = [];
  const runner = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, stdout: '', stderr: '' }; };
  return { calls, runner };
};
const sequence = (...values) => () => (values.length > 1 ? values.shift() : values[0]);

test('brain refresh of an existing install runs its updater, never a forced fresh install', async () => {
  const { calls, runner } = brainCalls();
  let stamped = null;
  const r = await installRuvnetBrain({
    runner,
    latestRelease: async () => ({ version: '4.3.28', releaseAssetAvailable: true }),
    present: () => true,
    updaterPresent: () => true,
    releaseOnDisk: sequence('4.3.22', '4.3.28'),
    recordRelease: (v) => { stamped = v; },
    recordRefusal: () => {},
  });
  assert.equal(calls.length, 1);
  const { args, opts } = calls[0];
  for (const flag of ['--update', '--no-nightly-prompt', '--no-telemetry']) assert.ok(args.includes(flag), flag);
  assert.equal(args.includes('--force'), false, '--force is the fresh-install bypass, never an update');
  assert.equal(args.includes('--version'), false, '--update ignores --version, so ak must not pretend to pin');
  assert.equal(opts.env?.RUVNET_BRAIN_NO_UPDATE_FALLBACK, '1',
    "the updater's own fallback is a fresh --force install that drops ak's opt-out flags");
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(stamped, '4.3.28', 'the stamp is the release observed on disk');
  assert.match(r.detail, /v4\.3\.28/);
});

test('an updater that exits 0 without changing the release on disk is degraded and stamps nothing', async () => {
  const { runner } = brainCalls();
  let stamped = null;
  const r = await installRuvnetBrain({
    runner,
    latestRelease: async () => ({ version: '4.3.28', releaseAssetAvailable: true }),
    present: () => true,
    updaterPresent: () => true,
    releaseOnDisk: () => '4.3.22',
    recordRelease: (v) => { stamped = v; },
    recordRefusal: () => {},
  });
  assert.equal(r.ok, false, 'a no-op update must reach the convergence proof as unconverged');
  assert.equal(r.status, 'degraded');
  assert.equal(r.usable, true);
  assert.equal(stamped, null);
  assert.match(r.detail, /still v4\.3\.22/);
});

test('a fresh install stamps the release observed on disk, not the one requested', async () => {
  const { calls, runner } = brainCalls();
  let stamped = null;
  await installRuvnetBrain({
    runner,
    latestRelease: async () => ({ version: '4.3.28', releaseAssetAvailable: true }),
    present: () => false,
    updaterPresent: () => false,
    releaseOnDisk: () => '4.3.27', // what landed, read after the installer exits
    recordRelease: (v) => { stamped = v; },
    recordRefusal: () => {},
  });
  assert.equal(stamped, '4.3.27');
  assert.equal(calls[0].args.includes('--force'), false, 'a first install needs no bypass');
  assert.deepEqual(calls[0].args.slice(-2), ['--version', 'v4.3.28']);
});

test('a present bundle without an updater keeps the pinned forced reinstall', async () => {
  const { calls, runner } = brainCalls();
  await installRuvnetBrain({
    runner,
    latestRelease: async () => ({ version: '4.3.28', releaseAssetAvailable: true }),
    present: () => true,
    updaterPresent: () => false,
    releaseOnDisk: () => '4.3.28',
    recordRelease: () => {},
    recordRefusal: () => {},
  });
  const { args } = calls[0];
  assert.ok(args.includes('--force'), 'a pre-updater bundle can only be refreshed by reinstalling');
  assert.ok(args.includes('--version') && args.includes('v4.3.28'));
  assert.equal(args.includes('--update'), false);
});

test('brain failures drop ANSI color and keep the installer remediation hint', () => {
  const esc = String.fromCharCode(27);
  const detail = brainInstallFailure({
    code: 1,
    stdout: '',
    stderr: [
      '',
      `${esc}[31m✗ install stopped:${esc}[0m fresh-install activation refused because this brain contains a private overlay`,
      '',
      `Run ${esc}[1mnpx ruvnet-brain --update${esc}[22m so the bundle updater preserves those private stores.`,
      '',
      "Nothing is left half-installed — fix the above and re-run the same command (it's safe to re-run).",
    ].join('\n'),
  });
  assert.equal(detail.includes(esc), false, 'no terminal escape codes in a status/sync detail');
  assert.match(detail, /install stopped: fresh-install activation refused/);
  assert.match(detail, /npx ruvnet-brain --update/);
  assert.doesNotMatch(detail, /Nothing is left half-installed/);
});

// agentic-qe#617/#620: the native solver was never published and upstream made the
// TypeScript solver the implementation, so the report-only solver step is gone.
test('AQE solver: the heal that never installs anything is removed (agentic-qe#617)', () => {
  assert.equal(heal.healAqeSolver, undefined);
});

test('AQE solver: the sync security step lists no aqe solver', async () => {
  const step = SYNC_STEPS.find((s) => s.id === 'security');
  assert.ok(step, 'the security step exists');
  const names = [];
  await step.run({ step: async (name) => { names.push(name); }, report: () => {} });
  assert.deepEqual(names, ['aidefence']);
});

test('AQE solver: setup reports no aqe solver line', () => {
  const setup = fs.readFileSync(new URL('../../src/commands/setup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(setup, /aqe solver|healAqeSolver/);
});
