// Branch 6a Task 9: dashboard-server.mjs's default /api/status provider now
// calls status.mjs's own collect() in process instead of shelling out to
// `node bin/agentic-kit.mjs status --json`. This file proves the swap kept
// both properties that mattered about the old subprocess boundary:
//
// 1. A warm-cache request spawns nothing (tests/fixtures/status-zero-spawn-child.mjs
//    already proved this for a bare collect() call — Task 8a/Task 7; this
//    proves it for a REQUEST ARRIVING AT A RUNNING SERVER, the actual shape
//    the dashboard's 30s poll exercises).
// 2. The JSON /api/status now COMPUTES has the same {overall, rows} content
//    `ak status --json` (the real CLI, still a real subprocess for comparison
//    purposes only) produces for the identical fixture/cwd/env — catching any
//    place run()'s CLI path post-processes something collect() alone doesn't
//    return, which the in-process path would otherwise silently drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnEnv, sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot } from './helpers/home-sandbox.mjs';
import {
  startGuardedDashboard, stopGuardedDashboard, getJson, markLedgerBoundary, readLedger, sliceByCallBoundary,
  isVersionDriftLookup,
} from './helpers/dashboard-child-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(PKG_ROOT, 'bin', 'agentic-kit.mjs');

/** A disposable HOME + project + hermetic env, matching status-zero-spawn's
 *  own convention: PATH points nowhere, so every real tool probe ENOENTs
 *  deterministically instead of depending on what happens to be installed. */
function sandbox(prefix, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  const project = sandboxProject(prefix);
  writeKitConfig(home, offlineKitConfig());
  const env = spawnEnv(home, {
    NO_COLOR: '1',
    PATH: path.join(home, 'no-such-bin'),
    ...extraEnv,
  });
  return { home, project, env };
}

function cleanup(home, project) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
}

// The one legitimately non-deterministic content in a rows[] payload: the
// context section's `contextReport` embeds its own `observedAt` capture
// timestamps (status/sections/context.mjs), which differ by however many
// milliseconds separate the dashboard's request from the CLI's own run —
// everything else in rows[] is a pure function of the identical fixture/env.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function normalizeTimestamps(value) {
  if (Array.isArray(value)) return value.map(normalizeTimestamps);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeTimestamps(v)]));
  }
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) ? '<timestamp>' : value;
}

test('GET /api/status (no injected fetchStatus) spawns nothing on the SECOND request against a warm cache', async () => {
  const ledgerFile = path.join(os.tmpdir(), `ak-dash-status-zero-spawn-${process.pid}.ndjson`);
  const { home, project, env: baseEnv } = sandbox('ak-dash-inprocess');
  const env = { ...baseEnv, AK_SPAWN_LEDGER_FILE: ledgerFile };
  let child;
  try {
    const started = await startGuardedDashboard({ cwd: project, env });
    child = started.child;
    const { port, token } = started;

    const first = await getJson(port, '/api/status', token);
    assert.equal(first.status, 200);
    assert.ok(Array.isArray(first.json.rows), 'first response carries rows[]');
    markLedgerBoundary(ledgerFile, 'first');

    const second = await getJson(port, '/api/status', token);
    assert.equal(second.status, 200);
    assert.ok(Array.isArray(second.json.rows), 'second response carries rows[]');
    markLedgerBoundary(ledgerFile, 'second');

    const lines = readLedger(ledgerFile);
    const { first: firstSlice, second: secondSlice } = sliceByCallBoundary(lines, ['first', 'second']);

    // Sanity: server startup + a cold-cache first request is expected to
    // probe at least once (Ruling A) — a RED baseline, not the enforced gate.
    assert.ok(firstSlice.length > 0,
      `sanity: startup + a cold-cache first request is expected to probe at least once; got ${JSON.stringify(firstSlice)}`);

    // The enforced gate: a second /api/status request, same warm process,
    // spawns nothing UNEXPLAINED (versions.mjs's npm-view drift lookups are
    // the one documented, pre-existing exception — see isVersionDriftLookup).
    const secondUnexplained = secondSlice.filter((l) => !isVersionDriftLookup(l));
    assert.strictEqual(secondUnexplained.length, 0,
      `expected zero unexplained spawns from a warm-cache /api/status request; got ${JSON.stringify(secondUnexplained.map((l) => [l.cmd, l.args]))}`);
  } finally {
    await stopGuardedDashboard(child);
    fs.rmSync(ledgerFile, { force: true });
    cleanup(home, project);
  }
});

