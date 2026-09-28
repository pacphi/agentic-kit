// final-review fix: sync's 'daemons' step must re-record daemon-sweep
// evidence after a successful reap. The Important finding: listDaemons()
// records the PRE-reap process list; without a re-list after reap() kills
// something, that stale list is the last thing written — a later `ak
// status`/this sync's own converge proof would still see the reaped
// daemon(s). Mutation-tested: deleting the re-list call in src/commands/
// sync.mjs's 'daemons' step turns the first assertion below red while
// leaving the rest of this file green.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxHome, rmrf } from './helpers/home-sandbox.mjs';

const SANDBOX_HOME = sandboxHome('ak-sync-daemon-repair');
after(() => rmrf(SANDBOX_HOME));
const sync = await import('../../src/commands/sync.mjs');

const daemonsStep = sync.SYNC_STEPS.find((s) => s.id === 'daemons');

// A fresh tmp dir with no `.claude-flow` durable project marker: applyRufloDaemon()
// (called unconditionally at the end of the step) resolves no project root and
// returns null immediately, so the step's run() ends right after the reap/
// re-list logic under test — no daemon config surface to fake.
function freshCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ak-sync-daemon-repair-cwd-'));
}

const cfg = {};

test('a successful reap re-lists and re-records daemon-sweep evidence with source "sync"', async () => {
  const cwd = freshCwd();
  const listCalls = [];
  try {
    await daemonsStep.run({
      cwd, cfg,
      daemonLifecycle: {
        list: async (opts) => { listCalls.push(opts); return [{ pid: 4242, workspace: cwd, ageSecs: 999999, workspaceExists: true }]; },
        reap: (stale) => stale.map((d) => ({ ...d, killed: true })),
      },
    });
    assert.equal(listCalls.length, 2, 'listDaemons is called once to find stale daemons, once again to re-record after reaping them');
    assert.deepEqual(listCalls[1], { cwd, refresh: true, record: true, source: 'sync' },
      'the re-list forces a fresh read and persists it as this reap\'s own evidence');
  } finally { rmrf(cwd); }
});

test('no daemons killed: the sweep is never re-recorded', async () => {
  const cwd = freshCwd();
  const listCalls = [];
  try {
    await daemonsStep.run({
      cwd, cfg,
      daemonLifecycle: {
        list: async (opts) => { listCalls.push(opts); return []; },
        reap: () => [],
      },
    });
    assert.equal(listCalls.length, 1, 'nothing was stale, so there is nothing to reap and nothing to re-record');
  } finally { rmrf(cwd); }
});

test('a reap attempt that fails to kill anything is not re-recorded either', async () => {
  const cwd = freshCwd();
  const listCalls = [];
  try {
    await daemonsStep.run({
      cwd, cfg,
      daemonLifecycle: {
        list: async (opts) => { listCalls.push(opts); return [{ pid: 4242, workspace: cwd, ageSecs: 999999, workspaceExists: true }]; },
        reap: (stale) => stale.map((d) => ({ ...d, killed: false, pidReused: true })),
      },
    });
    assert.equal(listCalls.length, 1, 'a failed reap (pid already gone/reused) leaves the process list unchanged; no re-record is needed');
  } finally { rmrf(cwd); }
});
