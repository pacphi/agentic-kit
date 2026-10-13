// Scope contract (P0-08, design #289 "Making it stick", part 3.1): run `ak setup`, `ak sync`
// (which upgrades by default), `ak sync --no-upgrade` and `ak uninstall` against a disposable
// HOME and compare every change to it with the baseline of current user-level writes.
//
// Two layers, both on the scope gate's vocabulary:
//   writes   OutOfScopeWrite: files that change under HOME outside the cache. The tools are
//            absent (PATH holds nothing), so this layer is what ak itself writes.
//   commands OutOfScopeCommand: the argv every external tool is called with, recorded by
//            logging shims on PATH and classified by the gate's own checkCommand(). Nothing
//            real runs, so no network is used and no real `npm install -g` happens.
// A new write or command rule fails the test; so does a baseline entry that no longer happens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, spawnEnv } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import {
  changedPaths, compareToBaseline, explain, loadBaseline, note,
} from './helpers/user-level-writes.mjs';
import { cacheDir } from '../../src/lib/cache-dir.mjs';
import { checkCommand, clearViolations, isInside, violations, withWriteScope } from '../../src/lib/scope-gate.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');
const POSIX = { skip: process.platform === 'win32' ? 'the baseline records the POSIX layout of HOME' : false };
/** `sync --upgrade` is not a flag: sync upgrades unless --no-upgrade. It is run to prove it is refused. */
const SCENARIOS = [['setup', '--yes'], ['sync'], ['sync', '--no-upgrade'], ['uninstall']];
const label = (args) => args.filter((a) => a !== '--yes').join(' ');
const SHIMMED = ['claude', 'codex', 'npm', 'npx', 'ruflo', 'aqe', 'opencode', 'launchctl', 'pnpm', 'git'];
after(() => clearViolations());

// A tool shim: record [name, cwd, ...argv] as one JSON line, print a version (or, for npm, an empty
// global root) when asked, and exit 0.
const SHIM = '#!/usr/bin/env node\n'
  + 'import("node:fs").then(({ appendFileSync }) => {\n'
  + '  const line = [process.argv[1].split("/").pop(), process.cwd(), ...process.argv.slice(2)];\n'
  + '  appendFileSync(process.env.AK_SHIM_LOG, JSON.stringify(line) + "\\n");\n'
  + '  const [, , first, second] = process.argv;\n'
  + '  if (["--version", "-v", "version"].includes(first)) console.log("9.9.9");\n'
  + '  if (line[0] === "npm" && first === "root" && second === "-g") console.log(process.env.AK_SHIM_NPM_ROOT);\n'
  + '});\n';

/** A disposable machine: HOME, a git project that never ran init, and PATH. Every path the child
 *  could write is checked to lie inside it before anything runs. */
function machine(t, { shims }) {
  const root = tempDir('ak-scope-cli', t);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'shim.log');
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'npm-global', 'node_modules'), { recursive: true });
  if (shims) {
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    for (const name of SHIMMED) {
      fs.writeFileSync(path.join(bin, name), SHIM);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
  }
  const env = spawnEnv(home, {
    PATH: bin, NO_COLOR: '1', AK_SHIM_LOG: log, AK_SHIM_NPM_ROOT: path.join(root, 'npm-global', 'node_modules'),
    npm_config_prefix: path.join(root, 'npm-prefix'), npm_config_cache: path.join(root, 'npm-cache'),
    RUVNET_BRAIN_KB: path.join(root, 'brain-kb'), AQE_EMBEDDER_ENDPOINT: '', AQE_EMBEDDER_TOKEN: '',
  });
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
    assert.ok(isInside(root, env[key]), `${key}=${env[key]} is outside the disposable machine`);
  }
  return { root, home, project, env, log };
}

const run = (m, args) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: m.project, env: m.env, encoding: 'utf8', timeout: 120_000,
});

test('setup, sync, sync --no-upgrade and uninstall change HOME only as the baseline lists', POSIX, (t) => {
  const m = machine(t, { shims: false });
  const cache = cacheDir({ env: m.env, home: m.home });
  const allowed = (absolute, isFolder) => isInside(cache, absolute) || (isFolder && isInside(absolute, cache))
    || isInside(path.join(m.home, 'tmp'), absolute);
  const observed = new Map();
  for (const args of SCENARIOS) {
    const before = snapshot(m.home);
    const done = run(m, args);
    assert.equal(done.error, undefined, `${label(args)}: ${done.error}`);
    assert.notEqual(done.status, null, `${label(args)} was killed (${done.signal})`);
    assert.ok(done.status < 2, `${label(args)} exited ${done.status}: ${done.stderr.slice(-400)}`);
    for (const rel of changedPaths(before, m.home, allowed)) note(observed, rel, label(args));
  }
  const result = compareToBaseline(observed, loadBaseline().writes, 'path');
  assert.deepEqual(result, { added: [], stale: [] }, explain('write', result));
});

test('sync --upgrade is refused and writes nothing', POSIX, (t) => {
  const m = machine(t, { shims: false });
  const before = snapshot(m.home);
  const done = run(m, ['sync', '--upgrade']);
  assert.equal(done.status, 2, done.stderr.slice(-300));
  assert.deepEqual(changedPaths(before, m.home, () => false), []);
});

test('the external commands the same four runs make, classified by the scope gate, are the baseline', POSIX, (t) => {
  const m = machine(t, { shims: true });
  const observed = new Map();
  for (const args of SCENARIOS) {
    fs.rmSync(m.log, { force: true });
    const done = run(m, args);
    assert.notEqual(done.status, null, `${label(args)} was killed (${done.signal})`);
    const calls = fs.existsSync(m.log)
      ? fs.readFileSync(m.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    clearViolations();
    // The project is the scope root, as it is for a real run from an opted-in folder.
    for (const [cmd, cwd, ...argv] of calls) withWriteScope({ root: m.project }, () => checkCommand(cmd, argv, cwd));
    for (const v of violations()) note(observed, v.rule, label(args));
    clearViolations();
  }
  const result = compareToBaseline(observed, loadBaseline().commands, 'rule');
  assert.deepEqual(result, { added: [], stale: [] }, explain('command', result));
});
