// Every in-process open-and-verify read must compare file identity exactly.
// NTFS file IDs carry a sequence number in the top 16 bits, so they can exceed
// 2^53: as Numbers, two different files can read as the same inode (CI run
// 36341703517, Windows Node 22). Each case hands the reader two IDs that are
// exact when it asks for { bigint: true } and collide when it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { tempDir } from './helpers/temp-dir.mjs';
import { readBoundedFile } from '../../src/lib/hook-audit/common.mjs';
import { inspectHookTarget } from '../../src/lib/hook-remediation/fs-port.mjs';
import { readHookReceipt, writeHookReceipt } from '../../src/lib/hook-remediation/store.mjs';
import { hashAdapterContent } from '../../src/lib/adapters/integrity.mjs';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { createInventorySnapshotStore } from '../../src/lib/maintenance/management/service-store.mjs';

const ID_A = 2n ** 53n;
const ID_B = 2n ** 53n + 1n;
const RECEIPT_ID = 'tx-2026-09-27T00-00-00.000Z-0123456789abcdef';

function withIno(stat, id, options) {
  if (id !== undefined) stat.ino = options?.bigint ? id : Number(id);
  return stat;
}

/** A real fs whose lstat of `file` and whose fstat calls report the listed IDs, in call order. */
function collidingFs(file, { lstat = [], fstat = [] }) {
  let lstats = 0;
  let fstats = 0;
  return {
    ...fs,
    lstatSync: (target, options) => withIno(fs.lstatSync(target, options), target === file ? lstat[lstats++] : undefined, options),
    fstatSync: (fd, options) => withIno(fs.fstatSync(fd, options), fstat[fstats++], options),
  };
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function hookManifest() {
  return validateAdapterManifest({
    name: 'hermes', version: '1.0.0', contract: 1,
    host: {
      id: 'hermes', label: 'Hermes',
      install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
      capabilities: {
        canDriveSession: false, canBePrimary: false, canRouteActivities: true,
        commandStatusline: false, transcripts: false, usage: false,
        nativeMcpConfig: false, nativeGuidance: false,
      },
      trust: { approvalPolicy: 'unchanged', changes: [] },
      enabledByDefault: false, configProjection: 'ruflo', observability: [],
    },
    detection: { bin: 'hermes' },
    driving: { surfaces: ['cli-subprocess'] },
    lifecycle: { detect: { hook: { command: [process.execPath, 'detect-hook.mjs'], files: ['detect-hook.mjs'] } } },
    trust: { changes: [] },
  });
}

const CASES = [
  {
    site: 'hook-audit readBoundedFile: lstat vs fstat',
    run(t, root) {
      const file = path.join(root, 'hooks.json');
      fs.writeFileSync(file, '{}');
      const lstat = fs.lstatSync;
      const fstat = fs.fstatSync;
      t.mock.method(fs, 'lstatSync', (target, options) => withIno(lstat(target, options), target === file ? ID_A : undefined, options));
      t.mock.method(fs, 'fstatSync', (fd, options) => withIno(fstat(fd, options), ID_B, options));
      assert.equal(readBoundedFile(file, root).status, 'refused');
    },
  },
  {
    site: 'hook-remediation inspectHookTarget: lstat vs fstat',
    run(t, root) {
      const file = path.join(root, 'hooks.json');
      fs.writeFileSync(file, '{}');
      const fsImpl = collidingFs(file, { lstat: [ID_A], fstat: [ID_B] });
      assert.throws(() => inspectHookTarget(file, root, { fsImpl }), /identity changed between inspection and open/);
    },
  },
  {
    site: 'hook-remediation writeHookReceipt: transaction directory before vs at commit',
    run(t, root) {
      const dir = privateDir(path.join(root, RECEIPT_ID));
      const fsImpl = collidingFs(dir, { lstat: [ID_A, ID_B] });
      assert.throws(() => writeHookReceipt(path.join(dir, 'receipt.json'), { id: RECEIPT_ID }, { fsImpl }),
        /transaction directory changed before commit/);
    },
  },
  {
    site: 'hook-remediation writeHookReceipt: prior receipt before vs at commit',
    run(t, root) {
      const dir = privateDir(path.join(root, RECEIPT_ID));
      const receiptFile = path.join(dir, 'receipt.json');
      fs.writeFileSync(receiptFile, '{}', { mode: 0o600 });
      const fsImpl = collidingFs(receiptFile, { lstat: [ID_A, ID_B] });
      assert.throws(() => writeHookReceipt(receiptFile, { id: RECEIPT_ID }, { fsImpl }), /receipt changed before commit/);
    },
  },
  {
    site: 'hook-remediation readHookReceipt: lstat vs fstat',
    run(t, root) {
      const transactions = privateDir(path.join(root, 'transactions'));
      const receiptFile = path.join(privateDir(path.join(transactions, RECEIPT_ID)), 'receipt.json');
      fs.writeFileSync(receiptFile, '{}', { mode: 0o600 });
      const fsImpl = collidingFs(receiptFile, { lstat: [ID_A], fstat: [ID_B] });
      assert.throws(() => readHookReceipt(transactions, RECEIPT_ID, { fsImpl }), /identity changed while opening/);
    },
  },
  {
    site: 'adapters digestFile: lstat vs fstat',
    run(t, root) {
      const file = path.join(root, 'detect-hook.mjs');
      fs.writeFileSync(file, 'process.stdout.write("one");\n');
      const fsImpl = collidingFs(file, { lstat: [ID_A], fstat: [ID_B, ID_B] });
      assert.throws(() => hashAdapterContent(hookManifest(), { baseDir: root, fsImpl }), /changed between inspection and open/);
    },
  },
  {
    site: 'adapters digestFile: fstat before vs after the read',
    run(t, root) {
      const file = path.join(root, 'detect-hook.mjs');
      fs.writeFileSync(file, 'process.stdout.write("one");\n');
      const fsImpl = collidingFs(file, { lstat: [ID_A], fstat: [ID_A, ID_B] });
      assert.throws(() => hashAdapterContent(hookManifest(), { baseDir: root, fsImpl }), /changed while it was read/);
    },
  },
  {
    site: 'maintenance inventory snapshot read: lstat vs fstat',
    run(t, root) {
      createInventorySnapshotStore(root, { fsImpl: fs }).write({ probe: true });
      const fsImpl = collidingFs(path.join(root, 'inventory-latest.json.gz'), { lstat: [ID_A], fstat: [ID_B] });
      assert.equal(createInventorySnapshotStore(root, { fsImpl }).read(), null);
    },
  },
];

test('the simulated Windows file IDs are distinct but collide as Numbers', () => {
  assert.notEqual(ID_A, ID_B);
  assert.equal(Number(ID_A), Number(ID_B));
});

for (const { site, run } of CASES) {
  test(`${site} refuses a different file whose ID exceeds 2^53`, (t) => run(t, tempDir('ak-file-identity', t)));
}
