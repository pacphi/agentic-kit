// Subprocess helpers. Rule (binding, from the plan): NOTHING goes through a
// shell string — spawn with argv arrays only, shell ALWAYS false.
//
// npm/npx/claude/deja/ruflo/aqe/claude-flow are .cmd shims on Windows, and
// Windows' CreateProcess cannot launch a .cmd directly — that historically
// forced `shell:true`, which hands Node's own cmd+args JOIN of the whole
// command line to cmd.exe as ONE string (CVE-class: any arg with `&`/`|`/`^`
// breaks out into a second command). The actual fix is resolving the shim to
// its real file on PATH. Native .com/.exe files run directly. A .cmd shim is
// never passed to spawn: Node does not execute batch files without a shell.
// Instead, its sibling .ps1 shim runs through Windows PowerShell's `-File`
// interface, preserving every caller argument as a separate argv element.
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from './paths.mjs';

const MAX_EXEC_BUFFER = 16 * 1024 * 1024;

// A caller that bounds work it does not own (a live check under `ak status
// --refresh=live` running the full live-check suite) scopes an AbortSignal
// here; every run() inside the scope that passes no signal of its own uses it,
// so a timed-out check's entire owned process tree stops and cleanup still runs.
const abortScope = new AsyncLocalStorage();

/** Run `fn` with `signal` as the default abort signal for run() calls in it.
 * @template T @param {AbortSignal} signal @param {() => T} fn @returns {T} */
export const withAbortSignal = (signal, fn) => abortScope.run(signal, fn);

// `ak` too: the MCP launcher check asks the PATH `ak` (an npm shim on Windows)
// for its help.
const CMD_SHIMS = new Set([
  'npm', 'npx', 'claude', 'codex', 'opencode', 'deja', 'ruflo', 'aqe', 'claude-flow', 'ak',
]);

/** Build a shell-free invocation for `cmd`, trying Windows' shim extensions in
 *  PATHEXT order. A native executable is launched directly; a .cmd shim is
 *  accepted only when its sibling .ps1 and system PowerShell both exist.
 *  Falls back to the bare name with resolved:false when no safe target exists.
 *  Exported: the execution adapters spawn these CLIs directly (subprocess.mjs
 *  for claude/codex, opencode.mjs for the serve child, x/ruflo-mcp.mjs for the
 *  Ruflo MCP launcher) and must share the same
 *  resolution `run()`/`have()` use, or readiness passes but launch ENOENTs on
 *  Windows (swarm review, #88). */
export function resolveShim(cmd, args = [], { windows = isWindows, env = process.env } = {}) {
  const direct = { command: cmd, args: [...args], resolved: !windows };
  if (!windows) return direct;

  const systemRoot = env.SystemRoot || env.WINDIR;
  const powershell = systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : null;
  const invocationFor = (candidate) => {
    let stat;
    try { stat = fs.statSync(candidate); } catch { return null; }
    if (!stat.isFile()) return null;
    const ext = path.extname(candidate).toLowerCase();
    if (ext === '.com' || ext === '.exe' || !ext) {
      return { command: candidate, args: [...args], resolved: true };
    }
    if (ext !== '.cmd' || !powershell) return null;
    const script = `${candidate.slice(0, -ext.length)}.ps1`;
    try {
      if (!fs.statSync(script).isFile() || !fs.statSync(powershell).isFile()) return null;
    } catch { return null; }
    return {
      command: powershell,
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
      ],
      resolved: true,
    };
  };

  if (path.isAbsolute(cmd)) return invocationFor(cmd) ?? direct;
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const invocation = invocationFor(path.join(dir, cmd + ext.toLowerCase()));
      if (invocation) return invocation;
    }
  }
  return direct;
}

/** Normalize whatever a failed spawn threw into `run()`'s never-throws shape.
 *  A signal kill (the timeout path below, or a crash) leaves `err.code` null,
 *  which lands on 1 — non-zero, so a caller reading only the code can never
 *  mistake a killed run's partial stdout for a completed one. The signal
 *  itself is kept as `signal` so a caller can name the real cause. */
