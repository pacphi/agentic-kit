// Subprocess helpers. Rule (binding, from the plan): NOTHING goes through a
// shell string — execFile with argv arrays only, shell ALWAYS false.
//
// npm/npx/claude/ruflo/aqe/claude-flow are .cmd shims on Windows, and
// Windows' CreateProcess cannot launch a .cmd directly — that historically
// forced `shell:true`, which hands Node's own cmd+args JOIN of the whole
// command line to cmd.exe as ONE string (CVE-class: any arg with `&`/`|`/`^`
// breaks out into a second command). The actual fix is resolving the shim to
// its real file on PATH (with extension) and calling execFile on THAT path
// directly with shell:false: Node >=18.20.2/20.12.2/21.7.2 (this package
// requires >=22 — see package.json engines) internally detects a .cmd/.bat
// target and safely re-invokes cmd.exe itself, with each argv element
// properly escaped — the CVE-2024-27980 fix. Callers never need shell:true.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from './paths.mjs';

const pexecFile = promisify(execFile);

const CMD_SHIMS = new Set(['npm', 'npx', 'claude', 'ruflo', 'aqe', 'claude-flow']);

/** Resolve `cmd` to its real file on PATH, trying Windows' shim extensions in
 *  PATHEXT order. Falls back to the bare name (execFile will ENOENT honestly)
 *  if nothing on PATH matches — never silently launches the wrong binary. */
function resolveShim(cmd) {
  if (!isWindows || path.isAbsolute(cmd)) return cmd;
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext.toLowerCase());
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try the next */ }
    }
  }
  return cmd;
}

/** Run a command; never throws. Returns {code, stdout, stderr}. */
export async function run(cmd, args = [], opts = {}) {
  try {
    const resolved = CMD_SHIMS.has(cmd) ? resolveShim(cmd) : cmd;
    const { stdout, stderr } = await pexecFile(resolved, args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      shell: false,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err.message ?? err),
    };
  }
}

/** Is `cmd` invokable? (cross-platform `command -v`) */
export async function have(cmd) {
  const probe = isWindows ? ['where', [cmd]] : ['which', [cmd]];
  return (await run(...probe)).code === 0;
}
