// ADR-0048 scan checkpoints — checkpoint contract, integrity, size ceiling,
// expiry, and resume-drift rejection (MNT-DSC-011/012/013, MNT-PERF-005).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_CHECKPOINT_BYTES, contextDigest, createCheckpointStore, validateForResume,
} from '../../src/lib/maintenance/discovery/checkpoint.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-discovery-checkpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseCheckpoint(overrides = {}) {
  return {
    scanId: 'scn_test0000000000000000000',
    sourceId: 'src_test0000000000000000000',
    environmentId: 'env_test0000000000000000000',
    scanEpoch: 1,
    observationContractVersions: { walk: 1 },
    completedPartitions: [],
    pendingPartitions: [{ partitionId: 'dir:a', kind: 'directory', targets: ['/a'], sourceStamps: [] }],
    boundedTraversalCursors: [],
    workCounts: { visited: 12 },
    sourceStamps: [],
    createdAt: '2026-09-05T12:00:00.000Z',
    sourceIdentityDigest: 'sid-1',
    exclusionsDigest: 'exc-1',
    safetyPolicyDigest: 'pol-1',
    ...overrides,
  };
}

test('MNT-PERF-005: a checkpoint round-trips with a bounded size and sealed integrity', (t) => {
  const dir = path.join(fixture(t), 'management', 'checkpoints');
  const store = createCheckpointStore(dir, { fsImpl: fs, now: () => Date.parse('2026-09-05T12:00:00.000Z') });
  const written = store.write(baseCheckpoint());
  assert.equal(written.schemaVersion, 'maintenance-scan-checkpoint/v1');
  assert.ok(written.integrity?.digest);

  // Windows permissions do not expose POSIX owner/group mode bits.
  if (process.platform !== 'win32') {
    const stat = fs.lstatSync(path.join(dir, `${written.scanId}.json`));
    assert.equal(stat.mode & 0o777, 0o600);
    const dirStat = fs.lstatSync(dir);
    assert.equal(dirStat.mode & 0o777, 0o700);
  }

  const read = store.read(written.scanId);
  assert.deepEqual(read.pendingPartitions, written.pendingPartitions);
  assert.ok(Buffer.byteLength(JSON.stringify(read)) <= MAX_CHECKPOINT_BYTES);
});

test('a checkpoint exceeding the size ceiling is refused, not silently truncated', (t) => {
  const dir = path.join(fixture(t), 'management', 'checkpoints');
  const store = createCheckpointStore(dir, { fsImpl: fs, now: Date.now });
  const huge = baseCheckpoint({
    pendingPartitions: Array.from({ length: 5000 }, (_, i) => ({
      partitionId: `dir:${i}`, kind: 'directory', targets: [`/very/long/path/segment/${i}`], sourceStamps: [],
    })),
  });
  assert.throws(() => store.write(huge), /exceeds/);
});

test('a checkpoint whose integrity digest no longer matches is treated as absent', (t) => {
  const dir = path.join(fixture(t), 'management', 'checkpoints');
  const store = createCheckpointStore(dir, { fsImpl: fs, now: Date.now });
  const written = store.write(baseCheckpoint());
  const file = path.join(dir, `${written.scanId}.json`);
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.workCounts.visited = 999999;
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.equal(store.read(written.scanId), null);
});

test('MNT-DSC-012 continuation floor: a checkpoint older than the retention window expires', (t) => {
  const dir = path.join(fixture(t), 'management', 'checkpoints');
  let now = Date.parse('2026-09-01T00:00:00.000Z');
  const store = createCheckpointStore(dir, { fsImpl: fs, now: () => now });
  const written = store.write(baseCheckpoint());
  now = Date.parse('2026-09-01T00:00:00.000Z') + 8 * 86_400_000; // 8 days later
  assert.equal(store.read(written.scanId), null);
  assert.deepEqual(store.list(), []);
});

test('validateForResume accepts a matching context and rejects each drift with a factual reason', () => {
  const checkpoint = baseCheckpoint();
  const matching = {
    sourceIdentityDigest: 'sid-1', environmentId: 'env_test0000000000000000000',
    exclusionsDigest: 'exc-1', contractVersions: { walk: 1 }, safetyPolicyDigest: 'pol-1',
  };
  assert.deepEqual(validateForResume(checkpoint, matching), { valid: true, reason: null });

  assert.match(validateForResume(checkpoint, { ...matching, environmentId: 'env_other' }).reason, /environment/);
  assert.match(validateForResume(checkpoint, { ...matching, sourceIdentityDigest: 'sid-2' }).reason, /source identity/);
  assert.match(validateForResume(checkpoint, { ...matching, exclusionsDigest: 'exc-2' }).reason, /exclusions/);
  assert.match(validateForResume(checkpoint, { ...matching, safetyPolicyDigest: 'pol-2' }).reason, /safety policy/);
  assert.match(validateForResume(checkpoint, { ...matching, contractVersions: { walk: 2 } }).reason, /observation contract/);
  assert.match(validateForResume(null, matching).reason, /no checkpoint/);
});

test('validateForResume is insensitive to observationContractVersions key order', () => {
  const checkpoint = baseCheckpoint({ observationContractVersions: { a: 1, b: 2 } });
  const context = {
    sourceIdentityDigest: 'sid-1', environmentId: 'env_test0000000000000000000',
    exclusionsDigest: 'exc-1', contractVersions: { b: 2, a: 1 }, safetyPolicyDigest: 'pol-1',
  };
  assert.equal(validateForResume(checkpoint, context).valid, true);
});

test('contextDigest is a stable, order-insensitive hash of arbitrary identity material', () => {
  assert.equal(contextDigest({ a: 1, b: 2 }), contextDigest({ b: 2, a: 1 }));
  assert.notEqual(contextDigest({ a: 1 }), contextDigest({ a: 2 }));
});

test('checkpoint.remove is idempotent and store.list only names existing scans', (t) => {
  const dir = path.join(fixture(t), 'management', 'checkpoints');
  const store = createCheckpointStore(dir, { fsImpl: fs, now: Date.now });
  const written = store.write(baseCheckpoint());
  assert.deepEqual(store.list(), [written.scanId]);
  store.remove(written.scanId);
  store.remove(written.scanId); // idempotent
  assert.deepEqual(store.list(), []);
  assert.equal(store.read(written.scanId), null);
});
