// This harness covers src/commands/status.mjs's collect()
// runs inside a real child Node process launched with `--import` of
// tests/helpers/spawn-guard.mjs (Ruling C: a product-code ledger seam inside
// exec.mjs would under-count — ~30 files spawn child_process directly, not
// through it), so every spawn path is caught regardless of which module
// makes it, with no product code change.
//
// Evidence caching closed every remaining spawn path on a plain `ak status` (native
// runtime, host setup/launch, version drift, npm's global root, the
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
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnEnv, sandboxProject } from './helpers/home-sandbox.mjs';
import { acquireRunRootHold, releaseRunRootHold } from '../../scripts/run-roots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');
// `--import` takes a module URL: a bare Windows path parses as a `d:` scheme.
const SPAWN_GUARD_URL = pathToFileURL(path.resolve(PKG_ROOT, 'tests', 'helpers', 'spawn-guard.mjs')).href;
const FIXTURE = path.resolve(PKG_ROOT, 'tests', 'fixtures', 'status-zero-spawn-child.mjs');

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitUntil(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return check();
}

async function waitFor(promise, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('owned process did not close')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function processGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** Runs `fn` inside a disposable sandboxed HOME/project, with `extraEnv`
 *  merged into the child's environment. Retains both roots when a child may still use them. */
async function inSandbox(prefix, extraEnv, fn) {
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
  let result;
  let failure;
  let retained = false;
  try { result = await fn({ home, project, env, retain: () => { retained = true; } }); }
  catch (error) { failure = error; }
  if (retained) throw failure ?? new Error(`retained uncertain sandbox: ${home}, ${project}`);
  for (const root of [home, project]) {
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'sandbox assertion and cleanup failed') : error; }
  }
  if (failure) throw failure;
  return result;
}

test('spawn-guard is a no-op when AK_SPAWN_LEDGER_FILE is unset', async () => {
  await inSandbox('ak-spawn-guard-noop', {}, ({ project, env }) => {
    // A vacuous "no ledger file exists" check would pass even if the guard
    // patched child_process regardless of the env var — assert the function
    // ITSELF is untouched (native name `spawn`, not our wrapper's `patched`).
    const out = execFileSync(process.execPath, [
      `--import=${SPAWN_GUARD_URL}`, '-e', "process.stdout.write(require('node:child_process').spawn.name)",
    ], { cwd: project, env, encoding: 'utf8' });
    assert.strictEqual(out, 'spawn', 'node:child_process.spawn is left untouched when AK_SPAWN_LEDGER_FILE is unset');
  });
});

