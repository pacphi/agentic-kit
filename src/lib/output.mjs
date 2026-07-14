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
