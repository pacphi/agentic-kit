// captureOutput — lets a live check keep its own printed lines: the verify
// runner reads a failed proof's first ✗ line as the remembered reason, and
// `ak status --live` runs several checks at once without mixing their output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as output from '../../src/lib/output.mjs';

async function withConsole(fn) {
  const printed = [];
  const real = console.log;
  console.log = (...a) => printed.push(a.join(' '));
  try { return { value: await fn(), printed }; } finally { console.log = real; }
}

test('captured lines are collected with their level and not printed', async () => {
  const { value, printed } = await withConsole(() => output.captureOutput(async () => {
    output.heading('suite');
    output.ok('fine');
    output.fail('broken thing');
    return 7;
  }));
  assert.equal(value.result, 7);
  assert.deepEqual(value.entries, [
    { level: 'heading', text: 'suite' }, { level: 'ok', text: 'fine' }, { level: 'fail', text: 'broken thing' },
  ]);
  assert.deepEqual(printed, []);
});

test('echo prints the lines as well as collecting them', async () => {
  const { value, printed } = await withConsole(() => output.captureOutput(async () => {
    output.warn('careful');
  }, { echo: true }));
  assert.deepEqual(value.entries, [{ level: 'warn', text: 'careful' }]);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /careful/);
});

test('parallel captures never mix their lines', async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const check = (name) => output.captureOutput(async () => {
    for (let i = 0; i < 3; i++) { output.info(`${name}-${i}`); await tick(); }
  });
  const [a, b] = await Promise.all([check('a'), check('b')]);
  assert.deepEqual(a.entries.map((e) => e.text), ['a-0', 'a-1', 'a-2']);
  assert.deepEqual(b.entries.map((e) => e.text), ['b-0', 'b-1', 'b-2']);
});

test('lines outside any capture still print', async () => {
  const { printed } = await withConsole(() => output.ok('plain'));
  assert.equal(printed.length, 1);
});
