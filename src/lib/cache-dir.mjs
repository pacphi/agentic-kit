// The kit's cache location and the XDG rule it shares with paths.mjs. A leaf
// module (node: built-ins only) so scope-gate.mjs can read the cache folder
// without importing paths.mjs, which imports file-write.mjs, which imports
// scope-gate.mjs.
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

/** The XDG Base Directory spec ignores relative environment overrides. */
export function xdgBase(name, fallback, { env = process.env, p = path } = {}) {
  const value = env[name];
  return value && p.isAbsolute(value) ? value : fallback;
}

/** The user's cache base: XDG on POSIX, %LOCALAPPDATA% on Windows (the base stateBase() uses there). */
export function cacheBase({ env = process.env, home: h = home, platform = process.platform, p = path } = {}) {
  if (platform === 'win32') return env.LOCALAPPDATA || p.join(h, 'AppData', 'Local');
  return xdgBase('XDG_CACHE_HOME', p.join(h, '.cache'), { env, p });
}

/** The kit's cache of derived data it can rebuild: `<cache base>/agentic-kit` on macOS and Linux, and
 *  `%LOCALAPPDATA%\agentic-kit\cache` on Windows, where stateBase() already owns `…\agentic-kit`. */
export function cacheDir(opts = {}) {
  const { platform = process.platform, p = path } = opts;
  const base = cacheBase(opts);
  return platform === 'win32' ? p.join(base, 'agentic-kit', 'cache') : p.join(base, 'agentic-kit');
}