test('GET /api/status (in-process) carries the same {overall, rows} `ak status --json` (the real CLI) produces for the identical fixture', async () => {
  const { home, project, env } = sandbox('ak-dash-byte-identical');
  let child;
  try {
    const started = await startGuardedDashboard({ cwd: project, env });
    child = started.child;
    const { port, token } = started;

    // Warm the in-process cache with a first request (mirrors real dashboard
    // use — the CLI comparison below runs against a warm evidence cache too,
    // via the shared HOME) before taking the response this test compares.
    await getJson(port, '/api/status', token);
    const dash = await getJson(port, '/api/status', token);
    assert.equal(dash.status, 200);

    const cli = spawnSync(process.execPath, [BIN, 'status', '--json'], {
      cwd: project, env, encoding: 'utf8', timeout: 30_000,
    });
    // run()'s own contract: exit 1 exactly when overall is 'fail' (this
    // sandbox's primary host is enabled but not installed, so it legitimately
    // is) — a real crash is a non-{0,1} status or empty stdout, not this.
    assert.ok([0, 1].includes(cli.status), `ak status --json must not crash: ${cli.stderr || cli.stdout}`);
    const cliJson = JSON.parse(cli.stdout);

    assert.equal(dash.json.overall, cliJson.overall,
      `dashboard overall (${dash.json.overall}) must match ak status --json's overall (${cliJson.overall})`);
    assert.deepStrictEqual(normalizeTimestamps(dash.json.rows), normalizeTimestamps(cliJson.rows),
      'the dashboard\'s in-process rows must be identical (up to timestamp fields) to what the real CLI\'s '
      + 'collect()-backed run() emits — a mismatch here means run() post-processes something beyond what collect() itself returns');
  } finally {
    await stopGuardedDashboard(child);
    cleanup(home, project);
  }
});

test('GET /api/status passes the server cwd through ruflo-components project-root discovery', async () => {
  const { home, project, env } = sandbox('ak-dash-ruflo-cwd');
  const decoy = sandboxProject('ak-dash-ruflo-decoy');
  const fakeRoot = fakeGlobalRoot(home, { ruflo: '9.9.9' });
  fs.mkdirSync(path.join(project, '.claude-flow'));
  fs.mkdirSync(path.join(project, '.harness'));
  fs.writeFileSync(path.join(project, '.harness', 'mcp-policy.json'), '{invalid');
  fs.mkdirSync(path.join(decoy, '.claude-flow'));
  writeKitConfig(home, offlineKitConfig({ rufloComponents: { mcpGovernance: { maxCallsPerMinute: 60 } } }));

  let child;
  try {
    const ready = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [path.join(PKG_ROOT, 'tests/fixtures/dashboard-status-child.mjs'), project, fakeRoot], {
        cwd: decoy, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', chunk => {
        out += chunk;
        const match = out.match(/READY (\d+) (\S+)\n/);
        if (match) resolve({ port: Number(match[1]), token: match[2] });
      });
      child.stderr.on('data', chunk => { err += chunk; });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`dashboard child exited ${code}: ${err || out}`)));
    });
    const response = await getJson(ready.port, '/api/status', ready.token);
    assert.equal(response.status, 200);
    assert.ok(response.json.rows.some(row => row.subsystem === 'ruflo-components'
      && /ruflo components:.*ruflo 9\.9\.9/.test(row.message)),
    'the status request must use the disposable fake Ruflo package');
    const governance = response.json.rows.find(row => row.subsystem === 'ruflo-components'
      && /MCP tool governance/.test(row.message));
    assert.ok(governance, 'fake installed Ruflo must reach its component projection');
    assert.equal(governance.state, 'blocked');
    assert.match(governance.message, /policy file is invalid/,
      'the server-supplied project cwd, not process.cwd(), must drive rufloProjectRoot');
  } finally {
    await stopGuardedDashboard(child);
    cleanup(home, project);
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});
