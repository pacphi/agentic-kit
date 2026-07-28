import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTailer } from '../../src/lib/live/index.mjs';

const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-'));
  return path.join(dir, 'events.jsonl');
};

test('tailer waits for newline before parsing a partial record', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{"n":1');
  const rows = [];
  const tailer = new JsonlTailer(file, { onRecord: (row) => rows.push(row) });
  tailer.reconcile();
  assert.deepEqual(rows, []);
  fs.appendFileSync(file, '}\n{"n":2}\n');
  tailer.reconcile();
  assert.deepEqual(rows, [{ n: 1 }, { n: 2 }]);
});

test('tailer recovers from truncation and inode replacement', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{"n":1}\n');
  const rows = [];
  const tailer = new JsonlTailer(file, { onRecord: (row) => rows.push(row) });
  tailer.reconcile();
  fs.truncateSync(file, 0);
  tailer.reconcile();
  fs.appendFileSync(file, '{"n":2}\n');
  tailer.reconcile();
  const replacement = `${file}.new`;
  fs.writeFileSync(replacement, '{"n":3}\n');
  fs.renameSync(replacement, file);
  tailer.reconcile();
  assert.deepEqual(rows, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('tailer isolates malformed lines and continues', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{"n":1}\nnot-json\n{"n":2}\n');
  const rows = [];
  const errors = [];
  new JsonlTailer(file, {
    onRecord: (row) => rows.push(row), onError: (error, line) => errors.push([error, line]),
  }).reconcile();
  assert.deepEqual(rows, [{ n: 1 }, { n: 2 }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], 'not-json');
});
