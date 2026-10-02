import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distinctErrorReporter } from '../../src/lib/dashboard/watch-errors.mjs';

test('distinctErrorReporter logs each distinct failure once, with the label and the error itself', () => {
  const lines = [];
  const report = distinctErrorReporter('failed:', (...args) => lines.push(args));
  const first = new Error('EACCES: permission denied');
  report(first);
  report(new Error('EACCES: permission denied'));
  report(new Error('ENOSPC: no space left'));
  report('plain text');
  report('plain text');
  assert.deepEqual(lines, [['failed:', first], ['failed:', lines[1][1]], ['failed:', 'plain text']]);
  assert.equal(lines[1][1].message, 'ENOSPC: no space left');
});

test('distinctErrorReporter forgets old messages instead of growing without bound', () => {
  const lines = [];
  const report = distinctErrorReporter('failed:', (...args) => lines.push(args));
  for (let i = 0; i < 25; i++) report(new Error(`failure ${i}`));
  assert.equal(lines.length, 25);
  report(new Error('failure 0')); // forgotten after the cap, so it can be reported again
  assert.equal(lines.length, 26);
});

test('distinctErrorReporter defaults to stderr through console.error', (t) => {
  const calls = [];
  t.mock.method(console, 'error', (...args) => calls.push(args));
  distinctErrorReporter('[dashboard] x:')(new Error('boom'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '[dashboard] x:');
});
