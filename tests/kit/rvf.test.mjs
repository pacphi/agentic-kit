// scanRvf / aqeSelfHealsRvf — the RVF corrupt-lock detector and its
// version-gated retirement (issue #563 → aqe PR #564). Hermetic: a synthetic
// .agentic-qe fixture with hand-built lock records + injected version/pid/cap,
// so no aqe install, no rvf-node binding, no network.
//
// The load-bearing facts, measured against @ruvector/rvf-node 0.1.8 and
// confirmed on the dev machine: a lock record is `FLVR` magic + owner pid as
// u32 LE at offset 4; the store's own magic is `SFVR`; an empty store is 162
// bytes. The old detector fired on the mere presence of an `FLVR` lock, which
// is EVERY lock — the retirement + pid-guard fix that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRvf, aqeSelfHealsRvf } from '../../src/lib/rvf.mjs';

const DEAD_PID = 0x7fffffff; // no process; process.kill(_, 0) throws ESRCH → dead

function aqeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rvf-'));
}

/** Write an rvf-node-shaped lock: 4-byte 'FLVR' magic, pid u32 LE at offset 4. */
function writeLock(dir, name, pid) {
  const buf = Buffer.alloc(104);
  buf.write('FLVR', 0, 'latin1');
  buf.writeUInt32LE(pid, 4);
  fs.writeFileSync(path.join(dir, name), buf);
}

/** Write a store file of `size` bytes with the real `SFVR` store magic. */
function writeStore(dir, name, size) {
  const buf = Buffer.alloc(size);
  buf.write('SFVR', 0, 'latin1');
  fs.writeFileSync(path.join(dir, name), buf);
}

const kinds = (findings) => findings.map((f) => f.kind).sort();

// ── aqeSelfHealsRvf: the retirement gate ────────────────────────────────────

test('aqeSelfHealsRvf is false below 3.12.3 — the legacy scan stays active', () => {
  assert.equal(aqeSelfHealsRvf('3.12.2'), false);
});

test('aqeSelfHealsRvf is true at exactly 3.12.3 — the scan retires', () => {
  assert.equal(aqeSelfHealsRvf('3.12.3'), true);
});

test('aqeSelfHealsRvf is true above 3.12.3', () => {
  assert.equal(aqeSelfHealsRvf('3.13.0'), true);
});

test('aqeSelfHealsRvf treats a 3.12.3 prerelease as not-yet-healed (safe direction)', () => {
  assert.equal(aqeSelfHealsRvf('3.12.3-rc.1'), false);
});

test('aqeSelfHealsRvf is false when no aqe version resolves', () => {
  assert.equal(aqeSelfHealsRvf(null), false);
});

// ── scanRvf: corrupt-lock detection, pre- and post-fix ──────────────────────

test('a stale FLVR lock is flagged on aqe < 3.12.3 (legacy behavior preserved)', () => {
  const dir = aqeDir();
  writeStore(dir, 'brain.rvf', 162);
  writeLock(dir, 'brain.rvf.lock', DEAD_PID);
  const findings = scanRvf(dir, { selfHeals: false });
  assert.deepEqual(kinds(findings), ['corrupt-lock']);
  assert.equal(findings[0].sibling, path.join(dir, 'brain.rvf'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the same stale FLVR lock is IGNORED once aqe self-heals (>= 3.12.3)', () => {
  const dir = aqeDir();
  writeStore(dir, 'brain.rvf', 162);
  writeLock(dir, 'brain.rvf.lock', DEAD_PID);
  assert.deepEqual(scanRvf(dir, { selfHeals: true }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lock held by a LIVE process is never flagged — no quarantining a peer in use', () => {
  const dir = aqeDir();
  writeStore(dir, 'patterns.rvf', 162);
  writeLock(dir, 'patterns.rvf.lock', process.pid); // this test process is alive
  assert.deepEqual(scanRvf(dir, { selfHeals: false }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a non-FLVR .rvf.lock is not treated as a lock record', () => {
  const dir = aqeDir();
  fs.writeFileSync(path.join(dir, 'brain.rvf.lock'), Buffer.from('not-a-lock-record'));
  assert.deepEqual(scanRvf(dir, { selfHeals: false }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── scanRvf: the oversized backstop (a different mode; survives retirement) ──

test('an oversized store is flagged even after the corrupt-lock scan retires', () => {
  const dir = aqeDir();
  writeStore(dir, 'patterns.rvf', 4096);
  const findings = scanRvf(dir, { selfHeals: true, capBytes: 1024 });
  assert.deepEqual(kinds(findings), ['oversized']);
  assert.equal(findings[0].size, 4096);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a normal-sized store is not flagged', () => {
  const dir = aqeDir();
  writeStore(dir, 'patterns.rvf', 162);
  assert.deepEqual(scanRvf(dir, { selfHeals: true, capBytes: 2 * 1024 ** 3 }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanRvf on a missing .agentic-qe dir returns empty, never throws', () => {
  assert.deepEqual(scanRvf(path.join(os.tmpdir(), 'ak-rvf-nope-123'), { selfHeals: false }), []);
});
