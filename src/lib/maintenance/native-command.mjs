import { execFile } from 'node:child_process';

const BINARY = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ARG_BYTES = 4096;
const MAX_OUTPUT_BYTES = 256 * 1024;

export async function runNativeCommand(binary, args, {
  execFileImpl = execFile, timeoutMs = 30_000, env = process.env, signal,
} = {}) {
  if (!BINARY.test(binary ?? '')) throw new TypeError('native command binary is invalid');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'
      || Buffer.byteLength(arg) > MAX_ARG_BYTES || arg.includes('\0'))) {
    throw new TypeError('native command arguments are invalid');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('native command timeout must be a positive integer');
  }

  // Host inventory commands are observation-only, but some take seconds to
  // answer. `spawnSync` used to freeze the dashboard's one Node event loop for
  // that whole interval. execFile preserves the exact argv/no-shell boundary
  // and Node's output/timeout caps while letting status and report requests be
  // served concurrently.
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const timeoutMarker = setTimeout(() => { timedOut = true; }, timeoutMs);
    timeoutMarker.unref?.();

    const finish = (error, stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutMarker);
      const code = /** @type {NodeJS.ErrnoException|null} */ (error)?.code;
      const exitCode = Number.isInteger(code) ? code : (error ? null : 0);
      resolve({
        ok: !error && !timedOut && signal?.aborted !== true,
        exitCode,
        timedOut: timedOut || code === 'ETIMEDOUT',
        aborted: code === 'ABORT_ERR' || signal?.aborted === true,
        signal: /** @type {{ signal?: string|null }|null} */ (error)?.signal ?? null,
        stdout: String(stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
        stderr: String(stderr ?? '').slice(0, MAX_OUTPUT_BYTES),
      });
    };

    try {
      execFileImpl(binary, args, {
        encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES,
        env, windowsHide: true, ...(signal ? { signal } : {}),
      }, finish);
    } catch (error) {
      finish(error);
    }
  });
}
