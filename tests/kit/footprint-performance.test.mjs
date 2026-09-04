import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectConsumers } from '../../src/lib/footprint/consumers.mjs';

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ak-footprint-perf-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('allocated-size consumers reuse the walker stat instead of lstatting every file twice', (t) => {
  const root = fixture(t, 'allocated');
  fs.writeFileSync(path.join(root, 'one.bin'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(root, 'two.bin'), Buffer.alloc(8192, 2));

  let lstats = 0;
  const fsImpl = {
    ...fs,
    lstatSync(target, options) {
      lstats += 1;
      return fs.lstatSync(target, options);
    },
  };
  const expectedAllocated = ['one.bin', 'two.bin']
    .map((name) => fs.lstatSync(path.join(root, name)).blocks * 512)
    .reduce((total, bytes) => total + bytes, 0);

  const result = collectConsumers({
    roots: [{ id: 'allocated', label: 'allocated', path: root, allocation: 'blocks' }],
    fsImpl,
    platform: 'darwin',
    now: () => 1,
  });
  const row = result.rows.find((candidate) => candidate.id === 'allocated');

  assert.equal(row.bytes.value, expectedAllocated);
  assert.equal(row.basis, 'allocated-blocks');
  assert.equal(lstats, 3, 'one root and two files should each be lstatted exactly once');
});
