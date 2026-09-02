// Terminal output helpers, mirroring the shell kit's ok/warn/fail/dim voice.
// Color only on a TTY and when NO_COLOR is unset; --json callers collect
// structured results instead of printing.
import { stripUnsafeChars } from './text-safety.mjs';

const SGR_CODES = ['1;32', '1;33', '1;31', '1;36', '2', '1'];
const RESET = '0';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const green = (s) => c('1;32', s);
export const yellow = (s) => c('1;33', s);
export const red = (s) => c('1;31', s);
export const cyan = (s) => c('1;36', s);
export const dim = (s) => c('2', s);
export const bold = (s) => c('1', s);

/** Exactly the SGR sequences the helpers above emit — nothing else. Built
 *  from SGR_CODES so adding a color here cannot forget to teach the sanitizer
 *  about it. */
const OWN_SGR_RE = new RegExp(
  `\\x1b\\[(?:${[RESET, ...SGR_CODES].map((code) => code.replace(';', '\\;')).join('|')})m`, 'g',
);

/**
 * The render-time half of the SEC-2 fix (security review, HIGH): strip every
 * control and bidi character from a message before it becomes bytes on a
 * terminal, while preserving the styling THIS module added.
 *
 * Why the message cannot simply be stripped whole: callers legitimately
 * pre-style their text — `info(dim(line))` hands us a string that already
 * contains our own escape codes — so a blanket strip would silently delete
 * the kit's own formatting everywhere. The string is therefore split on the
 * sequences this module emits, and only the pieces BETWEEN them are stripped.
 *
 * What that leaves, stated honestly: a hostile string could still forge one of
 * those six color codes and render itself, say, red. It could not move the
 * cursor, clear the screen, conceal text, ring the bell, or emit an OSC
 * title/clipboard sequence — the primitives the review actually demonstrated.
 * And in practice most attacker-chosen strings are also stripped or validated
 * at their source boundary. This sanitizer is the last line, not the only one.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeForTerminal(value) {
  const text = String(value ?? '');
  let out = '';
  let last = 0;
  OWN_SGR_RE.lastIndex = 0;
  for (let match = OWN_SGR_RE.exec(text); match; match = OWN_SGR_RE.exec(text)) {
    out += stripUnsafeChars(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + stripUnsafeChars(text.slice(last));
}

const s = sanitizeForTerminal;

export const ok = (msg) => console.log(`${green('✓')} ${s(msg)}`);
export const warn = (msg) => console.log(`${yellow('⚠')}  ${s(msg)}`);
export const fail = (msg) => console.log(`${red('✗')} ${s(msg)}`);
export const info = (msg) => console.log(`${dim('ℹ')}  ${s(msg)}`);
export const heading = (msg) => console.log(`\n${bold(s(msg))}`);

/** Render a managed-operation result without collapsing degraded/skipped work
 * into a green success. Legacy `{ok, detail}` results remain supported. */
export function reportOutcome(name, result) {
  const status = result?.status ?? (result?.ok ? 'ok' : 'failed');
  const message = `${name}: ${result?.detail ?? 'no detail'}`;
  if (status === 'ok') ok(message);
  else if (status === 'degraded') warn(message);
  else if (status === 'skipped') info(message);
  else fail(message);
  return status;
}

/** Status glyph for dashboard rows. */
export const glyph = (level) =>
  level === 'ok' ? green('✓') : level === 'warn' ? yellow('⚠') : level === 'fail' ? red('✗') : dim('·');

/** Run `thunk` while showing a live elapsed-time ticker on one rewritten line, so
 *  long heals (npm -g installs, the ~512 MB brain KB download, native rebuilds)
 *  visibly progress instead of leaving the prompt frozen — our `run()` buffers
 *  child output, so without this the terminal is silent until the process exits.
 *  TTY-only: piped/redirected output gets no ticker (the caller's result line is
 *  enough) so logs and `--json` stay clean. Always clears its line before
 *  returning, so the caller's ok/fail prints fresh. Rejects exactly as `thunk`
 *  does — never swallows errors.
 *
 *  INVARIANT (load-bearing): the thunk must not write to stdout — the ticker
 *  owns the line via \r-rewrites with no trailing newline. Every current sync
 *  thunk routes child output through the buffered run() in exec.mjs, which is
 *  why this holds; a thunk that console.logs or spawns stdio:'inherit' will
 *  garble the line. */
export async function withProgress(label, thunk, {
  tty = process.stdout.isTTY, // injectable for hermetic tests
  out = process.stdout,
} = {}) {
  const start = Date.now();
  const fmt = (ms) => {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  };
  let timer;
  if (tty) {
    const render = () =>
      out.write(`\r${dim('⏳')} ${label} ${dim(`— ${fmt(Date.now() - start)}…`)}`);
    render();
    timer = setInterval(render, 1000);
    if (timer.unref) timer.unref();
  }
  try {
    return await thunk();
  } finally {
    if (timer) clearInterval(timer);
    if (tty) out.write('\r\x1b[K'); // erase the ticker line
  }
}

/** How long the drain below is allowed to take before the process exits
 *  anyway. Security review SEC-5 (MEDIUM): the exit used to sit inside two
 *  nested write callbacks with no timeout and no fallback, so a consumer that
 *  OPENS the pipe and never reads it hung the process forever — the review
 *  measured 8 s and then SIGKILL, against a payload above the ~64 KB pipe
 *  buffer. A paused pager, a `tee` into a blocked sink, or a lazy CI step is
 *  enough. Before the drain fix the bin called `process.exit(code)` directly,
 *  so this was a NEW hang in a path that previously could not hang.
 *
 *  Two seconds is chosen against the measured drain cost: 270 KB through a
 *  real pipe to a real consumer took 789 ms, so this leaves generous headroom
 *  for a slow-but-live reader while still bounding a dead one. */
const FLUSH_TIMEOUT_MS = 2000;

/** Exit once stdout and stderr have drained. `process.exit()` kills the
 *  process with piped output still queued — a pipe consumer sees at most one
 *  ~64KB buffer of any larger JSON payload. A zero-length write's callback fires only
 *  after everything queued before it has been handed to the OS, so exiting
 *  from the second callback preserves hard-exit semantics (lingering timers
 *  or handles still can't keep the process alive) without the truncation.
 *
 *  The drain RACES a bounded timer (SEC-5). Whichever finishes first exits
 *  with the same code, so a stalled consumer costs the caller two seconds
 *  rather than the process's whole life, and a live one is unaffected. The
 *  timer is `unref`'d so it never becomes the reason the process stays up. */
export function exitWhenFlushed(code) {
  const fallback = setTimeout(() => process.exit(code), FLUSH_TIMEOUT_MS);
  fallback.unref?.();
  // Wait on the stream's ACTUAL buffer, not a zero-length `write('', cb)`: on
  // Windows that callback can fire before a large buffered payload has drained
  // (the empty write is a no-op that calls back immediately rather than queuing
  // behind the pending bytes), so `ak … | jq` truncated past the pipe buffer.
  // `writableLength === 0` means the Node buffer is empty (handed to the OS);
  // otherwise `drain` fires exactly when it empties. Both are true only after
  // the bytes are with the kernel, so the reader still gets them after exit.
  let pending = 2;
  const done = () => { if (--pending === 0) { clearTimeout(fallback); process.exit(code); } };
  const flush = (s) => { if (s.writableLength === 0) done(); else s.once('drain', done); };
  flush(process.stdout);
  flush(process.stderr);
}