function failureResult(err, stdout = '', stderr = '') {
  return {
    code: typeof err.code === 'number' ? err.code : 1,
    stdout: err.stdout ?? stdout ?? '',
    stderr: err.stderr || stderr || String(err.message ?? err),
    ...(err.signal ? { signal: err.signal } : {}),
  };
}

/** Kill the whole process GROUP led by a `detached` child, so subprocesses it
 *  spawned die with it. Security review SEC-8 measured the alternative: a
 *  grandchild of a timed-out `claude -p` survived the direct-child kill and
 *  finished its work 5s after `run()` had already returned. SIGKILL rather
 *  than SIGTERM because the case this exists for is a child that has stopped
 *  responding. Falls back to the direct child where there is no group to
 *  signal (Windows) or the group has already exited. */
function killGroup(child) {
  try {
    if (typeof child.pid === 'number' && child.pid > 0) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch { /* no process group, or it is already gone — fall through */ }
  try { child.kill('SIGKILL'); } catch { /* already reaped */ }
}

/** Kill a spawned child and everything it started. Shared by the MCP stdio
 *  clients (discovery probe, tool calls) so their teardown cannot drift apart.
 *  POSIX children must have been spawned `detached` so they lead their own
 *  process group (killGroup, the same kill run()'s timeout path uses); Windows
 *  uses `taskkill /T /F`, falling back to the direct child when taskkill
 *  cannot start. Nothing is spawned without a pid, and an already-exited
 *  process is not an error. run() keeps its own kill unchanged. */
export function killProcessTree(child, { platform = process.platform, spawnFn = spawn } = {}) {
  if (platform !== 'win32') { killGroup(child); return; }
  if (typeof child.pid !== 'number' || child.pid <= 0) return;
  const killer = spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
  killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already reaped */ } });
}

/** Accumulate one child stream, capped at `maxBuffer` — `execFile` applies its
 *  own cap internally, so the spawn-based path below has to reimplement it. */
function captureStream(stream, encoding, maxBuffer, onOverflow) {
  const chunks = [];
  const state = {
    bytes: 0,
    overflowed: false,
    get text() { return Buffer.concat(chunks).toString(encoding); },
  };
  stream?.on('data', (chunk) => {
    if (state.overflowed) return;
    const remaining = maxBuffer - state.bytes;
    chunks.push(chunk.subarray(0, remaining));
    state.bytes += chunk.length;
    if (state.bytes > maxBuffer) {
      state.overflowed = true;
      onOverflow();
    }
  });
  return state;
}

/** `spawn` is required for both paths: execFile silently drops `detached`, so
 *  its AbortSignal and timeout can only stop the direct child. Input stays on
 *  stdin and never enters argv. The Windows taskkill completion is awaited
 *  before returning, even if the direct child closes first. */
