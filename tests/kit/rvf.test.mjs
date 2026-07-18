// scanRvf / quarantine — the oversized-store backstop (#495 runaway append),
// the ONLY RVF failure mode the kit still owns. Lock/corruption handling moved
// to agentic-qe itself (>= 3.12.3, issue #563 → PR #564); the kit's old
// corrupt-lock detector — and its version-gated remnant from PR #31 — are gone.
// These tests pin the reduced contract: size is the only signal, `.rvf.lock`
// files are never candidates, and quarantine takes the sidecars with the store.
// Hermetic: synthetic .agentic-qe fixtures, injected cap — no aqe install, no
// rvf-node binding, no network.
//
// Load-bearing facts (measured against @ruvector/rvf-node 0.1.8): a lock record
// is 104 bytes starting `FLVR`; the store's own magic is `SFVR`; a 162-byte
// store is a valid EMPTY store. They appear here so any future "corruption"
// heuristic gets confronted with real shapes before it ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRvf, quarantine } from '../../src/lib/rvf.mjs';

function aqeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rvf-'));
}

/** Write an rvf-node-shaped lock: 4-byte 'FLVR' magic, pid u32 LE at offset 4. */
function writeLock(dir, name, pid = process.pid) {
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

// ── scanRvf: the oversized backstop ─────────────────────────────────────────

test('an oversized store is flagged with its size', () => {
  const dir = aqeDir();
  writeStore(dir, 'patterns.rvf', 4096);
  const findings = scanRvf(dir, { capBytes: 1024 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'oversized');
  assert.equal(findings[0].size, 4096);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a normal-sized store is not flagged (a 162-byte store is a valid EMPTY store)', () => {
  const dir = aqeDir();
  writeStore(dir, 'brain.rvf', 162);
  assert.deepEqual(scanRvf(dir, { capBytes: 2 * 1024 ** 3 }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a normal FLVR lock beside a healthy store is NOT a finding — ever', () => {
  const dir = aqeDir();
  writeStore(dir, 'brain.rvf', 162);
  writeLock(dir, 'brain.rvf.lock'); // FLVR magic = every real lock on disk
  assert.deepEqual(scanRvf(dir, { capBytes: 2 * 1024 ** 3 }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.rvf.lock files are never oversized candidates, even under a tiny cap', () => {
  const dir = aqeDir();
  writeLock(dir, 'brain.rvf.lock'); // 104 bytes
  assert.deepEqual(scanRvf(dir, { capBytes: 50 }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('capBytes <= 0 disables the backstop entirely', () => {
  const dir = aqeDir();
  writeStore(dir, 'patterns.rvf', 4096);
  assert.deepEqual(scanRvf(dir, { capBytes: 0 }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cap is exclusive: size === capBytes is NOT oversized, cap+1 is', () => {
  const dir = aqeDir();
  writeStore(dir, 'at-cap.rvf', 1024);
  writeStore(dir, 'over-cap.rvf', 1025);
  const findings = scanRvf(dir, { capBytes: 1024 });
  assert.equal(findings.length, 1);
  assert.equal(path.basename(findings[0].file), 'over-cap.rvf');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only .rvf files are candidates — an oversized sidecar is never flagged', () => {
  const dir = aqeDir();
  fs.writeFileSync(path.join(dir, 'patterns.rvf.idmap.json'), Buffer.alloc(4096));
  assert.deepEqual(scanRvf(dir, { capBytes: 1024 }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a store that vanishes between readdir and stat is skipped, not a crash', () => {
  // The aqe daemon renames/quarantines stores while we scan (observed live:
  // 35 renames in 7 min). A dangling symlink models the vanished entry
  // deterministically: readdir lists it, stat throws ENOENT.
  const dir = aqeDir();
  fs.symlinkSync(path.join(dir, 'gone-away'), path.join(dir, 'brain.rvf'));
  writeStore(dir, 'patterns.rvf', 4096);
  const findings = scanRvf(dir, { capBytes: 1024 }); // must not throw
  assert.equal(findings.length, 1);
  assert.equal(path.basename(findings[0].file), 'patterns.rvf');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanRvf on a missing .agentic-qe dir returns empty, never throws', () => {
  assert.deepEqual(scanRvf(path.join(os.tmpdir(), 'ak-rvf-nope-123')), []);
});

// ── quarantine: store + sidecars go together ────────────────────────────────

test('quarantine removes the store and every sidecar, and reports each path', () => {
  const dir = aqeDir();
  writeStore(dir, 'patterns.rvf', 4096);
  writeLock(dir, 'patterns.rvf.lock');
  fs.writeFileSync(path.join(dir, 'patterns.rvf.idmap.json'), '{}');
  fs.writeFileSync(path.join(dir, 'patterns.rvf.manifest.json'), '{}');
  const [finding] = scanRvf(dir, { capBytes: 1024 });
  const removed = quarantine(finding);
  assert.equal(removed.length, 4);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quarantine skips absent sidecars without failing', () => {
  const dir = aqeDir();
  writeStore(dir, 'aqe.rvf', 4096); // no lock, no idmap, no manifest
  const [finding] = scanRvf(dir, { capBytes: 1024 });
  const removed = quarantine(finding);
  assert.deepEqual(removed, [path.join(dir, 'aqe.rvf')]);
  fs.rmSync(dir, { recursive: true, force: true });
});
