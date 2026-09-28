// Branch 6a Task 8a: captures, with real command output, exactly which
// checks spawn a subprocess on a plain `ak status` today — before Tasks 2-7
// touch anything. src/commands/status.mjs's collect() runs inside a real
// child Node process launched with `--import` of tests/helpers/spawn-guard.mjs
// (Ruling C: a product-code ledger seam inside exec.mjs would under-count —
// ~30 files spawn child_process directly, not through it), so this catches
// every spawn path regardless of which module makes it, with no product
// code change.
//
// The zero-spawn assertion is wrapped in `test.todo` (Ruling D — never commit
// a red test): Node's test runner runs the body for real and reports the
// outcome, but never fails the suite either way. It is currently RED — there
// are real, unclosed spawn paths today (see the Task 8a report for the
// captured ledger). Task 7 deletes the word `todo` to promote this into a
// real, enforced gate once every spawn path is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnEnv, sandboxProject } from './helpers/home-sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');
const SPAWN_GUARD = path.resolve(PKG_ROOT, 'tests', 'helpers', 'spawn-guard.mjs');
const FIXTURE = path.resolve(PKG_ROOT, 'tests', 'fixtures', 'status-zero-spawn-child.mjs');

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Runs `fn` inside a disposable sandboxed HOME/project, with `extraEnv`
 *  merged into the child's environment. Cleans up unconditionally. */
function inSandbox(prefix, extraEnv, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  const project = sandboxProject(prefix);
  const env = spawnEnv(home, {
    NO_COLOR: '1',
    // No real tool spawn ever succeeds here — the guard still records the
    // attempt before the ENOENT, which is exactly what this test wants to see.
    PATH: path.join(home, 'no-such-bin'),
    ...extraEnv,
  });
  try {
    return fn({ home, project, env });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

test('spawn-guard is a no-op when AK_SPAWN_LEDGER_FILE is unset', () => {
  inSandbox('ak-spawn-guard-noop', {}, ({ project, env }) => {
    // A vacuous "no ledger file exists" check would pass even if the guard
    // patched child_process regardless of the env var — assert the function
    // ITSELF is untouched (native name `spawn`, not our wrapper's `patched`).
    const out = execFileSync(process.execPath, [
      `--import=${SPAWN_GUARD}`, '-e', "process.stdout.write(require('node:child_process').spawn.name)",
    ], { cwd: project, env, encoding: 'utf8' });
    assert.strictEqual(out, 'spawn', 'node:child_process.spawn is left untouched when AK_SPAWN_LEDGER_FILE is unset');
  });
});

test('spawn-guard records a spawn made inside the guarded child, by every wrapped form', () => {
  inSandbox('ak-spawn-guard-smoke', {}, ({ project, env: baseEnv }) => {
    const ledgerFile = path.join(os.tmpdir(), `ak-spawn-guard-smoke-${process.pid}.ndjson`);
    const env = { ...baseEnv, AK_SPAWN_LEDGER_FILE: ledgerFile };
    const forkTarget = path.join(project, 'fork-target.mjs');
    fs.writeFileSync(forkTarget, 'process.exit(0);\n');
    const script = [
      "const { spawnSync, execFileSync: ef, execSync: es, fork } = require('node:child_process');",
      "spawnSync(process.execPath, ['-e', '0']);",
      "ef(process.execPath, ['-e', '0']);",
      'try { es(\'true\'); } catch {}', // shell builtin: exercised even with PATH broken
      `fork(${JSON.stringify(forkTarget)}, [], { stdio: 'ignore' });`,
      'process.exit(0);', // do not wait on the forked grandchild's IPC channel
    ].join(' ');
    execFileSync(process.execPath, [
      `--import=${SPAWN_GUARD}`, '-e', script,
    ], { cwd: project, env, encoding: 'utf8' });
    const lines = readLedger(ledgerFile);
    fs.rmSync(ledgerFile, { force: true });
    assert.strictEqual(lines.length, 4, `expected 4 ledger lines (spawnSync/execFileSync/execSync/fork), got ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.cmd === forkTarget), 'fork() records the module path as cmd');
    assert.ok(lines.filter((l) => l.cmd === process.execPath).length === 2, 'spawnSync and execFileSync both record process.execPath');
    assert.ok(lines.every((l) => typeof l.at === 'string' && !Number.isNaN(Date.parse(l.at))), 'every line has an ISO timestamp');
  });
});

test.todo('plain ak status spawns nothing (native/host/deja-vu/version checks) — see Task 7', () => {
  inSandbox('ak-status-zero-spawn', {}, ({ project, env: baseEnv }) => {
    const ledgerFile = path.join(os.tmpdir(), `ak-status-zero-spawn-${process.pid}.ndjson`);
    const env = { ...baseEnv, AK_SPAWN_LEDGER_FILE: ledgerFile };
    execFileSync(process.execPath, [
      `--import=${SPAWN_GUARD}`, FIXTURE, PKG_ROOT, project,
    ], { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
    const lines = readLedger(ledgerFile);
    fs.rmSync(ledgerFile, { force: true });
    const cmds = [...new Set(lines.map((l) => l.cmd))];
    assert.strictEqual(lines.length, 0,
      `expected zero spawns from a plain status collect(); got ${lines.length}: ${JSON.stringify(cmds)}`);
  });
});
