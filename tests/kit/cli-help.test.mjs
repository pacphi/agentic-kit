// CLI help + dispatch — spawns the real bin. The load-bearing guarantee here
// is that `--help` is intercepted BEFORE run(), so mutating commands
// (setup, sync, uninstall) never fire on `ak <cmd> --help`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');
const ak = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('setup --help shows help and does NOT run setup', () => {
  const r = ak('setup', '--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ak setup — /);
  assert.match(r.stdout, /Options:/);
  // A real setup run would emit ✓/⚠ progress lines, never the help header.
  assert.doesNotMatch(r.stdout, /installing|✓ /);
});

test('mutating commands intercept both --help and -h before running', () => {
  for (const cmd of ['setup', 'sync', 'uninstall']) {
    for (const flag of ['--help', '-h']) {
      const r = ak(cmd, flag);
      assert.equal(r.status, 0, `${cmd} ${flag} exit`);
      assert.match(r.stdout, new RegExp(`^ak ${cmd} — `), `${cmd} ${flag} header`);
    }
  }
});

test('every command exposes an Examples section in its help', () => {
  for (const cmd of [['setup'], ['status'], ['sync'], ['uninstall'],
    ['x', 'mcp'], ['x', 'provider'], ['x', 'verify'], ['x', 'reference'], ['x', 'daemon-gc']]) {
    const r = ak(...cmd, '--help');
    assert.equal(r.status, 0, `${cmd.join(' ')} exit`);
    assert.match(r.stdout, /Examples:/, `${cmd.join(' ')} examples`);
  }
});

test('ak x / ak x --help print the plumbing index', () => {
  for (const args of [['x'], ['x', '--help'], ['x', '-h']]) {
    const r = ak(...args);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Plumbing \(power users\)/);
  }
});

test('--version prints a semver-ish string', () => {
  const r = ak('--version');
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('unknown command exits 2 and prints top-level help', () => {
  const r = ak('bogus');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /unknown command: bogus/);
});

test('unknown plumbing command exits 2 and prints the plumbing index', () => {
  const r = ak('x', 'bogus');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /unknown plumbing command: bogus/);
});
