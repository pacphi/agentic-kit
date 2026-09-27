// tests/kit/spawn-env-guard.test.mjs
// A spawned child that inherits the developer's XDG_*/LOCALAPPDATA/TMPDIR writes
// that developer's real tool state (six files created ~/.local/state/opencode,
// ~/.cache/opencode and ~/.local/share/opencode this way). Every child env in
// tests/ is built by spawnEnv()/sandboxEnvFor(); a deliberate exception carries
// the marker comment `spawn-env: inherits (<reason>)` on the same line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnEnv, sandboxEnvFor, INHERITED_STATE_KEYS } from './helpers/home-sandbox.mjs';

const TESTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const HELPER = path.join(TESTS, 'kit', 'helpers', 'home-sandbox.mjs');
const INHERIT = /\.\.\.\s*process\.env\b|env:\s*process\.env\b/;

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures') files(full, out); } else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

test('no test builds a child environment from process.env outside the sandbox helper', () => {
  const offenders = [];
  for (const file of files(TESTS)) {
    if (file === SELF || file === HELPER) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (INHERIT.test(line) && !/spawn-env: inherits \(.+\)/.test(line)) offenders.push(`${path.relative(TESTS, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `use spawnEnv(home, extra) from tests/kit/helpers/home-sandbox.mjs:\n  ${offenders.join('\n  ')}`);
});

const tempHome = (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-spawn-env-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};

test('spawnEnv pins every per-user base inside the sandbox, whatever the parent exported', (t) => {
  const home = tempHome(t);
  const env = spawnEnv(home, { EXTRA: '1' });
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'npm_config_cache']) {
    assert.ok(env[key] && env[key].startsWith(home), `${key}=${env[key]} escapes ${home}`);
  }
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH']) {
    assert.equal(env[key], undefined, `${key} must not be inherited`);
  }
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.EXTRA, '1');
  assert.deepEqual(Object.keys(sandboxEnvFor(home)).sort(),
    INHERITED_STATE_KEYS.filter((k) => !['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH'].includes(k)).sort());
});

test('a real child sees the sandboxed state base, not the parent one', (t) => {
  const home = tempHome(t);
  const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.XDG_STATE_HOME, require("os").tmpdir()]))'],
    { env: spawnEnv(home), encoding: 'utf8' });
  const [state, tmp] = JSON.parse(r.stdout);
  assert.ok(state.startsWith(home));
  assert.ok(tmp.startsWith(home));
});
