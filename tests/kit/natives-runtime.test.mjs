// #45 truthful-natives additions: the tree-derived install spec (FR-2), the
// ruflo memory-runtime load-test (FR-3), and the CLAUDE_FLOW_DB_PATH pin drift
// check (FR-5). All hermetic — a synthetic global tree + an injected runner, no
// npm, no network, no real child process (tests/kit/natives-probe.test.mjs runs
// the real probe script against fixture packages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveBsq3Spec, rufloMemoryContexts, rufloRuntimeNatives, dbPathPinStatus, probeBsq3Runtime, bsq3IsNative,
} from '../../src/lib/natives.mjs';
import * as nativesSection from '../../src/commands/status/sections/natives.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import { evidenceDir, readEvidence, writeEvidence, stableInputsKey } from '../../src/lib/evidence.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

// Task 4: rufloRuntimeNatives now reads/writes evidence under the kit state dir
// (evidenceDir()) when refresh:false. Redirect the state base for this whole
// file so those reads/writes never touch this machine's real evidence store —
// mirrors tests/kit/heal-natives.test.mjs's XDG_STATE_HOME/LOCALAPPDATA redirect.
process.env.XDG_STATE_HOME = tempDir('ak-natives-runtime-state');
process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME;

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const resetEvidence = () => rm(evidenceDir());

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
  assert.equal(deriveBsq3Spec(dir, '^12', 24), '12.9.0');
  rm(dir);
});

test('deriveBsq3Spec prefers overrides over optionalDependencies (EOVERRIDE avoidance)', () => {
  const dir = tmp('ak-derive-');
  writePkg(dir, {
    overrides: { 'better-sqlite3': '^12.9.0' },
    optionalDependencies: { 'better-sqlite3': '^12.0.0' },
  });
  assert.equal(deriveBsq3Spec(dir, '^12', 24), '^12.9.0');
  rm(dir);
});

test('deriveBsq3Spec falls back through optionalDependencies when no override', () => {
  const dir = tmp('ak-derive-');
  writePkg(dir, { optionalDependencies: { 'better-sqlite3': '^12.9.0' } });
  assert.equal(deriveBsq3Spec(dir, '^12', 24), '^12.9.0');
  rm(dir);
});

