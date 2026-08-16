// ADR-0031 P3 — external lifecycle execution wired into setup/sync/uninstall.
// A synthetic ADMITTED host ('globex') with real, standalone node-script
// lifecycle hooks (apply/undo — no injected runHook, spawned through the
// REAL hook-runner, same black-box posture as adapter-conformance.test.mjs's
// acme fixture) proves the three command loops now iterate hostsWithLifecycle()
// safely: the hook actually runs and lifecycle-render.mjs's generic one-line
// summary prints, gated by lifecycleExecutionEnabled (cfg enablement AND the
// experimental flag — an admitted host is never exercised without both).
//
// setup.mjs and uninstall.mjs's admitted-host branch is reachable through a
// real command call (setup.run_machine / uninstall.run). sync.mjs's branch
// is additionally gated by `subsystems.has(hostId)`, sourced from
// status.mjs's collect() — which (D4, ADR-0031 P3 tracked follow-up) now
// emits a lean, generic subsystem row (subsystem === hostId) for any admitted
// lifecycle host that lifecycleExecutionEnabled() gates in for this run
// (cfg enablement AND the experimental flag — see status.mjs's
// admittedLifecycleFallbackRows). That closes the gap this file used to
// pin as a documented gap: an admitted host's row now enters sync's plan,
// so its already-wired lifecycle loop body runs for real, exactly like
// setup's and uninstall's below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-external-lifecycle');
const paths = await import('../../src/lib/paths.mjs');
const setup = await import('../../src/commands/setup.mjs');
const sync = await import('../../src/commands/sync.mjs');
const uninstall = await import('../../src/commands/uninstall.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const { validateAdapterManifest } = await import('../../src/lib/adapters/manifest.mjs');
const { applyAdmitted, resetAdmitted } = await import('../../src/lib/adapters/admitted.mjs');
const { registerAdmittedLifecycle, lifecycleAdapterFor } = await import('../../src/lib/adapters/lifecycle-registry.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const FLAG = 'AK_EXPERIMENTAL_HOST_ADAPTERS';

function globexHost(overrides = {}) {
  return {
    id: 'globex',
    label: 'Globex',
    install: { bin: 'globex-cli', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: {
      canDriveSession: false, canBePrimary: false, canRouteActivities: false,
      commandStatusline: false, transcripts: false, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
    trust: { approvalPolicy: 'unchanged', changes: [] },
    enabledByDefault: false,
    configProjection: 'ruflo',
    observability: [],
    ...overrides,
  };
}

/** Writes a real, standalone marker-writing hook script (ESM `.mjs`, no
 *  injected runHook — spawned through the REAL hook-runner) into `dir` under
 *  `filename`, and returns the RELATIVE `[process.execPath, filename]`
 *  command anchored to `dir` via baseDir. The marker path lives in FILE
 *  CONTENT, never a spawn argv element — a `node -e '<script embedding a
 *  JSON-stringified absolute path>'` command used to do the latter, but an
 *  absolute path is full of backslashes and quotes on Windows, exactly what
 *  CreateProcess's argv-quoting algorithm is most likely to mangle. File
 *  content is plain JS source text handed to Node's own parser, never
 *  touched by OS argv quoting, so this sidesteps that risk entirely (and,
 *  as a side effect, the relative filename argument is unambiguous under
 *  the F-1 anchorability check — no embedded '/' from a marker path to be
 *  mistaken for a relative path argument). */
function writeMarkerHook(dir, filename, markerFile, payload) {
  fs.writeFileSync(path.join(dir, filename),
    "import fs from 'node:fs';\n"
    + `fs.writeFileSync(${JSON.stringify(markerFile)}, 'ran');\n`
    + `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
  return [process.execPath, filename];
}

function globexManifest({ applyCommand, undoCommand }) {
  return validateAdapterManifest({
    name: 'globex',
    version: '1.0.0',
    contract: 1,
    host: globexHost(),
    detection: { bin: 'globex-cli' },
    driving: { surfaces: ['acp'] },
    lifecycle: {
      apply: { hook: { command: applyCommand, timeoutMs: 5000 } },
      undo: { hook: { command: undoCommand, timeoutMs: 5000 } },
    },
    trust: {
      changes: [{
        id: 'globex-subprocess-hooks', kind: 'third-party-adapter', scope: 'project',
        owner: 'globex', value: 'subprocess hooks', effect: 'run consented lifecycle hooks for globex',
      }],
    },
  });
}

/** Registers the real (non-injected) lifecycle adapter for 'globex' and
 *  returns the marker paths it will write when its hooks actually run.
 *  These tests are about the command-loop WIRING/gating (does the loop reach
 *  the hook at all), not F-1 anchoring itself — F-1 has its own dedicated
 *  tests below and in lifecycle-registry.test.mjs / adapter-admission.test.mjs
 *  — but `baseDir: tmpDir` is still required here (not optional): the hook
 *  scripts are written INTO tmpDir and referenced by a relative filename, so
 *  tmpDir must be the adapter directory the relative command resolves
 *  against, or the hook simply wouldn't be found. */
function admitGlobex(tmpDir) {
  const applyMarker = path.join(tmpDir, 'apply.marker');
  const undoMarker = path.join(tmpDir, 'undo.marker');
  const applyCommand = writeMarkerHook(tmpDir, 'apply-hook.mjs', applyMarker, {
    ok: true, changed: true, facts: null, actions: ['wired'], ownership: [], warnings: [], errors: [],
  });
  const undoCommand = writeMarkerHook(tmpDir, 'undo-hook.mjs', undoMarker, {
    ok: true, changed: true, facts: null, actions: ['unwired'], ownership: [], warnings: [], errors: [],
  });
  applyAdmitted([{ entry: globexHost() }]);
  registerAdmittedLifecycle(globexManifest({ applyCommand, undoCommand }), { baseDir: tmpDir });
  return { applyMarker, undoMarker };
}

/** Prepend a fake `globex-cli` bin to PATH for the duration of `fn` — plays
 *  the installed CLI for detection.bin's `have()` probe. /usr/bin:/bin ride
 *  along for the underlying `which` call itself.
 *
 *  Cross-OS shim, mirroring setup-command.test.mjs's own withOpencodeCli
 *  exactly: a bare, extensionless, chmod+x file satisfies POSIX `which`, but
 *  `have()`'s Windows path (exec.mjs's resolveShim) walks PATHEXT looking
 *  for a `.com`/`.exe`/no-ext file OR a `.cmd` shim with a `.ps1` sidecar —
 *  an extensionless file alone is invisible to it there. All three variants
 *  are written unconditionally (not gated on process.platform): harmless
 *  extras on POSIX, load-bearing on Windows. */
async function withGlobexCli(fn) {
  const bin = path.join(HOME, `fake-bin-globex-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'globex-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'globex-cli.cmd'), '@echo off\r\nexit /b 0\r\n');
  fs.writeFileSync(path.join(bin, 'globex-cli.ps1'), 'exit 0\r\n');
  const prev = process.env.PATH;
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  try { return await fn(); } finally { process.env.PATH = prev; rmrf(bin); }
}

function seedHome(cfg) {
  rmrf(paths.claudeDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  writeKitConfig(HOME, cfg);
}

function cfgWithGlobex(enabled) {
  return offlineKitConfig({
    integrations: { version: 2, hosts: { globex: enabled }, bindings: [], ownership: {} },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {},
  });
}

// ── setup: run_machine's lifecycle loop drives an admitted host ────────────

test('setup.run_machine runs the admitted host\'s apply hook and prints the generic report when enabled + flag on', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-setup-'));
  const prevFlag = process.env[FLAG];
  seedHome(cfgWithGlobex(true));
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));
  process.env[FLAG] = '1';
  try {
    const { applyMarker } = admitGlobex(tmpDir);
    const cfg = loadKitConfig();
    const { result, out } = await withGlobexCli(() => captureLog(() =>
      setup.run_machine({ flags: {}, pkgRoot: PKG_ROOT, cfg })));
    assert.equal(result, true, out);
    assert.ok(fs.existsSync(applyMarker), 'the admitted host\'s real apply hook subprocess must have run');
    assert.match(out, /globex: applied — 1 action\(s\)/, `expected the generic one-line summary; got:\n${out}`);
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(tmpDir);
  }
});

test('setup.run_machine skips the admitted host when the experimental flag is off (cfg enabled)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-setup-noflag-'));
  const prevFlag = process.env[FLAG];
  seedHome(cfgWithGlobex(true));
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));
  delete process.env[FLAG];
  try {
    const { applyMarker } = admitGlobex(tmpDir);
    const cfg = loadKitConfig();
    const { result, out } = await withGlobexCli(() => captureLog(() =>
      setup.run_machine({ flags: {}, pkgRoot: PKG_ROOT, cfg })));
    assert.equal(result, true, out);
    assert.ok(!fs.existsSync(applyMarker), 'flag off — the admitted host\'s hook must never run');
    assert.doesNotMatch(out, /globex:/, 'no report line for a host that was never exercised');
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(tmpDir);
  }
});

