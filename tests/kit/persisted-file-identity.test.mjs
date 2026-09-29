import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { tempDir } from './helpers/temp-dir.mjs';
import { planPartitions, partitionDrifted } from '../../src/lib/maintenance/discovery/partitions.mjs';
import { inspectHookTarget, atomicReplaceHookTarget } from '../../src/lib/hook-remediation/fs-port.mjs';
import { JsonlTailer } from '../../src/lib/live/jsonl-tailer.mjs';
import { createHostHealthSnapshot } from '../../src/lib/host-health-evidence.mjs';
import { HOOK_HEAL_RECEIPT_SCHEMA, readHookReceipt, writeHookReceipt } from '../../src/lib/hook-remediation/store.mjs';
import { inspectHostAlignment } from '../../src/lib/host-alignment.mjs';
import { TranscriptStreams } from '../../src/lib/live/transcript-streams.mjs';

const A = 9007199254740992n;
const B = 9007199254740993n;

test('Discovery stamp survives JSON with adjacent 64-bit inodes and fractional mtime', (t) => {
  const root = tempDir('ak-partition-id', t);
  const lstatSync = fs.lstatSync;
  let ino = A;
  const fsImpl = { ...fs, lstatSync(target, options) {
    const stat = lstatSync(target, options);
    stat.ino = options?.bigint ? ino : Number(ino);
    return stat;
  } };
  const stamp = planPartitions(root, { fsImpl }).partitions[0].sourceStamps[0];
  assert.equal(stamp.ino, '9007199254740992');
  assert.equal(typeof stamp.mtimeMs, 'number');
  assert.equal(stamp.mtimeMs, lstatSync(root).mtimeMs);
  const restored = JSON.parse(JSON.stringify(stamp));
  assert.equal(partitionDrifted({ sourceStamps: [{ ...restored, ino: Number(A) }] }, { fsImpl }), true,
    'unsafe legacy number cannot authorize a match');
  ino = B;
  assert.equal(partitionDrifted({ sourceStamps: [restored] }, { fsImpl }), true);
  for (const malformed of ['-1', '01', -1]) {
    assert.equal(partitionDrifted({ sourceStamps: [{ ...restored, ino: malformed }] }, { fsImpl }), true);
  }
  ino = 42n;
  const safeStamp = planPartitions(root, { fsImpl }).partitions[0].sourceStamps[0];
  assert.equal(partitionDrifted({ sourceStamps: [{ ...safeStamp, ino: 42 }] }, { fsImpl }), false);
});

