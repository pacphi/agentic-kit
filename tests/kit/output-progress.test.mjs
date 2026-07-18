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

test('the interval actually ticks: elapsed time advances second by second', async (t) => {
  // Mocked clock so the 1s interval and Date.now() are driven, not real-time —
  // without this, every thunk resolves before the first tick and the entire
  // ticker (the feature) could be deleted with the suite staying green.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const out = sink();
  let release;
  const p = withProgress('upgrade ruflo', () => new Promise((r) => { release = r; }), { tty: true, out });
  assert.match(out.writes[0], /upgrade ruflo/);
  assert.match(out.writes[0], /0s/); // initial render at t=0
  t.mock.timers.tick(1000);
  assert.match(out.writes.at(-1), /1s/); // interval fired, elapsed advanced
  release('done');
  assert.equal(await p, 'done');
  assert.equal(out.writes.at(-1), '\r\x1b[K');
});

test('minute rollover formats as XmYYs with zero-padded seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const out = sink();
  let release;
  const p = withProgress('brain KB', () => new Promise((r) => { release = r; }), { tty: true, out });
  t.mock.timers.tick(61_000); // 61 ticks; last render at t=61s
  assert.match(out.writes.at(-1), /1m01s/); // not '1m1s', not '61s'
  release('v');
  await p;
});

test('labels are interpolated verbatim — including real callers with metachars', async () => {
  // Real sync labels include 'providers (api)' and 'upgrade @openai/codex';
  // the ticker must render them literally (plain interpolation, no formatting).
  const out = sink();
  await withProgress('providers (api)', async () => 'v', { tty: true, out });
  assert.ok(out.writes[0].includes('providers (api)'));
});