test('setup.run_machine skips the admitted host when cfg never enabled it (flag on)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-setup-notenabled-'));
  const prevFlag = process.env[FLAG];
  seedHome(cfgWithGlobex(false)); // enrolled in kit.json but never enabled
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));
  process.env[FLAG] = '1';
  try {
    const { applyMarker } = admitGlobex(tmpDir);
    const cfg = loadKitConfig();
    const { result, out } = await withGlobexCli(() => captureLog(() =>
      setup.run_machine({ flags: {}, pkgRoot: PKG_ROOT, cfg })));
    assert.equal(result, true, out);
    assert.ok(!fs.existsSync(applyMarker), 'never enabled — the admitted host\'s hook must never run');
    assert.doesNotMatch(out, /globex:/);
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(tmpDir);
  }
});

test('setup.run_machine skips the admitted host (enabled + flag on) when its CLI is absent — no config fabricated', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-setup-absent-'));
  const prevFlag = process.env[FLAG];
  seedHome(cfgWithGlobex(true));
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));
  process.env[FLAG] = '1';
  try {
    const { applyMarker } = admitGlobex(tmpDir);
    const cfg = loadKitConfig();
    // No withGlobexCli() wrapper here — globex-cli is not on PATH.
    const { result, out } = await captureLog(() => setup.run_machine({ flags: {}, pkgRoot: PKG_ROOT, cfg }));
    assert.equal(result, true, out);
    assert.ok(!fs.existsSync(applyMarker), 'CLI absent — the hook must never run');
    assert.match(out, /globex: enabled but CLI not installed — wiring skipped/);
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(tmpDir);
  }
});

