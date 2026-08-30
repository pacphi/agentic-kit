// withProgress — the live elapsed-time ticker around slow sync heals (the
// ~512 MB brain KB download sat silent for 4m25s before this existed; run()
// buffers child output, so the parent must supply the liveness signal).
// Contract under test: transparent passthrough (value and rejection are the
// thunk's, always), ticker bytes only on a TTY, and the line is erased before
// the caller's ok/fail prints. Hermetic via the injectable {tty, out} seam —
// never touches the real stdout, so results don't depend on how tests are run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reportOutcome, withProgress, sanitizeForTerminal, dim, bold,
} from '../../src/lib/output.mjs';

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

test('managed outcomes render degraded and failed states without green success', () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    assert.equal(reportOutcome('solver', { ok: true, status: 'degraded', detail: 'fallback' }), 'degraded');
    assert.equal(reportOutcome('brain', { ok: false, status: 'failed', detail: 'exit 1' }), 'failed');
  } finally { console.log = original; }
  assert.match(lines[0], /⚠.*solver: fallback/);
  assert.match(lines[1], /✗.*brain: exit 1/);
  assert.doesNotMatch(lines.join('\n'), /✓/);
});

// exitWhenFlushed — the pipe-safe exit for the bin entry. process.exit() kills
// the process before a piped stdout drains, so any command whose output tops
// the ~64KB pipe buffer (ak usage prompts --json is ~268KB on the reference
// corpus) truncates for every `| jq` consumer. The fix defers the hard exit
// until stdout and stderr report their queues flushed. Tested end-to-end
// through a real child process and a real pipe — the buffer behavior being
// pinned does not exist in-process.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUTPUT_MJS = fileURLToPath(new URL('../../src/lib/output.mjs', import.meta.url));
const PAYLOAD = 200 * 1024;

const runChild = (tailJs) => spawnSync(process.execPath, ['--input-type=module', '-e',
  `import { exitWhenFlushed } from ${JSON.stringify(OUTPUT_MJS)};
   process.stdout.write('x'.repeat(${PAYLOAD}));
   ${tailJs}`,
], { encoding: 'utf8', maxBuffer: 4 * PAYLOAD });

test('exitWhenFlushed delivers the full piped payload past the 64KB pipe buffer', () => {
  const r = runChild('exitWhenFlushed(0);');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, PAYLOAD);
});

test('exitWhenFlushed propagates a nonzero exit code', () => {
  const r = runChild('exitWhenFlushed(3);');
  assert.equal(r.status, 3);
  assert.equal(r.stdout.length, PAYLOAD);
});

// ── SEC-5: a stalled pipe consumer must not hang the exit forever ──────────
// Security review SEC-5 (MEDIUM). The exit sits inside two nested write
// callbacks with no timeout and no fallback. The review measured it: a
// consumer that OPENS the pipe and never reads it, plus a payload above the
// ~64 KB pipe buffer, never exits — it took SIGKILL at 8 s. A draining
// consumer, a consumer that reads one chunk and destroys, and one that
// destroys immediately all exited in under a second, which is why the tests
// written alongside the drain fix (above) did not see this: they all drain.
//
// The shape that hits it is ordinary — a paused pager, a `tee` into a blocked
// sink, a lazy CI step. Availability only, but it is a new hang in a path that
// previously could not hang: before the drain fix the bin called
// process.exit(code) directly and returned immediately.

test('SEC-5: a consumer that opens the pipe and never reads it still exits, bounded', () => {
  // The parent holds the read end open without reading, exactly as the review
  // did. Without the bounded fallback this never resolves.
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { exitWhenFlushed } from ${JSON.stringify(OUTPUT_MJS)};
     process.stdout.write('x'.repeat(${PAYLOAD}));
     exitWhenFlushed(7);`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.pause(); // open, never read — the stalled-consumer case

  const started = Date.now();
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('exitWhenFlushed never exited against a stalled consumer'));
    }, 15_000);
    child.on('exit', (code) => {
      clearTimeout(guard);
      const elapsed = Date.now() - started;
      try {
        assert.equal(code, 7, 'the exit code must survive the fallback path');
        assert.ok(elapsed < 10_000, `took ${elapsed}ms — the bounded fallback did not fire`);
        resolve();
      } catch (err) { reject(err); }
    });
  });
});

// ── sanitizeForTerminal — the render-time half of SEC-2 ─────────────────────
// The security review demonstrated four independent paths that carried raw
// ESC/BEL/NUL bytes to the terminal, and captured every one of them with
// stdout redirected to a FILE: the bytes land in the file and fire when it is
// later `cat`'d. The stores now reject such text at rest; this is the last
// line, and the only one covering `--deep`'s raw transcript text.
//
// The forbidden ranges are spelled out HERE, independently of the module's
// own list, so narrowing that list fails this test rather than agreeing with
// it. Written as numbers so this file carries none of the bytes it forbids.
const FORBIDDEN = new RegExp(`[${[
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069],
].map(([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`).join('')}]`);

const CH = (code) => String.fromCharCode(code);
const ESC = CH(0x1b);
const BEL = CH(0x07);

test('sanitizeForTerminal removes every demonstrated control-sequence primitive', () => {
  const cases = {
    'screen clear': `${ESC}[2J`,
    'cursor home': `${ESC}[1;1H`,
    conceal: `${ESC}[8m HIDDEN ${ESC}[28m`,
    'OSC-0 window title': `${ESC}]0;PWNED${BEL}`,
    'OSC-52 clipboard write': `${ESC}]52;c;cm0gLXJmIH4=${BEL}`,
    bell: BEL,
    nul: CH(0x00),
    backspace: CH(0x08),
    'C1 CSI': CH(0x9b),
    'bidi override': CH(0x202e),
    'carriage-return line overwrite': `${CH(0x0d)}OVERWRITTEN`,
  };
  for (const [why, payload] of Object.entries(cases)) {
    const out = sanitizeForTerminal(`before ${payload} after`);
    assert.ok(!FORBIDDEN.test(out),
      `${why}: output still carries a forbidden character: ${JSON.stringify(out)}`);
  }
});

test('sanitizeForTerminal keeps tab and newline, which are legitimate in a message', () => {
  assert.equal(sanitizeForTerminal('a\tb\nc'), 'a\tb\nc');
});

test('sanitizeForTerminal preserves the styling this module itself applied', () => {
  const styled = `${dim('Billing:')} ${bold('subscription')}`;
  assert.equal(sanitizeForTerminal(styled), styled,
    'a blanket strip would have deleted the kit\'s own formatting everywhere');
});

test('sanitizeForTerminal strips hostile bytes that arrive INSIDE a styled message', () => {
  const out = sanitizeForTerminal(dim(`name ${ESC}]0;PWNED${BEL} tail`));
  // Built with fromCharCode rather than an escape so this file carries none
  // of the bytes it is asserting about: strip the module's OWN styling first,
  // then nothing forbidden may remain.
  const ownSgr = new RegExp(`${ESC}\\[(?:0|1|2|1;3[1236])m`, 'g');
  assert.ok(!FORBIDDEN.test(out.replace(ownSgr, '')),
    'an OSC introducer must not survive just because the message was styled');
});