async function runGuardedSmoke({ childExitCode = 0, childStallsOnRelease = false,
  closeTimeoutMs = 5_000, launchFailure = false } = {}) {
  // The guarded runner must know about uncertainty before any process uses
  // its temp root. Standalone node --test has no runner hold to acquire.
  const hold = acquireRunRootHold();
  await inSandbox('ak-spawn-guard-smoke', {}, async ({ project, env: baseEnv, retain }) => {
    const ledgerFile = path.join(project, 'spawn-ledger.ndjson');
    const readyFile = path.join(project, 'fork-ready');
    const releaseFile = path.join(project, 'fork-release');
    const doneFile = path.join(project, 'fork-done');
    const pidFile = path.join(project, 'fork-pid');
    const attemptFile = path.join(project, 'fork-attempt');
    const waitingFile = path.join(project, 'parent-waiting-for-fork');
    const parentAckFile = path.join(project, 'fork-closed-by-parent');
    const env = { ...baseEnv, AK_SPAWN_LEDGER_FILE: ledgerFile };
    const forkTarget = path.join(project, 'fork-target.cjs');
    fs.writeFileSync(forkTarget, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
      `const release = ${JSON.stringify(releaseFile)};`,
      'const timer = setInterval(() => {',
      '  if (!fs.existsSync(release)) return;',
      `  fs.writeFileSync(${JSON.stringify(doneFile)}, 'done');`,
      ...(childStallsOnRelease ? ['  return;'] : []),
      '  clearInterval(timer);',
      `  process.exit(${childExitCode});`,
      '}, 10);',
    ].join('\n'));
    const script = [
      'async function main() {',
      "const { spawnSync, execFileSync: ef, execSync: es, fork } = require('node:child_process');",
      "spawnSync(process.execPath, ['-e', '0']);",
      "ef(process.execPath, ['-e', '0']);",
      'try { es(\'true\'); } catch {}', // shell builtin: exercised even with PATH broken
      `require('node:fs').writeFileSync(${JSON.stringify(attemptFile)}, 'attempt');`,
      `const child = fork(${JSON.stringify(forkTarget)}, [], { stdio: 'ignore' });`,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      `require('node:fs').writeFileSync(${JSON.stringify(waitingFile)}, 'waiting');`,
      'await new Promise((resolve, reject) => {',
      '  child.once("error", reject);',
      '  child.once("close", (code, signal) => code === 0 && !signal',
      '    ? resolve() : reject(new Error(`fork failed: code=${code}, signal=${signal}`)));',
      '});',
      'if (child.exitCode !== 0 || child.signalCode) throw new Error("fork has not exited cleanly");',
      `require('node:fs').writeFileSync(${JSON.stringify(parentAckFile)}, 'fork closed');`,
      '}',
      'main().catch((error) => { console.error(error); process.exitCode = 1; });',
    ].join(' ');
    const guarded = spawn(launchFailure ? path.join(project, 'missing-node') : process.execPath, [
      `--import=${SPAWN_GUARD_URL}`, '-e', script,
    ], { cwd: project, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let launchError;
    guarded.once('error', (error) => { launchError = error; });
    guarded.stderr.on('data', (chunk) => { stderr += chunk; });
    let closed = false;
    const parentClose = new Promise((resolve) => guarded.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    }));
    let failure;
    try {
      await waitUntil(() => (fs.existsSync(waitingFile) && fs.existsSync(readyFile)) || closed || launchError);
      if (launchError) throw launchError;
      assert.ok(fs.existsSync(waitingFile), `guarded parent did not reach fork wait: ${stderr}`);
      assert.ok(fs.existsSync(readyFile), `fork did not become ready: ${stderr}`);
      // A premature parent may write its acknowledgment or close on a later
      // event-loop turn. Give those events time to surface before release.
      await waitUntil(() => fs.existsSync(parentAckFile) || closed, 300);
      assert.ok(!fs.existsSync(parentAckFile), 'parent acknowledged fork close before child release');
      assert.ok(!closed, 'guarded parent exited while its owned fork was still running');
    } catch (error) { failure = error; }
    const cleanupErrors = [];
    let parentExited = closed;
    let pid = NaN;
    try { fs.writeFileSync(releaseFile, 'release'); } catch (error) { cleanupErrors.push(error); }
    try { pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : NaN; }
    catch (error) { cleanupErrors.push(error); }
    try { await waitFor(parentClose, closeTimeoutMs); parentExited = true; }
    catch {
      // Keep the guarded parent alive to receive its own fork's close event.
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error); }
      }
      try { await waitFor(parentClose, closeTimeoutMs); parentExited = true; }
      catch {
        if (!closed) guarded.kill();
        try { await waitFor(parentClose, closeTimeoutMs); parentExited = true; }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    parentExited ||= closed;
    // The acknowledgment is written only after the guarded parent receives
    // its fork's close event. Otherwise require independent OS exit evidence.
    let forkExited = fs.existsSync(parentAckFile) || (!fs.existsSync(attemptFile) && parentExited)
      || await waitUntil(() => processGone(pid));
    if (!forkExited && Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error); }
      forkExited = await waitUntil(() => processGone(pid));
    }
    if (!forkExited) cleanupErrors.push(new Error(`cannot establish owned fork exit: pid=${pid}`));
    if (!parentExited) cleanupErrors.push(new Error('cannot establish guarded parent exit'));
    if (!parentExited || !forkExited) retain();
    else {
      try { releaseRunRootHold(hold); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) failure = failure
      ? new AggregateError([failure, ...cleanupErrors], 'fork assertion and cleanup failed')
      : new AggregateError(cleanupErrors, 'fork cleanup failed');
    if (failure) throw failure;
    assert.ok(fs.existsSync(doneFile), 'owned fork completed before sandbox cleanup');
    const { code, signal } = await parentClose;
    assert.strictEqual(code, 0, `guarded parent failed (${signal}): ${stderr}`);
    assert.ok(fs.existsSync(parentAckFile), 'guarded parent did not acknowledge the fork close event');
    const lines = readLedger(ledgerFile);
    // Each wrapped form by name, not an exact total: execSync goes through a
    // platform shell, and only its own record is what this test is about.
    const got = JSON.stringify(lines);
    assert.strictEqual(lines.filter((l) => l.cmd === process.execPath).length, 2,
      `spawnSync and execFileSync both record process.execPath; got ${got}`);
    assert.ok(lines.some((l) => l.cmd === 'true'), `execSync records its command; got ${got}`);
    assert.ok(lines.some((l) => l.cmd === forkTarget), `fork() records the module path as cmd; got ${got}`);
    assert.ok(lines.every((l) => typeof l.at === 'string' && !Number.isNaN(Date.parse(l.at))), 'every line has an ISO timestamp');
  });
}