// ── uninstall: the teardown loop drives an admitted host's undo hook ───────

test('uninstall.run runs the admitted host\'s undo hook and prints the generic report when enabled + flag on', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-uninstall-'));
  const prevFlag = process.env[FLAG];
  seedHome(cfgWithGlobex(true));
  process.env[FLAG] = '1';
  try {
    const { undoMarker } = admitGlobex(tmpDir);
    const { result, out } = await captureLog(() => uninstall.run({ flags: { yes: true } }));
    assert.equal(result, 0, out);
    assert.ok(fs.existsSync(undoMarker), 'the admitted host\'s real undo hook subprocess must have run');
    assert.match(out, /globex: undo complete — 1 action\(s\)/, `expected the generic one-line summary; got:\n${out}`);
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(tmpDir);
  }
});

test('uninstall.run skips the admitted host\'s undo when the experimental flag is off', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-uninstall-noflag-'));
  const prevFlag = process.env[FLAG];
  seedHome(cfgWithGlobex(true));
  delete process.env[FLAG];
  try {
    const { undoMarker } = admitGlobex(tmpDir);
    const { result, out } = await captureLog(() => uninstall.run({ flags: { yes: true } }));
    assert.equal(result, 0, out);
    assert.ok(!fs.existsSync(undoMarker), 'flag off — the admitted host\'s undo hook must never run');
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(tmpDir);
  }
});

