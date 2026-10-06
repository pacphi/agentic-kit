import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as leaf from '../../src/lib/cache-dir.mjs';
import * as paths from '../../src/lib/paths.mjs';

test('paths.mjs re-exports the cache helpers unchanged', () => {
  assert.equal(paths.xdgBase, leaf.xdgBase);
  assert.equal(paths.cacheBase, leaf.cacheBase);
  assert.equal(paths.cacheDir, leaf.cacheDir);
});

test('cacheDir follows an absolute XDG_CACHE_HOME and ignores a relative one', () => {
  const posix = { home: '/h', platform: 'linux', p: path.posix };
  assert.equal(leaf.cacheDir({ ...posix, env: { XDG_CACHE_HOME: '/x/cache' } }), '/x/cache/agentic-kit');
  assert.equal(leaf.cacheDir({ ...posix, env: { XDG_CACHE_HOME: 'relative' } }), '/h/.cache/agentic-kit');
});

test('cacheDir on Windows lives under LOCALAPPDATA\\agentic-kit\\cache', () => {
  const win = { home: 'C:\\h', platform: 'win32', p: path.win32 };
  assert.equal(leaf.cacheDir({ ...win, env: { LOCALAPPDATA: 'C:\\L' } }), 'C:\\L\\agentic-kit\\cache');
});
