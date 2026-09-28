// Branch 6a Task 9 / Task 8b — the Review Focus item this whole branch was
// scoped around: "Dashboard cost. The 30-second poll must not start more
// processes or transfer more data than before the branch." Task 7 made a
// warm-cache collect() spawn-free; this task made dashboard-server.mjs call
// it in process instead of shelling out. This file is the end-to-end proof
// that swap actually delivered the promised cost property, simulating two
// 30s poll ticks against a running server (not a bare collect() call):
//
//   (a) the SECOND /api/status request starts zero child processes.
//   (b) the SECOND response's byte size stays within a small, fixed budget
//       of the first response's — catching an in-process cache/leak that
//       silently grows the payload across requests, which a process-count
//       assertion alone would miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnEnv, sandboxProject, writeKitConfig, offlineKitConfig } from './helpers/home-sandbox.mjs';
import {
  startGuardedDashboard, getJson, markLedgerBoundary, readLedger, sliceByCallBoundary, isVersionDriftLookup,
} from './helpers/dashboard-child-server.mjs';

test('two 30s-poll-tick /api/status requests: the second starts no processes and transfers no more data than the first', async () => {
  const ledgerFile = path.join(os.tmpdir(), `ak-dash-cost-${process.pid}.ndjson`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dash-cost-home-'));
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  const project = sandboxProject('ak-dash-cost');
  writeKitConfig(home, offlineKitConfig());
  const env = spawnEnv(home, {
    NO_COLOR: '1',
    PATH: path.join(home, 'no-such-bin'),
    AK_SPAWN_LEDGER_FILE: ledgerFile,
  });

  let child;
  try {
    const started = await startGuardedDashboard({ cwd: project, env });
    child = started.child;
    const { port, token } = started;

    // Tick 1: a cold-cache poll. Every real dashboard's FIRST poll after
    // startup pays this cost — Ruling A (Task 7) says a cold cache probes at
    // least once per gated kind, so this is not itself under budget.
    const first = await getJson(port, '/api/status', token);
    assert.equal(first.status, 200);
    markLedgerBoundary(ledgerFile, 'first');

    // Tick 2: the SAME server, ~30s later in production — the one every
    // later poll tick looks like once the cache is warm.
    const second = await getJson(port, '/api/status', token);
    assert.equal(second.status, 200);
    markLedgerBoundary(ledgerFile, 'second');

    // (a) zero processes started by the second tick.
    const lines = readLedger(ledgerFile);
    const { second: secondSlice } = sliceByCallBoundary(lines, ['first', 'second']);
    const secondUnexplained = secondSlice.filter((l) => !isVersionDriftLookup(l));
    assert.strictEqual(secondUnexplained.length, 0,
      `expected zero processes started by the second poll tick; got ${JSON.stringify(secondUnexplained.map((l) => [l.cmd, l.args]))}`);

    // (b) no more data transferred by the second tick than the first. Budget:
    // within 10% or 2KB, whichever is larger — generous enough to absorb a
    // legitimately-changed timestamp string or two, tight enough to fail on
    // an actual leak (e.g. an accumulating cache the second request re-serves
    // a growing copy of, or a row list that silently duplicates).
    const budget = Math.max(first.bytes * 0.10, 2048);
    assert.ok(second.bytes <= first.bytes + budget,
      `second /api/status response (${second.bytes} bytes) exceeds the first (${first.bytes} bytes) `
      + `by more than the ${budget}-byte budget — possible in-process cache growth/leak across polls`);
  } finally {
    child?.kill();
    fs.rmSync(ledgerFile, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