test('uninstall.run --dry-run reports the admitted host generically and runs nothing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-uninstall-dry-'));
  const prevFlag = process.env[FLAG];
  seedHome(cfgWithGlobex(true));
  process.env[FLAG] = '1';
  try {
    const { undoMarker } = admitGlobex(tmpDir);
    const { result, out } = await captureLog(() => uninstall.run({ flags: { yes: true, 'dry-run': true } }));
    assert.equal(result, 0, out);
    assert.ok(!fs.existsSync(undoMarker), 'dry-run must never invoke a real hook');
    assert.match(out, /\[dry-run\] stripped ak-managed globex wiring \+ artifacts \(hook-declared undo\)/);
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(tmpDir);
  }
});

// ── sync: the admitted-host lifecycle branch is reachable (D4) ─────────────

test('sync.run exercises an admitted host\'s lifecycle hook now that status.mjs emits its subsystem row (D4 closes the ADR-0031 P3 gap)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-sync-'));
  const prevFlag = process.env[FLAG];
  seedHome(cfgWithGlobex(true));
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));
  process.env[FLAG] = '1';
  try {
    const { applyMarker } = admitGlobex(tmpDir);
    const { out } = await withGlobexCli(() => captureLog(() => sync.run({ flags: {}, pkgRoot: PKG_ROOT })));
    assert.ok(fs.existsSync(applyMarker),
      'status.mjs now emits a subsystem row for an admitted lifecycle host that lifecycleExecutionEnabled() gates '
      + 'in, so subsystems.has(\'globex\') is true and sync\'s already-wired admitted-host branch runs for real');
    assert.match(out, /globex: applied — 1 action\(s\)/, `expected the generic one-line summary; got:\n${out}`);
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(tmpDir);
  }
});

// ── opencode is unaffected by an admitted host sharing the same loop ───────

test('opencode\'s own lifecycle wiring is unaffected when an admitted host is ALSO registered but not enabled', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-opencode-'));
  const prevFlag = process.env[FLAG];
  const cfg = offlineKitConfig({
    integrations: { version: 2, hosts: { opencode: false, globex: false }, bindings: [], ownership: {} },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {},
  });
  seedHome(cfg);
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));
  process.env[FLAG] = '1';
  try {
    const { applyMarker } = admitGlobex(tmpDir);
    const liveCfg = loadKitConfig();
    const { result, out } = await captureLog(() => setup.run_machine({ flags: {}, pkgRoot: PKG_ROOT, cfg: liveCfg }));
    assert.equal(result, true, out);
    assert.ok(!fs.existsSync(applyMarker), 'globex disabled — its hook must not run even though it is registered');
    assert.doesNotMatch(out, /globex:|opencode:/, 'neither host is enabled — the lifecycle loop body never executes');
    assert.notEqual(lifecycleAdapterFor('opencode'), null, 'opencode\'s own registered adapter is untouched');
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(tmpDir);
  }
});

// ── F-1 (ADR-0031 P3, critical fix): a same-named script planted in the
// operator's cwd must never run — a relative lifecycle hook command resolves
// against the admitted host's OWN manifest directory, never wherever `ak`
// happened to be invoked from. This is the full black-box repro (a real
// command entry point, a real subprocess, real files on disk — no injected
// runHook) proving the fix end-to-end, not just at the unit/bootstrap level
// (see lifecycle-registry.test.mjs and adapter-admission.test.mjs for those).