function runOwned(command, args, execOpts, { windows, input }) {
  const { timeout, encoding, maxBuffer, cwd, env, signal } = execOpts;
  if (signal?.aborted) return Promise.resolve({ code: 1, stdout: '', stderr: 'The operation was aborted' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell: false, detached: !windows });
    } catch (err) { resolve(failureResult(err)); return; }

    let failure = null;
    let closed = false;
    let stopping = Promise.resolve();
    const closePipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    };
    const incomplete = (reason) => {
      failure = `${reason}; incomplete process-tree cleanup`;
      closePipes();
    };
    const abort = (reason) => {
      if (closed) return;
      if (failure) return;
      failure = reason;
      if (!windows) { killGroup(child); return; }
      // A reaped root PID may already name a different process. The owned
      // descendant may still hold our pipes, but cannot be safely found by PID.
      if (child.exitCode !== null || child.signalCode !== null) {
        incomplete(reason);
        return;
      }
      if (!Number.isInteger(child.pid) || child.pid < 1) {
        incomplete(reason);
        return;
      }
      stopping = new Promise((done) => {
        let killer;
        const fallback = (detail) => {
          incomplete(`${reason} (${detail})`);
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL'); } catch { /* exited */ }
          }
          done();
        };
        try {
          killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore', shell: false,
          });
        } catch { fallback('taskkill could not start'); return; }
        const finish = (code, detail) => {
          clearTimeout(deadline);
          killer.removeListener('error', onError);
          killer.removeListener('close', onClose);
          if (code === 0) done();
          else fallback(detail);
        };
        const onError = () => finish(null, 'taskkill could not start');
        const onClose = (code) => finish(code, `taskkill exited ${code}`);
        const deadline = setTimeout(() => {
          try { killer.kill('SIGKILL'); } catch { /* already exited */ }
          killer.unref?.();
          finish(null, 'taskkill exceeded cleanup deadline');
        }, 1_000);
        killer.once('error', onError);
        killer.once('close', onClose);
      });
    };
    const onSignal = () => abort('The operation was aborted');
    signal?.addEventListener('abort', onSignal, { once: true });
    if (signal?.aborted) onSignal();
    const out = captureStream(child.stdout, encoding, maxBuffer,
      () => abort('stdout maxBuffer length exceeded'));
    const errOut = captureStream(child.stderr, encoding, maxBuffer,
      () => abort('stderr maxBuffer length exceeded'));
    const timer = timeout > 0 ? setTimeout(() => abort(`timed out after ${timeout}ms`), timeout) : null;
    timer?.unref?.();

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onSignal);
      stopping.then(() => resolve(failureResult(err, out.text, errOut.text)));
    });
    child.on('close', (code, exitSignal) => {
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onSignal);
      const exitCode = typeof code === 'number' ? code : 1;
      stopping.then(() => resolve({
        code: failure ? exitCode || 1 : exitCode,
        stdout: out.text,
        stderr: failure ? [errOut.text, failure].filter(Boolean).join('\n') : errOut.text,
        ...(exitSignal ? { signal: exitSignal } : {}),
      }));
    });
    // A child that exits without reading its input makes this write fail with
    // EPIPE. That is the child's own non-zero exit to report, not a crash here.
    child.stdin?.on('error', () => {});
    if (typeof input === 'string') child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/** Run a command; never throws. Returns {code, stdout, stderr}.
 *  `opts.input` (a string) is delivered on the child's stdin instead of argv;
 *  `runOwned` keeps that payload out of the process table. */
export async function run(cmd, args = [], opts = {}) {
  try {
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;
    const windows = opts.windows ?? isWindows;
    const invocation = CMD_SHIMS.has(cmd)
      ? resolveShim(cmd, args, { windows, env })
      : { command: cmd, args };
    if (invocation.resolved === false) {
      return { code: 1, stdout: '', stderr: `No safe Windows invocation found for ${cmd}` };
    }
    const execOpts = {
      encoding: 'utf8',
      timeout: opts.timeout ?? 120_000,
      signal: opts.signal ?? abortScope.getStore(),
      maxBuffer: Number.isFinite(opts.maxBuffer) && opts.maxBuffer > 0
        ? Math.min(Math.floor(opts.maxBuffer), MAX_EXEC_BUFFER) : MAX_EXEC_BUFFER,
      cwd: opts.cwd,
      env,
      shell: false,
    };
    return await runOwned(invocation.command, invocation.args, execOpts, {
      windows, input: opts.input,
    });
  } catch (err) {
    return failureResult(err);
  }
}

/** Is `cmd` invokable? (cross-platform `command -v`) */
export async function have(cmd, opts = {}) {
  opts.signal?.throwIfAborted?.();
  if (isWindows) {
    return resolveShim(cmd).resolved;
  }
  const present = (await run('which', [cmd], opts)).code === 0;
  opts.signal?.throwIfAborted?.();
  return present;
}
