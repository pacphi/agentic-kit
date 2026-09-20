import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createInventorySnapshotStore } from '../../src/lib/maintenance/management/service-store.mjs';

test('should_refuseOversizedInventory_before_readingRetainedBytes', () => {
  let reads = 0;
  const fsImpl = { ...fs,
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 70 * 1024 * 1024 }),
    readFileSync: () => { reads++; throw new Error('unexpected read'); },
  };
  createInventorySnapshotStore(path.join(os.tmpdir(), 'unused'), { fsImpl }).read();
  assert.equal(reads, 0);
});
test('should_boundDecompression_when_readingCompressedInventory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-telemetry-bound-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'inventory-latest.json.gz'), zlib.gzipSync('{}'));
  const original = zlib.gunzipSync;
  let options;
  t.mock.method(zlib, 'gunzipSync', (buffer, value) => { options = value; return original(buffer, value); });
  createInventorySnapshotStore(root, { fsImpl: fs }).read();
  assert.equal(options?.maxOutputLength, 64 * 1024 * 1024);
});
