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

// security review SEC-7/SEC-8: `run()` grew an `input` option so a caller
// with a sensitive payload (the inference seam's transcript-derived prompt)
// can keep it out of argv, which `ps -ww` shows to the same user here and
// /proc/<pid>/cmdline shows to ANY local user on Linux. Passing `input` also
// switches the spawn to its own process GROUP so a timeout reaps the child's
// own subprocesses rather than orphaning them.

test('run() writes opts.input to the child stdin and keeps it out of argv (SEC-7)', async () => {
  const secret = 'PROMPT-THAT-MUST-NOT-APPEAR-IN-THE-PROCESS-TABLE';
  const r = await run(process.execPath, [
    '-e',
    'let d = ""; process.stdin.on("data", (c) => { d += c; })'
    + '.on("end", () => process.stdout.write(JSON.stringify({ stdin: d, argv: process.argv.slice(1) })));',
    // A bounded timeout so this fails FAST rather than hanging for the
    // 120s default when `input` is not delivered and the child waits on an
    // stdin `end` that never comes.
  ], { input: secret, timeout: 5_000 });
  assert.equal(r.code, 0, r.stderr);
  const seen = JSON.parse(r.stdout);
  assert.equal(seen.stdin, secret, 'the payload must arrive on stdin, byte-for-byte');
  assert.ok(!JSON.stringify(seen.argv).includes(secret),
    `the payload must never appear in argv, got: ${JSON.stringify(seen.argv)}`);
});

test('run() with input still reports a non-zero exit and its stderr', async () => {
  const r = await run(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(4)'], {
    input: 'ignored',
  });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /boom/);
});

test('run() with input tolerates a child that never reads stdin', async () => {
  const r = await run(process.execPath, ['-e', 'process.stdout.write("done")'], {
    input: 'x'.repeat(200_000),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'done');
});

test('run() with input kills the whole process GROUP on timeout, not just the direct child (SEC-8)', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX process groups'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-group-kill-'));
  const marker = path.join(dir, 'grandchild-survived');
  try {
    // The realistic shape of the SEC-8 repro: an agent CLI spawns a tool
    // subprocess that INHERITS its process group, then the parent hangs. A
    // direct-child kill leaves the grandchild running to completion; a group
    // kill takes both. (A grandchild that calls setsid() for itself escapes
    // any group kill — that is a property of process groups, not a gap here.)
    const grandchild = 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "x"), 1500);';
    const hangingChild = 'require("node:child_process").spawn(process.execPath, '
      + `['-e', ${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}], { stdio: 'ignore' });`
      + 'setInterval(() => {}, 1000);';
    const r = await run(process.execPath, ['-e', hangingChild], { input: '', timeout: 300 });
    assert.notEqual(r.code, 0, 'the timed-out run must report failure');
    await new Promise((resolve) => { setTimeout(resolve, 2500); });
    assert.equal(fs.existsSync(marker), false,
      'the grandchild outlived the group kill and completed its work after run() returned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('run() routes the deja npm binary through safe Windows shim resolution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-deja-shim-'));
  const bin = path.join(root, 'bin');
  const hostile = ['install', 'claude-code', 'hello & whoami', '$(echo pwned)'];
  fs.mkdirSync(bin);
  try {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, 'deja.cmd'), '@echo off\r\n');
      fs.writeFileSync(
        path.join(bin, 'deja.ps1'),
        '[Console]::Out.Write(($args | ConvertTo-Json -Compress))\n',
      );
    } else {
      fs.writeFileSync(
        path.join(bin, 'deja.exe'),
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o755 },
      );
    }
    const result = await run('deja', hostile, {
      windows: true,
      env: { PATH: bin, PATHEXT: process.platform === 'win32' ? '.CMD' : '.EXE' },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), hostile);
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
