import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, have } from '../../src/lib/exec.mjs';

// code-quality Finding 2: exec.mjs used to set shell:true for a fixed set of
// Windows .cmd shims (npm/npx/claude/ruflo/aqe/claude-flow), which handed
// Node's own cmd+args string-join to cmd.exe — an injection surface if any
// arg ever carried untrusted content (providers.mjs did, via --provider).
// The fix resolves the shim to its real file and runs with shell ALWAYS
// false; these are basic behavioral smoke tests (no Windows CI here to
// exercise resolveShim's PATH walk directly) proving run()/have() still work
// for real cross-platform commands.

test('run() executes a real command and captures stdout, code 0', async () => {
  const r = await run(process.execPath, ['--version']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.trim().startsWith('v'), `expected a version string, got ${JSON.stringify(r.stdout)}`);
});

test('run() never throws on a missing command — returns a non-zero code instead', async () => {
  const r = await run('this-command-does-not-exist-anywhere', []);
  assert.notEqual(r.code, 0);
  assert.equal(typeof r.stderr, 'string');
});

test('run() never throws on a command that exits non-zero', async () => {
  const r = await run(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(r.code, 3);
});

test('run() passes args as an argv array, not shell-joined — a metacharacter-laden arg is inert', async () => {
  // If args were ever shell-joined again, this argument would break out into
  // a second command; run() must pass it through as one literal argv string.
  const hostile = 'hello && echo INJECTED; $(echo pwned)';
  const r = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', hostile]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, hostile, 'the argument must arrive byte-for-byte, never re-parsed as shell syntax');
});

test('have() reports true for a command that is definitely on PATH', async () => {
  assert.equal(await have(process.platform === 'win32' ? 'cmd' : 'sh'), true);
});

test('have() reports false for a command that does not exist', async () => {
  assert.equal(await have('this-command-does-not-exist-anywhere'), false);
});
