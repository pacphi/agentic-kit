// Branch 6a Task 8a built this harness: src/commands/status.mjs's collect()
// runs inside a real child Node process launched with `--import` of
// tests/helpers/spawn-guard.mjs (Ruling C: a product-code ledger seam inside
// exec.mjs would under-count — ~30 files spawn child_process directly, not
// through it), so every spawn path is caught regardless of which module
// makes it, with no product code change.
//
// Task 7 closed every remaining spawn path on a plain `ak status` (native
// runtime, host setup/launch, deja-vu, version drift, npm's global root, the
// daemon process sweep, the ak-launcher-availability check) and promotes the
// zero-spawn assertion from `test.todo` (Ruling D — never commit a red test)
// to a real, enforced gate. A single fresh-sandbox collect() call can never
// show zero spawns (Ruling A requires a first probe on a cold cache), so the
// fixture (tests/fixtures/status-zero-spawn-child.mjs) now makes three calls
// in the SAME child process/state dir and marks the ledger between them:
// cold cache (probes), warm cache (the enforced zero-spawn assertion), and
// `refresh: true` (always probes again, even warm).
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

// A ledger line from the fixture's own npm registry lookups
// (`npm view <pkg>@<tag> version`) — versions.mjs's driftReport()/selfDrift()
// TTL cache (kit.json `versionCheck`, pre-dating this branch and explicitly
// out of this task's scope: "don't touch the version-drift library functions
// again") only persists after AT LEAST ONE live fetch succeeds — by design,
// so a total npm outage is never mistaken for "confirmed nothing changed"
// (see the comment on driftReport()). This sandbox's PATH is deliberately
// broken so every spawn ENOENTs (that is what makes the ledger deterministic
// for every OTHER gated check), which means npm can never succeed here and
// that TTL cache can never go warm inside this specific harness — proven
// correct instead, with an injectable fetchLatest that DOES succeed, by
// tests/kit/status-version-drift-refresh.test.mjs. This predicate names that
// one documented exception so the warm-cache assertion below still catches
// every OTHER unclosed spawn path.
const isVersionDriftLookup = (line) => line.cmd === 'npm' && line.args?.[0] === 'view';

/** Splits a ledger that spans multiple collect() calls at the fixture's
 *  `__CALL_BOUNDARY_<label>__` marker lines. Returns the lines strictly
 *  between the previous boundary (or the start) and each named boundary. */
function sliceByCallBoundary(lines, labels) {
  const slices = {};
  let start = 0;
  for (const label of labels) {
    const marker = `__CALL_BOUNDARY_${label}__`;
    const end = lines.findIndex((l, i) => i >= start && l.cmd === marker);
    assert.ok(end >= start, `ledger is missing the ${marker} boundary — got ${JSON.stringify(lines.map((l) => l.cmd))}`);
    slices[label] = lines.slice(start, end);
    start = end + 1;
  }
  return slices;
}

test('plain ak status spawns nothing on a warm cache; --refresh always re-probes', () => {
  inSandbox('ak-status-zero-spawn', {}, ({ project, env: baseEnv }) => {
    const ledgerFile = path.join(os.tmpdir(), `ak-status-zero-spawn-${process.pid}.ndjson`);
    const env = { ...baseEnv, AK_SPAWN_LEDGER_FILE: ledgerFile };
    execFileSync(process.execPath, [
      `--import=${SPAWN_GUARD}`, FIXTURE, PKG_ROOT, project,
    ], { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
    const lines = readLedger(ledgerFile);
    fs.rmSync(ledgerFile, { force: true });

    const { first, second, third } = sliceByCallBoundary(lines, ['first', 'second', 'third']);

    // Cold cache (no pre-existing evidence): Ruling A says a plain collect()
    // probes once per gated kind. A RED-baseline sanity check, not the
    // enforced assertion below.
    assert.ok(first.length > 0, `sanity: a cold-cache first call is expected to probe at least once; got ${JSON.stringify(first)}`);

    // The real, enforced gate: a second collect() call, same warm evidence
    // cache (written by the first call, in the same state dir), spawns
    // nothing unexplained.
    const secondUnexplained = second.filter((l) => !isVersionDriftLookup(l));
    assert.strictEqual(secondUnexplained.length, 0,
      `expected zero unexplained spawns from a warm-cache collect(); got ${JSON.stringify(secondUnexplained.map((l) => [l.cmd, l.args]))}`);

    // `refresh: true` must still force a fresh probe even with a warm cache.
    assert.ok(third.length > 0, `--refresh must re-probe even with a warm cache; got ${JSON.stringify(third)}`);
  });
});
