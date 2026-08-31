// Subprocess helpers. Rule (binding, from the plan): NOTHING goes through a
// shell string — execFile with argv arrays only, shell ALWAYS false.
//
// npm/npx/claude/deja/ruflo/aqe/claude-flow are .cmd shims on Windows, and
// Windows' CreateProcess cannot launch a .cmd directly — that historically
// forced `shell:true`, which hands Node's own cmd+args JOIN of the whole
// command line to cmd.exe as ONE string (CVE-class: any arg with `&`/`|`/`^`
// breaks out into a second command). The actual fix is resolving the shim to
// its real file on PATH. Native .com/.exe files run directly. A .cmd shim is
// never passed to execFile: Node does not execute batch files without a shell.
// Instead, its sibling .ps1 shim runs through Windows PowerShell's `-File`
// interface, preserving every caller argument as a separate argv element.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from './paths.mjs';

const pexecFile = promisify(execFile);
const MAX_EXEC_BUFFER = 16 * 1024 * 1024;

const CMD_SHIMS = new Set([
  'npm', 'npx', 'claude', 'codex', 'opencode', 'deja', 'ruflo', 'aqe', 'claude-flow',
]);

/** Build a shell-free invocation for `cmd`, trying Windows' shim extensions in
 *  PATHEXT order. A native executable is launched directly; a .cmd shim is
 *  accepted only when its sibling .ps1 and system PowerShell both exist.
 *  Falls back to the bare name with resolved:false when no safe target exists.
 *  Exported: the execution adapters spawn these CLIs directly (subprocess.mjs
 *  for claude/codex, opencode.mjs for the serve child) and must share the same
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
 *  A signal kill (the timeout path below) leaves `err.code` null, which lands
 *  on 1 — non-zero, so a caller reading only the code can never mistake a
 *  killed run's partial stdout for a completed one. */
function failureResult(err, stdout = '', stderr = '') {
  return {
    code: typeof err.code === 'number' ? err.code : 1,
    stdout: err.stdout ?? stdout ?? '',
    stderr: err.stderr || stderr || String(err.message ?? err),
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

/** Accumulate one child stream, capped at `maxBuffer` — `execFile` applies its
 *  own cap internally, so the spawn-based path below has to reimplement it. */
function captureStream(stream, encoding, maxBuffer, onOverflow) {
  const state = { text: '', overflowed: false };
  stream?.setEncoding?.(encoding);
  stream?.on('data', (chunk) => {
    if (state.overflowed) return;
    state.text += chunk;
    if (state.text.length > maxBuffer) {
      state.text = state.text.slice(0, maxBuffer);
      state.overflowed = true;
      onOverflow();
    }
  });
  return state;
}

/** The stdin-feeding, process-group variant of `run()`, used whenever a caller
 *  passes `opts.input`. Two reasons it exists, both from the security review:
 *  the payload stays out of argv (SEC-7 — `ps -ww` shows argv to the same user
 *  here, and `/proc/<pid>/cmdline` shows it to ANY local user on Linux), and
 *  the child leads its own process group so the timeout reaps its subprocesses
 *  (SEC-8).
 *
 *  WHY `spawn` AND NOT `execFile`: execFile forwards only a fixed whitelist of
 *  options through to spawn, and `detached` is not on it — passing it there is
 *  silently ignored, and the child stays in the PARENT's process group, where
 *  `process.kill(-pid)` fails ESRCH and the grandchild survives. Measured, not
 *  assumed. The timeout is likewise managed here rather than handed to the
 *  child process API, whose own `timeout` signals only the direct child. */
function runWithInput(command, args, execOpts, { windows, input }) {
  const { timeout, encoding, maxBuffer, cwd, env, signal } = execOpts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, signal, shell: false, detached: !windows });
    } catch (err) { resolve(failureResult(err)); return; }

    let failure = null;
    const abort = (reason) => { failure ??= reason; killGroup(child); };
    const out = captureStream(child.stdout, encoding, maxBuffer,
      () => abort('stdout maxBuffer length exceeded'));
    const errOut = captureStream(child.stderr, encoding, maxBuffer,
      () => abort('stderr maxBuffer length exceeded'));
    const timer = setTimeout(() => abort(`timed out after ${timeout}ms`), timeout);
    timer.unref?.();

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(failureResult(err, out.text, errOut.text));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = typeof code === 'number' ? code : 1;
      resolve({
        code: failure ? exitCode || 1 : exitCode,
        stdout: out.text,
        stderr: failure ? errOut.text || failure : errOut.text,
      });
    });
    // A child that exits without reading its input makes this write fail with
    // EPIPE. That is the child's own non-zero exit to report, not a crash here.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/** Run a command; never throws. Returns {code, stdout, stderr}.
 *  `opts.input` (a string) is delivered on the child's stdin instead of argv;
 *  see `runWithInput` for the two guarantees that carries. */
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
      signal: opts.signal,
      maxBuffer: Number.isFinite(opts.maxBuffer) && opts.maxBuffer > 0
        ? Math.min(Math.floor(opts.maxBuffer), MAX_EXEC_BUFFER) : MAX_EXEC_BUFFER,
      cwd: opts.cwd,
      env,
      shell: false,
    };
    if (typeof opts.input === 'string') {
      return await runWithInput(invocation.command, invocation.args, execOpts, {
        windows, input: opts.input,
      });
    }
    const { stdout, stderr } = await pexecFile(invocation.command, invocation.args, execOpts);
    return { code: 0, stdout, stderr };
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