test('F-1: setup.run_machine anchors a relative apply hook to the adapter directory — a same-named script planted in the operator cwd never runs', async () => {
  const adapterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-f1-adapter-'));
  const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ext-lifecycle-f1-decoy-'));
  const prevFlag = process.env[FLAG];
  const prevCwd = process.cwd();
  const realMarker = path.join(adapterDir, 'real.marker');
  const decoyMarker = path.join(decoyDir, 'decoy.marker');
  try {
    // The REAL hook, on disk in the adapter's own directory — the one F-1
    // must resolve the relative `apply-hook.mjs` argument against. A `.mjs`
    // file is ESM (no `require`), so `node:fs` is imported, not required.
    fs.writeFileSync(path.join(adapterDir, 'apply-hook.mjs'),
      "import fs from 'node:fs';\n"
      + `fs.writeFileSync(${JSON.stringify(realMarker)}, 'ran');\n`
      + "process.stdout.write(JSON.stringify({ok:true,changed:true,actions:['wired'],ownership:[],warnings:[],errors:[]}));\n");
    // A DECOY, same relative filename, planted where an attacker controlling
    // the operator's cwd would place it — must NEVER be the one that runs.
    fs.writeFileSync(path.join(decoyDir, 'apply-hook.mjs'),
      "import fs from 'node:fs';\n"
      + `fs.writeFileSync(${JSON.stringify(decoyMarker)}, 'ran');\n`
      + "process.stdout.write(JSON.stringify({ok:false,changed:false,actions:[],ownership:[],warnings:[],errors:['decoy ran']}));\n");

    seedHome(cfgWithGlobex(true));
    paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));
    process.env[FLAG] = '1';

    const manifestPath = path.join(adapterDir, 'manifest.json');
    // process.execPath (absolute), not the bare token 'node' — the fake PATH
    // withGlobexCli sets up has no real node on it; using the interpreter's
    // own absolute path sidesteps that while still exercising exactly the
    // vulnerable argument (the RELATIVE 'apply-hook.mjs' script name).
    const manifest = validateAdapterManifest({
      name: 'globex', version: '1.0.0', contract: 1,
      host: globexHost(),
      detection: { bin: 'globex-cli' },
      driving: { surfaces: ['acp'] },
      lifecycle: { apply: { hook: { command: [process.execPath, 'apply-hook.mjs'] } } },
      trust: {
        changes: [{
          id: 'globex-subprocess-hooks', kind: 'third-party-adapter', scope: 'project',
          owner: 'globex', value: 'subprocess hooks', effect: 'run consented lifecycle hooks for globex',
        }],
      },
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const { bootstrapHostAdapters, hashManifest } = await import('../../src/lib/adapters/admission.mjs');
    const hash = hashManifest(manifest);
    const bootstrap = await bootstrapHostAdapters({
      cfg: { hostAdapters: [{ name: 'globex', source: manifestPath }] },
      env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
      readManifest: async () => manifest,
      consent: { recordedHashFor: () => hash, isTrusted: () => true },
    });
    assert.deepEqual(bootstrap.warnings, [], `expected no warnings; got ${JSON.stringify(bootstrap.warnings)}`);

    // The operator's cwd is the DECOY directory for the whole run — the
    // exact scenario F-1 closes: an attacker who can influence where `ak` is
    // invoked from plants a same-named file, hoping a relative hook command
    // resolves against it instead of the adapter's own directory.
    process.chdir(decoyDir);
    const cfg = loadKitConfig();
    const { result, out } = await withGlobexCli(() => captureLog(() =>
      setup.run_machine({ flags: {}, pkgRoot: PKG_ROOT, cfg })));
    assert.equal(result, true, out);
    assert.ok(fs.existsSync(realMarker), 'the REAL hook (adapter directory) must have run');
    assert.ok(!fs.existsSync(decoyMarker), 'the DECOY hook (operator cwd) must NEVER have run');
    assert.match(out, /globex: applied — 1 action\(s\)/);
  } finally {
    process.chdir(prevCwd);
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    resetAdmitted();
    rmrf(adapterDir);
    rmrf(decoyDir);
  }
});

test.after(() => rmrf(HOME));
