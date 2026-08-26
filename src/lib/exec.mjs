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
import { execFile } from 'node:child_process';
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

/** Run a command; never throws. Returns {code, stdout, stderr}. */
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
    const { stdout, stderr } = await pexecFile(invocation.command, invocation.args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 120_000,
      signal: opts.signal,
      maxBuffer: Number.isFinite(opts.maxBuffer) && opts.maxBuffer > 0
        ? Math.min(Math.floor(opts.maxBuffer), MAX_EXEC_BUFFER) : MAX_EXEC_BUFFER,
      cwd: opts.cwd,
      env,
      shell: false,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr || String(err.message ?? err),
    };
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
