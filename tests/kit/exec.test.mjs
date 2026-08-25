import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, have, resolveShim } from '../../src/lib/exec.mjs';

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

test('run() honors a caller-requested bounded output cap', async () => {
  const r = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], {
    maxBuffer: 1024,
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /maxBuffer|stdout/i);
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

test('run()/have() accept the execution deadline AbortSignal', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  const started = Date.now();
  try {
    const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
      timeout: 10_000,
    });
    assert.notEqual(result.code, 0);
    assert.ok(Date.now() - started < 500, 'abort stops the subprocess before its independent timeout');
  } finally {
    clearTimeout(timer);
  }

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    have(process.platform === 'win32' ? 'cmd' : 'sh', { signal: alreadyAborted.signal }),
    (error) => error?.name === 'AbortError',
  );
});

test('resolveShim builds safe native and PowerShell invocations in PATHEXT order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-shim-'));
  const bin = path.join(root, 'bin');
  const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const hostile = ['hello & whoami', '$(echo pwned)', 'a|b', 'quoted " value'];
  fs.mkdirSync(path.dirname(powershell), { recursive: true });
  fs.mkdirSync(bin);
  try {
    fs.writeFileSync(powershell, 'x');
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(bin, 'codex.ps1'), '# shim');
    fs.writeFileSync(path.join(bin, 'codex.exe'), 'x');
    const env = { PATH: bin, PATHEXT: '.COM;.EXE;.CMD', SystemRoot: root };

    assert.deepEqual(resolveShim('codex', hostile, { windows: true, env }), {
      command: path.join(bin, 'codex.exe'), args: hostile, resolved: true,
    }, 'native .exe wins according to PATHEXT and receives the original argv');

    assert.deepEqual(resolveShim('codex', hostile, {
      windows: true, env: { ...env, PATHEXT: '.CMD' },
    }), {
      command: powershell,
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', path.join(bin, 'codex.ps1'),
        ...hostile,
      ],
      resolved: true,
    }, 'a .cmd shim is represented by its sibling .ps1 without joining argv');

    fs.rmSync(path.join(bin, 'codex.ps1'));
    assert.deepEqual(resolveShim('codex', hostile, {
      windows: true, env: { ...env, PATHEXT: '.CMD' },
    }), { command: 'codex', args: hostile, resolved: false },
    'a .cmd shim without its sibling .ps1 is not considered executable');
    assert.deepEqual(resolveShim('codex', hostile, { windows: false, env }), {
      command: 'codex', args: hostile, resolved: true,
    }, 'non-Windows commands and argv pass through unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows PowerShell shim execution preserves hostile arguments literally', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-shim-live-'));
  const hostile = ['hello & whoami', '$(echo pwned)', 'a|b', 'quoted " value'];
  try {
    fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\n');
    fs.writeFileSync(
      path.join(dir, 'codex.ps1'),
      '[Console]::Out.Write(($args | ConvertTo-Json -Compress))\n',
    );
    const result = await run('codex', hostile, { env: { PATH: dir, PATHEXT: '.CMD' } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), hostile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
