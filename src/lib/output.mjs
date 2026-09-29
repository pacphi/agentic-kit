// Terminal output helpers, mirroring the shell kit's ok/warn/fail/dim voice.
// Color only on a TTY and when NO_COLOR is unset; --json callers collect
// structured results instead of printing.
import { AsyncLocalStorage } from 'node:async_hooks';
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
 * `--show-text`'s raw transcript text is also stripped at `clipText`. This is the
 * last line, not the only one.
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

// A live check that runs beside others (or whose verdict needs its first
// failure line) captures the ok/warn/fail/info/heading lines it prints, scoped
// by AsyncLocalStorage so parallel checks never mix their lines. `echo` also
// prints them, as a sequential `ak status --refresh=live` run does.
const captureScope = new AsyncLocalStorage();

/**
 * Run `fn`, collecting every line the helpers below emit inside it.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @param {{echo?:boolean}} [options]
 * @returns {Promise<{result:T, entries:{level:string,text:string}[]}>}
 */
export async function captureOutput(fn, { echo = false } = {}) {
  const scope = { entries: [], echo };
  const result = await captureScope.run(scope, fn);
  return { result, entries: scope.entries };
}

function emit(level, msg, line) {
  const scope = captureScope.getStore();
  if (scope) scope.entries.push({ level, text: s(msg) });
  if (!scope || scope.echo) console.log(line);
}

export const ok = (msg) => emit('ok', msg, `${green('✓')} ${s(msg)}`);
export const warn = (msg) => emit('warn', msg, `${yellow('⚠')}  ${s(msg)}`);
export const fail = (msg) => emit('fail', msg, `${red('✗')} ${s(msg)}`);
export const info = (msg) => emit('info', msg, `${dim('ℹ')}  ${s(msg)}`);
export const heading = (msg) => emit('heading', msg, `\n${bold(s(msg))}`);

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

/** Under --json, send everything written to stdout during `fn` (ok/warn/fail/
 *  info lines, the plan listing, prompts, progress) to stderr instead, and
 *  let the step tracer collect it while `capture.chunks` is set. stdout is
 *  restored even when `fn` throws, so the one JSON result lands on it alone. */
export async function humanOutputToStderr(fn) {
  const capture = { chunks: null };
  const restore = stdoutToStderr(capture);
  try {
    return await fn(capture);
  } finally {
    restore();
  }
}

/** Send stdout writes to stderr (collected in `capture.chunks` while it is
 *  set) until the returned function restores stdout. */
function stdoutToStderr(capture) {
  const stdoutWrite = process.stdout.write;
  // stderr.write is looked up on every call, so a caller's own wrapper still sees it.
  const toStderr = (...args) => {
    capture.chunks?.push(String(args[0]));
    return Reflect.apply(process.stderr.write, process.stderr, args);
  };
  process.stdout.write = /** @type {typeof process.stdout.write} */ (/** @type {unknown} */ (toStderr));
  return () => { process.stdout.write = stdoutWrite; };
}

/** Report a failure the way the invocation asked for it. Without --json,
 *  `human` prints as usual. With it, everything `human` prints goes to stderr
 *  and stdout carries `payload` as the one JSON object, so a `--json` caller
 *  always gets JSON, even for a rejected option or an unreadable kit.json
 *  (ADR-0063). `human` must be synchronous.
 *  @param {{ json: boolean, payload: Record<string, unknown>, human: () => void }} input */
export function reportFailure({ json, payload, human }) {
  if (!json) { human(); return; }
  const restore = stdoutToStderr({ chunks: null });
  try { human(); } finally { restore(); }
  console.log(JSON.stringify(payload, null, 2));
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
 *  ~64KB buffer of any larger payload (`ak usage prompts --json | jq` loses
 *  three quarters of its document). A zero-length write's callback fires only
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
