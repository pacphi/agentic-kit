// tests/kit/opencode-state-hermeticity.test.mjs
// Six test files created OpenCode's own folders under the developer's
// XDG_CONFIG_HOME/XDG_STATE_HOME/XDG_CACHE_HOME/XDG_DATA_HOME and TMPDIR
// (per-file probe, Branch 2 plan). Runs the three in-process ones with those
// bases (and APPDATA, the Windows config base) pointed at a watched folder and
// requires the folder to stay empty. The three direct-spawn files are covered
// by spawn-env-guard.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redirectToolState } from './helpers/home-sandbox.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const IN_PROCESS = ['integration-command-facts', 'opencode', 'provider-credentials'];
const WATCHED = ['cfg', 'state', 'data', 'cache', 'tmp'];
const TOOL_BASES = ['XDG_CONFIG_HOME', 'APPDATA', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP'];

// Deterministic half: holds without opencode installed. OpenCode creates
// <config>/opencode on start, so the config bases must move with the others.
test('redirectToolState points every tool base, config included, inside its base', () => {
  const previous = Object.fromEntries(TOOL_BASES.map((key) => [key, process.env[key]]));
  const toolState = redirectToolState('ak-oc-keys');
  let seen;
  try {
    seen = Object.fromEntries(TOOL_BASES.map((key) => [key, process.env[key]]));
  } finally {
    toolState.restore();
  }
  for (const key of TOOL_BASES) {
    assert.ok(seen[key]?.startsWith(toolState.base + path.sep), `${key}=${seen[key]} is outside ${toolState.base}`);
    assert.equal(process.env[key], previous[key], `${key} was not restored`);
  }
  assert.equal(fs.existsSync(toolState.base), false);
});

for (const name of IN_PROCESS) {
  test(`${name}.test.mjs leaves the inherited tool-state bases untouched`, { timeout: 300_000 }, (t) => {
    const watched = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-oc-watch-')));
    t.after(() => fs.rmSync(watched, { recursive: true, force: true }));
    for (const d of WATCHED) fs.mkdirSync(path.join(watched, d));
    const env = { ...process.env, // spawn-env: inherits (this test measures exactly what an inheriting run leaks)
      XDG_CONFIG_HOME: path.join(watched, 'cfg'), APPDATA: path.join(watched, 'cfg'),
      XDG_STATE_HOME: path.join(watched, 'state'), XDG_DATA_HOME: path.join(watched, 'data'),
      XDG_CACHE_HOME: path.join(watched, 'cache'), TMPDIR: path.join(watched, 'tmp'),
      TEMP: path.join(watched, 'tmp'), TMP: path.join(watched, 'tmp') };
    // Inherited from the outer runner, it turns the nested `node --test` into a
    // reporting child that runs nothing, and this check would pass vacuously.
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(KIT, `${name}.test.mjs`)],
      { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^# pass [1-9]/m, `the nested run executed no test:\n${r.stdout}`);
    const leaked = WATCHED.flatMap((d) => fs.readdirSync(path.join(watched, d))
      .filter((n) => n !== 'node-compile-cache').map((n) => `${d}/${n}`));
    assert.deepEqual(leaked, []);
  });
}
