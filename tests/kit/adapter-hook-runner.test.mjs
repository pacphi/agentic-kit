import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAdapterHook } from '../../src/lib/adapters/hook-runner.mjs';
import {
  recordedHashFor, isTrusted, recordConsent, revokeConsent, adapterConsentPath,
} from '../../src/lib/adapters/consent.mjs';

const NODE = process.execPath;

test('happy path: an echo script runs and returns ok with captured stdout', async () => {
  const result = await runAdapterHook({
    hook: { command: [NODE, '-e', "console.log('hello-hook')"] },
    hostId: 'claude', verb: 'discover',
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.detail, null);
  assert.ok(result.stdout.includes('hello-hook'), result.stdout);
  assert.equal(result.outcome, 'success');
  assert.equal(result.timedOut, false);
  assert.equal(result.timeoutMs, 30_000);
  assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
  assert.equal(result.stdoutBytes, Buffer.byteLength('hello-hook\n'));
  assert.equal(result.stderrBytes, 0);
});

test('argv arrives literally — no shell, so shell metacharacters never execute', async () => {
  const literal = '; rm -rf /tmp/should-not-run && echo pwned';
  const result = await runAdapterHook({
    // `node -e` has no script-path slot, so the first extra argv entry lands
    // at process.argv[1] (verified empirically, not assumed).
    hook: { command: [NODE, '-e', 'console.log(process.argv[1])', literal] },
    hostId: 'claude', verb: 'discover',
  });
  assert.equal(result.ok, true);
  // Strongest proof of no shell interpretation: the single logged line is
  // exactly the literal, unsplit and unexpanded. If a shell had interpreted
  // it, stdout would instead show an `rm` failure followed by a bare
  // "pwned" line from the injected `echo`.
  assert.equal(result.stdout.trim(), literal);
});

test('a nonexistent binary reports ok:false without throwing', async () => {
  const result = await runAdapterHook({
    hook: { command: ['definitely-not-a-real-binary-xyz123'] },
    hostId: 'claude', verb: 'discover',
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, '');
  assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
  assert.equal(result.outcome, 'spawn-failed');
  assert.equal(result.timedOut, false);
  assert.equal(result.stdoutBytes, 0);
  assert.equal(result.stderrBytes, 0);
  assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
});

test('a hook that outlives its timeout is killed and reports ok:false with captured-so-far output', async () => {
  const result = await runAdapterHook({
    hook: {
      command: [NODE, '-e', "console.log('before-sleep'); setTimeout(() => {}, 60000);"],
    },
    hostId: 'claude', verb: 'discover', timeoutMs: 200,
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.ok(result.stdout.includes('before-sleep'), result.stdout);
  assert.ok(/timed out/i.test(result.detail ?? ''), result.detail);
  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutMs, 200);
  assert.equal(result.stdoutBytes, Buffer.byteLength('before-sleep\n'));
  assert.equal(result.stderrBytes, 0);
  assert.ok(result.durationMs >= 150 && result.durationMs < 5_000, result.durationMs);
});

test('hook.timeoutMs and the caller timeoutMs both apply — the tighter one wins', async () => {
  // hook declares a generous 60s budget; the caller imposes a much tighter
  // 200ms ceiling. The call must not wait anywhere near 60s.
  const start = Date.now();
  const result = await runAdapterHook({
    hook: {
      command: [NODE, '-e', 'setTimeout(() => {}, 60000);'],
      timeoutMs: 60_000,
    },
    hostId: 'claude', verb: 'discover', timeoutMs: 200,
  });
  const elapsedMs = Date.now() - start;
  assert.equal(result.ok, false);
  assert.ok(elapsedMs < 5_000, `expected the tighter 200ms timeout to win, took ${elapsedMs}ms`);
});

test('combined stdout+stderr output is capped at 256KB with a truncation marker', async () => {
  const result = await runAdapterHook({
    hook: {
      command: [NODE, '-e', "process.stdout.write('a'.repeat(400 * 1024));"],
    },
    hostId: 'claude', verb: 'discover',
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, false);
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 256 * 1024 + 200);
  assert.ok(/truncated/i.test(result.stdout));
  assert.equal(result.stdoutBytes, 256 * 1024 + 1,
    'receipt byte counts saturate one byte above the capture cap instead of growing without bound');
  assert.equal(result.stderrBytes, 0);
});

test('env is minimal: PATH is present, an unrelated process.env canary is not', async () => {
  process.env.AK_TEST_CANARY_SECRET = 'do-not-leak';
  try {
    const result = await runAdapterHook({
      hook: {
        command: [NODE, '-e', "console.log(JSON.stringify({ path: process.env.PATH ?? null, canary: process.env.AK_TEST_CANARY_SECRET ?? null }))"],
      },
      hostId: 'claude', verb: 'discover',
    });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(parsed.path, 'PATH must be present in the child env');
    assert.equal(parsed.canary, null, 'unrelated process.env entries must not leak to the adapter');
  } finally {
    delete process.env.AK_TEST_CANARY_SECRET;
  }
});

test('caller-passed env entries are forwarded to the hook', async () => {
  const result = await runAdapterHook({
    hook: {
      command: [NODE, '-e', 'console.log(process.env.AK_TEST_ALLOWED ?? "MISSING")'],
    },
    hostId: 'claude', verb: 'discover', env: { AK_TEST_ALLOWED: 'yes' },
  });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.includes('yes'));
});

test('a non-zero exit is reported as ok:false with the exit code preserved', async () => {
  const result = await runAdapterHook({
    hook: { command: [NODE, '-e', 'process.exit(7)'] },
    hostId: 'claude', verb: 'discover',
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.outcome, 'nonzero-exit');
  assert.equal(result.timedOut, false);
});

// --- stdin (P2, ADR-0031: worker prompt delivery) ---------------------------

test('stdin: a payload written to the child is delivered and echoed back', async () => {
  const payload = 'the worker prompt, rendered task + handoffs';
  const result = await runAdapterHook({
    hook: { command: [NODE, '-e', 'process.stdin.pipe(process.stdout)'] },
    hostId: 'claude', verb: 'run', stdin: payload,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, payload);
});

test('stdin: a child that exits without reading stdin (EPIPE) still yields a normal result', async () => {
  // A large payload makes it likely the write is still in flight (or at
  // least unread) when the child exits, so the pipe's write side sees EPIPE.
  const bigPayload = 'x'.repeat(4 * 1024 * 1024);
  const result = await runAdapterHook({
    hook: { command: [NODE, '-e', 'process.exit(3)'] },
    hostId: 'claude', verb: 'run', stdin: bigPayload,
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
});

test('stdin: absent stdin keeps the existing ignore behavior (reading it yields EOF, not a hang)', async () => {
  const result = await runAdapterHook({
    hook: {
      command: [NODE, '-e', "let n=0; process.stdin.on('data', () => { n++; }); process.stdin.on('end', () => console.log('eof', n));"],
    },
    hostId: 'claude', verb: 'discover', timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.includes('eof 0'), result.stdout);
});

// --- cwd (F-1: pin the child to the adapter's own directory, never the
// operator's process.cwd() — a relative hook.command like `node
// run-hook.mjs` must resolve against the adapter bundle, not wherever `ak
// run` happened to be invoked from) --------------------------------------

test('cwd: when provided, the child actually runs there — not in process.cwd()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-hook-cwd-'));
  try {
    const target = fs.realpathSync(dir); // resolve /private symlink on macOS
    const result = await runAdapterHook({
      hook: { command: [NODE, '-e', 'console.log(process.cwd())'] },
      hostId: 'claude', verb: 'run', cwd: target,
    });
    assert.equal(result.ok, true);
    assert.equal(result.stdout.trim(), target);
    assert.notEqual(result.stdout.trim(), process.cwd());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cwd: a relative path is refused synchronously, same class as the other arg-shape checks', async () => {
  await assert.rejects(
    () => runAdapterHook({
      hook: { command: [NODE, '-e', "console.log('should not run')"] },
      hostId: 'claude', verb: 'run', cwd: 'relative/dir',
    }),
    TypeError,
  );
});

test('cwd: a non-string cwd is refused synchronously', async () => {
  await assert.rejects(
    () => runAdapterHook({
      hook: { command: [NODE, '-e', "console.log('should not run')"] },
      hostId: 'claude', verb: 'run', cwd: 42,
    }),
    TypeError,
  );
});

test('cwd: omitted keeps the existing inherited-process.cwd() behavior', async () => {
  const result = await runAdapterHook({
    hook: { command: [NODE, '-e', 'console.log(process.cwd())'] },
    hostId: 'claude', verb: 'discover',
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), process.cwd());
});

// --- stderrText (F-4: stderr must never be silently folded into a caller's
// parse of `stdout` — the admitted execution adapter reads the payload from
// stdout alone and diagnostics from stderrText, never a blended blob) ------

test('stderrText: carries only stderr, independent of the combined stdout field', async () => {
  const result = await runAdapterHook({
    hook: {
      command: [NODE, '-e', "process.stdout.write('PAYLOAD'); process.stderr.write('noisy diagnostic log line');"],
    },
    hostId: 'claude', verb: 'run',
  });
  assert.equal(result.ok, true);
  assert.equal(result.stderrText, 'noisy diagnostic log line');
  // the combined `stdout` field still folds both streams together, unchanged
  // back-compat behavior for lifecycle callers/diagnostics that read it.
  assert.ok(result.stdout.includes('PAYLOAD'));
  assert.ok(result.stdout.includes('noisy diagnostic log line'));
});

test('stderrText: empty when the hook writes nothing to stderr', async () => {
  const result = await runAdapterHook({
    hook: { command: [NODE, '-e', "console.log('only stdout')"] },
    hostId: 'claude', verb: 'run',
  });
  assert.equal(result.ok, true);
  assert.equal(result.stderrText, '');
});

// --- stdoutText (R-1: mergeCapture's `stdout` folds stderr in after a
// separator, so a JSON.parse of `stdout` breaks the instant the hook writes
// ANYTHING to stderr — a warning, a deprecation notice, a logging library
// defaulting to stderr. stdoutText is the unmerged, stdout-only capture the
// admitted adapter must parse the payload from instead.) ------------------

test('stdoutText: a JSON payload on stdout plus a warning on stderr — stdoutText parses cleanly, stdout does not', async () => {
  const result = await runAdapterHook({
    hook: {
      command: [NODE, '-e', "process.stdout.write(JSON.stringify({summary:'ok'})); process.stderr.write('deprecation warning');"],
    },
    hostId: 'claude', verb: 'run',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdoutText), { summary: 'ok' });
  assert.equal(result.stderrText, 'deprecation warning');
  // the combined `stdout` field is unchanged back-compat behavior — it folds
  // both streams, so parsing IT as JSON is exactly the break R-1 fixes.
  assert.throws(() => JSON.parse(result.stdout));
  assert.ok(result.stdout.includes('deprecation warning'));
});

test('stdoutText: equals the plain stdout capture when the hook writes nothing to stderr', async () => {
  const result = await runAdapterHook({
    hook: { command: [NODE, '-e', "console.log('only stdout')"] },
    hostId: 'claude', verb: 'run',
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdoutText.trim(), 'only stdout');
  assert.equal(result.stdout, result.stdoutText);
});

// --- consent.mjs -----------------------------------------------------------

function sandboxFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adapter-consent-'));
  return path.join(dir, 'nested', 'adapter-consent.json');
}

test('recordConsent then isTrusted with the same hash is trusted', () => {
  const file = sandboxFile();
  recordConsent('my-adapter', 'sha256:abc123', { file });
  assert.equal(isTrusted('my-adapter', 'sha256:abc123', { file }), true);
  assert.equal(recordedHashFor('my-adapter', { file }), 'sha256:abc123');
  fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
});

test('a different hash (edited adapter) is untrusted', () => {
  const file = sandboxFile();
  recordConsent('my-adapter', 'sha256:abc123', { file });
  assert.equal(isTrusted('my-adapter', 'sha256:def456', { file }), false);
  fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
});

test('revokeConsent removes trust', () => {
  const file = sandboxFile();
  recordConsent('my-adapter', 'sha256:abc123', { file });
  assert.equal(revokeConsent('my-adapter', { file }), true);
  assert.equal(isTrusted('my-adapter', 'sha256:abc123', { file }), false);
  assert.equal(recordedHashFor('my-adapter', { file }), null);
  assert.equal(revokeConsent('my-adapter', { file }), false, 'revoking again finds nothing to remove');
  fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
});

// POSIX-only: NTFS does not carry Unix permission bits, so `mode & 0o777`
// never reflects the 0600 the store requests on Windows. The 0600 write is
// still made (fs.writeFileSync mode option); this asserts the observable bits
// where the platform has them.
test('the consent file is written with mode 0600', { skip: process.platform === 'win32' }, () => {
  const file = sandboxFile();
  recordConsent('my-adapter', 'sha256:abc123', { file });
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
});

test('a missing consent file returns null/false without throwing', () => {
  const file = path.join(os.tmpdir(), `ak-adapter-consent-missing-${process.pid}-${Date.now()}.json`);
  assert.equal(recordedHashFor('my-adapter', { file }), null);
  assert.equal(isTrusted('my-adapter', 'sha256:abc123', { file }), false);
});

test('adapterConsentPath resolves under the kit config dir', () => {
  assert.ok(adapterConsentPath().endsWith(path.join('agentic-kit', 'adapter-consent.json')));
});
