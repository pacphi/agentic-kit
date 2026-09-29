import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessScope } from '../live/aqe-live-lock-process.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';
import { ownerRecord, writeOwner, readOwner, prepareRunRootHolds,
  inspectRunRootHolds } from '../../scripts/run-roots.mjs';

function sandbox(root) {
  const home = path.join(root, 'home');
  mkdirSync(home);
  return spawnEnv(home);
}

test('abort closes a call-owned child before its temporary root is removed', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-abort-proof-'));
  const controller = new AbortController();
  const scope = createProcessScope(controller.signal);
  let closed = false;
  try {
    const marker = path.join(root, 'child-ready');
    const run = scope.launch(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready');setInterval(() => {}, 1000)`], { cwd: root, env: sandbox(root) });
    assert.ok(run.child.pid > 0);
    const deadline = Date.now() + 2000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), 'the child must be running before cancellation');
    controller.abort();
    await scope.closeAll();
    closed = true;
    assert.equal(run.closed, true);
    assert.throws(() => scope.launch(process.execPath, [], { env: {} }), /cannot launch/);
    assert.ok(existsSync(root), 'root must remain until closure is established');
  } finally {
    if (!closed) await scope.closeAll();
    if (closed) rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(root), false);
});

test('spawn failure is retained without an unhandled rejection', async () => {
  const scope = createProcessScope(new AbortController().signal);
  const root = mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-spawn-failure-'));
  const run = scope.launch(path.join(root, 'ak-missing-executable'), [], { env: sandbox(root) });
  await assert.rejects(scope.wait(run, 1000), /ENOENT/);
  await scope.closeAll();
  rmSync(root, { recursive: true, force: true });
});

test('requires explicit sandbox env and passes it to the child', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-env-proof-'));
  const scope = createProcessScope(new AbortController().signal);
  try {
    assert.throws(() => scope.launch(process.execPath, [], {}), /explicit sandbox env/);
    assert.throws(() => scope.launch(process.execPath, [], { env: {} }), /requires sandbox home/);
    const env = sandbox(root);
    const run = scope.launch(process.execPath,
      ['-e', 'console.log(JSON.stringify({home:process.env.HOME,tmp:process.env.TMPDIR,state:process.env.XDG_STATE_HOME}))'],
      { cwd: root, env });
    const result = await scope.wait(run, 2000);
    assert.equal(result.code, 0);
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(observed.home, env.HOME);
    assert.equal(observed.tmp, env.TMPDIR);
    assert.equal(observed.state, env.XDG_STATE_HOME);
  } finally {
    await scope.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a guarded scope holds the enclosing run root until owned children close', async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-hold-base-'));
  const root = mkdtempSync(path.join(base, 'ak-suite-'));
  const owner = ownerRecord();
  writeOwner(root, owner);
  prepareRunRootHolds(root, owner.runId);
  const beforeRoot = process.env.AK_SUITE_ROOT;
  const beforeId = process.env.AK_SUITE_RUN_ID;
  process.env.AK_SUITE_ROOT = root;
  process.env.AK_SUITE_RUN_ID = owner.runId;
  let scope;
  try {
    scope = createProcessScope(new AbortController().signal, { closeLimitMs: 25 });
    assert.equal(inspectRunRootHolds(root, readOwner(root).runId).unresolved, true);
    const run = scope.launch(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { env: sandbox(base) });
    assert.equal(run.closed, false);
    const realKill = run.child.kill.bind(run.child);
    run.child.kill = () => false;
    try {
      await assert.rejects(scope.closeAll(), /did not close/);
      assert.equal(inspectRunRootHolds(root, owner.runId).unresolved, true);
    } finally {
      run.child.kill = realKill;
    }
    await scope.closeAll();
    assert.equal(run.closed, true);
    assert.equal(inspectRunRootHolds(root, owner.runId).unresolved, false);
  } finally {
    if (scope) await scope.closeAll();
    if (beforeRoot === undefined) delete process.env.AK_SUITE_ROOT;
    else process.env.AK_SUITE_ROOT = beforeRoot;
    if (beforeId === undefined) delete process.env.AK_SUITE_RUN_ID;
    else process.env.AK_SUITE_RUN_ID = beforeId;
    rmSync(base, { recursive: true, force: true });
  }
});
