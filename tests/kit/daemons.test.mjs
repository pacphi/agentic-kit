// daemons.mjs — the kit's only module whose job is TERMINATING processes, and
// (until this file) its only zero-coverage destructive module. Pins the three
// load-bearing behaviors: which daemons staleDaemons selects to die, that
// reap() degrades safely on dead/foreign pids (including the pid-reuse guard:
// never SIGTERM a live process whose cmdline isn't a ruflo daemon), and that
// parseSweepLine extracts pid + workspace from real ps shapes. reap's
// kill-true path runs against a REAL spawned child whose argv contains
// "daemon start", so the guard's match and the kill are both exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { staleDaemons, reap, parseSweepLine } from '../../src/lib/daemons.mjs';

const DEAD_PID = 0x7ffffff0; // outside real pid ranges; kill(pid,0) → ESRCH

// ── staleDaemons: the kill-selection rule ───────────────────────────────────

test('selects workspace-gone and TTL-exceeded daemons, spares the young', () => {
  const daemons = [
    { pid: 1, workspaceExists: false, ageSecs: 10 },     // workspace gone → stale
    { pid: 2, workspaceExists: true, ageSecs: 99_999 },  // over TTL → stale
    { pid: 3, workspaceExists: true, ageSecs: 5 },       // healthy → spared
  ];
  assert.deepEqual(staleDaemons(daemons, 43_200).map((d) => d.pid), [1, 2]);
});

test('ttlSecs=0 disables the age rule — only workspace-gone daemons die', () => {
  const daemons = [
    { pid: 1, workspaceExists: false, ageSecs: 10 },
    { pid: 2, workspaceExists: true, ageSecs: 99_999_999 },
  ];
  assert.deepEqual(staleDaemons(daemons, 0).map((d) => d.pid), [1]);
});

test('unknown age (null) never counts as over-TTL', () => {
  assert.deepEqual(staleDaemons([{ pid: 1, workspaceExists: true, ageSecs: null }], 1), []);
});

// ── reap: safety on every pid class ─────────────────────────────────────────

test('a dead pid degrades to killed:false — no throw, per-entry result', () => {
  const [r] = reap([{ pid: DEAD_PID, workspace: '/x' }]);
  assert.equal(r.killed, false);
});

test('pid-reuse guard: a LIVE process that is not a ruflo daemon is never killed', () => {
  // process.pid is this test runner — alive, but its cmdline has no
  // "daemon start". The old reap would have SIGTERM'd it.
  const [r] = reap([{ pid: process.pid, workspace: '/x' }]);
  assert.equal(r.killed, false);
  assert.equal(r.pidReused, true);
});

test('a real child whose argv matches "daemon start" IS reaped', async (t) => {
  // The guard itself is cross-platform (ps on POSIX, CIM on Windows) and the
  // never-kill side is covered above on every OS; this kill-true path stays
  // POSIX-only because Windows CI's spawn + CIM probe latency makes the
  // 200ms settle window flake-prone, not because the behavior differs.
  if (process.platform === 'win32') { t.skip('kill-true path exercised on POSIX only (CI timing)'); return; }
  // Spawn a keep-alive child whose ps args contain "daemon start" (extra argv
  // after -e lands in the command line), so the identity guard matches it.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'daemon', 'start'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } });
  await new Promise((r) => setTimeout(r, 200)); // let it register in the ps table
  const [r] = reap([{ pid: child.pid, workspace: '/x' }]);
  assert.equal(r.killed, true);
});

// ── parseSweepLine: pid + workspace extraction from ps output ───────────────

test('parses pid and --workspace <path> from a standard ps line', () => {
  const found = [];
  parseSweepLine('12345   node /g/ruflo/node_modules/@claude-flow/cli/bin/cli.js daemon start --workspace /a/proj', found);
  assert.equal(found.length, 1);
  assert.equal(found[0].pid, 12345);
  assert.equal(found[0].workspace, '/a/proj');
});

test('parses the --workspace=/x/y variant and de-quotes a quoted path', () => {
  const found = [];
  parseSweepLine('7 node cli.js daemon start --workspace=/x/y', found);
  parseSweepLine('8 node cli.js daemon start --workspace "/a b/proj"', found);
  assert.equal(found[0].workspace, '/x/y');
  assert.equal(found[1].workspace, '/a b/proj');
});

test('a garbage line yields nothing', () => {
  const found = [];
  parseSweepLine('not a ps line at all', found);
  assert.deepEqual(found, []);
});
