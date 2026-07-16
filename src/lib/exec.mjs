// Subprocess helpers. Rule (binding, from the plan): NOTHING goes through a
// shell string — execFile with argv arrays only. `shell:true` is allowed solely
// for npm/claude on Windows, where the entry points are .cmd shims.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isWindows } from './paths.mjs';

const pexecFile = promisify(execFile);

const CMD_SHIMS = new Set(['npm', 'npx', 'claude', 'ruflo', 'aqe', 'claude-flow']);

/** Run a command; never throws. Returns {code, stdout, stderr}. */
export async function run(cmd, args = [], opts = {}) {
  try {
    const { stdout, stderr } = await pexecFile(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      shell: isWindows && CMD_SHIMS.has(cmd),
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
