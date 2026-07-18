// withProgress — the live elapsed-time ticker around slow sync heals (the
// ~512 MB brain KB download sat silent for 4m25s before this existed; run()
// buffers child output, so the parent must supply the liveness signal).
// Contract under test: transparent passthrough (value and rejection are the
// thunk's, always), ticker bytes only on a TTY, and the line is erased before
// the caller's ok/fail prints. Hermetic via the injectable {tty, out} seam —
// never touches the real stdout, so results don't depend on how tests are run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProgress } from '../../src/lib/output.mjs';

const sink = () => {
  const writes = [];
  return { writes, write: (s) => { writes.push(String(s)); return true; } };
};

test('resolves with the thunk value', async () => {
  const out = sink();
  assert.equal(await withProgress('x', async () => 42, { tty: false, out }), 42);
});

test('propagates thunk rejection unchanged (never swallows errors)', async () => {
  const out = sink();
  await assert.rejects(
    () => withProgress('x', async () => { throw new Error('boom'); }, { tty: false, out }),
    /boom/);
});

test('non-TTY: zero ticker bytes (piped/--json output stays clean)', async () => {
  const out = sink();
  await withProgress('label', async () => 'v', { tty: false, out });
  assert.deepEqual(out.writes, []);
});

test('TTY: renders the label immediately, erases the line last', async () => {
  const out = sink();
  await withProgress('upgrade ruflo', async () => 'v', { tty: true, out });
  assert.ok(out.writes.length >= 2, 'initial render + erase');
  assert.match(out.writes[0], /upgrade ruflo/);
  assert.match(out.writes[0], /^\r/); // rewrites in place, never scrolls
  assert.equal(out.writes.at(-1), '\r\x1b[K'); // caller's result line prints fresh
});

test('TTY: erases the line even when the thunk throws', async () => {
  const out = sink();
  await assert.rejects(
    () => withProgress('x', async () => { throw new Error('boom'); }, { tty: true, out }),
    /boom/);
  assert.equal(out.writes.at(-1), '\r\x1b[K');
});