test('spawn-guard records every wrapped form and waits for its owned fork', async () => {
  await runGuardedSmoke();
});

test('nonzero owned fork exit fails after the guarded parent reaps it', async () => {
  await assert.rejects(runGuardedSmoke({ childExitCode: 7 }), /guarded parent failed/);
});

test('stalled owned fork is signaled before its parent is reaped', async () => {
  await assert.rejects(runGuardedSmoke({ childStallsOnRelease: true, closeTimeoutMs: 200 }), /guarded parent failed/);
});

test('guarded launch failure is reported and its sandbox is cleaned', async () => {
  await assert.rejects(runGuardedSmoke({ launchFailure: true }), { code: 'ENOENT' });
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

test('plain ak status spawns nothing on a warm cache; --refresh always re-probes', async () => {
  await inSandbox('ak-status-zero-spawn', {}, ({ project, env: baseEnv }) => {
    const ledgerFile = path.join(project, 'status-ledger.ndjson');
    const env = { ...baseEnv, AK_SPAWN_LEDGER_FILE: ledgerFile };
    execFileSync(process.execPath, [
      `--import=${SPAWN_GUARD_URL}`, FIXTURE, PKG_ROOT, project,
    ], { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
    const lines = readLedger(ledgerFile);

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

    // `refresh: true` must still force a fresh probe even with a warm cache —
    // specifically for the kinds THIS task gated, not merely "something
    // spawned": versions.mjs's `npm view` lookups spawn unconditionally
    // regardless of refresh (the second call's ledger already contains them,
    // filtered above), so `third.length > 0` alone would still pass even if
    // `refresh: true` silently stopped reaching globalRoot()/processSweep()/
    // claudeLauncherUnavailable() specifically. Assert each of this task's
    // own re-probes by name instead.
    const hasCall = (lines, cmd, argsPrefix) => lines.some((l) => l.cmd === cmd
      && argsPrefix.every((a, i) => l.args?.[i] === a));
    const thirdExplained = third.filter((l) => !isVersionDriftLookup(l));
    // On Windows have() resolves a binary through resolveShim() without
    // spawning, so detectHosts() and claudeLauncherUnavailable() leave no line
    // in a spawn ledger there (Linux and macOS CI enforce those re-probes), and
    // the daemon sweep runs PowerShell instead of ps.
    const reprobes = process.platform === 'win32'
      ? [
        ['npm', ['root', '-g'], 'globalRoot()'],
        ['powershell', ['-NoProfile', '-Command'], 'processSweep()'],
      ]
      : [
        ['npm', ['root', '-g'], 'globalRoot()'],
        ['which', ['claude'], 'detectHosts()'],
        ['which', ['codex'], 'detectHosts()'],
        ['which', ['opencode'], 'detectHosts()'],
        ['which', ['ak'], 'claudeLauncherUnavailable()'],
        ['ps', ['-eo', 'pid=,args='], 'processSweep()'],
      ];
    for (const [cmd, argsPrefix, why] of reprobes) {
      assert.ok(hasCall(thirdExplained, cmd, argsPrefix),
        `--refresh must re-probe ${why} (${cmd} ${argsPrefix.join(' ')}); got ${JSON.stringify(thirdExplained.map((l) => [l.cmd, l.args]))}`);
    }
  });
});
