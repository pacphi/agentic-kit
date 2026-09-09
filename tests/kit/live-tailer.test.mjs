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

test('tailer bounds each reconciliation, retains burst backlog, and decodes split UTF-8', (t) => {
  const file = tempFile();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const lines = Array.from({ length: 20 }, (_, n) => ({ n, text: 'é😀' }));
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
  const rows = [], coverage = [];
  const tailer = new JsonlTailer(file, {
    onRecord: (row) => rows.push(row), onCoverage: (value) => coverage.push(value),
    maxChunkBytes: 7, maxReadBytes: 31,
  });
  tailer.reconcile();
  assert.ok(rows.length < lines.length, 'a burst must not be acquired in one reconciliation');
  assert.ok(coverage.at(-1).pendingBytes > 0);
  fs.appendFileSync(file, '{"n":20}\n');
  for (let i = 0; i < 100; i++) tailer.reconcile();
  assert.deepEqual(rows, [...lines, { n: 20 }]);
  assert.equal(coverage.at(-1).complete, true);
});

test('tailer discards oversized incomplete lines with explicit coverage and recovers at newline', (t) => {
  const file = tempFile();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, '{"text":"' + 'x'.repeat(80));
  const rows = [], coverage = [];
  const tailer = new JsonlTailer(file, {
    onRecord: (row) => rows.push(row), onCoverage: (value) => coverage.push(value),
    maxChunkBytes: 9, maxReadBytes: 100, maxLineBytes: 32,
  });
  tailer.reconcile();
  assert.equal(coverage.at(-1)?.truncated, true);
  assert.equal(coverage.at(-1).droppedLines, 1);
  assert.ok(coverage.at(-1).bufferedBytes <= 32);
  fs.appendFileSync(file, 'x'.repeat(80) + '"}\n{"n":1}\n');
  tailer.reconcile();
  assert.deepEqual(rows, [{ n: 1 }]);
  assert.equal(coverage.at(-1).droppedLines, 1);
  assert.equal(coverage.at(-1).complete, false);
});
