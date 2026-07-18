// Terminal output helpers, mirroring the shell kit's ok/warn/fail/dim voice.
// Color only on a TTY and when NO_COLOR is unset; --json callers collect
// structured results instead of printing.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const green = (s) => c('1;32', s);
export const yellow = (s) => c('1;33', s);
export const red = (s) => c('1;31', s);
export const cyan = (s) => c('1;36', s);
export const dim = (s) => c('2', s);
export const bold = (s) => c('1', s);

export const ok = (msg) => console.log(`${green('✓')} ${msg}`);
export const warn = (msg) => console.log(`${yellow('⚠')}  ${msg}`);
export const fail = (msg) => console.log(`${red('✗')} ${msg}`);
export const info = (msg) => console.log(`${dim('ℹ')}  ${msg}`);
export const heading = (msg) => console.log(`\n${bold(msg)}`);

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
 *  does — never swallows errors. */
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
