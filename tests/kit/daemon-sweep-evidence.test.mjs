// listDaemons()'s processSweep() (src/lib/daemons.mjs)
// stops spawning `ps -eo pid=,args=` (or the Windows CIM query) on every
// plain `ak status` call — it reuses fresh evidence instead (kind
// 'daemon-sweep', id 'machine', 5-minute TTL: this is live process-table
// state, so a stale answer goes wrong quickly). `refresh` defaults to true
// (Ruling B: processSweep already ran unconditionally, so every non-status
// caller keeps its unconditional spawn); status/sections/daemons.mjs's own
// collect() explicitly threads refresh:false from ctx.
//
// processSweep has no injectable runner, so — mirroring
// tests/kit/host-setup-evidence.test.mjs's state-isolation precedent — these tests
// break PATH so a real `ps` ENOENTs deterministically (run() never throws;
// it degrades to an empty result), then seed cached evidence with a marker
// entry no real sweep could ever produce. Getting the marker back proves the
// cache was used.
//
// There is no natural "input" a process-table sweep is scoped to (ps/CIM
// both enumerate every process on the machine, not per-cwd — see the comment
// above DAEMON_SWEEP_INPUTS_KEY in daemons.mjs), so unlike the other
// evidence kinds in this branch there is no meaningful "invalidated inputsKey"
// case here; only staleness (the 5-minute TTL) matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDaemons } from '../../src/lib/daemons.mjs';
import {
  evidenceDir, evidenceFile, readEvidence, writeEvidence, stableInputsKey,
} from '../../src/lib/evidence.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.XDG_STATE_HOME = tempDir('ak-daemon-sweep-evidence-state');
process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME;

const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const resetEvidence = () => rm(evidenceDir());
const DAEMON_SWEEP_KEY = stableInputsKey({ kind: 'daemon-sweep' });
const MARKER = [{
  pid: 999999, workspace: 'MARKER-EVIDENCE-CACHE-HIT', ageSecs: null, workspaceExists: true,
}];

/** Real `ps`/CIM sweeps ENOENT deterministically inside `fn`: PATH points
 *  nowhere. A fresh, empty cwd means registryWorkspaces()/daemonFromWorkspace
 *  contribute nothing, so the returned list is purely processSweep()'s. */
async function withBrokenPathAndFreshCwd(fn) {
  const prevPath = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), 'ak-daemon-sweep-no-such-bin');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-daemon-sweep-cwd-'));
  try {
    return await fn(cwd);
  } finally {
    process.env.PATH = prevPath;
    rm(cwd);
  }
}

test('listDaemons({ refresh: false }) reuses fresh evidence and never re-sweeps', async () => {
  resetEvidence();
  await withBrokenPathAndFreshCwd(async (cwd) => {
    writeEvidence('daemon-sweep', 'machine', {
      source: 'test', inputsKey: DAEMON_SWEEP_KEY, inputs: { kind: 'daemon-sweep' }, result: { found: MARKER },
    });
    const daemons = await listDaemons({ cwd, refresh: false });
    assert.deepEqual(daemons, MARKER, 'the cached sweep came back, not a fresh ps sweep');
  });
  resetEvidence();
});

test('listDaemons({ refresh: true }) always re-sweeps and writes evidence a later refresh:false read can reuse', async () => {
  resetEvidence();
  await withBrokenPathAndFreshCwd(async (cwd) => {
    const before = await listDaemons({ cwd, refresh: true });
    assert.deepEqual(before, [], 'a broken-PATH sweep finds nothing (a real result, not the seeded marker)');
    const record = readEvidence('daemon-sweep', 'machine', { inputsKey: DAEMON_SWEEP_KEY });
    assert.ok(record, 'evidence was written after the sweep');
    assert.deepEqual(record.result.found, []);
    const after = await listDaemons({ cwd, refresh: false });
    assert.deepEqual(after, [], 'refresh:false reused the evidence refresh:true just wrote');
  });
  resetEvidence();
});

test('listDaemons({ refresh: false }) re-sweeps when cached evidence is older than 5 minutes', async () => {
  resetEvidence();
  await withBrokenPathAndFreshCwd(async (cwd) => {
    writeEvidence('daemon-sweep', 'machine', {
      source: 'test', inputsKey: DAEMON_SWEEP_KEY, inputs: { kind: 'daemon-sweep' }, result: { found: MARKER },
    }, { now: Date.now() - 6 * 60_000 });
    const daemons = await listDaemons({ cwd, refresh: false });
    assert.deepEqual(daemons, [], 'evidence older than the 5-minute window must not be trusted');
  });
  resetEvidence();
});

test('listDaemons({ refresh: false }) re-sweeps when there is no cached evidence yet (first run)', async () => {
  resetEvidence();
  await withBrokenPathAndFreshCwd(async (cwd) => {
    const daemons = await listDaemons({ cwd, refresh: false });
    assert.deepEqual(daemons, []);
    assert.ok(fs.existsSync(evidenceFile('daemon-sweep', 'machine')), 'the sweep is recorded for next time');
  });
  resetEvidence();
});

test('listDaemons({ record: false }) still sweeps but writes no evidence', async () => {
  resetEvidence();
  await withBrokenPathAndFreshCwd(async (cwd) => {
    const daemons = await listDaemons({ cwd, refresh: true, record: false });
    assert.deepEqual(daemons, []);
    assert.equal(fs.existsSync(evidenceFile('daemon-sweep', 'machine')), false, 'record:false must not write evidence');
  });
  resetEvidence();
});
