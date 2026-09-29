import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessScope } from './aqe-live-lock-process.mjs';

test('abort closes a call-owned child before its temporary root is removed', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-abort-proof-'));
  const controller = new AbortController();
  const scope = createProcessScope(controller.signal);
  try {
    const marker = path.join(root, 'child-ready');
    const run = scope.launch(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready');setInterval(() => {}, 1000)`], { cwd: root, env: { PATH: process.env.PATH ?? '' } });
    assert.ok(run.child.pid > 0);
    const deadline = Date.now() + 2000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), 'the child must be running before cancellation');
    controller.abort();
    await scope.closeAll();
    assert.equal(run.closed, true);
    assert.ok(existsSync(root), 'root must remain until closure is established');
  } finally {
    await scope.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(root), false);
});

test('spawn failure is retained without an unhandled rejection', async () => {
  const scope = createProcessScope(new AbortController().signal);
  const run = scope.launch(path.join(os.tmpdir(), 'ak-missing-executable'), [], { env: { PATH: '' } });
  await assert.rejects(scope.wait(run, 1000), /ENOENT/);
  await scope.closeAll();
});
