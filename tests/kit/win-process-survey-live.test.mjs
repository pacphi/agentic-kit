// win-process-survey-live.test.mjs — the ONLY test that actually executes the
// Windows survey. Everything in footprint-windows.test.mjs injects a fake
// runner and feeds the parsers captured fixture text, so those tests pass
// identically on macOS and prove nothing about PowerShell, the .ps1, or the
// P/Invoke probe. This file closes that gap: on win32 it spawns the real
// `powershell -File <the shipped script>` and checks the result against ground
// truth we already hold — THIS process's own pid and cwd.
//
// It is skipped everywhere else, so it is inert locally and only earns its keep
// on the `windows-latest` leg already in the CI matrix (.github/workflows/ci.yml).
// If it ever fails there, one of these is broken for real Windows users:
// packaging (the .ps1 not shipping), execution policy, Get-CimInstance, the
// output contract the JS parsers depend on, or the PEB walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const onWindows = process.platform === 'win32';
const SCRIPT = fileURLToPath(
  new URL('../../src/lib/live/win-process-survey.ps1', import.meta.url));

/** Invoke the real script exactly as process-sessions.mjs does. */
async function runScript(mode, processIds) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT, '-Mode', mode,
  ];
  if (processIds) args.push('-ProcessIds', processIds);
  const { stdout } = await execFileAsync('powershell.exe', args, {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

// This one assertion is platform-independent on purpose: a packaging regression
// that drops the .ps1 must fail the suite on every developer's machine, not
// only on the Windows CI leg. This is the exact bug that shipped once already —
// the script lived under scripts/, which package.json's `files` never included,
// so npm-installed Windows users got no census at all.
test('the Windows survey script is colocated under src/ so packaging ships it', () => {
  assert.ok(fs.existsSync(SCRIPT), `expected the survey script at ${SCRIPT}`);
  const files = JSON.parse(
    fs.readFileSync(path.join(path.dirname(SCRIPT), '..', '..', '..', 'package.json'), 'utf8'),
  ).files ?? [];
  assert.ok(
    files.some((entry) => entry === 'src/' || entry.startsWith('src/')),
    'package.json `files` must ship src/, which is what carries the .ps1 into the tarball',
  );
  assert.ok(
    SCRIPT.split(path.sep).includes('src'),
    'the script must live under src/ — a runtime asset outside the packaged tree never reaches users',
  );
});

test('census mode reports THIS process with a real RSS', { skip: !onWindows && 'win32 only' }, async () => {
  const stdout = await runScript('census');
  const rows = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split('\t'));

  assert.ok(rows.length > 0, 'the census returned no rows at all');
  for (const row of rows) {
    assert.equal(row.length, 6, `each row is pid/ppid/created/name/cpu/rss, got: ${row.join('|')}`);
  }

  // Ground truth: we are a live process, so we must be in our own census.
  const self = rows.find((row) => Number(row[0]) === process.pid);
  assert.ok(self, `this process (pid ${process.pid}) was missing from the census`);
  assert.ok(/^node/i.test(self[3]), `expected a node image name, got ${self[3]}`);
  assert.ok(Number(self[5]) > 0, 'a live process must report a non-zero working set');
  assert.ok(Number.isFinite(Number(self[4])), 'CPU time must parse as a number');

  // The floor must never leak argv — that is where a pasted prompt or token lives.
  assert.ok(!stdout.includes('--test'), 'census output must not carry command lines');
});

test('cwd mode resolves THIS process to its real directory, or fails honestly',
  { skip: !onWindows && 'win32 only' }, async () => {
    const stdout = await runScript('cwd', String(process.pid));
    const row = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line) => line.split('\t'))
      .find((cells) => Number(cells[0]) === process.pid);

    assert.ok(row, `cwd mode returned nothing for pid ${process.pid}`);
    const [, status, value] = row;
    assert.ok(status === 'ok' || status === 'err',
      `status must be ok|err so the caller can branch, got ${status}`);

    if (status === 'ok') {
      // The strongest available check: we KNOW our own cwd, so a wrong PEB walk
      // cannot hide behind a plausible-looking path.
      assert.equal(
        path.resolve(value).toLowerCase(),
        path.resolve(process.cwd()).toLowerCase(),
        'the PEB walk returned a directory that is not actually this process\'s cwd',
      );
    } else {
      // Honest degradation is a PASS: AV, policy, or bitness may legitimately
      // block the probe. What must never happen is a fabricated path.
      assert.match(value, /^[a-z0-9-]+$/,
        `a failure must be a terse machine-readable reason, got ${value}`);
      assert.ok(!value.includes(path.sep), 'a failure reason must never look like a path');
    }
  });

test('a cwd probe failure never takes the census down with it',
  { skip: !onWindows && 'win32 only' }, async () => {
    // Pid 0 is the System Idle Process: never openable, so this drives the
    // documented failure path rather than simulating it.
    const stdout = await runScript('cwd', '0');
    const rows = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of rows) {
      const cells = line.split('\t');
      assert.equal(cells[1], 'err', 'an unopenable pid must report err, not a path');
    }
    // And the guaranteed floor still works immediately afterward.
    const census = await runScript('census');
    assert.ok(census.split('\n').filter((line) => line.trim()).length > 0,
      'the census must still work after a failed cwd probe');
  });