test('hook target parent identity survives JSON and refuses adjacent replacement', (t) => {
  const root = tempDir('ak-hook-parent-id', t);
  const file = path.join(root, 'hook.json');
  fs.writeFileSync(file, '{}');
  const statSync = fs.statSync;
  let ino = A;
  const fsImpl = { ...fs, statSync(target, options) {
    const stat = statSync(target, options);
    if (target === root) stat.ino = options?.bigint ? ino : Number(ino);
    return stat;
  } };
  const snapshot = inspectHookTarget(file, root, { fsImpl });
  assert.equal(snapshot.parent.ino, '9007199254740992');
  const savedParent = JSON.parse(JSON.stringify(snapshot.parent));
  ino = B;
  assert.throws(() => atomicReplaceHookTarget({ ...snapshot, parent: savedParent }, Buffer.from('[]'), undefined, { fsImpl }),
    /target parent changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});

test('hook snapshot gets identity and fractional mtime from one descriptor stat', (t) => {
  const root = tempDir('ak-hook-one-stat', t);
  const file = path.join(root, 'hook.json');
  fs.writeFileSync(file, '{}');
  const fstatSync = fs.fstatSync;
  let calls = 0;
  const fsImpl = { ...fs, fstatSync(fd, options) {
    calls++;
    assert.equal(options?.bigint, true);
    const stat = fstatSync(fd, options);
    stat.ino = A;
    return stat;
  }, lstatSync(target, options) {
    const stat = fs.lstatSync(target, options);
    if (target === file) stat.ino = A;
    return stat;
  } };
  const snapshot = inspectHookTarget(file, root, { fsImpl });
  assert.equal(calls, 1);
  assert.equal(snapshot.mtimeMs, fs.statSync(file).mtimeMs);
});

test('JSONL replacement with a colliding Number inode resets offset and emits new records', (t) => {
  const root = tempDir('ak-tailer-id', t);
  const file = path.join(root, 'events.jsonl');
  fs.writeFileSync(file, '{"a":1}\n');
  const statSync = fs.statSync;
  let ino = A;
  t.mock.method(fs, 'statSync', (target, options) => {
    const stat = statSync(target, options);
    if (target === file) stat.ino = options?.bigint ? ino : Number(ino);
    return stat;
  });
  const records = [];
  const tailer = new JsonlTailer(file, { onRecord: record => records.push(record) });
  tailer.reconcile();
  fs.writeFileSync(file, '{"b":2}\n');
  ino = B;
  tailer.reconcile();
  assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
});

test('host health evidence changes when adjacent 64-bit launcher inode changes', (t) => {
  const root = tempDir('ak-health-id', t);
  const launcher = path.join(root, 'codex');
  fs.writeFileSync(launcher, 'launcher');
  const statSync = fs.statSync;
  let ino = A;
  t.mock.method(fs, 'statSync', (target, options) => {
    const stat = statSync(target, options);
    if (target === launcher) stat.ino = options?.bigint ? ino : Number(ino);
    return stat;
  });
  const snapshot = createHostHealthSnapshot({ env: { PATH: root }, inputPaths: () => [] });
  const before = snapshot({ cwd: root, cfg: {} }).key;
  ino = B;
  assert.notEqual(snapshot({ cwd: root, cfg: {} }).key, before);
});

test('hook receipt accepts exact parent IDs but refuses unsafe legacy Numbers', (t) => {
  const root = tempDir('ak-receipt-id', t);
  fs.chmodSync(root, 0o700);
  const id = 'tx-2026-09-29T00-00-00.000Z-0123456789abcdef';
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, 'receipt.json');
  const digest = 'a'.repeat(64);
  const receipt = {
    schemaVersion: HOOK_HEAL_RECEIPT_SCHEMA, id, createdAt: new Date().toISOString(),
    status: 'prepared', planDigest: digest, auditId: 'audit',
    authorization: { mechanism: 'explicit-action-selection', actionIds: ['one'], trustMutationAuthorized: false },
    actions: [{
      id: 'one', host: 'codex', hostVersion: '1', recipeId: 'recipe', profileId: 'profile',
      target: path.join(root, 'hook'), containmentRoot: root, classification: 'safe-automatic', state: 'prepared',
      preimage: { sha256: digest, size: 2, mode: 0o600, modeSupported: true,
        uid: null, gid: null, specialMode: 0, parent: { realPath: root, dev: '1', ino: '9007199254740993' } },
      postimage: { sha256: digest, size: 2, mode: 0o600, modeSupported: true },
      backup: { relative: path.join('backups', '0000.bin'), sha256: digest, size: 2 },
    }],
  };
  writeHookReceipt(file, receipt);
  assert.equal(readHookReceipt(root, id).receipt.actions[0].preimage.parent.ino, '9007199254740993');
  receipt.actions[0].preimage.parent.ino = Number(B);
  writeHookReceipt(file, receipt);
  assert.throws(() => readHookReceipt(root, id), /receipt action image is invalid/);
  for (const malformed of ['-1', '01', -1]) {
    receipt.actions[0].preimage.parent.ino = malformed;
    writeHookReceipt(file, receipt);
    assert.throws(() => readHookReceipt(root, id), /receipt action image is invalid/);
  }
  receipt.actions[0].preimage.parent.ino = 42;
  writeHookReceipt(file, receipt);
  assert.equal(readHookReceipt(root, id).receipt.actions[0].preimage.parent.ino, 42);
});

test('host alignment snapshot serializes adjacent file IDs distinctly', (t) => {
  const root = tempDir('ak-align-id', t);
  const file = path.join(root, '.mcp.json');
  fs.writeFileSync(file, '{}');
  const lstatSync = fs.lstatSync;
  let ino = A;
  t.mock.method(fs, 'lstatSync', (target, options) => {
    const stat = lstatSync(target, options);
    if (target === file) stat.ino = options?.bigint ? ino : Number(ino);
    return stat;
  });
  const options = { home: root, codexHome: path.join(root, '.codex'), projectRoots: [root] };
  const before = inspectHostAlignment(options);
  assert.equal(before.snapshots.find(s => s.file === file).identity.inode, '9007199254740992');
  ino = B;
  assert.notEqual(inspectHostAlignment(options).digest, before.digest);
});

test('transcript replay cursor distinguishes adjacent 64-bit file epochs', (t) => {
  const root = tempDir('ak-transcript-id', t);
  const file = path.join(root, 'session-1.jsonl');
  fs.writeFileSync(file, '');
  const statSync = fs.statSync;
  let ino = A;
  t.mock.method(fs, 'statSync', (target, options) => {
    const stat = statSync(target, options);
    if (target === file) stat.ino = options?.bigint ? ino : Number(ino);
    return stat;
  });
  const first = new TranscriptStreams({ roots: { claude: root }, mask: value => value });
  const before = first.open('claude', 'session-1').snapshot().cursor;
  first.close();
  ino = B;
  const second = new TranscriptStreams({ roots: { claude: root }, mask: value => value });
  const after = second.open('claude', 'session-1').snapshot().cursor;
  second.close();
  assert.notEqual(before, after);
});