test('deriveBsq3Spec upgrades a stale ancestor 12.9 override for Node 26 before agentdb optional ^11', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-bsq3-ancestor-'));
  const agentdb = path.join(root, 'node_modules', 'agentdb');
  fs.mkdirSync(agentdb, { recursive: true });
  writePkg(root, { overrides: { 'better-sqlite3': '12.9.0' } });
  writePkg(agentdb, { optionalDependencies: { 'better-sqlite3': '^11.8.1' } });

  assert.equal(deriveBsq3Spec(agentdb, '^12', 26), '^12.10.0');
  assert.equal(deriveBsq3Spec(agentdb, '^12', 24), '12.9.0');
  fs.rmSync(root, { recursive: true, force: true });
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

/** What the probe child writes when better-sqlite3 will not load (exit 2). */
const failure = (message) => ({
  code: 2, stdout: '', stderr: `AK_NATIVE_FAILURE:${JSON.stringify({ message })}\n`,
});

test('rufloRuntimeNatives reports per-context native vs WASM via the injected child probe', async () => {
  const { cleanup } = fakeGlobalTree();
  // Runner stands in for `node -e <require+SELECT 1>`: memory loads native (code 0),
  // cli fails to load the binding (the #45 WASM-only state) → the child's diagnostic.
  const runner = async (cmd, args, opts) => {
    assert.equal(cmd, 'node');
    if (opts.cwd.endsWith(path.join('@claude-flow', 'memory'))) return { code: 0, stdout: '', stderr: '' };
    return failure('Could not locate the bindings file. Tried:\n → /g/ruflo/build/better_sqlite3.node');
  };
  const rt = await rufloRuntimeNatives({ runner });
  assert.equal(rt.installed, true);
  const memory = rt.contexts.find((c) => c.context === 'memory');
  const cli = rt.contexts.find((c) => c.context === 'cli');
  assert.equal(memory.ok, true);
  assert.equal(memory.state, 'native');
  assert.equal(cli.ok, false);
  assert.equal(cli.state, 'unavailable');
  assert.equal(cli.reason, 'Could not locate the bindings file.');
  assert.equal(cli.bindingPresent, false, 'the fixture has no build/Release binding');
  cleanup();
});

test('rufloRuntimeNatives says whether the resolved binding file is present', async () => {
  const { nm, cleanup } = fakeGlobalTree({ contexts: ['cli'] });
  const bsq3 = path.join(nm, '@claude-flow', 'cli', 'node_modules', 'better-sqlite3');
  writePkg(bsq3, { name: 'better-sqlite3' });
  fs.mkdirSync(path.join(bsq3, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(bsq3, 'build', 'Release', 'better_sqlite3.node'), 'stale');
  const rt = await rufloRuntimeNatives({ runner: async () => failure('invalid ELF header') });
  assert.equal(rt.contexts[0].state, 'unavailable');
  assert.equal(rt.contexts[0].bindingPresent, true);
  cleanup();
});

// ── P3: the probe keeps the load error and separates unavailable from inconclusive ──

test('probeBsq3Runtime reports native with the attempt count', async () => {
  const r = await probeBsq3Runtime('/x', { runner: async () => ({ code: 0, stdout: '', stderr: '' }) });
  assert.deepEqual(r, { ok: true, state: 'native', attempts: 1 });
});

const LOAD_ERRORS = [
  {
    name: 'macOS dlopen of a corrupt binding under a path with a space',
    message: "dlopen(/Users/Jo Doe/.g/ruflo/node_modules/better-sqlite3/build/Release/better_sqlite3.node, 0x0001): tried: '/Users/Jo Doe/.g/ruflo/node_modules/better-sqlite3/build/Release/better_sqlite3.node' (slice is not valid mach-o file), '/System/Volumes/Preboot/Cryptexes/OS/Users/Jo Doe/.g/ruflo/node_modules/better-sqlite3/build/Release/better_sqlite3.node' (no such file)",
    keeps: /slice is not valid mach-o file/,
  },
  {
    // Node's own multi-line text (captured from node 24 loading a node 26 build).
    name: 'Node ABI mismatch spread over five lines',
    message: "The module '/g/ruflo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 147. This version of Node.js requires\nNODE_MODULE_VERSION 137. Please try re-compiling or re-installing\nthe module (for instance, using `npm rebuild` or `npm install`).",
    keeps: /compiled against a different Node\.js version using NODE_MODULE_VERSION 147/,
  },
  {
    name: 'the bindings package search list',
    message: 'Could not locate the bindings file. Tried:\n → /g/ruflo/node_modules/better-sqlite3/build/better_sqlite3.node\n → /g/ruflo/node_modules/better-sqlite3/build/Debug/better_sqlite3.node',
    equals: 'Could not locate the bindings file.',
  },
  {
    name: 'an absent package with its require stack',
    message: "Cannot find module 'better-sqlite3'\nRequire stack:\n- /g/ruflo/node_modules/@claude-flow/cli/[eval]",
    equals: "Cannot find module 'better-sqlite3'",
  },
  {
    name: 'Linux invalid ELF header',
    message: '/home/u/.g/ruflo/node_modules/better-sqlite3/build/Release/better_sqlite3.node: invalid ELF header',
    equals: 'better_sqlite3.node: invalid ELF header',
  },
  {
    name: 'Windows extended-length path',
    message: '\\\\?\\C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ruflo\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node is not a valid Win32 application.',
    equals: 'better_sqlite3.node is not a valid Win32 application.',
  },
];

for (const { name, message, keeps, equals } of LOAD_ERRORS) {
  test(`probeBsq3Runtime keeps the load cause, not its paths: ${name}`, async () => {
    const r = await probeBsq3Runtime('/x', { runner: async () => failure(message) });
    assert.equal(r.ok, false);
    assert.equal(r.state, 'unavailable');
    assert.equal(r.attempts, 1);
    assert.ok(r.reason.length <= 160, `capped at 160 chars (got ${r.reason.length})`);
    assert.doesNotMatch(r.reason, /[\\/](?:Users|home|g|System)[\\/]|node_modules|\n/, `no absolute paths or newlines: ${r.reason}`);
    if (keeps) assert.match(r.reason, keeps);
    if (equals) assert.equal(r.reason, equals);
  });
}

/** A runner that behaves like run() under an AbortSignal: it never answers on
 *  its own and resolves as run() does once the probe's signal aborts. */
function hangingRunner(calls) {
  return (cmd, args, opts) => new Promise((resolve) => {
    calls.push(opts);
    opts.signal.addEventListener('abort', () => resolve({ code: 1, stdout: '', stderr: 'The operation was aborted' }));
  });
}

test('probeBsq3Runtime retries a timed-out probe once, then reports inconclusive', async () => {
  const calls = [];
  const r = await probeBsq3Runtime('/x', { runner: hangingRunner(calls), timeoutMs: 20 });
  assert.equal(calls.length, 2, 'exactly one retry');
  assert.equal(r.ok, false);
  assert.equal(r.state, 'inconclusive');
  assert.equal(r.attempts, 2);
  assert.match(r.reason, /timed out after 2 attempts/);
  for (const opts of calls) {
    assert.ok(opts.signal instanceof AbortSignal, 'the probe owns an AbortSignal');
    assert.ok(opts.timeout > 20, 'run()\'s own timeout is only a backstop behind the signal');
  }
});

/** Ref'd timers only: an unref'd one (AbortSignal.timeout's) is not listed. */
const refdTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('probeBsq3Runtime keeps the process alive while an attempt waits on its deadline', async () => {
  // Node 22's test runner cancels a test once nothing holds the loop open; 24 and
  // 26 do not, so count the probe's own ref'd timer to pin this on every Node.
  const pending = [];
  const baseline = refdTimers();
  const hang = hangingRunner([]);
  const runner = (cmd, args, opts) => { pending.push(refdTimers()); return hang(cmd, args, opts); };
  await probeBsq3Runtime('/x', { runner, timeoutMs: 20 });
  assert.equal(pending.length, 2);
  for (const count of pending) assert.ok(count > baseline, `a ref'd deadline timer while the attempt waits (${count} vs ${baseline})`);
});

test('probeBsq3Runtime clears its deadline timer once the attempt settles', async () => {
  const baseline = refdTimers();
  const r = await probeBsq3Runtime('/x', { runner: async () => ({ code: 0, stdout: '', stderr: '' }), timeoutMs: 60_000 });
  assert.equal(r.state, 'native');
  assert.equal(refdTimers(), baseline, 'no deadline timer outlives a probe that answered in time');
});

test('probeBsq3Runtime passes when the retry after a timeout loads', async () => {
  const calls = [];
  const hang = hangingRunner(calls);
  const runner = (cmd, args, opts) => (calls.length === 0 ? hang(cmd, args, opts)
    : (calls.push(opts), Promise.resolve({ code: 0, stdout: '', stderr: '' })));
  const r = await probeBsq3Runtime('/x', { runner, timeoutMs: 20 });
  assert.deepEqual(r, { ok: true, state: 'native', attempts: 2 });
});

test('probeBsq3Runtime never retries a failure that was not a timeout', async () => {
  let calls = 0;
  // run() on a crashed child: no diagnostic, stderr is execFile's "Command failed" text.
  const runner = async () => {
    calls += 1;
    return { code: 1, stdout: '', stderr: "Command failed: node -e try{const D=require(require.resolve('better-sqlite3'" };
  };
  const r = await probeBsq3Runtime('/x', { runner, timeoutMs: 20 });
  assert.equal(calls, 1);
  assert.equal(r.state, 'inconclusive');
  assert.equal(r.attempts, 1);
  assert.doesNotMatch(r.reason, /Command failed|require\(/, 'the probe source is not a cause');
  assert.match(r.reason, /without a diagnostic/);
});

test('probeBsq3Runtime treats timeout words in stderr as text, not as a timeout', async () => {
  let calls = 0;
  const runner = async () => { calls += 1; return { code: 1, stdout: '', stderr: 'Error: connect ETIMEDOUT\n' }; };
  const r = await probeBsq3Runtime('/x', { runner, timeoutMs: 1000 });
  assert.equal(calls, 1, 'only an aborted signal means the probe timed out');
  assert.equal(r.state, 'inconclusive');
  assert.equal(r.reason, 'Error: connect ETIMEDOUT');
});

test('probeBsq3Runtime reports a runner that throws as inconclusive', async () => {
  const r = await probeBsq3Runtime('/x', { runner: async () => { throw new Error('spawn node ENOENT'); } });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'inconclusive');
  assert.equal(r.reason, 'spawn node ENOENT');
});

// ── P3: status rows per probe state ────────────────────────────────────────

const ctx = (context, extra) => ({ context, dir: `/g/ruflo/node_modules/@claude-flow/${context}`, ...extra });

test('runtime rows: every context native is one ok row', () => {
  const rows = nativesSection.runtimeNativeRows({ installed: true, contexts: [
    ctx('memory', { ok: true, state: 'native' }), ctx('cli', { ok: true, state: 'native' }),
  ] });
  assert.deepEqual(rows.map((r) => [r.level, r.message, r.fix]),
    [['ok', 'ruflo memory runtime native (memory, cli)', null]]);
});

test('runtime rows: a missing binding names the cause and keeps sync\'s build fix', () => {
  const [r] = nativesSection.runtimeNativeRows({ installed: true, contexts: [
    ctx('memory', { ok: true, state: 'native' }),
    ctx('cli', { ok: false, state: 'unavailable', reason: 'Could not locate the bindings file.', bindingPresent: false }),
  ] });
  assert.equal(r.level, 'fail');
  assert.match(r.message, /WASM fallback \(@claude-flow\/cli\)/);
  assert.match(r.message, /Could not locate the bindings file\./);
  assert.equal(r.fix, 'sync builds the native binding', 'heal builds a missing binding');
});

test('runtime rows: a present binding that will not load is rebuilt by sync', () => {
  const [r] = nativesSection.runtimeNativeRows({ installed: true, contexts: [
    ctx('cli', { ok: false, state: 'unavailable', reason: 'better_sqlite3.node: invalid ELF header', bindingPresent: true }),
  ] });
  assert.equal(r.level, 'fail');
  assert.match(r.message, /present but will not load/);
  assert.match(r.message, /invalid ELF header/);
  assert.doesNotMatch(r.message, /by hand|npm run install/, 'no manual step once sync performs it');
  assert.equal(r.fix, 'sync rebuilds the native binding', 'the natives heal load-tests and rebuilds it');
});

test('runtime rows: an inconclusive probe is an unverified warning with no fix', () => {
  const rows = nativesSection.runtimeNativeRows({ installed: true, contexts: [
    ctx('memory', { ok: false, state: 'inconclusive', reason: 'native probe timed out after 2 attempts', bindingPresent: true }),
    ctx('cli', { ok: false, state: 'unavailable', reason: 'Could not locate the bindings file.', bindingPresent: false }),
  ] });
  assert.equal(rows.length, 2, 'one row per context that is not native');
  const [memory] = rows;
  assert.equal(memory.level, 'warn');
  assert.match(memory.message, /unverified \(@claude-flow\/memory\)/);
  assert.match(memory.message, /timed out after 2 attempts/);
  assert.doesNotMatch(memory.message, /WASM fallback \(/, 'no claim the runtime fell back');
  assert.equal(memory.fix, null, 'sync never rebuilds on an inconclusive probe');
});

test('runtime rows: absent ruflo or no contexts add no row', () => {
  assert.deepEqual(nativesSection.runtimeNativeRows({ installed: false, contexts: [] }), []);
  assert.deepEqual(nativesSection.runtimeNativeRows({ installed: true, contexts: [] }), []);
});

// #237 §F: `ak sync` fails a planned repair that did not take, so a fix no
// step performs would fail every sync. Sync installs only a MISSING ruflo (its
// versions row carries that fix); nothing puts agentdb back into a present one.
test('no agentdb locations: a present ruflo needs a manual reinstall, an absent one defers to versions', async () => {
  const present = fakeGlobalTree({ contexts: [] });
  writePkg(path.join(present.g, 'ruflo'), { name: 'ruflo', version: '9.9.9' });
  const [presentRow] = await nativesSection.default.collect();
  present.cleanup();
  assert.match(presentRow.message, /no agentdb locations/);
  assert.equal(presentRow.repair, 'manual', 'no sync step reinstalls a present ruflo');
  assert.match(presentRow.fix, /npm install -g ruflo@latest/);

  const g = tmp('ak-rt-noruflo-');
  _setGlobalRootForTest(g);
  const [absentRow] = await nativesSection.default.collect();
  _setGlobalRootForTest(null); rm(g);
  assert.match(absentRow.message, /ruflo is not installed/);
  assert.equal(absentRow.fix, null, 'the versions row owns the install; no second plan item');
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

// ── Task 4: evidence-backed refresh (Ruling A/B) ────────────────────────────

/** Seed a fresh, matching evidence record for one context, as a real probe +
 *  writeEvidence would leave it. */
function seedEvidence(context, dir, result, { now } = {}) {
  writeEvidence('native-runtime', context, {
    source: 'test',
    inputsKey: stableInputsKey({ dir, native: bsq3IsNative(dir) }),
    inputs: { dir, native: bsq3IsNative(dir) },
    result: { ok: true, state: 'native', attempts: 1, reason: null, bindingPresent: bsq3IsNative(dir), ...result },
  }, { now });
}

test('rufloRuntimeNatives({ refresh: false }) reuses fresh, matching evidence and never spawns', async () => {
  const { nm, cleanup } = fakeGlobalTree();
  resetEvidence();
  for (const context of ['memory', 'cli']) {
    seedEvidence(context, path.join(nm, '@claude-flow', context));
  }
  let spawned = false;
  const rt = await rufloRuntimeNatives({ refresh: false, runner: async () => { spawned = true; return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(spawned, false, 'fresh, matching cached evidence: no spawn');
  assert.equal(rt.installed, true);
  for (const c of rt.contexts) {
    assert.equal(c.ok, true);
    assert.equal(c.state, 'native');
    assert.equal(c.attempts, 1);
  }
  cleanup();
  resetEvidence();
});

test('rufloRuntimeNatives({ refresh: true }) spawns and writes evidence a later refresh:false read can reuse', async () => {
  const { nm, cleanup } = fakeGlobalTree({ contexts: ['memory'] });
  resetEvidence();
  const dir = path.join(nm, '@claude-flow', 'memory');
  let spawned = false;
  const rt = await rufloRuntimeNatives({
    refresh: true,
    runner: async () => { spawned = true; return { code: 0, stdout: '', stderr: '' }; },
  });
  assert.equal(spawned, true, 'refresh:true always probes');
  assert.equal(rt.contexts[0].state, 'native');
  const record = readEvidence('native-runtime', 'memory', { inputsKey: stableInputsKey({ dir, native: bsq3IsNative(dir) }) });
  assert.ok(record, 'evidence was written after the probe');
  assert.equal(record.result.ok, true);
  assert.equal(record.result.state, 'native');
  cleanup();
  resetEvidence();
});

test('rufloRuntimeNatives({ refresh: false }) re-probes when cached evidence is older than 6h', async () => {
  const { nm, cleanup } = fakeGlobalTree({ contexts: ['memory'] });
  resetEvidence();
  const dir = path.join(nm, '@claude-flow', 'memory');
  seedEvidence('memory', dir, {}, { now: Date.now() - 7 * 3600_000 });
  let spawned = false;
  const rt = await rufloRuntimeNatives({
    refresh: false,
    runner: async () => { spawned = true; return { code: 0, stdout: '', stderr: '' }; },
  });
  assert.equal(spawned, true, 'evidence older than the 6h window must not suppress the probe');
  assert.equal(rt.contexts[0].state, 'native');
  cleanup();
  resetEvidence();
});

test('rufloRuntimeNatives({ refresh: false }) re-probes when bsq3IsNative(dir) changed (invalidated inputsKey)', async () => {
  const { nm, cleanup } = fakeGlobalTree({ contexts: ['memory'] });
  resetEvidence();
  const dir = path.join(nm, '@claude-flow', 'memory');
  // Evidence recorded while no binding was present at all.
  writeEvidence('native-runtime', 'memory', {
    source: 'test',
    inputsKey: stableInputsKey({ dir, native: false }),
    inputs: { dir, native: false },
    result: { ok: false, state: 'unavailable', attempts: 1, reason: 'no binding', bindingPresent: false },
  });
  // A binding now exists: bsq3IsNative(dir) flips, so the freshly computed
  // inputsKey no longer matches the cached record's.
  const bsq3 = path.join(dir, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(path.join(bsq3, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(bsq3, 'package.json'), JSON.stringify({ name: 'better-sqlite3' }));
  fs.writeFileSync(path.join(bsq3, 'build', 'Release', 'better_sqlite3.node'), '');
  let spawned = false;
  const rt = await rufloRuntimeNatives({
    refresh: false,
    runner: async () => { spawned = true; return { code: 0, stdout: '', stderr: '' }; },
  });
  assert.equal(spawned, true, 'a changed bsq3IsNative(dir) result invalidates the cached inputsKey');
  assert.equal(rt.contexts[0].state, 'native');
  cleanup();
  resetEvidence();
});

test('rufloRuntimeNatives({ refresh: false }) probes when there is no cached evidence yet (first run)', async () => {
  const { cleanup } = fakeGlobalTree({ contexts: ['memory'] });
  resetEvidence();
  let spawned = false;
  const rt = await rufloRuntimeNatives({
    refresh: false,
    runner: async () => { spawned = true; return { code: 0, stdout: '', stderr: '' }; },
  });
  assert.equal(spawned, true, 'no cached evidence at all: probes');
  assert.equal(rt.contexts[0].state, 'native');
  cleanup();
  resetEvidence();
});

// The status section's collect() has no injectable runner, so these two tests
// prove the `refresh` flag actually threads through by breaking PATH (a real
// probe then fails fast with ENOENT instead of hanging) and observing whether
// cached evidence was honored (refresh:false) or ignored (refresh:true).
test('status natives collect({ refresh: false }) reuses fresh cached evidence — no real probe runs', async () => {
  const { nm, cleanup } = fakeGlobalTree();
  resetEvidence();
  for (const context of ['memory', 'cli']) {
    seedEvidence(context, path.join(nm, '@claude-flow', context));
  }
  const prevPath = process.env.PATH;
  process.env.PATH = path.join(nm, 'no-such-bin'); // a real probe would ENOENT immediately
  try {
    const rows = await nativesSection.default.collect({ refresh: false });
    assert.ok(rows.some((r) => r.level === 'ok' && /ruflo memory runtime native/.test(r.message)),
      'the ok row came from cached evidence, not a (broken-PATH) real probe');
  } finally {
    process.env.PATH = prevPath;
    cleanup();
    resetEvidence();
  }
});

test('status natives collect({ refresh: true }) always re-probes, ignoring fresh cached evidence', async () => {
  const { nm, cleanup } = fakeGlobalTree({ contexts: ['memory'] });
  resetEvidence();
  seedEvidence('memory', path.join(nm, '@claude-flow', 'memory'));
  const prevPath = process.env.PATH;
  process.env.PATH = path.join(nm, 'no-such-bin');
  try {
    const rows = await nativesSection.default.collect({ refresh: true });
    assert.ok(rows.some((r) => r.level === 'warn' && /unverified/.test(r.message)),
      'refresh:true ran a real (broken-PATH) probe instead of trusting the fresh cache');
  } finally {
    process.env.PATH = prevPath;
    cleanup();
    resetEvidence();
  }
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
